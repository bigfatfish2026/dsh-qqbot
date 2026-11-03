import { chunkMarkdownText } from "../transport/chunker.js";
import { TICKETS_C2C_ONLY, NO_SUCH_TICKET, foldTickets, findTickets, renderTicketCandidates, renderTicketDetail, renderTicketList, } from "../tickets-view.js";
/** /tickets 只认主人 Julia 的私聊 openid（c2c 消息的 senderId 就是 user_openid） */
const TICKETS_OWNER_OPENID = '64532D871A10E466D163FD001524AD83';
/** all 的同义写法 */
const ALL_ALIASES = new Set(['all', 'closed', 'history', '-a', '--all', '全部', '已结束']);
/** 一次读盘：列表和详情都用同一份折叠结果 */
function readTickets() {
    try {
        return foldTickets();
    }
    catch {
        return [];
    }
}
/** 超长行（goal 里没有换行时）按字符硬切，避免整段超过单条上限被 QQ 拒收 */
function hardSplit(chunk, limit) {
    if (chunk.length <= limit)
        return [chunk];
    const out = [];
    let buf = '';
    for (const ch of chunk) {
        buf += ch;
        if ([...buf].length >= limit) {
            out.push(buf);
            buf = '';
        }
    }
    if (buf)
        out.push(buf);
    return out;
}
/** 长文本按宿主单条上限切块发送，短文本直接返回让 SDK 发 */
async function reply(cmdCtx, text, config) {
    const limit = Math.max(200, Math.min(config?.textChunkLimit ?? 4500, 4500));
    if (typeof text !== 'string' || !text)
        return { kind: 'noop' };
    if (text.length <= limit)
        return text;
    const chunks = chunkMarkdownText(text, limit).flatMap((chunk) => hardSplit(chunk, limit));
    for (const chunk of chunks) {
        await cmdCtx.bot.sendText(cmdCtx.replyTarget, chunk);
    }
    return { kind: 'noop' };
}
/** /tickets — 列票 / 看单张 */
export function ticketsCommand({ config } = {}) {
    return {
        name: 'tickets',
        category: 'qqbot',
        scope: 'c2c',
        // 白名单：只有主人私聊能读票。authorized 返回非 true 时，中间件会把
        // 返回值当提示发出去（字符串原样发）；这里返回空串，sendCommandResult
        // 判 content 为空就跳过发送，陌生人得到的是完全安静，
        // 同时 ctx.stop('command:unauthorized:tickets') 短路，消息不会进 agent。
        authorized: (cmdCtx) => String(cmdCtx.message?.senderId ?? '').toUpperCase() === TICKETS_OWNER_OPENID ? true : '',
        description: '查看票：/tickets、/tickets all、/tickets <票号>',
        usage: [
            '/tickets',
            '/tickets all',
            '/tickets <票号或前缀>',
            '',
            '只读，只在私聊可用。默认列未结的票（按创建时间），',
            'all 再带上最近结束的几张，给票号看单张详情。',
        ].join('\n'),
        handler: async (cmdCtx) => {
            // 兜底：群聊不读票、不回票数
            if (cmdCtx.message?.kind === 'group' || cmdCtx.message?.groupOpenid) {
                return TICKETS_C2C_ONLY;
            }
            let text;
            try {
                const args = (cmdCtx.command?.args ?? []).map((a) => String(a).trim()).filter(Boolean);
                const target = args[0] ?? '';
                if (!target) {
                    text = renderTicketList(readTickets());
                }
                else if (ALL_ALIASES.has(target.toLowerCase())) {
                    text = renderTicketList(readTickets(), { includeEnded: true });
                }
                else {
                    const matches = findTickets(target);
                    if (matches.length === 0)
                        text = NO_SUCH_TICKET;
                    else if (matches.length > 1)
                        text = renderTicketCandidates(matches);
                    else
                        text = renderTicketDetail(matches[0]);
                }
            }
            catch {
                // 任何意外都不许把命令打死
                text = '票读不出来（tickets.jsonl 打不开或全是坏行）';
            }
            return reply(cmdCtx, text, config);
        },
    };
}
//# sourceMappingURL=tickets.js.map