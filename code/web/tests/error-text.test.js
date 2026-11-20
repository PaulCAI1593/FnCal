/**
 * 0.8.53（任务书 F.9，总监自审 D1／D2）：错误文案统一出口。
 *
 * 用户多轮截图里出现过英文报错（`e.syncCalendar is not a function`）。
 * 规则：含汉字的消息原样透传（服务端原因、应用自造提示）；英文消息一律
 * 换成中文兜底，绝不把 `err.message` 拼进界面文案。
 */
import { describe, it, expect } from 'vitest';
import { friendlyError } from '../src/js/error-text.js';
import { t } from '../src/i18n/index.js';

const CJK = /[\u3400-\u9fff]/;

describe('0.8.53 · friendlyError（错误文案统一出口）', () => {
  it('后端 ApiError 的中文 message 原样透传', () => {
    const err = Object.assign(new Error('订阅地址无法访问，请检查网络或地址'), {
      name: 'ApiError',
      status: 400,
      code: 'subscription_unreachable',
    });
    expect(friendlyError(err, 'calendar.subscription.syncReasonUnknown')).toBe(
      '订阅地址无法访问，请检查网络或地址',
    );
  });

  it('普通 Error 的中文 message 也透传（服务端/应用自造中文）', () => {
    expect(friendlyError(new Error('权限更新失败'), 'settings.saveFailed')).toBe('权限更新失败');
  });

  it('后端错误但 message 是英文时改用兜底中文，不吐英文', () => {
    const err = Object.assign(new Error('Internal Server Error'), {
      name: 'ApiError',
      status: 500,
      code: 'internal',
    });
    const text = friendlyError(err, 'settings.ai.loadFailed');
    expect(text).toBe(t('settings.ai.loadFailed'));
    expect(text).not.toMatch(/Internal Server Error/);
  });

  it('TypeError("Failed to fetch") 给网络类中文，不含英文', () => {
    const text = friendlyError(new TypeError('Failed to fetch'));
    expect(text).toBe(t('error.network'));
    expect(CJK.test(text)).toBe(true);
    expect(text).not.toMatch(/fetch/i);
  });

  it('SyntaxError("Unexpected token <") 给兜底中文，不含英文', () => {
    const text = friendlyError(new SyntaxError('Unexpected token < in JSON at position 0'), 'io.error.exportFailed');
    expect(text).toBe(t('io.error.exportFailed'));
    expect(text).not.toMatch(/Unexpected token/);
  });

  it('未知对象（没有 message）给兜底中文', () => {
    const text = friendlyError({ nope: true }, 'error.actionFailed');
    expect(text).toBe(t('error.actionFailed'));
    expect(CJK.test(text)).toBe(true);
  });

  it('非对象异常（字符串 / undefined）也给兜底中文', () => {
    expect(friendlyError('boom', 'error.actionFailed')).toBe(t('error.actionFailed'));
    expect(friendlyError(undefined, 'error.actionFailed')).toBe(t('error.actionFailed'));
  });

  it('默认兜底键是 error.actionFailed，且词条存在', () => {
    expect(t('error.actionFailed')).not.toBe('error.actionFailed');
    expect(friendlyError(new Error('boom'))).toBe(t('error.actionFailed'));
  });

  it('AbortError / TimeoutError 走网络类中文', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    expect(friendlyError(abort)).toBe(t('error.network'));
    expect(friendlyError(timeout)).toBe(t('error.network'));
  });
});
