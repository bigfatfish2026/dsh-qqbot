/**
 * 启动预热（session warmup）回归用例
 *
 * 覆盖：开关、延迟调度与取消、keepAlive 名单 + 最近 c2c 候选收集、
 * 幂等（已在活表跳过）、prefs 无映射跳过、盘上不存在跳过、单条失败不影响其它。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry } from './types.ts';

const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

const { SessionManager } = await import('./session-manager.ts');
const { PrefsStore } = await import('../model/prefs-store.ts');
const { runWarmup, scheduleWarmup, collectWarmupPeers } = await import('./warmup.ts');

const APP_ID = 'app1';
const PEER = 'user1';
const OTHER = 'user2';
const key = (peer: string): string => `qqbot:${APP_ID}:c2c:${peer}`;

function fakeAgent(id: string): DshAgent {
  return {
    id,
    ctx: {} as Context,
    status: 'idle',
    session: { id, snapshotEvents: () => [] },
    cancel: vi.fn(),
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal)),
  } as unknown as DshAgent;
}

function fakeHandle(id: string): DshAgentHandle {
  const agent = fakeAgent(id);
  return { agent, dispose: vi.fn(async () => {}) };
}

function persistenceCtx(stat: (id: string) => Promise<{ header?: { agentPreset?: string } } | undefined>): Context {
  return {
    get: (name: string) => (name === 'sessionPersistence' ? { stat } : undefined),
    on: vi.fn(),
  } as unknown as Context;
}

/** 盘上所有会话都存在 */
function onDiskCtx(...ids: string[]): Context {
  return persistenceCtx(async (id) => (ids.includes(id) ? { header: {} } : undefined));
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function allLogText(logger: Logger): string {
  return (['info', 'warn', 'error', 'debug'] as const)
    .flatMap((level) => vi.mocked(logger[level]).mock.calls.flat())
    .map(String)
    .join('\n');
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

function makeConfig(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return ConfigSchema({
    appId: APP_ID,
    appSecret: 'secret',
    provider: 'p',
    model: 'm',
    cwd: join(env.home, 'workspace'),
    sessionIdleTimeout: 0,
    ...overrides,
  } as ImQQBotConfig);
}

function createManager(
  registry: Pick<DshAgentRegistry, 'get' | 'resume' | 'create'>,
  config: ImQQBotConfig = makeConfig(),
  ctx: Context = onDiskCtx('session-live'),
  logger: Logger = createLogger(),
): InstanceType<typeof SessionManager> {
  const manager = new SessionManager(ctx, registry as DshAgentRegistry, config, logger);
  managers.push(manager);
  return manager;
}

function createRegistry(resumeImpl = async ({ resumeSessionId }: { resumeSessionId: string }) => fakeHandle(resumeSessionId)) {
  const registry = {
    get: vi.fn(() => undefined),
    resume: vi.fn(resumeImpl),
    create: vi.fn(async (options: { sessionId: string }) => fakeHandle(options.sessionId)),
  };
  return registry;
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-warmup-'));
  mkdirSync(join(env.home, 'workspace'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('warmup — 候选与执行', () => {
  it('白名单优先且去重：白名单里已含的 c2c 不再重复入列', () => {
    new PrefsStore().setSessionId(key(PEER), 'session-live');
    new PrefsStore().setSessionId(key(OTHER), 'session-live');
    const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [PEER] }));

    expect(collectWarmupPeers(manager, APP_ID)).toEqual([PEER]);
  });

  it('白名单为空：prefs 里的 c2c 私聊 peer 仍会进候选（最近活跃那一个）', () => {
    new PrefsStore().setSessionId(key(PEER), 'session-live');
    new PrefsStore().setSessionId(key(OTHER), 'session-other');
    const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [] }));

    const peers = collectWarmupPeers(manager, APP_ID);

    expect(peers).toHaveLength(1);
    expect([PEER, OTHER]).toContain(peers[0]);
  });

  it('预热把私聊会话拉进活表（活表里出现对应 agent），不发消息', async () => {
    new PrefsStore().setSessionId(key(PEER), 'session-live');
    const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [PEER] }));
    const logger = createLogger();

    const outcome = await runWarmup(manager, makeConfig({ sessionKeepAlivePeers: [PEER], appId: APP_ID }), logger);

    expect(outcome.total).toBeGreaterThanOrEqual(1);
    expect(outcome.ok).toBe(1);
    expect(manager.size).toBe(1);
    expect(manager.getSessionRecord('c2c', PEER)?.sessionId).toBe('session-live');
    expect(allLogText(logger)).toMatch(/预热 1 条，成功 1，失败 0/);
  });

  it('幂等：会话已在活表 → 跳过，不重复 resume', async () => {
    new PrefsStore().setSessionId(key(PEER), 'session-live');
    const registry = createRegistry();
    const manager = createManager(registry, makeConfig({ sessionKeepAlivePeers: [PEER] }));
    await manager.getOrCreate('c2c', PEER, PEER, { scope: 'c2c', targetId: PEER });
    expect(registry.resume).toHaveBeenCalledTimes(1);

    const outcome = await runWarmup(manager, makeConfig({ sessionKeepAlivePeers: [PEER], appId: APP_ID }), createLogger());

    expect(outcome.skipped).toBe(1);
    expect(outcome.ok).toBe(0);
    expect(registry.resume).toHaveBeenCalledTimes(1);
  });

  it('prefs 无映射 / 盘上不存在 → 跳过且不新建会话', async () => {
    new PrefsStore().setSessionId(key(PEER), 'session-gone');
    const registry = createRegistry();
    const manager = createManager(registry, makeConfig({ sessionKeepAlivePeers: [PEER, OTHER] }), onDiskCtx());

    const outcome = await runWarmup(manager, makeConfig({ sessionKeepAlivePeers: [PEER, OTHER], appId: APP_ID }), createLogger());

    expect(outcome.skipped).toBe(2);
    expect(outcome.ok).toBe(0);
    expect(registry.create).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it('单条失败只记日志，不影响其它 peer', async () => {
    const registry = createRegistry(async ({ resumeSessionId }) => {
      if (resumeSessionId === 'session-bad') throw new Error('EIO: corrupt session log');
      return fakeHandle(resumeSessionId);
    });
    new PrefsStore().setSessionId(key(PEER), 'session-bad');
    new PrefsStore().setSessionId(key(OTHER), 'session-good');
    const manager = createManager(
      registry,
      makeConfig({ sessionKeepAlivePeers: [PEER, OTHER] }),
      onDiskCtx('session-bad', 'session-good'),
    );
    const logger = createLogger();

    const outcome = await runWarmup(manager, makeConfig({ sessionKeepAlivePeers: [PEER, OTHER], appId: APP_ID }), logger);

    expect(outcome.failed).toBe(1);
    expect(outcome.ok).toBe(1);
    expect(manager.getSessionRecord('c2c', OTHER)?.sessionId).toBe('session-good');
    expect(allLogText(logger)).toMatch(/预热 2 条，成功 1，失败 1/);
  });

  it('collectWarmupPeers 自身不抛（prefs 快照异常时退回白名单）', () => {
    const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [PEER] }));
    vi.spyOn(manager, 'modelPrefs', 'get').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(collectWarmupPeers(manager, APP_ID)).toEqual([PEER]);
  });
});

