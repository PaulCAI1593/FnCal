/**
 * 0.4.8（用户 2026-11-04 / 规范 `design/M18-提案队列入口-规范.md` §1–§9）：
 * 「提案队列」从设置页迁到主界面顶栏铃铛。
 *
 * 本文件锁八类事实（对应派单第 7 项）：
 *   1. 结构：铃铛是 `.header__nav` 的第一个子节点，「今天」紧随其右；
 *   2. 两态：有未过期待审批 → `has-proposals` + accent 色 + 带条数文案；空态 →
 *      `--text-2` + 空态文案；两档都写 aria-label 与 title；
 *   3. fail-closed：`enabled=false` 时即使 pending>0 也不亮；
 *   4. 面板：点开用 `listAiProposals({status:'pending'})` 拉正文并渲染卡片；
 *   5. 接受后**不关面板**，原位刷新；
 *   6. 设置页第三块只剩一句指向说明，没有任何提案操作；
 *   7. 全库（src 的 js/css）不再出现 `has-badge`；
 *   8. 几何：宽度 min(400px, 100vw-32px)、left 夹取 ≥16 且右边不越界、top = 铃铛底 + 8。
 *   9. 0.4.10（用户）：AI 关闭时铃铛隐藏、开启才显示（三态）；关闭时收起浮层并收回焦点。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  getAiProposalCount: vi.fn(),
  listAiProposals: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAiProposalCount: mocks.getAiProposalCount,
    listAiProposals: mocks.listAiProposals,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
  };
});

const { createApp } = await import('../src/js/app.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { createAiSettingsPage } = await import('../src/js/ai-settings.js');
const { refreshAiBadge, __resetAiBadgeForTest, stopAiBadge } = await import('../src/js/ai-badge.js');
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
];

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  const listeners = new Set();
  return {
    getSettings: () => ({ ...s }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    saveSettings: (patch) => {
      Object.assign(s, patch);
      return Promise.resolve({ ...s });
    },
    toggleTask: async () => {},
  };
}

/** 已 resolve 的 promise 链 + 一轮宏任务（打开浮层的 setTimeout(0) 注册要跑完）。 */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const bellBtn = () => document.querySelector('.header__bell');
const navEl = () => document.querySelector('.header__nav');
const popoverEl = () => document.querySelector('.popover--proposals');
const cards = () => [...document.querySelectorAll('.popover--proposals .ai-proposal')];

const futureIso = (hours = 5) => new Date(Date.now() + hours * 3600_000).toISOString();

function proposal(overrides = {}) {
  return {
    id: 'p-1',
    action: 'create',
    uid: 'uid-1',
    calendarId: 'default',
    expiresAt: futureIso(),
    after: { title: '评审会' },
    ...overrides,
  };
}

/** 按 M18 §1 的两条文案键（不在测试里自造文案）。 */
const labelOn = (n) => t('toolbar.proposalsWithPending', { n });
const labelOff = () => t('toolbar.proposals');

/** 0.4.10（用户）：AI 关闭时铃铛隐藏；面板类用例先把总开关打开。 */
async function enableAi(pending = 0) {
  mocks.getAiProposalCount.mockResolvedValue({ pending, enabled: true });
  await refreshAiBadge();
  await flush();
}

/** 0.4.10：fail-closed 口径——总开关关闭（请求失败也走这一档）。 */
async function disableAi(pending = 0) {
  mocks.getAiProposalCount.mockResolvedValue({ pending, enabled: false });
  await refreshAiBadge();
  await flush();
}

function setInnerWidth(width) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
}

