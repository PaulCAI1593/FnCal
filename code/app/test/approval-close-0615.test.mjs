#!/usr/bin/env node
/**
 * 0.6.15：审批页终态页「关闭页面」按钮。
 *
 * 覆盖：
 *   1. 终态说明页（链接无效 / 已过期 / 已处理完 / 已达上限）：有且只有一个「关闭页面」，
 *      位于 `.glass` 内、说明文字之后；次要按钮（`.btn`、无 `btn--primary`）、`type="button"`、
 *      `aria-label="关闭页面"`；
 *   2. CSP：只有带关闭按钮的页面追加 `script-src 'nonce-…'`，script 标签 nonce 与头一致；
 *      没有按钮的页面 CSP 与 0.6.15 之前逐字相同；
 *   3. 点不掉时的三步脚本：`window.close()` → 300ms 后 `window.open('', '_self')` 再试 →
 *      仍关不掉隐藏按钮、给一行「请手动关闭此标签页」，不弹 alert；
 *   4. PIN 页与还有待处理卡片（带接受/拒绝表单）的队列没有该按钮；
 *   5. 全部处理完的队列页（POST 决策后回列表）有且只有一个按钮，且在卡片列表之后。
 *
 * 运行（在 code/ 下）：node app/test/approval-close-0615.test.mjs
 */
import { Readable } from 'node:stream';
import vm from 'node:vm';

const APP = new URL('../', import.meta.url);
const { createApprovalPage } = await import(new URL('api/approval-page.mjs', APP).href);

const results = [];
let failures = 0;

function record(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

const ROW = {
  id: 'p1',
  action: 'update',
  title: '团队周会',
  calendarId: 'cal-1',
  calendarName: '工作',
  startsAt: '2026-11-10T01:00:00.000Z',
  endsAt: '2026-11-10T02:00:00.000Z',
  expiresAt: Date.now() + 3600000,
  description: '',
  location: '',
  note: '',
};

const VIEW = {
  id: 'p1',
  action: 'update',
  title: '团队周会',
  calendarId: 'cal-1',
  calendarName: '工作',
  when: '11月10日 09:00',
  location: '',
  description: '',
  note: '',
  hoursLeft: 1,
};

const OLD_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const CLOSE_BUTTON = '<button class="btn" type="button" data-close-page';

function credential(overrides = {}) {
  return {
    id: 'cred-1',
    label: '测试凭据',
    writeMode: 'direct',
    deleteMode: 'direct',
    agentApproval: false,
    pinHash: null,
    ...overrides,
  };
}

/** 一个只走内存的最小审批页：链接、提案、决策都由测试注入。 */
function makeHarness({ state = 'ok', remaining = 1, decisions = new Map(), credential: cred = credential() } = {}) {
  const link = { id: 'link-0615', userId: 'user-1', credentialId: 'cred-1', csrf: 'csrf-0615', proposalIds: ['p1'] };
  const approvalLinks = {
    resolve: () => ({ link, state }),
    remainingCount: () => remaining,
    decisionOf: (target, id) => decisions.get(String(id)) || null,
    snapshotOf: () => VIEW,
    rememberSnapshot: () => {},
    pinAttemptsLeft: () => 3,
    pendingIds: () => ['p1'],
    claim: (target, ids) => ({ claimed: ids.slice() }),
    settle: (target, id, result) => { decisions.set(String(id), result); },
    release: () => {},
  };
  const aiStore = {
    getCredential: async () => cred,
    listCalendarMetasFor: async () => [],
    readSettings: async () => ({}),
  };
  const aiService = {
    listAgentProposals: async () => [ROW],
    agentDecide: async () => ({ status: 'accepted' }),
  };
  return { page: createApprovalPage({ aiStore, aiService, approvalLinks }), link };
}

function makeReq(method, url, body = null) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

async function call(page, method, url, body = null) {
  const state = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(payload) { state.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || ''); },
  };
  await page.handle(makeReq(method, url, body), res);
  return state;
}

const countOf = (text, needle) => text.split(needle).length - 1;

