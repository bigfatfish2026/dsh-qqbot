/**
 * 偏好只读出口 —— `qqbot/prefs` 这个 cordis service 的实现。
 *
 * 别家插件（本机的 dsh-timer / dsh-email / dsh-speak-up-qq）要读 per-peer 偏好，
 * 规矩是走接口而不是自己 `readFileSync('~/.dsh-qqbot/model-prefs.json')`：
 * 文件格式归 qqbot 管，路径、缓存、并发写语义都在这边，别人直接读就要跟着改。
 *
 * 三条约束：
 * - 只读：不提供任何写方法，写仍然只走 PrefsStore（/model 指令那条路）；
 * - 深拷贝：payload() 给出去的是独立对象，消费者改它不影响 store、更不落盘；
 * - 同实例：拿的是 ModelResolver 里那个 PrefsStore，跟写者是同一份内存态，
 *   所以 payload() 读到的就是 qqbot 眼下的现状，不重读磁盘、不做热重载。
 *
 * 文件不存在 / 读不动 / JSON 坏了时 PrefsStore.load() 已经吞掉异常并留空表，
 * 这里照原样返回空的三段对象，不抛错——消费者按「没偏好」处理即可。
 */
import type { PrefsSnapshot, PrefsStore } from './prefs-store.ts';
import type { ModelRoute } from './types.ts';

/** cordis service 名。消费者按这个名字 `ctx.get()`。 */
export const PREFS_SERVICE = 'qqbot/prefs';

/**
 * 单键读的结果：一个 sessionKey 在三个段里的全部条目。
 *
 * 三段各自独立（可能只有 overrides、也可能只有 sessionIds），缺的那段整个键
 * 不出现，与 prefs-store 内部的可用性判断一致。三段都没有就返回 undefined。
 */
export interface PrefsEntry {
  override?: ModelRoute;
  sessionId?: string;
  preset?: string;
}

/** 出口形状；别家插件认这一份，改签名等于改对外契约。 */
export interface PrefsOutlet {
  /** 顶层路径，给诊断和「我读的是哪个文件」用。 */
  path(): string;
  /** 全量三段快照（深拷贝）；文件读不出来时是空对象表。 */
  payload(): PrefsSnapshot;
  /** 单键读：sessionKey 在三个段里的条目；不认识的 key 返回 undefined。 */
  get(key: string): PrefsEntry | undefined;
}

/**
 * 把只读出口挂到 ctx 上（cordis 的 `ctx.provide`），返回挂上去的出口。
 *
 * 挂不上不抛：热重载时同名服务可能还没被上一份 fiber 释放，ctx 也可能被宿主
 * 包成别的代理。这两种情况都只递给 warn 一句，消费者会按「服务缺失」回退。
 */
export function providePrefs(
  ctx: unknown,
  store: PrefsStore,
  warn: (msg: string) => void,
): PrefsReadout | undefined {
  const readout = new PrefsReadout(store);
  const provider = (ctx as { provide?: (name: string, value: unknown) => unknown }).provide;
  if (typeof provider !== 'function') {
    warn(`[qqbot] ctx 没有 provide，${PREFS_SERVICE} 没注册（消费者会回退读文件）`);
    return undefined;
  }
  try {
    provider.call(ctx, PREFS_SERVICE, readout);
    return readout;
  } catch (error) {
    warn(`[qqbot] ${PREFS_SERVICE} 服务没挂上：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export class PrefsReadout implements PrefsOutlet {
  constructor(private readonly store: PrefsStore) {}

  path(): string {
    return this.store.filePath;
  }

  payload(): PrefsSnapshot {
    return this.store.snapshot();
  }

  get(key: string): PrefsEntry | undefined {
    if (!key) return undefined;
    const override = this.store.getOverride(key);
    const sessionId = this.store.getSessionId(key);
    const preset = this.store.getPreset(key);
    if (override === undefined && sessionId === undefined && preset === undefined) return undefined;
    const entry: PrefsEntry = {};
    // Route 是纯字符串字段，浅拷贝就是深拷贝；但仍拷一份，别把 store 里的对象递出去
    if (override) entry.override = { ...override };
    if (sessionId !== undefined) entry.sessionId = sessionId;
    if (preset !== undefined) entry.preset = preset;
    return entry;
  }
}
