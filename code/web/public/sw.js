/**
 * FnCal 静态外壳 Service Worker。
 *
 * 只缓存同源静态资源（Vite 产物、图标、manifest）；绝不拦截或缓存 `/api/*`
 * —— 日历数据必须始终走网络，离线写入由应用层（offline.js）的写闸门拒绝，
 * 这样缓存与数据同步永远不会互相污染。
 *
 * 缓存策略：
 *   - 导航（HTML）→ 网络优先，失败回退到缓存的 ./index.html；
 *   - 同源静态资源 → stale-while-revalidate（Vite 资源带内容哈希，可安全缓存）；
 *   - 跨源请求 → 完全不拦截（本应用运行期不发跨源请求）。
 *
 * 注意：skipWaiting()+clients.claim() 之所以安全，是因为应用没有动态 import()，
 * 在线会话中不会中途请求新的哈希分块。
 */
const CACHE = 'fncal-shell-v1';

// 最小外壳：保证可安装、可离线打开。带哈希的 JS/CSS 在首次抓取时懒缓存。
const SHELL = [
  './',
  './index.html',
  './site.webmanifest',
  './favicon.ico',
  './favicon-32x32.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  // 0.2.4 ⑭：首屏主题色 prepaint（构建期由 stamp-version 追加 ?v=<version>，
  // 与 index.html 的引出一致，离线时也能命中缓存）。
  './accent-prepaint.js',
];

const ASSET_URL_RE = /["'](\.?\/?assets\/[^"']+)["']/g;

/** 预缓存 index.html 引用的哈希资源，避免首次离线打开缺少 JS/CSS。 */
async function precacheShellAssets(cache) {
  try {
    const shell = await cache.match('./index.html');
    if (!shell) return;
    const html = await shell.clone().text();
    const urls = new Set();
    for (const m of html.matchAll(ASSET_URL_RE)) urls.add(m[1]);
    await Promise.allSettled([...urls].map((url) => cache.add(url)));
  } catch {
    /* 资源发现失败不应让安装失败 */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.allSettled(SHELL.map((url) => cache.add(url))).then(() => precacheShellAssets(cache)),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 只有完整、同源的基本响应才可缓存。 */
function isCacheableAsset(resp) {
  return resp && resp.ok && resp.type === 'basic';
}

/** 清理当前外壳不再引用的旧哈希资源。 */
async function pruneStaleAssets(cache) {
  try {
    const shell = await cache.match('./index.html');
    if (!shell) return;
    const html = await shell.clone().text();
    const current = new Set();
    for (const m of html.matchAll(ASSET_URL_RE)) current.add(new URL(m[1], self.location.href).pathname);
    if (!current.size) return;
    const keys = await cache.keys();
    const stale = keys.filter((req) => {
      const url = new URL(req.url);
      return url.origin === self.location.origin && url.pathname.includes('/assets/') && !current.has(url.pathname);
    });
    await Promise.all(stale.map((req) => cache.delete(req)));
  } catch {
    /* 清理是尽力而为，绝不因此阻断导航 */
  }
}

/** 保存外壳副本；被重定向过的响应需要重新包装后才能用于导航。 */
async function putShellCopy(cache, fresh) {
  try {
    if (!fresh.redirected) {
      await cache.put('./index.html', fresh.clone());
      return;
    }
    const body = await fresh.clone().blob();
    await cache.put('./index.html', new Response(body, { status: 200, headers: fresh.headers }));
  } catch {
    /* 尽力而为 */
  }
}

async function networkFirstNavigation(event, request) {
  const cache = await caches.open(CACHE);
  const path = new URL(request.url).pathname;
  const scopePath = new URL(self.registration.scope).pathname;
  const isShell = path === scopePath || path.endsWith('/index.html');
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && isShell)
      event.waitUntil(putShellCopy(cache, fresh).then(() => pruneStaleAssets(cache)));
    return fresh;
  } catch {
    if (!isShell) return Response.error();
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (isCacheableAsset(resp)) return cache.put(request, resp.clone()).then(() => resp);
      return resp;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 写请求与 API 一律不拦截：数据永远走网络，缓存不参与同步。
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // 跨源请求不拦截（运行期应为零）。
  if (url.origin !== self.location.origin) return;
  // API 请求不拦截、不缓存。
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/v1/')) return;

  event.respondWith(
    (async () => {
      try {
        if (request.mode === 'navigate') return await networkFirstNavigation(event, request);
        return await staleWhileRevalidate(event, request);
      } catch {
        return fetch(request);
      }
    })(),
  );
});
