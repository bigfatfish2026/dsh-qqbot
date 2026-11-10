import { isOwner } from "./owner.js";
import { sendMarkdownChunked } from "../shared/index.js";
import { REMINDERS_C2C_ONLY, REMINDERS_UNREADABLE, foldReminders, isGroupContext, renderReminders, } from "../timer-reminders.js";
/** 长文本按宿主单条上限切块发送，短文本直接返回让 SDK 发 */
async function reply(cmdCtx, text, config) {
    if (!text)
        return { kind: 'noop' };
    const limit = Math.max(200, Math.min(config?.textChunkLimit ?? 4500, 4500));
    if (text.length <= limit)
        return text;
    await sendMarkdownChunked(cmdCtx, text, limit);
    return { kind: 'noop' };
}
/** /reminders — 列待发 + 失败的提醒 */
export function remindersCommand({ config, readReminders } = {}) {
    return {
        name: 'reminders',
        category: 'qqbot',
        scope: 'c2c',
        // 白名单同 /tickets：authorized 返回非 true 时中间件把返回值当提示发出去，
        // 这里给空串 = 陌生人什么都收不到，同时消息不进 agent。
        authorized: (cmdCtx) => (isOwner(cmdCtx.message?.senderId) ? true : ''),
        description: '查看所有提醒（待发 + 失败）',
        usage: [
            '/reminders',
            '',
            '列出 dsh-timer 里所有一次性提醒：id、到点时间、发往哪里、正文（截断）、状态。',
            '发送失败的提醒也在这里，重试用尽后状态是「失败」。只读，只在私聊可用。',
        ].join('\n'),
        handler: async (cmdCtx) => {
            // 兜底：群聊不读提醒、不报条数
            if (isGroupContext(cmdCtx))
                return REMINDERS_C2C_ONLY;
            let text;
            try {
                const rows = readReminders?.();
                // undefined = 读不出来；空数组 = 确实没有提醒，两种说法不能混
                // undefined = 读不出来；空数组 = 确实没有提醒（renderReminders 给「没有提醒」）
                text = rows === undefined ? REMINDERS_UNREADABLE : renderReminders(foldReminders(rows));
            }
            catch {
                // 任何意外都不许把命令打死
                text = REMINDERS_UNREADABLE;
            }
            return reply(cmdCtx, text, config);
        },
    };
}
//# sourceMappingURL=reminders.js.map