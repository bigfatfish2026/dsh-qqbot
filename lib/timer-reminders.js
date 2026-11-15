/** dsh-timer 的提醒表名，和 plugins/dsh-timer/lib/remind.js 的 REMINDER_TABLE 同一个 */
export const REMINDER_TABLE = 'dsh_timer_reminder';
/** 列表最多列几条，超了给一句「还有 n 条」 */
export const MAX_REMINDERS_LISTED = 20;
/** 每行一个 emoji，按状态给：待发 ⏰、发送中 ⏳、失败 ⚠️；认不出的状态给 🔔 */
export const REMINDER_STATE_EMOJI = {
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
/** 群聊里的统一回复：提醒正文与 target 都是 owner 的私事，群里一个字都不吐 */
export const REMINDERS_C2C_ONLY = '该指令仅限私聊使用';
/** 本机时区的星期名，索引就是 Date#getDay()：0 = 周日 */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
/** 一天毫秒数，只用来算日历日差（本地时区，中国无夏令时，round 兜住 23/25 小时的一天） */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 把时刻抹平成本地当天 00:00，只留日历日 */
function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** 这一天的本地周一 00:00 毫秒数（周一起算，和「下周X」的说法对齐） */
function startOfLocalWeek(d) {
    const day = startOfLocalDay(d);
    const backToMonday = (d.getDay() + 6) % 7;
    return day - backToMonday * DAY_MS;
}
/**
 * 从 from 到 to 差几个本地日历日（今天 = 0，明天 = 1，昨天 = -1）。
 * 纯函数，只看本机时区的年月日，不看时分秒。
 */
export function calendarDayDiff(from, to) {
    return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}
/** 「X月X日」，本机时区，不带年份（超过一周才用） */
function monthDay(d) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}
/**
 * 相对日期词，纯函数：
 *   今天 / 明天 / 后天   —— 日历日差 0 / 1 / 2
 *   本周X / 下周X        —— 差 3~7 天，同一周给「本周X」，跨到下一周给「下周X」
 *    X月X日             —— 超过一周，以及已经过去的日子（含本周已过的那天）
 * X 是本机时区的周几。周一切周。
 */
export function relativeDayLabel(due, now = new Date()) {
    const diff = calendarDayDiff(now, due);
    if (diff === 0)
        return '今天';
    if (diff === 1)
        return '明天';
    if (diff === 2)
        return '后天';
    if (diff > 2 && diff <= 7) {
        const prefix = startOfLocalWeek(due) === startOfLocalWeek(now) ? '本周' : '下周';
        return `${prefix}${WEEKDAY_NAMES[due.getDay()]}`;
    }
    return monthDay(due);
}
/** HH:MM，24 小时制，本机时区，两位补零 */
export function formatClock(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/**
 * 一行的日期时段：「明天 09:30」。
 * 坏时刻（不是合法 ISO / 空串）原样吐出来，不抛、不猜。
 */
export function formatDueWhen(dueAt, now = new Date()) {
    const d = new Date(dueAt);
    if (!Number.isFinite(d.getTime()))
        return dueAt || '—';
    return `${relativeDayLabel(d, now)} ${formatClock(d)}`;
}
/** 一行：emoji + 日期 + 时间 + 正文全文（正文不截断，原样保留） */
export function formatReminderLine(item, now = new Date()) {
    const emoji = REMINDER_STATE_EMOJI[item.state] ?? FALLBACK_EMOJI;
    const body = item.text.trim();
    return `${emoji} ${formatDueWhen(item.dueAt, now)}${body ? ` ${body}` : ''}`;
}
/** 把出口读数规整成 ReminderItem[]；不是数组、缺字段一律安全退化 */
export function foldReminders(payload) {
    if (!Array.isArray(payload))
        return [];
    const out = [];
    for (const raw of payload) {
        if (!raw || typeof raw !== 'object')
            continue;
        const row = raw;
        const id = String(row.id ?? '').trim();
        if (!id)
            continue;
        const item = {
            id,
            dueAt: String(row.dueAt ?? ''),
            text: String(row.text ?? ''),
            target: String(row.target ?? ''),
            state: String(row.state ?? ''),
            attempts: Number(row.attempts ?? 0) || 0,
        };
        if (row.lastError !== undefined && row.lastError !== null)
            item.lastError = String(row.lastError);
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
export function renderReminders(items, now = new Date()) {
    if (items.length === 0)
        return NO_REMINDERS;
    const lines = [`${TITLE_EMOJI} 提醒 ${items.length} 条`];
    for (const item of items.slice(0, MAX_REMINDERS_LISTED)) {
        lines.push(formatReminderLine(item, now));
    }
    if (items.length > MAX_REMINDERS_LISTED) {
        lines.push(`…还有 ${items.length - MAX_REMINDERS_LISTED} 条没列`);
    }
    return lines.join('\n');
}
/** 群聊兜底判定：群消息一律不读提醒、不报条数 */
export function isGroupContext(cmdCtx) {
    const message = cmdCtx.message;
    return message?.kind === 'group' || Boolean(message?.groupOpenid);
}
//# sourceMappingURL=timer-reminders.js.map