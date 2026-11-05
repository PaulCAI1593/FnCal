// 0.4.23（M4 §S1–S9）：审批网页 `/a/<token>`——提案列表排版 + 逐条/批量操作。
//
// 为什么是「网页」：没有 elicitation 弹窗能力的 AI 客户端，服务端唯一能证明
// 「用户本人点了」的入口就是这个页面。页面只做一件事——把该链接绑定的几条提案
// 画成与网页端提案面板同构的列表，让用户在手机上逐条批准/拒绝，或一次批量处理。
//
// 硬约束（规则 ②③④⑤）
//   - 页面里绝不出现 API 路径、API 令牌、令牌明文、内部字段名、凭据 id；
//   - 零第三方资源、零外链请求（CSP `default-src 'none'`，样式内联；
//     PIN 页的自动跳格脚本用每次请求生成的 nonce 放行，仍无外链）；
//   - 执行走 ai-service 同一套受理（runProposalBatch → agentDecide → acceptProposalForAgent）；
//   - 每条提案最多决策一次：`claim()` 原子占位、`settle()` 落结果；已处理条目零执行；
//   - 失效条件：到期、全部条目已决策、PIN 错满 5 次；
//   - 设了 PIN 的凭据：先验 4 位 PIN（每链接 5 次），解锁一次对整条链接有效；
//   - 日志只记链接 id 前 8 位，绝不要写令牌或哈希。
//
// 路由（server.mjs 挂载，必须早于 `/api/` 与 DAV 的 403 判定）：
//   GET  /a/<token>              审批页（无 PIN 直接出列表；有 PIN 出四格 PIN 表单）
//   POST /a/<token>/pin          校验 PIN（成功 303 回 GET）
//   POST /a/<token>/decision     逐条批准/拒绝（字段 id + decision + CSRF）
//   POST /a/<token>/batch        批量批准/拒绝剩余条目（字段 decision + CSRF）

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { accentCssFor } from '../lib/accent.mjs';
// 0.4.27（S2）：时间格式化抽到 lib，审批页与 MCP 摘要共用同一套时区规则。
import { activeTimeZone, formatWhenInZone, hoursLeftOf } from '../lib/time-zone.mjs';

import { APPROVAL_REASON_TEXTS } from '../lib/approval-link.mjs';
import { verifyPin } from '../lib/pin.mjs';
import { runProposalBatch } from '../lib/ai-service.mjs';
import { PROPOSAL_ACTION_WORDS, proposalTitleOf } from './mcp.mjs';

export const APPROVAL_PAGE_PREFIX = '/a/';
const MAX_BODY_BYTES = 8 * 1024;
const PAGE_RATE_LIMIT = 60;

const BATCH_FAILURE_TEXT = Object.freeze({
  not_found: '提案不存在',
  expired: '已过期',
  conflict: '日程已被修改，请刷新后重试',
  calendar_missing: '目标日历不存在',
  invalid: '参数不合法',
  forbidden: '无权操作这一条',
  failed: '决策失败',
});

const DECISION_VERBS = Object.freeze({ accept: '接受', reject: '拒绝' });

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // 零第三方资源、零出站请求：样式只在页面内；表单只回本站。
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

