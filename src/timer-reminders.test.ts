import { describe, it, expect } from 'vitest';
import {
  NO_REMINDERS,
  calendarDayDiff,
  foldReminders,
  formatClock,
  formatDueWhen,
  relativeDayLabel,
  renderReminders,
} from './timer-reminders.ts';

/** 本机时区（这台树莓派是 Asia/Shanghai / CST）构一个时刻，测试不写死 UTC 偏移 */
const at = (y: number, m: number, d: number, hh = 12, mm = 0): Date => new Date(y, m - 1, d, hh, mm);
const iso = (y: number, m: number, d: number, hh = 12, mm = 0): string => at(y, m, d, hh, mm).toISOString();

describe('calendarDayDiff（本地日历日）', () => {
  const now = at(2026, 11, 10, 16, 50);

  it('同一天不同时刻差 0', () => {
    expect(calendarDayDiff(now, at(2026, 11, 10, 0, 0))).toBe(0);
    expect(calendarDayDiff(now, at(2026, 11, 10, 23, 59))).toBe(0);
  });

  it('跨零点就是 1 天，哪怕只差 1 分钟', () => {
    expect(calendarDayDiff(at(2026, 11, 10, 23, 59), at(2026, 11, 11, 0, 0))).toBe(1);
  });

  it('往过去是负数', () => {
    expect(calendarDayDiff(now, at(2026, 11, 9, 10, 0))).toBe(-1);
  });

  it('跨月、跨年都按日历日算', () => {
    expect(calendarDayDiff(at(2026, 11, 30, 23, 0), at(2026, 12, 1, 0, 0))).toBe(1);
    expect(calendarDayDiff(at(2026, 12, 31, 23, 0), at(2027, 1, 1, 0, 0))).toBe(1);
  });
});

describe('formatClock（HH:MM 24 小时制，本机时区）', () => {
  it('补零到两位', () => {
    expect(formatClock(at(2026, 11, 10, 9, 5))).toBe('09:05');
    expect(formatClock(at(2026, 11, 10, 0, 0))).toBe('00:00');
    expect(formatClock(at(2026, 11, 10, 23, 59))).toBe('23:59');
  });

  it('UTC ISO 按本机时区换钟点（这台树莓派是 CST +8）', () => {
    const d = new Date('2026-11-10T01:30:00.000Z');
    const intl = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    expect(formatClock(d)).toBe(intl);
    // 只在真的跑在 CST 的机器上钉死 01:30Z = 09:30，别在别的时区假红
    if (new Date().getTimezoneOffset() === -480) expect(formatClock(d)).toBe('09:30');
  });
});

describe('relativeDayLabel（相对日期词）', () => {
  // 2026-11-10 是周二，本周 = 11-09(一) ~ 11-15(日)
  const tue = at(2026, 11, 10, 16, 50);

  it('今天 / 明天 / 后天', () => {
    expect(relativeDayLabel(at(2026, 11, 10, 23, 59), tue)).toBe('今天');
    expect(relativeDayLabel(at(2026, 11, 11, 9, 30), tue)).toBe('明天');
    expect(relativeDayLabel(at(2026, 11, 12, 0, 0), tue)).toBe('后天');
  });

  it('三天后但还在本周给「本周X」', () => {
    expect(relativeDayLabel(at(2026, 11, 13, 18, 0), tue)).toBe('本周五');
    expect(relativeDayLabel(at(2026, 11, 15, 10, 0), tue)).toBe('本周日');
  });

  it('一周内跨到下周给「下周X」', () => {
    expect(relativeDayLabel(at(2026, 11, 16, 10, 0), tue)).toBe('下周一');
    expect(relativeDayLabel(at(2026, 11, 17, 10, 0), tue)).toBe('下周二');
  });

  it('超过一周回到「X月X日」，不带年份', () => {
    expect(relativeDayLabel(at(2026, 11, 18, 10, 0), tue)).toBe('11月18日');
    expect(relativeDayLabel(at(2026, 12, 25, 10, 0), tue)).toBe('12月25日');
  });

  it('本周已经过去的那天不叫「本周X」，落到月日', () => {
    expect(relativeDayLabel(at(2026, 11, 9, 10, 0), tue)).toBe('11月9日');
    expect(relativeDayLabel(at(2026, 11, 10, 8, 0), tue)).toBe('今天');
  });

  it('周日当「今天」时，下周一仍在 7 天内算「下周一」', () => {
    const sun = at(2026, 11, 15, 20, 0);
    expect(relativeDayLabel(at(2026, 11, 16, 9, 0), sun)).toBe('明天');
    // 周日已经在本周末尾，3 天后就跨周了
    expect(relativeDayLabel(at(2026, 11, 20, 9, 0), sun)).toBe('下周五');
    expect(relativeDayLabel(at(2026, 11, 22, 9, 0), sun)).toBe('下周日');
  });

  it('23:59 / 00:00 边界不串日', () => {
    const late = at(2026, 11, 10, 23, 59);
    expect(relativeDayLabel(at(2026, 11, 11, 0, 0), late)).toBe('明天');
    const early = at(2026, 11, 11, 0, 0);
    expect(relativeDayLabel(at(2026, 11, 11, 0, 1), early)).toBe('今天');
  });

  it('月末边界', () => {
    const monthEnd = at(2026, 11, 30, 22, 0);
    expect(relativeDayLabel(at(2026, 12, 1, 9, 0), monthEnd)).toBe('明天');
    expect(relativeDayLabel(at(2026, 12, 3, 9, 0), monthEnd)).toBe('本周四');
    expect(relativeDayLabel(at(2026, 12, 10, 9, 0), monthEnd)).toBe('12月10日');
  });

  it('跨年边界', () => {
    const yearEnd = at(2026, 12, 31, 23, 59);
    expect(relativeDayLabel(at(2027, 1, 1, 0, 0), yearEnd)).toBe('明天');
    expect(relativeDayLabel(at(2027, 1, 5, 9, 0), yearEnd)).toBe('下周二');
    expect(relativeDayLabel(at(2027, 1, 8, 9, 0), yearEnd)).toBe('1月8日');
  });

  it('闰年 2 月 29 也算得出来', () => {
    const feb28 = at(2028, 2, 28, 10, 0);
    expect(relativeDayLabel(at(2028, 2, 29, 10, 0), feb28)).toBe('明天');
  });
});

