// 0.4.22（M4 §S1）：审批页 4 位 PIN 的哈希与校验。
//
// PIN 只用于 `/a/<token>` 审批页，不进 API、不回显、不写日志。存储形态与账号密码
// 一致（bcrypt 哈希，见 `auth/accounts.mjs` 的 hashPassword / verifyPassword），
// 因此不在凭据文件里留明文，也不能被 JSON 读出来后反推。
//
// 约束：只接受 4 位阿拉伯数字。长度/字符不对一律 `invalid`，不静默截断。

import { hashPassword, verifyPassword } from '../auth/accounts.mjs';

export const PIN_LENGTH = 4;
export const PIN_PATTERN = /^\d{4}$/;
export const PIN_HINT_TEXT = '这 4 位只用于审批页，不要告诉 AI 助手。';

export function isValidPin(value) {
  return typeof value === 'string' && PIN_PATTERN.test(value);
}

export async function hashPin(pin) {
  if (!isValidPin(pin)) {
    const err = new Error('PIN 必须是 4 位数字');
    err.code = 'invalid';
    err.field = 'pin';
    throw err;
  }
  return hashPassword(pin);
}

export async function verifyPin(pin, hash) {
  if (!isValidPin(pin) || !hash) return false;
  return verifyPassword(pin, hash);
}
