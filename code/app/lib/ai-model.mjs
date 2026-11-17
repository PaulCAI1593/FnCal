/**
 * 0.8.37（任务书 §A）：AI 侧（MCP 与 REST 共用）的「重复 + 农历」参数口径。
 *
 * MCP 对外的参数是给模型看的（`FREQ` 用小写词、星期用 `MO/WE`），写进 ICS 的
 * 模型却是 store.js / 前端那一套（`{freq, interval, byWeekday, monthlyMode,
 * monthlyNth, count, until}`）。这一层只做映射与校验，不写 ICS：模型怎么落盘由
 * `ical.mjs` 决定，保证网页导出的 .ics 与 MCP 写出来的按同一份规则展开。
 *
 * 校验失败一律抛 `AiInputError`，`code` 是给客户端看的稳定标识：
 *   - `recurrence_unsupported`：规则超出「常见组合」，并说明支持哪几种；
 *   - `lunar_conflicts_ics`：同时给了 `ics` 与 `lunar`，不静默取舍；
 *   - `invalid`：字段本身不合法（沿用既有错误码）。
 */

import { normalizeRecurrence } from '../vendor/ical/recurrence.js';
import {
  LUNAR_RULE_MONTHLY,
  LUNAR_RULE_YEARLY,
  LUNAR_MAX_YEAR,
  LUNAR_MIN_YEAR,
  leapMonth,
  leapMonthDays,
  lunarDayLabel,
  lunarMonthLabel,
  solarToLunar,
} from './lunar-core.mjs';

export class AiInputError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = 'AiInputError';
    this.code = code;
    if (field) this.field = field;
  }
}

/** 支持的公历重复组合（错误文案与技能说明共用这一句）。 */
export const RECURRENCE_FORMATS =
  '支持：每天（freq=daily）、每周指定星期（freq=weekly + byDay）、每月第 N 天'
  + '（freq=monthly + monthDay）、每月第 N 个星期几（freq=monthly + setPos + weekday）、'
  + '每年（freq=yearly）；可带 interval / count / until。';

const WEEKDAY_TO_INDEX = Object.freeze({
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
});

const LUNAR_RULES = [LUNAR_RULE_YEARLY, LUNAR_RULE_MONTHLY];

function badField(field, message) {
  return new AiInputError('invalid', message, field);
}

