/**
 * 只读类指令（/tickets、/reminders）的 owner 白名单。
 *
 * c2c 消息的 senderId 就是 user_openid，比较时统一大写。
 * 名单来源：配置项 `ownerOpenid` 优先，其次环境变量 `QQBOT_OWNER_OPENID`
 * （逗号/空格/分号分隔，可写多个）；两边都没配就等于没人可用，fail-closed。
 * 不在代码里写死任何真实 openid。
 */
/** 名单的环境变量名（配置项为空时回退到这里） */
export const OWNER_ENV = 'QQBOT_OWNER_OPENID';
/** 把逗号/空格/分号分隔的字符串（或数组）规整成大写 openid 集合 */
export function parseOwnerIds(raw) {
    const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/);
    const out = [];
    for (const part of parts) {
        const id = String(part ?? '').trim().toUpperCase();
        if (id && !out.includes(id))
            out.push(id);
    }
    return out;
}
/** 生效名单：配置项优先，其次环境变量；都没有就是空数组 */
export function resolveOwnerIds(configured, env = process.env) {
    const fromConfig = parseOwnerIds(configured);
    return fromConfig.length > 0 ? fromConfig : parseOwnerIds(env[OWNER_ENV]);
}
/** 判断一个 senderId 是不是 owner（大小写不敏感，缺身份一律 false） */
export function isOwner(senderId, configured) {
    const id = String(senderId ?? '').trim().toUpperCase();
    if (!id)
        return false;
    return resolveOwnerIds(configured).includes(id);
}
//# sourceMappingURL=owner.js.map