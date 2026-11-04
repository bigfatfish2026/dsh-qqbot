/** 出口的 service 名，和 dsh-dispatcher 的 tickets/readout.ts 同一个常数。 */
export const TICKETS_SERVICE = 'dispatcher/tickets';
/**
 * 从 ctx 上摸出口。
 *
 * ctx.get 是 cordis 的 reflect.get：服务没注册就返回 undefined，不抛；
 * 万一宿主包了别的代理，再退一步直接读属性，仍旧 try 住。两条都不成就当没出口。
 */
function probeOutlet(ctx) {
    if (!ctx)
        return undefined;
    let raw;
    try {
        raw = ctx.get(TICKETS_SERVICE);
    }
    catch {
        raw = undefined;
    }
    if (raw === undefined || raw === null) {
        try {
            raw = ctx[TICKETS_SERVICE];
        }
        catch {
            raw = undefined;
        }
    }
    if (!raw || typeof raw !== 'object')
        return undefined;
    const outlet = raw;
    return typeof outlet.payload === 'function' ? outlet : undefined;
}
/**
 * 造一条惰性读票函数。
 *
 * 惰性是为了服务晚到：每次调用现摸 ctx，dispatcher 后加载、热重载后重新提供
 * 服务都能读到。出口不在、payload 抛错、返回值不是对象，一律给 undefined，
 * 不把异常甩给命令层——那层只要「有没有读数」这一个事实。
 */
export function createTicketsReader(ctx) {
    return (selection) => {
        const outlet = probeOutlet(ctx);
        if (!outlet?.payload)
            return undefined;
        try {
            const payload = outlet.payload(selection);
            return payload && typeof payload === 'object' ? payload : undefined;
        }
        catch {
            return undefined;
        }
    };
}
//# sourceMappingURL=tickets-source.js.map