/**
 * 极简 i18n 层：一个 `t(key, params)` + 一份 zh-CN 词条表。
 *
 * 设计取舍（对齐《M2-中文术语表与文案规范》§7.1）：
 *   - 只做单语言，不做切换器；`locale` 仍保留，便于将来加词典。
 *   - key 用「模块.对象.动作」三段式，缺词条时原样返回 key（不静默吞掉，
 *     便于走查时一眼看出漏翻）。
 *   - 占位符写作 `{name}`；参数值按 String() 插入，不转义（文案里不含 HTML）。
 */
import { zhCN } from './zh-CN.js';

const DICTIONARIES = { 'zh-CN': zhCN };
export const DEFAULT_LOCALE = 'zh-CN';

let locale = DEFAULT_LOCALE;

export function setLocale(next) {
  if (!next) return;
  if (DICTIONARIES[next]) locale = next;
}

export function getLocale() {
  return locale;
}

export function hasKey(key, at = locale) {
  const dict = DICTIONARIES[at];
  return Boolean(dict && Object.prototype.hasOwnProperty.call(dict, key));
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] != null
      ? String(params[name])
      : match,
  );
}

/**
 * @param {string} key 词典键
 * @param {Record<string, string|number>} [params] 占位符参数
 * @returns {string}
 */
export function t(key, params) {
  const dict = DICTIONARIES[locale] || zhCN;
  const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  return interpolate(template, params);
}

/** 缺词条清单（供自检脚本/走查使用）。 */
export function missingKeys(keys) {
  return keys.filter((key) => !hasKey(key));
}

export default t;
