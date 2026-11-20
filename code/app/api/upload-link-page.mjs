// 0.9.1（C.3 / C.4）：附件上传链接页 `/u/a/<令牌>`。
//
// 目的：AI 不传文件字节，只签一个链接，用户在自己手机浏览器里选照片，
// 附件直接落到指定的那一次日程（实例键 `<uid>::<recurrenceId>`）。
//
// 安全口径（与审批页 `approval-page.mjs` 一致）：
//   - 令牌只存 SHA-256，明文只在签发时回一次；
//   - 只凭令牌 + PIN，不要求登录（用户 2026-11-20 纠正，与审批页同一口径）；
//   - 凭据设了 PIN 时先出四格 PIN 表单，每链接 5 次错误即失效，验过对被链接有效；
//   - 每次访问都重新读凭据：附件开关关闭后已签发的链接立即失效。

import { randomBytes } from 'node:crypto';

import { eventFromIcs, expandToIcs } from '../lib/ical.mjs';
import { verifyPin } from '../lib/pin.mjs';
import { runWithContext } from '../lib/request-context.mjs';

/** 上传链接页的前缀；注册时必须早于通用 `/api/` 与年度总结 `/i/`。 */
export const UPLOAD_LINK_PREFIX = '/u/a/';

const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.txt';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(ms, allDay) {
  const at = new Date(Number(ms) || Date.now());
  const pad = (v) => String(v).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  if (allDay) return date;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const BASE_CSS = `
  :root { color-scheme: light dark; --ink:#16202e; --ink-2:#55637a; --line:#dde5ef; --card:#fff; --bg:#eef3f9; --accent:#1e72d6; --accent-ink:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#eaf0f8; --ink-2:#9fb0c6; --line:#2b3646; --card:#131a24; --bg:#0c1118; --accent:#4b96ef; --accent-ink:#08121f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 40px; background:var(--bg); color:var(--ink);
    font:16px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-text-size-adjust:100%; }
  main { width:100%; max-width:560px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:20px; line-height:1.4; letter-spacing:.01em; }
  h2 { margin:0 0 8px; font-size:15px; line-height:1.4; color:var(--ink-2); font-weight:600; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px;
    box-shadow:0 1px 2px rgba(16,32,56,.06), 0 12px 32px rgba(16,32,56,.06); }
  .card + .card { margin-top:14px; }
  .meta { margin:0; color:var(--ink-2); font-size:13px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top:14px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 20px;
    border:1px solid var(--line); border-radius:12px; background:var(--accent); color:var(--accent-ink);
    font-size:16px; font-weight:600; text-decoration:none; cursor:pointer; }
  .btn:disabled { opacity:.55; cursor:progress; }
  .filelist { list-style:none; margin:10px 0 0; padding:0; }
  .filelist li { display:flex; align-items:center; gap:10px; min-height:44px; border-top:1px solid var(--line); }
  .filelist li:first-child { border-top:0; }
  .name { flex:1 1 0%; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:600; }
  .size { flex:0 0 auto; color:var(--ink-2); font-size:13px; }
  .note { margin:12px 2px 0; color:var(--ink-2); font-size:13px; }
  .pin { display:flex; gap:10px; margin-top:14px; }
  .pin input { width:52px; height:56px; text-align:center; font-size:22px; border:1px solid var(--line);
    border-radius:12px; background:var(--card); color:var(--ink); }
  .pin input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .progress { margin-top:12px; }
  .progress .bar { height:8px; border-radius:999px; background:var(--line); overflow:hidden; }
  .progress .bar span { display:block; width:0; height:100%; border-radius:inherit; background:var(--accent); transition:width 120ms linear; }
  .progress .meta { margin-top:6px; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .progress .btn { margin-top:8px; }
  .status { margin:12px 2px 0; font-size:14px; color:var(--ink-2); }
  .status[data-tone="bad"] { color:#c0392b; }
`;

