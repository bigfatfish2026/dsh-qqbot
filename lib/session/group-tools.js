/**
 * 计算本次要应用的白名单。
 *
 * - 非群聊：返回 undefined（私聊不受影响）
 * - 名单为空或全是空白：返回 undefined（保持原行为，向后兼容）
 * - 否则返回去重、去空白后的名单
 */
export function resolveGroupToolAllow(scope, allow) {
    if (scope !== 'group')
        return undefined;
    const cleaned = [...new Set((allow ?? []).map((name) => name.trim()).filter((name) => name.length > 0))];
    return cleaned.length > 0 ? cleaned : undefined;
}
/**
 * 把名单应用到某个 agent scope，返回是否真的应用成功。
 *
 * `ctx.tools` 是宿主可选提供的服务（未挂载时按不启用处理，只告警不中断会话）：
 * 工具收敛是加固手段，不该因为宿主版本差异把机器人打死。
 */
export function applyGroupToolAllow(scopedCtx, allow, onWarn) {
    const tools = scopedCtx?.tools;
    if (!tools) {
        onWarn('群聊工具白名单未生效：宿主未提供 ctx.tools');
        return false;
    }
    try {
        tools.restrict({ allow });
        return true;
    }
    catch (err) {
        onWarn(`群聊工具白名单应用失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
//# sourceMappingURL=group-tools.js.map