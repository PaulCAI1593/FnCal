#!/usr/bin/env node
/**
 * audit-i18n-length.mjs —— 按钮/菜单/分段控件文案长度审计（M3 走查）
 *
 * 目的：中文按钮/菜单项过长会撑破工具栏或在窄屏换行。对 `src/i18n/zh-CN.js`
 * 中命名含 button/action/cta/tab/menu 的 key，统计**汉字个数**，>4 列为超长。
 *
 * 用法：
 *   node scripts/audit-i18n-length.mjs             # 默认扫 code/web/src/i18n/zh-CN.js
 *   node scripts/audit-i18n-length.mjs <词典文件>  # 指定文件
 *
 * 输出：每个超长 key 一行 `文件:行: key 文案 (N 汉字)`，末行固定
 *   SUMMARY: keys=N over=N
 * over>0 且不在白名单 → 退出码 1；全部 ≤4 或白名单有理由 → 退出 0。
 *
 * 白名单必须写明理由（例如「设置菜单里的说明性选项，非按钮」）；白名单 key 仍会
 * 打印在输出里（标 [whitelisted]），方便走查复核。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DICT = path.resolve(HERE, '..', 'web', 'src', 'i18n', 'zh-CN.js');
const MAX_HAN = 4;
const KEY_PATTERN = /(button|action|cta|tab|menu)/i;

/**
 * 允许超过 4 个汉字的 key → 理由。只允许「确实不是紧凑按钮」的项；新增条目要
 * 在 M3 走查记录里能直接引用这条理由。
 */
const WHITELIST = new Map([
  ['menu.clockChanges', '设置菜单里的开关行（带说明含义），不是按钮；按「夏令时切换」显示更清楚'],
  ['menu.holidays.autoNone', '设置菜单下拉选项，含括号说明「自动（未识别）」，不是按钮'],
  ['app.action.newAllDayEvent', '右键菜单项（新建全天事件），菜单宽度自适应，不是工具栏按钮'],
  ['app.action.newOoo', '右键菜单项（新建外出），菜单宽度自适应，不是工具栏按钮'],
  ['recurrence.action.custom', '重复规则对话框标题，不是按钮（正文更长也不挤按钮栏）'],
  ['recurrence.action.editSeries', '确认对话框标题（编辑重复事件），不是按钮'],
  ['recurrence.action.deleteSeries', '确认对话框标题（删除重复事件），不是按钮'],
  ['editor.action.notificationsEnable', '权限提示里的动作句（开启通知），不是紧凑按钮'],
]);

const HAN_RE = /[\u4e00-\u9fa5]/g;
const hanCount = (text) => (String(text).match(HAN_RE) || []).length;

function parseDictionary(source) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*'([^']+)':\s*(['"])(.*?)\2,?\s*$/.exec(lines[i]);
    if (match) entries.push({ key: match[1], value: match[3], line: i + 1 });
  }
  return entries;
}

async function main() {
  const target = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : DEFAULT_DICT;
  const source = await fs.readFile(target, 'utf8');
  const entries = parseDictionary(source).filter((entry) => KEY_PATTERN.test(entry.key));
  const over = [];
  for (const entry of entries) {
    const count = hanCount(entry.value);
    if (count <= MAX_HAN) continue;
    const reason = WHITELIST.get(entry.key);
    over.push({ ...entry, count, reason });
  }
  for (const item of over) {
    const tag = item.reason ? `  [whitelisted: ${item.reason}]` : '';
    const rel = path.relative(path.resolve(HERE, '..'), target).split(path.sep).join('/');
    console.log(`${rel}:${item.line}: ${item.key} 「${item.value}」 (${item.count} 汉字)${tag}`);
  }
  const violations = over.filter((item) => !item.reason);
  console.log(`SUMMARY: keys=${entries.length} over=${violations.length}`);
  if (over.length !== violations.length) {
    console.log(`（另有 ${over.length - violations.length} 条超长但已白名单，见上方 [whitelisted]）`);
  }
  process.exit(violations.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(2);
});
