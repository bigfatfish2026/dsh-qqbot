/**
 * 启动预热 — 网关 ready 后把「保持常驻」的私聊会话提前 resume 进活表
 *
 * 背景：重启后 SessionManager.sessions 是空表，主会话 agent 要等第一条入站消息
 * 才 resume；出站路由（transport/outbound.ts route()）靠 findBySessionId 找人，
 * 找不到就直接 return。于是任何插件开机就想主动说一句话都发不出去。
 *
 * 预热只做「把 agent 拉进活表」：不发送任何消息、不伪造入站消息、不触发 LLM。
 * 候选 = sessionKeepAlivePeers 私聊白名单 + 最近活跃的那个 c2c 私聊 peer。
 *
 * 失败语义：整条链路吞异常只写日志，主流程和真实消息收发不受影响。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { SessionManager } from './session-manager.ts';

/**
 * journal 里过滤预热用的统一前缀 —— 与 bootstrap 的「[im-qqbot] Bot ready!」
 * 走同一个 console 通道。本 profile 下 ctx.logger 没接进 journal，所以预热
 * 观测必须以 console 这份为准（logger 那份保留给宿主日志，测试也在用）。
 */
export const WARMUP_LOG_PREFIX = '[im-qqbot] warmup:';

/** 信息级双写：console.log 进 journal，logger.info 保留 */
export function warmupInfo(logger: Logger, message: string): void {
  console.log(`${WARMUP_LOG_PREFIX} ${message}`);
  logger.info(`warmup: ${message}`);
}

/** 告警级双写：console.warn 进 journal，logger.warn 保留 */
export function warmupWarn(logger: Logger, message: string): void {
  console.warn(`${WARMUP_LOG_PREFIX} ${message}`);
  logger.warn(`warmup: ${message}`);
}

/** 单次预热汇总 */
export interface WarmupOutcome {
  /** 候选条数 */
  total: number;
  /** 新拉进活表 */
  ok: number;
  /** 失败 */
  failed: number;
  /** 跳过（已在活表 / prefs 无映射 / 盘上已不存在） */
  skipped: number;
}

/** 宿主 session 存储根（与 ~/.dsh-qqbot 无关：这里是宿主自己的目录） */
const HOST_SESSIONS_DIR = join(homedir(), '.dsh', 'sessions');

/** 每个 session 目录里用于判活跃的候选文件名前缀（宿主格式变化时宽松匹配） */
const SESSION_FILE_PREFIXES = ['session.v', 'session.'];

/** 从 session 目录（或文件）里取最近一次写入时间，取不到返回 undefined */
function sessionMtime(sessionId: string): number | undefined {
  try {
    if (!existsSync(HOST_SESSIONS_DIR)) return undefined;
    let newest: number | undefined;
    for (const project of readdirSync(HOST_SESSIONS_DIR)) {
      const dir = join(HOST_SESSIONS_DIR, project, sessionId);
      if (!existsSync(dir)) continue;
      const dirStat = statSync(dir);
      if (dirStat.isFile()) return dirStat.mtimeMs;
      let best = dirStat.mtimeMs;
      for (const entry of readdirSync(dir)) {
        if (!SESSION_FILE_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
        try {
          const fileStat = statSync(join(dir, entry));
          if (fileStat.mtimeMs > best) best = fileStat.mtimeMs;
        } catch { /* 单个文件读不到不影响排序 */ }
      }
      if (newest === undefined || best > newest) newest = best;
    }
    return newest;
  } catch {
    return undefined; // 扫盘失败只是排序退化，不影响预热本身
  }
}

/**
 * 收集预热候选（去重、保序）：白名单在前，最近活跃的 c2c 私聊 peer 在后。
 *
 * 「最近活跃」没有持久化时间戳可用（prefs 只存 sessionKey → sessionId），
 * 因此按会话文件 mtime 推断；全都读不到时退化为 prefs 里第一个 c2c。
 */
export function collectWarmupPeers(manager: SessionManager, appId: string): string[] {
  const peers: string[] = [];
  const seen = new Set<string>();
  const push = (peer: string): void => {
    if (!peer || seen.has(peer)) return;
    seen.add(peer);
    peers.push(peer);
  };

  for (const peer of manager.keepAlivePeers) push(peer);

  try {
    const prefix = `qqbot:${appId}:c2c:`;
    let recent: string | undefined;
    let recentAt = -1;
    for (const [key, sessionId] of Object.entries(manager.modelPrefs.snapshot().sessionIds)) {
      if (!key.startsWith(prefix)) continue;
      const peer = key.slice(prefix.length);
      if (!peer) continue;
      const at = sessionMtime(sessionId) ?? 0;
      if (at > recentAt) {
        recentAt = at;
        recent = peer;
      }
    }
    if (recent) push(recent);
  } catch {
    // prefs 快照异常不该拖累白名单预热
  }

  return peers;
}

/** 执行一轮预热（单个 peer 失败不影响其它；本函数自身也不抛） */
export async function runWarmup(
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<WarmupOutcome> {
  const outcome: WarmupOutcome = { total: 0, ok: 0, failed: 0, skipped: 0 };

  let peers: string[] = [];
  try {
    peers = collectWarmupPeers(manager, config.appId);
  } catch (err) {
    warmupWarn(logger, `收集候选失败，跳过本轮: ${errText(err)}`);
    warmupInfo(logger, '预热 0 条，成功 0，失败 1');
    outcome.failed += 1;
    return outcome;
  }

  if (peers.length === 0) {
    warmupInfo(logger, '预热 0 条，成功 0，失败 0（无候选：白名单为空且无 c2c 会话映射）');
    return outcome;
  }

  for (const peer of peers) {
    outcome.total += 1;
    try {
      const result = await manager.warmupPeer(peer);
      if (result === 'ok') {
        outcome.ok += 1;
        warmupInfo(logger, `已预热 peer=${peer}`);
      } else {
        outcome.skipped += 1;
        warmupInfo(logger, `跳过 peer=${peer} reason=${result}`);
      }
    } catch (err) {
      outcome.failed += 1;
      warmupWarn(logger, `失败 peer=${peer}: ${errText(err)}`);
    }
  }

  warmupInfo(logger, `预热 ${outcome.total} 条，成功 ${outcome.ok}，失败 ${outcome.failed}（跳过 ${outcome.skipped}）`);
  return outcome;
}

/**
 * 安排一次延迟预热：网关 ready 后等 N 秒再动手，让启动风暴（插件装载、
 * 会话列表重建）先过去。返回取消函数（生命周期收尾时清定时器）。
 *
 * 延迟配置 sessionWarmupDelayMs（默认 10 秒，0 = 立即），开关 sessionWarmupEnabled。
 */
export function scheduleWarmup(
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): () => void {
  if (!config.sessionWarmupEnabled) {
    warmupInfo(logger, '已关闭（sessionWarmupEnabled=false），跳过');
    return () => {};
  }

  const delay = Math.max(0, config.sessionWarmupDelayMs);
  let cancelled = false;

  const timer = setTimeout(() => {
    if (cancelled) return;
    void runWarmup(manager, config, logger).catch((err: unknown) => {
      // runWarmup 自己吞异常，这里只是兜底，绝不让预热影响主流程
      warmupWarn(logger, `未捕获异常: ${errText(err)}`);
    });
  }, delay);
  // 预热不该拦住进程退出（宿主停服时定时器还在等）
  (timer as { unref?: () => void }).unref?.();

  warmupInfo(logger, `已安排，${delay}ms 后预热 keepAlive 私聊会话`);

  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