const STYLE = `
/* 0.4.26 审批页样式：结构与视觉 1:1 复刻应用内「提案队列」。
   来源（逐条抄，不新增设计 token；改面板时按行号回查）：
   - code/web/src/styles/tokens.css:7-131（浅色）、:134-184（深色）
   - code/web/src/styles/base.css:114-187（.btn / --primary / --ghost / --danger）
   - code/web/src/styles/calendar.css:2372-2394（.ai-section__head/__title/__body、.ai-count）
   - code/web/src/styles/calendar.css:2699-2760（.ai-proposal / __head / __title / __expires / __note）
   - code/web/src/styles/calendar.css:2846-2893（__dot、两段式 .ai-badge）
   - code/web/src/styles/calendar.css:2903-2997（操作区、剩余时间、头部按钮、全部拒绝描边）
   - code/web/src/styles/calendar.css:2998-3024（≤420 图标档、≤340 间距）
   0.4.26 S9–S12 是本页新增的外层（渐变背景 + 玻璃浮层），面板里没有对应规则。 */
:root {
  color-scheme: light dark;
  --surface: #ffffff; --surface-2: #f5f6f8; --surface-3: #eceef2;
  --border: #e2e5eb; --border-strong: #d6dae2; --gray-300: #b9bfcc;
  --text: #14161c; --text-2: #4b5162; --text-3: #656c7a; --text-on-accent: #ffffff;
  --accent: #2f5e9e; --accent-hover: #29538b; --accent-active: #264b7e; --accent-link-hover: #29538b; --accent-soft: #e8eff8;
  --danger: #e5484d; --danger-soft: #fdecec; --danger-ink: #c22a2f; --success-ink: #15803d;
  --r-xs: 4px; --r-sm: 6px; --r-md: 9px; --r-lg: 12px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --fs-xs: 11px; --fs-sm: 12px; --fs-base: 13px; --fs-md: 14px;
  --shadow-sm: 0 1px 2px rgba(20, 22, 28, .06), 0 1px 1px rgba(20, 22, 28, .04);
  --dur-fast: 120ms; --ease: cubic-bezier(.22, .61, .36, 1);
}
/* 0.4.26（S14）：服务端主题设置会写 <html data-theme="dark|light">。
   dark 时用属性选择器覆盖系统；light 时下面的媒体查询用 :not([data-theme='light']) 让路。 */
:root[data-theme='dark'] {
  --surface: #16181f; --surface-2: #1a1c24; --surface-3: #21242e;
  --border: #2a2e3a; --border-strong: #343946; --gray-300: #454b5b;
  --text: #f4f6fa; --text-2: #a7adbc; --text-3: #8a91a2; --text-on-accent: #101216;
  --accent: #5c82b3; --accent-hover: #7091bc; --accent-active: #7d9bc2; --accent-link-hover: #7091bc; --accent-soft: #1b2a40;
  --danger: #ff6b6f; --danger-hover: #ff8386; --danger-soft: #3a2224; --danger-ink: #ff6b6f;
  --success-ink: #4cc38a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --surface: #16181f; --surface-2: #1a1c24; --surface-3: #21242e;
    --border: #2a2e3a; --border-strong: #343946; --gray-300: #454b5b;
    --text: #f4f6fa; --text-2: #a7adbc; --text-3: #8a91a2; --text-on-accent: #101216;
    --accent: #5c82b3; --accent-hover: #7091bc; --accent-active: #7d9bc2; --accent-link-hover: #7091bc; --accent-soft: #1b2a40;
    --danger: #ff6b6f; --danger-hover: #ff8386; --danger-soft: #3a2224; --danger-ink: #ff6b6f;
    --success-ink: #4cc38a;
  }
}
* { box-sizing: border-box; }
/* base.css:92-103 */
.icon { display: inline-flex; width: 20px; height: 20px; flex: none; color: currentColor; }
.icon svg { width: 100%; height: 100%; display: block; }
html { min-height: 100%; background: #108eb4; }
body {
  margin: 0; padding: 0;
  min-height: 100dvh;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', sans-serif;
  font-size: var(--fs-base);
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
/* S9：logo 同款蓝绿渐变（#1D73D6 → #1094B7 → #02B497，取自 code/web/public/icon-512.png 对角采样）。
   用 fixed 伪元素铺满视口，不用 background-attachment: fixed —— iOS Safari 不支持该值，
   会退化成随页面滚动的局部背景，滚动时还要重绘整屏；fixed 伪元素只绘制一次。 */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(110% 80% at 62% 18%, rgba(255, 255, 255, .22) 0%, rgba(255, 255, 255, 0) 62%),
    linear-gradient(135deg, #1d73d6 0%, #1094b7 52%, #02b497 100%);
}
:root[data-theme='dark'] { background: #0b3a4d; }
:root[data-theme='dark'] body::before {
  background:
    radial-gradient(110% 80% at 62% 18%, rgba(255, 255, 255, .09) 0%, rgba(255, 255, 255, 0) 62%),
    linear-gradient(135deg, #0d2a45 0%, #0b3a4d 52%, #083a35 100%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { background: #0b3a4d; }
  :root:not([data-theme='light']) body::before {
    background:
      radial-gradient(110% 80% at 62% 18%, rgba(255, 255, 255, .09) 0%, rgba(255, 255, 255, 0) 62%),
      linear-gradient(135deg, #0d2a45 0%, #0b3a4d 52%, #083a35 100%);
  }
}
.page {
  max-width: 680px;
  margin: 0 auto;
  padding: 24px 16px 32px;
}
/* S10：玻璃浮层。只有这一层 backdrop-filter；卡片保持不透明，滚动时不再为每张卡做模糊。 */
.glass {
  min-width: 0;
  padding: 16px;
  background: rgba(255, 255, 255, .86);
  -webkit-backdrop-filter: blur(18px) saturate(1.15);
  backdrop-filter: blur(18px) saturate(1.15);
  border: 1px solid rgba(255, 255, 255, .55);
  border-radius: 16px;
  /* 中性阴影：深色渐变底下带色阴影会被判成刻意光晕（AI 味），改用纯黑半透明，深度不变。 */
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28), 0 2px 8px rgba(0, 0, 0, .14);
}
:root[data-theme='dark'] .glass {
  background: rgba(22, 24, 31, .82);
  border-color: rgba(255, 255, 255, .10);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .glass {
    background: rgba(22, 24, 31, .82);
    border-color: rgba(255, 255, 255, .10);
  }
}
/* S10 回退：不支持 backdrop-filter 的浏览器用高不透明度底色，保证文字对比。 */
@supports not (backdrop-filter: blur(1px)) {
  .glass { background: rgba(255, 255, 255, .96); }
}
@supports not (backdrop-filter: blur(1px)) {
  :root[data-theme='dark'] .glass { background: rgba(22, 24, 31, .96); }
}
@media (prefers-color-scheme: dark) {
  @supports not (backdrop-filter: blur(1px)) {
    :root:not([data-theme='light']) .glass { background: rgba(22, 24, 31, .96); }
  }
}
/* base.css:114-187 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-height: 44px;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 550;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  .btn:hover { background: var(--surface-2); border-color: var(--gray-300); }
}
.btn:active { transform: translateY(.5px); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-sm);
}
@media (hover: hover) and (pointer: fine) {
  .btn--primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
}
.btn--primary:active { background: var(--accent-active); }
.btn--ghost { background: transparent; border-color: transparent; }
@media (hover: hover) and (pointer: fine) {
  .btn--ghost:hover { background: var(--surface-3); border-color: transparent; }
}
.btn--danger { color: var(--danger-ink); background: transparent; border-color: transparent; }
@media (hover: hover) and (pointer: fine) {
  .btn--danger:hover { background: var(--danger-soft); color: var(--danger-ink); }
}
/* S12：焦点环。白色环按范围文档写；再加一层深色外晕，浅色玻璃上也能看出焦点
   （白环单独放在 rgba(255,255,255,.86) 玻璃上只有约 1.1:1，等于不可见）。 */
.btn:focus-visible,
a:focus-visible,
.pin-cell:focus-visible {
  outline: 2px solid rgba(255, 255, 255, .9);
  outline-offset: 2px;
  box-shadow: 0 0 0 5px rgba(6, 40, 70, .45);
}
/* calendar.css:2372-2394 */
.ai-section__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  min-height: 32px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.ai-section__title {
  margin: 0;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
}
.ai-count { font-size: var(--fs-sm); color: var(--text-3); }
.ai-section__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
/* calendar.css:2958-2997：头部按钮组；DOM 顺序 = 刷新 → 全部批准 → 全部拒绝。 */
.ai-section__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
  flex: 0 0 auto;
}
.ai-proposals-refresh { margin-left: auto; }
.ai-section__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-count { flex: 0 0 auto; }
.ai-section__actions .btn__icon { display: none; }
.ai-section__actions .btn__label { display: inline; }
.ai-section__actions .btn { padding: 0 var(--sp-2); }
/* 全部拒绝默认描边式（§4）：危险色文字 + 常规边框。 */
.ai-section__actions .ai-proposals-reject { border-color: var(--border-strong); }
@media (hover: hover) and (pointer: fine) {
  .ai-section__actions .ai-proposals-reject:hover { background: var(--danger-soft); border-color: var(--danger-ink); }
}
/* 批量按钮在同一个表单里，表单自身不换行。 */
.ai-section__batch { display: flex; align-items: center; gap: var(--sp-1); margin: 0; }
/* calendar.css:2699-2760 / 2839-2950：卡片骨架与每行单行省略。 */
.ai-proposal {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.ai-proposal__head { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; min-width: 0; }
.ai-proposal__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-proposal .ai-badge { flex: 0 0 auto; max-width: 45%; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-proposal .ai-badge { display: inline-flex; align-items: center; gap: 6px; }
.ai-badge__cred { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-badge__sep { flex: 0 0 auto; width: 1px; height: .9em; background: currentColor; opacity: .35; }
.ai-badge__action { flex: 0 0 auto; }
.ai-badge--delete .ai-badge__action { color: var(--danger-ink); }
.ai-proposal__meta,
.ai-proposal__when { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* calendar.css:2605-2611 的底色与圆点；:2846-2849 把尺寸收到 8px。 */
.ai-proposal__dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--cal-color, var(--accent)); }
.ai-proposal__calendar {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-proposal__time { flex: 0 0 auto; font-size: var(--fs-sm); color: var(--text); white-space: nowrap; }
.ai-proposal__note {
  margin: 0;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 0.4.26 S4：删除类影响提示用危险色（面板的 .ai-proposal__note 没有单独配色，
   本页按范围文档「红字」要求补一条，只用现有 --danger-ink，不新增 token）。 */
.ai-proposal__impact { color: var(--danger-ink); }
.ai-proposal__actions { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.ai-proposal__expires {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-proposal__buttons { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; flex: 0 0 auto; }
.ai-proposal__form { display: flex; align-items: center; gap: var(--sp-2); margin: 0; }
/* 卡片按钮仍保持 ≥44px 触控高度（S6）；文字与面板一致：接受=主按钮，拒绝=纯红字。 */
.ai-proposal .btn { min-height: 44px; padding: 0 14px; }
.ai-proposal__state { font-size: var(--fs-sm); color: var(--text-3); }
.status--ok { color: var(--success-ink); }
.status--fail { color: var(--danger-ink); }
/* 0.4.26 页面辅助行：批量影响提示与结果 banner（0.4.23 已有内容，只换外观）。 */
.ai-impact { margin: 0 0 8px; font-size: var(--fs-sm); color: var(--text-2); }
.ai-banner {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: var(--accent-soft);
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.ai-banner ul { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
/* PIN 页（0.4.23 S10 四格，页面外壳换成玻璃后内部不变）。 */
.pin-panel { padding: 8px 0 0; }
.pin-form { display: flex; flex-direction: column; gap: 14px; }
.pin-label { font-size: var(--fs-sm); color: var(--text-2); margin: 0; }
.pin-boxes { display: flex; gap: 10px; justify-content: center; }
.pin-cell {
  width: 56px; height: 56px; flex: 0 0 56px; padding: 0; margin: 0;
  text-align: center; font-size: 24px; line-height: 56px; font-family: inherit; font-weight: 600;
  color: var(--text); background: var(--surface-2);
  border: 1px solid var(--border-strong); border-radius: var(--r-md);
  -moz-appearance: textfield; appearance: none;
}
.pin-cell::-webkit-outer-spin-button, .pin-cell::-webkit-inner-spin-button { appearance: none; margin: 0; }
.pin-boxes--error .pin-cell { border-color: var(--danger); }
.pin-boxes--error { animation: pin-shake .2s ease-in-out; }
@keyframes pin-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}
.hint { margin: 0; font-size: var(--fs-sm); color: var(--text-3); }
.error { margin: 0; font-size: var(--fs-sm); color: var(--danger-ink); }
.brand { font-size: var(--fs-sm); font-weight: 600; letter-spacing: .02em; color: var(--text-3); margin: 0; }
h1 { font-size: 20px; line-height: 1.3; margin: 6px 0 4px; font-weight: 650; }
.lede { margin: 0 0 12px; font-size: var(--fs-sm); color: var(--text-3); }
@media (prefers-reduced-motion: reduce) {
  .pin-boxes--error { animation: none; }
  * { transition: none !important; }
}
/* calendar.css:2998-3024：窄屏头部按钮只留图标（文字进 aria-label）；本页按钮尺寸保持 44px 触控。 */
@media (max-width: 420px) {
  .ai-section__actions { gap: var(--sp-1); }
  .ai-section__actions .btn { width: 44px; height: 44px; min-height: 44px; padding: 0; }
  .ai-section__actions .btn__icon { display: inline-flex; }
  .ai-section__actions .btn__label { display: none; }
}
@media (max-width: 340px) {
  .ai-section__actions { gap: 4px; }
}
/* 手机窄屏收页面与玻璃内边距：320 下仍给标题与三枚 44px 按钮留出空间。 */
@media (max-width: 520px) {
  .page { padding: 12px 12px 24px; }
  .glass { padding: 16px 12px; }
}
@media (max-width: 359px) {
  .pin-boxes { gap: 8px; }
  .pin-cell { width: 52px; height: 52px; flex-basis: 52px; line-height: 52px; font-size: 22px; }
}
`;

