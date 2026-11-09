/**
 * tick driver 回归用例：tick 优先，降级路径必须真的能用。
 *
 * 六条硬要求各一例：schedule 在 → tick 驱动且原生 interval 被停；schedule 不在 →
 * 回落且 unref 被调；register 抛 EV-006 → 回落；internal/service 就绪 → 重新注册；
 * tick 断流 3 拍 → 回落；同一拍重复 tick 不重复执行。另补服务中途消失、监听器
 * 吞错不 rethrow、卸载走 ctx.effect 清理三条。
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import {
  createTickDriver,
  type TickClock,
  type TickEventsService,
  type TickScheduleService,
} from './tick-driver.ts';

const TOPIC = 'qqbot.test.tick';
const RULE_ID = 'qqbot.test';
const EVERY = 60_000;

interface FakeHandle {
  id: number;
  ms: number;
  fn: () => void;
  unrefCalls: number;
  unref: () => void;
}

/** 假时钟：推进时把到点的定时器都打一拍；句柄记 unref 调用。 */
function fakeClock() {
  const handles: FakeHandle[] = [];
  let seq = 0;
  let time = 1_700_000_000_000;
  const clock = {
    now: () => time,
    setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
      const handle: FakeHandle = {
        id: ++seq,
        ms,
        fn,
        unrefCalls: 0,
        unref() {
          handle.unrefCalls += 1;
        },
      };
      handles.push(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle: ReturnType<typeof setInterval>): void {
      const index = handles.findIndex((item) => item.id === (handle as unknown as FakeHandle).id);
      if (index >= 0) handles.splice(index, 1);
    },
    advance(ms: number): void {
      time += ms;
      for (const handle of [...handles]) handle.fn();
    },
  };
  return { clock: clock as TickClock, handles, advance: clock.advance, now: () => time };
}

/** 假 events：defineEvent 记账，subscribe 可派发，registry 可配置抛错。 */
function fakeEvents() {
  const defined = new Map<string, { durability: string; payloadSchema?: (payload: unknown) => boolean }>();
  const subs: Array<{
    pattern: string;
    handler: (event: { payload?: unknown }) => unknown;
    stopped: boolean;
    stop: () => void;
  }> = [];
  const state = {
    registryThrows: false,
    service: {
      defineEvent(def: { name: string }) {
        if (defined.has(def.name)) {
          throw Object.assign(new Error(`事件类型重复注册：${def.name}`), { code: 'EV-001' });
        }
        defined.set(def.name, def);
        return def;
      },
      subscribe(pattern: string, handler: (event: { payload?: unknown }) => unknown) {
        const sub = {
          pattern,
          handler,
          stopped: false,
          stop() {
            sub.stopped = true;
          },
        };
        subs.push(sub);
        return sub;
      },
      registry: {
        get(name: string) {
          if (state.registryThrows) throw new Error('registry down');
          return defined.get(name);
        },
      },
    },
    defined,
    subs,
  };
  return state;
}

/** 假 schedule：register 记账，可按需抛 EV-006/其它错。 */
function fakeSchedule(events: ReturnType<typeof fakeEvents>) {
  const rules = new Map<string, unknown>();
  const state = {
    registerCalls: 0,
    failNext: undefined as Error | undefined,
    rules,
    service: {
      register(rule: { id: string; topic: string }) {
        state.registerCalls += 1;
        if (state.failNext) {
          const error = state.failNext;
          state.failNext = undefined;
          throw error;
        }
        if (!events.defined.has(rule.topic)) {
          throw Object.assign(new Error(`EV-006 定时规则引用了未注册的 topic：${rule.topic}`), {
            code: 'EV-006',
          });
        }
        rules.set(rule.id, rule);
        return rule;
      },
      unregister(id: string) {
        rules.delete(id);
      },
    },
  };
  return state;
}

