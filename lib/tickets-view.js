/**
 * 票视图公共模块（FISH_PATCH tickets-view）
 *
 * 票状态的唯一来源是 dsh-dispatcher 的只读出口，这里既不读 tickets.jsonl、
 * 也不折事件行：
 *   - 进程内：`dispatcher/tickets` 这个 cordis service 的 payload(selection)
 *   - 跨进程：`dsh-dispatcher tickets --json`，顶层形状与 payload 逐字段相同
 * 本模块只做三件事：把出口的读数规整成 TicketSnapshot、排序裁剪、渲染成消息。
 *
 *   - commands/session.ts 的 /new 拦截用 openTickets(payload) + renderTicketBlock()
 *   - commands/tickets.ts 的 /tickets 用 foldTickets(payload) + renderTicketList()/renderTicketDetail()
 *
 * 出口拿不到读数（服务没注册、payload 抛错）时 foldTickets 给空数组，说话权交给
 * 调用方：/tickets 说「票读不出来」，/new 当没有未结票放行。
 * 出口换后端（jsonl → redis）时这里一个字节都不用动。
 */
import { formatRelativeTime } from "./shared/index.js";
/** 未结状态：open/running/waiting/blocked 算没结，done/dropped 算结束 */
export const OPEN_TICKET_STATUS = new Set(['open', 'running', 'waiting', 'blocked']);
/** 已结束状态 */
const ENDED_TICKET_STATUS = new Set(['done', 'dropped']);
/** /new 拦截提示里最多列几张 */
const MAX_LISTED = 5;
/** /new 拦截提示的行数上限：开场句 1 行 + 列表 5 行 + 「还有 n 张没列」1 行 */
const MAX_LINES = MAX_LISTED + 2;
/** /tickets 默认最多列几张未结票 */
export const MAX_TICKETS_LISTED = 10;
/** /tickets all 最多补几张已结束的票 */
export const MAX_ENDED_LISTED = 5;
/** goal 压成一行，超过 40 字截断 */
export function clipGoal(goal) {
    if (typeof goal !== 'string')
        return '';
    const flat = goal.replace(/\s+/g, ' ').trim();
    if (!flat)
        return '';
    const chars = [...flat];
    return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : flat;
}
/** 票的短标签：去空白后非空才算有，空串、纯空白一律当缺失 */
export function normBrief(brief) {
    if (typeof brief !== 'string')
        return '';
    return brief.replace(/\s+/g, ' ').trim();
}
/** 标题行用哪段话：brief 优先（去空白后非空），缺了回落 goal */
export function ticketTitle(t) {
    const brief = normBrief(t?.brief ?? '');
    if (brief)
        return clipGoal(brief);
    return clipGoal(t?.goal ?? '');
}
/** goal 保留换行（详情用），超过 3000 字软截断，避免一条 QQ 消息爆掉 */
export function clipLongGoal(goal, limit = 3000) {
    if (typeof goal !== 'string')
        return '';
    const flat = goal.replace(/\r\n/g, '\n').trim();
    if (!flat)
        return '';
    const chars = [...flat];
    return chars.length > limit ? `${chars.slice(0, limit).join('')}…（已截断，共 ${chars.length} 字）` : flat;
}
/** 非负整数：缺字段、负数、NaN、非数字都退化成 0 */
function count(value) {
    const n = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** 字符串字段：不是字符串就退化成空串 */
function text(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * 把出口的读数规整成 TicketSnapshot 列表，顺序保持出口给的（createdAt 升序）。
 *
 * 这里不做任何状态推导——状态、closedAt、计数全是出口算好的，原样搬。
 * 读数缺失 / tickets 不是数组 / 单条不是对象 / 缺 id，一律跳过不抛。
 */
export function foldTickets(payload) {
    const rows = payload?.tickets;
    if (!Array.isArray(rows))
        return [];
    const out = [];
    for (const raw of rows) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const row = raw;
        const id = text(row.id);
        if (!id)
            continue;
        const closedAt = text(row.closedAt);
        out.push({
            id,
            goal: text(row.goal),
            brief: text(row.brief),
            status: text(row.status) || 'open',
            owner: text(row.owner),
            createdAt: text(row.createdAt),
            updatedAt: text(row.updatedAt),
            closedAt: closedAt || undefined,
            pendingReports: count(row.pendingReports),
            pendingInputs: count(row.pendingInputs),
            reportsCount: count(row.reportsCount),
        });
    }
    return out;
}
/** 还没结的票（id / status / brief / 截断后的 goal），顺序跟出口一致 */
export function openTickets(payload) {
    return foldTickets(payload)
        .filter((t) => OPEN_TICKET_STATUS.has(t.status))
        .map((t) => ({ id: t.id, status: t.status, brief: normBrief(t.brief), goal: clipGoal(t.goal) }));
}
/** 按票号或前缀找票：先精确匹配，再前缀匹配；多个候选时返回前几个 */
export function findTickets(query, tickets) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle)
        return [];
    const exact = tickets.filter((t) => t.id.toLowerCase() === needle);
    if (exact.length > 0)
        return exact;
    return tickets.filter((t) => t.id.toLowerCase().startsWith(needle));
}
/** 把未结票拼成 /new 的拦截提示：最多 MAX_LINES 行，固定列 5 张，超出的补一句 */
export function renderTicketBlock(tickets) {
    const total = tickets.length;
    const lines = [`还有 ${total} 张票没结，开新会话会丢掉，要强开发 /new force：`];
    const listed = Math.min(total, MAX_LISTED);
    for (const t of tickets.slice(0, listed)) {
        // 和 /tickets 列表同一口径：brief 去空白后非空才用，缺了回落 goal
        const brief = normBrief(t.brief);
        const title = brief ? clipGoal(brief) : t.goal;
        lines.push(`${t.id} · ${t.status}${title ? ` · ${title}` : ''}`);
    }
    if (total > listed)
        lines.push(`还有 ${total - MAX_LISTED} 张没列`);
    return lines.slice(0, MAX_LINES).join('\n');
}
/**
 * 一行描述一张票：id · status · 多久没动 · brief（缺了就 goal 前 40 字，两样都空就少这一段，其余照旧）
 * waiting 不等于交活：waiting 且票里一条报告都没有时状态打问号（waiting?），
 * 主会话一眼看出这张票没人交过活。
 */
