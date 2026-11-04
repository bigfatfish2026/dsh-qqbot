/**
 * /tickets — 只读查看 dispatcher 的票（FISH_PATCH tickets）
 *
 * 读数只问 dispatcher 的只读出口（`dispatcher/tickets` 的 payload），本文件不读
 * 盘、不折事件行；规整与渲染都在 ../tickets-view.ts，和 /new 的未结票拦截共用
 * 一份实现。出口不在时老实说读不出来，不许拿旧日志顶。
 * 只在 c2c 生效：群聊里 SDK 的 scope 检查会先拦下（回「该指令仅限私聊使用」），
 * handler 里再兜一层，绝不输出票内容、也不报张数。
 */
import type { SlashCommandHandlerContext, SlashCommandResult } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import { chunkMarkdownText } from '../transport/chunker.ts';
import type { TicketSnapshot, TicketsSelection } from '../tickets-view.ts';
import {
  TICKETS_C2C_ONLY,
  NO_SUCH_TICKET,
  MAX_ENDED_LISTED,
  foldTickets,
  findTickets,
  renderTicketCandidates,
  renderTicketDetail,
  renderTicketList,
} from '../tickets-view.ts';
import type { CommandDeps, CategorizedCommand } from './types.ts';

/** /tickets 只认主人 Julia 的私聊 openid（c2c 消息的 senderId 就是 user_openid） */
const TICKETS_OWNER_OPENID = '64532D871A10E466D163FD001524AD83';

/** all 的同义写法 */
const ALL_ALIASES: Set<string> = new Set(['all', 'closed', 'history', '-a', '--all', '全部', '已结束']);

/**
 * 问一次出口，拿到规整后的票。
 *
 * selection 原样透给出口：列表要 open、all 要 recentClosed、详情要 id，
 * 全量前缀搜索就不传。出口没应答（服务没注册 / payload 抛错）直接抛，
 * 由 handler 兜成一句提示——不拿空表冒充「没有票」。
 */
function readTicketsFrom(
  reader: ((selection?: TicketsSelection) => unknown) | undefined,
  selection?: TicketsSelection,
): TicketSnapshot[] {
  const payload = reader?.(selection) as Parameters<typeof foldTickets>[0];
  if (!payload) throw new Error('票出口没应答');
  return foldTickets(payload);
}

/** 超长行（goal 里没有换行时）按字符硬切，避免整段超过单条上限被 QQ 拒收 */
function hardSplit(chunk: string, limit: number): string[] {
  if (chunk.length <= limit) return [chunk];
  const out: string[] = [];
  let buf = '';
  for (const ch of chunk) {
    buf += ch;
    if ([...buf].length >= limit) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 长文本按宿主单条上限切块发送，短文本直接返回让 SDK 发 */
async function reply(
  cmdCtx: SlashCommandHandlerContext,
  text: string,
  config: ImQQBotConfig | undefined,
): Promise<SlashCommandResult> {
  const limit = Math.max(200, Math.min(config?.textChunkLimit ?? 4500, 4500));
  if (typeof text !== 'string' || !text) return { kind: 'noop' };
  if (text.length <= limit) return text;
  const chunks = chunkMarkdownText(text, limit).flatMap((chunk) => hardSplit(chunk, limit));
  for (const chunk of chunks) {
    await cmdCtx.bot.sendText(cmdCtx.replyTarget, chunk);
  }
  return { kind: 'noop' };
}

/** /tickets — 列票 / 看单张 */
export function ticketsCommand({ config, readTickets }: Partial<CommandDeps> = {}): CategorizedCommand {
  return {
    name: 'tickets',
    category: 'qqbot',
    scope: 'c2c',
    // 白名单：只有主人私聊能读票。authorized 返回非 true 时，中间件会把
    // 返回值当提示发出去（字符串原样发）；这里返回空串，sendCommandResult
    // 判 content 为空就跳过发送，陌生人得到的是完全安静，
    // 同时 ctx.stop('command:unauthorized:tickets') 短路，消息不会进 agent。
    authorized: (cmdCtx) =>
      String(cmdCtx.message?.senderId ?? '').toUpperCase() === TICKETS_OWNER_OPENID ? true : '',
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
      let text: string;
      try {
        const args = (cmdCtx.command?.args ?? []).map((a) => String(a).trim()).filter(Boolean);
        const target = args[0] ?? '';
        if (!target) {
          text = renderTicketList(readTicketsFrom(readTickets, { open: true }));
        } else if (ALL_ALIASES.has(target.toLowerCase())) {
          // 未结票 + 最近结束的几张；COUNT 类统计出口自己算，这里只管显示
          text = renderTicketList(readTicketsFrom(readTickets, { recentClosed: MAX_ENDED_LISTED }), {
            includeEnded: true,
          });
        } else {
          // 前缀搜索要看全量（含很早关闭的），出口不给过滤，自己筛
          const matches = findTickets(target, readTicketsFrom(readTickets));
          if (matches.length === 0) text = NO_SUCH_TICKET;
          else if (matches.length > 1) text = renderTicketCandidates(matches);
          else text = renderTicketDetail(matches[0]!);
        }
      } catch {
        // 任何意外都不许把命令打死
        text = '票读不出来（dispatcher 的票出口没应答）';
      }
      return reply(cmdCtx, text, config);
    },
  };
}