function buttonTagOf(html) {
  const at = html.indexOf(CLOSE_BUTTON);
  if (at < 0) return '';
  const end = html.indexOf('>', at);
  return html.slice(at, end + 1);
}

function nonceOf(csp) {
  return (/script-src 'nonce-([^']+)'/.exec(csp) || [])[1] || '';
}

/* ---------------- 1. 终态说明页（链接无效）：按钮本身 ---------------- */
const dead = await call(makeHarness({ state: 'unknown' }).page, 'GET', '/a/deadbeef');
const deadBody = dead.body;
const deadTag = buttonTagOf(deadBody);

record('终态说明页返回 404', dead.status === 404, `status=${dead.status}`);
record('终态说明页有且只有一个关闭按钮', countOf(deadBody, CLOSE_BUTTON) === 1,
  `count=${countOf(deadBody, CLOSE_BUTTON)}`);
record('关闭按钮是次要按钮（.btn、无 btn--primary）',
  deadTag.includes('class="btn"') && !deadTag.includes('btn--primary'), deadTag);
record('关闭按钮可被键盘触发（type=button + aria-label）',
  deadTag.includes('type="button"') && deadTag.includes('aria-label="关闭页面"'), deadTag);
record('按钮文案为「关闭页面」', deadBody.includes('>关闭页面</button>'), '');
record('按钮在 .glass 内、且在说明文字之后',
  deadBody.indexOf('<div class="glass">') < deadBody.indexOf(CLOSE_BUTTON)
  && deadBody.indexOf('class="lede"') < deadBody.indexOf(CLOSE_BUTTON)
  && deadBody.indexOf(CLOSE_BUTTON) < deadBody.indexOf('</div>\n</main>'), '');

/* ---------------- 2. CSP nonce ---------------- */
const deadCsp = dead.headers['Content-Security-Policy'] || '';
const deadNonce = nonceOf(deadCsp);
record('终态页 CSP 追加 script-src nonce', Boolean(deadNonce), deadCsp);
record('script 标签 nonce 与 CSP 一致', Boolean(deadNonce) && deadBody.includes(`<script nonce="${deadNonce}">`), '');
record('页面里没有残留 nonce 占位符', !deadBody.includes('__fncal_close_nonce__'), '');

/* ---------------- 3. 三步脚本与兜底文案 ---------------- */
record('脚本第一步直接 window.close()', deadBody.includes('window.close()'), '');
record('脚本第二步 300ms 后 window.open(_self) 再 close', deadBody.includes("window.open('', '_self')")
  && deadBody.includes('}, 300);'), '');
record('仍关不掉时给「请手动关闭此标签页」并隐藏按钮',
  deadBody.includes('请手动关闭此标签页') && deadBody.includes('button.hidden = true'), '');
record('兜底不弹 alert', !deadBody.includes('alert('), '');

/* ---------------- 4. PIN 页：不出现 ---------------- */
const pin = await call(makeHarness({
  credential: credential({ agentApproval: true, writeMode: 'proposal', pinHash: 'fake-hash' }),
}).page, 'GET', '/a/token');
record('PIN 页没有关闭按钮', countOf(pin.body, CLOSE_BUTTON) === 0,
  `count=${countOf(pin.body, CLOSE_BUTTON)}`);
record('PIN 页仍是四格 PIN 表单', pin.body.includes('data-pin-form') && pin.body.includes('data-pin-cell'), '');

/* ---------------- 5. 还有待处理卡片：不出现 ---------------- */
const pending = await call(makeHarness({ remaining: 1 }).page, 'GET', '/a/token');
record('待处理队列页没有关闭按钮', countOf(pending.body, CLOSE_BUTTON) === 0,
  `count=${countOf(pending.body, CLOSE_BUTTON)}`);
record('待处理队列页保留接受/拒绝表单',
  pending.body.includes('ai-proposal__accept') && pending.body.includes('ai-proposal__reject'), '');
record('无关闭按钮的页面 CSP 与 0.6.15 之前逐字相同',
  (pending.headers['Content-Security-Policy'] || '') === OLD_CSP, pending.headers['Content-Security-Policy'] || '');