export function describeTicket(t) {
    const id = t.id ?? '(无 id)';
    const raw = t.status ?? '未知';
    const status = raw === 'waiting' && t.reportsCount === 0 ? 'waiting?' : raw;
    const parsed = t.updatedAt ? Date.parse(t.updatedAt) : Number.NaN;
    const idle = Number.isNaN(parsed) ? '时间未知' : `${formatRelativeTime(parsed)}没动`;
    const parts = [id, status, idle];
    const title = ticketTitle(t);
    if (title)
        parts.push(title);
    return parts.join(' · ');
}
/** 绝对时间：2026-11-02 19:30（本机时区） */
function formatStamp(iso) {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts))
        return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 未结票按 createdAt 升序（缺 createdAt 的排最后） */
function sortByCreatedAt(tickets) {
    return [...tickets].sort((a, b) => {
        const left = a.createdAt ?? '';
        const right = b.createdAt ?? '';
        if (left === right)
            return a.id.localeCompare(b.id);
        if (!left)
            return 1;
        if (!right)
            return -1;
        return left.localeCompare(right);
    });
}
/** 已结束的票按结束时间倒序（最近关的在前） */
function sortByClosedAtDesc(tickets) {
    return [...tickets].sort((a, b) => {
        const left = a.closedAt ?? a.updatedAt ?? '';
        const right = b.closedAt ?? b.updatedAt ?? '';
        if (left === right)
            return b.id.localeCompare(a.id);
        return right.localeCompare(left);
    });
}
/**
 * /tickets 列表：默认只列未结票（createAt 升序，最多 MAX_TICKETS_LISTED 张），
 * includeEnded 时再补最多 MAX_ENDED_LISTED 张最近结束的。
 */
export function renderTicketList(tickets, { includeEnded = false } = {}) {
    const open = sortByCreatedAt(tickets.filter((t) => OPEN_TICKET_STATUS.has(t.status)));
    const ended = sortByClosedAtDesc(tickets.filter((t) => ENDED_TICKET_STATUS.has(t.status)));
    const lines = [];
    if (open.length === 0) {
        lines.push('现在没有未结的票');
    }
    else {
        for (const t of open.slice(0, MAX_TICKETS_LISTED))
            lines.push(describeTicket(t));
        if (open.length > MAX_TICKETS_LISTED)
            lines.push(`还有 ${open.length - MAX_TICKETS_LISTED} 张没列`);
    }
    if (includeEnded) {
        const shown = ended.slice(0, MAX_ENDED_LISTED);
        if (shown.length > 0) {
            lines.push('— 最近结束 —');
            for (const t of shown)
                lines.push(describeTicket(t));
        }
        if (ended.length > shown.length)
            lines.push(`还有 ${ended.length - shown.length} 张已结束的没列`);
    }
    return lines.join('\n');
}
/** 单张详情：状态、owner、多久没动、未读报告、排队消息、closedAt、goal 全文 */
export function renderTicketDetail(t) {
    const idle = t.updatedAt && !Number.isNaN(Date.parse(t.updatedAt))
        ? formatRelativeTime(Date.parse(t.updatedAt))
        : '时间未知';
    const lines = [
        `${t.id} · ${t.status ?? '未知'}`,
        `owner: ${t.owner ? t.owner : '—'}`,
        `最后动静: ${idle}`,
        `未读报告: ${t.pendingReports} · 排队消息: ${t.pendingInputs}`,
    ];
    if (t.closedAt)
        lines.push(`关闭于: ${formatStamp(t.closedAt)}`);
    if (t.createdAt)
        lines.push(`创建于: ${formatStamp(t.createdAt)}`);
    const goal = clipLongGoal(t.goal ?? '');
    lines.push('goal:', goal ? goal : '（空）');
    return lines.join('\n');
}
/** 多个前缀候选时的提示 */
export function renderTicketCandidates(matches) {
    const shown = matches.slice(0, 5).map((t) => `${t.id} · ${t.status}`);
    const lines = [`匹配到 ${matches.length} 张票，说全一点：`, ...shown];
    if (matches.length > shown.length)
        lines.push(`还有 ${matches.length - shown.length} 张没列`);
    return lines.join('\n');
}
/** 找不到票的提示 */
export const NO_SUCH_TICKET = '没这张票\n（用 /tickets 看列表，/tickets all 带已结束的）';
/** 群聊里的一律回答：不透票数、不透内容 */
export const TICKETS_C2C_ONLY = '这个指令只在私聊用';
//# sourceMappingURL=tickets-view.js.map