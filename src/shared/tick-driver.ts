/**
 * 业务定时器的驱动源：dsh-timer 的 schedule 发 tick 优先，拿不到就自己数秒。
 *
 * 这一层只换驱动源，不碰业务：每一拍调用传进来的 `run`，回收阈值、清理规则
 * 全由调用方决定。四条降级路径都不能让业务停摆：
 *
 * - `schedule` 不在（dsh-timer 没挂、或还没 apply）：保留自己的 interval，每次
 *   reconcile 再探一次——它中途出现就切过去。
 * - 注册被拒（EV-006：topic 没在 events 注册表里；BAD_RULE：every 小于 5000 或
 *   id 被占）：保留自己的 interval，冷却一段时间再试，别每拍刷一行 warn。
 * - 服务中途消失（events 或 schedule 被撤）：当场退回自己的 interval 并 warn。
 * - tick 断流（dsh-timer 停了、events 没了、规则被撤了）：watchdog 按「三个周期
 *   没收到 tick」判死，退订 + 注销规则 + 恢复自己的 interval 并 warn 一次。
 *
 * 三把锁：
 *
 * - 拍子不并发：`running` 闸门管住 interval 与订阅两路。
 * - 同一拍不重复：tick 的 `periodKey` 相同就跳过（dsh-timer 重扫、重投都靠它）。
 * - 换源幂等：订阅只有一份、规则只注册一次，换源先停旧再起新。
 *
 * 回落路径的 interval 一律 `unref()`，并由 `ctx.effect` 的清理函数负责
 * `clearInterval`；插件卸载时不留定时器。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';

/** dsh-timer 发 tick 的 payload：只有到点信号，没有业务数据。 */
export interface TickPayload {
  name: string;
  firedAt: string;
  periodKey: string;
}

/** 事件类型注册项。volatile：tick 是到点信号，不落事件表、不重放。 */
export function tickEventDef(topic: string) {
  return Object.freeze({
    name: topic,
    version: 1,
    durability: 'volatile' as const,
    payloadSchema: (payload: unknown): boolean => {
      const tick = payload as Partial<TickPayload> | undefined;
      return typeof tick?.name === 'string'
        && typeof tick.firedAt === 'string'
        && typeof tick.periodKey === 'string';
    },
  });
}

/** 本插件眼里 dsh-events 服务的最小面。 */
export interface TickEventsService {
  defineEvent(def: ReturnType<typeof tickEventDef>): unknown;
  subscribe(
    pattern: string,
    handler: (event: { payload?: unknown }) => unknown,
    options?: { subscriberId?: string; replay?: { mode: 'none' } },
  ): { stop?: () => void } | undefined;
  registry?: { get(name: string, version?: number): unknown };
}

/** 本插件眼里 dsh-timer 调度服务的最小面。 */
export interface TickScheduleService {
  register(rule: { id: string; every: number; topic: string; catchUp: 'skip' }): unknown;
  unregister(id: string): unknown;
}