describe('formatDueWhen / 坏输入', () => {
  const now = at(2026, 11, 10, 16, 50);

  it('拼成「日期词 HH:MM」', () => {
    expect(formatDueWhen(iso(2026, 11, 11, 9, 30), now)).toBe('明天 09:30');
    expect(formatDueWhen(iso(2026, 11, 10, 23, 59), now)).toBe('今天 23:59');
  });

  it('坏时刻原样吐出来，不抛', () => {
    expect(formatDueWhen('not-a-time', now)).toBe('not-a-time');
    expect(formatDueWhen('', now)).toBe('—');
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
        dueAt: iso(2026, 11, 11, 9, 30),
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

describe('renderReminders（新格式：emoji + 日期 + 时间 + 正文全文）', () => {
  const now = at(2026, 11, 10, 16, 50);

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'rem_x',
    dueAt: iso(2026, 11, 11, 9, 30),
    text: '该换钥匙了',
    target: 'c2c:0000000000000000000000000000ABCD',
    state: 'pending',
    attempts: 0,
    ...over,
  });

  it('空表就是「没有提醒」', () => {
    expect(renderReminders([])).toBe(NO_REMINDERS);
  });

  it('标题只有条数，没有「（待发 n）」括注', () => {
    const text = renderReminders(foldReminders([row(), row({ id: 'rem_y', state: 'failed' })]), now);
    expect(text.split('\n')[0]).toBe('📋 提醒 2 条');
    expect(text).not.toContain('待发');
    expect(text).not.toContain('失败');
  });

  it('一行一条：⏰ 明天 09:30 正文，不带 id / 目标 / 状态字', () => {
    const text = renderReminders(foldReminders([row()]), now);
    expect(text).toBe('📋 提醒 1 条\n⏰ 明天 09:30 该换钥匙了');
    expect(text).not.toContain('rem_x');
    expect(text).not.toContain('c2c:');
  });

  it('失败行用 ⚠️ 区分，不写「失败」「待发」，也不带次数和最后错误', () => {
    const text = renderReminders(
      foldReminders([row({ state: 'failed', attempts: 4, lastError: 'send failed: 401 unauthorized' })]),
      now,
    );
    expect(text).toContain('⚠️ 明天 09:30 该换钥匙了');
    expect(text).not.toContain('失败');
    expect(text).not.toContain('send failed');
    expect(text).not.toContain('4 次');
  });

  it('发送中用 ⏳，认不出的状态用 🔔', () => {
    expect(renderReminders(foldReminders([row({ state: 'sending' })]), now)).toContain('⏳ 明天 09:30');
    expect(renderReminders(foldReminders([row({ state: 'weird' })]), now)).toContain('🔔 明天 09:30');
  });

  it('正文不截断，60 字以上全文照出', () => {
    const long = '啊'.repeat(200);
    const text = renderReminders(foldReminders([row({ text: long })]), now);
    expect(text).toContain(long);
    expect(text).not.toContain('…');
  });

  it('超过条数上限报「还有 n 条没列」，每条仍只有一行', () => {
    const many = Array.from({ length: 22 }, (_, i) => row({ id: `rem_${i}` }));
    const text = renderReminders(foldReminders(many), now);
    expect(text).toContain('还有 2 条没列');
    expect(text.split('\n')).toHaveLength(1 + 20 + 1);
  });
});
