/**
 * 0.8.53（任务书 F.9，总监静态审查 D1／D2）：错误文案统一出口。
 *
 * 背景：用户在界面上多次看到英文报错（`e.syncCalendar is not a function`）。
 * 规则：
 *
 * - **中文原样透传**：后端 `ApiError` 的 `message` 由服务端写成中文；应用自己
 *   throw 的中文提示同理。只要消息里有汉字就直接给用户，不再拼前后缀。
 * - **英文一律不露**：`TypeError('Failed to fetch')`、`SyntaxError('Unexpected
 *   token <')`、`err.message` 里混着英文的，全部换成中文兜底。
 * - 网络类异常给「无法连接服务器…」，其余给调用方传入的兜底键。
 *
 * 判断只看「消息里有没有汉字」，不看构造器名字：跨 realm 的 Error、被包装成普通
 * 对象的拒绝值都能覆盖；而英文消息永远进不了透传分支。
 */
import { t } from '../i18n/index.js';

const CJK = /[\u3400-\u9fff]/;

/** 像错误的对象：有字符串 `message`（`Error`、`ApiError`、`{ message }` 拒绝值）。 */
function errorMessage(err) {
  if (!err || typeof err !== 'object') return '';
  return typeof err.message === 'string' ? err.message.trim() : '';
}

/** 网络类异常：fetch 抛的 `TypeError('Failed to fetch')`、Abort、超时等。 */
function isNetworkish(err) {
  if (!err || typeof err !== 'object') return false;
  const name = String(err.name || '');
  if (name === 'NetworkError' || name === 'AbortError' || name === 'TimeoutError') return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return /fetch|network|load failed|timeout|abort/i.test(`${name} ${message}`);
}

/**
 * @param {unknown} err 捕获到的异常
 * @param {string} [fallbackKey] 非网络异常时的兜底 i18n 键
 * @returns {string} 一定会显示给用户的中文文案
 */
export function friendlyError(err, fallbackKey = 'error.actionFailed') {
  const message = errorMessage(err);
  // 有汉字的消息是人写的：服务端原因、应用自造提示——照原样展示。
  if (message && CJK.test(message)) return message;
  if (isNetworkish(err)) return t('error.network');
  return t(fallbackKey);
}