// 0.4.26（S13–S15）：每个请求的主题（accent 变量 + data-theme）放进 AsyncLocalStorage，
// pageShell 与所有渲染函数都读它；不用模块级变量，避免并发请求互相串主题。
const pageSkinStore = new AsyncLocalStorage();

function pageShell({ title, body }) {
  const skin = pageSkinStore.getStore() || {};
  const themeAttr = skin.theme === 'dark' || skin.theme === 'light' ? ` data-theme="${skin.theme}"` : '';
  const accentCss = skin.accentCss ? `\n${skin.accentCss}` : '';
  return '<!doctype html>\n<html lang="zh-CN"' + themeAttr + '>\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="robots" content="noindex, nofollow">\n'
    + `<title>${escapeHtml(title)}</title>\n<style>${STYLE}${accentCss}</style>\n</head>\n`
    + `<body>\n<main class="page">\n<div class="glass">\n${body}\n</div>\n</main>\n</body>\n</html>\n`;
}

const PIN_SCRIPT = `
(function () {
  var cells = Array.prototype.slice.call(document.querySelectorAll('[data-pin-cell]'));
  var form = document.querySelector('[data-pin-form]');
  if (!cells.length || !form) return;
  var filled = function () {
    return cells.every(function (cell) { return String(cell.value || '').length === 1; });
  };
  var submitIfFilled = function () {
    if (filled()) form.submit();
  };
  cells.forEach(function (cell, index) {
    cell.addEventListener('input', function () {
      var digits = String(cell.value || '').replace(/[^0-9]/g, '');
      cell.value = digits.slice(-1);
      if (cell.value && index < cells.length - 1) cells[index + 1].focus();
      submitIfFilled();
    });
    cell.addEventListener('keydown', function (event) {
      if (event.key === 'Backspace' && !cell.value && index > 0) {
        cells[index - 1].focus();
        cells[index - 1].value = '';
        event.preventDefault();
      }
    });
    cell.addEventListener('paste', function (event) {
      var source = (event.clipboardData || window.clipboardData);
      var text = source ? source.getData('text') : '';
      var digits = String(text || '').replace(/[^0-9]/g, '').slice(0, 4);
      if (!digits) return;
      event.preventDefault();
      digits.split('').forEach(function (digit, at) {
        if (cells[at]) cells[at].value = digit;
      });
      var next = Math.min(digits.length, cells.length - 1);
      cells[next].focus();
      submitIfFilled();
    });
  });
  if (form.getAttribute('data-error') === '1') {
    cells.forEach(function (cell) { cell.value = ''; });
    cells[0].focus();
  }
})();
`;

