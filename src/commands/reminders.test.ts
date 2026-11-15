import { describe, it, expect, vi } from 'vitest';
import { remindersCommand } from './reminders.ts';
import { isOwner } from './owner.ts';
import { buildCommandList } from './index.ts';
import { NO_REMINDERS, REMINDERS_C2C_ONLY, REMINDERS_UNREADABLE } from '../timer-reminders.ts';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

const OWNER = 'test-owner-openid-0001';

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
  target: 'c2c:test-owner-openid-0001',
  state: 'pending',
  attempts: 0,
  ...over,
});

describe('isOwner', () => {
  it('认名单里的 openid，大小写不敏感', () => {
    expect(isOwner(OWNER, OWNER)).toBe(true);
    expect(isOwner(OWNER.toLowerCase(), [OWNER])).toBe(true);
  });

  it('缺身份 / 别人一律 false', () => {
    expect(isOwner(undefined, OWNER)).toBe(false);
    expect(isOwner('', OWNER)).toBe(false);
    expect(isOwner('somebody-else', OWNER)).toBe(false);
  });

  it('名单用逗号分隔也认，空名单谁都不放行', () => {
    expect(isOwner(OWNER, `a, ${OWNER}`)).toBe(true);
    expect(isOwner(OWNER, '')).toBe(false);
  });
});

describe('/reminders 鉴权（同 /tickets：只认 owner 私聊）', () => {
  const config = { ownerOpenid: OWNER } as never;

  it('owner 放行', () => {
    const cmd = remindersCommand({ config });
    expect(cmd.authorized?.(makeCtx(OWNER))).toBe(true);
  });

  it('陌生人返回空串（中间件判空就不发，彻底安静）', () => {
    const cmd = remindersCommand({ config });
    expect(cmd.authorized?.(makeCtx('stranger'))).toBe('');
  });

  it('没配 owner 谁都不放行', () => {
    expect(remindersCommand({}).authorized?.(makeCtx(OWNER))).toBe('');
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

  it('待发 + 失败都列出来：一行一条 emoji + 日期 + 时间 + 正文', async () => {
    const cmd = remindersCommand({
      readReminders: () => [
        row(),
        row({ id: 'rem_b', state: 'failed', attempts: 4, lastError: '401', text: '审计设计稿' }),
      ],
    });
    const out = (await cmd.handler(makeCtx())) as string;
    const lines = out.split('\n');
    expect(lines[0]).toBe('📋 提醒 2 条');
    expect(lines).toHaveLength(3);
    // 待发表不带状态字、id、目标；只留 emoji + 日期 + HH:MM + 正文
    expect(lines[1]).toMatch(/^⏰ \S+ \d{2}:\d{2} 换 key$/);
    // 失败行用 ⚠️ 区分
    expect(lines[2]).toMatch(/^⚠️ \S+ \d{2}:\d{2} 审计设计稿$/);
    expect(out).not.toContain('rem_a');
    expect(out).not.toContain('rem_b');
    expect(out).not.toContain('c2c:');
    expect(out).not.toContain('待发');
    expect(out).not.toContain('失败');
  });

  it('群聊一个字都不吐', async () => {
    const cmd = remindersCommand({ readReminders: () => [row()] });
    expect(await cmd.handler(makeCtx(OWNER, 'group', 'g1'))).toBe(REMINDERS_C2C_ONLY);
  });

  it('超长列表按 textChunkLimit 切块发', async () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: `rem_${i}`, text: '字'.repeat(200) }));
    const ctx = makeCtx();
    const cmd = remindersCommand({ readReminders: () => many, config: { textChunkLimit: 300 } as never });
    const out = await cmd.handler(ctx);
    expect(out).toEqual({ kind: 'noop' });
    const send = (ctx as unknown as { bot: { sendMarkdown: ReturnType<typeof vi.fn> } }).bot.sendMarkdown;
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });

  it('单条超长正文也不截断，整条走切块发', async () => {
    const long = '长'.repeat(2000);
    const ctx = makeCtx();
    const cmd = remindersCommand({ readReminders: () => [row({ text: long })], config: { textChunkLimit: 300 } as never });
    expect(await cmd.handler(ctx)).toEqual({ kind: 'noop' });
    const send = (ctx as unknown as { bot: { sendMarkdown: ReturnType<typeof vi.fn> } }).bot.sendMarkdown;
    const sent = send.mock.calls.map((c) => String(c[1] ?? '')).join('');
    expect(sent).toContain(long);
    expect(sent).not.toContain('…');
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
