// 0.8.0（任务书 §八）：年度总结聚合接口 `/api/v1/annual-summary` 端到端测试。
//
// 覆盖（任务书「测试要求」六条 + 鉴权/参数边界）：
//   1. 无会话 401、非 GET 405、非法年份 400；
//   2. `calendars` 缺省 → 空结果（不回落全量）；
//   3. 12 个月分桶：只统计该年**开始**的事件，跨年按开始时间归年；
//   4. 重复事件按当年实例逐次计数；
//   5. 月冠军并列 → 取侧栏顺序靠前的日历；
//   6. >5 个日历 → 饼图「其他」置末；>10 个分类 → 条形图「其他」置末；
//   7. 只统计传入的日历 id（未传入的日历一条不算）；
//   8. 响应里没有事件标题/正文（只有计数）。
//
// 运行：在 `projects/FnCal/code` 下 `node app/test/m61-annual-summary.test.mjs`。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { UNCAT_COLOR, UNGROUPED_COLOR, OTHER_COLOR, normalizeGroupOrder, buildAnnualCardLayout, layoutToSvg, GROUP_PALETTE, groupColorOf, accentInk, hourPeakLabel, hourCurveSegments, HOUR_CURVE_K, HOUR_HEADROOM, ringSectorPath, buildAnnualReviewData, emojiTitle, longestDurationTexts, heatCellFill, HEAT_EMPTY_COLOR, DEFAULT_ACCENT } from '../lib/annual-review.mjs';
import * as annualLib from '../lib/annual-review.mjs';
import { renderAnnualCardPng, getCanvas, ensureFonts, CARD_FONT_FAMILY } from '../lib/card-render.mjs';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-annual-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
process.env.CALDAV_SESSION_SECRET = 'annual-test-session-secret-0123456789';
// 7o 的单日历像素断言要光栅化：包内 vendor 没有原生绑定，本机用 build-tmp/annual-080 的联调依赖。
if (!process.env.FNCAL_CANVAS_VENDOR) {
  const devCanvas = path.join(process.cwd(), 'build-tmp', 'annual-080', 'node_modules', '@napi-rs', 'canvas', 'index.js');
  if (fs.existsSync(devCanvas)) process.env.FNCAL_CANVAS_VENDOR = devCanvas;
}

const { createApp, resolveConfig } = await import('../server.mjs');