/* ---------------- 6. 全部处理完的队列页：POST 决策后回列表 ---------------- */
const done = await call(makeHarness({ remaining: 0 }).page, 'POST', '/a/token/decision',
  'csrf=csrf-0615&id=p1&decision=approve');
record('全部处理完的队列页返回 200', done.status === 200, `status=${done.status}`);
record('全部处理完的队列页有已完成卡片', done.body.includes('ai-proposal__state') && done.body.includes('已接受'), '');
record('全部处理完的队列页有且只有一个关闭按钮', countOf(done.body, CLOSE_BUTTON) === 1,
  `count=${countOf(done.body, CLOSE_BUTTON)}`);
record('队列页的关闭按钮在卡片列表之后',
  done.body.indexOf('ai-section__body') < done.body.indexOf(CLOSE_BUTTON), '');
record('队列页不再有接受/拒绝表单',
  !done.body.includes('ai-proposal__accept') && !done.body.includes('ai-proposal__reject'), '');

/* ---------------- 7. 「已处理完」说明页 ---------------- */
const finished = await call(makeHarness({
  remaining: 0,
  decisions: new Map([['p1', { action: 'accept', ok: true }]]),
}).page, 'GET', '/a/token');
record('「已处理完」说明页 200 且有且只有一个关闭按钮',
  finished.status === 200 && finished.body.includes('已处理完')
  && countOf(finished.body, CLOSE_BUTTON) === 1,
  `status=${finished.status} count=${countOf(finished.body, CLOSE_BUTTON)}`);

/* ---------------- 8. 脚本行为（用假 window/document 执行一次，不跑浏览器） ---------------- */
const scriptAt = deadBody.indexOf('<script nonce=');
const scriptOpen = deadBody.indexOf('>', scriptAt) + 1;
const scriptSource = deadBody.slice(scriptOpen, deadBody.indexOf('</script>', scriptOpen));

function runCloseScript(source, { closesOnFirstTry = false } = {}) {
  const listeners = [];
  const timers = [];
  const button = { hidden: false, addEventListener(type, fn) { if (type === 'click') listeners.push(fn); } };
  const hint = { hidden: true };
  const win = {
    closed: false,
    closeCount: 0,
    openCalls: [],
    close() { win.closeCount += 1; if (closesOnFirstTry) win.closed = true; },
    open(...args) { win.openCalls.push(args); },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
  };
  const document = {
    querySelector(selector) {
      if (selector === '[data-close-page]') return button;
      if (selector === '[data-close-hint]') return hint;
      return null;
    },
  };
  vm.runInNewContext(source, { window: win, document });
  return { win, button, hint, timers, click: () => listeners[0](), drain() { while (timers.length) timers.shift().fn(); } };
}

const blocked = runCloseScript(scriptSource);
blocked.click();
record('点击后先调用 window.close()', blocked.win.closeCount === 1, `count=${blocked.win.closeCount}`);
blocked.drain();
record('关不掉时 300ms 后用 _self 再试一次',
  blocked.win.openCalls.length === 1 && blocked.win.openCalls[0][1] === '_self' && blocked.win.closeCount === 2,
  `open=${JSON.stringify(blocked.win.openCalls)} close=${blocked.win.closeCount}`);
record('仍关不掉：隐藏按钮、显示「请手动关闭此标签页」',
  blocked.button.hidden === true && blocked.hint.hidden === false,
  `button.hidden=${blocked.button.hidden} hint.hidden=${blocked.hint.hidden}`);

const closedAtOnce = runCloseScript(scriptSource, { closesOnFirstTry: true });
closedAtOnce.click();
closedAtOnce.drain();
record('第一次就关掉时不再尝试 _self 兜底',
  closedAtOnce.win.closeCount === 1 && closedAtOnce.win.openCalls.length === 0 && closedAtOnce.button.hidden === false,
  `close=${closedAtOnce.win.closeCount} open=${closedAtOnce.win.openCalls.length}`);

console.log(`SUMMARY: pass=${results.length - failures} fail=${failures}`);
if (failures > 0) process.exitCode = 1;
