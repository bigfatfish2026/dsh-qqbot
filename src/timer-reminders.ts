/**
 * 提醒视图公共模块（LOCAL_PATCH reminders-view）
 *
 * 读数唯一来源是 dsh-timer 自己的 sqlite（默认 ~/.dsh-timer/timer.db 的
 * dsh_timer_reminder 表）。本模块不建表、不缓存、不写：/reminders 每次现读现渲染。
 *
 * 和 /tickets 的差别只在读数来源：票有 dispatcher 的只读出口，提醒没有出口，
 * 由 gateway/reminders-source.ts 只读打开那个库文件拿行。库表结构归 dsh-timer
 * （lib/remind.js 的 REMINDER_TABLE），这里只认列名，不改语义。
 *
 * 输出格式（2026-11 改版）：一行一条，只留
 *   emoji + 相对日期 + HH:MM + 正文全文
 * id、目标 openid、状态文字、失败次数、最后错误一律不上屏；正文不截断。
 * 失败行靠 ⚠️ 区分，不再写「失败」二字。长文本切块发送归 commands/reminders.ts。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

/** dsh-timer 的提醒表名，和 plugins/dsh-timer/lib/remind.js 的 REMINDER_TABLE 同一个 */
export const REMINDER_TABLE = 'dsh_timer_reminder';

/** 列表最多列几条，超了给一句「还有 n 条」 */
export const MAX_REMINDERS_LISTED = 20;

/** 每行一个 emoji，按状态给：待发 ⏰、发送中 ⏳、失败 ⚠️；认不出的状态给 🔔 */
export const REMINDER_STATE_EMOJI: Record<string, string> = {
  pending: '⏰',
  sending: '⏳',
  failed: '⚠️',
};

/** 未知状态的兜底 emoji（一条消息里 emoji 也就标题一个 + 每行一个，不撒） */
const FALLBACK_EMOJI = '🔔';

/** 标题行 emoji */
const TITLE_EMOJI = '📋';

/** 没有提醒时回这一句 */
export const NO_REMINDERS = '没有提醒';

/** 读不出来时回这一句（库不在 / 表没建 / 打开失败，都不许拿空表冒充「没有提醒」） */
export const REMINDERS_UNREADABLE = '提醒读不出来（没找到 dsh-timer 的提醒库）';

/** 群聊里的统一回复：提醒正文与 target 都是所有者的私事，群里一个字都不吐 */
export const REMINDERS_C2C_ONLY = '该指令仅限私聊使用';

/** 出口给的一行（字段全部未知类型，规整时安全退化） */
export interface ReminderRow {
  id?: unknown;
  dueAt?: unknown;
  text?: unknown;
  target?: unknown;
  state?: unknown;
  attempts?: unknown;
  lastError?: unknown;
  nextAttemptAt?: unknown;
}

/** 规整后的一条提醒（渲染用） */
export interface ReminderItem {
  id: string;
  dueAt: string;
  text: string;
  target: string;
  state: string;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
}

/** 惰性读提醒函数：每次调用现读库，undefined = 读不出来（区别于空数组 = 没有提醒） */
export type RemindersReader = () => ReminderRow[] | undefined;

/** 本机时区的星期名，索引就是 Date#getDay()：0 = 周日 */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 一天毫秒数，只用来算日历日差（本地时区，中国无夏令时，round 兜住 23/25 小时的一天） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 把时刻抹平成本地当天 00:00，只留日历日 */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 这一天的本地周一 00:00 毫秒数（周一起算，和「下周X」的说法对齐） */
function startOfLocalWeek(d: Date): number {
  const day = startOfLocalDay(d);
  const backToMonday = (d.getDay() + 6) % 7;
  return day - backToMonday * DAY_MS;
}

/**
 * 从 from 到 to 差几个本地日历日（今天 = 0，明天 = 1，昨天 = -1）。
 * 纯函数，只看本机时区的年月日，不看时分秒。
 */