/* ---------- 0.4.26（S7）/ 0.4.27（S2）：时间按服务端时区显示 ---------- */
// 审批页是独立服务端 HTML，拿不到浏览器时区。按范围文档 S7：用服务端时区（默认
// Asia/Shanghai）；部署在别的时区可用环境变量 CALDAV_TIME_ZONE 覆盖，不必改代码。
// 0.4.27 起实现抽到 lib/time-zone.mjs，MCP 摘要用同一套算法（S2）。
// 这里仍取一次作为页面默认值：同一次渲染里各处时间必须用同一个时区。
const PAGE_TIME_ZONE = activeTimeZone();

/* ---------- 0.4.26（S1/S2/S3）：提案队列同款结构与文案 ---------- */
// 图标内联自 code/web/src/js/icons.js（sync :64-65、check :16、close :11）；
// 页面不许引外部资源，所以直接用 SVG path，不加脚本。
const PAGE_ICONS = Object.freeze({
  sync: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
});

function pageIcon(name) {
  const body = PAGE_ICONS[name];
  if (!body) return '';
  return '<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + body + '</svg></span>';
}

// proposals-panel.js:150-163 的 actionBadge：凭据名 + 竖线 + 动作词。
function actionBadge(credentialLabel, action) {
  const word = PROPOSAL_ACTION_WORDS[action] || '修改';
  const cred = String(credentialLabel || '').trim();
  const credHtml = cred
    ? `<span class="ai-badge__cred">${escapeHtml(cred)}</span><span class="ai-badge__sep" aria-hidden="true"></span>`
    : '';
  const title = cred ? `${cred} ${word}` : word;
  return `<span class="ai-badge ai-badge--${escapeHtml(action)}" title="${escapeHtml(title)}">`
    + credHtml + `<span class="ai-badge__action">${escapeHtml(word)}</span></span>`;
}

function cardHead(view, credentialLabel) {
  return '<div class="ai-proposal__head">'
    + `<span class="ai-proposal__title" title="${escapeHtml(view.title)}">${escapeHtml(view.title)}</span>`
    + actionBadge(credentialLabel, view.action)
    + '</div>';
}

function cardMeta(view, colorById) {
  const color = colorById.get(view.calendarId) || '';
  return '<div class="ai-proposal__meta">'
    + `<span class="ai-proposal__dot" aria-hidden="true"${color ? ` style="--cal-color:${escapeHtml(color)}"` : ''}></span>`
    + `<span class="ai-proposal__calendar">${escapeHtml(view.calendarName || '日历')}</span>`
    + '</div>';
}

function timeLine(view) {
  if (!view.when) return '';
  return `<div class="ai-proposal__when"><span class="ai-proposal__time">${escapeHtml(view.when)}</span></div>`;
}

// proposals-panel.js 行④：删除类的固定影响文案（i18n zh-CN.js:746-747）。
function deleteNote(action, { trashMode, retentionDays }) {
  if (action !== 'delete') return '';
  const text = trashMode
    ? `将删除这一条日程，${Number(retentionDays) || 14} 天内可在最近删除里恢复`
    : '将删除这一条日程';
  return `<p class="ai-proposal__note ai-proposal__impact">${escapeHtml(text)}</p>`;
}

function viewOfRow(row, timeZone = PAGE_TIME_ZONE) {
  return {
    id: String(row.id),
    action: row.action,
    title: proposalTitleOf(row),
    calendarName: row.calendarName || '',
    calendarId: row.calendarId || '',
    when: formatWhenInZone(row, timeZone),
    location: row.location || '',
    hoursLeft: hoursLeftOf(row.expiresAt),
  };
}

/**
 * 0.4.25（S1）：表单 action 必须是含令牌的绝对路径。
 * 页面 URL 是 `/a/<token>`（无尾斜杠），相对 action 会被浏览器解析成 `/a/pin`，令牌丢失。
 */
function approvalAction(token, verb) {
  return `${APPROVAL_PAGE_PREFIX}${encodeURIComponent(String(token))}/${verb}`;
}

function renderPendingCard(view, { csrf, token, colorById, credentialLabel, trashMode, retentionDays }) {
  const deleteCard = view.action === 'delete';
  return `<article class="ai-proposal${deleteCard ? ' ai-proposal--delete' : ''}">`
    + cardHead(view, credentialLabel)
    + cardMeta(view, colorById)
    + timeLine(view)
    + deleteNote(view.action, { trashMode, retentionDays })
    + '<div class="ai-proposal__actions">'
    + `<span class="ai-proposal__expires">剩余 ${view.hoursLeft} 小时</span>`
    + '<div class="ai-proposal__buttons">'
    + `<form class="ai-proposal__form" method="post" action="${escapeHtml(approvalAction(token, 'decision'))}">`
    + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
    + `<input type="hidden" name="id" value="${escapeHtml(view.id)}">`
    + '<button class="btn btn--primary ai-proposal__accept" type="submit" name="decision" value="approve">接受</button>'
    + '<button class="btn btn--danger ai-proposal__reject" type="submit" name="decision" value="reject">拒绝</button>'
    + '</form></div></div></article>';
}

function renderDoneCard(view, decision, { colorById, credentialLabel, trashMode, retentionDays }) {
  if (!decision) return '';
  const deleteCard = view.action === 'delete';
  let status = '';
  if (decision.ok) {
    status = `<p class="ai-proposal__state status--ok">已${DECISION_VERBS[decision.action] || '处理'}</p>`;
  } else {
    const reason = BATCH_FAILURE_TEXT[decision.code] || '处理失败';
    status = `<p class="ai-proposal__state status--fail">失败：${escapeHtml(reason)}</p>`;
  }
  return `<article class="ai-proposal${deleteCard ? ' ai-proposal--delete' : ''}">`
    + cardHead(view, credentialLabel)
    + cardMeta(view, colorById)
    + timeLine(view)
    + deleteNote(view.action, { trashMode, retentionDays })
    + status
    + '</article>';
}

