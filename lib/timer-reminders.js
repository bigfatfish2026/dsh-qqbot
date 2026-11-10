/** dsh-timer 的提醒表名，和 plugins/dsh-timer/lib/remind.js 的 REMINDER_TABLE 同一个 */
export const REMINDER_TABLE = 'dsh_timer_reminder';
/** 正文截断长度：提醒正文可能很长，列出来只留前这么多字 */
export const MAX_TEXT_CHARS = 60;
/** 失败原因截断长度 */
const MAX_ERROR_CHARS = 80;
/** 列表最多列几条，超了给一句「还有 n 条」 */
export const MAX_REMINDERS_LISTED = 20;
/** 状态标签，和 dsh-timer 的 timer_remind_list 工具同一套说法 */
export const REMINDER_STATE_LABEL = {
    pending: '待发',
    sending: '发送中',
    failed: '失败',
};
/** 没有提醒时回这一句 */
export const NO_REMINDERS = '没有提醒';
/** 读不出来时回这一句（库不在 / 表没建 / 打开失败，都不许拿空表冒充「没有提醒」） */
export const REMINDERS_UNREADABLE = '提醒读不出来（没找到 dsh-timer 的提醒库）';
/** 群聊里的统一回复：提醒正文与 target 都是所有者的私事，群里一个字都不吐 */
export const REMINDERS_C2C_ONLY = '该指令仅限私聊使用';
/** 按字符（不是 UTF-16 码元）截断，超了补省略号 */
function clip(text, limit) {
    const chars = [...text];
    if (chars.length <= limit)
        return text;
    return `${chars.slice(0, limit).join('')}…`;
}
/** 本地时区的「YYYY-MM-DD HH:mm」；坏时间原样返回，不抛 */
export function clock(isoText) {
    const d = new Date(isoText);
    if (!Number.isFinite(d.getTime()))
        return isoText;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 目标缩写：c2c:00000000…ABCD，只留够认人的头尾 */
export function shortTarget(target) {
    const m = /^(c2c|group):(.+)$/.exec(target);
    if (!m)
        return target;
    const [, kind, id] = m;
    const tail = id.length > 4 ? id.slice(-4) : id;
    const head = id.length > 8 ? `${id.slice(0, 8)}…` : '';
    return `${kind}:${head}${tail}`;
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
/** 渲染一行的第一段：id · 时刻 · 状态 → 目标 */
function renderHead(item) {
    const label = REMINDER_STATE_LABEL[item.state] ?? (item.state || '未知');
    const extra = item.state === 'failed' && item.attempts > 0 ? `（${item.attempts} 次）` : '';
    const at = item.dueAt ? clock(item.dueAt) : '—';
    return `${item.id} · ${at} · ${label}${extra} → ${shortTarget(item.target)}`;
}
/**
 * 渲染整张表。
 * 空表给 NO_REMINDERS；有条目先报总数（待发 / 失败分项），再逐条列。
 */
export function renderReminders(items) {
    if (items.length === 0)
        return NO_REMINDERS;
    const pending = items.filter((i) => i.state === 'pending').length;
    const failed = items.filter((i) => i.state === 'failed').length;
    const parts = [`待发 ${pending}`];
    if (failed > 0)
        parts.push(`失败 ${failed}`);
    const others = items.length - pending - failed;
    if (others > 0)
        parts.push(`其他 ${others}`);
    const lines = [`📋 提醒 ${items.length} 条（${parts.join(' · ')}）`];
    for (const item of items.slice(0, MAX_REMINDERS_LISTED)) {
        lines.push(renderHead(item));
        lines.push(`  ${clip(item.text, MAX_TEXT_CHARS)}`);
        if (item.lastError)
            lines.push(`  最后错误：${clip(item.lastError, MAX_ERROR_CHARS)}`);
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