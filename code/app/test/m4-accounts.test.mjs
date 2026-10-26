#!/usr/bin/env node
/**
 * M4 / 0.1.2 — 账号安全入口（强制改密 / 登出全部设备 / 管理员建号与重置）。
 *
 * 走的是**全新安装**的真实路径：var 目录为空、`CALDAV_ADMIN_PASSWORD=""`，
 * 服务端生成随机初始密码并写 `<var>/admin-initial-password.txt`；测试从磁盘
 * 读回该密码登录，验证：
 *
 *   1. 随机初始密码 → 会话返回 mustChangePassword=true；
 *   2. 旧密码改密失败（401）、缺 CSRF 失败（403 中文）、改密成功清标记；
 *   3. 改密后旧密码 401、新密码 200（真实 HTTP，不 mock）；
 *   4. 管理员建号 → 管理员自设密码即最终密码，不强制改密（0.2.4 保留）；
 *   5. 管理员重置密码（0.2.8）→ 固定默认密码 1234567890 + 强制首登改密：
 *      未改密时业务 API 403；改密后可正常用；默认密码与重置前密码都失效；
 *   6. 停用后旧会话立即 401、登录也 401；
 *   7. 普通用户访问 /api/v1/admin/users → 403；
 *   8. POST /api/v1/auth/logout-all：无会话 401、缺 CSRF 403、成功后旧 Cookie
 *      全部失效、密码本身仍可重新登录；
 *   9. 审计含「管理员重置密码」「用户首次登录改密」两条事件且不含密码明文；
 *  10. 未改密时 DAV（Basic 与 Web cookie 两条路径）403 拒绝，改密后立即恢复。
 *
 * 本文件是「全新安装 + 强制改密」的后端证据；浏览器里的不可跳过错觉由
 * `code/web/tests/force-password.test.js` 覆盖。
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_M4_PORT || 5297);
const BASE = `http://127.0.0.1:${PORT}`;
// 数据目录可用环境变量换一个干净目录：固定的 `.var-*` 一旦被上一次运行留下的
// 外来权限项占住，本机删除会报 EPERM，整个文件直接 FATAL（与产品代码无关）。
const VAR_DIR = `.var-m4-test${process.env.CALDAV_TEST_VAR_SUFFIX || ''}`;

const results = [];
let failures = 0;
let child = null;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function pickCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = (name) => {
    const hit = setCookies.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1).split(';')[0] : '';
  };
  return { session: pick('caldav_session'), csrf: pick('caldav_csrf') };
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ...pickCookies(res) };
}

async function rest(session, method, pathname, { body, csrf = true, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `caldav_session=${session.session}; caldav_csrf=${session.csrf}`,
      ...(csrf && session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function stopServer() {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  }).catch(() => {});
}

async function main() {
  const varPath = path.join(appRoot, VAR_DIR);
  await fs.rm(varPath, { recursive: true, force: true });
  await fs.mkdir(varPath, { recursive: true });

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: varPath,
      CALDAV_USER: 'admin',
      // 空串 = 让应用生成随机初始密码（与正式包未提供密码时的路径一致）。
      CALDAV_ADMIN_PASSWORD: '',
      CALDAV_AUTH: 'on',
    },
    stdio: 'ignore',
  });
  await waitForServer();

  const initialFile = path.join(varPath, 'admin-initial-password.txt');
  let initialPassword = '';
  try {
    initialPassword = (await fs.readFile(initialFile, 'utf8')).trim();
  } catch {
    /* asserted below */
  }
  record('全新安装：生成随机初始密码文件（非空）', 'non-empty 0600 file',
    initialPassword ? `len=${initialPassword.length}` : 'missing',
    initialPassword.length >= 16);

  const accountsFile = path.join(varPath, 'accounts.json');
  const seeded = JSON.parse(await fs.readFile(accountsFile, 'utf8'));
  const adminId = seeded.accounts[0].id;
  record('全新安装：accounts.json 里管理员 mustChangePassword=true', 'true',
    String(Boolean(seeded.accounts[0].mustChangePassword)), Boolean(seeded.accounts[0].mustChangePassword));

  /* ---------------- 1. 首次登录拿到强制改密标记 ---------------------- */
  const first = await login('admin', initialPassword);
  record('首登：随机密码登录 200 + 会话 Cookie', '200 + session/csrf',
    `${first.status} ${first.session ? 'session' : '-'}/${first.csrf ? 'csrf' : '-'}`,
    first.status === 200 && Boolean(first.session) && Boolean(first.csrf));
  record('首登：登录响应 mustChangePassword=true', 'true',
    String(first.json.mustChangePassword), first.json.mustChangePassword === true);

  let adminSession = { session: first.session, csrf: first.csrf };
  const session1 = await rest(adminSession, 'GET', '/api/v1/auth/session');
  record('首登：/auth/session 返回 mustChangePassword=true', '200 + true',
    `${session1.status} ${session1.json && session1.json.mustChangePassword}`,
    session1.status === 200 && session1.json && session1.json.mustChangePassword === true);
  record('首登：/auth/session 含 uid/role', 'uid+role',
    `${session1.json && session1.json.uid ? 'uid' : '-'}/${session1.json && session1.json.role}`,
    Boolean(session1.json && session1.json.uid && session1.json.role === 'admin'));

  /* ---------------- 2. 改密校验与成功路径 ---------------------------- */
  const wrongOld = await rest(adminSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: 'definitely-wrong', newPassword: 'M4-Admin-Pass-New-1' },
  });
  record('改密：旧密码错误 → 401', '401', String(wrongOld.status), wrongOld.status === 401);

  const noCsrf = await rest(adminSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: initialPassword, newPassword: 'M4-Admin-Pass-New-1' },
    csrf: false,
  });
  record('改密：缺 CSRF → 403 + 中文 message', '403 + 中文',
    `${noCsrf.status} ${noCsrf.json && noCsrf.json.message}`,
    noCsrf.status === 403 && Boolean(noCsrf.json && /[\u4e00-\u9fa5]/.test(noCsrf.json.message || '')));

  const weak = await rest(adminSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: initialPassword, newPassword: 'short' },
  });
  record('改密：新密码过短 → 400', '400', String(weak.status), weak.status === 400);

  const changed = await rest(adminSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: initialPassword, newPassword: 'M4-Admin-Pass-New-1' },
  });
  record('改密：成功 → 200 + mustChangePassword=false', '200 + false',
    `${changed.status} ${changed.json && changed.json.mustChangePassword}`,
    changed.status === 200 && changed.json && changed.json.mustChangePassword === false);
  const freshCookies = pickCookies({ headers: changed.headers });
  if (freshCookies.session) adminSession = freshCookies;
  record('改密：响应下发新会话 Cookie（旧 Cookie 已因 tokenVersion 失效）', 'new cookies',
    freshCookies.session ? 'new-cookie' : 'missing', Boolean(freshCookies.session));

  const afterChangeSession = await rest(adminSession, 'GET', '/api/v1/auth/session');
  record('改密后：会话 mustChangePassword=false', 'false',
    String(afterChangeSession.json && afterChangeSession.json.mustChangePassword),
    afterChangeSession.json && afterChangeSession.json.mustChangePassword === false);

  const oldLogin = await login('admin', initialPassword);
  record('改密后：旧密码登录 → 401', '401', String(oldLogin.status), oldLogin.status === 401);

  const newLogin = await login('admin', 'M4-Admin-Pass-New-1');
  record('改密后：新密码登录 → 200 + 不再强制改密', '200 + false',
    `${newLogin.status} ${newLogin.json.mustChangePassword}`,
    newLogin.status === 200 && newLogin.json.mustChangePassword === false);
  adminSession = { session: newLogin.session, csrf: newLogin.csrf };

  const persisted = JSON.parse(await fs.readFile(accountsFile, 'utf8'));
  record('改密后：accounts.json 标记已清除', 'false',
    String(Boolean(persisted.accounts[0].mustChangePassword)),
    persisted.accounts[0].mustChangePassword === false);

  /* ---------------- 3. 管理员建号 → 密码即最终密码（0.2.4） ---------- */
  const created = await rest(adminSession, 'POST', '/api/v1/admin/users', {
    body: { username: 'dave', displayName: 'Dave', password: 'M4-Dave-Pass-1', role: 'user' },
  });
  record('管理员建号：201 + mustChangePassword=false（设置即生效）', '201 + false',
    `${created.status} ${created.json && created.json.user && created.json.user.mustChangePassword}`,
    created.status === 201 && created.json && created.json.user && created.json.user.mustChangePassword === false);
  const daveId = created.json && created.json.user && created.json.user.id;

  const daveFirst = await login('dave', 'M4-Dave-Pass-1');
  record('管理员建号：新账号用所设密码登录 200 + 不强制改密', '200 + false',
    `${daveFirst.status} ${daveFirst.json.mustChangePassword}`,
    daveFirst.status === 200 && daveFirst.json.mustChangePassword === false);
  let daveSession = { session: daveFirst.session, csrf: daveFirst.csrf };

  const daveList = await rest(daveSession, 'GET', '/api/v1/admin/users');
  record('普通用户 GET /admin/users → 403', '403', String(daveList.status), daveList.status === 403);
  const daveCreate = await rest(daveSession, 'POST', '/api/v1/admin/users', {
    body: { username: 'mallory', password: 'M4-Mallory-1', role: 'user' },
  });
  record('普通用户 POST /admin/users → 403', '403', String(daveCreate.status), daveCreate.status === 403);

  const daveChanged = await rest(daveSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: 'M4-Dave-Pass-1', newPassword: 'M4-Dave-Pass-2' },
  });
  record('新账号自助改密：200 + 标记清除', '200 + false',
    `${daveChanged.status} ${daveChanged.json && daveChanged.json.mustChangePassword}`,
    daveChanged.status === 200 && daveChanged.json && daveChanged.json.mustChangePassword === false);
  const daveCookies = pickCookies({ headers: daveChanged.headers });
  if (daveCookies.session) daveSession = daveCookies;

  /* ------- 4. 管理员重置密码 → 固定默认密码 + 强制首登改密（0.2.8） ---- */
  const reset = await rest(adminSession, 'PATCH', `/api/v1/admin/users/${daveId}`, {
    body: { resetPassword: true },
  });
  record('管理员重置密码：200 + mustChangePassword=true（固定默认密码）', '200 + true',
    `${reset.status} ${reset.json && reset.json.user && reset.json.user.mustChangePassword}`,
    reset.status === 200 && reset.json && reset.json.user && reset.json.user.mustChangePassword === true);

  const staleDave = await rest(daveSession, 'GET', '/api/v1/auth/session');
  record('管理员重置后：用户旧会话立即 401', '401', String(staleDave.status), staleDave.status === 401);

  const oldDavePw = await login('dave', 'M4-Dave-Pass-2');
  record('重置后：重置前的密码失效 → 401', '401', String(oldDavePw.status), oldDavePw.status === 401);

  const daveResetLogin = await login('dave', '1234567890');
  record('重置后：默认密码 1234567890 登录 200 + mustChangePassword=true', '200 + true',
    `${daveResetLogin.status} ${daveResetLogin.json.mustChangePassword}`,
    daveResetLogin.status === 200 && daveResetLogin.json.mustChangePassword === true);
  daveSession = { session: daveResetLogin.session, csrf: daveResetLogin.csrf };

  const blockedKv = await rest(daveSession, 'GET', '/api/v1/kv?pattern=cal:evt:*');
  record('未改密：业务 API（KV 读）→ 403 + 中文 code=password_change_required', '403 + 中文 code',
    `${blockedKv.status} ${blockedKv.json && blockedKv.json.code} ${blockedKv.json && blockedKv.json.message}`,
    blockedKv.status === 403 && blockedKv.json && blockedKv.json.code === 'password_change_required'
      && /[\u4e00-\u9fa5]/.test(blockedKv.json.message || ''));
  const blockedCal = await rest(daveSession, 'GET', '/api/v1/calendars');
  record('未改密：/api/v1/calendars → 403', '403', String(blockedCal.status), blockedCal.status === 403);
  const sessionReadable = await rest(daveSession, 'GET', '/api/v1/auth/session');
  record('未改密：/auth/session 仍可读（改密页依赖）', '200 + true',
    `${sessionReadable.status} ${sessionReadable.json && sessionReadable.json.mustChangePassword}`,
    sessionReadable.status === 200 && sessionReadable.json.mustChangePassword === true);

  // 0.2.8（安全）：未改密时 DAV 也必须拒绝（Basic 与 Web cookie 两条路径）。
  // 默认密码 1234567890 是公开值，不拦 DAV 等于把日历暴露给任何知道用户名的人。
  const basicAuth = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const davPropfind = (pathname, headers) => fetch(`${BASE}${pathname}`, {
    method: 'PROPFIND',
    headers: { Depth: '0', 'Content-Type': 'application/xml', ...headers },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  const davBlockedBasic = await davPropfind('/calendars/dave/default/', {
    Authorization: basicAuth('dave', '1234567890'),
  });
  record('未改密：DAV Basic（默认密码）→ 403 拒绝', '403', String(davBlockedBasic.status), davBlockedBasic.status === 403);
  const davBlockedCookie = await davPropfind('/calendars/dave/default/', {
    Cookie: `caldav_session=${daveSession.session}; caldav_csrf=${daveSession.csrf}`,
  });
  record('未改密：DAV Web 会话 → 403 拒绝', '403', String(davBlockedCookie.status), davBlockedCookie.status === 403);
  const davWrongPass = await davPropfind('/calendars/dave/default/', {
    Authorization: basicAuth('dave', 'definitely-wrong'),
  });
  record('DAV Basic 密码错误 → 401（与改密闸门区分）', '401', String(davWrongPass.status), davWrongPass.status === 401);
  const davAdminOk = await davPropfind('/calendars/admin/default/', {
    Authorization: basicAuth('admin', 'M4-Admin-Pass-New-1'),
  });
  record('普通管理员账号 DAV 不受影响 → 207', '207', String(davAdminOk.status), davAdminOk.status === 207);

  const defaultAsNew = await rest(daveSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: '1234567890', newPassword: '1234567890' },
  });
  record('改密：新密码仍用默认密码 → 400 + default_password_forbidden', '400 + code',
    `${defaultAsNew.status} ${defaultAsNew.json && defaultAsNew.json.code}`,
    defaultAsNew.status === 400 && defaultAsNew.json
      && defaultAsNew.json.code === 'default_password_forbidden'
      && /[\u4e00-\u9fa5]/.test(defaultAsNew.json.message || ''));

  const daveOwnChange = await rest(daveSession, 'POST', '/api/v1/auth/password', {
    body: { oldPassword: '1234567890', newPassword: 'M4-Dave-Pass-3' },
  });
  record('强制改密：成功 → 200 + mustChangePassword=false', '200 + false',
    `${daveOwnChange.status} ${daveOwnChange.json && daveOwnChange.json.mustChangePassword}`,
    daveOwnChange.status === 200 && daveOwnChange.json && daveOwnChange.json.mustChangePassword === false);
  const daveFresh = pickCookies({ headers: daveOwnChange.headers });
  if (daveFresh.session) daveSession = daveFresh;

  const kvAfter = await rest(daveSession, 'GET', '/api/v1/kv?pattern=cal:evt:*');
  record('改密后：业务 API 恢复 200', '200', String(kvAfter.status), kvAfter.status === 200);

  const davAfterChange = await davPropfind('/calendars/dave/default/', {
    Authorization: basicAuth('dave', 'M4-Dave-Pass-3'),
  });
  record('改密后：DAV Basic 立即恢复 207（无需重启/重装）', '207',
    String(davAfterChange.status), davAfterChange.status === 207);

  const defaultGone = await login('dave', '1234567890');
  record('改密后：默认密码失效 → 401', '401', String(defaultGone.status), defaultGone.status === 401);

  /* ---------------- 4b. 管理员直接改显示名（0.2.4） ------------------ */
  const renamed = await rest(adminSession, 'PATCH', `/api/v1/admin/users/${daveId}`, {
    body: { displayName: 'Dave 改名' },
  });
  record('管理员改显示名：200 + displayName 更新', '200 + Dave 改名',
    `${renamed.status} ${renamed.json && renamed.json.user && renamed.json.user.displayName}`,
    renamed.status === 200 && renamed.json && renamed.json.user && renamed.json.user.displayName === 'Dave 改名');
  const emptyName = await rest(adminSession, 'PATCH', `/api/v1/admin/users/${daveId}`, {
    body: { displayName: '   ' },
  });
  record('管理员改显示名：空白 → 400', '400', String(emptyName.status), emptyName.status === 400);

  /* ---------------- 5. 登出全部设备 ---------------------------------- */
  const anonLogoutAll = await fetch(`${BASE}/api/v1/auth/logout-all`, { method: 'POST' });
  record('logout-all：无会话 → 401', '401', String(anonLogoutAll.status), anonLogoutAll.status === 401);

  const noCsrfLogoutAll = await rest(adminSession, 'POST', '/api/v1/auth/logout-all', { csrf: false });
  record('logout-all：缺 CSRF → 403', '403', String(noCsrfLogoutAll.status), noCsrfLogoutAll.status === 403);

  const basicLogoutAll = await fetch(`${BASE}/api/v1/auth/logout-all`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from('admin:M4-Admin-Pass-New-1').toString('base64')}` },
  });
  record('logout-all：Basic 凭证 → 403（会话专属）', '403', String(basicLogoutAll.status), basicLogoutAll.status === 403);

  const all = await rest(adminSession, 'POST', '/api/v1/auth/logout-all');
  record('logout-all：会话 + CSRF → 200', '200', String(all.status), all.status === 200);

  const revoked = await rest(adminSession, 'GET', '/api/v1/auth/session');
  record('logout-all 后：旧 Cookie 立即 401', '401', String(revoked.status), revoked.status === 401);

  const relogin = await login('admin', 'M4-Admin-Pass-New-1');
  record('logout-all 后：密码仍可重新登录（只吊销会话）', '200',
    String(relogin.status), relogin.status === 200);
  adminSession = { session: relogin.session, csrf: relogin.csrf };

  /* ---------------- 6. 停用 → 立即 401 ------------------------------- */
  const disabled = await rest(adminSession, 'PATCH', `/api/v1/admin/users/${daveId}`, {
    body: { disabled: true },
  });
  record('管理员停用账号：200 + disabled=true', '200 + true',
    `${disabled.status} ${disabled.json && disabled.json.user && disabled.json.user.disabled}`,
    disabled.status === 200 && disabled.json && disabled.json.user && disabled.json.user.disabled === true);

  const disabledSession = await rest(daveSession, 'GET', '/api/v1/auth/session');
  record('停用后：该账号已有会话立即 401', '401', String(disabledSession.status), disabledSession.status === 401);

  const disabledLogin = await login('dave', 'M4-Dave-Pass-3');
  record('停用后：该账号登录 → 401', '401', String(disabledLogin.status), disabledLogin.status === 401);

  const enabled = await rest(adminSession, 'PATCH', `/api/v1/admin/users/${daveId}`, {
    body: { disabled: false },
  });
  record('管理员启用账号：200 + disabled=false', '200 + false',
    `${enabled.status} ${enabled.json && enabled.json.user && enabled.json.user.disabled}`,
    enabled.status === 200 && enabled.json && enabled.json.user && enabled.json.user.disabled === false);
  const enabledLogin = await login('dave', 'M4-Dave-Pass-3');
  record('启用后可重新登录：200 + 不强制改密', '200 + false',
    `${enabledLogin.status} ${enabledLogin.json.mustChangePassword}`,
    enabledLogin.status === 200 && enabledLogin.json.mustChangePassword === false);
  // 启用会 bump tokenVersion，旧 daveSession 已失效；改用新会话再测删除接口的普通用户 403。
  daveSession = { session: enabledLogin.session, csrf: enabledLogin.csrf };

  /* ---------------- 7. 列表只回元数据 -------------------------------- */
  const users = await rest(adminSession, 'GET', '/api/v1/admin/users');
  const list = (users.json && users.json.users) || [];
  record('管理员账号列表：200 且含 dave + mustChangePassword 元数据', 'dave + flag',
    `${users.status} users=${list.length}`,
    users.status === 200 && list.some((u) => u.username === 'dave' && typeof u.mustChangePassword === 'boolean'));
  record('账号列表不含 hash/password 字段', 'no secrets',
    list.some((u) => 'hash' in u || 'password' in u) ? 'leaked' : 'clean',
    !list.some((u) => 'hash' in u || 'password' in u));

  /* ---------------- 7b. 0.2.9 删除账号（管理员） ---------------------- */
  const erinCreate = await rest(adminSession, 'POST', '/api/v1/admin/users', {
    body: { username: 'erin', password: 'M4-Erin-Pass-1', role: 'user' },
  });
  const erinId = erinCreate.json && erinCreate.json.user && erinCreate.json.user.id;
  record('建测试账号 erin：201 + id', '201 + id', `${erinCreate.status} ${erinId ? 'id' : '-'}`,
    erinCreate.status === 201 && Boolean(erinId));

  const daveDelete = await rest(daveSession, 'DELETE', `/api/v1/admin/users/${erinId}`);
  record('普通用户 DELETE 账号 → 403', '403', String(daveDelete.status), daveDelete.status === 403);
  const noCsrfDelete = await rest(adminSession, 'DELETE', `/api/v1/admin/users/${erinId}`, { csrf: false });
  record('删除账号：缺 CSRF → 403', '403', String(noCsrfDelete.status), noCsrfDelete.status === 403);
  const selfDelete = await rest(adminSession, 'DELETE', `/api/v1/admin/users/${adminId}`);
  record('删除自己 → 400 + 中文（最后一个管理员保护）', '400 + 中文',
    `${selfDelete.status} ${selfDelete.json && selfDelete.json.message}`,
    selfDelete.status === 400 && /[\u4e00-\u9fa5]/.test((selfDelete.json && selfDelete.json.message) || ''));

  const erinDir = path.join(varPath, 'calendars', erinId);
  const erinDirBefore = await fs.stat(erinDir).then(() => true).catch(() => false);
  const erinDelete = await rest(adminSession, 'DELETE', `/api/v1/admin/users/${erinId}`);
  const erinDirAfter = await fs.stat(erinDir).then(() => true).catch(() => false);
  record('管理员删除账号：200 + 数据目录已清', '200 + 目录前有后无',
    `${erinDelete.status} before=${erinDirBefore} after=${erinDirAfter}`,
    erinDelete.status === 200 && erinDirBefore === true && erinDirAfter === false);
  // 0.2.13 起失败锁定按「账号 + 来源 IP」双维度：前面的错误登录可能已锁住本机 IP，
  // 先让管理员解锁，才能稳定验证「账号已删除 → 401」。
  await rest(adminSession, 'POST', '/api/v1/admin/security/unlock', { body: { ip: '127.0.0.1' } });
  const erinLogin = await login('erin', 'M4-Erin-Pass-1');
  record('删除后：该账号登录 → 401', '401', String(erinLogin.status), erinLogin.status === 401);

  /* -------- 8. 审计：重置 / 首登改密 / 删除账号，且不含密码明文 ---------- */
  await new Promise((resolve) => setTimeout(resolve, 200));
  let auditLines = [];
  try {
    const raw = await fs.readFile(path.join(varPath, 'logs', 'audit.log'), 'utf8');
    auditLines = raw.trim().split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
  } catch {
    /* asserted below */
  }
  record('审计：记录管理员重置密码事件（mustChange=true）', 'account-password-reset mustChange',
    auditLines.some((e) => e.event === 'account-password-reset') ? 'found' : 'missing',
    auditLines.some((e) => e.event === 'account-password-reset' && e.mustChange === true));
  record('审计：记录用户首次登录改密事件', 'forced-password-changed',
    auditLines.some((e) => e.event === 'forced-password-changed') ? 'found' : 'missing',
    auditLines.some((e) => e.event === 'forced-password-changed'));
  record('审计：记录管理员删除账号事件', 'account-deleted',
    auditLines.some((e) => e.event === 'account-deleted') ? 'found' : 'missing',
    auditLines.some((e) => e.event === 'account-deleted'));
  const auditText = JSON.stringify(auditLines);
  record('审计：不含任何密码明文', 'no password',
    auditText.includes('1234567890') || auditText.includes('M4-Dave-Pass-3') ? 'leaked' : 'clean',
    !auditText.includes('1234567890') && !auditText.includes('M4-Dave-Pass-3'));

  await stopServer();
  console.log('');
  console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  await stopServer();
  process.exit(2);
});
