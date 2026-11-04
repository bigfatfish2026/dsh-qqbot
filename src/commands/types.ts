/**
 * 命令依赖类型
 *
 * 每个命令工厂函数接收 CommandDeps，由 commands/index.ts 统一注入。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { TicketsPayloadReader } from '../tickets-view.ts';

export interface CommandDeps {
  manager: SessionManager;
  config: ImQQBotConfig;
  logger?: Logger;
  /**
   * 惰性读票：问 dispatcher 的只读出口（`dispatcher/tickets`）。
   * /new 的未结票拦截和 /tickets 共用这一条；出口不在时给 undefined，
   * 命令层自己决定怎么说，不许自己回去读 tickets.jsonl。
   */
  readTickets?: TicketsPayloadReader;
}

/** 命令分类：agent = 底层 agent 通用能力，qqbot = 插件特有 */
export type CommandCategory = 'agent' | 'qqbot';

/** 带分类的斜杠命令（category 供 help 分组展示，SDK 忽略未知字段） */
export interface CategorizedCommand extends SlashCommand {
  category: CommandCategory;
}
