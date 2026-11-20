#!/usr/bin/env node
/**
 * 0.8.46：在线 ICS 订阅。
 *
 * 覆盖：
 *   A 地址校验：http(s)、拒绝 ftp/超长/云元数据地址，展示打码 userinfo；
 *   B fetchIcs：正常读取、304、HTTP 错误、重定向 ≤3 与自环、10 MB 上限、超时；
 *   C syncSubscription：导入、304 不写、源变化再导入、失败保留旧数据并记错误、
 *     恢复后再同步清掉错误；
 *   D REST：POST 带 subscriptionUrl 新建（readOnly/isSubscription/间隔）、
 *     非法 URL/间隔 400、普通日历 PATCH 订阅地址 400 subscription_requires_new_calendar、
 *     订阅日历改地址 200 且清 etag 后立即同步、POST /sync 409/200、订阅上限 409；
 *   E 只读：REST KV 写 403 calendar_read_only、DAV PUT 403；
 *   F 定时器：只同步到点且间隔 >0 的订阅，串行不重入。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0846-subscriptions-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';

const {
  createSubscriptionScheduler,
  fetchIcs,
  maskSubscriptionUrl,
  syncSubscription,
  validateSubscriptionUrl,
} = await import('../lib/subscriptions.mjs');
const { createApp, resolveConfig } = await import('../server.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);

/* ---------------- 远端订阅源 ---------------- */

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const NOW = Date.parse('2026-12-01T00:00:00Z');
const HOUR = 3600 * 1000;

function icsWith(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FnCal Test//EN'];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `SUMMARY:${event.summary}`,
      `DTSTART:${stamp(event.start)}`,
      `DTEND:${stamp(event.end)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return lines.join('\r\n');
}

const remote = {
  etag: '"feed-v1"',
  body: icsWith([
    { uid: 'holiday-1', summary: '元旦', start: NOW, end: NOW + HOUR },
    { uid: 'holiday-2', summary: '初二', start: NOW + 24 * HOUR, end: NOW + 25 * HOUR },
  ]),
  fail: false,
  hits: 0,
  lastIfNoneMatch: '',
};

const remoteServer = http.createServer((req, res) => {
  remote.hits += 1;
  remote.lastIfNoneMatch = String(req.headers['if-none-match'] || '');
  const pathname = new URL(req.url, 'http://x').pathname;

  if (pathname === '/feed.ics') {
    if (remote.fail) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (remote.lastIfNoneMatch === remote.etag) {
      res.writeHead(304, { ETag: remote.etag });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', ETag: remote.etag });
    res.end(remote.body);
    return;
  }
  if (pathname === '/big.ics') {
    res.writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(11 * 1024 * 1024) });
    res.end();
    return;
  }
  if (pathname === '/loop.ics') {
    res.writeHead(302, { location: '/loop.ics' });
    res.end();
    return;
  }
  if (pathname === '/r1.ics' || pathname === '/r2.ics') {
    res.writeHead(302, { location: `/r${Number(pathname[2]) + 1}.ics` });
    res.end();
    return;
  }
  // r3 直接跳到 feed：总计 3 次重定向（上限允许 3）。
  if (pathname === '/r3.ics') {
    res.writeHead(302, { location: '/feed.ics' });
    res.end();
    return;
  }
  // 0.8.47：gzip 正文（验证不会手工二次解压）、text/plain、非 ICS。
  if (pathname === '/gzip.ics') {
    const packed = zlib.gzipSync(Buffer.from(remote.body, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/calendar; charset=UTF-8', 'content-encoding': 'gzip', 'content-length': String(packed.length) });
    res.end(packed);
    return;
  }
  if (pathname === '/plain.ics') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(remote.body);
    return;
  }
  if (pathname === '/html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>not a calendar</body></html>');
    return;
  }
  if (pathname === '/slow.ics') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(remote.body);
    }, 300);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
const FEED = `http://127.0.0.1:${remoteServer.address().port}`;

/* ---------------- 本机服务 ---------------- */

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const BASIC = `Basic ${Buffer.from('admin:admin-pass-123').toString('base64')}`;

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-123' }),
  });
  const body = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .map((item) => item.split(';')[0]).join('; ');
  return { body, cookie: cookies, csrf: body.csrf || '' };
}