/** `YYYY-MM-DD` → 当天本地零点毫秒；不合法返回 null。 */
function localDateMs(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

/**
 * `recurrence` 参数 → 模型里的 recurrence（`normalizeRecurrence` 的形状）。
 *
 * @param {object|null|undefined} input  `null` = 清除重复；`undefined` = 不改
 * @param {number} startMs               系列起点（事件开始 / 任务到期日）
 */
export function parseRecurrenceRequest(input, startMs) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw badField('recurrence', 'recurrence 必须是对象，或 null 表示清除重复');
  }
  const freq = String(input.freq || '').trim().toLowerCase();
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) {
    throw new AiInputError(
      'recurrence_unsupported',
      `不支持的重复频率：${input.freq || '(空)'}。${RECURRENCE_FORMATS}`,
      'recurrence.freq',
    );
  }
  const hasByDay = Array.isArray(input.byDay) && input.byDay.length > 0;
  const hasMonthDay = input.monthDay !== undefined && input.monthDay !== null;
  const hasSetPos = input.setPos !== undefined && input.setPos !== null;
  if (hasByDay && freq !== 'weekly') {
    throw new AiInputError('recurrence_unsupported', `byDay 只用于每周重复。${RECURRENCE_FORMATS}`, 'recurrence.byDay');
  }
  if ((hasMonthDay || hasSetPos || input.weekday !== undefined) && freq !== 'monthly') {
    throw new AiInputError(
      'recurrence_unsupported',
      `monthDay / setPos / weekday 只用于每月重复。${RECURRENCE_FORMATS}`,
      'recurrence.monthDay',
    );
  }
  if (hasMonthDay && hasSetPos) {
    throw new AiInputError(
      'recurrence_unsupported',
      `每月的「第几天」与「第几个星期几」只能二选一。${RECURRENCE_FORMATS}`,
      'recurrence',
    );
  }

  const draft = { freq };
  if (input.interval !== undefined && input.interval !== null) {
    const interval = Math.trunc(Number(input.interval));
    if (!Number.isFinite(interval) || interval < 1 || interval > 99) {
      throw badField('recurrence.interval', 'interval 需在 1–99 之间');
    }
    draft.interval = interval;
  }
  if (hasByDay) {
    const days = [...new Set(input.byDay.map((item) => String(item || '').trim().toUpperCase()))];
    const indexes = [];
    for (const day of days) {
      const index = WEEKDAY_TO_INDEX[day];
      if (index === undefined) throw badField('recurrence.byDay', `byDay 只接受 SU/MO/TU/WE/TH/FR/SA，收到 ${day}`);
      indexes.push(index);
    }
    draft.byWeekday = indexes.sort((a, b) => a - b);
  }
  if (hasMonthDay) {
    const monthDay = Math.trunc(Number(input.monthDay));
    if (!Number.isFinite(monthDay) || monthDay < 1 || monthDay > 31) {
      throw badField('recurrence.monthDay', 'monthDay 需在 1–31 之间');
    }
    draft.monthlyMode = 'date';
    draft.monthDay = monthDay;
  }
  if (hasSetPos) {
    const setPos = Math.trunc(Number(input.setPos));
    if (!(setPos === -1 || (setPos >= 1 && setPos <= 5))) {
      throw badField('recurrence.setPos', 'setPos 需在 1–5 之间，或 -1 表示最后一个');
    }
    const weekday = String(input.weekday || '').trim().toUpperCase();
    if (WEEKDAY_TO_INDEX[weekday] === undefined) {
      throw badField('recurrence.weekday', 'weekday 只接受 SU/MO/TU/WE/TH/FR/SA');
    }
    draft.monthlyMode = 'weekday';
    draft.monthlyNth = setPos;
    draft.byWeekday = [WEEKDAY_TO_INDEX[weekday]];
  }
  if (input.count !== undefined && input.count !== null) {
    const count = Math.trunc(Number(input.count));
    if (!Number.isFinite(count) || count < 1 || count > 999) throw badField('recurrence.count', 'count 需在 1–999 之间');
    draft.count = count;
  }
  if (input.until !== undefined && input.until !== null) {
    const until = Date.parse(String(input.until));
    if (!Number.isFinite(until)) throw badField('recurrence.until', 'until 必须是 ISO 时间');
    draft.until = until;
  }
  const normalized = normalizeRecurrence(draft, startMs);
  if (!normalized) {
    throw new AiInputError('recurrence_unsupported', `这条规则无法表达。${RECURRENCE_FORMATS}`, 'recurrence');
  }
  return normalized;
}

/**
 * `lunar` 参数 → 模型里的农历字段（与网页保存时的字段同名）。
 *
 * `lunar: null` 表示清除农历规则、退回单次事件/任务（由调用方删字段）。
 *
 * @param {object|null|undefined} input
 * @param {{startMs: number}} options  起始时刻（MONTHLY 省略 month 时取它的农历月）
 */