/** 假 ctx：get 查服务表，on 记监听，effect 立刻执行并收清理函数。 */
function fakeContext() {
  const services = new Map<string, unknown>();
  const listeners: Array<{ event: string; fn: (name: unknown, value: unknown) => void; off: boolean }> = [];
  const cleanups: Array<() => void> = [];
  const effects: string[] = [];
  const state = { getThrows: false };
  const ctx = {
    get(name: string) {
      if (state.getThrows) throw new Error('ctx.get boom');
      return services.get(name);
    },
    on(event: string, fn: (name: unknown, value: unknown) => void) {
      const entry = { event, fn, off: false };
      listeners.push(entry);
      return () => {
        entry.off = true;
      };
    },
    effect(fn: () => (() => void) | void, name?: string) {
      effects.push(name ?? '');
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  return {
    ctx: ctx as unknown as Context,
    services,
    listeners,
    cleanups,
    effects,
    state,
    emit(event: string, name: unknown, value?: unknown) {
      for (const entry of [...listeners]) {
        if (!entry.off && entry.event === event) entry.fn(name, value);
      }
    },
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

function loggerStub(warns: string[], infos: string[]): Logger {
  return {
    info: (message: string) => {
      infos.push(message);
    },
    warn: (message: string) => {
      warns.push(message);
    },
    error: () => {},
    debug: () => {},
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(options: { schedule?: boolean; events?: boolean; run?: () => unknown } = {}) {
  const clock = fakeClock();
  const events = fakeEvents();
  const schedule = fakeSchedule(events);
  const h = fakeContext();
  if (options.events !== false) h.services.set('events', events.service as unknown as TickEventsService);
  if (options.schedule !== false) h.services.set('schedule', schedule.service as unknown as TickScheduleService);

  const runs: number[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const driver = createTickDriver({
    ctx: h.ctx,
    topic: TOPIC,
    ruleId: RULE_ID,
    every: EVERY,
    run: options.run ?? (() => {
      runs.push(clock.now());
    }),
    logger: loggerStub(warns, infos),
    label: 'test',
    clock: clock.clock,
  });
  driver.start();
  return { h, clock, events, schedule, driver, runs, warns, infos };
}

const tickPayload = (periodKey: string) => ({
  name: TOPIC,
  firedAt: '2026-11-09T13:30:00.000Z',
  periodKey,
});

describe('tick driver：schedule 在', () => {
  it('注册规则并订阅 tick，成功后自己的 interval 被停', async () => {
    const { schedule, events, clock, driver, runs } = setup();

    expect(schedule.rules.get(RULE_ID)).toEqual({
      id: RULE_ID,
      every: EVERY,
      topic: TOPIC,
      catchUp: 'skip',
    });
    expect(driver.mode()).toBe('tick');
    expect(driver.status().registered).toBe(true);
    expect(driver.status().intervalActive).toBe(false);
    expect(events.subs).toHaveLength(1);

    const def = events.defined.get(TOPIC) as {
      durability: string;
      payloadSchema: (payload: unknown) => boolean;
    };
    expect(def.durability).toBe('volatile');
    expect(def.payloadSchema(tickPayload('qqbot.test.every1m.1'))).toBe(true);
    expect(def.payloadSchema({ name: TOPIC })).toBe(false);

    // 旧定时器真没了：推进一个原周期，业务一拍都不跑。
    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base);

    expect(events.subs[0]?.handler({ payload: tickPayload('qqbot.test.every1m.1') })).toBeUndefined();
    await flush();
    expect(runs.length).toBe(base + 1);
  });

  it('schedule 换实例后重挂规则，不重复订阅', () => {
    const { schedule, events, h, driver } = setup();
    const replacement = fakeSchedule(events);
    h.services.set('schedule', replacement.service as unknown as TickScheduleService);

    driver.reconcile();

    expect(replacement.rules.has(RULE_ID)).toBe(true);
    expect(events.subs).toHaveLength(1);
    expect(driver.mode()).toBe('tick');
  });

  it('同一拍重复 tick 不重复执行，换一拍照常跑', async () => {
    const { events, runs } = setup();
    const first = tickPayload('qqbot.test.every1m.42');

    events.subs[0]?.handler({ payload: first });
    await flush();
    events.subs[0]?.handler({ payload: first });
    await flush();
    expect(runs.length).toBe(1);

    events.subs[0]?.handler({ payload: tickPayload('qqbot.test.every1m.43') });
    await flush();
    expect(runs.length).toBe(2);
  });

  it('tick 断流 3 个周期：回落自己的 interval 并只 warn 一次', () => {
    const { clock, driver, runs, warns } = setup();
    expect(driver.mode()).toBe('tick');

    clock.advance(EVERY);
    clock.advance(EVERY);
    expect(driver.mode()).toBe('tick');

    clock.advance(EVERY);
    expect(driver.mode()).toBe('interval');
    expect(driver.status().intervalActive).toBe(true);
    expect(warns.join('\n')).toContain('没收到 tick');
    const warnCount = warns.length;
    // 冷却期内再推进：不重复 warn，interval 照常跑。
    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base + 1);
    expect(warns.length).toBe(warnCount);
  });
});

describe('tick driver：降级路径', () => {
  it('schedule 不在：保留 interval、unref 被调、照常一拍一拍跑', () => {
    const { clock, schedule, driver, runs, infos } = setup({ schedule: false });

    expect(driver.mode()).toBe('interval');
    expect(schedule.registerCalls).toBe(0);
    expect(infos.join('\n')).toContain('没有 schedule 服务');

    const interval = clock.handles.find((handle) => handle.ms === EVERY);
    expect(interval?.unrefCalls).toBe(1);

    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base + 1);
  });

  it('register 抛 EV-006：interval 保留、打一行 warn、冷却期内不反复重试', () => {
    const { h, clock, schedule, driver, runs, warns } = setup({ schedule: false });

    h.services.set('schedule', schedule.service as unknown as TickScheduleService);
    schedule.failNext = Object.assign(new Error('EV-006 定时规则引用了未注册的 topic'), {
      code: 'EV-006',
    });
    driver.reconcile();

    expect(warns.join('\n')).toContain('EV-006');
    expect(driver.mode()).toBe('interval');

    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base + 1);

    const tries = schedule.registerCalls;
    driver.reconcile();
    expect(schedule.registerCalls).toBe(tries);
  });

  it('events 不在：不注册、interval 照跑', () => {
    const { clock, schedule, driver, runs, infos } = setup({ events: false });

    expect(driver.mode()).toBe('interval');
    expect(schedule.registerCalls).toBe(0);
    expect(infos.join('\n')).toContain('没有 events 服务');

    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base + 1);
  });

  it('schedule 中途消失：tick 模式当场回落并 warn', () => {
    const { h, driver, warns } = setup();
    expect(driver.mode()).toBe('tick');

    h.services.delete('schedule');
    driver.reconcile();

    expect(driver.mode()).toBe('interval');
    expect(driver.status().intervalActive).toBe(true);
    expect(warns.join('\n')).toContain('schedule 服务不在了');
  });

  it('internal/service 就绪：重新注册并切回 tick', () => {
    const { h, schedule, driver } = setup({ schedule: false });
    expect(schedule.registerCalls).toBe(0);
    expect(driver.mode()).toBe('interval');

    h.services.set('schedule', schedule.service as unknown as TickScheduleService);
    h.emit('internal/service', 'schedule', schedule.service);

    expect(schedule.rules.get(RULE_ID)).toEqual({
      id: RULE_ID,
      every: EVERY,
      topic: TOPIC,
      catchUp: 'skip',
    });
    expect(driver.mode()).toBe('tick');
  });

  it('internal/service 销毁：清缓存并回落', () => {
    const { h, driver, warns } = setup();
    expect(driver.mode()).toBe('tick');

    h.emit('internal/service', 'schedule', undefined);

    expect(driver.mode()).toBe('interval');
    expect(warns.join('\n')).toContain('schedule 服务下线');
  });

  it('探针抛错：只 warn 不崩，interval 照跑', () => {
    const { h, clock, driver, runs, warns } = setup({ schedule: false });

    h.state.getThrows = true;
    expect(() => driver.reconcile()).not.toThrow();
    expect(warns.join('\n')).toContain('探 events 服务失败');
    expect(driver.mode()).toBe('interval');

    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base + 1);
  });
});

describe('tick driver：生命周期', () => {
  it('卸载走 ctx.effect 清理：interval 被 clearInterval，不再跑', () => {
    const { h, clock, driver, runs } = setup({ schedule: false });
    expect(clock.handles.length).toBe(1);

    h.unmount();

    expect(clock.handles.length).toBe(0);
    const base = runs.length;
    clock.advance(EVERY);
    expect(runs.length).toBe(base);
    expect(driver.mode()).toBe('interval');
  });

  it('stop 幂等，收摊后退订、撤规则、停 interval', () => {
    const { events, schedule, clock, driver } = setup();
    driver.stop();
    driver.stop();

    expect(events.subs[0]?.stopped).toBe(true);
    expect(schedule.rules.has(RULE_ID)).toBe(false);
    expect(clock.handles.length).toBe(0);
    expect(driver.status().intervalActive).toBe(false);
  });
});
