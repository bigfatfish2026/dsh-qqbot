/**
 * IdleEvictor — 闲置会话回收器
 *
 * 定期检查会话最后活跃时间，超时则自动回收释放资源。
 * 私聊常驻名单（keepAlivePeers）里的 c2c 会话不回收；群聊不看名单。
 *
 * 驱动源在 `SessionManager` 里：`qqbot.session.evict.tick`（dsh-timer）优先，
 * 拿不到就回落自己的 60 秒 interval。这里只管「检查一轮」和回收规则。
 */
import type { SessionRecord } from './types.ts';

export class IdleEvictor {
  private readonly sessions: Map<string, SessionRecord>;
  private readonly timeoutMs: number;
  private readonly keepAlivePeers: ReadonlySet<string>;
  private readonly onEvict: (key: string, record: SessionRecord) => void;

  constructor(
    sessions: Map<string, SessionRecord>,
    timeoutMs: number,
    keepAlivePeers: ReadonlySet<string>,
    onEvict: (key: string, record: SessionRecord) => void,
  ) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
    this.keepAlivePeers = keepAlivePeers;
    this.onEvict = onEvict;
  }

  /** 执行一轮回收检查（由 tick 或回落 interval 驱动，重复调幂等） */
  check(): void {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      // 私聊常驻名单：c2c 命中就不回收；群聊不进白名单逻辑
      if (record.scope === 'c2c' && this.keepAlivePeers.has(record.peerId)) continue;
      if (now - record.lastActivity > this.timeoutMs) {
        this.onEvict(key, record);
      }
    }
  }

  /** 停止回收（驱动源由 SessionManager 的 tick driver 收，这里留口子给旧调用方） */
  dispose(): void {}
}
