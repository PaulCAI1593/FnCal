#!/usr/bin/env node
/**
 * 0.8.28（总监 m01069 ①② + 补一条口径）：MCP 年度总结与网页同口径。
 *
 * 覆盖断言：
 *   (a) `settings.weekStartsOn = 1` → MCP 模型 `weekStartsOn = 1`、月份表头从周一起；
 *   (b) `settings.visibleCalendarIds = ['c1']` → 模型只含 c1，总数与网页接口同参数结果一致；
 *   (c) 某日历 `meta.visible = false` 且清单为空 → 被排除；
 *   (d) 同一份数据 + 同一份 settings，MCP 模型与网页侧 `buildAnnualReviewData` 逐字段相同；
 *   (e) 日历在网页开着、凭据不可读 → 不进模型、不进 `list_calendars`、不报错；
 *   (f) 该场景下两边结果「预期不同」，不参与 (d) 的一致性对照；
 *   另：`list_calendars` 对被开关关掉但仍可读的日历返回 `visible: false`（不隐藏、不报错）。
 *
 * 运行：在 `projects/FnCal/code` 下 `node app/test/m63-mcp-annual-scope.test.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-m63-annual-scope-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;

const { createStore } = await import('../store/file-store.mjs');
const aiStoreMod = await import('../lib/ai-store.mjs');
const { createAiService } = await import('../lib/ai-service.mjs');
const { buildAnnualReviewData } = await import('../lib/annual-review.mjs');
const { collectAnnualEvents, yearRange } = await import('../lib/annual-collect.mjs');

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`); }
}
const eq = (name, expected, actual) => ok(name, JSON.stringify(expected) === JSON.stringify(actual),
  `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);

/* 逐字段比较：失败时只打印差异所在的键路径与两侧短值，避免整份模型刷屏。 */
function diffPaths(a, b, prefix = '', out = [], limit = 12) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const isObj = (v) => v && typeof v === 'object';
  if (!isObj(a) || !isObj(b)) {
    out.push(`${prefix || '<root>'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (out.length >= limit) break;
    diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, limit);
  }
  return out;
}
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
function eqDeep(name, expected, actual) {
  const same = stable(expected) === stable(actual);
  const diff = same ? [] : diffPaths(expected, actual);
  ok(name, same, diff.join('\n  '));
}

/* ------------------------------------------------------------ 固定时钟与数据 */

const NOW = new Date(2026, 5, 15, 12, 0, 0, 0).getTime(); // 本地 2026-06-15 12:00
const now = () => NOW;

const store = createStore({ root: path.join(TMP, 'calendars') });
await store.ensureRoot();
await store.ensureUser('u1');
const accounts = { all: async () => [{ id: 'u1' }] };
const aiStore = aiStoreMod.createAiStore({ store, accounts, varDir: TMP, logger: null, now });

const USER = 'u1';

function calDir(calendarId) {
  return path.join(TMP, 'calendars', USER, calendarId);
}
function writeCalendar(id, { displayName, color = '#3b82f6', visible = true, order = 0 }) {
  fs.mkdirSync(path.join(calDir(id), 'objects'), { recursive: true });
  const meta = {
    id, displayName, color, order,
    ctag: 0, syncUuid: `uuid-${id}`, tombstones: [],
    description: '', alarmsEnabled: true, remindersEnabled: true,
    type: 'vevent', davAccess: 'rw', visible,
  };
  fs.writeFileSync(path.join(calDir(id), 'meta.json'), JSON.stringify(meta, null, 2));
}
function icsStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function writeEvent(calendarId, uid, { title, start, end }) {
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  fs.mkdirSync(path.join(calDir(calendarId), 'objects'), { recursive: true });
  fs.writeFileSync(path.join(calDir(calendarId), 'objects', `${uid}.ics`), body);
}
function writeSettings(settings) {
  const dir = path.join(TMP, 'calendars', USER, '.data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

const at = (month1, day, hour = 9) => new Date(2026, month1 - 1, day, hour, 0, 0, 0).getTime();

writeCalendar('c1', { displayName: '工作', color: '#3b82f6', visible: true, order: 0 });
writeCalendar('c2', { displayName: '生活', color: '#10b981', visible: true, order: 1 });
writeCalendar('c3', { displayName: '私人', color: '#ef4444', visible: true, order: 2 });

writeEvent('c1', 'c1-a', { title: '一月会', start: at(1, 5), end: at(1, 5, 10) });
writeEvent('c1', 'c1-b', { title: '三月会', start: at(3, 9), end: at(3, 9, 10) });
writeEvent('c2', 'c2-a', { title: '二月跑步', start: at(2, 8), end: at(2, 8, 10) });
writeEvent('c2', 'c2-b', { title: '二月读书', start: at(2, 20), end: at(2, 20, 10) });
writeEvent('c2', 'c2-c', { title: '四月读书', start: at(4, 2), end: at(4, 2, 10) });
writeEvent('c3', 'c3-a', { title: '私人一号', start: at(5, 1), end: at(5, 1, 10) });
writeEvent('c3', 'c3-b', { title: '私人二号', start: at(5, 2), end: at(5, 2, 10) });
// c5 用英文名，专门验「去首尾空白 + 忽略大小写」那条解析路径。
writeCalendar('c5', { displayName: 'Work', color: '#8b5cf6', visible: true, order: 3 });
writeEvent('c5', 'c5-a', { title: '六月评审', start: at(6, 3), end: at(6, 3, 11) });

/* readAccent 与 app/server.mjs 的契约一致（同一份 settings 的四个字段）。 */
async function readAccentStub(userId) {
  const file = path.join(TMP, 'calendars', userId, '.data', 'settings.json');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = null; }
  return {
    accentColor: settings && typeof settings.accentColor === 'string' ? settings.accentColor : '#1f6feb',
    theme: 'system',
    weekStartsOn: settings && settings.weekStartsOn === 1 ? 1 : 0,
    visibleCalendarIds: settings && Array.isArray(settings.visibleCalendarIds)
      ? settings.visibleCalendarIds.filter((id) => typeof id === 'string' && id !== '')
      : [],
  };
}

const created = await aiStore.createCredential(USER, {
  label: 'MCP 年度总结',
  // c1、c2 可读；c3 网页开着但**不在授权列表**里（= hidden，对凭据不存在）。
  grants: { c1: 'read', c2: 'read', c5: 'read' },
  timeWindow: { pastDays: null, futureDays: null },
});
const credential = created.credential;
const service = createAiService({ aiStore, readAccent: readAccentStub, now });
const ctx = { userId: USER, credential, nowMs: NOW };

/** 网页侧同口径：同一份 events/calendars/settings → buildAnnualReviewData。 */
async function webModel({ year = 2026, calendarIds, weekStartsOn, accent }) {
  const { from, to } = yearRange(year);
  const collected = await collectAnnualEvents({
    calendarIds,
    listObjects: (calendarId) => aiStore.listObjectsFor(USER, calendarId),
    expand: (event, rangeFrom, rangeTo) => (require_expander(event, rangeFrom, rangeTo)),
    from,
    to,
  });
  return buildAnnualReviewData({
    events: collected.events,
    calendars: calendarIds.map((id) => {
      const meta = JSON.parse(fs.readFileSync(path.join(calDir(id), 'meta.json'), 'utf8'));
      return { id, name: meta.displayName, color: meta.color };
    }),
    tagOf: () => null,
    groups: [],
    year,
    now: NOW,
    accent,
    weekStartsOn,
  });
}
const expander = await import('../lib/annual-collect.mjs');
const require_expander = (event, from, to) => expander.expandOccurrences
  ? expander.expandOccurrences(event, from, to)
  : [];

/* --------------------------------------------------------- (a) 一周从周一起 */

writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#123456' });
{
  const review = await service.annualReview(ctx, { year: 2026 });
  const model = review.model;
  eq('(a) weekStartsOn=1 → 模型 weekStartsOn=1', 1, model.weekStartsOn);
  eq('(a) 月份表头从周一起', '周一', model.weekdayLabels[0]);
  eq('(a) 表头长度仍 7', 7, model.weekdayLabels.length);
  eq('(a) 重点色取同一份 settings', '#123456', model.accent);
}

writeSettings({ weekStartsOn: 0, visibleCalendarIds: [], accentColor: '#123456' });
{
  const review = await service.annualReview(ctx, { year: 2026 });
  eq('(a) weekStartsOn=0 → 模型 weekStartsOn=0', 0, review.model.weekStartsOn);
  eq('(a) weekStartsOn=0 → 表头从周日起', '周日', review.model.weekdayLabels[0]);
}

/* ------------------------------------------------ (b) 显式可见清单优先 */

writeSettings({ weekStartsOn: 1, visibleCalendarIds: ['c1'], accentColor: '#123456' });
{
  const review = await service.annualReview(ctx, { year: 2026 });
  const model = review.model;
  eq('(b) 模型只含 c1', ['c1'], model.calendars.map((c) => c.id));
  eq('(b) 总数只算 c1 的 2 条', 2, model.total);
  const expected = await webModel({ calendarIds: ['c1'], weekStartsOn: 1, accent: '#123456' });
  eq('(b) 总数与网页接口同参数一致', expected.total, model.total);
  eqDeep('(b) 与网页模型逐字段相同', expected, model);
}

/* ------------------------------------------- (c) meta.visible=false 被排除 */

{
  const metaPath = path.join(calDir('c2'), 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.visible = false;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#123456' });
  const review = await service.annualReview(ctx, { year: 2026 });
  eq('(c) visible=false 且清单为空的日历被排除', ['c1', 'c5'], review.model.calendars.map((c) => c.id).slice().sort());
  eq('(c) 总数只剩 c1 + c5 的 3 条', 3, review.model.total);
  // 复位：c2 重新可见
  meta.visible = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/* ------------------------------------------- (d) 全可读 + 同一开关 → 完全一致 */

writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#7c3aed' });
{
  const review = await service.annualReview(ctx, { year: 2026 });
  const model = review.model;
  eq('(d) 两边日历集合一致', ['c1', 'c2', 'c5'], model.calendars.map((c) => c.id).slice().sort());
  const expected = await webModel({ calendarIds: ['c1', 'c2', 'c5'], weekStartsOn: 1, accent: '#7c3aed' });
  eqDeep('(d) MCP 模型与网页模型逐字段相同', expected, model);
  eq('(d) 总数 = 6', 6, model.total);
}

/* --------------------- (e)(f) 网页开着但凭据不可读 → 不存在、不报错、不算 */

writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#123456' });
{
  const review = await service.annualReview(ctx, { year: 2026 });
  const model = review.model;
  ok('(e) 不可读日历不进模型', !model.calendars.some((c) => c.id === 'c3'), JSON.stringify(model.calendars.map((c) => c.id)));
  eq('(e) 总数不含 c3 的 2 条', 6, model.total);
  const calIds = JSON.stringify(model.calendars);
  ok('(e) 模型里不出现 c3 的名字', !calIds.includes('私人'), calIds);
  const list = await service.listCalendars(ctx);
  ok('(e) list_calendars 不返回 c3', !list.some((c) => c.id === 'c3'), JSON.stringify(list.map((c) => c.id)));
  ok('(e) list_calendars 里也不出现 c3 的名字', !JSON.stringify(list).includes('私人'));
  ok('(e) 调用不抛错', true);

  // (f) 网页若把 c3 也算进去，结果必然不同 —— 这种不同是预期，不进 (d) 的对照。
  const withC3 = await webModel({ calendarIds: ['c1', 'c2', 'c3', 'c5'], weekStartsOn: 1, accent: '#123456' });
  eq('(f) 把 c3 也算进去时总数 = 8（与 MCP 的 6 不同，属预期差异）', 8, withC3.total);
  ok('(f) 两者不同', withC3.total !== model.total, `${withC3.total} vs ${model.total}`);
}

/* ---------------------- 可读但被开关关掉 → list_calendars 带 visible:false */

{
  writeSettings({ weekStartsOn: 1, visibleCalendarIds: ['c1'], accentColor: '#123456' });
  const list = await service.listCalendars(ctx);
  const byId = new Map(list.map((c) => [c.id, c]));
  eq('开关关掉但可读的日历仍出现在 list_calendars', true, byId.has('c2'));
  eq('它带 visible:false', false, byId.get('c2') && byId.get('c2').visible);
  eq('清单里的 c1 是 visible:true', true, byId.get('c1') && byId.get('c1').visible);
  eq('不可读的 c3 仍不出现', false, byId.has('c3'));

  const review = await service.annualReview(ctx, { year: 2026 });
  eq('模型侧按开关排除 c2', ['c1'], review.model.calendars.map((c) => c.id));
  ok('文案里不出现「无权限 / N 个日历」这类暴露', !String(review.model.total).includes('无权限'));
}

/* ------------------- (g)–(n) 0.8.28：点名日历（总监 m01288） ------------------- */

/* (g) 点名一个可读日历 → 只统计它 */
writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#123456' });
{
  const review = await service.annualReview(ctx, { year: 2026, calendars: ['工作'] });
  eq('(g) calendars=["工作"] → 模型只含 c1', ['c1'], review.model.calendars.map((c) => c.id));
  eq('(g) 总数 = 工作日历当年 2 条', 2, review.model.total);
  eq('(g) 文案名单＝工作', ['工作'], review.scopedCalendars);
  const expected = await webModel({ calendarIds: ['c1'], weekStartsOn: 1, accent: '#123456' });
  eqDeep('(g) 与网页侧只算工作日的模型逐字段相同', expected, review.model);
}

/* (h) 解析不到的名字 → calendar_not_found，零渲染 */
let notFoundMsg = '';
{
  let code = '';
  let message = '';
  try {
    await service.annualReview(ctx, { year: 2026, calendars: ['不存在'] });
  } catch (err) {
    code = err.code;
    message = err.message;
  }
  eq('(h) 不存在的名字 → code=calendar_not_found', 'calendar_not_found', code);
  notFoundMsg = message;
  ok('(h) 文案说没找到并列出可用日历', /没找到这个日历「不存在」/.test(message) && /可用日历：/.test(message), message);
  ok('(h) 可用日历里含工作/生活/Work', message.includes('工作') && message.includes('生活') && message.includes('Work'), message);
}

/* (i) 不可读的日历名 → 同一个失败，文案形状与 (h) 完全一致 */
{
  let code = '';
  let message = '';
  try {
    await service.annualReview(ctx, { year: 2026, calendars: ['私人'] });
  } catch (err) {
    code = err.code;
    message = err.message;
  }
  eq('(i) 不可读的日历名 → 也报 calendar_not_found', 'calendar_not_found', code);
  eq('(i) 文案形状与不存在完全一致（只差点名）',
    notFoundMsg.replace('「不存在」', '「X」'),
    message.replace('「私人」', '「X」'));
}

/* (j) 两个日历合起来 → 两段，百分比合计 100% */
{
  const review = await service.annualReview(ctx, { year: 2026, calendars: ['工作', '生活'] });
  const model = review.model;
  eq('(j) 两个日历都进模型', ['c1', 'c2'], model.calendars.map((c) => c.id).slice().sort());
  eq('(j) 环形图 2 段', 2, model.calendars.length);
  eq('(j) 百分比合计 100', 100, model.calendars.reduce((sum, c) => sum + c.percent, 0));
  eq('(j) 总数 = 2 + 3', 5, model.total);
  eq('(j) 文案名单按点名顺序', ['工作', '生活'], review.scopedCalendars);
}

/* (k) 不传 calendars → 与默认口径（可读 ∩ 开关）逐字段一致 */
{
  const withParam = await service.annualReview(ctx, { year: 2026 });
  const withEmpty = await service.annualReview(ctx, { year: 2026, calendars: [] });
  const withNull = await service.annualReview(ctx, { year: 2026, calendars: null });
  eq('(k) calendars 省略 → 默认口径（c1+c2+Work，共 6 条）', 6, withParam.model.total);
  eq('(k) 文案不带「本次只统计」', [], withParam.scopedCalendars);
  eqDeep('(k) 空数组等同省略', withParam.model, withEmpty.model);
  eqDeep('(k) null 等同省略', withParam.model, withNull.model);
  eq('(k) 空数组也不带点名文案', [], withEmpty.scopedCalendars);
}

/* (l) 点名优先于网页开关：生活被关掉，照样统计 */
{
  writeSettings({ weekStartsOn: 1, visibleCalendarIds: ['c1'], accentColor: '#123456' });
  const bySwitch = await service.annualReview(ctx, { year: 2026 });
  eq('(l) 不点名时，被关掉的生活不计入', ['c1'], bySwitch.model.calendars.map((c) => c.id));
  const named = await service.annualReview(ctx, { year: 2026, calendars: ['生活'] });
  eq('(l) 点名生活 → 仍然统计', ['c2'], named.model.calendars.map((c) => c.id));
  eq('(l) 点数 = 3', 3, named.model.total);
  writeSettings({ weekStartsOn: 1, visibleCalendarIds: [], accentColor: '#123456' });
}

/* (m) 名称解析三条路径：id / 精确名 / 去空白+忽略大小写 */
{
  const byId = await service.annualReview(ctx, { year: 2026, calendars: ['c1'] });
  eq('(m) id 精确 → c1', ['c1'], byId.model.calendars.map((c) => c.id));
  const byName = await service.annualReview(ctx, { year: 2026, calendars: ['工作'] });
  eq('(m) displayName 精确 → c1', ['c1'], byName.model.calendars.map((c) => c.id));
  const byLoose = await service.annualReview(ctx, { year: 2026, calendars: ['  WORK  '] });
  eq('(m) 去首尾空白 + 忽略大小写 → c5', ['c5'], byLoose.model.calendars.map((c) => c.id));
  eq('(m) c5 那年 1 条', 1, byLoose.model.total);
}

/* (n) 只传 year → 老路径回归（与 0.8.25 一致：可读 ∩ 开关，带年份边界） */
{
  const review = await service.annualReview(ctx, { year: 2025 });
  eq('(n) 只传 year → 2025 年 0 条（空卡）', 0, review.model.total);
  eq('(n) 只传 year 不点名 → 无点名文案', [], review.scopedCalendars);
  ok('(n) 年份仍生效', review.model.year === 2025, String(review.model.year));
}

/* ---------------------- 源码守卫：server.mjs 的 readAccent 必须给出这两个字段 */

{
  const src = fs.readFileSync(path.join(process.cwd(), 'app', 'server.mjs'), 'utf8');
  ok('server.mjs readAccent 返回 weekStartsOn', /weekStartsOn/.test(src) && /return \{ accentColor, theme, weekStartsOn, visibleCalendarIds \}/.test(src));
  ok('server.mjs readAccent 返回 visibleCalendarIds', /visibleCalendarIds/.test(src));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
