import { describe, it, expect, vi } from 'vitest';
import { remindersCommand } from './reminders.ts';
import { isOwner } from './owner.ts';
import { buildCommandList } from './index.ts';
import { NO_REMINDERS, REMINDERS_C2C_ONLY, REMINDERS_UNREADABLE } from '../timer-reminders.ts';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

const OWNER = '0000000000000000000000000000ABCD';

function makeCtx(senderId = OWNER, kind: 'c2c' | 'group' = 'c2c', groupOpenid?: string): SlashCommandHandlerContext {
  return {
    message: { senderId, kind, ...(groupOpenid ? { groupOpenid } : {}) },
    bot: { sendMarkdown: vi.fn(async () => ({})) },
    replyTarget: { scope: kind, targetId: senderId },
  } as unknown as SlashCommandHandlerContext;
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'rem_a',
  dueAt: '2026-11-10T10:00:00.000Z',
  text: '换 key',
  target: 'c2c:0000000000000000000000000000ABCD',
  state: 'pending',
  attempts: 0,
  ...over,
});

describe('isOwner', () => {
  it('认得所有者，大小写不敏感', () => {
    expect(isOwner(OWNER)).toBe(true);
    expect(isOwner(OWNER.toLowerCase())).toBe(true);
  });

  it('缺身份 / 别人一律 false', () => {
    expect(isOwner(undefined)).toBe(false);
    expect(isOwner('')).toBe(false);
    expect(isOwner('somebody-else')).toBe(false);
  });
});

describe('/reminders 鉴权（同 /tickets：只认所有者私聊）', () => {
  it('所有者放行', () => {
    const cmd = remindersCommand({});
    expect(cmd.authorized?.(makeCtx(OWNER))).toBe(true);
  });

  it('陌生人返回空串（中间件判空就不发，彻底安静）', () => {
    const cmd = remindersCommand({});
    expect(cmd.authorized?.(makeCtx('stranger'))).toBe('');
  });

  it('只在 c2c 声明', () => {
    expect(remindersCommand({}).scope).toBe('c2c');
  });
});

describe('/reminders handler', () => {
  it('空表回「没有提醒」', async () => {
    const cmd = remindersCommand({ readReminders: () => [] });
    expect(await cmd.handler(makeCtx())).toBe(NO_REMINDERS);
  });

  it('读不出来（undefined）回提示，不冒充没有提醒', async () => {
    const cmd = remindersCommand({ readReminders: () => undefined });
    expect(await cmd.handler(makeCtx())).toBe(REMINDERS_UNREADABLE);
  });

  it('读的时候抛错也兜成提示', async () => {
    const cmd = remindersCommand({
      readReminders: () => {
        throw new Error('disk gone');
      },
    });
    expect(await cmd.handler(makeCtx())).toBe(REMINDERS_UNREADABLE);
  });

  it('待发 + 失败都列出来，含 id/时间/状态/目标/正文', async () => {
    const cmd = remindersCommand({
      readReminders: () => [
        row(),
        row({ id: 'rem_b', state: 'failed', attempts: 4, lastError: '401', text: '审计设计稿' }),
      ],
    });
    const out = (await cmd.handler(makeCtx())) as string;
    expect(out).toContain('提醒 2 条');
    expect(out).toContain('rem_a');
    expect(out).toContain('待发');
    expect(out).toContain('rem_b');
    expect(out).toContain('失败（4 次）');
    expect(out).toContain('c2c:00000000…ABCD');
    expect(out).toContain('换 key');
    expect(out).toContain('审计设计稿');
  });

  it('群聊一个字都不吐', async () => {
    const cmd = remindersCommand({ readReminders: () => [row()] });
    expect(await cmd.handler(makeCtx(OWNER, 'group', 'g1'))).toBe(REMINDERS_C2C_ONLY);
  });

  it('超长列表按 textChunkLimit 切块发', async () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `rem_${i}`, text: '字'.repeat(60) }));
    const ctx = makeCtx();
    const cmd = remindersCommand({ readReminders: () => many, config: { textChunkLimit: 300 } as never });
    const out = await cmd.handler(ctx);
    expect(out).toEqual({ kind: 'noop' });
    const send = (ctx as unknown as { bot: { sendMarkdown: ReturnType<typeof vi.fn> } }).bot.sendMarkdown;
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('注册进指令表', () => {
  it('buildCommandList 带上 /reminders，归 qqbot 类', () => {
    const list = buildCommandList({} as never);
    const cmd = list.find((c) => c.name === 'reminders');
    expect(cmd?.category).toBe('qqbot');
    expect(cmd?.description).toContain('提醒');
  });
});
