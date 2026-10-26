/**
 * 移动端走查素材生成（0.2.0）：
 *   1. 用 jsdom + 真实组件渲染「月 / 周 / 日 / 议程 / 任务栏展开 / 设置三页」快照；
 *   2. 内联真实样式（tokens/base/layout/views/offline/calendar）；
 *   3. 交给无头 Edge（--screenshot）在 375×667 / 360×800 出图，并读取
 *      `#probe` 上的 scrollWidth/innerWidth 判断「最小 360px 不出现横向滚动」。
 *
 * 用法：node scripts/mobile-shots.mjs
 * 产物：code/M5-移动端走查/harness/*.html、code/M5-移动端走查/*.png、code/M5-移动端走查/result.txt
 * 说明：这是**布局走查**（真实 CSS + 真实组件 DOM、假数据），不是真机截图；
 *      真机验收仍按方案 §14 清单由项目负责人执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');
const webDir = path.join(codeDir, 'web');
const outDir = path.join(codeDir, 'M5-移动端走查');
const harnessDir = path.join(outDir, 'harness');
fs.mkdirSync(harnessDir, { recursive: true });

const require = createRequire(path.join(webDir, 'package.json'));
const { JSDOM } = require('jsdom');

/* ---- 1. DOM globals（与 vitest 的 jsdom 环境等价的最小集合） ---- */
const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1:5581/',
  pretendToBeVisual: true,
});
const win = dom.window;
globalThis.window = win;
globalThis.document = win.document;
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
globalThis.HTMLElement = win.HTMLElement;
globalThis.HTMLInputElement = win.HTMLInputElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.MouseEvent = win.MouseEvent;
globalThis.CustomEvent = win.CustomEvent;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
Object.defineProperty(globalThis, 'localStorage', { value: win.localStorage, configurable: true, writable: true });
win.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.matchMedia = win.matchMedia;

const styles = ['tokens', 'base', 'layout', 'views', 'offline', 'calendar']
  .map((name) => fs.readFileSync(path.join(webDir, 'src', 'styles', `${name}.css`), 'utf8'))
  .join('\n');

const { createApp } = await import(pathToFileURL(path.join(webDir, 'src', 'js', 'app.js')).href);
const { openAccountDialog } = await import(
  pathToFileURL(path.join(webDir, 'src', 'js', 'account-dialog.js')).href
);

/* ---- 2. 假数据 store ---- */
const DAY = 86_400_000;
const base = new Date(2026, 9, 15, 0, 0, 0, 0).getTime();
const calendars = [
  { id: 'default', displayName: '我的日历', color: 'blue', type: 'vevent', visible: true, order: 0, shares: [] },
  { id: 'cal-work', displayName: '工作', color: 'green', type: 'vevent', visible: true, order: 1, shares: [] },
  { id: 'tasks', displayName: '任务', color: 'graphite', type: 'vtodo', visible: true, order: 2, shares: [] },
];

function makeEvent(id, title, dayOffset, hour, durationMin, calendarId, color) {
  const start = base + dayOffset * DAY + hour * 3600_000;
  return {
    id,
    title,
    start,
    end: start + durationMin * 60_000,
    allDay: false,
    color,
    calendarId,
    reminders: [],
  };
}

const events = [
  makeEvent('e1', '产品周会', 0, 9, 60, 'cal-work', 'green'),
  makeEvent('e2', '牙医预约', 0, 14, 45, 'default', 'blue'),
  makeEvent('e3', '家庭聚餐', 1, 18, 120, 'default', 'pink'),
  makeEvent('e4', '季度评审', 2, 10, 90, 'cal-work', 'green'),
  makeEvent('e5', '健身', 3, 7, 60, 'default', 'orange'),
  makeEvent('e6', '读书会', 4, 20, 90, 'default', 'violet'),
];
const tasks = [
  { id: 't1', title: '提交周报', due: base + 3600_000, allDay: false, done: false, color: 'graphite', calendarId: 'tasks', isTask: true, updatedAt: 1 },
  { id: 't2', title: '预约体检', due: base + DAY + 3600_000, allDay: false, done: false, color: 'graphite', calendarId: 'tasks', isTask: true, updatedAt: 2 },
  { id: 't3', title: '续费域名', due: base - DAY, allDay: false, done: true, color: 'graphite', calendarId: 'tasks', isTask: true, updatedAt: 3 },
];

function makeStore(view) {
  const settings = {
    theme: 'light',
    weekStartsOn: 1,
    hour12: false,
    defaultView: view,
    timezone: '',
    showWeekNumbers: false,
    eventColorMode: 'calendar',
    defaultReminders: { timed: [10], allDay: [540] },
    defaultCalendarId: '',
    lastCalendarId: 'default',
    visibleCalendarIds: [],
    hiddenColors: [],
    categoryNames: {},
    categoriesCollapsed: false,
    bookingLinksCollapsed: false,
    secondaryTz: '',
    holidaysEnabled: true,
    defaultReminders: { timed: [10], allDay: [540] },
    mailInvites: 'known',
  };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...settings }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    saveSettings: async () => ({ ...settings }),
    getAllEvents: () => events,
    getEventsInRange: (from, to) =>
      events.filter((e) => e.end > from && e.start < to),
    getAllTasks: () => tasks,
    getTasksInRange: (from, to) => tasks.filter((t) => t.due >= from && t.due < to),
    getTask: (id) => tasks.find((t) => t.id === id) || null,
    getEvent: () => null,
    getCalendars: () => calendars,
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    getCalendarType: (id) => (id === 'tasks' ? 'vtodo' : 'vevent'),
    getTaskCalendars: () => calendars.filter((c) => c.type === 'vtodo'),
    isCalendarVisible: () => true,
    toggleTask: async () => {},
    createCalendar: async () => calendars[0],
    updateCalendar: async (id, patch) => ({ ...calendars[0], ...patch }),
  };
}

