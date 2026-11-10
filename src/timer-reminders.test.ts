import { describe, it, expect } from 'vitest';
import {
  MAX_TEXT_CHARS,
  NO_REMINDERS,
  clock,
  foldReminders,
  renderReminders,
  shortTarget,
} from './timer-reminders.ts';

describe('clock / shortTarget', () => {
  it('ISO 时刻按本地时区渲染到分钟', () => {
    expect(clock('2026-11-10T10:00:00.000Z')).toMatch(/^2026-11-10 \d{2}:\d{2}$/);
  });

  it('坏时刻原样吐出来，不抛', () => {
    expect(clock('not-a-time')).toBe('not-a-time');
  });

  it('c2c 目标保留头尾，中间省略', () => {
    expect(shortTarget('c2c:0000000000000000000000000000ABCD')).toBe('c2c:00000000…ABCD');
  });

  it('短 openid 不省略', () => {
    expect(shortTarget('c2c:abc')).toBe('c2c:abc');
  });

  it('不合格式的目标原样返回', () => {
    expect(shortTarget('somewhere')).toBe('somewhere');
  });
});

describe('foldReminders（出口读数 → 规整行）', () => {
  it('不是数组给空表', () => {
    expect(foldReminders(undefined)).toEqual([]);
    expect(foldReminders({ rows: [] })).toEqual([]);
  });

  it('保留 id/dueAt/text/target/state/attempts，失败带 lastError', () => {
    const items = foldReminders([
      {
        id: 'rem_a',
        dueAt: '2026-11-10T10:00:00.000Z',
        text: '换 key',
        target: 'c2c:u1',
        state: 'failed',
        attempts: 4,
        lastError: '401',
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'rem_a', text: '换 key', state: 'failed', attempts: 4, lastError: '401' });
  });

  it('缺 id 的行丢掉，其他字段缺了安全退化', () => {
    const items = foldReminders([{ text: '没 id' }, { id: 'rem_b' }]);
    expect(items.map((i) => i.id)).toEqual(['rem_b']);
    expect(items[0]).toMatchObject({ dueAt: '', target: '', state: '', attempts: 0 });
  });
});

describe('renderReminders', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'rem_x',
    dueAt: '2026-11-10T10:00:00.000Z',
    text: '正文',
    target: 'c2c:0000000000000000000000000000ABCD',
    state: 'pending',
    attempts: 0,
    ...over,
  });

  it('空表就是「没有提醒」', () => {
    expect(renderReminders([])).toBe(NO_REMINDERS);
  });

  it('报总数与待发/失败分项', () => {
    const text = renderReminders(
      foldReminders([row({}), row({ id: 'rem_y', state: 'failed', attempts: 4 })]),
    );
    expect(text).toContain('提醒 2 条');
    expect(text).toContain('待发 1');
    expect(text).toContain('失败 1');
  });

  it('每条都给 id、时间、状态、目标', () => {
    const text = renderReminders(foldReminders([row({})]));
    expect(text).toContain('rem_x');
    expect(text).toContain('待发');
    expect(text).toContain('c2c:00000000…ABCD');
    expect(text).toMatch(/2026-11-10 \d{2}:\d{2}/);
  });

  it('失败行带次数与最后错误', () => {
    const text = renderReminders(
      foldReminders([row({ state: 'failed', attempts: 4, lastError: 'send failed: 401 unauthorized' })]),
    );
    expect(text).toContain('失败（4 次）');
    expect(text).toContain('最后错误：send failed: 401 unauthorized');
  });

  it('正文截断到上限并补省略号', () => {
    const long = '啊'.repeat(MAX_TEXT_CHARS + 10);
    const text = renderReminders(foldReminders([row({ text: long })]));
    expect(text).toContain(`${'啊'.repeat(MAX_TEXT_CHARS)}…`);
    expect(text).not.toContain('啊'.repeat(MAX_TEXT_CHARS + 1));
  });

  it('超过上限的条数报「还有 n 条没列」', () => {
    const many = Array.from({ length: 22 }, (_, i) => row({ id: `rem_${i}` }));
    const text = renderReminders(foldReminders(many));
    expect(text).toContain('还有 2 条没列');
  });
});
