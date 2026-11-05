/** cordis service 名。消费者按这个名字 `ctx.get()`。 */
export const PREFS_SERVICE = 'qqbot/prefs';
/**
 * 把只读出口挂到 ctx 上（cordis 的 `ctx.provide`），返回挂上去的出口。
 *
 * 挂不上不抛：热重载时同名服务可能还没被上一份 fiber 释放，ctx 也可能被宿主
 * 包成别的代理。这两种情况都只递给 warn 一句，消费者会按「服务缺失」回退。
 */
export function providePrefs(ctx, store, warn) {
    const readout = new PrefsReadout(store);
    const provider = ctx.provide;
    if (typeof provider !== 'function') {
        warn(`[qqbot] ctx 没有 provide，${PREFS_SERVICE} 没注册（消费者会回退读文件）`);
        return undefined;
    }
    try {
        provider.call(ctx, PREFS_SERVICE, readout);
        return readout;
    }
    catch (error) {
        warn(`[qqbot] ${PREFS_SERVICE} 服务没挂上：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
export class PrefsReadout {
    store;
    constructor(store) {
        this.store = store;
    }
    path() {
        return this.store.filePath;
    }
    payload() {
        return this.store.snapshot();
    }
    get(key) {
        if (!key)
            return undefined;
        const override = this.store.getOverride(key);
        const sessionId = this.store.getSessionId(key);
        const preset = this.store.getPreset(key);
        if (override === undefined && sessionId === undefined && preset === undefined)
            return undefined;
        const entry = {};
        // Route 是纯字符串字段，浅拷贝就是深拷贝；但仍拷一份，别把 store 里的对象递出去
        if (override)
            entry.override = { ...override };
        if (sessionId !== undefined)
            entry.sessionId = sessionId;
        if (preset !== undefined)
            entry.preset = preset;
        return entry;
    }
}
//# sourceMappingURL=prefs-readout.js.map