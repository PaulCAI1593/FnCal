#!/usr/bin/env node
/**
 * M3.2 account/session tests — HTTP level against a freshly spawned instance.
 *
 * Covers: 401, wrong password, login rate limit (429 + Retry-After), cookie
 * attributes (HttpOnly/SameSite/Path/Secure-on-TLS), CSRF 403, tokenVersion
 * invalidation on password change, audit log contents (no secrets), accounts.json
 * shape/atomic file, and that DAV Basic auth keeps working.
 *
 * Usage: node test/auth.test.mjs   (spawns its own instance on port 5287)
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.CALDAV_AUTH_PORT || 5287);
const BASE = `http://127.0.0.1:${PORT}`;
const VAR_DIR = '.var-auth-test';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'Admin-Pass-123';
const NEW_PASS = 'New-Pass-456';

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

function cookieValue(setCookies, name) {
  const hit = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!hit) return '';
  return hit.slice(name.length + 1).split(';')[0];
}

async function call(method, pathname, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body != null && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body != null && typeof body === 'object' ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    headers: res.headers,
    setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    text,
    json,
  };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
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

async function main() {
  const varPath = path.join(appRoot, VAR_DIR);
  await fs.rm(varPath, { recursive: true, force: true });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(PORT),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: varPath,
      CALDAV_USER: ADMIN_USER,
      CALDAV_ADMIN_PASSWORD: ADMIN_PASS,
      CALDAV_AUTH: 'on',
    },
    stdio: 'ignore',
  });

  try {
    await waitForServer();

    /* 1. anonymous access */
    {
      const r = await call('GET', '/api/auth/me');
      record('anonymous /api/auth/me -> 401', '401', String(r.status), r.status === 401);
    }

    /* 2. wrong password */
    {
      const r = await call('POST', '/api/auth/login', { body: { username: ADMIN_USER, password: 'wrong-password' } });
      record('login wrong password -> 401', '401', `${r.status} ${r.json?.error || ''}`, r.status === 401);
    }

    /* 3. correct login: cookie attributes */
    const login = await call('POST', '/api/auth/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
    const sessionCookie = cookieValue(login.setCookies, 'caldav_session');
    const csrfCookie = cookieValue(login.setCookies, 'caldav_csrf');
    const sessionRaw = login.setCookies.find((c) => c.startsWith('caldav_session=')) || '';
    {
      const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/'].every((a) => sessionRaw.includes(a));
      record('login -> 200 + session cookie HttpOnly/SameSite=Lax/Path=/', '200 + attributes',
        `${login.status}${attrs ? ' +attrs' : ''}${sessionCookie ? ' +cookie' : ''}`,
        login.status === 200 && Boolean(sessionCookie) && attrs);
      record('login -> csrf cookie issued (readable)', 'caldav_csrf', csrfCookie ? 'present' : 'missing',
        Boolean(csrfCookie) && !/HttpOnly/.test(login.setCookies.find((c) => c.startsWith('caldav_csrf=')) || ''));
      record('login on plain HTTP -> no Secure attribute', 'no Secure', /Secure/.test(sessionRaw) ? 'Secure present' : 'absent',
        !/Secure/.test(sessionRaw));
    }

    /* 4. session works */
    const cookieHeader = `caldav_session=${sessionCookie}; caldav_csrf=${csrfCookie}`;
    {
      const r = await call('GET', '/api/auth/me', { headers: { Cookie: cookieHeader } });
      record('session /api/auth/me -> 200 user', '200 admin', `${r.status} ${r.json?.user?.username || ''}`,
        r.status === 200 && r.json?.user?.username === ADMIN_USER);
    }

    /* 5. Secure attribute：0.2.37（S1）起只在「可信反向代理」发来的 https 请求上生效 */
    {
      // 5a 反代没开时，X-Forwarded-Proto 不再被采信（旧逻辑是「谁都能声明自己是 https」）。
      const spoofed = await call('POST', '/api/auth/login', {
        body: { username: ADMIN_USER, password: ADMIN_PASS },
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      const spoofedRaw = spoofed.setCookies.find((c) => c.startsWith('caldav_session=')) || '';
      record('login with spoofed X-Forwarded-Proto -> no Secure (proxy disabled)', 'no Secure',
        /Secure/.test(spoofedRaw) ? 'Secure present' : 'absent',
        spoofed.status === 200 && !/Secure/.test(spoofedRaw));

      // 5b 显式信任本机回环后，同一个转发头才生效。
      const trustedHeaders = { Cookie: cookieHeader, 'X-CSRF-Token': csrfCookie };
      const enable = await call('PATCH', '/api/v1/admin/security', {
        body: { proxy: { enabled: true, trusted: ['127.0.0.1'] } },
        headers: trustedHeaders,
      });
      record('enable trusted proxy', '200', String(enable.status), enable.status === 200);
      const r = await call('POST', '/api/auth/login', {
        body: { username: ADMIN_USER, password: ADMIN_PASS },
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      const raw = r.setCookies.find((c) => c.startsWith('caldav_session=')) || '';
      record('login over trusted proxy https -> Secure attribute', 'Secure',
        raw.includes('Secure') ? 'present' : 'absent', r.status === 200 && raw.includes('Secure'));
      // 关掉反代，后面的用例继续走普通 HTTP。
      const disable = await call('PATCH', '/api/v1/admin/security', {
        body: { proxy: { enabled: false, trusted: [] } },
        headers: trustedHeaders,
      });
      record('restore proxy settings', '200', String(disable.status), disable.status === 200);
    }

    /* 6. DAV Basic auth still works (CalDAV clients) */
    const basic = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`;
    {
      const r = await call('MKCALENDAR', `/calendars/${ADMIN_USER}/auth-test/`, {
        body: '',
        headers: { Authorization: basic },
      });
      record('DAV MKCALENDAR with Basic auth -> 201', '201', String(r.status), r.status === 201);
    }

    /* 7. CSRF: session-authenticated write without header -> 403 */
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
      'BEGIN:VEVENT', 'UID:csrf-test', 'DTSTAMP:20261023T060000Z',
      'DTSTART:20261120T090000Z', 'DTEND:20261120T100000Z', 'SUMMARY:csrf',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    {
      const r = await call('PUT', `/calendars/${ADMIN_USER}/auth-test/csrf-test.ics`, {
        body: ics,
        headers: { Cookie: cookieHeader, 'Content-Type': 'text/calendar' },
      });
      record('session PUT without X-CSRF-Token -> 403', '403', String(r.status), r.status === 403);
    }
    {
      const r = await call('PUT', `/calendars/${ADMIN_USER}/auth-test/csrf-test.ics`, {
        body: ics,
        headers: { Cookie: cookieHeader, 'Content-Type': 'text/calendar', 'X-CSRF-Token': csrfCookie },
      });
      record('session PUT with X-CSRF-Token -> 201', '201', String(r.status), r.status === 201);
    }

    /* 8. password change bumps tokenVersion and kills old cookies */
    {
      const bad = await call('POST', '/api/auth/password', {
        body: { oldPassword: 'nope', newPassword: NEW_PASS },
        headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfCookie },
      });
      record('password change with wrong old -> 401', '401', String(bad.status), bad.status === 401);

      const changed = await call('POST', '/api/auth/password', {
        body: { oldPassword: ADMIN_PASS, newPassword: NEW_PASS },
        headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfCookie },
      });
      record('password change -> 200', '200', String(changed.status), changed.status === 200);

      const stale = await call('GET', '/api/auth/me', { headers: { Cookie: cookieHeader } });
      record('old cookie after password change -> 401 (tokenVersion)', '401', String(stale.status), stale.status === 401);

      const relogin = await call('POST', '/api/auth/login', { body: { username: ADMIN_USER, password: NEW_PASS } });
      record('login with new password -> 200', '200', String(relogin.status), relogin.status === 200);

      const oldPw = await call('POST', '/api/auth/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
      record('login with old password after change -> 401', '401', String(oldPw.status), oldPw.status === 401);
    }

    /* 9. rate limiting: 5 failures -> 429 with Retry-After */
    {
      const probeUser = 'rate-probe';
      const codes = [];
      let last = null;
      for (let i = 0; i < 5; i++) {
        last = await call('POST', '/api/auth/login', { body: { username: probeUser, password: `bad-${i}` } });
        codes.push(last.status);
      }
      const sixth = await call('POST', '/api/auth/login', { body: { username: probeUser, password: 'bad-again' } });
      const retryAfter = Number(sixth.headers.get('retry-after') || 0);
      // 0.2.13 起锁定是「账号 + 来源 IP」双维度：本文件前面的失败登录也会计入本机 IP，
      // 所以这里只断言「先 401、最终 429、给出 Retry-After、锁定期内仍 429」。
      record('5 failed logins -> 429 + Retry-After', '401 后转 429；retry>0',
        `${codes.join(',')}; retry=${retryAfter}`,
        codes[0] === 401 && codes[4] === 429 && retryAfter > 0 && sixth.status === 429);
    }

    /* 10. accounts.json: shape + hash, no plaintext */
    {
      const raw = await fs.readFile(path.join(varPath, 'accounts.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const account = parsed.accounts[0];
      const fieldsOk = ['id', 'username', 'displayName', 'hash', 'role', 'tokenVersion', 'disabled', 'createdAt']
        .every((field) => field in account);
      record('accounts.json shape', 'M2 §3.1 fields', fieldsOk ? 'all fields' : 'missing',
        fieldsOk && parsed.version === 1);
      record('accounts.json stores bcrypt hash, no plaintext', 'no plaintext password',
        /^\$2[aby]\$/.test(account.hash) && !raw.includes(ADMIN_PASS) && !raw.includes(NEW_PASS),
        account.hash.slice(0, 7));
      record('accounts.json has tokenVersion bumped after change', '>=1', String(account.tokenVersion),
        Number(account.tokenVersion) >= 1);
    }

    /* 11. audit log: events present, no secrets */
    {
      const raw = await fs.readFile(path.join(varPath, 'logs', 'audit.log'), 'utf8').catch(() => '');
      const hasFailure = raw.includes('login-failure');
      const hasSuccess = raw.includes('login-success');
      const hasRate = raw.includes('login-rate-limited');
      const noSecrets = !raw.includes(ADMIN_PASS) && !raw.includes(NEW_PASS) && !raw.includes(sessionCookie);
      record('audit.log records auth events', 'login-success + login-failure + login-rate-limited',
        `${hasSuccess}/${hasFailure}/${hasRate}`,
        hasSuccess && hasFailure && hasRate);
      record('audit.log contains no password/token', 'clean', noSecrets ? 'clean' : 'LEAK',
        noSecrets);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true }).catch(() => {});
  }

  const passed = results.length - failures;
  console.log(`\nSUMMARY: pass=${passed} fail=${failures} total=${results.length}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