function renderPinPage({ csrf, token, credentialLabel, error = '', attemptsLeft = null, nonce }) {
  const left = Number.isFinite(attemptsLeft) ? `<p class="hint">还剩 ${attemptsLeft} 次尝试。</p>` : '';
  const err = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const errorClass = error ? ' pin-boxes--error' : '';
  const cells = [1, 2, 3, 4].map((index) => (
    '<input class="pin-cell" data-pin-cell type="password" inputmode="numeric" '
    + `pattern="[0-9]*" maxlength="1" autocomplete="one-time-code" `
    + `name="pin${index}" id="pin${index}" aria-label="第 ${index} 位数字"`
    + (index === 1 ? ' autofocus' : '')
    + '>'
  )).join('');
  const body = '<p class="brand">FnCal</p>\n<h1>输入审批 PIN</h1>\n'
    + `<p class="lede">来自 ${escapeHtml(credentialLabel)}。这 4 位只用于审批页，不要告诉 AI 助手。</p>\n`
    + `<section class="pin-panel"><form class="pin-form" method="post" action="${escapeHtml(approvalAction(token, 'pin'))}" `
    + `autocomplete="off" data-pin-form data-error="${error ? '1' : '0'}">`
    + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
    + '<p class="pin-label">4 位数字 PIN</p>'
    + `<div class="pin-boxes${errorClass}">${cells}</div>`
    + err + left
    + '<button class="btn btn--primary" type="submit">继续</button>'
    + '</form></section>'
    + `<script nonce="${escapeHtml(nonce)}">${PIN_SCRIPT}</script>`;
  return pageShell({ title: '审批提案 · 输入 PIN', body });
}

function renderCardsPage({
  csrf,
  token,
  credentialLabel,
  cards,
  remaining,
  deleteCount,
  trashMode,
  retentionDays,
  banner = '',
}) {
  const impact = deleteCount
    ? `<p class="ai-impact">其中 ${deleteCount} 条为删除日程，批准后${trashMode ? `可在 ${Number(retentionDays) || 14} 天内还原` : '无法恢复'}。</p>`
    : '';
  const batch = remaining >= 2
    ? `<form class="ai-section__batch" method="post" action="${escapeHtml(approvalAction(token, 'batch'))}">`
      + `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`
      + '<button class="btn btn--primary ai-proposals-approve" type="submit" name="decision" value="approve" aria-label="全部批准">'
      + `<span class="btn__icon">${pageIcon('check')}</span><span class="btn__label">全部批准</span></button>`
      + '<button class="btn btn--danger ai-proposals-reject" type="submit" name="decision" value="reject" aria-label="全部拒绝">'
      + `<span class="btn__icon">${pageIcon('close')}</span><span class="btn__label">全部拒绝</span></button>`
      + '</form>'
    : '';
  const body = '<div class="ai-section__head">'
    + '<h1 class="ai-section__title">提案队列</h1>'
    + `<span class="ai-count">待确认 ${remaining} 条</span>`
    + '<div class="ai-section__actions">'
    + '<a class="btn btn--ghost ai-proposals-refresh" href="" aria-label="刷新">'
    + `<span class="btn__icon">${pageIcon('sync')}</span><span class="btn__label">刷新</span></a>`
    + batch
    + '</div></div>'
    + impact
    + (banner ? `<div class="ai-banner" role="status">${banner}</div>` : '')
    + `<div class="ai-section__body">\n${cards.join('\n')}\n</div>`;
  return pageShell({ title: '提案队列 · FnCal', body });
}

function renderMessagePage(httpStatus, message, { title = '审批提案', hint = '' } = {}) {
  const body = '<p class="brand">FnCal</p>\n' + `<h1>${escapeHtml(title)}</h1>\n`
    + `<p class="lede">${escapeHtml(message)}</p>`
    + (hint ? `<p class="hint">${escapeHtml(hint)}</p>` : '');
  return pageShell({ title: `${title} · FnCal`, body });
}
function bannerForSingle(verb, view, decision) {
  if (decision && decision.ok) return `已${verb}「${escapeHtml(view.title)}」。`;
  const reason = BATCH_FAILURE_TEXT[(decision && decision.code) || 'failed'] || '处理失败';
  return `「${escapeHtml(view.title)}」${escapeHtml(reason)}。`;
}

function bannerForBatch(verb, batch, failedRows) {
  const failed = Array.isArray(failedRows) ? failedRows : [];
  const parts = [`${verb} ${batch.ok} 条`];
  if (batch.failed) parts.push(`${batch.failed} 条失败`);
  let html = escapeHtml(parts.join('，')) + '。';
  if (failed.length) {
    html += '<ul>' + failed
      .map((entry) => `<li>${escapeHtml(entry.title || '提案')}：${escapeHtml(entry.message || '失败')}</li>`)
      .join('') + '</ul>';
  }
  return html;
}

/**
 * @param {{
 *   aiStore: object, aiService: object, approvalLinks: object,
 *   audit?: object, logger?: object, now?: () => number,
 *   pinVerifier?: (pin: string, hash: string) => Promise<boolean>,
 *   rateLimiter?: object,
 * }} deps
 */
