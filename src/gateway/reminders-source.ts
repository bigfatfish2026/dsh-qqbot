/**
 * 提醒读数来源：只读打开 dsh-timer 的 sqlite，拿 dsh_timer_reminder 的行。
 *
 * 和 tickets-source.ts 同一个角色，差别是出口形态：
 *   - 票有进程内 cordis service（`dispatcher/tickets`）可问；
 *   - 提醒没有出口，dsh-timer 只把状态落在自己的库文件里（lib/remind.js 的
 *     openStore），所以这里只读打开那个文件，读完就关。
 *
 * 三条硬规矩：
 *   - 不建表、不写、不迁移：PRAGMA query_only 打开后立刻置上，库文件不在就直接
 *     当读不出来，绝不让 sqlite 顺手新建一个空库；
 *   - 不缓存：每次调用现开现读现关，timer 刚写完的行下一次就看得见；
 *   - 不兜底：读不出来返回 undefined，由 /reminders 说「读不出来」，
 *     不许拿空数组冒充「没有提醒」。
 *
 * 以后 dsh-timer 要是像 dispatcher 那样开个只读出口，只改这一个文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REMINDER_TABLE, type ReminderRow, type RemindersReader } from '../timer-reminders.ts';
import type { Logger } from '../types.ts';

/** 库路径的环境变量覆盖，和 dsh-timer 的 stateDbPath 默认值对齐 */
export const TIMER_DB_ENV = 'DSH_TIMER_DB';

/** dsh-timer 的默认库：~/.dsh-timer/timer.db（plugins/dsh-timer/lib/index.js 的 stateDbPath） */
export const DEFAULT_TIMER_DB_PATH = path.join(os.homedir(), '.dsh-timer', 'timer', 'timer.db');

/** 只读查询：列名对齐 dsh-timer 的建表语句，只取渲染要用的字段 */
const SELECT_ALL = `SELECT id, dueAt, text, target, state, attempts, lastError, nextAttemptAt
  FROM ${REMINDER_TABLE}
  ORDER BY dueAt ASC, createdAt ASC`;

/** 库路径：环境变量优先，否则 dsh-timer 的默认位置 */
export function resolveTimerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env[TIMER_DB_ENV] ?? '').trim();
  return override || DEFAULT_TIMER_DB_PATH;
}

/**
 * 造一条惰性读提醒函数。
 *
 * 库文件不在、表没建、打开失败、查询抛错，一律 undefined；日志只报一次，
 * 别让每条 /reminders 都刷一行。
 */
export function createRemindersReader(
  dbPath: string = resolveTimerDbPath(),
  logger?: Logger,
): RemindersReader {
  let warned = false;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    logger?.warn?.(`im-qqbot: ${message}`);
  };

  return (): ReminderRow[] | undefined => {
    if (!fs.existsSync(dbPath)) {
      warnOnce(`提醒库不在：${dbPath}（/reminders 读不出来）`);
      return undefined;
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      // 只读语义交给 sqlite 自己兜：查询之外的语句一律报错
      db.exec('PRAGMA query_only = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      const rows = db.prepare(SELECT_ALL).all() as unknown as ReminderRow[];
      return Array.isArray(rows) ? rows : undefined;
    } catch (error) {
      warnOnce(`读提醒库 ${dbPath} 失败：${String((error as Error)?.message ?? error)}`);
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        /* 关不掉就算了，下次新开 */
      }
    }
  };
}
