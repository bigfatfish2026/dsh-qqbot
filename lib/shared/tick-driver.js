/** 事件类型注册项。volatile：tick 是到点信号，不落事件表、不重放。 */
export function tickEventDef(topic) {
    return Object.freeze({
        name: topic,
        version: 1,
        durability: 'volatile',
        payloadSchema: (payload) => {
            const tick = payload;
            return typeof tick?.name === 'string'
                && typeof tick.firedAt === 'string'
                && typeof tick.periodKey === 'string';
        },
    });
}
const realClock = {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
};
/** tick 断流判定：这么多拍没来就认死。 */
const STALL_FACTOR = 3;
/** 失败后的冷却：最短 1 分钟，别每拍都撞同一堵墙。 */
const MIN_RETRY_MS = 60_000;
const RETRY_FACTOR = 30;
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function codeOf(error) {
    const code = error?.code;
    return typeof code === 'string' && code ? code : 'ERR';
}
export function createTickDriver(options) {
    const { ctx, topic, ruleId, every, run, logger } = options;
    const label = options.label;
    const clock = options.clock ?? realClock;
    const stallMs = Math.max(every * STALL_FACTOR, every + 1);
    const retryMs = Math.max(every * RETRY_FACTOR, MIN_RETRY_MS);
    let mode = 'interval';
    let started = false;
    let stopped = false;
    let intervalHandle = null;
    let subscription;
    let ruleRegistered = false;
    let lastTickAt = 0;
    let lastPeriodKey;
    let running = false;
    let retryAt = 0;
    let watchdog = null;
    /** 上次看到的 schedule 服务实例：换实例等于规则全丢，得在新实例上重挂。 */
    let scheduleSeen;
    /** 只缓存成功的探针结果；对象变了就跟着换，服务消失就清空。 */
    let scheduleCache;
    let eventsCache;
    /** 「某某不在」各只播报一次，服务出现过再消失时重新播报。 */
    let eventsAbsentAnnounced = false;
    let scheduleAbsentAnnounced = false;
    let serviceWatchOff;
    function now() {
        return clock.now();
    }
    /** 惰性探针：每次现取，只缓存拿到手的服务对象。 */
    function probeEvents() {
        try {
            const candidate = ctx.get('events');
            if (candidate && typeof candidate.defineEvent === 'function' && typeof candidate.subscribe === 'function') {
                if (eventsCache !== candidate)
                    eventsCache = candidate;
                return eventsCache;
            }
        }
        catch (error) {
            logger.warn(`${label}: 探 events 服务失败：${messageOf(error)}`);
        }
        eventsCache = undefined;
        return undefined;
    }
    function probeSchedule() {
        try {
            const candidate = ctx.get('schedule');
            if (candidate && typeof candidate.register === 'function') {
                if (scheduleCache !== candidate)
                    scheduleCache = candidate;
                return scheduleCache;
            }
        }
        catch (error) {
            logger.warn(`${label}: 探 schedule 服务失败：${messageOf(error)}`);
        }
        scheduleCache = undefined;
        return undefined;
    }
    function ensureInterval() {
        if (intervalHandle || stopped)
            return;
        intervalHandle = clock.setInterval(() => {
            pulse('interval');
        }, every);
        intervalHandle.unref?.();
    }
    function stopInterval() {
        if (!intervalHandle)
            return;
        clock.clearInterval(intervalHandle);
        intervalHandle = null;
    }
    function stopWatchdog() {
        if (!watchdog)
            return;
        clock.clearInterval(watchdog);
        watchdog = null;
    }
    /**
     * 业务一拍。两路驱动共用一个闸：上一拍没跑完就跳过这一拍，宁可少一次，
     * 也不让同一份数据被并发处理（回收/删除都要求幂等）。
     */
    function pulse(source) {
        if (stopped || running)
            return;
        running = true;
        let result;
        try {
            result = run();
        }
        catch (error) {
            running = false;
            logger.warn(`${label}: ${source} 驱动的一拍失败：${messageOf(error)}`);
            return;
        }
        Promise.resolve(result)
            .catch((error) => {
            logger.warn(`${label}: ${source} 驱动的一拍失败：${messageOf(error)}`);
        })
            .finally(() => {
            running = false;
        });
    }
    function handleTick(payload) {
        if (stopped)
            return;
        // 先记时间：被闸掉的那一拍也算「流还活着」，否则 watchdog 会误判断流。
        lastTickAt = now();
        const key = payload?.periodKey;
        if (typeof key === 'string' && key) {
            // 同一拍重复投递（dsh-timer 重扫、订阅重连补发）不能重复干活。
            if (key === lastPeriodKey)
                return;
            lastPeriodKey = key;
        }
        pulse('tick');
        reconcile();
    }
    function dropSubscription() {
        const sub = subscription;
        if (!sub)
            return false;
        subscription = undefined;
        try {
            sub.stop?.();
        }
        catch (error) {
            logger.warn(`${label}: 退订 ${topic} 失败：${messageOf(error)}`);
        }
        return true;
    }
    function dropRule() {
        if (!ruleRegistered)
            return;
        ruleRegistered = false;
        const service = probeSchedule();
        if (!service)
            return;
        try {
            service.unregister(ruleId);
        }
        catch (error) {
            logger.warn(`${label}: 注销规则 ${ruleId} 失败：${messageOf(error)}`);
        }
    }
    function ensureSubscription(service) {
        if (subscription)
            return true;
        try {
            service.defineEvent(tickEventDef(topic));
        }
        catch (error) {
            // 重复注册（热重载、上一份 fiber 已注册过）不算失败：注册表里查得到就行。
            let registered = false;
            try {
                registered = service.registry?.get(topic) !== undefined;
            }
            catch {
                // 注册表本身读不了：保守当作已注册，订阅那一步会给出最终答案。
                registered = true;
            }
            if (!registered) {
                logger.warn(`${label}: 注册事件类型 ${topic} 失败（${codeOf(error)}）：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`);
                return false;
            }
        }
        try {
            const sub = service.subscribe(topic, (event) => {
                handleTick(event?.payload);
                return undefined;
            }, { subscriberId: ruleId, replay: { mode: 'none' } });
            if (!sub || typeof sub.stop !== 'function') {
                logger.warn(`${label}: 订阅 ${topic} 没拿到 stop()，继续由自己的 ${every}ms 定时器驱动`);
                return false;
            }
            subscription = sub;
            logger.info(`${label}: 已订阅 ${topic}（volatile，不落事件表）`);
            return true;
        }
        catch (error) {
            logger.warn(`${label}: 订阅 ${topic} 失败：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`);
            return false;
        }
    }
    function registerRule(service) {
        try {
            service.register({ id: ruleId, every, topic, catchUp: 'skip' });
            ruleRegistered = true;
            retryAt = 0;
            return true;
        }
        catch (error) {
            ruleRegistered = false;
            retryAt = now() + retryMs;
            logger.warn(`${label}: 注册规则 ${ruleId} 失败（${codeOf(error)}）：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`);
            return false;
        }
    }
    function startWatchdog() {
        stopWatchdog();
        watchdog = clock.setInterval(() => {
            if (stopped || mode !== 'tick')
                return;
            const idle = now() - lastTickAt;
            if (idle < stallMs)
                return;
            // 断流不是「少跑一拍」而是「再也不会跑」：必须当场把驱动源换回来。
            fallback(`${label}: ${topic} 连续 ${STALL_FACTOR} 个周期（${Math.round(idle / 1_000)} 秒）没收到 tick`);
        }, every);
        watchdog.unref?.();
    }
    /** 注册成功之后才停自己的 interval——顺序反了就会出现「两边都没在跑」的缝。 */
    function switchToTick() {
        mode = 'tick';
        lastTickAt = now();
        stopInterval();
        startWatchdog();
        logger.info(`${label}: 改由 ${topic} 驱动（规则 ${ruleId}，每 ${every}ms，catchUp=skip），自己的定时器已停`);
    }
    /** 降级：退回自己的 interval，并说明原因。只在 tick 模式下有意义，warn 只发一次。 */
    function fallback(reason) {
        if (stopped || mode !== 'tick')
            return;
        mode = 'interval';
        stopWatchdog();
        dropSubscription();
        dropRule();
        ensureInterval();
        retryAt = now() + retryMs;
        logger.warn(`${reason}，${label} 回落到自己的 ${every}ms 定时器`);
    }
    function reconcile() {
        if (stopped)
            return;
        const eventsService = probeEvents();
        if (!eventsService) {
            if (mode === 'tick') {
                fallback(`${label}: events 服务不在了`);
                return;
            }
            if (!eventsAbsentAnnounced) {
                eventsAbsentAnnounced = true;
                logger.info(`${label}: 没有 events 服务，${topic} 订阅等它出现再挂，当前由自己的 ${every}ms 定时器驱动`);
            }
            return;
        }
        eventsAbsentAnnounced = false;
        if (!ensureSubscription(eventsService))
            return;
        const scheduleService = probeSchedule();
        if (!scheduleService) {
            if (mode === 'tick') {
                fallback(`${label}: schedule 服务不在了`);
                return;
            }
            if (!scheduleAbsentAnnounced) {
                scheduleAbsentAnnounced = true;
                logger.info(`${label}: 没有 schedule 服务，当前由自己的 ${every}ms 定时器驱动，等服务出现再切 ${topic}`);
            }
            return;
        }
        scheduleAbsentAnnounced = false;
        if (scheduleService !== scheduleSeen) {
            // 新实例（装上、重启、热重载）：旧规则跟着旧实例没了，得重挂。
            if (scheduleSeen !== undefined) {
                logger.info(`${label}: schedule 换了实例，规则 ${ruleId} 在新实例上重挂`);
            }
            scheduleSeen = scheduleService;
            ruleRegistered = false;
            retryAt = 0;
        }
        if (mode === 'tick' && ruleRegistered)
            return;
        if (now() < retryAt)
            return;
        if (registerRule(scheduleService))
            switchToTick();
    }
    /**
     * `internal/service` 监听：schedule 就绪就重挂规则，不用等下一拍。
     *
     * ⚠ 回调整体包 try/catch，这条是硬要求：dsh-events 的 emit 是
     * `dispatch(...).map(cb => cb(...args))`，没有 try/catch，监听器抛错会冒到
     * timer 的 provide/effect，可能把 timer 的 apply 弄挂。catch 里只 warn，绝不 rethrow。
     */
    function attachServiceWatch() {
        const holder = ctx;
        if (typeof holder.on !== 'function')
            return;
        try {
            const off = holder.on('internal/service', (name, value) => {
                try {
                    if (name !== 'schedule')
                        return;
                    // 服务实例变了：缓存、规则标记全部作废，下面重新探。
                    scheduleCache = undefined;
                    scheduleSeen = undefined;
                    ruleRegistered = false;
                    retryAt = 0;
                    if (!value) {
                        // 销毁：别在这里 reconcile（服务马上要再来，纯噪音），只在 tick 模式下回落。
                        if (mode === 'tick')
                            fallback(`${label}: schedule 服务下线`);
                        return;
                    }
                    reconcile();
                }
                catch (error) {
                    logger.warn(`${label}: internal/service 监听处理失败（name=${String(name)}）：${messageOf(error)}`);
                }
            });
            if (typeof off === 'function')
                serviceWatchOff = off;
        }
        catch (error) {
            logger.warn(`${label}: 挂 internal/service 监听失败：${messageOf(error)}`);
        }
    }
    function shutdown() {
        if (stopped)
            return;
        stopped = true;
        stopWatchdog();
        dropSubscription();
        dropRule();
        stopInterval();
        const off = serviceWatchOff;
        serviceWatchOff = undefined;
        if (off) {
            try {
                off();
            }
            catch (error) {
                logger.warn(`${label}: 摘 internal/service 监听失败：${messageOf(error)}`);
            }
        }
        mode = 'interval';
    }
    function start() {
        if (started || stopped)
            return;
        started = true;
        // 先挂保底 interval：服务不在、注册失败、tick 断流，业务都还有拍子。
        try {
            const holder = ctx;
            if (typeof holder.effect === 'function') {
                holder.effect(() => {
                    ensureInterval();
                    return () => {
                        shutdown();
                    };
                }, `${label}.timer`);
            }
            else {
                ensureInterval();
            }
        }
        catch (error) {
            logger.warn(`${label}: 挂 effect 失败（${codeOf(error)}）：${messageOf(error)}，定时器仍以 interval 跑`);
            ensureInterval();
        }
        attachServiceWatch();
        try {
            reconcile();
        }
        catch (error) {
            // 兜底：探针/注册里任何漏网的异常都不该把插件的 apply 弄挂。
            logger.warn(`${label}: 首次探服务失败：${messageOf(error)}，先用自己的 ${every}ms 定时器驱动`);
        }
    }
    return {
        start,
        reconcile,
        stop: shutdown,
        mode: () => mode,
        status: () => ({
            mode,
            subscribed: subscription !== undefined,
            registered: ruleRegistered,
            lastTickAt,
            intervalActive: intervalHandle !== null,
        }),
    };
}
//# sourceMappingURL=tick-driver.js.map