export function parseLunarRequest(input, { startMs } = {}) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw badField('lunar', 'lunar 必须是对象，或 null 表示清除农历规则');
  }
  const rule = String(input.rule || LUNAR_RULE_YEARLY).trim().toUpperCase();
  if (!LUNAR_RULES.includes(rule)) {
    throw badField('lunar.rule', `lunar.rule 只接受 ${LUNAR_RULES.join(' 或 ')}`);
  }
  const startLunar = Number.isFinite(startMs) ? solarToLunar(startMs) : null;
  if (!startLunar) {
    throw badField('lunar', `起始日期超出农历表（${LUNAR_MIN_YEAR}–${LUNAR_MAX_YEAR}），无法按农历重复`);
  }
  const monthlyRule = rule === LUNAR_RULE_MONTHLY;
  const monthRaw = input.month === undefined || input.month === null ? null : Math.trunc(Number(input.month));
  const month = monthlyRule ? (monthRaw === null ? startLunar.month : monthRaw) : monthRaw;
  const dayRaw = input.day === undefined || input.day === null ? null : Math.trunc(Number(input.day));
  const day = dayRaw === null ? (monthlyRule ? startLunar.day : null) : dayRaw;
  if (!Number.isInteger(month) || month < 1 || month > 12) throw badField('lunar.month', 'lunar.month 需在 1–12 之间');
  if (!Number.isInteger(day) || day < 1 || day > 30) throw badField('lunar.day', 'lunar.day 需在 1–30 之间');
  const leap = input.leap === true;
  if (leap) {
    // 起点所在农历年没有同号闰月时提前拒绝：否则会写出一条永远不生成的规则。
    if (leapMonth(startLunar.year) !== month) {
      throw badField('lunar.leap', `${startLunar.year} 年没有闰 ${month} 月，leap 不能为 true`);
    }
    if (day > leapMonthDays(startLunar.year)) {
      throw badField('lunar.day', `${startLunar.year} 年闰 ${month} 月只有 ${leapMonthDays(startLunar.year)} 天`);
    }
  }
  let interval = 1;
  if (input.interval !== undefined && input.interval !== null) {
    interval = Math.trunc(Number(input.interval));
    if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw badField('lunar.interval', 'interval 需在 1–99 之间');
  }
  let until = null;
  if (input.until !== undefined && input.until !== null) {
    until = localDateMs(input.until);
    if (until === null) throw badField('lunar.until', 'until 必须是 YYYY-MM-DD');
  }
  return {
    lunar: true,
    lunarMonth: month,
    lunarDay: day,
    lunarLeap: leap,
    lunarRule: rule,
    lunarInterval: interval,
    lunarUntil: until,
  };
}

/** 把 `parseLunarRequest` 的字段写进记录；`null` 表示清除。 */
export function applyLunarFields(record, parsed) {
  const target = record;
  delete target.lunarMonth;
  delete target.lunarDay;
  delete target.lunarLeap;
  delete target.lunarRule;
  delete target.lunarInterval;
  delete target.lunarUntil;
  if (!parsed) {
    target.lunar = false;
    return target;
  }
  Object.assign(target, parsed);
  return target;
}

/** 某个实例时刻对应的农历日；超表返回 null。 */
export function lunarViewOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const lunar = solarToLunar(ms);
  if (!lunar) return null;
  return {
    year: lunar.year,
    month: lunar.month,
    day: lunar.day,
    leap: Boolean(lunar.leap),
    text: `${lunarMonthLabel(lunar.month, lunar.leap)}${lunarDayLabel(lunar.day)}`,
  };
}

/** 记录上的农历规则（对外形态）；没有规则返回 null。 */
export function lunarRuleViewOf(record) {
  if (!record || !record.lunar) return null;
  if (record.lunarRule !== LUNAR_RULE_YEARLY && record.lunarRule !== LUNAR_RULE_MONTHLY) return null;
  return {
    rule: record.lunarRule,
    month: Number.isInteger(record.lunarMonth) ? record.lunarMonth : null,
    day: Number.isInteger(record.lunarDay) ? record.lunarDay : null,
    leap: record.lunarLeap === true,
    interval: Number.isInteger(record.lunarInterval) && record.lunarInterval > 1 ? record.lunarInterval : 1,
    until: Number.isFinite(record.lunarUntil) ? new Date(record.lunarUntil).toISOString() : null,
  };
}

const WEEKDAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** 公历重复的对外形态（byWeekday 数字 → `MO/WE`）；没有重复返回 null。 */
export function recurrenceViewOf(recurrence) {
  if (!recurrence || !recurrence.freq) return null;
  const view = {
    freq: recurrence.freq,
    interval: Number.isInteger(recurrence.interval) && recurrence.interval > 0 ? recurrence.interval : 1,
  };
  if (Array.isArray(recurrence.byWeekday) && recurrence.byWeekday.length) {
    view.byDay = recurrence.byWeekday.map((index) => WEEKDAY_NAMES[index]).filter(Boolean);
  }
  if (recurrence.freq === 'monthly') {
    view.monthlyMode = recurrence.monthlyMode === 'weekday' ? 'weekday' : 'date';
    if (recurrence.monthlyMode === 'weekday' && recurrence.monthlyNth != null) view.setPos = recurrence.monthlyNth;
  }
  if (recurrence.count != null) view.count = recurrence.count;
  if (recurrence.until != null) view.until = new Date(recurrence.until).toISOString();
  return view;
}
