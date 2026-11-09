/**
 * 富媒体过期清理 — 避免下载文件持续膨胀
 *
 * 下载目录 ~/.dsh-qqbot/media，文件写入后不再变更，故文件 mtime 即「下载时间」。
 * 清理时按文件 mtime 判断是否超过保留时长。
 */
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import { createTickDriver } from '../shared/tick-driver.ts';

/** 富媒体下载根目录（attachment.ts 复用） */
export const MEDIA_ROOT = resolve(PLUGIN_HOME, 'media');

/** 定期清理间隔（毫秒），固定 1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 定时清理的 topic：dsh-timer 的 schedule 规则往这发 tick。 */
export const MEDIA_CLEANUP_TOPIC = 'qqbot.media.cleanup.tick';
/** 规则 id：schedule.register 里全局唯一。 */
export const MEDIA_CLEANUP_RULE_ID = 'qqbot.media.cleanup';

/**
 * 清理过期的富媒体文件（按文件 mtime 判断，异步并发执行，不阻塞事件循环）
 *
 * @param ttlHours 保留时长（小时），<=0 表示永不过期（跳过清理）
 * @returns 删除的文件数
 */
export async function cleanupExpiredMedia(ttlHours: number, logger?: Logger): Promise<number> {
  if (ttlHours <= 0) return 0;
  if (!existsSync(MEDIA_ROOT)) return 0;

  const now = Date.now();
  const ttlMs = ttlHours * 60 * 60 * 1000;

  const entries = await readdir(MEDIA_ROOT, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);

  const results = await Promise.all(files.map(async (name) => {
    const filePath = join(MEDIA_ROOT, name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs <= ttlMs) return false;
      await rm(filePath, { force: true });
      logger?.debug(`im-qqbot: cleaned expired media: ${name}`);
      return true;
    } catch (err) {
      logger?.warn(`im-qqbot: media cleanup failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }));

  return results.filter(Boolean).length;
}

/**
 * 启动富媒体过期清理：启动时清理一次 + 定期清理（每 1 小时）
 *
 * 定期那一拍优先由 dsh-timer 的 `qqbot.media.cleanup.tick` 驱动，schedule 不在、
 * 注册被拒或 tick 断流时回落到自己的 1 小时 interval（driver 负责 unref 与
 * ctx.effect 清理）。ttlHours <= 0 时不启动（永不过期）。
 */
export function startMediaCleanup(ctx: Context, ttlHours: number, logger: Logger): void {
  if (ttlHours <= 0) return;

  logger.info(`im-qqbot: media cleanup started (ttl=${ttlHours}h, interval=1h, root=${MEDIA_ROOT})`);

  // 启动时立即清理一次（异步，不阻塞启动流程）——行为保持，与驱动源无关。
  void cleanupExpiredMedia(ttlHours, logger)
    .then((cleaned) => {
      if (cleaned > 0) logger.info(`im-qqbot: cleaned ${cleaned} expired media files`);
    })
    .catch((err) => {
      logger.warn(`im-qqbot: media cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  const driver = createTickDriver({
    ctx,
    topic: MEDIA_CLEANUP_TOPIC,
    ruleId: MEDIA_CLEANUP_RULE_ID,
    every: CLEANUP_INTERVAL_MS,
    run: () => cleanupExpiredMedia(ttlHours, logger).then((cleaned) => {
      if (cleaned > 0) logger.info(`im-qqbot: cleaned ${cleaned} expired media files`);
    }),
    logger,
    label: 'im-qqbot: media-cleanup',
  });
  driver.start();
}
