/**
 * IdleEvictor 回归用例：私聊常驻白名单（sessionKeepAlivePeers）
 *
 * - 名单里的 c2c 会话超时也不回收
 * - 名单外的 c2c 会话照旧回收
 * - 群聊不看名单：peerId 撞上名单也照旧回收
 * - 名单为空时行为与原来一致
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IdleEvictor } from './idle-evictor.ts';
import type { SessionRecord } from './types.ts';

const NOW = 1_700_000_000_000;
const TIMEOUT = 30 * 60 * 1000;
const KEEP = '64532D871A10E466D163FD001524AD83';

function record(scope: SessionRecord['scope'], peerId: string, lastActivity: number): SessionRecord {
  return {
    sessionKey: `qqbot:app1:${scope}:${peerId}`,
    sessionId: `session-${scope}-${peerId}`,
    agent: {} as SessionRecord['agent'],
    handle: {} as SessionRecord['handle'],
    replyTarget: { scope, targetId: peerId, msgId: 'm1' },
    scope,
    peerId,
    senderId: peerId,
    lastActivity,
  };
}

const evictors: IdleEvictor[] = [];

function run(sessions: SessionRecord[], keepAlivePeers: string[]): string[] {
  const map = new Map(sessions.map((r) => [r.sessionKey, r]));
  const evicted: string[] = [];
  const evictor = new IdleEvictor(map, TIMEOUT, new Set(keepAlivePeers), (key) => evicted.push(key));
  evictors.push(evictor);
  evictor.check();
  return evicted;
}

afterEach(() => {
  for (const evictor of evictors.splice(0)) evictor.dispose();
  vi.restoreAllMocks();
});

describe('IdleEvictor 私聊常驻白名单', () => {
  it('名单里的私聊超时也不回收', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const idle = record('c2c', KEEP, NOW - TIMEOUT - 60_000);
    expect(run([idle], [KEEP])).toEqual([]);
  });

  it('名单外的私聊照旧回收', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const idle = record('c2c', 'other-openid', NOW - TIMEOUT - 60_000);
    expect(run([idle], [KEEP])).toEqual([idle.sessionKey]);
  });

  it('群聊即便 peerId 在名单里也照旧回收', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const idle = record('group', KEEP, NOW - TIMEOUT - 60_000);
    expect(run([idle], [KEEP])).toEqual([idle.sessionKey]);
  });

  it('名单为空时行为不变：活跃的留、超时的收', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fresh = record('c2c', KEEP, NOW - 1000);
    const stale = record('c2c', 'other-openid', NOW - TIMEOUT - 1);
    expect(run([fresh, stale], [])).toEqual([stale.sessionKey]);
  });
});