function shell(title, body, { nonce = '', cspExtra = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>${body}</main>
${nonce ? `<script nonce="${escapeHtml(nonce)}">${cspExtra}</script>` : ''}
</body>
</html>`;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

function sendHtml(res, status, html, headers = {}) {
  const body = Buffer.from(String(html), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': PAGE_CSP,
    ...headers,
  });
  res.end(body);
}

function renderMessage(res, status, title, lead, sub = '') {
  const body = `<div class="card"><p class="status" data-tone="bad">${escapeHtml(lead)}</p>${sub ? `<p class="meta">${escapeHtml(sub)}</p>` : ''}</div>`;
  sendHtml(res, status, shell(title, body));
}

/** 把展开结果里的「第几次」选项读出来（RECURRENCE-ID + DTSTART + SUMMARY）。 */
function readOccurrences(icsText, { take = 20 } = {}) {
  const out = [];
  const blocks = String(icsText || '').split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const rid = /^RECURRENCE-ID[^:]*:(.+)$/m.exec(block);
    const start = /^DTSTART[^:]*:(.+)$/m.exec(block);
    const summary = /^SUMMARY:(.*)$/m.exec(block);
    if (!rid || !start) continue;
    const ridMs = Date.parse(rid[1].trim().replace(/(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?/, '$1-$2-$3T$4:$5:$6Z'));
    if (!Number.isFinite(ridMs)) continue;
    out.push({ recurrenceId: ridMs, start: start[1].trim(), title: summary ? summary[1].trim() : '' });
    if (out.length >= take) break;
  }
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.uploadLinks  `createUploadLinks()` 的实例
 * @param {object} deps.aiStore      读凭据（PIN / 附件开关）
 * @param {object} deps.store        读日程对象
 * @param {object} deps.attachmentStore 列已上传附件
 */
export function createUploadLinkPage({
  uploadLinks,
  aiStore,
  store,
  attachmentStore,
  logger = null,
  pinVerifier = verifyPin,
} = {}) {
  function logEvent(event, detail = {}) {
    if (logger && typeof logger.event === 'function') logger.event(event, detail);
  }

  function credentialOf(entry) {
    if (!entry.credentialId) return null;
    return runWithContext({ userId: entry.userId }, () => aiStore.getCredential(entry.userId, entry.credentialId));
  }

  function targetOf(entry) {
    const baseUid = String(entry.objectKey).split('::')[0];
    return runWithContext({ userId: entry.userId }, async () => {
      const object = await store.getEvent(entry.calendarId, `${baseUid}.ics`);
      if (!object || !object.content) return null;
      const event = await eventFromIcs(object.content);
      const fixedRid = entry.objectKey.includes('::') ? Number(entry.objectKey.split('::')[1]) : 0;
      let options = [];
      if (!fixedRid && event && event.recurrence) {
        try {
          const expanded = await expandToIcs(object.content, { start: Date.now(), end: Date.now() + 120 * 86400000 });
          options = readOccurrences(expanded.ics);
        } catch {
          options = [];
        }
      }
      return { baseUid, event, fixedRid, options };
    });
  }

  function itemsOf(entry) {
    return runWithContext({ userId: entry.userId }, async () => {
      const result = await attachmentStore.listAttachments({
        userId: entry.userId,
        calendarId: entry.calendarId,
        key: entry.objectKey,
      });
      return Array.isArray(result) ? result : (result && result.items) || [];
    });
  }

  function renderPinPage(res, { entry, token, credential, attemptsLeft }) {
    const nonce = randomBytes(16).toString('base64');
    const cells = ['pin1', 'pin2', 'pin3', 'pin4']
      .map((name) => `<input name="${name}" inputmode="numeric" pattern="[0-9]" maxlength="1" autocomplete="one-time-code" aria-label="PIN 第 ${name.slice(-1)} 位">`)
      .join('');
    const body = `<div class="card">
  <h1>${escapeHtml(credential.label || 'FnCal')} 需要 PIN</h1>
  <p class="meta">输入这枚凭据的 4 位 PIN 继续，最多 5 次机会。</p>
  <form method="post" action="${escapeHtml(`${UPLOAD_LINK_PREFIX}${encodeURIComponent(token)}/pin`)}">
    <input type="hidden" name="csrf" value="${escapeHtml(entry.csrf)}">
    <div class="pin">${cells}</div>
    <p class="status">还可尝试 ${Number(attemptsLeft) || 0} 次</p>
    <div class="row"><button class="btn" type="submit">继续</button></div>
  </form>
</div>`;
    sendHtml(res, 200, shell('FnCal · 输入 PIN', body, { nonce }), {
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
  }

  function renderUploadPage(res, { entry, token, credential, target, items }) {
    const nonce = randomBytes(16).toString('base64');
    const fixedLabel = target && target.fixedRid
      ? (target.options.find((o) => o.recurrenceId === target.fixedRid) || null)
      : null;
    const title = (target && target.event && target.event.title) || '日程';
    const when = target && target.event
      ? formatWhen(fixedLabel ? Date.parse(fixedLabel.start) : target.event.start, target.event.allDay)
      : '';
    const remaining = Math.max(0, entry.maxFiles - (entry.files || 0));
    const usedBytes = (entry.bytes || 0);
    const optionsHtml = !target || target.fixedRid || !target.options.length
      ? ''
      : `<label class="meta" for="occurrence">这一次</label>
<select id="occurrence" name="occurrence" class="btn" style="width:100%;margin-top:6px;background:var(--card);color:var(--ink)">
${target.options.map((o) => `<option value="${o.recurrenceId}">${escapeHtml(formatWhen(Date.parse(o.start), false))} · ${escapeHtml(o.title || title)}</option>`).join('')}
</select>`;
    const list = items.length
      ? `<ul class="filelist">${items.map((item) => `<li><span class="name">${escapeHtml(item.name)}</span><span class="size">${escapeHtml(formatBytes(item.bytes))}</span></li>`).join('')}</ul>`
      : '<p class="note">还没有附件。</p>';
    const body = `<h1>上传到「${escapeHtml(title)}」</h1>
<div class="card">
  <p class="meta">${escapeHtml(when)}${fixedLabel ? ' · 这一次' : ''}</p>
  <p class="meta">最多 ${entry.maxFiles} 个文件、${entry.maxBytes == null ? '合计不限大小' : `合计 ${formatBytes(entry.maxBytes)}`}；${entry.maxBytes == null ? '单个不限大小（受磁盘剩余空间限制）' : '单个不超过存储上限'}。</p>
  <p class="meta">已上传 ${entry.files || 0} 个，${formatBytes(usedBytes)}；剩余 ${remaining} 个。</p>
  ${optionsHtml}
  <div class="row">
    <input id="files" type="file" multiple accept="${FILE_ACCEPT}" class="btn" style="background:var(--card);color:var(--ink);padding:10px 12px">
  </div>
  <div class="row"><button id="upload" class="btn" type="button">上传</button></div>
  <div id="progress" class="progress" hidden>
    <div class="bar"><span id="bar"></span></div>
    <p id="ptext" class="meta"></p>
    <button id="cancel" class="btn" type="button">取消上传</button>
  </div>
  <p id="status" class="status" role="status" aria-live="polite"></p>
</div>
<div class="card">
  <h2>已上传</h2>
  ${list}
</div>
<script nonce="${escapeHtml(nonce)}">
(function () {
  var token = ${JSON.stringify(token)};
  var target = ${JSON.stringify(entry.objectKey)};
  var linkCsrf = ${JSON.stringify(entry.csrf)};
  var button = document.getElementById('upload');
  var input = document.getElementById('files');
  var status = document.getElementById('status');
  var select = document.getElementById('occurrence');
  var progress = document.getElementById('progress');
  var bar = document.getElementById('bar');
  var ptext = document.getElementById('ptext');
  var cancel = document.getElementById('cancel');
  var xhr = null;
  var cancelled = false;
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function say(text, bad) {
    status.textContent = text;
    status.setAttribute('data-tone', bad ? 'bad' : 'good');
  }
  function showProgress(index, count, loaded, total) {
    total = Number(total) || 0;
    loaded = Number(loaded) || 0;
    var percent = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
    progress.hidden = false;
    bar.style.width = percent + '%';
    ptext.textContent = '正在上传 ' + (index + 1) + '/' + count + ' · ' + percent + '%（'
      + formatBytes(loaded) + ' / ' + formatBytes(total) + '）';
  }
  cancel.addEventListener('click', function () {
    cancelled = true;
    if (xhr) { try { xhr.abort(); } catch (e) {} }
  });
  function uploadOne(file, headers, index, count) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      xhr = x;
      x.open('POST', '/api/v1/upload-links/' + encodeURIComponent(token) + '/files', true);
      Object.keys(headers).forEach(function (key) { x.setRequestHeader(key, headers[key]); });
      x.upload.onprogress = function (evt) {
        if (evt.lengthComputable) showProgress(index, count, evt.loaded, evt.total);
        else showProgress(index, count, 0, Number(file.size) || 0);
      };
      x.onload = function () {
        xhr = null;
        var data = {};
        try { data = JSON.parse(x.responseText || '{}'); } catch (e) {}
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new Error(data.message || ('HTTP ' + x.status)));
      };
      x.onerror = function () { xhr = null; reject(new Error('网络错误')); };
      x.onabort = function () {
        xhr = null;
        var err = new Error('已取消上传');
        err.cancelled = true;
        reject(err);
      };
      x.send(file);
    });
  }
  button.addEventListener('click', async function () {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) { say('先选照片或文件。', true); return; }
    button.disabled = true;
    cancel.disabled = false;
    cancelled = false;
    var done = 0;
    for (var i = 0; i < files.length; i += 1) {
      if (cancelled) break;
      var file = files[i];
      say('正在上传 ' + (i + 1) + '/' + files.length + '…');
      try {
        var headers = {
          'Accept': 'application/json',
          'Content-Type': file.type || 'application/octet-stream',
          'X-FnCal-Filename': encodeURIComponent(file.name),
          'X-FnCal-Link-Csrf': linkCsrf
        };
        if (select && select.value) headers['X-FnCal-Recurrence-Id'] = select.value;
        await uploadOne(file, headers, i, files.length);
        done += 1;
      } catch (err) {
        if (cancelled || (err && err.cancelled)) {
          say('已取消上传，已传的 ' + done + ' 个保留。', true);
          button.disabled = false;
          progress.hidden = true;
          return;
        }
        say('第 ' + (i + 1) + ' 个失败：' + (err && err.message ? err.message : '未知错误'), true);
        button.disabled = false;
        return;
      }
    }
    if (cancelled) {
      say('已取消上传，已传的 ' + done + ' 个保留。', true);
      button.disabled = false;
      progress.hidden = true;
      return;
    }
    say('已收到 ' + done + ' 个文件，正在刷新…');
    location.reload();
  });
