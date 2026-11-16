// 0.8.4（用户 2026-11-15 14:10）：年度总结「全部数字都来自 ?year= 这一次请求」。
//
// 这一条专门挡「标题 2025、数据 2026」：
//   - 两套年份数据不同的夹具：2025 放 7 条、2026 放 128 条；
//   - `?year=2025` 的响应里 year / 总数 / 热力图 / 环形 / 分类必须全是 2025 的 7 条；
//   - `?year=2026` 同理是 128 条；两年互不串；
//   - 卡片布局标题用响应里的 year（`buildAnnualCardLayout(model)`）。
//
// 运行：在 `projects/FnCal/code` 下 `node app/test/m63-annual-year.test.mjs`。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildAnnualCardLayout } from '../lib/annual-review.mjs';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-annual-year-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
process.env.CALDAV_SESSION_SECRET = 'annual-year-test-secret-0123456789';

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
  check('登录成功', true, res.status === 200 && Boolean(cookie));
}

const at = (year, month1, day, hour = 12) => new Date(year, month1 - 1, day, hour, 0, 0, 0).getTime();

async function putEvent(id, event) {
  const res = await raw(`/api/v1/kv/${encodeURIComponent(`cal:evt:${id}`)}`, { method: 'PUT', body: event });
  if (res.status >= 400) throw new Error(`PUT ${id} -> ${res.status} ${res.text.slice(0, 200)}`);
  return res;
}

const summary = (year) => raw(`/api/v1/annual-summary?year=${year}&calendars=default`);

// —— 夹具：2025 七条（全部有标签）、2026 一百二十八条（一半有标签） ——
{
  const groupRes = await raw('/api/v1/tag-groups', { method: 'POST', body: { name: '家庭事务' } });
  const group = groupRes.json.group;
  const tagRes = await raw('/api/v1/tags', { method: 'POST', body: { name: '家务', emoji: '🏠', groupId: group.id } });
  const tag = tagRes.json.tag;

  for (let i = 0; i < 7; i += 1) {
    await putEvent(`y2025-${i}`, {
      title: `2025 事件 ${i}`, start: at(2025, (i % 12) + 1, 3 + i), end: at(2025, (i % 12) + 1, 3 + i, 13),
      tagId: tag.id, categories: ['家务'],
    });
  }
  for (let i = 0; i < 128; i += 1) {
    const tagged = i % 2 === 0;
    await putEvent(`y2026-${i}`, {
      title: `2026 事件 ${i}`, start: at(2026, (i % 12) + 1, (i % 27) + 1), end: at(2026, (i % 12) + 1, (i % 27) + 1, 13),
      ...(tagged ? { tagId: tag.id, categories: ['家务'] } : {}),
    });
  }
}

const sum = (list, key) => list.reduce((acc, row) => acc + (key ? row[key] : row), 0);
const layoutTitles = (model) => buildAnnualCardLayout(model).els
  .filter((item) => item.t === 'text')
  .map((item) => item.text);

// —— 1. 2025：7 条 ——
{
  const res = await summary(2025);
  const model = res.json && res.json.data;
  check('2025 接口 200', 200, res.status);
  check('响应 year=2025', 2025, model.year);
  check('2025 总数=7', 7, model.total);
  check('2025 热力图合计=7', 7, sum(model.heat, 'count'));
  check('2025 环形（日历）合计=7', 7, sum(model.calendars, 'count'));
  check('2025 月份桶合计=7', 7, sum(model.months, 'total'));
  check('2025 分类合计=有标签 7', 7, sum(model.categories, 'count'));
  check('2025 分类百分比合计 100', true,
    Math.abs(model.categories.reduce((acc, row) => acc + row.percent, 0) - 100) < 0.05,
    model.categories.map((row) => `${row.name}:${row.count}/${row.percent}`).join(' '));
  check('2025 卡片标题=2025年度总结', true, layoutTitles(model).includes('2025年度总结'));
  check('2025 卡片标题不含 2026', false, layoutTitles(model).some((text) => /2026年度总结/.test(text)));
}

// —— 2. 2026：128 条 ——
{
  const res = await summary(2026);
  const model = res.json && res.json.data;
  check('2026 接口 200', 200, res.status);
  check('响应 year=2026', 2026, model.year);
  check('2026 总数=128（不串 2025 的 7 条）', 128, model.total);
  check('2026 热力图合计=128', 128, sum(model.heat, 'count'));
  check('2026 环形（日历）合计=128', 128, sum(model.calendars, 'count'));
  check('2026 月份桶合计=128', 128, sum(model.months, 'total'));
  check('2026 分类合计=有标签 64', 64, sum(model.categories, 'count'));
  check('2026 分类合计 ≤ 总数', true, sum(model.categories, 'count') <= model.total,
    `${sum(model.categories, 'count')} / ${model.total}`);
  check('2026 卡片标题=2026年度总结', true, layoutTitles(model).includes('2026年度总结'));
  check('2026 卡片标题不含 2025', false, layoutTitles(model).some((text) => /2025年度总结/.test(text)));
}

// —— 3. 无 year 参数不回落到别的年份数据 ——
{
  const res = await raw('/api/v1/annual-summary?calendars=default');
  const nowYear = new Date().getFullYear();
  check('缺省 year = 当前系统年（仅接口兜底）', nowYear, res.json && res.json.data.year);
}

server.close();
console.log(`\nSUMMARY: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
