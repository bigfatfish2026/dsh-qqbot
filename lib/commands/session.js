import { getScopePeer } from "../shared/index.js";
// 折叠 / 截断 / 渲染都挪到 ../tickets-view.ts，/new 和 /tickets 共用一份（FISH_PATCH tickets-view）
// 读数只问 dispatcher 的只读出口，不再自己读 tickets.jsonl。
import { openTickets, renderTicketBlock } from "../tickets-view.js";
export { clipGoal, openTickets, renderTicketBlock } from "../tickets-view.js";
/** /new（别名 /reset /clear）— 开始新会话 */
export function newCommand({ manager, readTickets }) {
    return {
        name: ['new', 'reset', 'clear'],
        category: 'agent',
        scope: 'all',
        description: '开始新会话（清空上下文）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const forced = (cmdCtx.command?.args ?? []).some((a) => String(a).toLowerCase() === 'force');
            // 只管私聊：群聊（group:<gid>）不读票、不拦
            if (scope === 'c2c' && !forced) {
                // 出口没给读数（服务没注册）就当没有未结票：不拦，放行
                const open = openTickets(readTickets?.({ open: true }));
                if (open.length > 0)
                    return renderTicketBlock(open);
            }
            void manager.remove(scope, peerId);
            return '已开启新会话 ✓';
        },
    };
}
/** /compact — 原地压缩会话历史 */
export function compactCommand({ manager }) {
    return {
        name: 'compact',
        category: 'agent',
        scope: 'all',
        description: '压缩会话历史（摘要替换旧记录，保留上下文）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const msg = cmdCtx.message;
            const outcome = await manager.compact(scope, peerId, {
                senderId: msg.senderId,
                replyTarget: { scope, targetId: peerId, msgId: msg.messageId },
            });
            if (outcome.ok) {
                if (!outcome.shadowed)
                    return '没有可压缩的历史';
                return `✅ 已压缩 ${outcome.shadowed} 条历史记录（约 ${outcome.tokens ?? 0} tokens）`;
            }
            switch (outcome.reason) {
                case 'no-session':
                    return '当前无活跃会话';
                case 'busy':
                    return '正在生成中，无法压缩';
                case 'unavailable':
                    return '压缩能力不可用（当前会话的 agent preset 未加载 compaction 服务）';
                default:
                    return `压缩失败: ${outcome.message ?? '未知错误'}`;
            }
        },
    };
}
//# sourceMappingURL=session.js.map