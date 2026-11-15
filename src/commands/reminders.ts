/**
 * /reminders — 列所有一次性提醒（待发和发送失败都列）
 *
 * 和 /tickets 同一套规矩：只在私聊、只认 owner 的 openid，陌生人完全安静
 * （authorized 返回空串，SDK 判空就不发）。读数来自 dsh-timer 的 sqlite
 * （见 ../gateway/reminders-source.ts），不另建表、不缓存。
 *
 * 与 timer_remind_list 工具的区别：工具给模型看，这条指令给人看——同样一份
 * dsh_timer_reminder，渲染成 QQ 里能直接读的几行。
 */
import type { SlashCommandHandlerContext, SlashCommandResult } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { isOwner } from './owner.ts';
import { sendMarkdownChunked } from '../shared/index.ts';
import {
  REMINDERS_C2C_ONLY,
  REMINDERS_UNREADABLE,
  foldReminders,
  isGroupContext,
  renderReminders,
} from '../timer-reminders.ts';

/** 长文本按宿主单条上限切块发送，短文本直接返回让 SDK 发 */
async function reply(
  cmdCtx: SlashCommandHandlerContext,
  text: string,
  config: ImQQBotConfig | undefined,
): Promise<SlashCommandResult> {
  if (!text) return { kind: 'noop' };
  const limit = Math.max(200, Math.min(config?.textChunkLimit ?? 4500, 4500));
  if (text.length <= limit) return text;
  await sendMarkdownChunked(cmdCtx, text, limit);
  return { kind: 'noop' };
}

/** /reminders — 列待发 + 失败的提醒 */
export function remindersCommand({ config, readReminders }: Partial<CommandDeps> = {}): CategorizedCommand {
  return {
    name: 'reminders',
    category: 'qqbot',
    scope: 'c2c',
    // 白名单同 /tickets：authorized 返回非 true 时中间件把返回值当提示发出去，
    // 这里给空串 = 陌生人什么都收不到，同时消息不进 agent。
    authorized: (cmdCtx) => (isOwner(cmdCtx.message?.senderId, config?.ownerOpenid) ? true : ''),
    description: '查看所有提醒（待发 + 失败）',
    usage: [
      '/reminders',
      '',
      '列出 dsh-timer 里所有一次性提醒，一行一条：emoji + 日期 + 时间 + 正文全文。',
      '日期按远近说（今天/明天/后天/本周X/下周X/X月X日），时间 24 小时制。',
      '发送失败的提醒也在这里，用 ⚠️ 标出。只读，只在私聊可用。',
    ].join('\n'),
    handler: async (cmdCtx) => {
      // 兜底：群聊不读提醒、不报条数
      if (isGroupContext(cmdCtx)) return REMINDERS_C2C_ONLY;
      let text: string;
      try {
        const rows = readReminders?.();
        // undefined = 读不出来；空数组 = 确实没有提醒，两种说法不能混
        // undefined = 读不出来；空数组 = 确实没有提醒（renderReminders 给「没有提醒」）
        text = rows === undefined ? REMINDERS_UNREADABLE : renderReminders(foldReminders(rows));
      } catch {
        // 任何意外都不许把命令打死
        text = REMINDERS_UNREADABLE;
      }
      return reply(cmdCtx, text, config);
    },
  };
}
