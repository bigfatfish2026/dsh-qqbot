/**
 * 票视图公共模块（FISH_PATCH tickets-view）
 *
 * 折叠 `$DSH_HOME/dispatcher/tickets.jsonl` 的地方只此一处：
 *   - commands/session.ts 的 /new 拦截用 openTickets() + renderTicketBlock()
 *   - commands/tickets.ts 的 /tickets 用 foldTickets() + renderTicketList()/renderTicketDetail()
 *
 * 折叠口径抄 dsh-dispatcher src/store.ts 的 foldEvents：
 * 每票取最后一条 status（首行没有 status 就当 open），owner/at 后者覆盖前者，
 * goal 取第一个非空的，brief 同上（短标签，列表标题行优先用它）；
 * done/dropped 记 closedAt，重新打开则清掉。
 * 读不到文件、坏行、JSON 解析失败、字段缺类型一律安全退化，不抛异常。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
/** 票日志路径：$DSH_HOME/dispatcher/tickets.jsonl，缺省 ~/.dsh */
export function ticketsFilePath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'dispatcher', 'tickets.jsonl');
}
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
/**
 * 折叠票日志，返回所有票的快照（含已结束的），按文件里首次出现的顺序。
 * 顺序即创建顺序，和 store.ts 按 createdAt 排序等价；调用方要严格按时间排自己排。
 */
export function foldTickets(file = ticketsFilePath()) {
    try {
        const text = readFileSync(file, 'utf8');
        const folded = new Map();
        for (const line of text.split('\n')) {
            if (!line.trim())
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!event || typeof event !== 'object')
                continue;
            const e = event;
            if (typeof e.id !== 'string')
                continue;
            const id = e.id;
            let cur = folded.get(id);
            if (cur === undefined) {
                cur = {
                    id,
                    goal: '',
                    brief: '',
                    status: 'open',
                    owner: '',
                    createdAt: '',
                    updatedAt: '',
                    closedAt: undefined,
                    inputs: [],
                    reports: [],
                };
            }
            if (typeof e.at === 'string') {
                if (!cur.createdAt)
                    cur.createdAt = e.at;
                cur.updatedAt = e.at;
            }
            // 首行没有 status 就算 open，之后每条 status 覆盖；只有状态行能挪 closedAt
            if (typeof e.status === 'string') {
                cur.status = e.status;
                cur.closedAt = ENDED_TICKET_STATUS.has(e.status)
                    ? (typeof e.at === 'string' ? e.at : cur.updatedAt)
                    : undefined;
            }
            // goal 只在 create 那条里，取第一个非空的
            if (!cur.goal && typeof e.goal === 'string')
                cur.goal = e.goal;
            // brief 同理，且空串/纯空白不算「有」，后面还能被真正的 brief 补上
            if (!normBrief(cur.brief) && typeof e.brief === 'string')
                cur.brief = e.brief;
            if (typeof e.owner === 'string' && e.owner)
                cur.owner = e.owner;
            const input = e.input;
            if (input !== null && typeof input === 'object') {
                cur.inputs.push({ id: String(input.id ?? ''), delivered: false });
            }
            const report = e.report;
            if (report !== null && typeof report === 'object') {
                cur.reports.push({ id: String(report.id ?? ''), delivered: false });
            }
            const delivery = e.delivered;
            if (delivery !== null && typeof delivery === 'object') {
                const bucket = delivery.kind === 'input' ? cur.inputs : delivery.kind === 'report' ? cur.reports : undefined;
                if (bucket !== undefined) {
                    const hit = bucket.find((entry) => entry.id === delivery.id);
                    if (hit !== undefined)
                        hit.delivered = true;
                }
            }
            folded.set(id, cur);
        }
        return [...folded.values()];
    }
    catch {
        return [];
    }
}
/** 还没结的票（id / status / brief / 截断后的 goal），顺序与旧实现一致：文件里首次出现的顺序 */
export function openTickets() {
    return foldTickets()
        .filter((t) => OPEN_TICKET_STATUS.has(t.status))
        .map((t) => ({ id: t.id, status: t.status, brief: normBrief(t.brief), goal: clipGoal(t.goal) }));
}
/** 按票号或前缀找票：先精确匹配，再前缀匹配；多个候选时返回前几个 */
export function findTickets(query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle)
        return [];
    const all = foldTickets();
    const exact = all.filter((t) => t.id.toLowerCase() === needle);
    if (exact.length > 0)
        return exact;
    return all.filter((t) => t.id.toLowerCase().startsWith(needle));
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
 * 主会话一眼看出这张票没人交过活。老票没有 reports 字段按空数组算，别的状态照旧。
 */
export function describeTicket(t) {
    const id = t.id ?? '(无 id)';
    const raw = t.status ?? '未知';
    const reports = Array.isArray(t.reports) ? t.reports : [];
    const status = raw === 'waiting' && reports.length === 0 ? 'waiting?' : raw;
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
    const unreadReports = t.reports.filter((r) => !r.delivered).length;
    const queuedInputs = t.inputs.filter((i) => !i.delivered).length;
    const idle = t.updatedAt && !Number.isNaN(Date.parse(t.updatedAt))
        ? formatRelativeTime(Date.parse(t.updatedAt))
        : '时间未知';
    const lines = [
        `${t.id} · ${t.status ?? '未知'}`,
        `owner: ${t.owner ? t.owner : '—'}`,
        `最后动静: ${idle}`,
        `未读报告: ${unreadReports} · 排队消息: ${queuedInputs}`,
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