export function calendarDayDiff(from: Date, to: Date): number {
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}

/** 「X月X日」，本机时区，不带年份（超过一周才用） */
function monthDay(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 相对日期词，纯函数：
 *   今天 / 明天 / 后天   —— 日历日差 0 / 1 / 2
 *   本周X / 下周X        —— 差 3~7 天，同一周给「本周X」，跨到下一周给「下周X」
 *    X月X日             —— 超过一周，以及已经过去的日子（含本周已过的那天）
 * X 是本机时区的周几。周一切周。
 */
export function relativeDayLabel(due: Date, now: Date = new Date()): string {
  const diff = calendarDayDiff(now, due);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff > 2 && diff <= 7) {
    const prefix = startOfLocalWeek(due) === startOfLocalWeek(now) ? '本周' : '下周';
    return `${prefix}${WEEKDAY_NAMES[due.getDay()]}`;
  }
  return monthDay(due);
}

/** HH:MM，24 小时制，本机时区，两位补零 */
export function formatClock(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 一行的日期时段：「明天 09:30」。
 * 坏时刻（不是合法 ISO / 空串）原样吐出来，不抛、不猜。
 */
export function formatDueWhen(dueAt: string, now: Date = new Date()): string {
  const d = new Date(dueAt);
  if (!Number.isFinite(d.getTime())) return dueAt || '—';
  return `${relativeDayLabel(d, now)} ${formatClock(d)}`;
}

/** 一行：emoji + 日期 + 时间 + 正文全文（正文不截断，原样保留） */
export function formatReminderLine(item: ReminderItem, now: Date = new Date()): string {
  const emoji = REMINDER_STATE_EMOJI[item.state] ?? FALLBACK_EMOJI;
  const body = item.text.trim();
  return `${emoji} ${formatDueWhen(item.dueAt, now)}${body ? ` ${body}` : ''}`;
}

/** 把出口读数规整成 ReminderItem[]；不是数组、缺字段一律安全退化 */
export function foldReminders(payload: unknown): ReminderItem[] {
  if (!Array.isArray(payload)) return [];
  const out: ReminderItem[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as ReminderRow;
    const id = String(row.id ?? '').trim();
    if (!id) continue;
    const item: ReminderItem = {
      id,
      dueAt: String(row.dueAt ?? ''),
      text: String(row.text ?? ''),
      target: String(row.target ?? ''),
      state: String(row.state ?? ''),
      attempts: Number(row.attempts ?? 0) || 0,
    };
    if (row.lastError !== undefined && row.lastError !== null) item.lastError = String(row.lastError);
    if (row.nextAttemptAt !== undefined && row.nextAttemptAt !== null) {
      item.nextAttemptAt = String(row.nextAttemptAt);
    }
    out.push(item);
  }
  return out;
}

/**
 * 渲染整张表：标题一行（条数，不带括注），然后一行一条。
 * 空表给 NO_REMINDERS。now 可注入，测试用；线上走默认当前时刻。
 */
export function renderReminders(items: ReminderItem[], now: Date = new Date()): string {
  if (items.length === 0) return NO_REMINDERS;
  const lines: string[] = [`${TITLE_EMOJI} 提醒 ${items.length} 条`];
  for (const item of items.slice(0, MAX_REMINDERS_LISTED)) {
    lines.push(formatReminderLine(item, now));
  }
  if (items.length > MAX_REMINDERS_LISTED) {
    lines.push(`…还有 ${items.length - MAX_REMINDERS_LISTED} 条没列`);
  }
  return lines.join('\n');
}

/** 群聊兜底判定：群消息一律不读提醒、不报条数 */
export function isGroupContext(cmdCtx: SlashCommandHandlerContext): boolean {
  const message = cmdCtx.message as { kind?: string; groupOpenid?: string } | undefined;
  return message?.kind === 'group' || Boolean(message?.groupOpenid);
}
