/**
 * Vitest setup, run before every test file.
 *
 * M3.7：这里原本只处理 localStorage；剥离 Puter 后测试里不再有 `puter` 全局，
 * 数据层改为 REST（fetch）。因此在 setup 里装一个「默认拒绝」的 fetch：
 * 忘记 mock 的用例会立刻报错，而不是真的发请求到外网/本机端口。需要网络行为
 * 的用例用 `installFetchMock(handler)` 显式安装，并在结束后 restore()。
 *
 * Node 22+ ships a global `localStorage` of its own which, without a
 * `--localstorage-file` path, is a stub with no working methods. Under the
 * jsdom environment that stub shadows jsdom's real Storage, so everything that
 * touches storage — offline-store.js, contacts.js, and any test that calls
 * `localStorage.clear()` — silently breaks. Install a functional in-memory
 * Storage whenever the ambient one is unusable, and leave a working one alone.
 */
function ambientStorageWorks() {
  try {
    if (typeof globalThis.localStorage === 'undefined') return false;
    const probe = '__vitest_storage_probe__';
    globalThis.localStorage.setItem(probe, '1');
    const ok = globalThis.localStorage.getItem(probe) === '1';
    globalThis.localStorage.removeItem(probe);
    return ok && typeof globalThis.localStorage.clear === 'function';
  } catch {
    return false;
  }
}

if (!ambientStorageWorks()) {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(String(k)),
    clear: () => void map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true, // vi.stubGlobal in individual tests must still win
    writable: true,
  });
  if (typeof window !== 'undefined' && window.localStorage !== storage) {
    try {
      Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    } catch {
      /* window may be sealed; the global above is what src code resolves */
    }
  }
}

/* ---- fetch：默认拒绝，按需安装 ---- */

let fetchHandler = null;
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;

globalThis.fetch = async (input, init) => {
  if (fetchHandler) {
    return fetchHandler(new URL(String(input), 'http://localhost'), init);
  }
  throw new Error(
    `[tests] 未配置 fetch：${String(input)}。` +
      '请用 tests/setup.js 导出的 installFetchMock(handler) 显式提供响应。',
  );
};

/**
 * 安装一个 fetch mock。
 * handler(url, init) 返回 Response（或可直接构造响应的对象）。
 * 返回 restore()，在 afterEach 里调用。
 */
export function installFetchMock(handler) {
  fetchHandler = handler;
  return () => {
    fetchHandler = null;
  };
}

/** 便于用例构造 JSON 响应。 */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export { nativeFetch };

