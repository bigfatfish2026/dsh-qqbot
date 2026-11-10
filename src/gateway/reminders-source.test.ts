import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REMINDER_TABLE } from '../timer-reminders.ts';
import { createRemindersReader, resolveTimerDbPath, TIMER_DB_ENV } from './reminders-source.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-reminders-'));
  dbPath = join(dir, 'timer.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 照 dsh-timer lib/remind.js 的建表语句建一份（测试库，只用一次） */
function seed(rows: Array<Record<string, unknown>> = []): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${REMINDER_TABLE} (
       id TEXT PRIMARY KEY,
       dueAt TEXT NOT NULL,
       whenRaw TEXT NOT NULL,
       text TEXT NOT NULL,
       target TEXT NOT NULL,
       createdAt TEXT NOT NULL,
       state TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0,
       nextAttemptAt TEXT,
       lastError TEXT,
       sentAt TEXT
     )`,
  );
  for (const row of rows) {
    db.prepare(
      `INSERT INTO ${REMINDER_TABLE}(id, dueAt, whenRaw, text, target, createdAt, state, attempts, lastError)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(row.id),
      String(row.dueAt),
      String(row.dueAt),
      String(row.text),
      String(row.target),
      '2026-11-10T00:00:00.000Z',
      String(row.state ?? 'pending'),
      Number(row.attempts ?? 0),
      (row.lastError as string | null) ?? null,
    );
  }
  db.close();
}

describe('resolveTimerDbPath', () => {
  it('默认落在 dsh-timer 的 stateDbPath', () => {
    expect(resolveTimerDbPath({})).toMatch(/dsh-timer[\\/]timer[\\/]timer\.db$/);
  });

  it('环境变量能覆盖', () => {
    expect(resolveTimerDbPath({ [TIMER_DB_ENV]: '/tmp/other.db' })).toBe('/tmp/other.db');
  });

  it('环境变量是空白就回默认', () => {
    expect(resolveTimerDbPath({ [TIMER_DB_ENV]: '   ' })).toMatch(/timer\.db$/);
  });
});

describe('createRemindersReader（只读读 dsh-timer 的 sqlite）', () => {
  it('库文件不在：undefined，且不新建文件', () => {
    const read = createRemindersReader(dbPath);
    expect(read()).toBeUndefined();
    expect(existsSync(dbPath)).toBe(false);
  });

  it('空表：空数组（= 没有提醒，不是读不出来）', () => {
    seed();
    const read = createRemindersReader(dbPath);
    expect(read()).toEqual([]);
  });

  it('pending 与 failed 都读出来，按到点时间排', () => {
    seed([
      { id: 'rem_b', dueAt: '2026-11-10T11:00:00.000Z', text: '后一条', target: 'c2c:u1', state: 'failed', attempts: 4, lastError: '401' },
      { id: 'rem_a', dueAt: '2026-11-10T10:00:00.000Z', text: '前一条', target: 'c2c:u1', state: 'pending' },
    ]);
    const rows = createRemindersReader(dbPath)();
    expect(rows?.map((r) => r.id)).toEqual(['rem_a', 'rem_b']);
    expect(rows?.[1]).toMatchObject({ state: 'failed', attempts: 4, lastError: '401' });
  });

  it('每次调用现读：新写的行下一次就看得见（不缓存）', () => {
    seed();
    const read = createRemindersReader(dbPath);
    expect(read()).toEqual([]);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO ${REMINDER_TABLE}(id, dueAt, whenRaw, text, target, createdAt, state, attempts)
       VALUES ('rem_new','2026-11-10T12:00:00.000Z','12:00','新加的','c2c:u1','2026-11-10T01:00:00.000Z','pending',0)`,
    ).run();
    db.close();
    expect(read()?.map((r) => r.id)).toEqual(['rem_new']);
  });

  it('写不进这个连接：query_only 生效（读接口不碰库内容）', () => {
    seed([{ id: 'rem_a', dueAt: '2026-11-10T10:00:00.000Z', text: 'x', target: 'c2c:u1' }]);
    const read = createRemindersReader(dbPath);
    read();
    const db = new DatabaseSync(dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${REMINDER_TABLE}`).get() as { n: number };
    db.close();
    expect(Number(count.n)).toBe(1);
  });

  it('表没建：undefined（读不出来，不冒充空表）', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE other (x TEXT)');
    db.close();
    expect(createRemindersReader(dbPath)()).toBeUndefined();
  });

  it('读失败只 warn 一次', () => {
    const warnings: string[] = [];
    const read = createRemindersReader(join(dir, 'missing.db'), {
      warn: (m: string) => warnings.push(m),
    } as never);
    read();
    read();
    expect(warnings).toHaveLength(1);
  });
});