describe('warmup — 调度', () => {
  it('开关关闭：不排定时器', async () => {
    const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [PEER] }));
    const logger = createLogger();
    const cancel = scheduleWarmup(manager, makeConfig({ sessionWarmupEnabled: false }), logger);
    cancel();
    expect(allLogText(logger)).toMatch(/已关闭/);
  });

  it('延迟到达后执行一次，取消后不再执行', async () => {
    vi.useFakeTimers();
    try {
      new PrefsStore().setSessionId(key(PEER), 'session-live');
      const manager = createManager(createRegistry(), makeConfig({ sessionKeepAlivePeers: [PEER] }));
      const warmup = vi.spyOn(manager, 'warmupPeer').mockResolvedValue('ok');
      const logger = createLogger();

      const config = makeConfig({ sessionKeepAlivePeers: [PEER], sessionWarmupDelayMs: 10000 });
      const cancel = scheduleWarmup(manager, config, logger);
      await vi.advanceTimersByTimeAsync(9000);
      expect(warmup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(warmup).toHaveBeenCalledWith(PEER);

      warmup.mockClear();
      const cancel2 = scheduleWarmup(manager, config, logger);
      cancel2();
      await vi.advanceTimersByTimeAsync(20000);
      expect(warmup).not.toHaveBeenCalled();
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