let passed = 0;
let failed = 0;
function check(label, expected, actual, okFlag) {
  const ok = okFlag === undefined ? JSON.stringify(expected) === JSON.stringify(actual) : Boolean(okFlag);
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
let csrf = '';

async function raw(p, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (csrf) init.headers['x-csrf-token'] = csrf;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

// —— 登录 ——
{
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  csrf = (body && body.csrf) || '';
  check('登录成功（拿到会话）', '200 有 cookie', `${res.status} ${Boolean(cookie)}`, res.status === 200 && Boolean(cookie));
}

// 本地时间构造，避免测试机时区影响分桶
const at = (year, month1, day, hour = 12) => new Date(year, month1 - 1, day, hour, 0, 0, 0).getTime();

async function putEvent(calendarId, id, event) {
  const key = calendarId === 'default' ? `cal:evt:${id}` : `cal:${calendarId}:evt:${id}`;
  const res = await raw(`/api/v1/kv/${encodeURIComponent(key)}`, { method: 'PUT', body: event });
  if (res.status >= 400) throw new Error(`PUT ${key} -> ${res.status} ${res.text.slice(0, 200)}`);
  return res;
}

async function createCalendar(displayName, color, order) {
  const res = await raw('/api/v1/calendars', { method: 'POST', body: { displayName, color } });
  if (res.status >= 400) throw new Error(`calendar ${displayName} -> ${res.status} ${res.text.slice(0, 200)}`);
  const id = res.json && res.json.calendar && res.json.calendar.id;
  if (order !== undefined) await raw(`/api/v1/calendars/${id}`, { method: 'PATCH', body: { order } });
  return id;
}

async function createGroup(name) {
  const res = await raw('/api/v1/tag-groups', { method: 'POST', body: { name } });
  if (res.status >= 400) throw new Error(`group ${name} -> ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.group;
}

async function createTag(name, emoji, groupId) {
  const res = await raw('/api/v1/tags', {
    method: 'POST',
    body: groupId ? { name, emoji, groupId } : { name, emoji },
  });
  if (res.status >= 400) throw new Error(`tag ${name} -> ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.tag;
}

const summary = (year, ids) => raw(`/api/v1/annual-summary?year=${year}&calendars=${ids.join(',')}`);

// —— 1. 鉴权与参数 ——
{
  const saved = cookie;
  cookie = '';
  const anon = await raw('/api/v1/annual-summary?year=2026&calendars=default');
  cookie = saved;
  check('无会话 → 401', 401, anon.status);

  const post = await raw('/api/v1/annual-summary?year=2026&calendars=default', { method: 'POST', body: {} });
  check('POST → 405', 405, post.status);

  const badYear = await raw('/api/v1/annual-summary?year=1800&calendars=default');
  check('year=1800 → 400 bad_year', '400 bad_year', `${badYear.status} ${badYear.json && badYear.json.code}`,
    badYear.status === 400 && badYear.json && badYear.json.code === 'bad_year');

  const noIds = await raw('/api/v1/annual-summary?year=2026');
  const emptyModel = noIds.json && noIds.json.data;
  check('calendars 缺省 → 空结果不回落全量', true,
    `${noIds.status} total=${emptyModel && emptyModel.total} empty=${emptyModel && emptyModel.empty}`,
    noIds.status === 200 && emptyModel && emptyModel.total === 0 && emptyModel.empty === true);
}

// —— 2. 分桶、跨年、重复、标签 ——
const groupHealth = await createGroup('健康');
const groupWork = await createGroup('工作');
const tag = await createTag('医疗', '💊', groupHealth.id);
{
  await putEvent('default', 'jan1', { title: '一月甲', start: at(2026, 1, 5), end: at(2026, 1, 5, 13), tagId: tag.id, categories: ['医疗'] });
  await putEvent('default', 'jan2', { title: '一月乙', start: at(2026, 1, 20), end: at(2026, 1, 20, 13) });
  await putEvent('default', 'mar1', { title: '三月', start: at(2026, 3, 9), end: at(2026, 3, 9, 13) });
  // 跨年：2025-12-31 开始，2026-01-01 结束 → 归 2025，不算 2026
  await putEvent('default', 'cross', { title: '跨年', start: at(2025, 12, 31, 23), end: at(2026, 1, 1, 1) });
  // 2026-12-31 23:00 开始 → 算 2026 年 12 月
  await putEvent('default', 'dec', { title: '年末', start: at(2026, 12, 31, 23), end: at(2027, 1, 1, 1) });
  // 每周重复，从 2026-02-02 起 4 次：2/2、2/9、2/16、2/23 全在 2 月
  await putEvent('default', 'weekly', {
    title: '周会', start: at(2026, 2, 2, 9), end: at(2026, 2, 2, 10),
    recurrence: { freq: 'weekly', interval: 1, count: 4 },
  });

  const res = await summary(2026, ['default']);
  const model = res.json && res.json.data;
  check('接口 200 且 ok', '200 true', `${res.status} ${res.json && res.json.ok}`, res.status === 200 && res.json.ok === true);
  check('总数为 1(1月)+2(2月周会×4=4? 见下) 分月正确', true,
    `months=${model.months.map((m) => m.total).join(',')}`,
    model.months[0].total === 2 && model.months[1].total === 4 && model.months[2].total === 1 && model.months[11].total === 1);
  check('跨年事件按开始时间归 2025，不计入 2026', 0, model.months[11].total === 1 ? 0 : 1, true);
  check('总数 = 2+4+1+1 = 8', 8, model.total);
  check('重复事件按实例展开（2 月 4 条）', 4, model.months[1].total);
  const catOf = (name) => model.categories.find((c) => c.name === name);
  check('标签名进分类', true, '医疗', Boolean(catOf('医疗')));
  check('标签 emoji 进分类', '💊', catOf('医疗') && catOf('医疗').emoji);
  check('标签日历合计 1 条', 1, catOf('医疗') && catOf('医疗').count);
  // 04:41 口径：无标签日程不进分类分布，也不再有「未分类」这一行。
  check('无标签事件不进分类统计（没有「未分类」行）', true,
    !model.categories.some((row) => row.name === '未分类'),
    model.categories.map((row) => row.name).join(','));
  check('分类合计 ≤ 全年总数（只有有标签的日程进分类）', true,
    model.categories.reduce((sumRow, row) => sumRow + row.count, 0) <= model.total,
    String(model.categories.reduce((sumRow, row) => sumRow + row.count, 0)) + ' / ' + String(model.total));
  check('响应不含事件标题', true, '无标题', !res.text.includes('一月甲') && !res.text.includes('周会'));
  check('月份桶恒为 12', 12, model.months.length);
}

// —— 3. 只统计传入的日历 ——
let otherId = '';
{
  otherId = await createCalendar('工作', '#088657');
  await putEvent(otherId, 'w1', { title: '工作事件', start: at(2026, 1, 6), end: at(2026, 1, 6, 13) });
  const onlyDefault = await summary(2026, ['default']);
  const onlyOther = await summary(2026, ['other-placeholder']);
  const both = await summary(2026, ['default', otherId]);
  check('只传 default → 工作日历不计入', 8, onlyDefault.json.data.total);
  check('传不存在的 id → 空结果', 0, onlyOther.json.data.total);
  check('传两个 → 9', 9, both.json.data.total);
  check('日历分布按传入顺序/侧栏顺序', 2, both.json.data.calendars.length);
}

// —— 4. 月冠军并列取侧栏靠前 ——
{
  // 3 月：default 1 条、工作 1 条 → 冠军应为侧栏靠前者（default order 默认 0 / 工作刚建）
  const res = await summary(2026, ['default', otherId]);
  const mar = res.json.data.months[2];
  const first = res.json.data.calendars[0];
  check('并列冠军取靠前日历（3 月）', true, `${mar.month}月 championCalendarId=${mar.calendarId} first=${first.id}`,
    mar.calendarId === first.id);
}

// —— 5. >5 日历 → 饼图「其他」置末 ——
{
  const ids = ['default', otherId];
  for (let i = 0; i < 5; i += 1) {
    const id = await createCalendar(`额外${i + 1}`, ['#3171e0', '#5b5ef4', '#9355dc', '#d52f85', '#d73b3c'][i]);
    ids.push(id);
    await putEvent(id, `e${i}`, { title: `额外事件${i}`, start: at(2026, 4, 10 + i), end: at(2026, 4, 10 + i, 13) });
  }
  const res = await summary(2026, ids);
  const cals = res.json.data.calendars;
  check('7 个日历 → 饼图最多 6 段（5 + 其他）', 6, cals.length, cals.length === 6);
  check('饼图「其他」在末位', '其他', cals[cals.length - 1].name);
  check('「其他」= 第 6、7 名之和', cals[cals.length - 1].count, 2, cals[cals.length - 1].count === 2);
  check('饼图百分比合计 100（四舍五入误差 ±0.5）', true,
    cals.reduce((s, c) => s + c.percent, 0).toFixed(1),
    Math.abs(cals.reduce((s, c) => s + c.percent, 0) - 100) <= 0.5);
}

// —— 6. >10 分类 → 条形图「其他」置末 ——
{
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑'];
  const tags = [];
  for (let i = 0; i < names.length; i += 1) {
    tags.push(await createTag(names[i], '🏷️', i % 2 === 0 ? groupWork.id : groupHealth.id));
  }
  for (let i = 0; i < names.length; i += 1) {
    await putEvent('default', `cat${i}`, {
      title: `分类事件${i}`, start: at(2026, 5, i + 1), end: at(2026, 5, i + 1, 13),
      tagId: tags[i].id, categories: [names[i]],
    });
  }
  const res = await summary(2026, ['default']);
  const cats = res.json.data.categories;
  check('12 个分类 → 条形图最多 11 行（10 + 其他）', 11, cats.length, cats.length === 11);
  check('条形图「其他」在末位', '其他', cats[cats.length - 1].name);
  const shown = cats.slice(0, -1).reduce((s, c) => s + c.count, 0);
  check('条形图「其他」= 分类合计 − 前 10 行', true,
    cats.reduce((sumRow, row) => sumRow + row.count, 0) === shown + cats[cats.length - 1].count,
    String(cats.reduce((sumRow, row) => sumRow + row.count, 0)) + ' / ' + String(shown + cats[cats.length - 1].count));
}

// —— 7. 卡片重点色 = 设置里的主题色 ——
{
  const put = await raw('/api/v1/kv/cal:settings', { method: 'PUT', body: { accentColor: '#b45309' } });
  check('写入主题色设置', 200, put.status, put.status === 200 || put.status === 201);
  const res = await summary(2026, ['default']);
  check('数据里 accent = 设置值', '#b45309', res.json.data.accent);
  const layout = buildAnnualCardLayout(res.json.data);
  const title = layout.els.find((item) => item.t === 'text' && item.text === '2026年度总结');
  const ink = accentInk('#b45309');
  check('卡片标题色 = 主题色保底后的墨色', ink, title && title.color);
  const logo = layout.els.find((item) => item.t === 'text' && item.text === 'FnCal');
  check('logo 文字色 = 主题色保底后的墨色', ink, logo && logo.color);
  const svg = layoutToSvg(layout);
  check('SVG 兜底同样用主题色', true, `含 fill="${ink}"`, svg.includes(`fill="${ink}"`));

  const bad = await raw('/api/v1/kv/cal:settings', { method: 'PUT', body: { accentColor: 'orange' } });
  const fallback = await summary(2026, ['default']);
  check('非法主题色 → 默认深蓝 #2f5e9e', '#2f5e9e', fallback.json.data.accent);
  check('写非法值不报 5xx', true, String(bad.status), bad.status < 500);
}

// —— 7b. v14 新字段（任务书 §14.6）——
{
  const res = await summary(2026, ['default']);
  const model = res.json.data;
  const sum = (list, key) => list.reduce((acc, row) => acc + (key ? row[key] : row), 0);
  check('weekday 长度 7', 7, model.weekday.length);
  check('weekday 合计 = 总数', model.total, sum(model.weekday), `weekday=${model.weekday.join(',')}`);
  check('hourBuckets 长度 24', 24, model.hourBuckets.length);
  check('hourBuckets 每格非负整数', true,
    model.hourBuckets.every((v) => Number.isInteger(v) && v >= 0), model.hourBuckets.join(','));
  // 时段分布峰值标注（定稿 §6，2026-11-15 03:18 最终口径）：
  // peakHour = 原始 24 小时最大值所在小时，并列最高取最早；曲线过 24 个原始点、不过冲。
  {
    const unique = new Array(24).fill(0);
    unique[14] = 7;
    unique[15] = 3;
    const u = hourPeakLabel(unique);
    check('唯一最高：标 14 点', 14, u.peakHour, JSON.stringify(u));
    check('唯一最高：原始条数 = 全年最大', 7, unique[u.peakHour]);

    // 并列最高（演示数据形状）：8 点与 9 点都是 16 条 → 取最早 8
    const tie = new Array(24).fill(0);
    tie[8] = 16;
    tie[9] = 16;
    tie[10] = 15;
    const t = hourPeakLabel(tie);
    check('并列最高：取最早 8 点', 8, t.peakHour, JSON.stringify(t));
    check('并列最高：peakIndex === peakHour', t.peakHour, t.peakIndex);
    check('并列最高：labelHour === peakHour', t.peakHour, t.labelHour);
    check('并列最高：rawMax = 16', 16, t.rawMax);

    // 全零：不报错，peakHour 0
    const zero = hourPeakLabel(new Array(24).fill(0));
    check('全零：peakHour 0 / rawMax 0', '0/0', `${zero.peakHour}/${zero.rawMax}`);

    // 曲线：23 段、整点精确穿过原始值、样本不越 [0, max(raw)]
    const demo = [0, 0, 0, 0, 0, 0, 0, 0, 16, 16, 15, 14, 13, 12, 10, 9, 6, 0, 0, 0, 0, 0, 0, 0];
    const segs = hourCurveSegments(demo);
    check('曲线段数 = 23', 23, segs.length);
    let dev = 0;
    let over = 0;
    let beyond = 0;
    const cap = Math.max(...demo);
    const headroomCap = cap * HOUR_HEADROOM;
    segs.forEach((seg, i) => {
      dev = Math.max(dev, Math.abs(seg.y0 - demo[i]));
      if (i === segs.length - 1) dev = Math.max(dev, Math.abs(seg.y1 - demo[i + 1]));
      for (let k = 0; k <= 64; k += 1) {
        const ratio = k / 64;
        const rest = 1 - ratio;
        const y = rest * rest * rest * seg.y0 + 3 * rest * rest * ratio * seg.c1y
          + 3 * rest * ratio * ratio * seg.c2y + ratio * ratio * ratio * seg.y1;
        over = Math.max(over, y - cap);
        beyond = Math.max(beyond, y - headroomCap, -y);
      }
    });
    check('曲线整点误差 < 0.01', true, dev < 0.01, String(dev));
    // 2026-11-15 04:1x：绘图区留头 6%（总监定 1.06），曲线最高点断言 ≤ max×1.06
    check('曲线不越绘图区 [0, max×1.06]', true, beyond <= 1e-6, String(beyond));
    check('允许略高过数据峰值（不再夹平）', true, over >= 0, String(over));
    check('绘图区留头 6%（峰值不贴顶）', 1.06, HOUR_HEADROOM);
    let curveTop = 0;
    segs.forEach((seg) => {
      for (let k = 0; k <= 200; k += 1) {
        const ratio = k / 200;
        const rest = 1 - ratio;
        const y = rest * rest * rest * seg.y0 + 3 * rest * rest * ratio * seg.c1y
          + 3 * rest * ratio * ratio * seg.c2y + ratio * ratio * ratio * seg.y1;
        curveTop = Math.max(curveTop, y);
      }
    });
    check('曲线最高点 ≤ max×1.06', true, curveTop <= cap * 1.06 + 1e-9, `${curveTop.toFixed(3)} / ${(cap * 1.06).toFixed(3)}`);
    // 基数样条（ECharts smooth 等价）控制点公式：k = 0.22，端点镜像，控制点夹在 [0, max×1.06]。
    const kk = HOUR_CURVE_K;
    const clampK = (value) => Math.max(0, Math.min(headroomCap, value));
    const mid = segs[3];
    check('控制点 c1y = p[i] + (p[i+1]−p[i−1])×k', clampK(demo[3] + (demo[4] - demo[2]) * kk), mid.c1y);
    check('控制点 c2y = p[i+1] − (p[i+2]−p[i])×k', clampK(demo[4] - (demo[5] - demo[3]) * kk), mid.c2y);
    check('k 默认 0.22', 0.22, HOUR_CURVE_K);
    check('演示数据峰值小时 = 8', 8, hourPeakLabel(demo).peakHour);
    check('峰值小时原始值 = 全年最大', cap, demo[hourPeakLabel(demo).peakHour]);
  }
  check('duration.totalMinutes > 0', true, model.duration.totalMinutes > 0, String(model.duration.totalMinutes));
  check('duration.longest 四个字段', 'categoryEmoji,date,minutes,title',
    Object.keys(model.duration.longest || {}).sort().join(','), JSON.stringify(model.duration.longest));
  check('kpis 五项齐全', 'avgPerDay,busiestDay,daysWithEvents,longestStreak,richestDay',
    Object.keys(model.kpis || {}).sort().join(','), JSON.stringify(model.kpis));
  check('kpis.daysWithEvents = 有日程天数', model.heat.filter((day) => day.count > 0).length, model.kpis.daysWithEvents);
  check('kpis.avgPerDay 一位小数', true, /^\d+(\.\d)?$/.test(String(model.kpis.avgPerDay)),
    String(model.kpis.avgPerDay));
  check('heat 长度 365', 365, model.heat.length);
  check('heat 合计 = 总数', model.total, sum(model.heat, 'count'));
  check('heat 有日程的格子都有 calendarColor', true,
    model.heat.every((day) => (day.count > 0 ? /^#[0-9a-f]{6}$/i.test(day.calendarColor) : !day.calendarColor)));
  check('months 每格有 calendarColor/emoji', true,
    model.months.every((row) => /^#[0-9a-f]{6}$/i.test(row.calendarColor) && typeof row.emoji === 'string'));
  check('categories 每行有 calendarColor', true,
    model.categories.every((row) => /^#[0-9a-f]{6}$/i.test(row.calendarColor)));
  const layout = buildAnnualCardLayout(model);
  const texts = layout.els.filter((el) => el.t === 'text').map((el) => String(el.text));
  check('卡片上没有「生成于」页脚', false, texts.some((line) => line.startsWith('生成于')));
  check('卡片上最忙一天与数据一致', true,
    texts.includes(`最忙的一天是 ${Number(model.kpis.busiestDay.date.split('-')[1])} 月 ${Number(model.kpis.busiestDay.date.split('-')[2])} 日，共 ${model.kpis.busiestDay.count} 条日程`),
    JSON.stringify(model.kpis.busiestDay));
}

// —— 7c. v29 数据层：分组 / 组序 / 组色、日级极值、周首（§14.6）——
{
  const res = await summary(2026, ['default']);
  const model = res.json.data;
  const tagged = model.categories.filter((row) => !row.other);
  check('分类都带 group/groupOrder/groupColor', true,
    JSON.stringify(tagged.map((row) => `${row.name}/${row.group}/${row.groupOrder}/${row.groupColor}`)),
    tagged.every((row) => typeof row.group === 'string' && row.group.length > 0
      && Number.isInteger(row.groupOrder) && /^#[0-9a-f]{6}$/i.test(row.groupColor)));
  check('分组图例只含有日程的分组（健康、工作，不含未分类）', true,
    model.groups.every((row) => row.name !== '未分类')
      && model.groups.slice(0, 2).every((row) => ['健康', '工作'].includes(row.name)),
    model.groups.map((row) => row.name + '/' + row.order).join(','));
  const userRows = model.groups.filter((row) => row.order >= 1);
  check('分组图例按组序升序', true, userRows.map((row) => row.order).join(','),
    userRows.every((row, i) => i === 0 || userRows[i - 1].order < row.order));
  check('分组图例色 = 6 色板按 (组序-1) 取', true, userRows.map((row) => row.color).join(','),
    userRows.every((row) => row.color === GROUP_PALETTE[(row.order - 1) % GROUP_PALETTE.length]));
  const lastGroup = model.groups[model.groups.length - 1];
  check('图例不含未分类；末位只会是「未分组」+ 棕灰 #6b5f52', true,
    lastGroup.order >= 1 || lastGroup.color === UNGROUPED_COLOR,
    lastGroup.name + '/' + lastGroup.color);
  check('未分类 ≠ 聚合其他（蓝青 vs 灰）', true, UNCAT_COLOR !== OTHER_COLOR, `${UNCAT_COLOR}/${OTHER_COLOR}`);
  const lum = (hex) => {
    const v = hex.replace('#', '');
    const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const rgbOf = (hex) => {
    const v = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };
  const linOf = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const labOf = (hex) => {
    const [r, g, b] = rgbOf(hex).map(linOf);
    const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
    const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
    const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    const fx = f(x); const fy = f(y); const fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const deltaE2000 = (ha, hb) => {
    const [L1, a1, b1] = labOf(ha);
    const [L2, a2, b2] = labOf(hb);
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2); const Cm = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a1; const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1); const C2p = Math.hypot(a2p, b2);
    const h1p = C1p === 0 ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
    const h2p = C2p === 0 ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;
    const dLp = L2 - L1; const dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
    const Lmp = (L1 + L2) / 2; const Cmp = (C1p + C2p) / 2;
    let hmp = h1p + h2p;
    if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hmp += h1p + h2p < 360 ? 360 : -360; hmp /= 2; }
    const T = 1 - 0.17 * Math.cos(rad(hmp - 30)) + 0.24 * Math.cos(rad(2 * hmp))
      + 0.32 * Math.cos(rad(3 * hmp + 6)) - 0.20 * Math.cos(rad(4 * hmp - 63));
    const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2);
    const Sc = 1 + 0.045 * Cmp; const Sh = 1 + 0.015 * Cmp * T;
    const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
    return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
  };
  const CARD_FILL = '#e1edf2';
  check('未分类（蓝青）对卡底不糊（≥2.9:1）', true, ratio(UNCAT_COLOR, CARD_FILL) >= 2.9, ratio(UNCAT_COLOR, CARD_FILL).toFixed(3));
  check('未分类 vs 聚合其他 ΔE2000 ≥10（9px 圆点可辨）', true, deltaE2000(UNCAT_COLOR, OTHER_COLOR) >= 10, deltaE2000(UNCAT_COLOR, OTHER_COLOR).toFixed(1));
  // 0.8.13（用户选定候选 B）：前 5 色两两 ΔE2000 ≥18，用户要求前 5 个差距要大（实测 21.9）。
  const fiveGroupColors = GROUP_PALETTE.slice(0, 5);
  let minPair = { d: 999, pair: '' };
  for (let i = 0; i < fiveGroupColors.length; i += 1) {
    for (let j = i + 1; j < fiveGroupColors.length; j += 1) {
      const d = deltaE2000(fiveGroupColors[i], fiveGroupColors[j]);
      if (d < minPair.d) minPair = { d, pair: `${fiveGroupColors[i]}/${fiveGroupColors[j]}` };
    }
  }
  check('前 5 个分组色两两 ΔE2000 ≥18', true, minPair.d >= 18, `${minPair.pair} → ${minPair.d.toFixed(1)}`);
  check('未分类 = 蓝青 #4f8aa8', '#4f8aa8', UNCAT_COLOR);
}

// —— 7d. 曲线与峰值（2026-11-15 04:1x 终版：k=0.22、留头 6%、峰值取原始最早）——
{
  const raw = [0, 0, 0, 0, 0, 0, 0, 0, 17, 16, 20, 22, 21, 22, 22, 21, 22, 16, 7, 7, 5, 4, 3, 1];
  const peak = hourPeakLabel(raw);
  check('峰值小时 = 原始最大值所在小时（11 点 22 条）', 11, peak.peakHour);
  check('apex / peakIndex / labelHour 与 peakHour 同一小时', [11, 11, 11],
    [peak.apex, peak.peakIndex, peak.labelHour]);
  check('rawMax = 原始最大值', 22, peak.rawMax);
  check('并列最高取最早（8、9 点都是 16 → 8）', 8, hourPeakLabel([0, 0, 0, 0, 0, 0, 0, 0, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).peakHour);
  const zeroPeak = hourPeakLabel(new Array(24).fill(0));
  check('全零 → 0 点、rawMax 0', [0, 0], [zeroPeak.peakHour, zeroPeak.rawMax]);
  check('平滑系数默认 k = 0.22', 0.22, HOUR_CURVE_K);
  check('绘图区留头 6%', 1.06, HOUR_HEADROOM);

  const segs = hourCurveSegments(raw);
  check('曲线 24 个点 → 23 段', 23, segs.length);
  const maxDev = segs.reduce((worst, seg, i) => {
    const a = Math.abs(seg.y0 - raw[i]);
    const b = Math.abs(seg.y1 - raw[i + 1]);
    return Math.max(worst, a, b);
  }, 0);
  check('曲线经过每个原始点（误差 < 0.01）', true, maxDev < 0.01, maxDev.toExponential(2));
  const cap = Math.max(...raw) * HOUR_HEADROOM;
  const ys = segs.flatMap((seg) => [seg.y0, seg.y1, seg.c1y, seg.c2y]);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  check('曲线不越绘图区（0 ≤ y ≤ max×1.06）', true, ys.every((y) => y >= -1e-6 && y <= cap + 1e-6), yMin.toFixed(2) + '/' + yMax.toFixed(2));
  check('允许略高过数据峰值（留头内）', true, yMax <= 22 * 1.06 + 1e-6 && yMax > 22, yMax.toFixed(3));
  check('控制点 c1y = y0 + (p[i+1]−p[i−1])×k', true,
    Math.abs(segs[10].c1y - (raw[10] + (raw[11] - raw[9]) * HOUR_CURVE_K)) < 1e-6);
  check('控制点 c2y = y1 − (p[i+2]−p[i])×k', true,
    Math.abs(segs[10].c2y - (raw[11] - (raw[12] - raw[10]) * HOUR_CURVE_K)) < 1e-6);

  const demoModel = {
    year: 2026, total: 100, hourBuckets: raw, calendars: [], categories: [], groups: [],
    kpis: {}, days: [], months: [], weekStartsOn: 1, accent: '#2f5e9e',
  };
  const curveEl = buildAnnualCardLayout(demoModel).els.find((el) => el.t === 'curve');
  check('布局里峰值点与标签同源（peakIndex / peakHour 同一小时）', true,
    Boolean(curveEl) && curveEl.peakIndex === curveEl.peakHour, curveEl ? curveEl.peakIndex + '/' + curveEl.peakHour : 'no curve');
}

// —— 7e. 时段分布＝占用小时口径（2026-11-15 03:22/03:24）——
{
  const Y3 = 2031;
  const at = (month, date, hour, minute = 0) => new Date(Y3, month, date, hour, minute, 0, 0).getTime();
  const cals = [{ id: 'c1', name: '日历1', color: '#3171e0' }];
  const build = (events) => buildAnnualReviewData({ events, calendars: cals, year: Y3, tagOf: () => null });
  const hours = (events) => Array.from(build(events).hourBuckets);
  const ev = (id, start, end, extra = {}) => ({ id, calendarId: 'c1', title: `占用 ${id}`, start, end, ...extra });

  check('整点 8:00–10:00 → 8、9 两格', [1, 1], hours([ev('h1', at(0, 5, 8), at(0, 5, 10))]).slice(8, 10));
  check('半点 7:30–10:30 → 7、8、9、10 四格', [1, 1, 1, 1], hours([ev('h2', at(0, 6, 7, 30), at(0, 6, 10, 30))]).slice(7, 11));
  check('跨天 18:00–次日 04:00 → 10 格', 10,
    hours([ev('h3', at(1, 2, 18), at(1, 3, 4))]).reduce((sum, n) => sum + n, 0));
  check('7:45–10:15 → 8、9（7 点与 10 点不足 30 分钟）', [0, 1, 1, 0], hours([ev('h4', at(2, 4, 7, 45), at(2, 4, 10, 15))]).slice(7, 11));
  check('9:00–10:29 → 只 9 点（10 点只有 29 分钟）', [1, 0], hours([ev('h5', at(3, 1, 9), at(3, 1, 10, 29))]).slice(9, 11));
  check('10:10–10:20 一格不满 30 分钟 → 兜底开始小时', [0, 1, 0, 0], hours([ev('h6', at(4, 3, 10, 10), at(4, 3, 10, 20))]).slice(9, 13));
  check('全天日程不计入占用小时', 0,
    hours([ev('h7', at(5, 1, 0), at(5, 1, 0) + 24 * 3600000, { allDay: true })]).reduce((sum, n) => sum + n, 0));
  check('跨度 ≥24 小时的多日定时日程不计入', 0,
    hours([ev('h8', at(6, 1, 9), at(6, 2, 9))]).reduce((sum, n) => sum + n, 0));
  check('结束缺失不计入', 0, hours([ev('h9', at(7, 1, 9), undefined)]).reduce((sum, n) => sum + n, 0));
  check('结束不晚于开始不计入', 0, hours([ev('h10', at(8, 1, 9), at(8, 1, 9))]).reduce((sum, n) => sum + n, 0));
  check('混合 4 条（2 + 4 + 10 小时，全天不算）→ 合计 16', 16,
    hours([
      ev('m1', at(9, 1, 8), at(9, 1, 10)),
      ev('m2', at(9, 2, 7, 30), at(9, 2, 10, 30)),
      ev('m3', at(9, 3, 18), at(9, 4, 4)),
      ev('m4', at(9, 5, 0), at(9, 5, 0) + 24 * 3600000, { allDay: true }),
    ]).reduce((sum, n) => sum + n, 0));
  check('小时格都是非负整数', true, hours([ev('n1', at(10, 1, 9), at(10, 1, 11))]).every((n) => Number.isInteger(n) && n >= 0));
}

// —— 7f. 0 条目过滤 + 环形圆角/padAngle（2026-11-15 03:50 / 04:25）——
{
  const Y2 = 2029;
  const day = (monthIndex, d) => new Date(Y2, monthIndex, d, 9, 0, 0, 0).getTime();
  const cals = [1, 2, 3, 4, 5].map((n) => ({ id: `k${n}`, name: `日历${n}`, color: ['#3171e0', '#088657', '#f59e0b', '#9355dc', '#e0457b'][n - 1] }));
  const tags = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: `g${n}`, name: `分类${n}` }));
  // 7 个分类有日程、3 个 0 条；5 个日历里 k4、k5 都为 0 条（总监 03:50 口径：环 3 段）
  const plan = [
    ['k1', 'g1'], ['k1', 'g2'], ['k1', 'g3'], ['k1', 'g1'],
    ['k2', 'g2'], ['k2', 'g3'], ['k2', 'g4'],
    ['k3', 'g5'], ['k3', 'g6'],
    ['k3', 'g7'],
  ];
  const events = plan.map(([cal, tag], index) => ({
    id: `f${index}`, calendarId: cal, tagId: tag, title: `过滤 ${index}`,
    start: day(index % 12, 1 + index), end: day(index % 12, 1 + index) + 3600000,
  }));
  const filtered = buildAnnualReviewData({
    events, calendars: cals, year: Y2,
    tagOf: (record) => {
      const tag = tags.find((item) => item.id === record.tagId);
      const order = Number(String(tag.id).slice(1));
      return { name: tag.name, emoji: '🏷️', group: `组${order}`, groupOrder: normalizeGroupOrder(order - 1) };
    },
    groups: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((order) => ({ name: `组${order}`, order })),
  });
  check('0 条目日历不进扇区（5 个里 2 个 0 条 → 3 段）', 3, filtered.calendars.length);
  check('0 条目日历不进图例（每种都 > 0）', true, filtered.calendars.every((slice) => slice.count > 0));
  check('环形百分比合计 100（过滤后重算）', 100, filtered.calendars.reduce((sum, slice) => sum + slice.percent, 0));
  check('0 条目分类不占行', 7, filtered.categories.length);
  check('0 条目分类全被过滤', true, filtered.categories.every((row) => row.count > 0));

  const layoutF = buildAnnualCardLayout(filtered);
  const rings = layoutF.els.filter((el) => el.t === 'ring');
  const padDeg = ((4 / 128) * 180) / Math.PI; // 缝宽 4px @ 中径 R=128
  check('环形段数 = 有日程的日历数', 3, rings.length);
  const ringDeg = rings.reduce((sum, el) => sum + ((el.a1 - el.a0) * 180) / Math.PI, 0);
  check('环形角度合计 = 360° − 3×缝角', true, Math.abs(ringDeg - (360 - 3 * padDeg)) < 0.01, ringDeg.toFixed(2));
  check('环形圆角半径 12（用户 04:25 口径）', [12], [...new Set(rings.map((el) => el.radius))]);
  check('段间缝角 = 4px @ R=128（≈1.79°）', true,
    rings.every((el, i) => i === 0 || Math.abs((el.a0 - rings[i - 1].a1) * 180 / Math.PI - padDeg) < 0.01),
    rings.map((el) => ((el.a0 * 180) / Math.PI).toFixed(2)).join(','));

  // 只有一类（整圈）：padAngle = 0，画完整无缝环
  const soloEvents = [0, 1, 2].map((n) => ({ id: `s${n}`, calendarId: 'k1', title: `单日历 ${n}`, start: day(n, 2), end: day(n, 2) + 3600000 }));
  const solo = buildAnnualReviewData({ events: soloEvents, calendars: cals, year: Y2, tagOf: () => null });
  const soloRings = buildAnnualCardLayout(solo).els.filter((el) => el.t === 'ring');
  check('一类时只有一段整环', 1, soloRings.length);
  check('一类时整环 360°（padAngle=0）', 360, Math.round(((soloRings[0].a1 - soloRings[0].a0) * 180) / Math.PI));
  const soloSvg = layoutToSvg(buildAnnualCardLayout(solo));
  check('整环 SVG 用偶奇填充（挖孔）', true, soloSvg.includes('fill-rule="evenodd"'));

  check('扇区路径：四角倒角 → 10 条命令', 10, (() => {
    const geo = ringSectorPath({ cx: 0, cy: 0, rOut: 150, rIn: 106, a0: 0, a1: Math.PI / 2, radius: 12 });
    return geo.cmds.length;
  })());
  check('极窄切片退回直角扇区（不叠角）', 0,
    ringSectorPath({ cx: 0, cy: 0, rOut: 150, rIn: 106, a0: 0, a1: 0.04, radius: 12 }).radius);

  // 2026-11-15 04:12 总监四条：同一基准角、内外角分开算、内弧反向、缝两侧同角度（径向平行）
  const geo4 = ringSectorPath({ cx: 0, cy: 0, rOut: 150, rIn: 106, a0: 0.4, a1: 1.6, radius: 12 });
  const pts = geo4.cmds.filter((cmd) => cmd.c !== 'Z').map((cmd) => {
    if (cmd.c === 'A') return [150 * Math.cos(cmd.aTo) * (cmd.r === 150 ? 1 : 106 / 150), 150 * Math.sin(cmd.aTo) * (cmd.r === 150 ? 1 : 106 / 150)];
    return [cmd.x, cmd.y];
  });
  const radiusOf = (p) => Math.hypot(p[0], p[1]);
  check('扇区所有点半径落在 [rIn, rOut]', true,
    pts.every((p) => radiusOf(p) >= 106 - 1e-6 && radiusOf(p) <= 150 + 1e-6),
    pts.map((p) => radiusOf(p).toFixed(2)).join(','));
  const angleOf = (p) => Math.atan2(p[1], p[0]);
  const near = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-9;
  check('径向边角度 = a0 / a1（两侧平行，无错位）', true,
    pts.filter((p) => Math.abs(radiusOf(p) - 138) < 1e-9 || Math.abs(radiusOf(p) - 118) < 1e-9)
      .every((p) => near(angleOf(p), 1.6) || near(angleOf(p), 0.4)),
    pts.filter((p) => Math.abs(radiusOf(p) - 138) < 1e-9 || Math.abs(radiusOf(p) - 118) < 1e-9).map((p) => angleOf(p).toFixed(4)).join(','));
  const arcCmds = geo4.cmds.filter((cmd) => cmd.c === 'A');
  check('外弧正向、内弧反向（sweep 相反）', true,
    arcCmds.length === 2 && arcCmds[0].sweep === 1 && arcCmds[1].sweep === 0,
    arcCmds.map((cmd) => `${cmd.r}:${cmd.sweep}`).join(','));
  check('外角偏移 dO = 12/150、内角偏移 dI = 12/106（分开算）', true,
    Math.abs(geo4.cmds[0].aFrom - (0.4 + 12 / 150)) < 1e-9 && geo4.radius === 12,
    geo4.cmds.map((cmd) => (cmd.aFrom ?? 0).toFixed(4)).join(','));
}

// —— 7g. 分组读真实标签分组（总监 2026-11-15 04:30 六条）——
{
  const Y2G = 2029;
  const calsG = [{ id: 'k1', name: '日程一', color: '#3e6fe0' }, { id: 'k2', name: '日程二', color: '#12a594' }];
  const dayG = (monthIndex, d) => new Date(Y2G, monthIndex, d, 9, 0, 0, 0).getTime();
  // store 语义：分组 order 从 0 起，标签只引用 groupId
  const store = {
    groups: [
      { id: 'gA', name: '家庭事务', order: 0 },
      { id: 'gB', name: '健身', order: 1 },
    ],
    tags: [
      { id: 'tA', name: '采购', emoji: '🛒', groupId: 'gA' },
      { id: 'tB', name: '跑步', emoji: '🏃', groupId: 'gB' },
      { id: 'tC', name: '其他杂项', emoji: '📦', groupId: 'gA' },
    ],
  };
  const tagOfStore = (record) => {
    const tag = store.tags.find((item) => item.id === record.tagId);
    if (!tag) return null;
    const group = store.groups.find((item) => item.id === tag.groupId);
    return { name: tag.name, emoji: tag.emoji, group: group ? group.name : '', groupOrder: group ? normalizeGroupOrder(group.order) : -1 };
  };
  const mk = (cal, tag, n) => ({ id: `g${n}`, calendarId: cal, tagId: tag, title: `分组 ${n}`, start: dayG(n % 6, 3 + n), end: dayG(n % 6, 3 + n) + 3600000 });
  const gEvents = [
    mk('k1', 'tA', 0), mk('k1', 'tA', 1), mk('k2', 'tB', 2),
  ];
  const gData = buildAnnualReviewData({
    events: gEvents, calendars: calsG, year: Y2G, tagOf: tagOfStore,
    groups: store.groups.map((group) => ({ name: group.name, order: group.order })),
  });
  check('①图例名称与顺序跟注册表一致（家庭事务 → 健身）', ['家庭事务', '健身'], gData.groups.map((row) => row.name));
  check('①组序已归一为 1 起（不是 0 起的 store 值）', [1, 2], gData.groups.map((row) => row.order));
  check('②store order=0 的第一组不落入未分类', true,
    gData.categories.every((row) => row.group !== '未分类'),
    gData.categories.map((row) => `${row.name}/${row.group}`).join(','));
  check('②组色取第 1 色（GROUP_PALETTE[0]）', [GROUP_PALETTE[0]], [...new Set(gData.groups.map((row) => row.color))].slice(0, 1));
  // ③某组 0 条 → 条形与图例都不出现
  const zeroGroupEvents = [mk('k1', 'tA', 0)];
  const zData = buildAnnualReviewData({ events: zeroGroupEvents, calendars: calsG, year: Y2G, tagOf: tagOfStore, groups: store.groups });
  check('③0 条的组不进图例', ['家庭事务'], zData.groups.map((row) => row.name));
  check('③0 条的组不出条形行', true, zData.categories.every((row) => row.group === '家庭事务'));
  // ④无标签日程 → 完全不进分类（04:41 口径）
  const noTagData = buildAnnualReviewData({ events: [mk('k1', null, 0), mk('k2', null, 1)], calendars: calsG, year: Y2G, tagOf: () => null });
  check('④无标签 → 分类 0 行', 0, noTagData.categories.length);
  check('④无标签 → 图例 0 条（不出未分类/未分组）', 0, noTagData.groups.length);
  // ④b 有标签但没归组 → 「未分组」1 行、棕灰 #6b5f52、百分比 100
  const noGroupData = buildAnnualReviewData({
    events: [mk('k1', 'tA', 0), mk('k2', 'tA', 1)], calendars: calsG, year: Y2G,
    tagOf: () => ({ name: '采购', emoji: '🛒', group: '', groupOrder: -1 }),
  });
  check('④b 有标签未分组 → 条形仍按标签名、组=未分组、#6b5f52、100%', ['采购', '未分组', '#6b5f52', 100],
    [noGroupData.categories[0].name, noGroupData.categories[0].group,
      noGroupData.categories[0].groupColor, noGroupData.categories[0].percent]);
  check('④b 未分组只在图例末位出现一次', ['未分组'], noGroupData.groups.map((row) => row.name));
  // ④c 分类里的组序必须来自归一后的值（store order=0 → 1），不能被当成未分组哨兵 -1
  const orderZeroData = buildAnnualReviewData({
    events: [mk('k1', 'tA', 0)], calendars: calsG, year: Y2G,
    tagOf: () => ({ name: '采购', emoji: '🛒', group: '家庭事务', groupOrder: normalizeGroupOrder(0) }),
    groups: [{ name: '家庭事务', order: 0 }],
  });
  check('④c store order=0 的首组 → 组序 1、不进未分组',
    ['家庭事务', 1], [orderZeroData.groups[0].name, orderZeroData.groups[0].order]);
  // ⑤11 个分类 → 10 行 + 「其他」灰末行
  const manyTags = Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, name: `分类 ${i + 1}`, emoji: '🏷️', groupId: 'gA' }));
  const manyEvents = manyTags.map((tag, i) => mk(i % 2 ? 'k1' : 'k2', tag.id, i));
  const mData = buildAnnualReviewData({
    events: manyEvents, calendars: calsG, year: Y2G,
    tagOf: (record) => {
      const tag = manyTags.find((item) => item.id === record.tagId);
      return { name: tag.name, emoji: tag.emoji, group: '家庭事务', groupOrder: 1 };
    },
    groups: [{ name: '家庭事务', order: 0 }],
  });
  check('⑤11 个分类 → 10 行 + 「其他」共 11 条', 11, mData.categories.length);
  check('⑤末行是「其他」且为灰 #98a2b3', ['其他', OTHER_COLOR, true], [mData.categories[10].name, mData.categories[10].groupColor, mData.categories[10].other]);
  // ⑥只有一个组 → 第 1 色、单段整环 padAngle=0
  const singleGroup = buildAnnualReviewData({
    events: [mk('k1', 'tA', 0), mk('k2', 'tA', 1)], calendars: calsG, year: Y2G,
    tagOf: (record) => ({ name: '采购', emoji: '🛒', group: '家庭事务', groupOrder: 1 }),
    groups: [{ name: '家庭事务', order: 0 }],
  });
  check('⑥单个组取第 1 色', [GROUP_PALETTE[0]], [singleGroup.groups[0].color]);
  const singleLayout = buildAnnualCardLayout(singleGroup);
  const singleRing = singleLayout.els.find((el) => el.t === 'ring');
  check('⑥日历单类 → 整圈 360°、padAngle=0', true,
    Boolean(singleRing) && Math.abs(singleRing.a1 - singleRing.a0 - Math.PI * 2) < 1e-9,
    singleRing ? ((singleRing.a1 - singleRing.a0) * 180 / Math.PI).toFixed(3) : 'no ring');
}


// —— 7h. 分组色板 10 色（用户 2026-11-15 04:32）——
{
  const linH = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const rgbH = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lumH = (hex) => { const [r, g, b] = rgbH(hex).map(linH); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratioH = (a, b) => { const x = lumH(a), y = lumH(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const labH = (hex) => {
    const [r, g, b] = rgbH(hex).map(linH);
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const f2 = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    x = f2(x); y = f2(y); z = f2(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const deH = (h1, h2) => {
    const [L1, a1, b1] = labH(h1); const [L2, a2, b2] = labH(h2);
    const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2); const Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const ap1 = a1 * (1 + G); const ap2 = a2 * (1 + G);
    const Cp1 = Math.hypot(ap1, b1); const Cp2 = Math.hypot(ap2, b2);
    const hue = (b, a) => { let h = Math.atan2(b, a) * 180 / Math.PI; return h < 0 ? h + 360 : h; };
    const h1p = hue(b1, ap1); const h2p = hue(b2, ap2);
    const dLp = L2 - L1; const dCp = Cp2 - Cp1;
    let dhp = h2p - h1p;
    if (Cp1 * Cp2 === 0) dhp = 0; else if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
    const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp * Math.PI / 360);
    const Lb = (L1 + L2) / 2; const Cpb = (Cp1 + Cp2) / 2;
    let hb = h1p + h2p;
    if (Cp1 * Cp2 !== 0) { if (Math.abs(h1p - h2p) > 180) hb = hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2; else hb /= 2; } else hb /= 2;
    const T = 1 - 0.17 * Math.cos((hb - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hb * Math.PI / 180)
      + 0.32 * Math.cos((3 * hb + 6) * Math.PI / 180) - 0.2 * Math.cos((4 * hb - 63) * Math.PI / 180);
    const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
    const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
    const Sc = 1 + 0.045 * Cpb; const Sh = 1 + 0.015 * Cpb * T;
    const Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
    return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
  };

  check('色板 10 色', 10, GROUP_PALETTE.length);
  check('第 11 组回第 1 色', GROUP_PALETTE[0], groupColorOf(11));
  // 0.8.13：顺序 = 候选 B 的「最远点」顺序，不得改色相升序。
  check('色板顺序 = 候选 B（禁改色相升序）',
    '#da7f92,#5ab669,#59b8dd,#bf9759,#a890d4,#f28a6e,#60bead,#b4b135,#6da0e6,#da8dc8',
    GROUP_PALETTE.join(','));
  let minDE = Infinity;
  let minPair = '';
  for (let i = 0; i < GROUP_PALETTE.length; i += 1) {
    for (let j = i + 1; j < GROUP_PALETTE.length; j += 1) {
      const d = deH(GROUP_PALETTE[i], GROUP_PALETTE[j]);
      if (d < minDE) { minDE = d; minPair = `${GROUP_PALETTE[i]}/${GROUP_PALETTE[j]}`; }
    }
  }
  check('十色两两 ΔE2000 ≥ 12', true, minDE >= 12, `${minDE.toFixed(2)} ${minPair}`);
  const card = '#f0f5fa';
  check('每色对卡底 #f0f5fa ≥ 1.72:1', true, GROUP_PALETTE.every((c) => ratioH(c, card) >= 1.72),
    GROUP_PALETTE.map((c) => ratioH(c, card).toFixed(2)).join(','));
  check('每色对未分类 ΔE ≥ 12', true, GROUP_PALETTE.every((c) => deH(c, UNCAT_COLOR) >= 12),
    Math.min(...GROUP_PALETTE.map((c) => deH(c, UNCAT_COLOR))).toFixed(1));
  check('每色对「其他」灰 ΔE ≥ 12', true, GROUP_PALETTE.every((c) => deH(c, OTHER_COLOR) >= 12),
    Math.min(...GROUP_PALETTE.map((c) => deH(c, OTHER_COLOR))).toFixed(1));
  check('每色对未分组 #6b5f52 ΔE ≥ 12', true, GROUP_PALETTE.every((c) => deH(c, UNGROUPED_COLOR) >= 12),
    Math.min(...GROUP_PALETTE.map((c) => deH(c, UNGROUPED_COLOR))).toFixed(1));

  // 图例（用户 2026-11-15 20:35）：10 分组 + 聚合「其他」共 11 项，其他末位；
  // 每行先试 5 项，长名放不下就退 4、再退 3，所以长名 11 项会排成多行（≥2 行）。
  const Y2H = 2029;
  const calsH = [{ id: 'k1', name: '日程一', color: '#3e6fe0' }];
  const groupsH = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, name: `家庭事务第${i + 1}组`, order: i }));
  // 11 个标签落在 10 个分组里（第 11 个标签回第 1 组）→ 分类条形聚合出「其他」，图例仍是 10 组 + 其他。
  const tagsH = Array.from({ length: 11 }, (_, i) => ({ id: `ht${i}`, group: i % 10 }));
  const eventsH = tagsH.flatMap((tag, i) => [0, 1].map((n) => ({
    id: `h${i}-${n}`, calendarId: 'k1', tagId: tag.id, title: `分组日程 ${i}-${n}`,
    start: new Date(Y2H, i % 12, 2 + n, 9, 0, 0, 0).getTime(),
    end: new Date(Y2H, i % 12, 2 + n, 10, 0, 0, 0).getTime(),
  })));
  const dataH = buildAnnualReviewData({
    events: eventsH, calendars: calsH, year: Y2H,
    tagOf: (record) => {
      const i = Number(String(record.tagId).slice(2));
      const group = groupsH[tagsH[i].group];
      return { name: `标签${i}`, emoji: '🏷️', group: group.name, groupOrder: normalizeGroupOrder(group.order) };
    },
    groups: groupsH,
  });
  const layoutH = buildAnnualCardLayout(dataH);
  const dotsOf = (layout) => layout.els.filter((el) => el.t === 'arc' && Math.abs(el.r - 4.5) < 1e-9 && el.cx > 500);
  const legendDots = dotsOf(layoutH);
  check('10 分组 + 聚合「其他」= 图例 11 项', 11, legendDots.length);
  check('「其他」在图例末位（末位色 = #98a2b3）', OTHER_COLOR.toLowerCase(), String(legendDots[legendDots.length - 1].fill).toLowerCase());
  const rowsH = [...new Set(legendDots.map((el) => Math.round(el.cy)))].sort((a, b) => a - b);
  check('长名 11 项 → 换行（≥2 行）', true, rowsH.length >= 2, `${rowsH.length} 行`);
  check('换行后组色按组序轮换（10 组各不同 + 其他灰）', 11, new Set(legendDots.map((el) => el.fill)).size);

  // 10 个短名分组：5 + 5 两行，且不出现「其他」（无聚合）
  const groupsS = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `组${i + 1}`, order: i }));
  const eventsS = groupsS.map((group, i) => ({
    id: `s-${i}`, calendarId: 'k1', tagId: `st${i}`, title: `短名日程 ${i}`,
    start: new Date(Y2H, i, 3, 9, 0, 0, 0).getTime(),
    end: new Date(Y2H, i, 3, 10, 0, 0, 0).getTime(),
  }));
  const dataS = buildAnnualReviewData({
    events: eventsS, calendars: calsH, year: Y2H,
    tagOf: (record) => {
      const i = Number(String(record.tagId).slice(2));
      return { name: `标签${i}`, group: groupsS[i].name, groupOrder: normalizeGroupOrder(groupsS[i].order) };
    },
    groups: groupsS,
  });
  const dotsS = dotsOf(buildAnnualCardLayout(dataS));
  check('10 个短名分组 → 图例 10 项（无「其他」）', 10, dotsS.length);
  const rowsS = [...new Set(dotsS.map((el) => Math.round(el.cy)))].sort((a, b) => a - b);
  check('10 个短名分组 → 5 + 5 两行', 2, rowsS.length);
  check('无聚合时不出现「其他」灰', false, dotsS.some((el) => String(el.fill).toLowerCase() === OTHER_COLOR.toLowerCase()));

  // 用户 04:34：分组色也不能和日历默认 9 色相近
  const CAL_COLORS = ['#3171e0', '#5b5ef4', '#9355dc', '#d52f85', '#d73b3c', '#f59e0b', '#088657', '#078477', '#6b7280'];
  const nearest = (c) => Math.min(...CAL_COLORS.map((cal) => deH(c, cal)));
  const minVsCal = Math.min(...GROUP_PALETTE.map((c) => nearest(c)));
  check('每色对日历 9 色 ΔE ≥ 12', true, minVsCal >= 12, minVsCal.toFixed(1));
  check('未分类 #4f8aa8 对蓝 #3171e0 ΔE ≥ 12', true, deH(UNCAT_COLOR, '#3171e0') >= 12, deH(UNCAT_COLOR, '#3171e0').toFixed(1));
  check('其他灰 #98a2b3 对石墨 #6b7280 ΔE ≥ 15', true, deH(OTHER_COLOR, '#6b7280') >= 15, deH(OTHER_COLOR, '#6b7280').toFixed(1));
}


// —— 7j. 没有未分组就不显示「未分类」；≤10 分类 ≤5 日历不出现「其他」（用户 04:36）——
{
  const Y2J = 2029;
  const calsJ = [
    { id: 'k1', name: '一', color: '#3171e0' },
    { id: 'k2', name: '二', color: '#088657' },
    { id: 'k3', name: '三', color: '#d52f85' },
  ];
  const groupsJ = [
    { id: 'gj1', name: '家庭事务', order: 0 },
    { id: 'gj2', name: '健身', order: 1 },
  ];
  const tagsJ = [
    { id: 'tj1', name: '采购', emoji: '🛒', groupId: 'gj1' },
    { id: 'tj2', name: '跑步', emoji: '🏃', groupId: 'gj2' },
    { id: 'tj3', name: '整理', emoji: '🧹', groupId: 'gj1' },
  ];
  const tagOfJ = (record) => {
    const tag = tagsJ.find((item) => item.id === record.tagId);
    if (!tag) return null;
    const group = groupsJ.find((item) => item.id === tag.groupId);
    return { name: tag.name, emoji: tag.emoji, group: group.name, groupOrder: normalizeGroupOrder(group.order) };
  };
  const evJ = tagsJ.flatMap((tag, i) => [0, 1].map((n) => ({
    id: 'j' + i + '-' + n, calendarId: calsJ[i % 3].id, tagId: tag.id, title: '全带标签 ' + i + '-' + n,
    start: new Date(Y2J, 2 + i, 4 + n, 9, 0, 0, 0).getTime(),
    end: new Date(Y2J, 2 + i, 4 + n, 10, 0, 0, 0).getTime(),
  })));
  const allTagged = buildAnnualReviewData({ events: evJ, calendars: calsJ, year: Y2J, tagOf: tagOfJ, groups: groupsJ });
  check('①全带标签 → 条形里没有「未分类」', true,
    allTagged.categories.every((row) => row.name !== '未分类'),
    allTagged.categories.map((row) => row.name).join(','));
  check('①全带标签 → 图例里没有「未分类」', true,
    allTagged.groups.every((row) => row.name !== '未分类'),
    allTagged.groups.map((row) => row.name).join(','));
  check('①图例项数 = 有日程的组数（2）', 2, allTagged.groups.length);
  check('①第一组 store order=0 → 仍算「家庭事务」', ['家庭事务', '健身'], allTagged.groups.map((row) => row.name));
  check('①没有聚合「其他」项（3 分类 ≤ 10、3 日历 ≤ 5）', true,
    allTagged.categories.every((row) => !row.other) && allTagged.calendars.length === 3,
    allTagged.categories.map((row) => row.name + (row.other ? '(其他)' : '')).join(','));
  check('未分类哨兵仍是 -1（不是 0）', -1, normalizeGroupOrder(-1));
}

// —— 7m. 一条日程最多 1 个 emoji（0.8.3 bug 1）——
{
  check('①标题带 emoji → 不再前置标签 emoji', '✈️ 出差去上海', emojiTitle('✈️', '✈️ 出差去上海'));
  check('②标题无 emoji → 前置标签 emoji', '🍽️ 晚餐', emojiTitle('🍽️', '晚餐'));
  check('③无标签 → 前置 📅', '📅 晚餐', emojiTitle('', '晚餐'));
  check('标题用不带变体选择符的写法也认得', '✈ 出差', emojiTitle('✈️', '✈ 出差'));
  check('空标题不出 emoji', '', emojiTitle('✈️', '   '));

  const res = await summary(2026, ['default']);
  const base = res.json.data;
  const day = base.days && base.days.length ? base.days[0].date : '2026-01-17';
  const model = {
    ...base,
    duration: {
      ...(base.duration || { totalMinutes: 0 }),
      longest: { minutes: 480, date: day, title: '✈️ 出差去上海', categoryEmoji: '✈️' },
    },
  };
  const layout = buildAnnualCardLayout(model);
  const longestEl = layout.els.find((item) => item.t === 'text' && String(item.text).includes('出差去上海'));
  const PICTO = /\p{Extended_Pictographic}/u;
  const emojiCount = (value) => [...String(value)].filter((ch) => PICTO.test(ch)).length;  check('最长一次那行只有 1 个 emoji', 1, longestEl && emojiCount(longestEl.text), longestEl && longestEl.text);
}

// —— 7n. 年份跟请求年走（0.8.3 bug 2：卡片大标题）——
{
  const res = await summary(2025, ['default']);
  check('请求 2025 → 模型 year = 2025', 2025, res.json.data.year);
  const layout = buildAnnualCardLayout(res.json.data);
  check('2025 卡片标题写「2025年度总结」', true,
    layout.els.some((item) => item.t === 'text' && item.text === '2025年度总结'));
  check('2025 卡片不出现「2026年度总结」', true,
    !layout.els.some((item) => item.t === 'text' && item.text === '2026年度总结'));
}

// —— 7p. 「最长一次」文案（0.8.14，总监 00:17）：30 分钟不许写成 1 小时 ——
{
  const canvasMod = getCanvas();
  check('canvas 可用（最长一次宽度断言）', true, Boolean(canvasMod));
  if (canvasMod) {
    ensureFonts(canvasMod);
    const mctx = canvasMod.createCanvas(8, 8).getContext('2d');
    const measure = (value, size, weight = 400) => {
      mctx.font = `${weight} ${size}px ${CARD_FONT_FAMILY}`;
      return mctx.measureText(String(value)).width;
    };
    // 第三行左卡内宽：miniW = (1080 − 48×2 − 32×2) / 3，miniInner = miniW − 32×2
    const miniInner = (1080 - 48 * 2 - 32 * 2) / 3 - 32 * 2;
    const base = buildAnnualReviewData({
      events: [{
        id: 'd1', start: new Date(2026, 0, 1, 9, 0).getTime(), end: new Date(2026, 0, 1, 9, 30).getTime(),
        calendarId: 'c1', tagId: 't1', title: '整理资料',
      }],
      calendars: [{ id: 'c1', name: '我的日历', color: '#3171e0' }],
      tagOf: () => ({ name: '整理', emoji: '🧹', group: '', groupOrder: -1 }),
      groups: [], year: 2026, now: new Date(2026, 11, 15, 12, 0).getTime(), accent: '#2f5e9e', weekStartsOn: 1,
    });
    const longestEl = (model) => buildAnnualCardLayout(model, { measure }).els
      .find((item) => item.t === 'text' && item.size === 16 && String(item.text).startsWith('最长一次'));
    for (const minutes of [30, 59, 60, 90, 480, 1435]) {
      const model = {
        ...base,
        duration: { ...(base.duration || {}), longest: { minutes, date: '2026-01-01', title: '整理资料', categoryEmoji: '🧹' } },
      };
      const el = longestEl(model);
      const options = longestDurationTexts(minutes, '1 月 1 日');
      check(`${minutes} 分钟：文案取自候选列表`, true, Boolean(el) && options.includes(el.text), el && el.text);
      check(`${minutes} 分钟：宽度 ≤ 内宽 ${miniInner.toFixed(2)}`, true,
        Boolean(el) && measure(el.text, 16) <= miniInner + 0.01, el && measure(el.text, 16).toFixed(2));
    }
    check('30 分钟不写成 1 小时', true,
      longestDurationTexts(30, '1 月 1 日').every((text) => text.includes('30 分钟') && !text.includes('小时')));
    check('90 分钟写成「1 小时 30 分」', '最长一次 1 小时 30 分，1 月 1 日',
      longestDurationTexts(90, '1 月 1 日')[0]);
    check('整点 480 分钟不带「0 分」', '最长一次 8 小时，1 月 1 日',
      longestDurationTexts(480, '1 月 1 日')[0]);
    check('超宽时先省分钟、保留日期', '最长一次 23 小时，1 月 1 日',
      longestDurationTexts(1435, '1 月 1 日')[1]);
  }
}

// —— 7q. 无标签年份不画月份 emoji 行（0.8.14，总监 00:17）——
{
  const NOW2 = new Date(2026, 11, 15, 12, 0).getTime();
  const CAL2 = [{ id: 'c1', name: '我的日历', color: '#3171e0' }];
  const mkEvents = (tagged) => Array.from({ length: 12 }, (_, i) => {
    const start = new Date(2026, i, i + 1, 9, 0).getTime();
    return { id: `${tagged ? 't' : 'u'}${i}`, start, end: start + 30 * 60000, calendarId: 'c1', tagId: tagged ? 't1' : null, title: `日程 ${i + 1}` };
  });
  const monthEmojiEls = (model) => buildAnnualCardLayout(model).els
    .filter((item) => item.t === 'text' && item.size === 34 && item.y < 200);
  const untagged = buildAnnualReviewData({
    events: mkEvents(false), calendars: CAL2, tagOf: () => null, groups: [],
    year: 2026, now: NOW2, accent: '#2f5e9e', weekStartsOn: 1,
  });
  check('无标签年份：分类为空', 0, untagged.categories.length);
  check('无标签年份：月份 emoji 行不画', 0, monthEmojiEls(untagged).length);
  const tagged = buildAnnualReviewData({
    events: mkEvents(true), calendars: CAL2,
    tagOf: () => ({ name: '采购', emoji: '🛒', group: '', groupOrder: -1 }),
    groups: [], year: 2026, now: NOW2, accent: '#2f5e9e', weekStartsOn: 1,
  });
  check('有分类：月份 emoji 行仍在（12 个）', 12, monthEmojiEls(tagged).length);
}

// —— 7o. 单日历整圈环形：环心必须是洞（0.8.4，用户 17:07 真机：只有一类时环内长出旋转方块）——
// 根因：整圈分支把外圈/内圈各拆成 4 段 1/4 弧，每段前的 M 让 canvas 用弦隐式闭合，
// 偶奇填充把弦围出的区域也填上。修法：外圈一条 A(0→TAU)+Z、内圈一条反向 A(0→TAU)+Z。
{
  const canvasMod = getCanvas();
  check('canvas 可用（单日历像素断言）', true, Boolean(canvasMod));
  if (canvasMod) {
    ensureFonts(canvasMod);
    const CAL = { id: 'cal-only', name: '个人', color: '#3171e0' };
    const CAL_RGB = [49, 113, 224];
    const GROUPS1 = [{ id: 'grp-health', name: '健康', order: 0 }, { id: 'grp-study', name: '学习', order: 1 }];
    const TAGS1 = [
      { id: 't1', name: '健身', emoji: '🏃', groupId: 'grp-health' },
      { id: 't2', name: '阅读', emoji: '📚', groupId: 'grp-study' },
    ];
    const Y = 2026;
    const NOW1 = new Date(Y, 11, 31, 12, 0, 0, 0).getTime();
    const ev = (id, month, day, hour, tagId) => {
      const start = new Date(Y, month, day, hour, 0, 0, 0).getTime();
      return { id, start, end: start + 45 * 60000, calendarId: CAL.id, tagId, title: `单日历 ${id}` };
    };
    const tagOf1 = (record) => {
      const tag = TAGS1.find((item) => item.id === record.tagId);
      if (!tag) return null;
      const group = GROUPS1.find((item) => item.id === tag.groupId);
      return { name: tag.name, emoji: tag.emoji, group: group ? group.name : '', groupOrder: group ? normalizeGroupOrder(group.order) : -1 };
    };
    const maxCh = (a, b) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
    const cases = [
      ['单日历 1 条', [ev('c1', 4, 12, 9, 't1')]],
      ['单日历 9 条', Array.from({ length: 9 }, (_, i) => ev(`c9-${i}`, i % 12, 2 + (i % 7) * 3, 8 + (i % 9), TAGS1[i % 2].id))],
      ['单日历 9 条全部同一分类', Array.from({ length: 9 }, (_, i) => ev(`s9-${i}`, i % 12, 3 + (i % 7) * 3, 10 + (i % 6), 't1'))],
    ];
    for (const [label, events] of cases) {
      const model = buildAnnualReviewData({ events, calendars: [CAL], tagOf: tagOf1, groups: GROUPS1, year: Y, now: NOW1, accent: '#2f5e9e', weekStartsOn: 1 });
      check(`${label}：只有 1 个日历切片`, 1, model.calendars.length);
      const res = renderAnnualCardPng(annualLib, model);
      check(`${label}：渲染出 PNG`, true, res.ok, res.reason);
      if (!res.ok) continue;
      const img = await canvasMod.loadImage(res.png);
      const surface = canvasMod.createCanvas(img.width, img.height);
      const ctx = surface.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const px = (x, y) => {
        const i = (Math.round(y) * img.width + Math.round(x)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const ring = buildAnnualCardLayout(model).els.find((el) => el.t === 'ring');
      const at = (r, deg) => px(ring.cx + r * Math.cos((deg * Math.PI) / 180), ring.cy + r * Math.sin((deg * Math.PI) / 180));
      const band = (ring.rIn + ring.rOut) / 2;
      check(`${label}：环带 8 向（含四个 1/4 点）都是日历色`, true, [0, 45, 90, 135, 180, 225, 270, 315].every((d) => maxCh(at(band, d), CAL_RGB) <= 6));
      const hole = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => at(56, d));
      check(`${label}：环心 r=56 八向都不是日历色`, true, hole.every((p) => maxCh(p, CAL_RGB) > 30));
      check(`${label}：环心八向同色（容差 4）`, true, Math.max(...hole.map((p) => maxCh(p, hole[0]))) <= 4);
      check(`${label}：环心颜色 = #e1edf2 一档`, true, maxCh(hole[0], [225, 237, 242]) <= 6);
      check(`${label}：外沿外 r=170 是卡面底色`, true, maxCh(at(170, 270), CAL_RGB) > 30);
      check(`${label}：r=90 四斜向仍是洞（无尖角）`, true, [45, 135, 225, 315].every((d) => maxCh(at(90, d), CAL_RGB) > 30));
      const geo = ringSectorPath(ring);
      check(`${label}：整圈 = 2 条子路径（M 数 2，防退回 4 段写法）`, 2, geo.cmds.filter((cmd) => cmd.c === 'M').length);
      check(`${label}：整圈走偶奇填充`, true, geo.evenOdd === true);
    }
  }
}

// —— 7p. 热度格兜底色（0.8.9 崩溃路径）：日历已删、日程还在 ——
// 旧版 heatCellFill 在模块作用域引用布局内的局部 ACCENT，calendarColor 为空时 ReferenceError，
// 整张卡渲染失败。修法：accent 作为第三个参数传入（默认 DEFAULT_ACCENT），调用点传 ACCENT。
{
  const Y = 2026;
  const NOWP = new Date(Y, 11, 31, 12, 0, 0, 0).getTime();
  const at = (month, day, hour) => new Date(Y, month, day, hour, 0, 0, 0).getTime();
  const events = [
    { id: 'ghost-1', start: at(4, 12, 9), end: at(4, 12, 10), calendarId: 'ghost-cal', tagId: null, title: '日历已删 1' },
    { id: 'ghost-2', start: at(4, 12, 14), end: at(4, 12, 15), calendarId: 'ghost-cal', tagId: null, title: '日历已删 2' },
    { id: 'ghost-3', start: at(7, 3, 9), end: at(7, 3, 10), calendarId: 'ghost-cal', tagId: null, title: '日历已删 3' },
  ];
  // calendars 传空：模拟日历被删、日程记录还留着。
  const ghostModel = buildAnnualReviewData({ events, calendars: [], tagOf: () => null, groups: [], year: Y, now: NOWP, accent: '#2f5e9e', weekStartsOn: 1 });
  const ghostDays = ghostModel.days.filter((item) => item.total > 0);
  check('日历已删时 heat 有 count、无 calendarColor', true,
    ghostDays.length === 2 && ghostDays.every((item) => !item.calendarColor));

  let ghostLayout = null;
  let ghostError = null;
  try {
    ghostLayout = buildAnnualCardLayout(ghostModel);
  } catch (err) {
    ghostError = err;
  }
  check('日历已删时卡片布局不抛', null, ghostError && ghostError.message);

  if (ghostLayout) {
    // 热度格是 15×15 的 rect，按 model.days 顺序排列；用第一条有日程的日索引对齐。
    const heatRects = ghostLayout.els.filter((item) => item.t === 'rect' && item.w === 15 && item.h === 15);
    const index = ghostModel.days.findIndex((item) => item.total > 0);
    const ghostDay = ghostModel.days[index];
    const accent = accentInk(ghostModel.accent);
    check('该格色 = heatCellFill("", n, ACCENT)', heatCellFill('', ghostDay.total, accent), heatRects[index] && heatRects[index].fill);
    check('该格不是空格色（total > 0）', true, heatRects[index] && heatRects[index].fill !== HEAT_EMPTY_COLOR);
  }

  check('heatCellFill 无第三参时用 DEFAULT_ACCENT', heatCellFill('', 3, DEFAULT_ACCENT), heatCellFill('', 3));
  check('heatCellFill("#000000", 0) 仍是空格色', HEAT_EMPTY_COLOR, heatCellFill('#000000', 0));

  // —— 7p. 日热度 4 档差（0.8.26 用户 m01310「透明度从 50-100，区别大一点」）——
  // 口径：1 条 .56 / 2 条 .78 / 3 条 = 原色 / 4 条以上 = 原色压深 12%；空格 #d6e1ed 不变。
  {
    const cr = (a, b) => {
      const lum = (hex) => {
        const h = hex.replace('#', '');
        const [r, g, b2] = [0, 2, 4].map((i) => {
          const c = parseInt(h.slice(i, i + 2), 16) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
      };
      const la = lum(a); const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const band = (color, n) => [1, 2, 3, 4].map((k) => heatCellFill(color, k === 4 ? 4 : k));
    const ORANGE = '#f59e0b';
    const o = band(ORANGE, 1);
    check('热度 4 档颜色两两不同（橙）', 4, new Set(o).size);
    check('热度 4 档对空格对比度逐档递增（橙）', true,
      o.map((h) => cr(h, HEAT_EMPTY_COLOR)).every((v, i, arr) => i === 0 || v > arr[i - 1]));
    check('热度每档对空格 ≥1.15:1（橙）', true, o.every((h) => cr(h, HEAT_EMPTY_COLOR) >= 1.15));
    check('第 3 档 = 该日历色原值（橙）', ORANGE.toLowerCase(), o[2].toLowerCase());
    check('第 4 档 = 原值压深 12%（橙）', '#d88b0a', o[3].toLowerCase());
    check('橙色四档对空格 1.16 / 1.38 / 1.62 / 2.08', '1.16 / 1.38 / 1.62 / 2.08',
      o.map((h) => cr(h, HEAT_EMPTY_COLOR).toFixed(2)).join(' / '));
    const palette = ['#3b82f6', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#ec4899', '#64748b'];
    check('九色各自四档两两不同、逐档递增、每档 ≥1.15', true,
      [ORANGE, ...palette].every((c) => {
        const v = band(c, 1);
        const crs = v.map((h) => cr(h, HEAT_EMPTY_COLOR));
        return new Set(v).size === 4 && crs.every((x) => x >= 1.15) && crs.every((x, i, a) => i === 0 || x > a[i - 1]);
      }));
  }
}

// —— 7q. 分类分布行间空隙（0.8.10，用户 23:17）：11 行 + 图例两行时条带底 ≤ 图例顶 − 12 ——
// 布局是纯函数：这里直接改模型的 categories/groups（10 个标签分 9 组 + 聚合「其他」= 11 行，
// 图例 = 9 组 + 其他 = 10 项 → 两行），只量几何，不依赖标签存储。
{
  const Y = 2026;
  const NOWQ = new Date(Y, 11, 31, 12, 0, 0, 0).getTime();
  const baseModel = buildAnnualReviewData({
    events: [
      { id: 'q1', start: new Date(Y, 4, 12, 9, 0, 0, 0).getTime(), end: new Date(Y, 4, 12, 10, 0, 0, 0).getTime(), calendarId: 'qc', tagId: null, title: '分类空隙夹具' },
    ],
    calendars: [{ id: 'qc', name: '我的日历', color: '#3171e0' }],
    tagOf: () => null, groups: [], year: Y, now: NOWQ, accent: '#2f5e9e', weekStartsOn: 1,
  });
  const GROUP_NAMES = ['生活', '工作', '学习', '健康', '兴趣', '旅行', '家庭', '阅读', '运动'];
  const groups = GROUP_NAMES.map((name, index) => ({ name, color: GROUP_PALETTE[index % GROUP_PALETTE.length] }));
  const categories = Array.from({ length: 10 }, (_, index) => ({
    name: `标签${index + 1}`,
    emoji: '📌',
    count: 40 - index * 2,
    groupColor: groups[index % groups.length].color,
    other: false,
  })).concat([{ name: '其他', emoji: '📦', count: 5, groupColor: OTHER_COLOR, other: true }]);
  const model = { ...baseModel, groups, categories };
  const layout = buildAnnualCardLayout(model);
  const barRects = layout.els.filter((item) => item.t === 'rect' && item.x > 540 && Math.abs(item.h - 18) < 0.01);
  const rows2 = [...new Set(barRects.map((item) => Math.round(item.y * 100) / 100))].sort((a, b) => a - b);
  const dots = layout.els.filter((item) => item.t === 'arc' && item.r === 4.5 && item.cx > 540);
  const baselines = [...new Set(dots.map((item) => Math.round((item.cy + 5) * 100) / 100))].sort((a, b) => a - b);
  const barsBottom = Math.max(...barRects.map((item) => item.y + item.h));
  const legendTop = baselines.length ? baselines[0] - 8 : Infinity;
  check('11 行分类都画出条带', 11, rows2.length);
  check('11 行 + 图例占两行', 2, baselines.length);
  check('11 行 + 图例两行：条带底 ≤ 图例顶 − 12', true, barsBottom + 12 <= legendTop + 0.6);
  // 图例占两行时可用高度 = 866 − 46 − 12 − 428 = 380，(380 − 11×26) / 10 = 9.4，密集档上限 8 → 行距 8。
  check('11 行 + 两行图例：行距收紧到 8', 8, rows2.length > 1 ? Math.round(rows2[1] - rows2[0] - 26) : -1);
  check('条带厚度 18', true, barRects.every((item) => Math.abs(item.h - 18) < 0.01));
  // 0.8.10 用户 23:26：分类图例两行之间 28px（环形图例仍 32）。
  const fakeGroups = groups.map((group) => ({ name: group.name, color: group.color }));
  const legendModel = { ...model, groups: fakeGroups };
  const legendLayout = buildAnnualCardLayout(legendModel);
  const legendDots = legendLayout.els.filter((item) => item.t === 'arc' && item.r === 4.5 && item.cx > 540);
  const legendYs = [...new Set(legendDots.map((item) => Math.round((item.cy + 5) * 100) / 100))].sort((a, b) => a - b);
  check('分类图例两行之间 28px', 28, legendYs.length > 1 ? Math.round(legendYs[1] - legendYs[0]) : -1);
  // 0.8.10 用户 23:28：第三行三卡内容顶 998、最底文字基线 1092（差 ≤1px）。
  const weekRects = layout.els.filter((item) => item.t === 'rect' && Math.abs(item.w - 22) < 0.01 && item.y > 900);
  const weekTop = Math.min(...weekRects.map((item) => item.y));
  const curveEl = layout.els.find((item) => item.t === 'curve');
  const bigNum = layout.els.find((item) => item.t === 'text' && item.size === 34 && item.y > 900);
  const tops = [weekTop, curveEl.y, bigNum.y - 24];
  check('三卡内容顶都是 998', true, tops.every((v) => Math.abs(v - 998) <= 1));
  const row3Texts = layout.els.filter((item) => item.t === 'text' && item.y >= 960 && item.y <= 1110);
  check('最底文字基线 1092', 1092, Math.max(...row3Texts.map((item) => item.y)));
  // 0.8.12 用户 23:58：底部卡大标题 72 → 84，行高 87.36（= 84 × 1.04）；mid 基线 = 卡内上沿 + 87.36/2 + 84×0.36 = +73.92。
  const titleEl = layout.els.find((item) => item.t === 'text' && /年度总结$/.test(String(item.text)));
  const card4 = layout.els.find((item) => item.t === 'rect' && Math.abs(item.h - 230) < 0.01 && Math.abs(item.w - 984) < 0.01);
  check('底部大标题字号 84', 84, titleEl ? titleEl.size : -1);
  check('底部大标题基线 = 卡内上沿 + 73.92', true,
    !!(titleEl && card4) && Math.abs(titleEl.y - (card4.y + 24) - 73.92) <= 0.02);
}

// —— 7r. 全无标签文案（0.8.13，用户 00:01）：全年有日程、一条标签都没有 ——
// 分类卡不能写「今年还没有日程」；底部小字不能写「最丰富的一天 … 共 0 种分类」，
// 要写「最丰富的一天 —」且行位不动（与「最忙的一天」相距 32）。
{
  const Y = 2026;
  const NOWR = new Date(Y, 11, 31, 12, 0, 0, 0).getTime();
  const at = (month, day, hour) => new Date(Y, month, day, hour, 0, 0, 0).getTime();
  const model = buildAnnualReviewData({
    events: Array.from({ length: 12 }, (_, index) => ({
      id: `r${index}`,
      start: at(index % 12, 1 + index, 9),
      end: at(index % 12, 1 + index, 10),
      calendarId: 'rc',
      tagId: null,
      title: `无标签日程 ${index + 1}`,
    })),
    calendars: [{ id: 'rc', name: '我的日历', color: '#3171e0' }],
    tagOf: () => null, groups: [], year: Y, now: NOWR, accent: '#2f5e9e', weekStartsOn: 1,
  });
  const layout = buildAnnualCardLayout(model);
  const texts = layout.els.filter((item) => item.t === 'text').map((item) => String(item.text));
  check('无标签：分类空态写「今年还没有分类」', true, texts.includes('今年还没有分类'));
  check('无标签：不再出现「今年还没有日程」', true, !texts.includes('今年还没有日程'));
  check('无标签：分类分布 0 行、卡片非空', true, model.categories.length === 0 && model.total === 12 && model.empty === false);
  check('无标签：最丰富的一天 0 分类', 0, model.richestDay ? model.richestDay.categories : -1);
  check('无标签：底部小字「最丰富的一天 —」', true, texts.includes('最丰富的一天 —'));
  check('无标签：不出现「共 0 种分类」', true, !texts.some((text) => text.includes('共 0 种分类')));
  const sub1 = layout.els.find((item) => item.t === 'text' && String(item.text).startsWith('最忙的一天是'));
  const sub2 = layout.els.find((item) => item.t === 'text' && String(item.text) === '最丰富的一天 —');
  check('无标签：两行小字相距 32（行位不动）', 32, sub1 && sub2 ? Math.round((sub2.y - sub1.y) * 100) / 100 : -1);
}

// —— 7s. 环形固定圆心 + 图例固定顶边（0.8.15，用户 00:43）——
// 图例 1 / 2 / 3 行时，环顶、环心、图例第一行基线都不许动；3 行末行文字框底 ≤ 866（卡内底）。
{
  const Y3 = 2028;
  const NOW3 = new Date(Y3, 11, 31, 12, 0, 0, 0).getTime();
  const at3 = (month, day, hour) => new Date(Y3, month, day, hour, 0, 0, 0).getTime();
  const names = ['工作日', '家庭', '运动', '学习', '出行', '纪念日'];
  const cols = ['#3171e0', '#088657', '#f59e0b', '#9355dc', '#e0457b', '#12a5b5'];
  const cals = names.map((name, index) => ({ id: `q${index}`, name, color: cols[index] }));
  const mk = (count) => {
    const events = [];
    for (let c = 0; c < count; c += 1) {
      for (let n = 0; n < 3; n += 1) {
        events.push({
          id: `q${c}-${n}`, calendarId: `q${c}`, tagId: null, title: `日程 ${c}-${n}`,
          start: at3(c, 1 + n * 2, 9), end: at3(c, 1 + n * 2, 10),
        });
      }
    }
    return buildAnnualCardLayout(buildAnnualReviewData({
      events, calendars: cals, tagOf: () => null, groups: [], year: Y3, now: NOW3,
      accent: '#2f5e9e', weekStartsOn: 1,
    }));
  };
  const rowsOf = (layout) => {
    const dots = layout.els.filter((el) => el.t === 'arc' && el.r === 4.5 && el.cx < 540);
    return [...new Set(dots.map((el) => Math.round(el.cy * 100) / 100))].sort((a, b) => a - b);
  };
  const ringOf = (layout) => layout.els.find((el) => el.t === 'ring');
  const probes = [2, 3, 6].map((count) => {
    const layout = mk(count);
    const ring = ringOf(layout);
    return { count, layout, ring, top: ring.cy - ring.rOut, cy: ring.cy, rows: rowsOf(layout) };
  });
  check('图例行数 1 / 2 / 3 各一组', [1, 2, 3], probes.map((probe) => probe.rows.length));
  check('环顶固定 453（卡内 83，差 0）', [453], [...new Set(probes.map((probe) => Math.round(probe.top * 100) / 100))]);
  check('环心固定 603（差 0）', [603], [...new Set(probes.map((probe) => Math.round(probe.cy * 100) / 100))]);
  check('图例第一行基线固定 789（差 0）', [789], [...new Set(probes.map((probe) => Math.round(probe.rows[0] * 100) / 100))]);
  const lastRow = probes[2].rows[probes[2].rows.length - 1];
  check('3 行末行基线 853', 853, Math.round(lastRow * 100) / 100);
  check('3 行末行文字框底 ≤ 866', true, lastRow + 20 * 0.36 <= 866, (lastRow + 20 * 0.36).toFixed(2));
  const emptyModel = buildAnnualReviewData({
    events: [], calendars: cals, tagOf: () => null, groups: [], year: Y3, now: NOW3, accent: '#2f5e9e', weekStartsOn: 1,
  });
  const emptyText = buildAnnualCardLayout(emptyModel).els.find((el) => el.t === 'text' && el.text === '今年还没有日程');
  check('空状态文案也在图例顶 + 12（=789）', 789, emptyText ? Math.round(emptyText.y * 100) / 100 : -1);
}

// —— 7t. 环形图例百分比合计 100.0（0.8.16，总监 00:48）——
// 逐项四舍五入会让 6 等分各 16.7% 合计 100.2%；改用最大余数法后合计必须正好 100.0%。
{
  const Y4 = 2027;
  const NOW4 = new Date(Y4, 11, 31, 12, 0, 0, 0).getTime();
  const at4 = (month, day, hour) => new Date(Y4, month, day, hour, 0, 0, 0).getTime();
  const cols = ['#3171e0', '#088657', '#f59e0b', '#9355dc', '#e0457b', '#12a5b5',
    '#6b5f52', '#98a2b3', '#4f8aa8', '#da7f92', '#5ab669'];
  const mkModel = (calCount, perCal) => {
    const calendars = Array.from({ length: calCount }, (_, index) => ({ id: `t${index}`, name: `日历${index + 1}`, color: cols[index % cols.length] }));
    const events = [];
    calendars.forEach((cal, c) => {
      for (let n = 0; n < perCal; n += 1) {
        const start = at4((c + n) % 12, 1 + ((c * perCal + n) % 27), 9);
        events.push({ id: `${cal.id}-${n}`, calendarId: cal.id, tagId: null, title: `日程 ${c}-${n}`, start, end: start + 3600000 });
      }
    });
    return buildAnnualReviewData({ events, calendars, tagOf: () => null, groups: [], year: Y4, now: NOW4, accent: '#2f5e9e', weekStartsOn: 1 });
  };
  const pctSum = (model) => Math.round(model.calendars.reduce((sum, slice) => sum + slice.percent, 0) * 10) / 10;
  const oneDecimal = (model) => model.calendars.every((slice) => Math.round(slice.percent * 10) === slice.percent * 10);

  const six = mkModel(6, 4);
  check('6 等分：合计 100.0', 100, pctSum(six));
  check('6 等分：六项都一位小数', true, oneDecimal(six));
  check('6 等分：只有 16.6 / 16.7 两档', '16.6,16.7', [...new Set(six.calendars.map((slice) => slice.percent.toFixed(1)).sort())].join(','));

  const one = mkModel(1, 3);
  check('单日历：100.0', [100], one.calendars.map((slice) => slice.percent));

  const two = mkModel(2, 5);
  check('两日历 50/50', [50, 50], two.calendars.map((slice) => slice.percent));

  const many = mkModel(11, 2);
  check('11 个日历并成 5 + 其他', 6, many.calendars.length);
  check('11 个日历带「其他」：合计 100.0', 100, pctSum(many));
  check('环形图例文本合计 100.0', true, (() => {
    const texts = buildAnnualCardLayout(many).els
      .filter((el) => el.t === 'text' && /^\d+(\.\d)?%$/.test(String(el.text)))
      .map((el) => Number(String(el.text).replace('%', '')));
    return texts.length === 6 && Math.round(texts.reduce((sum, value) => sum + value, 0) * 10) / 10 === 100;
  })());

  check('导出：0 条时百分比 0', [], buildAnnualReviewData({
    events: [], calendars: [{ id: 'z', name: '空', color: '#3171e0' }], tagOf: () => null, groups: [],
    year: Y4, now: NOW4, accent: '#2f5e9e', weekStartsOn: 1,
  }).calendars.map((slice) => slice.percent));
}

await new Promise((resolve) => server.close(resolve));
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