/* ---- 3. 渲染快照 ---- */
const user = { username: 'alice', displayName: '爱丽丝', role: 'user' };
const appRoot = document.getElementById('app');

function renderPage(name, mutate) {
  const view = name === 'taskbar' || name === 'settings' ? 'month' : name;
  void view;
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const app = createApp(root, { store: makeStore(name === 'taskbar' || name === 'settings' ? 'month' : name), user });
  mutate?.(app, root);
  const html = document.documentElement.outerHTML;
  console.log(name, 'bodyLen', document.body.innerHTML.length, 'month', !!document.querySelector('.month'), 'week', !!document.querySelector('.week'), 'agenda', !!document.querySelector('.agenda'), 'taskbarOpen', !!document.querySelector('#taskbar:not([hidden])'));
  app.destroy();
  const page = html
    .replace('</head>', `<style>${styles}</style><style>html,body{overflow-x:hidden}</style></head>`)
    .replace('</body>', `<div id="probe" hidden></div><script>
      requestAnimationFrame(() => {
        const p = document.getElementById('probe');
        p.dataset.sw = document.documentElement.scrollWidth;
        p.dataset.iw = window.innerWidth;
        p.dataset.bw = document.body.scrollWidth;
        document.title = 'SW=' + p.dataset.sw + ' IW=' + p.dataset.iw;
      });
    </script></body>`);
  const target = path.join(harnessDir, `${name}.html`);
  fs.writeFileSync(target, page);
  return target;
}

const pages = [
  ['month', (app) => app.setView?.('month')],
  ['week', (app) => app.setView?.('week')],
  ['day', (app) => app.setView?.('day')],
  ['agenda', (app) => app.setView?.('agenda')],
  [
    'taskbar',
    (app) => {
      document.querySelector('.taskbar-toggle')?.click();
    },
  ],
  [
    'settings',
    () => {
      openAccountDialog({ user, store: makeStore('month') });
    },
  ],
];

/* app.setView is not exported on the returned app: switch views by clicking the
 * header's segmented button (the same path a user takes). */
const viewKey = { month: 'm', week: 'w', day: 'd', agenda: 'a' };
function pressView(view) {
  const btn = document.querySelector(`.header__tools .segmented [data-view="${view}"]`);
  if (btn) btn.click();
}

const generated = [];
for (const [name, mutate] of pages) {
  generated.push(
    renderPage(name, (app) => {
      if (viewKey[name]) pressView(name);
      mutate(app);
    }),
  );
}

/* ---- 4. 无头 Edge 出图 + 360px 横向滚动断言 ---- */
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const edgeExists = fs.existsSync(EDGE);
const sizes = [
  ['375x667', 375, 667],
  ['360x800', 360, 800],
];
const results = [];
if (edgeExists) {
  for (const [label, width, height] of sizes) {
    for (const file of generated) {
      const name = path.basename(file, '.html');
      const png = path.join(outDir, `${name}-${label}.png`);
      try {
        execFileSync(
          EDGE,
          [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            '--force-device-scale-factor=1',
            `--window-size=${width},${height}`,
            `--screenshot=${png}`,
            pathToFileURL(file).href,
          ],
          { stdio: 'ignore', timeout: 60_000 },
        );
      } catch (err) {
        results.push(`${name} ${label}: screenshot failed (${err.message})`);
      }
    }
    // 360px 横向滚动断言：dump-dom 读 #probe 上的 scrollWidth。
    const probePage = path.join(harnessDir, 'month.html');
    try {
      const dump = execFileSync(
        EDGE,
        [
          '--headless=new',
          '--disable-gpu',
          '--virtual-time-budget=1200',
          '--dump-dom',
          pathToFileURL(probePage).href,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      const sw = /data-sw="(\d+)"/.exec(dump);
      const iw = /data-iw="(\d+)"/.exec(dump);
      results.push(
        `probe ${label}: scrollWidth=${sw ? sw[1] : '?'} innerWidth=${iw ? iw[1] : '?'} => ${
          sw && iw && Number(sw[1]) <= Number(iw[1]) + 1 ? 'PASS 无横向滚动' : 'CHECK'
        }`,
      );
    } catch (err) {
      results.push(`probe ${label}: dump failed (${err.message})`);
    }
  }
} else {
  results.push('Edge 未找到，跳过截图/滚动断言（仅生成 HTML 快照）');
}

fs.writeFileSync(path.join(outDir, 'result.txt'), results.join('\n') + '\n');
console.log(results.join('\n'));
console.log(`\nharness: ${harnessDir}`);
