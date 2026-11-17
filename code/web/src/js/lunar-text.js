/**
 * 0.8.39（用户 2026-11-18 01:56）：农历文案的唯一实现。
 *
 * 需求是「按记录本身的记法显示日期」：农历系列的日期要写农历，而不是把
 * DTSTART 换算成公历打印出来。详情卡（`modal.js` 的 viewLunarHint）与搜索
 * 结果（`search.js` 的 meta 行）必须同一套措辞，所以农历日期与规则说明只
 * 在这里写一份；不要在两边各拼一遍字符串（`describeRecurrence` 是公历周序 /
 * 每月几号的措辞，拿它描述农历系列会写出「每年6月1日」这种错话）。
 */
import { t } from '../i18n/index.js';
import { lunarLabel, solarToLunar } from './lib/lunar-core.js';
import { LUNAR_RULE_MONTHLY, LUNAR_RULE_YEARLY } from './lunar-repeat.js';

/**
 * 这条记录是否「按农历记」。两种来源都认：
 *  - 0.8.35 起编辑器「农历」开关写入 `lunar: true`；
 *  - 0.2.12 起的老系列只有 `lunarRule`（没有 `lunar` 标记）。
 */
export function isLunarRecord(item) {
  return Boolean(item) && (item.lunar === true || Boolean(item.lunarRule));
}

/** 取某个时刻的农历年月日；超出 1900–2100 年表时退回记录自带的农历字段。 */
function partsOf(item, ms) {
  const conv = Number.isFinite(ms) ? solarToLunar(ms) : null;
  if (conv) return conv;
  if (item && item.lunarMonth && item.lunarDay) {
    return {
      year: item.lunarYear || conv?.year,
      month: item.lunarMonth,
      day: item.lunarDay,
      leap: Boolean(item.lunarLeap),
    };
  }
  return null;
}

/**
 * 「农历八月十五」式日期文案（闰月自带「闰」，由 lunarMonthLabel 负责）。
 *
 * 优先按传进来的时刻换算——实例的农历日期以它自己落在哪天为准；主事件的
 * `lunarMonth` / `lunarDay` 只是规则锚点，农历每月的第 2 次起会差一个月。
 */
export function lunarDateLabel(item, ms) {
  if (!isLunarRecord(item)) return '';
  const parts = partsOf(item, Number(ms));
  if (!parts || !parts.month || !parts.day) return '';
  return lunarLabel(parts.year, parts.month, parts.day, Boolean(parts.leap), false);
}

/** 规则说明：「每年（农历）」/「每月（农历）」；没有规则时返回空串。 */
export function lunarRuleLabel(item) {
  if (!item) return '';
  if (item.lunarRule === LUNAR_RULE_MONTHLY) return t('lunar.rule.monthly');
  if (item.lunarRule === LUNAR_RULE_YEARLY) return t('lunar.rule.yearly');
  return '';
}

/**
 * 详情卡的农历一行（不含「第 N 次」，那截由 modal.js 的 withOccurrenceIndex 追加）：
 * 「农历八月十五 · 每年」，带间隔 / 结束日期时再补「· 每隔 2 个月 · 至 2026-06-30」。
 * 没有农历标记的条目返回空串（整行不显示）。
 */
export function lunarHintText(item, { endsOn = (date) => date } = {}) {
  if (!item || !item.lunar) return '';
  const label = lunarDateLabel(item, item.start || item.due);
  if (!label) return '';
  const monthly = item.lunarRule === LUNAR_RULE_MONTHLY;
  const yearly = item.lunarRule === LUNAR_RULE_YEARLY;
  const text = monthly
    ? t('view.lunarMonthly', { label })
    : yearly
      ? t('view.lunarYearly', { label })
      : t('view.lunar', { label });
  const extras = [];
  const every = Number(item.lunarInterval) || 1;
  if ((monthly || yearly) && every > 1) {
    extras.push(t('view.lunarEvery', {
      n: every,
      unit: t(monthly ? 'recurrence.unit.month' : 'recurrence.unit.year'),
    }));
  }
  if ((monthly || yearly) && item.lunarUntil) {
    extras.push(`${t('recurrence.ends.on')} ${endsOn(new Date(item.lunarUntil))}`);
  }
  return extras.length ? `${text} · ${extras.join(' · ')}` : text;
}
