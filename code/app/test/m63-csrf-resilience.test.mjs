// 0.8.31（任务书 §四）：设置保存 CSRF 加固 —— 端到端断言。
//
// 背景：0.8.30 及以前 `validateCsrf` 要求「cookie == header == 期望值」，
// 而 `GET /api/auth/session` 只回 `csrf` 字段、不重发 cookie。令牌一换代
// （改密、退出全部设备）浏览器里的旧 cookie 就让整站写请求永远 403，
// 用户看到的是「设置保存报 CSRF 校验失败」。
//
// 本套覆盖任务书 §四 八条里的服务端七条（第八条是前端，在
// `code/web/tests/api-client-csrf-0831.test.js`）：
//   1. header = 期望值、没有 cookie        -> 200（旧行为 403）
//   2. header = 期望值、cookie 是旧值      -> 200
//   3. header 为空、cookie = 期望值        -> 403
//   4. header = 错值                       -> 403
//   5. GET /api/auth/session 重发 caldav_csrf cookie（值/属性）
//   6. 令牌换代后旧值 403 -> 取会话拿新值 -> 200
//   7. 失败写 app.log 的 csrf-failed 事件，四条布尔齐全，正文无 43 位令牌串
//
// 运行（cwd 必须是 projects/FnCal/code）：node app/test/m63-csrf-resilience.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-csrf-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const LOG_FILE = path.join(TMP, 'logs', 'app.log');
process.env.TRIM_PKGVAR = TMP;
process.env.CALDAV_LOG = LOG_FILE;
process.env.CALDAV_ADMIN_PASSWORD = 'admin-pass-123';
process.env.CALDAV_USER = 'admin';
process.env.CALDAV_AUTH = 'on';
process.env.FNCAL_BCRYPT_ROUNDS = '10';
process.env.CALDAV_SESSION_SECRET = 'csrf-test-session-secret-0123456789';

const { createApp, resolveConfig } = await import('../server.mjs');