/** 时钟抽象：测试用假时钟推进，真跑用系统时钟。 */
export interface TickClock {
  now(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const realClock: TickClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export interface TickDriverOptions {
  ctx: Context;
  /** dsh-timer 发 tick 的事件名，也是订阅/注册用的 topic。 */
  topic: string;
  /** 规则 id：`schedule.register` 里全局唯一，注销时按它撤。 */
  ruleId: string;
  /** 业务周期（毫秒），必须与迁走之前自己的 setInterval 一致。 */
  every: number;
  /** 业务一拍：同步或异步都行，异常由 driver 兜住。 */
  run: () => unknown;
  logger: Logger;
  /** 日志前缀，例如 `im-qqbot: idle-evict`。 */
  label: string;
  clock?: TickClock;
}

export interface TickDriver {
  /** 起驱动：先挂保底 interval，再探服务，注册成功就停自己的定时器。 */
  start(): void;
  /** 探一次服务，该换源就换。幂等，可以每拍都调。 */
  reconcile(): void;
  /** 收摊：停 watchdog、退订、撤规则、停 interval、摘监听。 */
  stop(): void;
  mode(): 'interval' | 'tick';
  status(): {
    mode: 'interval' | 'tick';
    subscribed: boolean;
    registered: boolean;
    lastTickAt: number;
    intervalActive: boolean;
  };
}

/** tick 断流判定：这么多拍没来就认死。 */
const STALL_FACTOR = 3;
/** 失败后的冷却：最短 1 分钟，别每拍都撞同一堵墙。 */
const MIN_RETRY_MS = 60_000;
const RETRY_FACTOR = 30;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code ? code : 'ERR';
}

export function createTickDriver(options: TickDriverOptions): TickDriver {
  const { ctx, topic, ruleId, every, run, logger } = options;
  const label = options.label;
  const clock = options.clock ?? realClock;
  const stallMs = Math.max(every * STALL_FACTOR, every + 1);
  const retryMs = Math.max(every * RETRY_FACTOR, MIN_RETRY_MS);

  let mode: 'interval' | 'tick' = 'interval';
  let started = false;
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let subscription: { stop?: () => void } | undefined;
  let ruleRegistered = false;
  let lastTickAt = 0;
  let lastPeriodKey: string | undefined;
  let running = false;
  let retryAt = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  /** 上次看到的 schedule 服务实例：换实例等于规则全丢，得在新实例上重挂。 */
  let scheduleSeen: TickScheduleService | undefined;
  /** 只缓存成功的探针结果；对象变了就跟着换，服务消失就清空。 */
  let scheduleCache: TickScheduleService | undefined;
  let eventsCache: TickEventsService | undefined;
  /** 「某某不在」各只播报一次，服务出现过再消失时重新播报。 */
  let eventsAbsentAnnounced = false;
  let scheduleAbsentAnnounced = false;
  let serviceWatchOff: (() => void) | undefined;

  function now(): number {
    return clock.now();
  }

  /** 惰性探针：每次现取，只缓存拿到手的服务对象。 */
  function probeEvents(): TickEventsService | undefined {
    try {
      const candidate = ctx.get('events') as TickEventsService | undefined;
      if (candidate && typeof candidate.defineEvent === 'function' && typeof candidate.subscribe === 'function') {
        if (eventsCache !== candidate) eventsCache = candidate;
        return eventsCache;
      }
    } catch (error) {
      logger.warn(`${label}: 探 events 服务失败：${messageOf(error)}`);
    }
    eventsCache = undefined;
    return undefined;
  }

  function probeSchedule(): TickScheduleService | undefined {
    try {
      const candidate = ctx.get('schedule') as TickScheduleService | undefined;
      if (candidate && typeof candidate.register === 'function') {
        if (scheduleCache !== candidate) scheduleCache = candidate;
        return scheduleCache;
      }
    } catch (error) {
      logger.warn(`${label}: 探 schedule 服务失败：${messageOf(error)}`);
    }
    scheduleCache = undefined;
    return undefined;
  }

  function ensureInterval(): void {
    if (intervalHandle || stopped) return;
    intervalHandle = clock.setInterval(() => {
      pulse('interval');
    }, every);
    (intervalHandle as unknown as { unref?: () => void }).unref?.();
  }

  function stopInterval(): void {
    if (!intervalHandle) return;
    clock.clearInterval(intervalHandle);
    intervalHandle = null;
  }

  function stopWatchdog(): void {
    if (!watchdog) return;
    clock.clearInterval(watchdog);
    watchdog = null;
  }

  /**
   * 业务一拍。两路驱动共用一个闸：上一拍没跑完就跳过这一拍，宁可少一次，
   * 也不让同一份数据被并发处理（回收/删除都要求幂等）。
   */
  function pulse(source: 'interval' | 'tick'): void {
    if (stopped || running) return;
    running = true;
    let result: unknown;
    try {
      result = run();
    } catch (error) {
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

  function handleTick(payload: unknown): void {
    if (stopped) return;
    // 先记时间：被闸掉的那一拍也算「流还活着」，否则 watchdog 会误判断流。
    lastTickAt = now();
    const key = (payload as Partial<TickPayload> | undefined)?.periodKey;
    if (typeof key === 'string' && key) {
      // 同一拍重复投递（dsh-timer 重扫、订阅重连补发）不能重复干活。
      if (key === lastPeriodKey) return;
      lastPeriodKey = key;
    }
    pulse('tick');
    reconcile();
  }

  function dropSubscription(): boolean {
    const sub = subscription;
    if (!sub) return false;
    subscription = undefined;
    try {
      sub.stop?.();
    } catch (error) {
      logger.warn(`${label}: 退订 ${topic} 失败：${messageOf(error)}`);
    }
    return true;
  }

  function dropRule(): void {
    if (!ruleRegistered) return;
    ruleRegistered = false;
    const service = probeSchedule();
    if (!service) return;
    try {
      service.unregister(ruleId);
    } catch (error) {
      logger.warn(`${label}: 注销规则 ${ruleId} 失败：${messageOf(error)}`);
    }
  }

  function ensureSubscription(service: TickEventsService): boolean {
    if (subscription) return true;
    try {
      service.defineEvent(tickEventDef(topic));
    } catch (error) {
      // 重复注册（热重载、上一份 fiber 已注册过）不算失败：注册表里查得到就行。
      let registered = false;
      try {
        registered = service.registry?.get(topic) !== undefined;
      } catch {
        // 注册表本身读不了：保守当作已注册，订阅那一步会给出最终答案。
        registered = true;
      }
      if (!registered) {
        logger.warn(
          `${label}: 注册事件类型 ${topic} 失败（${codeOf(error)}）：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`,
        );
        return false;
      }
    }
    try {
      const sub = service.subscribe(
        topic,
        (event) => {
          handleTick(event?.payload);
          return undefined;
        },
        { subscriberId: ruleId, replay: { mode: 'none' } },
      );
      if (!sub || typeof sub.stop !== 'function') {
        logger.warn(`${label}: 订阅 ${topic} 没拿到 stop()，继续由自己的 ${every}ms 定时器驱动`);
        return false;
      }
      subscription = sub;
      logger.info(`${label}: 已订阅 ${topic}（volatile，不落事件表）`);
      return true;
    } catch (error) {
      logger.warn(`${label}: 订阅 ${topic} 失败：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`);
      return false;
    }
  }

  function registerRule(service: TickScheduleService): boolean {
    try {
      service.register({ id: ruleId, every, topic, catchUp: 'skip' });
      ruleRegistered = true;
      retryAt = 0;
      return true;
    } catch (error) {
      ruleRegistered = false;
      retryAt = now() + retryMs;
      logger.warn(
        `${label}: 注册规则 ${ruleId} 失败（${codeOf(error)}）：${messageOf(error)}，继续由自己的 ${every}ms 定时器驱动`,
      );
      return false;
    }
  }

  function startWatchdog(): void {
    stopWatchdog();
    watchdog = clock.setInterval(() => {
      if (stopped || mode !== 'tick') return;
      const idle = now() - lastTickAt;
      if (idle < stallMs) return;
      // 断流不是「少跑一拍」而是「再也不会跑」：必须当场把驱动源换回来。
      fallback(`${label}: ${topic} 连续 ${STALL_FACTOR} 个周期（${Math.round(idle / 1_000)} 秒）没收到 tick`);
    }, every);
    (watchdog as unknown as { unref?: () => void }).unref?.();
  }

  /** 注册成功之后才停自己的 interval——顺序反了就会出现「两边都没在跑」的缝。 */
  function switchToTick(): void {
    mode = 'tick';
    lastTickAt = now();
    stopInterval();
    startWatchdog();
    logger.info(
      `${label}: 改由 ${topic} 驱动（规则 ${ruleId}，每 ${every}ms，catchUp=skip），自己的定时器已停`,
    );
  }

  /** 降级：退回自己的 interval，并说明原因。只在 tick 模式下有意义，warn 只发一次。 */
  function fallback(reason: string): void {
    if (stopped || mode !== 'tick') return;
    mode = 'interval';
    stopWatchdog();
    dropSubscription();
    dropRule();
    ensureInterval();
    retryAt = now() + retryMs;
    logger.warn(`${reason}，${label} 回落到自己的 ${every}ms 定时器`);
  }

  function reconcile(): void {
    if (stopped) return;

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

    if (!ensureSubscription(eventsService)) return;

    const scheduleService = probeSchedule();
    if (!scheduleService) {
      if (mode === 'tick') {
        fallback(`${label}: schedule 服务不在了`);
        return;
      }
      if (!scheduleAbsentAnnounced) {
        scheduleAbsentAnnounced = true;
        logger.info(
          `${label}: 没有 schedule 服务，当前由自己的 ${every}ms 定时器驱动，等服务出现再切 ${topic}`,
        );
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

    if (mode === 'tick' && ruleRegistered) return;
    if (now() < retryAt) return;

    if (registerRule(scheduleService)) switchToTick();
  }

  /**
   * `internal/service` 监听：schedule 就绪就重挂规则，不用等下一拍。
   *
   * ⚠ 回调整体包 try/catch，这条是硬要求：dsh-events 的 emit 是
   * `dispatch(...).map(cb => cb(...args))`，没有 try/catch，监听器抛错会冒到
   * timer 的 provide/effect，可能把 timer 的 apply 弄挂。catch 里只 warn，绝不 rethrow。
   */
  function attachServiceWatch(): void {
    const holder = ctx as unknown as {
      on?: (
        event: string,
        listener: (name: unknown, value: unknown) => void,
      ) => (() => void) | void;
    };
    if (typeof holder.on !== 'function') return;
    try {
      const off = holder.on('internal/service', (name, value) => {
        try {
          if (name !== 'schedule') return;
          // 服务实例变了：缓存、规则标记全部作废，下面重新探。
          scheduleCache = undefined;
          scheduleSeen = undefined;
          ruleRegistered = false;
          retryAt = 0;
          if (!value) {
            // 销毁：别在这里 reconcile（服务马上要再来，纯噪音），只在 tick 模式下回落。
            if (mode === 'tick') fallback(`${label}: schedule 服务下线`);
            return;
          }
          reconcile();
        } catch (error) {
          logger.warn(
            `${label}: internal/service 监听处理失败（name=${String(name)}）：${messageOf(error)}`,
          );
        }
      });
      if (typeof off === 'function') serviceWatchOff = off;
    } catch (error) {
      logger.warn(`${label}: 挂 internal/service 监听失败：${messageOf(error)}`);
    }
  }

  function shutdown(): void {
    if (stopped) return;
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
      } catch (error) {
        logger.warn(`${label}: 摘 internal/service 监听失败：${messageOf(error)}`);
      }
    }
    mode = 'interval';
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    // 先挂保底 interval：服务不在、注册失败、tick 断流，业务都还有拍子。
    try {
      const holder = ctx as unknown as {
        effect?: (fn: () => (() => void) | void, name?: string) => unknown;
      };
      if (typeof holder.effect === 'function') {
        holder.effect(() => {
          ensureInterval();
          return () => {
            shutdown();
          };
        }, `${label}.timer`);
      } else {
        ensureInterval();
      }
    } catch (error) {
      logger.warn(`${label}: 挂 effect 失败（${codeOf(error)}）：${messageOf(error)}，定时器仍以 interval 跑`);
      ensureInterval();
    }
    attachServiceWatch();
    try {
      reconcile();
    } catch (error) {
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