export function createApprovalPage({
  aiStore,
  aiService,
  approvalLinks,
  audit = null,
  logger = null,
  now = () => Date.now(),
  pinVerifier = verifyPin,
  rateLimiter = null,
  // 0.4.26（S13/S14）：读链接所属用户的 accentColor / theme；null 表示不读（测试/静态页）。
  readAccent = null,
} = {}) {
  if (!aiStore) throw new Error('createApprovalPage 需要 aiStore');
  if (!aiService) throw new Error('createApprovalPage 需要 aiService');
  if (!approvalLinks) throw new Error('createApprovalPage 需要 approvalLinks');

  // 已通过 PIN 的链接（对象身份，内存）：链接 10 分钟内有效，进程重启即失效，不需要持久化。
  const unlocked = new WeakSet();

  // 0.4.26（S13–S15）：只读 accentColor / theme 两个字段；读失败或非法值回落
  // 默认色 + 跟随系统，且不阻塞页面（S15：不写日志之外的任何设置内容）。
  async function skinFor(link) {
    let accentColor = '';
    let theme = 'system';
    if (readAccent && link && link.userId) {
      try {
        const got = await readAccent(link.userId);
        if (got && typeof got === 'object') {
          accentColor = typeof got.accentColor === 'string' ? got.accentColor : '';
          theme = got.theme;
        }
      } catch (err) {
        logEvent('approval-page-theme-fallback', { id: link.id, message: String((err && err.message) || err) });
      }
    }
    if (theme !== 'dark' && theme !== 'light') theme = 'system';
    return { theme, accentCss: accentCssFor(accentColor) };
  }

  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function writeAudit(record) {
    if (!audit || typeof audit.write !== 'function') return;
    try {
      audit.write({ type: 'ai', event: 'approval-page', ...record });
    } catch {
      /* 审计失败不影响页面结果 */
    }
  }

  function parsePath(pathname) {
    if (!pathname || !pathname.startsWith(APPROVAL_PAGE_PREFIX)) return null;
    const rest = pathname.slice(APPROVAL_PAGE_PREFIX.length);
    if (!rest) return null;
    const parts = rest.split('/');
    if (parts.length === 1) return { token: decodeURIComponent(parts[0]), action: 'view' };
    if (parts.length === 2 && (parts[1] === 'pin' || parts[1] === 'decision' || parts[1] === 'batch')) {
      return { token: decodeURIComponent(parts[0]), action: parts[1] };
    }
    return null;
  }

  function statusPage(res, httpStatus, state) {
    const message = APPROVAL_REASON_TEXTS[state] || APPROVAL_REASON_TEXTS.unknown;
    const titles = { expired: '链接已过期', completed: '已处理完', locked: '链接已作废', used: '链接已使用' };
    sendHtml(res, httpStatus, renderMessagePage(httpStatus, message, {
      title: titles[state] || '链接无效',
      hint: '审批链接只在本机有效，10 分钟内可用。',
    }));
  }

  async function loadCredential(link) {
    if (!link) return null;
    const credential = await aiStore.getCredential(link.userId, link.credentialId);
    if (!credential || credential.revokedAt) return null;
    return credential;
  }

  async function colorMapFor(userId) {
    const map = new Map();
    try {
      const metas = await aiStore.listCalendarMetasFor(userId);
      for (const meta of Array.isArray(metas) ? metas : []) {
        if (meta && meta.id) map.set(meta.id, meta.color || '');
      }
    } catch {
      /* 取不到颜色就退回 accent */
    }
    return map;
  }

  async function trashContext(userId, credential) {
    let retentionDays = 14;
    try {
      const settings = await aiStore.readSettings();
      const days = Number(settings && settings.trashRetentionDays);
      if ([3, 7, 14, 30].includes(days)) retentionDays = days;
    } catch {
      /* 用默认 14 天 */
    }
    return { trashMode: credential.deleteMode === 'trash', retentionDays };
  }

  function rowCtx(link, credential, remoteAddress) {
    return {
      userId: link.userId,
      credential,
      method: 'POST',
      route: APPROVAL_PAGE_PREFIX,
      action: link.action || null,
      nowMs: now(),
      source: 'ai-web-link',
      remoteAddress: remoteAddress || null,
      session: null,
    };
  }

  async function visibleRows(link, credential) {
    const ctx = rowCtx(link, credential, null);
    const rows = await aiService.listAgentProposals(ctx, { ids: link.proposalIds });
    const wanted = new Set(link.proposalIds.map(String));
    return (Array.isArray(rows) ? rows : []).filter((row) => row && wanted.has(String(row.id)));
  }

  function rememberSnapshots(link, rows) {
    for (const row of rows) approvalLinks.rememberSnapshot(link, row.id, viewOfRow(row));
  }

  function cardsFor(link, rows, context) {
    const byId = new Map(rows.map((row) => [String(row.id), viewOfRow(row)]));
    const cards = [];
    for (const id of link.proposalIds) {
      const decision = approvalLinks.decisionOf(link, id);
      if (decision) {
        const view = approvalLinks.snapshotOf(link, id) || byId.get(id);
        if (view) cards.push(renderDoneCard(view, decision, context));
        continue;
      }
      const view = byId.get(id);
      if (view) cards.push(renderPendingCard(view, { ...context, csrf: link.csrf }));
    }
    return { cards, pending: approvalLinks.remainingCount(link) };
  }

  function deleteCountOf(link, rows) {    const rowById = new Map(rows.map((row) => [String(row.id), row]));
    const deleteIds = new Set();
    for (const id of link.proposalIds) {
      const view = approvalLinks.snapshotOf(link, id);
      const row = rowById.get(id);
      const action = (view && view.action) || (row && row.action);
      if (action === 'delete') deleteIds.add(id);
    }
    return deleteIds.size;
  }

  /**
   * 0.4.23（S11/S13）：审批页只在「代办批准开启 + 已设 PIN」时要 PIN。
   * 代办批准关闭或两档操作方式都不是「提案」时，存量 PIN 哈希一律不生效。
   */
  function pinRequiredFor(credential) {
    const approvalAllowed = credential.writeMode === 'proposal' || credential.deleteMode === 'proposal';
    return credential.agentApproval === true && approvalAllowed && Boolean(credential.pinHash);
  }

  async function renderListPage(res, { link, credential, token, banner = '', forceList = false }) {
    const rows = await visibleRows(link, credential);
    rememberSnapshots(link, rows);
    const { trashMode, retentionDays } = await trashContext(link.userId, credential);
    const colorById = await colorMapFor(link.userId);
    const context = { token, colorById, credentialLabel: credential.label, trashMode, retentionDays };
    const { cards, pending } = cardsFor(link, rows, context);
    if (forceList) {
      // 刚处理完的响应要显示每条的最终状态（S2/S3）：即使已全部处理完也回列表页。
      if (!cards.length) {
        sendHtml(res, 200, renderMessagePage(200,
          '这些提案已经不在了：可能已被处理，或已过期。',
          { title: '没有待处理的提案', hint: '请回到 AI 助手重新发起批准。' }));
        return;
      }
      sendHtml(res, 200, renderCardsPage({
        csrf: link.csrf,
        token,
        credentialLabel: credential.label,
        cards,
        remaining: pending,
        total: link.proposalIds.length,
        deleteCount: deleteCountOf(link, rows),
        trashMode,
        retentionDays,
        banner,
      }));
      return;
    }
    if (!pending && !cards.length) {
      sendHtml(res, 200, renderMessagePage(200,
        '这些提案已经不在了：可能已被处理，或已过期。',
        { title: '没有待处理的提案', hint: '请回到 AI 助手重新发起批准。' }));
      return;
    }
    if (!pending) {
      sendHtml(res, 200, renderMessagePage(200,
        '这批提案已经全部处理完，审批链接已失效。',
        { title: '已处理完', hint: '请回到 AI 助手查看结果。' }));
      return;
    }
    sendHtml(res, 200, renderCardsPage({
      csrf: link.csrf,
      token,
      credentialLabel: credential.label,
      cards,
      remaining: pending,
      total: link.proposalIds.length,
      deleteCount: deleteCountOf(link, rows),
      trashMode,
      retentionDays,
      banner,
    }));
  }

  async function renderView(res, { link, credential, token }) {
    if (pinRequiredFor(credential) && !unlocked.has(link)) {
      const nonce = randomBytes(16).toString('base64');
      sendHtml(res, 200, renderPinPage({
        csrf: link.csrf,
        token,
        credentialLabel: credential.label,
        attemptsLeft: approvalLinks.pinAttemptsLeft(link),
        nonce,
      }), {
        'Content-Security-Policy':
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
      return;
    }
    await renderListPage(res, { link, credential, token });
  }

  function pinFromForm(form) {
    const cells = ['pin1', 'pin2', 'pin3', 'pin4'].map((name) => String(form.get(name) || '').trim());
    if (cells.every((digit) => /^\d$/.test(digit))) return cells.join('');
    const raw = String(form.get('pin') || '').trim();
    return /^\d{4}$/.test(raw) ? raw : '';
  }

  async function handlePin(req, res, { link, credential, token }) {
    const raw = await readBody(req);
    if (raw === null) return sendHtml(res, 413, renderMessagePage(413, '提交内容过大。', { title: '无法处理' }));
    const form = new URLSearchParams(raw);
    if (!safeEqual(form.get('csrf'), link.csrf)) {
      return sendHtml(res, 403, renderMessagePage(403, '表单已失效，请刷新页面重试。', { title: '无法处理' }));
    }
    const pin = pinFromForm(form);
    // 0.4.23（S11/S13）：不需要 PIN 的链接不接受 PIN 提交，避免误用旧哈希。
    if (!pinRequiredFor(credential)) {
      return sendHtml(res, 400, renderMessagePage(400, '这个链接不需要 PIN。', { title: '无需 PIN' }));
    }
    const ok = pin.length === 4 && await pinVerifier(pin, credential.pinHash);
    if (!ok) {
      const result = approvalLinks.registerPinFailure(link);
      writeAudit({
        event: 'approval-page-pin-failed',
        id: link.id,
        remoteAddress: req.socket && req.socket.remoteAddress,
        attemptsLeft: result.attemptsLeft,
      });
      if (result.locked) {
        logEvent('approval-link-locked', { id: link.id });
        return statusPage(res, 410, 'locked');
      }
      const nonce = randomBytes(16).toString('base64');
      return sendHtml(res, 200, renderPinPage({
        csrf: link.csrf,
        token,
        credentialLabel: credential.label,
        error: 'PIN 不对，请重试。',
        attemptsLeft: result.attemptsLeft,
        nonce,
      }), {
        'Content-Security-Policy':
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
    }
    unlocked.add(link);
    logEvent('approval-link-unlocked', { id: link.id });
    res.writeHead(303, { Location: `/a/${encodeURIComponent(token)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  function auditDecision({ link, credential, id, action, ok, code, mode, remoteAddress }) {
    writeAudit({
      event: 'proposal-decision',
      decidedBy: 'agent',
      proposalId: id,
      action,
      ok,
      code: ok ? '' : code,
      userId: link.userId,
      credentialId: credential.id,
      remoteAddress,
      via: 'web_link',
      pin: pinRequiredFor(credential),
      mode,
    });
  }

  function auditBatch({ link, credential, action, batch, mode, remoteAddress }) {
    writeAudit({
      event: 'proposal-batch-decision',
      action: action === 'accept' ? 'bulk_accept' : 'bulk_reject',
      decidedBy: 'agent',
      via: 'web_link',
      pin: pinRequiredFor(credential),
      mode,
      userId: link.userId,
      credentialId: credential.id,
      total: batch.total,
      ok: batch.ok,
      failed: batch.failed,
      remoteAddress,
    });
  }

  async function executeClaimed({ link, credential, decision, claimed, rows, remoteAddress, mode }) {
    const action = decision === 'reject' ? 'reject' : 'accept';
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const ids = claimed.map(String);
    let batch;
    try {
      batch = await runProposalBatch({
        action,
        ids,
        decideOne: async (id) => {
          const outcome = await aiService.agentDecide(rowCtx(link, credential, remoteAddress), id, action, {
            reason: '用户通过审批链接确认',
          });
          if (!outcome || outcome.missing) return { missing: true };
          return { status: outcome.status || (action === 'accept' ? 'accepted' : 'rejected') };
        },
        onItem: (entry) => {
          auditDecision({
            link,
            credential,
            id: entry.id,
            action,
            ok: entry.ok,
            code: entry.ok ? '' : entry.code,
            mode,
            remoteAddress,
          });
        },
      });
    } catch (err) {
      approvalLinks.release(link, claimed);
      throw err;
    }
    const results = new Map((batch.results || []).map((entry) => [String(entry.id), entry]));
    const failedRows = [];
    for (const id of ids) {
      const entry = results.get(id) || { ok: false, code: 'failed' };
      approvalLinks.settle(link, id, { action, ok: entry.ok === true, code: entry.ok ? '' : entry.code });
      if (!entry.ok) {
        const view = approvalLinks.snapshotOf(link, id) || (byId.get(id) ? viewOfRow(byId.get(id)) : null);
        failedRows.push({
          id,
          title: String((view && view.title) || proposalTitleOf(byId.get(id) || {}) || '提案').slice(0, 80),
          message: BATCH_FAILURE_TEXT[entry.code] || '处理失败',
        });
      }
    }
    auditBatch({ link, credential, action, batch, mode, remoteAddress });
    logEvent('approval-link-decision', {
      id: link.id,
      action,
      mode,
      pin: pinRequiredFor(credential),
      total: batch.total,
      ok: batch.ok,
      failed: batch.failed,
    });
    return { batch, failedRows, action };
  }

  async function handleDecision(req, res, { link, credential, remoteAddress, token }) {
    const raw = await readBody(req);
    if (raw === null) return sendHtml(res, 413, renderMessagePage(413, '提交内容过大。', { title: '无法处理' }));
    const form = new URLSearchParams(raw);
    if (!safeEqual(form.get('csrf'), link.csrf)) {
      return sendHtml(res, 403, renderMessagePage(403, '表单已失效，请刷新页面重试。', { title: '无法处理' }));
    }
    if (pinRequiredFor(credential) && !unlocked.has(link)) {
      return sendHtml(res, 403, renderMessagePage(403, '请先输入 PIN。', { title: '需要 PIN' }));
    }
    const decision = form.get('decision') === 'reject' ? 'reject' : 'approve';
    const id = String(form.get('id') || '').trim();
    if (!id) return sendHtml(res, 400, renderMessagePage(400, '缺少要处理的提案。', { title: '无法处理' }));
    const again = approvalLinks.resolve(token);
    if (again.state !== 'ok') return statusPage(res, again.state === 'unknown' ? 404 : 410, again.state);

    const rows = await visibleRows(link, credential);
    rememberSnapshots(link, rows);
    const { claimed } = approvalLinks.claim(link, [id]);
    if (!claimed.length) {
      // 已处理/处理中：零执行，回列表并显示当前状态。
      const row = rows.find((entry) => String(entry.id) === id);
      const view = approvalLinks.snapshotOf(link, id) || (row ? viewOfRow(row) : null);
      const banner = view ? `「${escapeHtml(view.title)}」已处理，不需要重复提交。` : '这一条已经处理过了。';
      return renderListPage(res, { link, credential, token, banner, forceList: true });
    }
    let outcome;
    try {
      outcome = await executeClaimed({ link, credential, decision, claimed, rows, remoteAddress, mode: 'single' });
    } catch (err) {
      logEvent('approval-link-error', { id: link.id, message: String((err && err.message) || err) });
      writeAudit({
        event: 'approval-page-error',
        id: link.id,
        credentialId: credential.id,
        remoteAddress,
        message: String((err && err.message) || err),
      });
      return sendHtml(res, 500, renderMessagePage(500, '处理失败，请稍后重试。', { title: '无法处理' }));
    }
    const view = approvalLinks.snapshotOf(link, claimed[0]) || (rows[0] ? viewOfRow(rows[0]) : { title: '提案' });
    const decisionResult = approvalLinks.decisionOf(link, claimed[0]);
    const banner = bannerForSingle(DECISION_VERBS[outcome.action], view, decisionResult);
    return renderListPage(res, { link, credential, token, banner, forceList: true });
  }

  async function handleBatch(req, res, { link, credential, remoteAddress, token }) {
    const raw = await readBody(req);
    if (raw === null) return sendHtml(res, 413, renderMessagePage(413, '提交内容过大。', { title: '无法处理' }));
    const form = new URLSearchParams(raw);
    if (!safeEqual(form.get('csrf'), link.csrf)) {
      return sendHtml(res, 403, renderMessagePage(403, '表单已失效，请刷新页面重试。', { title: '无法处理' }));
    }
    if (pinRequiredFor(credential) && !unlocked.has(link)) {
      return sendHtml(res, 403, renderMessagePage(403, '请先输入 PIN。', { title: '需要 PIN' }));
    }
    const decision = form.get('decision') === 'reject' ? 'reject' : 'approve';
    const again = approvalLinks.resolve(token);
    if (again.state !== 'ok') return statusPage(res, again.state === 'unknown' ? 404 : 410, again.state);
    const rows = await visibleRows(link, credential);
    rememberSnapshots(link, rows);
    const wanted = approvalLinks.pendingIds(link);
    const { claimed } = approvalLinks.claim(link, wanted);
    if (!claimed.length) {
      return renderListPage(res, { link, credential, token, banner: '没有需要处理的提案了。', forceList: true });
    }
    let outcome;
    try {
      outcome = await executeClaimed({ link, credential, decision, claimed, rows, remoteAddress, mode: 'all' });
    } catch (err) {
      logEvent('approval-link-error', { id: link.id, message: String((err && err.message) || err) });
      writeAudit({
        event: 'approval-page-error',
        id: link.id,
        credentialId: credential.id,
        remoteAddress,
        message: String((err && err.message) || err),
      });
      return sendHtml(res, 500, renderMessagePage(500, '处理失败，请稍后重试。', { title: '无法处理' }));
    }
    const banner = bannerForBatch(DECISION_VERBS[outcome.action], outcome.batch, outcome.failedRows);
    return renderListPage(res, { link, credential, token, banner, forceList: true });
  }

  /**
   * 处理 `/a/` 路由；命中返回 true，未命中返回 false（server 继续走后面的路由）。
   */
  async function handle(req, res, options = {}) {
    const pathname = options.pathname || (() => {
      try {
        return new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        return '';
      }
    })();
    const parsed = parsePath(pathname);
    if (!parsed) {
      // 0.4.25（S2）：`/a/` 前缀下解析失败（如 `/a/<token>/` 尾斜杠）直接 404，不再回落到后面的路由挂起。
      if (String(pathname).startsWith(APPROVAL_PAGE_PREFIX)) {
        sendHtml(res, 404, renderMessagePage(404, '这个审批链接无效。请回到 AI 助手重新发起批准。', { title: '链接无效' }));
        return true;
      }
      return false;
    }
    const remoteAddress = options.remoteAddress || (req.socket && req.socket.remoteAddress) || null;

    if (rateLimiter && typeof rateLimiter.hit === 'function') {
      const verdict = rateLimiter.hit(remoteAddress || 'unknown', PAGE_RATE_LIMIT);
      if (!verdict.allowed) {
        sendHtml(res, 429, renderMessagePage(429, '请求过于频繁，请稍后再试。', { title: '请稍后再试' }),
          { 'Retry-After': String(verdict.retryAfterSec) });
        return true;
      }
    }

    const { link, state } = approvalLinks.resolve(parsed.token);
    if (state !== 'ok') {
      statusPage(res, state === 'unknown' ? 404 : 410, state);
      return true;
    }
    const credential = await loadCredential(link);
    if (!credential) {
      statusPage(res, 404, 'unknown');
      return true;
    }

    const skin = await skinFor(link);
    return pageSkinStore.run(skin, async () => {
      if (req.method === 'GET' && parsed.action === 'view') {
        await renderView(res, { link, credential, token: parsed.token });
        return true;
      }
      if (req.method === 'POST' && parsed.action === 'pin') {
        await handlePin(req, res, { link, credential, token: parsed.token });
        return true;
      }
      if (req.method === 'POST' && parsed.action === 'decision') {
        await handleDecision(req, res, { link, credential, remoteAddress, token: parsed.token });
        return true;
      }
      if (req.method === 'POST' && parsed.action === 'batch') {
        await handleBatch(req, res, { link, credential, remoteAddress, token: parsed.token });
        return true;
      }
      sendHtml(res, 405, renderMessagePage(405, '这个地址只支持打开链接与提交表单。', { title: '不支持的方法' }));
      return true;
    });
  }

  function tokenOf(req) {
    try {
      return new URL(req.url || '/', 'http://localhost').pathname.slice(APPROVAL_PAGE_PREFIX.length).split('/')[0];
    } catch {
      return '';
    }
  }

  return { handle, prefix: APPROVAL_PAGE_PREFIX };
}
