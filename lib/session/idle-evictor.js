export class IdleEvictor {
    timer = null;
    sessions;
    timeoutMs;
    keepAlivePeers;
    onEvict;
    constructor(sessions, timeoutMs, keepAlivePeers, onEvict) {
        this.sessions = sessions;
        this.timeoutMs = timeoutMs;
        this.keepAlivePeers = keepAlivePeers;
        this.onEvict = onEvict;
        if (timeoutMs > 0) {
            this.timer = setInterval(() => this.check(), 60_000);
        }
    }
    /** 执行一轮回收检查 */
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
    /** 停止回收定时器 */
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=idle-evictor.js.map