let passed = 0;
let failed = 0;
function eq(label, expected, actual, detail = '') {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}${detail ? `\n  ${detail}` : ''}`,
    );
  }
}
function ok(label, value, detail = '') {
  eq(label, true, Boolean(value), detail);
}
function not(label, value) {
  eq(label, true, !value);
}

const app = await createApp(resolveConfig(process.env));
const server = app.server || http.createServer((req, res) => app.handleRequest(req, res, { gateway: false }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const SETTINGS_PATH = '/api/v1/kv/cal%3Asettings';

async function call(pathname, { method = 'GET', cookie = '', csrf = '', body = undefined } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (csrf !== '') headers['x-csrf-token'] = csrf;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, headers: res.headers, setCookies, text, json };
}

function cookieHeader(setCookies, names) {
  return setCookies
    .filter((item) => names.some((name) => item.startsWith(`${name}=`)))
    .map((item) => item.split(';')[0])
    .join('; ');
}
function cookieValue(setCookies, name) {
  const hit = setCookies.find((item) => item.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(';')[0] : '';
}

// ---------------------------------------------------------------- 登录一次
const loginRes = await call('/api/v1/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin-pass-123' },
});
eq('登录 200', 200, loginRes.status);
const loginCsrf = loginRes.json && loginRes.json.csrf;
ok('登录响应给了 csrf', typeof loginCsrf === 'string' && loginCsrf.length > 0);
eq('csrf 长度 43', 43, String(loginCsrf || '').length);
const sessionOnly = cookieHeader(loginRes.setCookies, ['caldav_session']);
const fullCookie = cookieHeader(loginRes.setCookies, ['caldav_session', 'caldav_csrf']);
ok('拿到会话 cookie', sessionOnly.includes('caldav_session='));
ok('登录同时下发了 caldav_csrf', cookieHeader(loginRes.setCookies, ['caldav_csrf']).includes('caldav_csrf='));

// ------------------------------------------- ① header 正确、没有 cookie -> 200
const noCookie = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: sessionOnly,
  csrf: loginCsrf,
  body: { theme: 'dark' },
});
eq('① header 对、无 csrf cookie：200', 200, noCookie.status);

// --------------------------------------- ② header 正确、cookie 是旧值 -> 200
const staleCookie = `${sessionOnly}; caldav_csrf=stale-old-cookie-value`;
const staleCk = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: staleCookie,
  csrf: loginCsrf,
  body: { theme: 'light' },
});
eq('② header 对、cookie 旧值：200', 200, staleCk.status);

// ------------------------ ③ header 为空、cookie = 期望值 -> 200（内网场景）
// 用户实测：内网地址访问必现 403、反代域名正常——内网入口的 X-CSRF-Token
// 可能被网关过滤，所以只认 header 的写法会让内网永远过不去。
const noHeader = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: fullCookie,
  csrf: '',
  body: { theme: 'dark' },
});
eq('③ 无 header、cookie 对：200', 200, noHeader.status);

// ------------------------------ ④ header = 错值、没有 cookie -> 403
const wrongHeader = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: sessionOnly,
  csrf: 'x'.repeat(43),
  body: { theme: 'dark' },
});
eq('④ header 错、无 cookie：403', 403, wrongHeader.status);
eq('④ 错误码是 csrf', 'csrf', wrongHeader.json && wrongHeader.json.code);

// -------------------------------------- ⑤ header 与 cookie 都空 -> 403
const bothEmpty = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: sessionOnly,
  csrf: '',
  body: { theme: 'dark' },
});
eq('⑤ 两者都空：403', 403, bothEmpty.status);
eq('⑤ 错误码是 csrf', 'csrf', bothEmpty.json && bothEmpty.json.code);

// ---------------- ⑤b 两者都有但都错 -> 403（旧 cookie 换代后的典型情形）
const bothWrong = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: `${sessionOnly}; caldav_csrf=${'y'.repeat(43)}`,
  csrf: 'z'.repeat(43),
  body: { theme: 'dark' },
});
eq('⑤b header 与 cookie 都是错值：403', 403, bothWrong.status);

// --------------------------- ⑥ GET /api/auth/session 重发 caldav_csrf cookie
const sessRes = await call('/api/auth/session', { cookie: sessionOnly });
eq('⑥ 会话接口 200', 200, sessRes.status);
const sessCsrf = sessRes.json && sessRes.json.csrf;
const csrfSetCookie = sessRes.setCookies.find((item) => item.startsWith('caldav_csrf='));
ok('⑥ 响应带 Set-Cookie: caldav_csrf', Boolean(csrfSetCookie));
eq('⑥ cookie 值与 csrf 字段相同', sessCsrf, cookieValue(sessRes.setCookies, 'caldav_csrf'));
ok('⑥ 未设置 HttpOnly', !/;\s*HttpOnly/i.test(csrfSetCookie || ''));
ok('⑥ SameSite=Lax', /;\s*SameSite=Lax/i.test(csrfSetCookie || ''));
ok('⑥ Path=/', /;\s*Path=\//i.test(csrfSetCookie || ''));
ok('⑥ 会话给的 csrf 与登录时同代', sessCsrf === loginCsrf);

// ------------------ ⑦ 改密（tokenVersion 换代）：旧值 403 -> 取会话 -> 200
const NEW_PASS = 'new-admin-pass-456';
const changeRes = await call('/api/v1/auth/password', {
  method: 'POST',
  cookie: fullCookie,
  csrf: loginCsrf,
  body: { oldPassword: 'admin-pass-123', newPassword: NEW_PASS },
});
eq('⑦ 改密 200', 200, changeRes.status);
const newSessionOnly = cookieHeader(changeRes.setCookies, ['caldav_session']);
ok('⑦ 改密后拿到新会话 cookie', newSessionOnly.includes('caldav_session='));

const oldTokenWithNewSession = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: `${newSessionOnly}; caldav_csrf=${loginCsrf}`, // 换代前的令牌（header 与 cookie 都是）
  csrf: loginCsrf,
  body: { theme: 'dark' },
});
eq('⑦ 换代后旧令牌：403', 403, oldTokenWithNewSession.status);
eq('⑦ 错误码是 csrf', 'csrf', oldTokenWithNewSession.json && oldTokenWithNewSession.json.code);

const refreshed = await call('/api/auth/session', { cookie: newSessionOnly });
eq('⑦ 再取会话 200', 200, refreshed.status);
const freshCsrf = refreshed.json && refreshed.json.csrf;
ok('⑦ 新令牌与旧令牌不同', freshCsrf && freshCsrf !== loginCsrf);
const healed = await call(SETTINGS_PATH, {
  method: 'PUT',
  cookie: `${newSessionOnly}; ${cookieHeader(refreshed.setCookies, ['caldav_csrf'])}`,
  csrf: freshCsrf,
  body: { theme: 'dark' },
});
eq('⑦ 用会话里的新令牌：200', 200, healed.status);

// ---------------------------------- ⑧ app.log 的 csrf-failed 事件（无令牌值）
await new Promise((resolve) => setTimeout(resolve, 120));
const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
const csrfLines = logText
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((rec) => rec && rec.event === 'csrf-failed');
ok('⑧ app.log 有 csrf-failed 事件', csrfLines.length >= 3);
const first = csrfLines[0] || {};
for (const field of ['hasHeader', 'hasCookie', 'headerMatchesExpected', 'cookieMatchesExpected']) {
  eq(`⑧ 字段 ${field} 是布尔`, 'boolean', typeof first[field]);
}
eq('⑧ 记录方法', 'PUT', first.method);
eq('⑧ 记录路径', SETTINGS_PATH, first.path);
eq('⑧ 记录用户名', 'admin', first.username);
// 两者都空那次：hasHeader=false、hasCookie=false
const bothEmptyLine = csrfLines.find((rec) => rec.hasHeader === false) || {};
eq('⑧ 两者都空那次 hasCookie=false', false, bothEmptyLine.hasCookie);
eq('⑧ 两者都空那次 headerMatchesExpected=false', false, bothEmptyLine.headerMatchesExpected);
// 两者都有但都错那次：hasHeader=true、hasCookie=true、两个匹配都 false
const bothWrongLine = csrfLines.find((rec) => rec.hasHeader === true && rec.hasCookie === true) || {};
eq('⑧ 两者都有但都错 headerMatchesExpected=false', false, bothWrongLine.headerMatchesExpected);
eq('⑧ 两者都有但都错 cookieMatchesExpected=false', false, bothWrongLine.cookieMatchesExpected);
// 正文里不能出现 43 位令牌串（base64url 字符集）
const tokenLike = csrfLines.filter((rec) => /[A-Za-z0-9_-]{43}/.test(JSON.stringify(rec)));
eq('⑧ 记录里没有 43 位令牌串', 0, tokenLike.length);
not('⑧ 记录里没有 login 的令牌值', logText.includes(String(loginCsrf)));

// --------------------- ⑨ 未认证写请求的 auth-failed（任务书「三之二」7b）
const PROBE_PATH = '/api/v1/kv/cal%3Acrlfprobe';
const anonymousWrite = await call(PROBE_PATH, {
  method: 'PUT',
  cookie: '',
  csrf: '',
  body: { theme: 'dark' },
});
eq('⑨ 未认证写请求：401', 401, anonymousWrite.status);
// 同一 path 再发两次：每分钟只记 1 条
await call(PROBE_PATH, { method: 'PUT', cookie: '', csrf: '', body: { theme: 'dark' } });
await call(PROBE_PATH, { method: 'PUT', cookie: '', csrf: '', body: { theme: 'dark' } });
// 有 cookie 但无效：session_invalid
const PROBE_PATH_2 = '/api/v1/kv/cal%3Acrlfprobe2';
const staleWrite = await call(PROBE_PATH_2, {
  method: 'PUT',
  cookie: 'caldav_session=v1.bogus.value',
  csrf: '',
  body: { theme: 'dark' },
});
eq('⑨ 无效 cookie 写请求：401', 401, staleWrite.status);

await new Promise((resolve) => setTimeout(resolve, 150));
const logAgain = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
const authLines = logAgain
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((rec) => rec && rec.event === 'auth-failed');
ok('⑨ app.log 有 auth-failed 事件', authLines.length >= 2);
const anon = authLines.filter((rec) => rec.path === PROBE_PATH);
eq('⑨ 同 path 一分钟内只记 1 条', 1, anon.length);
const anonRec = anon[0] || {};
eq('⑨ reason=no_credentials', 'no_credentials', anonRec.reason);
eq('⑨ via=none（没有 cookie、没有 Basic）', 'none', anonRec.via);
eq('⑨ hasCookie=false', false, anonRec.hasCookie);
eq('⑨ hasCsrfCookie=false', false, anonRec.hasCsrfCookie);
eq('⑨ proto=http', 'http', anonRec.proto);
eq('⑨ method=PUT', 'PUT', anonRec.method);
eq('⑨ 记录 remoteAddress', true, typeof anonRec.remoteAddress === 'string' && anonRec.remoteAddress.length > 0);
const staleRec = authLines.find((rec) => rec.path === PROBE_PATH_2) || {};
eq('⑨ 无效 cookie 的 reason=session_invalid', 'session_invalid', staleRec.reason);
eq('⑨ 无效 cookie 的 via=cookie', 'cookie', staleRec.via);
eq('⑨ 无效 cookie 的 hasCookie=true', true, staleRec.hasCookie);
// 八字段齐全 + 不含 cookie 值与令牌值
const fields = [
  'reason', 'via', 'hasCookie', 'hasCsrfCookie', 'proto', 'method', 'path', 'remoteAddress',
];
const missing = fields.filter((field) => !(field in anonRec));
eq('⑨ 八字段齐全', 0, missing.length);
not('⑨ 记录里没有 bogus cookie 值', logAgain.includes('v1.bogus.value'));
not('⑨ 记录里没有 login 的令牌值', logAgain.includes(String(loginCsrf)));

await new Promise((resolve) => server.close(resolve));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(
  `\n${failed === 0 ? 'OK' : 'FAILED'} (${passed + failed} assertions, ${passed} passed, ${failed} failed) — 0.8.31 csrf resilience`,
);
process.exit(failed === 0 ? 0 : 1);