describe('0.4.8 · 提案队列入顶栏铃铛', () => {
  let app;

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    setInnerWidth(1280);
    document.body.replaceChildren();
    stopAiBadge();
    __resetAiBadgeForTest();
    mocks.getAiProposalCount.mockReset();
    mocks.getAiProposalCount.mockResolvedValue({ pending: 0, enabled: false });
    mocks.listAiProposals.mockReset();
    mocks.listAiProposals.mockResolvedValue({ proposals: [] });
    mocks.acceptAiProposal.mockReset();
    mocks.acceptAiProposal.mockResolvedValue({ ok: true });
    mocks.rejectAiProposal.mockReset();
    mocks.rejectAiProposal.mockResolvedValue({ ok: true });

    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x', role: 'admin' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    stopAiBadge();
    __resetAiBadgeForTest();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('结构：铃铛绝对定位在品牌区里；nav 第一个元素子节点是「今天」', () => {
    const nav = navEl();
    expect(nav).toBeTruthy();
    // 0.4.9（用户）：铃铛不占 nav 的流内位置，「今天」回到 0.4.7 的 x。
    expect(nav.children[0].classList.contains('header__today')).toBe(true);
    expect(nav.querySelector('.header__bell')).toBeNull();

    const bell = bellBtn();
    expect(bell).toBeTruthy();
    const brand = document.querySelector('.header__brand');
    expect(brand.querySelector('.header__bell')).toBe(bell);

    // 把源码里的 `.header__bell` 规则注入 jsdom，确认计算值是 absolute。
    const layout = readSrc('src/styles/layout.css');
    const rule = layout.match(/\.header__bell \{[\s\S]*?\n\}/);
    expect(rule).toBeTruthy();
    const style = document.createElement('style');
    style.textContent = rule[0];
    document.head.append(style);
    expect(getComputedStyle(bell).position).toBe('absolute');
    style.remove();

    // 基类仍是图标按钮；用 dialog 语义告诉读屏点开的是浮层。
    expect(bell.classList.contains('icon-btn')).toBe(true);
    expect(bell.getAttribute('aria-haspopup')).toBe('dialog');
    expect(bell.getAttribute('aria-expanded')).toBe('false');
  });

  it('对齐：顶栏左区 = --sidebar-w，铃铛右边缘落在侧栏边界线上；≤720 交给底部工具栏', () => {
    const layout = readSrc('src/styles/layout.css');
    // 左区宽度 = 侧栏宽 − header 左 padding − header gap：16 + 236 + 12 = 264 = --sidebar-w
    expect(layout).toMatch(
      /\.header__brand \{[^}]*min-width: calc\(var\(--sidebar-w\) - var\(--sp-4\) - var\(--sp-3\)\);/,
    );
    // 铃铛右边缘再往右 12px（= header gap）⇒ 正好落在侧栏边界线上（差 0）。
    expect(layout).toMatch(/\.header__bell \{[^}]*position: absolute;/);
    expect(layout).toMatch(/\.header__bell \{[^}]*right: calc\(-1 \* var\(--sp-3\)\);/);
    expect(layout).toMatch(/\.header__bell \{[^}]*translate: 0 -50%;/);
    // ≤720：顶栏铃铛隐藏，底部工具栏那份接管。
    expect(layout).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.header__bell \{\s*display: none;/);

    // 几何账（>1200 与 721–1200 同值）：padding 16 + 品牌 236 + gap 12 = 264。
    const PAD = 16;
    const GAP = 12;
    const SIDEBAR = 264;
    const brandW = SIDEBAR - PAD - GAP;
    expect(PAD + brandW + GAP).toBe(SIDEBAR); // 铃铛右边缘 x == 侧栏右边界 x
    expect(brandW).toBe(236);

    const views = readSrc('src/styles/views.css');
    // 0.4.9（用户最终规则）：>1200 与 721–1200 一律用同一条左区宽度规则，
    // 铃铛右边缘因此始终落在侧栏边界线上（差值 0）。
    expect(views).toMatch(
      /@media \(min-width: 721px\) and \(max-width: 1200px\) \{[\s\S]*?\.header__brand \{[^}]*min-width: calc\(var\(--sidebar-w\) - var\(--sp-4\) - var\(--sp-3\)\);/,
    );
    // 宽度不够时只隐藏名称（≤1200 段），logo 与铃铛都保留。
    expect(views).toMatch(/@media \(max-width: 1200px\) \{[\s\S]*?\.brand-name \{\s*display: none;/);
    expect(views).not.toMatch(/\.brand-mark \{[^}]*visibility: hidden/);
    expect(views).not.toMatch(/\.brand-mark \{[^}]*display: none/);
    // 721–1023 实测 721 仍差 45px：搜索槽收成工具区图标，工具区再压一档。
    expect(views).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.header__search \{\s*display: none;/);
    expect(views).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.search-toggle \{\s*display: inline-flex;/);
    expect(views).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.header__tools \.segmented button \{\s*padding: 0 4px;/);
    expect(views).toMatch(
      /@media \(max-width: 1023px\) \{[\s\S]*?\.header__tools \.taskbar-toggle \.icon-btn__label \{\s*display: none;/,
    );

    // ≤720 底部工具栏：首项铃铛、末项任务，8 项每项 ≥44px。
    const tabbar = document.querySelector('.tabbar');
    expect(tabbar.children[0].classList.contains('tabbar__bell')).toBe(true);
    expect(tabbar.children[tabbar.children.length - 1].classList.contains('tabbar__task')).toBe(true);
    expect(tabbar.querySelectorAll('.tabbar__btn')).toHaveLength(8);
    expect(views).toMatch(/grid-auto-columns: minmax\(44px, 1fr\)/);
    expect(views).toMatch(/\.header__tools \.taskbar-toggle \{\s*display: none;/);
    // 375px：(375 − 8 padding − 7×2 gap) / 8 = 44.1 ≥ 44
    expect((375 - 8 - 7 * 2) / 8).toBeGreaterThanOrEqual(44);
  });

  it('两态：AI 开启时，有提案 → has-proposals + 带条数文案；空态 → 摘类 + 空态文案', async () => {
    await enableAi(2);
    expect(bellBtn().hidden).toBe(false);
    expect(bellBtn().classList.contains('has-proposals')).toBe(true);
    expect(bellBtn().getAttribute('aria-label')).toBe(labelOn(2));
    expect(bellBtn().getAttribute('title')).toBe(labelOn(2));
    // 条数只进可访问名，不进可见文本（图标按钮本来就没有文字）。
    expect(bellBtn().textContent.trim()).toBe('');

    await enableAi(0);
    expect(bellBtn().hidden).toBe(false);
    expect(bellBtn().classList.contains('has-proposals')).toBe(false);
    expect(bellBtn().getAttribute('aria-label')).toBe(labelOff());
    expect(bellBtn().getAttribute('title')).toBe(labelOff());
  });

  it('0.4.10：AI 关闭时两个铃铛都隐藏（不是描边显示），fail-closed', async () => {
    const tabBell = document.querySelector('.tabbar__bell');
    await disableAi(4);
    expect(bellBtn().hidden).toBe(true);
    expect(tabBell.hidden).toBe(true);
    expect(bellBtn().classList.contains('has-proposals')).toBe(false);
    expect(bellBtn().getAttribute('aria-label')).toBe(labelOff());
  });

  it('0.4.10：从关闭切到开启，铃铛出现在原位置', async () => {
    const tabBell = document.querySelector('.tabbar__bell');
    await disableAi(0);
    expect(bellBtn().hidden).toBe(true);
    expect(tabBell.hidden).toBe(true);

    await enableAi(0);
    expect(bellBtn().hidden).toBe(false);
    expect(tabBell.hidden).toBe(false);
    expect(bellBtn().classList.contains('has-proposals')).toBe(false);
    expect(tabBell.classList.contains('has-proposals')).toBe(false);
  });

  it('0.4.10：AI 关闭时开着的面板自动收起，焦点退回设置按钮', async () => {
    mocks.listAiProposals.mockResolvedValue({ proposals: [proposal()] });
    await enableAi(1);
    bellBtn().click();
    await flush();
    expect(popoverEl()).toBeTruthy();
    popoverEl().querySelector('.ai-proposals-refresh').focus();
    expect(popoverEl().contains(document.activeElement)).toBe(true);

    await disableAi(0);
    expect(popoverEl()).toBeNull();
    expect(bellBtn().hidden).toBe(true);
    // 铃铛已隐藏，焦点不能留在 display:none 的节点里 → 退回设置按钮。
    expect(document.activeElement.getAttribute('aria-label')).toBe(t('toolbar.settings'));
  });

  it('点开：拉 pending 列表并渲染卡片；aria-expanded 同步', async () => {
    mocks.listAiProposals.mockResolvedValue({ proposals: [proposal()] });
    await enableAi(1);
    bellBtn().click();
    await flush();

    expect(popoverEl()).toBeTruthy();
    expect(bellBtn().getAttribute('aria-expanded')).toBe('true');
    expect(mocks.listAiProposals).toHaveBeenCalledWith({ status: 'pending' });
    // 正文来自列表接口，不是计数接口。
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain('评审会');
    // 面板头部保留「刷新」按钮。
    expect(popoverEl().querySelector('.ai-proposals-refresh')).toBeTruthy();
  });

  it('接受后不关面板，原位刷新', async () => {
    mocks.listAiProposals.mockResolvedValue({ proposals: [proposal()] });
    await enableAi(1);
    bellBtn().click();
    await flush();
    expect(cards()).toHaveLength(1);

    cards()[0].querySelector('.ai-proposal__accept').click();
    await flush();

    expect(mocks.acceptAiProposal).toHaveBeenCalledWith('p-1');
    expect(popoverEl()).toBeTruthy(); // 面板还在
    expect(cards()).toHaveLength(0); // 卡片原位消失
    expect(popoverEl().textContent).toContain(t('settings.ai.proposals.empty'));
  });

  it('设置页已无提案队列：AI 页签不含「提案队列」字样，也不留空壳', () => {
    const page = createAiSettingsPage({ user: { username: 'x', role: 'admin' }, store: makeStore() });
    // 0.4.9（用户）：「设置里这行字不要」——整块删除（含标题），不是只删说明。
    expect(page.page.textContent).not.toContain('提案队列');
    expect(page.page.querySelector('.ai-section--proposals')).toBeNull();
    // 服务块自己的提示小字仍可有，但不能有指向铃铛的那句。
    expect(page.page.textContent).not.toContain('顶栏铃铛');
    // 0.4.13（M4 §3 / M21 §3）：新增「回收站」小节——服务块、回收站、凭据三块，故由 2 改为 3。
    // 0.4.14（M4 §2 硬规则 4）：回收站移入凭据编辑器，AI 页底部只剩服务 / 凭据两块。
    expect(page.page.querySelectorAll('.ai-section')).toHaveLength(2);
    expect(page.page.querySelector('.ai-section--trash')).toBeNull();
    // 源码里也不应再有该块的骨架与指向文案键。
    const src = readSrc('src/js/ai-settings.js');
    expect(src).not.toContain('ai-section--proposals');
    expect(src).not.toContain('settings.ai.proposals.moved');
    const dict = readSrc('src/i18n/zh-CN.js');
    expect(dict).not.toContain("'settings.ai.proposals.moved'");
  });

  it('全库（src 的 js/css）不再出现 has-badge；旧两处红点已删', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|css)$/.test(entry)) files.push(full);
      }
    };
    walk(path.join(HERE, '..', 'src'));
    const hits = files.filter((file) => readFileSync(file, 'utf8').includes('has-badge'));
    expect(hits).toEqual([]);
    // 铃铛的状态类名与两处旧红点的 DOM 贴法都在源码里有明确去处。
    const appSrc = readSrc('src/js/app.js');
    expect(appSrc).toContain("classList.toggle('has-proposals'");
    expect(appSrc).not.toContain('paintSettingsBadge');
  });

  it('面板几何：宽度 min(400px, 100vw-32px)、left 夹 ≥16、top = 铃铛底 + 8', async () => {
    setInnerWidth(375);
    await enableAi(1);
    bellBtn().click();
    await flush();
    const box = popoverEl();
    expect(box).toBeTruthy();
    // 375 - 32 = 343 < 400
    expect(box.style.width).toBe('343px');
    expect(box.style.left).toBe('16px'); // jsdom 的铃铛 rect.left = 0 → 夹到 16
    expect(box.style.top).toBe('8px'); // rect.bottom = 0

    const layout = readSrc('src/styles/layout.css');
    expect(layout).toContain('transform-origin: top left');
    expect(layout).toMatch(/\.header__bell\s*\{[^}]*color:\s*var\(--text-2\)/);
    expect(layout).toMatch(/\.header__bell\.has-proposals\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(layout).toMatch(/\.header__bell\.has-proposals svg\s*\{[^}]*fill:\s*currentColor/);
    // 过渡只给 color（规范 §1：不加缩放/脉冲）。
    expect(layout).toMatch(/\.header__bell\s*\{[^}]*transition:\s*color var\(--dur-fast\)/);
    expect(layout).toMatch(/\.header__bell::before\s*\{[^}]*inset:\s*-2px/);
  });

  it('关闭三件套：点外面 / Esc / 再点铃铛；焦点在面板内时回铃铛', async () => {
    mocks.listAiProposals.mockResolvedValue({ proposals: [proposal()] });
    await enableAi(1);
    bellBtn().click();
    await flush();
    expect(popoverEl()).toBeTruthy();

    // ① 点外面
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(popoverEl()).toBeNull();
    expect(bellBtn().getAttribute('aria-expanded')).toBe('false');

    // ② Esc（焦点在面板里 → 关掉后回铃铛）
    bellBtn().click();
    await flush();
    popoverEl().querySelector('.ai-proposals-refresh').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(popoverEl()).toBeNull();
    expect(document.activeElement).toBe(bellBtn());

    // ③ 再点铃铛
    bellBtn().click();
    await flush();
    expect(popoverEl()).toBeTruthy();
    bellBtn().click();
    await flush();
    expect(popoverEl()).toBeNull();
  });
});
