/**
 * 所有者（owner）的私聊 openid —— 只读类指令的白名单来源。
 *
 * c2c 消息的 senderId 就是 user_openid，比较时统一大写。
 * /tickets 与 /reminders 共用这一份，别再各写各的。
 */
export const OWNER_OPENID = '0000000000000000000000000000ABCD';

/** 判断一个 senderId 是不是所有者（大小写不敏感，缺身份一律 false） */
export function isOwner(senderId: unknown): boolean {
  const id = String(senderId ?? '').trim().toUpperCase();
  return id !== '' && id === OWNER_OPENID.toUpperCase();
}