</script>`;
    sendHtml(res, 200, shell('FnCal · 上传附件', body, { nonce }), {
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
    });
  }

  function readForm(req, limit = 4096) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });
  }

  async function handlePinSubmit(req, res, { entry, token }) {
    const raw = await readForm(req);
    if (raw === null) return renderMessage(res, 413, '无法处理', '提交内容过大。');
    const form = new URLSearchParams(raw);
    if (String(form.get('csrf') || '') !== entry.csrf) {
      return renderMessage(res, 403, '无法处理', '表单已失效，请刷新页面重试。');
    }
    const credential = await credentialOf(entry);
    if (!credential) return renderMessage(res, 403, '链接已失效', '签发这枚链接的凭据已被删除。');
    if (credential.allowAttachments === false) {
      return renderMessage(res, 403, '链接已失效', '该凭据未开启附件权限。');
    }
    const pin = ['pin1', 'pin2', 'pin3', 'pin4'].map((name) => String(form.get(name) || '').trim()).join('');
    const verifier = pinVerifier || (async () => false);
    const okPin = /^\d{4}$/.test(pin) && await verifier(pin, credential.pinHash);
    if (!okPin) {
      const result = uploadLinks.registerPinFailure(entry);
      logEvent('upload-link-pin-failed', { id: entry.id.slice(0, 8), attemptsLeft: result.attemptsLeft });
      if (result.locked) {
        return renderMessage(res, 410, '链接已失效', 'PIN 错误次数过多，这条上传链接已失效。');
      }
      return renderPinPage(res, {
        entry, token, credential, attemptsLeft: result.attemptsLeft,
      });
    }
    uploadLinks.unlock(entry);
    res.writeHead(303, { Location: `${UPLOAD_LINK_PREFIX}${encodeURIComponent(token)}`, 'Cache-Control': 'no-store' });
    res.end();
    return undefined;
  }

  async function handle(req, res, url) {
    const pathname = String((url && url.pathname) || '');
    const rest = pathname.slice(UPLOAD_LINK_PREFIX.length);
    const isPinSubmit = /\/pin$/.test(rest);
    const token = decodeURIComponent(isPinSubmit ? rest.replace(/\/pin$/, '') : rest);
    const { entry, state } = uploadLinks.resolve(token);
    if (state === 'unknown') return renderMessage(res, 404, '链接不存在', '这个上传链接不存在。', '请回到 AI 助手重新索取一条。');
    if (state !== 'ok') return renderMessage(res, 410, '链接已失效', '这条上传链接已过期或已失效。', '请回到 AI 助手重新索取一条。');

    // 用户 2026-11-20 纠正：只凭令牌 + PIN，不要求登录（与审批页同一口径）。
    // 页面与上传接口都以链接绑定的 userId 身份执行，不读会话、不写会话。
    // 每次访问都重新读凭据：附件开关关闭 → 已签发的链接立即失效。
    const credential = await credentialOf(entry);
    if (!credential) return renderMessage(res, 403, '链接已失效', '签发这枚链接的凭据已被删除。');
    if (credential.allowAttachments === false) {
      return renderMessage(res, 403, '链接已失效', '该凭据未开启附件权限。');
    }

    // PIN（凭据设了才要；验过对被链接有效）。
    if (isPinSubmit) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return undefined;
      }
      return handlePinSubmit(req, res, { entry, token });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end();
      return undefined;
    }
    if (credential.pinHash && !entry.unlocked) {
      return renderPinPage(res, {
        entry, token, credential, attemptsLeft: uploadLinks.pinAttemptsLeft(entry),
      });
    }

    const target = await targetOf(entry);
    if (!target) return renderMessage(res, 404, '日程不存在', '这条链接指向的日程已被删除。');
    const items = await itemsOf(entry);
    return renderUploadPage(res, { entry, token, credential, target, items });
  }

  return { handle, prefix: UPLOAD_LINK_PREFIX };
}
