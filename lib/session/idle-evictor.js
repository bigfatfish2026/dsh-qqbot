export class IdleEvictor {
    sessions;
    timeoutMs;
    keepAlivePeers;
    onEvict;
    constructor(sessions, timeoutMs, keepAlivePeers, onEvict) {
        this.sessions = sessions;
        this.timeoutMs = timeoutMs;
        this.keepAlivePeers = keepAlivePeers;
        this.onEvict = onEvict;
    }
    /** 执行一轮回收检查（由 tick 或回落 interval 驱动，重复调幂等） */
    check() {
        const now = Date.now();
        for (const [key, record] of this.sessions) {
            // 私聊常驻名单：c2c 命中就不回收；群聊不进白名单逻辑
            if (record.scope === 'c2c' && this.keepAlivePeers.has(record.peerId))
                continue;
            if (now - record.lastActivity > this.timeoutMs) {
                this.onEvict(key, record);
            }
        }
    }
    /** 停止回收（驱动源由 SessionManager 的 tick driver 收，这里留口子给旧调用方） */
    dispose() { }
}
//# sourceMappingURL=idle-evictor.js.map