async function api(p, { method = 'GET', body, session } = {}) {
  const init = { method, redirect: 'manual', headers: {} };
  if (session) {
    init.headers.cookie = session.cookie;
    if (session.csrf) init.headers['x-csrf-token'] = session.csrf;
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

async function calendarRow(session, calendarId) {
  const list = await api('/api/v1/calendars?counts=1', { session });
  return (list.body.calendars || []).find((cal) => cal.id === calendarId) || null;
}

try {
  /* ============================================================ A 地址校验 */
  ok('A1 http 通过', validateSubscriptionUrl('http://example.com/a.ics'));
  ok('A2 https 通过', validateSubscriptionUrl('https://example.com/a.ics'));
  eq('A3 ftp 拒绝', null, validateSubscriptionUrl('ftp://example.com/a.ics'));
  eq('A4 云元数据拒绝', null, validateSubscriptionUrl('http://169.254.169.254/latest/meta-data/'));
  eq('A5 超长拒绝', null, validateSubscriptionUrl(`https://example.com/${'a'.repeat(2050)}`));
  eq('A6 userinfo 打码', 'https://***:***@example.com/a.ics', maskSubscriptionUrl('https://user:pass@example.com/a.ics'));

  /* ============================================================ B fetchIcs */
  const plain = await fetchIcs(`${FEED}/feed.ics`);
  ok('B1 正常读取拿到正文', plain.text.includes('UID:holiday-1'));
  eq('B2 记下 ETag', '"feed-v1"', plain.etag);
  const notModified = await fetchIcs(`${FEED}/feed.ics`, { etag: '"feed-v1"' });
  eq('B3 304 → notModified', true, notModified.notModified);
  let httpError = null;
  try { await fetchIcs(`${FEED}/missing.ics`); } catch (err) { httpError = err; }
  eq('B4 HTTP 404 → subscription_http_error', 'subscription_http_error', httpError && httpError.code);
  const redirected = await fetchIcs(`${FEED}/r1.ics`);
  ok('B5 3 跳重定向可用', redirected.text.includes('UID:holiday-1'));
  let loopError = null;
  try { await fetchIcs(`${FEED}/loop.ics`); } catch (err) { loopError = err; }
  eq('B6 自环 → subscription_redirect_loop', 'subscription_redirect_loop', loopError && loopError.code);
  let bigError = null;
  try { await fetchIcs(`${FEED}/big.ics`); } catch (err) { bigError = err; }
  eq('B7 超过 10 MB → subscription_too_large', 'subscription_too_large', bigError && bigError.code);
  let timeoutError = null;
  try { await fetchIcs(`${FEED}/slow.ics`, { timeoutMs: 60 }); } catch (err) { timeoutError = err; }
  eq('B8 超时 → subscription_timeout', 'subscription_timeout', timeoutError && timeoutError.code);

  /* ============================================================ C 同步 */
  const admin = await login();
  const created = await api('/api/v1/calendars', {
    method: 'POST',
    session: admin,
    body: { displayName: '节假日订阅', color: '#3f7bd9', subscriptionUrl: `${FEED}/feed.ics`, syncIntervalMin: 60 },
  });
  eq('C0 新建订阅日历 201', 201, created.status);
  const subId = created.body && created.body.calendar ? created.body.calendar.id : '';
  ok('C1 视图 isSubscription', created.body.calendar.isSubscription === true, JSON.stringify(created.body.calendar));
  ok('C2 视图 readOnly', created.body.calendar.readOnly === true);
  eq('C3 视图间隔', 60, created.body.calendar.syncIntervalMin);
  eq('C4 视图状态 never', 'never', created.body.calendar.lastSyncStatus);

  const userId = admin.body.uid;
  const readMeta = () => app.store.readCalendarMeta(userId, subId);
  const syncOne = () => api(`/api/v1/calendars/${subId}/sync`, { method: 'POST', session: admin });

  const first = await syncOne();
  eq('C5 首次同步 200', 200, first.status);
  eq('C6 首次导入 2 条', 2, first.body.imported);
  let meta = await readMeta();
  eq('C7 同步后状态 ok', 'ok', meta.lastSyncStatus);
  ok('C8 同步后记 ETag', meta.lastSyncEtag === '"feed-v1"', meta.lastSyncEtag);
  ok('C9 同步后写 lastSyncAt', Boolean(meta.lastSyncAt));

  const second = await syncOne();
  eq('C10 源未变 → notModified', true, second.body.notModified);
  eq('C11 notModified 时不导入', 0, second.body.imported);
  eq('C12 请求带 If-None-Match', '"feed-v1"', remote.lastIfNoneMatch);

  remote.etag = '"feed-v2"';
  remote.body = icsWith([
    { uid: 'holiday-1', summary: '元旦', start: NOW, end: NOW + HOUR },
    { uid: 'holiday-2', summary: '初二', start: NOW + 24 * HOUR, end: NOW + 25 * HOUR },
    { uid: 'holiday-3', summary: '初三', start: NOW + 48 * HOUR, end: NOW + 49 * HOUR },
  ]);
  const third = await syncOne();
  eq('C13 源变化再同步 200', 200, third.status);
  eq('C14 新增 1 条', 1, third.body.imported);
  meta = await readMeta();
  eq('C15 ETag 更新', '"feed-v2"', meta.lastSyncEtag);

  remote.fail = true;
  const failed = await syncOne();
  eq('C16 源 500 → 502', 502, failed.status);
  eq('C17 错误码 http_error', 'subscription_http_error', failed.body && failed.body.code);
  meta = await readMeta();
  eq('C18 失败记状态 error', 'error', meta.lastSyncStatus);
  ok('C19 失败记错误摘要', Boolean(meta.lastSyncError));
  eq('C20 失败不动 ETag', '"feed-v2"', meta.lastSyncEtag);
  const rowAfterFail = await calendarRow(admin, subId);
  eq('C21 失败保留旧数据（3 条）', 3, rowAfterFail.eventCount);

  remote.fail = false;
  remote.etag = '"feed-v2"';
  const recovered = await syncOne();
  eq('C22 恢复后同步 200', 200, recovered.status);
  meta = await readMeta();
  eq('C23 恢复后错误清空', '', meta.lastSyncError);
  eq('C24 恢复后状态 ok', 'ok', meta.lastSyncStatus);

  /* ============================================================ D REST */
  const invalidUrl = await api('/api/v1/calendars', {
    method: 'POST', session: admin, body: { displayName: '坏地址', subscriptionUrl: 'ftp://example.com/a.ics' },
  });
  eq('D1 非法订阅地址 400', 400, invalidUrl.status);
  eq('D2 错误码 invalid_subscription_url', 'invalid_subscription_url', invalidUrl.body && invalidUrl.body.code);
  const invalidInterval = await api('/api/v1/calendars', {
    method: 'POST', session: admin, body: { displayName: '坏间隔', subscriptionUrl: `${FEED}/feed.ics`, syncIntervalMin: 7 },
  });
  eq('D3 非法间隔 400', 400, invalidInterval.status);
  eq('D4 错误码 invalid_sync_interval', 'invalid_sync_interval', invalidInterval.body && invalidInterval.body.code);

  const plainCal = await api('/api/v1/calendars', {
    method: 'POST', session: admin, body: { displayName: '普通日历', color: '#778899' },
  });
  eq('D5 普通日历 201', 201, plainCal.status);
  ok('D6 普通日历不只读', plainCal.body.calendar.readOnly === false);
  const plainId = plainCal.body.calendar.id;
  const plainPatch = await api(`/api/v1/calendars/${plainId}`, {
    method: 'PATCH', session: admin, body: { subscriptionUrl: `${FEED}/feed.ics` },
  });
  eq('D7 普通日历改成订阅 → 400', 400, plainPatch.status);
  eq('D8 错误码 subscription_requires_new_calendar', 'subscription_requires_new_calendar', plainPatch.body && plainPatch.body.code);

  const syncPlain = await api(`/api/v1/calendars/${plainId}/sync`, { method: 'POST', session: admin });
  eq('D9 非订阅日历同步 → 409', 409, syncPlain.status);
  eq('D10 错误码 not_a_subscription', 'not_a_subscription', syncPlain.body && syncPlain.body.code);

  remote.etag = '"feed-v3"';
  remote.body = icsWith([{ uid: 'holiday-1', summary: '元旦', start: NOW, end: NOW + HOUR }]);
  const patchUrl = await api(`/api/v1/calendars/${subId}`, {
    method: 'PATCH', session: admin, body: { subscriptionUrl: `${FEED}/feed.ics?x=2` },
  });
  eq('D11 订阅日历改地址 200', 200, patchUrl.status);
  const metaAfterUrl = await readMeta();
  eq('D12 改地址清掉旧 ETag 后重新同步 → 新 ETag', '"feed-v3"', metaAfterUrl.lastSyncEtag);
  const rowAfterUrl = await calendarRow(admin, subId);
  eq('D13 改地址后立即同步一次（剩 1 条）', 1, rowAfterUrl.eventCount);
  eq('D14 返回 sync 结果', true, patchUrl.body.sync && patchUrl.body.sync.ok, JSON.stringify(patchUrl.body.sync));

  remote.etag = '"feed-v4"';
  const manualSync = await api(`/api/v1/calendars/${subId}/sync`, { method: 'POST', session: admin });
  eq('D15 立即同步 200', 200, manualSync.status);
  ok('D16 立即同步返回 calendar', Boolean(manualSync.body.calendar));

  // 订阅上限 10：已建 1 个，再建 9 个到顶，第 11 个 409。
  let limitHit = null;
  for (let i = 0; i < 9; i += 1) {
    const extra = await api('/api/v1/calendars', {
      method: 'POST', session: admin, body: { displayName: `订阅${i}`, subscriptionUrl: `${FEED}/feed.ics?n=${i}` },
    });
    if (extra.status !== 201) limitHit = { at: i, res: extra };
  }
  eq('D17 第 10 个订阅仍可建', null, limitHit);
  const overLimit = await api('/api/v1/calendars', {
    method: 'POST', session: admin, body: { displayName: '第 11 个订阅', subscriptionUrl: `${FEED}/feed.ics?n=11` },
  });
  eq('D18 超过 10 个订阅 → 409', 409, overLimit.status);
  eq('D19 错误码 subscription_limit', 'subscription_limit', overLimit.body && overLimit.body.code);

  /* ============================================================ E 只读 */
  const kvWrite = await api(`/api/v1/kv/cal:${subId}:evt:probe-0846`, {
    method: 'PUT', session: admin, body: { id: 'probe-0846', title: '写入', start: NOW, end: NOW + HOUR, calendarId: subId },
  });
  eq('E1 REST 写订阅日历 403', 403, kvWrite.status);
  eq('E2 错误码 calendar_read_only', 'calendar_read_only', kvWrite.body && kvWrite.body.code);

  const davBody = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FnCal//m76//EN\r\nBEGIN:VEVENT\r\nUID:dav-probe\r\nDTSTAMP:${stamp(NOW)}\r\nDTSTART:${stamp(NOW)}\r\nDTEND:${stamp(NOW + HOUR)}\r\nSUMMARY:dav probe\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const davPut = await fetch(`${BASE}/calendars/admin/${subId}/dav-probe.ics`, {
    method: 'PUT',
    headers: { Authorization: BASIC, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: davBody,
  });
  eq('E3 DAV 写订阅日历 403', 403, davPut.status);
  const davGet = await fetch(`${BASE}/calendars/admin/${subId}/`, {
    method: 'PROPFIND',
    headers: { Authorization: BASIC, Depth: '0' },
  });
  eq('E4 DAV 仍可读（PROPFIND 207）', 207, davGet.status);

  /* ============================================================ F 定时器 */
  const ticked = [];
  const fakeStore = {
    listCalendarMetas() {
      return [
        { id: 'due', subscriptionUrl: 'https://example.com/a.ics', syncIntervalMin: 15, lastSyncAt: null },
        { id: 'fresh', subscriptionUrl: 'https://example.com/b.ics', syncIntervalMin: 60, lastSyncAt: new Date(NOW).toISOString() },
        { id: 'manual', subscriptionUrl: 'https://example.com/c.ics', syncIntervalMin: 0, lastSyncAt: null },
        { id: 'plain', subscriptionUrl: '', syncIntervalMin: 60, lastSyncAt: null },
      ];
    },
    updateCalendarMeta() {},
  };
  const scheduler = createSubscriptionScheduler({
    store: fakeStore,
    accounts: { all: async () => [{ id: 'u1' }] },
    // 30 分钟后：due（15 分钟间隔）到点，fresh（60 分钟、刚同步）未到点。
    now: () => NOW + 30 * 60 * 1000,
    sync: async ({ calendarId }) => { ticked.push(calendarId); return { ok: true }; },
  });
  const tickResult = await scheduler.tick();
  eq('F1 扫描到 2 个自动订阅', 2, tickResult.scanned);
  eq('F2 只同步到点那一个', 1, tickResult.synced);
  eq('F3 同步的是 due', 'due', ticked.join(','));

  let reentry = 0;
  const slowScheduler = createSubscriptionScheduler({
    store: {
      listCalendarMetas: () => [{ id: 'due', subscriptionUrl: 'https://example.com/a.ics', syncIntervalMin: 15, lastSyncAt: null }],
      updateCalendarMeta() {},
    },
    accounts: { all: async () => [{ id: 'u1' }] },
    now: () => NOW,
    sync: async () => { reentry += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: true }; },
  });
  await Promise.all([slowScheduler.tick(), slowScheduler.tick()]);
  eq('F4 并发 tick 不重入', 1, reentry);
  /* ============================================================ G 0.8.47 失败分类与测试地址 */
  const gz = await fetchIcs(`${FEED}/gzip.ics`);
  ok('G1 gzip 正文只解压一次', gz.text.startsWith('BEGIN:VCALENDAR') && gz.text.includes('UID:holiday-1'), gz.text.slice(0, 40));
  const plainType = await fetchIcs(`${FEED}/plain.ics`);
  ok('G2 text/plain 也接受（以正文判定）', plainType.text.includes('BEGIN:VCALENDAR'));
  let notIcs = null;
  try { await fetchIcs(`${FEED}/html`); } catch (err) { notIcs = err; }
  eq('G3 非 ICS → subscription_not_ics', 'subscription_not_ics', notIcs && notIcs.code);
  ok('G4 非 ICS 文案带 Content-Type', /text\/html/.test(String(notIcs && notIcs.message)), String(notIcs && notIcs.message));

  const dnsFetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND chinacalendar.app'), { code: 'ENOTFOUND' }),
    });
  };
  let dnsError = null;
  try { await fetchIcs('https://chinacalendar.app/x.ics', { fetchImpl: dnsFetch }); } catch (err) { dnsError = err; }
  eq('G5 DNS 失败分类', 'subscription_dns', dnsError && dnsError.code);
  ok('G6 DNS 文案说清原因', /域名解析失败/.test(String(dnsError && dnsError.message)), String(dnsError && dnsError.message));

  let attempts = 0;
  const flakyFetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
      });
    }
    return new Response(icsWith([{ uid: 'h1', summary: 'x', start: NOW, end: NOW + HOUR }]), {
      status: 200,
      headers: { 'content-type': 'text/calendar; charset=UTF-8' },
    });
  };
  const retried = await fetchIcs('https://example.com/retry.ics', { fetchImpl: flakyFetch });
  eq('G7 连接失败重试一次', 2, attempts);
  ok('G8 重试成功后拿到正文', retried.text.includes('UID:h1'));

  let timeoutHits = 0;
  const timeoutFetch = async () => {
    timeoutHits += 1;
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  let toErr = null;
  try { await fetchIcs('https://example.com/slow.ics', { fetchImpl: timeoutFetch, timeoutMs: 50 }); } catch (err) { toErr = err; }
  eq('G9 超时不重试', 'subscription_timeout', toErr && toErr.code);
  eq('G10 超时只请求一次', 1, timeoutHits);

  const testOk = await api('/api/v1/calendars/test-subscription', { method: 'POST', session: admin, body: { url: `${FEED}/gzip.ics` } });
  eq('G11 测试地址 200', 200, testOk.status);
  ok('G12 测试结果 ok 且有字节数', testOk.body.result.ok === true && testOk.body.result.bytes > 0, JSON.stringify(testOk.body.result));
  const testBad = await api('/api/v1/calendars/test-subscription', { method: 'POST', session: admin, body: { url: `${FEED}/html` } });
  eq('G13 非 ICS 测试仍 200', 200, testBad.status);
  ok('G14 测试结果带原因', testBad.body.result.ok === false && /不是 ICS/.test(testBad.body.result.message), JSON.stringify(testBad.body.result));
  const testInvalid = await api('/api/v1/calendars/test-subscription', { method: 'POST', session: admin, body: { url: 'ftp://x/a.ics' } });
  eq('G15 非法地址 400', 400, testInvalid.status);

  remote.fail = true;
  await syncOne();
  meta = await readMeta();
  eq('G16 失败原因写入 meta（HTTP 状态）', '订阅地址返回 HTTP 500', meta.lastSyncError);
  remote.fail = false;

  /* ============================================================ H 0.8.52 F.6 TLS 瞬时失败 */
  let tlsAttempts = 0;
  const tlsFlaky = async () => {
    tlsAttempts += 1;
    if (tlsAttempts === 1) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('unable to verify the first certificate'), {
          code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        }),
      });
    }
    return new Response(icsWith([{ uid: 'tls-1', summary: 'tls', start: NOW, end: NOW + HOUR }]), {
      status: 200,
      headers: { 'content-type': 'text/calendar; charset=UTF-8' },
    });
  };
  let tlsOk = null;
  try {
    tlsOk = await fetchIcs('https://tls.example/a.ics', { fetchImpl: tlsFlaky });
  } catch (err) {
    tlsOk = { error: err };
  }
  eq('H1 TLS 第一次失败后重试成功', 2, tlsAttempts);
  ok('H2 重试成功返回正文', Boolean(tlsOk && tlsOk.text && tlsOk.text.includes('BEGIN:VCALENDAR')), String(tlsOk && tlsOk.text && tlsOk.text.slice(0, 30)));

  let tlsFailAttempts = 0;
  const tlsDead = async () => {
    tlsFailAttempts += 1;
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
    });
  };
  let tlsError = null;
  try { await fetchIcs('https://tls.example/dead.ics', { fetchImpl: tlsDead }); } catch (err) { tlsError = err; }
  eq('H3 TLS 两次都失败才报错', 2, tlsFailAttempts);
  eq('H4 错误分类仍是 subscription_tls', 'subscription_tls', tlsError && tlsError.code);
  ok('H5 文案附底层错误码', /CERT_HAS_EXPIRED/.test(String(tlsError && tlsError.message)), String(tlsError && tlsError.message));
  ok('H6 错误码截断不超过 60 字', String(tlsError && tlsError.message).length < 120, String(tlsError && tlsError.message));

} catch (err) {
  failures += 1;
  console.error('[FATAL]', err && err.stack ? err.stack : err);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => remoteServer.close(resolve));
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
