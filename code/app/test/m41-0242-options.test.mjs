#!/usr/bin/env node
/**
 * 0.2.42 CalDAV 兼容：未认证 OPTIONS 必须返回 200 + DAV 能力头。
 *
 * 背景：Windows「邮件和日历」（Dav.Client）建账户时先发不带凭据的 OPTIONS，
 * 收到 401 就放弃（表现为「操作超时 / NO RESPONSE」）。RFC 4918 §10.1 未要求
 * OPTIONS 认证，公开能力头不泄露数据；其它方法必须继续要求认证。
 *
 * 覆盖：
 *   ① 无凭据 OPTIONS / → 200，DAV/Allow/MS-Author-Via 齐备，且不带 WWW-Authenticate；
 *   ② 无凭据 OPTIONS /principals/、/calendars/ 及其账号子路径 → 200；
 *   ③ 未认证 PROPFIND 仍 401（数据接口不放宽）；
 *   ④ 错误 Basic 的 OPTIONS 仍 200（OPTIONS 不参与认证）；
 *   ⑤ 正确 Basic 的 OPTIONS → 200 且能力头与无凭据时一致；
 *   ⑥ .well-known/caldav 仍 302（不受影响）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0242-options-${process.pid}`);
// 临时目录固定在 code/build-tmp，结束后清掉，避免被 assemble 收进包。
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

const { createApp, resolveConfig } = await import('../server.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

try {
  /* ---------- ① 无凭据 OPTIONS / ---------- */
  const bare = await call('/', { method: 'OPTIONS' });
  eq('无凭据 OPTIONS / 返回 200', 200, bare.status);
  const dav = bare.headers.get('dav') || '';
  record('DAV 头广告 calendar-access + sync-collection', 'calendar-access,sync-collection', dav,
    /calendar-access/.test(dav) && /sync-collection/.test(dav));
  const allow = bare.headers.get('allow') || '';
  const need = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR', 'PUT', 'DELETE'];
  record('Allow 广告已实现的方法', need.join(','), allow,
    need.every((m) => allow.split(/\s*,\s*/).includes(m)));
  record('Allow 不广告未实现的方法（MKCOL/MOVE/COPY）', 'absent',
    /MKCOL|MOVE|COPY/.test(allow) ? 'present' : 'absent', !/MKCOL|MOVE|COPY/.test(allow));
  eq('MS-Author-Via: DAV', 'DAV', bare.headers.get('ms-author-via'));
  eq('未认证 OPTIONS 不带 WWW-Authenticate', null, bare.headers.get('www-authenticate'));
  record('OPTIONS 响应体非空', 'truthy', bare.text.length > 0 ? `${bare.text.length} chars` : 'empty', bare.text.length > 0);

  /* ---------- ② 无凭据 OPTIONS 各路径 ---------- */
  for (const p of ['/principals/', '/calendars/', '/principals/admin/', '/calendars/admin/']) {
    const r = await call(p, { method: 'OPTIONS' });
    eq(`无凭据 OPTIONS ${p} 返回 200`, 200, r.status);
  }

  /* ---------- ③ 数据接口不放宽 ---------- */
  const pf = await call('/', {
    method: 'PROPFIND',
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  eq('未认证 PROPFIND / 仍 401', 401, pf.status);
  record('未认证 PROPFIND 带 Basic challenge', 'Basic realm="caldav"',
    pf.headers.get('www-authenticate') || '', /^Basic realm="caldav"/.test(pf.headers.get('www-authenticate') || ''));
  const rep = await call('/', {
    method: 'REPORT',
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/>',
  });
  eq('未认证 REPORT / 仍 401', 401, rep.status);

  /* ---------- ④ 错误凭据的 OPTIONS ---------- */
  const wrong = await call('/', { method: 'OPTIONS', headers: { Authorization: basic('admin', 'wrong-pass-999') } });
  eq('错误凭据 OPTIONS 仍 200（不参与认证）', 200, wrong.status);
  eq('错误凭据 OPTIONS 也不带 WWW-Authenticate', null, wrong.headers.get('www-authenticate'));

  /* ---------- ⑤ 正确凭据的 OPTIONS 不变 ---------- */
  const authed = await call('/', { method: 'OPTIONS', headers: { Authorization: basic('admin', 'admin-pass-123') } });
  eq('正确凭据 OPTIONS 仍 200', 200, authed.status);
  eq('有/无凭据的 DAV 头一致', dav, authed.headers.get('dav') || '');
  eq('有/无凭据的 Allow 一致', allow, authed.headers.get('allow') || '');

  /* ---------- ⑥ .well-known 不受影响 ---------- */
  const wk = await call('/.well-known/caldav', { method: 'GET' });
  eq('GET /.well-known/caldav 仍 302', 302, wk.status);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
// 输出格式与其余后端测试一致（run-backend-*.ps1 用 `SUMMARY: pass=X fail=Y` 解析）。
if (failures) {
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} checks=${results.length}`);
  process.exit(1);
}
console.log(`\nSUMMARY: pass=${passed} fail=0 checks=${results.length}`);
