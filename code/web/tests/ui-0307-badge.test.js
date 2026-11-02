/**
 * 0.3.7（用户 m00779）：AI 待审批提案的「红点」
 *
 * 设计侧真源：`design/M11-设置红点-规范.md`。本文件锁五类事实：
 *   1. 状态机：可见当且仅当 `enabled === true` 且 `pending > 0`；请求失败/形状不对
 *      一律 fail-closed（宁可不亮，也不给用户点不掉的红点）；`refreshAiBadge()`
 *      后订阅者收到新状态；60 秒轮询、`document.hidden` 时不发请求、前台补刷 15 秒限流；
 *   2. DOM：同一份状态贴到顶栏齿轮与「AI」页签上，两处要么一起亮要么一起灭；
 *      n=0 时齿轮回到「设置」、页签摘掉 aria-label（可访问名回落文本「AI」）；
 *      条数只进 aria-label/title，不进可见文本（视觉上只有点，没有数字）；
 *   3. i18n：两个新键存在、文案逐字、`{n}` 插值生效；
 *   4. CSS：外径/描边按规范 §1/§2 的数值（12px 含 2px 描边 = 内径 8px；页签 8px 无描边）、
 *      无 transition/animation（规范 §7：瞬时）、只用既有颜色变量；
 *   5. 接线：app.js / account-dialog.js 传的是哪两个文案键、关窗退订、受理后立即刷新。
 *      齿轮那条只能在源码层断言——`app.js` 在单测里不挂载（无先例，依赖整棵树），
 *      贴法本身已由 paintAiBadge() 的 DOM 用例覆盖。
 *
 * 断言写数值与 DOM 事实，不写「实现了什么函数」，这样撤掉实现能真的变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  // 只 mock 计数接口：ai-badge.js 对外只依赖这一个网络调用。
  getAiProposalCount: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAiProposalCount: mocks.getAiProposalCount,
  };
});

const badge = await import('../src/js/ai-badge.js');
const { t } = await import('../src/i18n/index.js');
import zhCN from '../src/i18n/zh-CN.js';

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 让已 resolve 的 promise 链跑完（refreshAiBadge 内部有两次 await）。 */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeGear() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  // 建好时的出厂状态与 app.js:741-742 一致：只有「设置」。
  btn.setAttribute('aria-label', t('toolbar.settings'));
  btn.setAttribute('title', t('toolbar.settings'));
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"></svg>';
  return btn;
}

function makeAiTab() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'tab');
  btn.textContent = t('settings.tab.ai');
  return btn;
}

/** 按 app.js / account-dialog.js 的真实传参贴两处（文案键不许在测试里自造）。 */
function paintBoth(gear, tab, current = badge.getAiBadgeState()) {
  badge.paintAiBadge(gear, {
    state: current,
    labelKey: 'toolbar.settingsWithPending',
    idleLabel: 'toolbar.settings',
  });
  badge.paintAiBadge(tab, { state: current, labelKey: 'settings.tab.aiWithPending' });
}

beforeEach(() => {
  document.body.replaceChildren();
  badge.stopAiBadge();
  badge.__resetAiBadgeForTest();
  mocks.getAiProposalCount.mockReset();
  mocks.getAiProposalCount.mockResolvedValue({ pending: 0, enabled: false });
});

afterEach(() => {
  badge.stopAiBadge();
  badge.__resetAiBadgeForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/* ============================================================================
 * 1. 状态机
 * ========================================================================= */

describe('0.3.7 · AI 红点状态机', () => {
  it('可见判据：enabled 且 pending>0 才可见', () => {
    expect(badge.isAiBadgeVisible({ pending: 2, enabled: true })).toBe(true);
    expect(badge.isAiBadgeVisible({ pending: 0, enabled: true })).toBe(false);
    expect(badge.isAiBadgeVisible({ pending: 2, enabled: false })).toBe(false);
    expect(badge.isAiBadgeVisible({ pending: 2, enabled: 'true' })).toBe(false);
    expect(badge.isAiBadgeVisible(null)).toBe(false);
  });

  it('响应收敛：pending 取整数、非数字归 0、enabled 只认布尔 true', async () => {
    mocks.getAiProposalCount.mockResolvedValue({ pending: 4.8, enabled: true });
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState()).toEqual({ pending: 4, enabled: true });

    mocks.getAiProposalCount.mockResolvedValue({ pending: 'abc', enabled: true });
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState()).toEqual({ pending: 0, enabled: true });

    mocks.getAiProposalCount.mockResolvedValue({ pending: 3, enabled: 1 });
    await badge.refreshAiBadge();
    // 条数照收（不影响文案），但没有布尔 true 的 enabled 就一律算关闭。
    expect(badge.getAiBadgeState()).toEqual({ pending: 3, enabled: false });
    expect(badge.isAiBadgeVisible()).toBe(false);
  });

  it('形状不认识（null / 空对象）→ fail-closed 归零', async () => {
    mocks.getAiProposalCount.mockResolvedValue({ pending: 5, enabled: true });
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState()).toEqual({ pending: 5, enabled: true });

    mocks.getAiProposalCount.mockResolvedValue(null);
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState()).toEqual({ pending: 0, enabled: false });

    mocks.getAiProposalCount.mockResolvedValue({});
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState()).toEqual({ pending: 0, enabled: false });
  });

  it('请求抛错 → fail-closed 归零，且 refreshAiBadge 自己不抛', async () => {
    mocks.getAiProposalCount.mockResolvedValue({ pending: 3, enabled: true });
    await badge.refreshAiBadge();
    expect(badge.getAiBadgeState().pending).toBe(3);

    mocks.getAiProposalCount.mockRejectedValue(new Error('network down'));
    await expect(badge.refreshAiBadge()).resolves.toEqual({ pending: 0, enabled: false });
    expect(badge.getAiBadgeState()).toEqual({ pending: 0, enabled: false });
  });

  it('refreshAiBadge() 成功后通知订阅者，并立即给一次当前状态', async () => {
    const seen = [];
    const off = badge.onAiBadgeChange((next) => seen.push(next));
    // 订阅即回调一次（调用方不必先手动读）。
    expect(seen).toEqual([{ pending: 0, enabled: false }]);

    mocks.getAiProposalCount.mockResolvedValue({ pending: 3, enabled: true });
    await badge.refreshAiBadge();
    expect(seen).toEqual([
      { pending: 0, enabled: false },
      { pending: 3, enabled: true },
    ]);

    // 值没变也广播（轮询刷新后 UI 要重新贴一次，不能靠 diff）。
    await badge.refreshAiBadge();
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({ pending: 3, enabled: true });

    off();
    mocks.getAiProposalCount.mockResolvedValue({ pending: 0, enabled: false });
    await badge.refreshAiBadge();
    expect(seen).toHaveLength(3);
  });

  it('退订函数可重复调用、订阅者抛错不拖垮状态源', async () => {
    const seen = [];
    const off = badge.onAiBadgeChange(() => {
      throw new Error('boom');
    });
    const off2 = badge.onAiBadgeChange((next) => seen.push(next));
    mocks.getAiProposalCount.mockResolvedValue({ pending: 1, enabled: true });
    await expect(badge.refreshAiBadge()).resolves.toEqual({ pending: 1, enabled: true });
    expect(seen.length).toBe(2);
    off();
    off();
    off2();
    expect(() => badge.paintAiBadge(makeGear(), { labelKey: 'toolbar.settings' })).not.toThrow();
  });

  it('startAiBadge() 立刻拉一次，不必等 60 秒', async () => {
    vi.useFakeTimers();
    mocks.getAiProposalCount.mockResolvedValue({ pending: 1, enabled: true });
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1);
    expect(badge.getAiBadgeState()).toEqual({ pending: 1, enabled: true });
  });

  it('60 秒轮询一次；重复 start 幂等（不会双倍打接口）', async () => {
    vi.useFakeTimers();
    mocks.getAiProposalCount.mockResolvedValue({ pending: 1, enabled: true });
    badge.startAiBadge();
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(3);
    expect(badge.POLL_INTERVAL_MS).toBe(60_000);
  });

  it('document.hidden 时轮询跳过请求，回到前台才发', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    mocks.getAiProposalCount.mockResolvedValue({ pending: 1, enabled: true });
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1); // 首次不受 hidden 影响

    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(2);
  });

  it('visibilitychange→visible 与 window focus 各补刷一次，且 15 秒内不重复', async () => {
    vi.useFakeTimers();
    mocks.getAiProposalCount.mockResolvedValue({ pending: 2, enabled: true });
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1);

    // 刚刷过 → 15 秒内的补刷被限流吞掉。
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(badge.MIN_REFRESH_GAP_MS);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(badge.MIN_REFRESH_GAP_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount).toHaveBeenCalledTimes(3);
    expect(badge.MIN_REFRESH_GAP_MS).toBe(15_000);
  });

  it('stopAiBadge() 清定时器并摘监听；重复 stop 不抛', async () => {
    vi.useFakeTimers();
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    const afterStart = mocks.getAiProposalCount.mock.calls.length;

    badge.stopAiBadge();
    badge.stopAiBadge();
    await vi.advanceTimersByTimeAsync(badge.POLL_INTERVAL_MS * 3);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount.mock.calls.length).toBe(afterStart);

    // 重新 start 立刻刷一次，不会因为 timer 残留而漏掉。
    badge.startAiBadge();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAiProposalCount.mock.calls.length).toBe(afterStart + 1);
  });
});

/* ============================================================================
 * 2. 两处 DOM 同源
 * ========================================================================= */

describe('0.3.7 · 两处红点 DOM', () => {
  it('待审批>0 且启用：齿轮与「AI」页签同时挂 has-badge', () => {
    const gear = makeGear();
    const tab = makeAiTab();
    paintBoth(gear, tab, { pending: 3, enabled: true });
    expect(gear.classList.contains('has-badge')).toBe(true);
    expect(tab.classList.contains('has-badge')).toBe(true);
    expect(gear.getAttribute('aria-label')).toBe('设置（3 条 AI 提案待审批）');
    expect(gear.getAttribute('title')).toBe('设置（3 条 AI 提案待审批）');
    expect(tab.getAttribute('aria-label')).toBe('AI（3 条待审批）');
    expect(tab.getAttribute('title')).toBe('AI（3 条待审批）');
  });

  it('条数只进 aria-label/title，可见文本不变（页签仍是「AI」、齿轮不出现数字）', () => {
    const gear = makeGear();
    const tab = makeAiTab();
    const gearTextBefore = gear.textContent;
    paintBoth(gear, tab, { pending: 12, enabled: true });
    expect(tab.textContent).toBe('AI');
    expect(gear.textContent).toBe(gearTextBefore);
    expect(gear.textContent).not.toContain('12');
    expect(tab.textContent).not.toContain('12');
    expect(tab.getAttribute('aria-label')).toContain('12');
  });

  it('pending=0：两处一起灭，齿轮回「设置」，页签摘掉 aria-label 回落文本', () => {
    const gear = makeGear();
    const tab = makeAiTab();
    paintBoth(gear, tab, { pending: 2, enabled: true });
    paintBoth(gear, tab, { pending: 0, enabled: true });
    expect(gear.classList.contains('has-badge')).toBe(false);
    expect(tab.classList.contains('has-badge')).toBe(false);
    expect(gear.getAttribute('aria-label')).toBe('设置');
    expect(gear.getAttribute('title')).toBe('设置');
    expect(tab.hasAttribute('aria-label')).toBe(false);
    expect(tab.hasAttribute('title')).toBe(false);
    expect(tab.textContent).toBe('AI');
  });

  it('enabled=false：即使 pending>0 也不亮（AI 关闭时队列旧条目不算）', () => {
    const gear = makeGear();
    const tab = makeAiTab();
    paintBoth(gear, tab, { pending: 5, enabled: false });
    expect(gear.classList.contains('has-badge')).toBe(false);
    expect(tab.classList.contains('has-badge')).toBe(false);
    expect(gear.getAttribute('aria-label')).toBe('设置');
    expect(tab.hasAttribute('aria-label')).toBe(false);
  });

  it('两处不得一亮一灭：任一状态序列下两枚按钮的可见性始终相同', () => {
    const gear = makeGear();
    const tab = makeAiTab();
    const sequence = [
      { pending: 0, enabled: false },
      { pending: 1, enabled: false },
      { pending: 0, enabled: true },
      { pending: 1, enabled: true },
      { pending: 7, enabled: true },
      { pending: 7, enabled: false },
      { pending: 0, enabled: true },
    ];
    for (const current of sequence) {
      paintBoth(gear, tab, current);
      expect(gear.classList.contains('has-badge')).toBe(tab.classList.contains('has-badge'));
      expect(gear.classList.contains('has-badge')).toBe(badge.isAiBadgeVisible(current));
    }
  });

  it('订阅后两处由同一个回调一起更新（模拟 app.js + account-dialog.js 的真实订阅）', async () => {
    const gear = makeGear();
    const tab = makeAiTab();
    const offGear = badge.onAiBadgeChange((next) =>
      badge.paintAiBadge(gear, {
        state: next,
        labelKey: 'toolbar.settingsWithPending',
        idleLabel: 'toolbar.settings',
      }),
    );
    const offTab = badge.onAiBadgeChange((next) =>
      badge.paintAiBadge(tab, { state: next, labelKey: 'settings.tab.aiWithPending' }),
    );
    paintBoth(gear, tab);

    mocks.getAiProposalCount.mockResolvedValue({ pending: 2, enabled: true });
    await badge.refreshAiBadge();
    expect(gear.classList.contains('has-badge')).toBe(true);
    expect(tab.classList.contains('has-badge')).toBe(true);
    expect(tab.getAttribute('aria-label')).toBe('AI（2 条待审批）');

    // 受理掉两条 → 两处同时灭。
    mocks.getAiProposalCount.mockResolvedValue({ pending: 0, enabled: true });
    await badge.refreshAiBadge();
    expect(gear.classList.contains('has-badge')).toBe(false);
    expect(tab.classList.contains('has-badge')).toBe(false);
    offGear();
    offTab();
  });

  it('请求失败时两处一起灭（fail-closed：不给用户点不掉的红点）', async () => {
    const gear = makeGear();
    const tab = makeAiTab();
    paintBoth(gear, tab, { pending: 1, enabled: true });
    expect(gear.classList.contains('has-badge')).toBe(true);

    const offGear = badge.onAiBadgeChange((next) =>
      badge.paintAiBadge(gear, {
        state: next,
        labelKey: 'toolbar.settingsWithPending',
        idleLabel: 'toolbar.settings',
      }),
    );
    const offTab = badge.onAiBadgeChange((next) =>
      badge.paintAiBadge(tab, { state: next, labelKey: 'settings.tab.aiWithPending' }),
    );
    mocks.getAiProposalCount.mockRejectedValue(new Error('401'));
    await badge.refreshAiBadge();
    expect(gear.classList.contains('has-badge')).toBe(false);
    expect(tab.classList.contains('has-badge')).toBe(false);
    expect(tab.hasAttribute('aria-label')).toBe(false);
    offGear();
    offTab();
  });

  it('paintAiBadge 空按钮/缺 labelKey 时不炸（关窗后订阅晚到一拍）', () => {
    expect(badge.paintAiBadge(null, { labelKey: 'toolbar.settings' })).toBe(false);
    expect(badge.paintAiBadge(makeGear(), {})).toBe(false);
    // 没能换成 labelKey 的按钮不应被改脏。
    const gear = makeGear();
    badge.paintAiBadge(gear, { state: { pending: 1, enabled: true } });
    expect(gear.classList.contains('has-badge')).toBe(false);
    expect(gear.getAttribute('aria-label')).toBe('设置');
  });
});

/* ============================================================================
 * 3. i18n
 * ========================================================================= */

describe('0.3.7 · 红点文案', () => {
  it('两个新键在 zh-CN 词典里，文案逐字照规范 §5', () => {
    expect(zhCN['toolbar.settingsWithPending']).toBe('设置（{n} 条 AI 提案待审批）');
    expect(zhCN['settings.tab.aiWithPending']).toBe('AI（{n} 条待审批）');
    expect(zhCN['toolbar.settings']).toBe('设置');
    expect(zhCN['settings.tab.ai']).toBe('AI');
  });

  it('{n} 插值生效，且 1 与多位数字都对', () => {
    expect(t('toolbar.settingsWithPending', { n: 1 })).toBe('设置（1 条 AI 提案待审批）');
    expect(t('toolbar.settingsWithPending', { n: 12 })).toBe('设置（12 条 AI 提案待审批）');
    expect(t('settings.tab.aiWithPending', { n: 1 })).toBe('AI（1 条待审批）');
    expect(t('settings.tab.aiWithPending', { n: 99 })).toBe('AI（99 条待审批）');
    // 没给参数时占位符原样留着（漏传参数要一眼看出来，不静默吞掉）。
    expect(t('settings.tab.aiWithPending')).toBe('AI（{n} 条待审批）');
  });

  it('两处新增键都不改既有页签文本：AI 页签仍是「AI」', () => {
    expect(t('settings.tab.ai')).toBe('AI');
    expect(t('settings.tab.aiWithPending', { n: 0 })).not.toBe(t('settings.tab.ai'));
  });
});

/* ============================================================================
 * 4. CSS 数值（规范 §1/§2/§3/§7）
 * ========================================================================= */

describe('0.3.7 · 红点样式', () => {
  const base = readSrc('../src/styles/base.css');
  const calendar = readSrc('../src/styles/calendar.css');

  const ruleOf = (css, selector) => {
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };

  it('.icon-btn 有 position: relative（红点的定位锚点）', () => {
    const iconBtn = ruleOf(base, '.icon-btn {');
    expect(iconBtn).toContain('position: relative');
  });

  it('齿轮红点：12px 外径 + 2px 描边（border-box 下内径 8px）、top/right 3px', () => {
    const rule = ruleOf(base, '.icon-btn.has-badge::after');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('top: 3px');
    expect(rule).toContain('right: 3px');
    expect(rule).toContain('width: 12px');
    expect(rule).toContain('height: 12px');
    expect(rule).toContain('border: 2px solid var(--surface)');
    expect(rule).toContain('border-radius: 50%');
    expect(rule).toContain('background: var(--danger)');
    expect(rule).toContain('pointer-events: none');
    // 全局 border-box（base.css 顶部 *::after）是 12px 这个数成立的前提。
    expect(base).toMatch(/\*::after\s*\{\s*box-sizing: border-box;/);
  });

  it('页签红点：8px、无描边、top/right 2px，且不吃点击', () => {
    const rule = ruleOf(calendar, '.settings__tabs button.has-badge::after');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('top: 2px');
    expect(rule).toContain('right: 2px');
    expect(rule).toContain('width: 8px');
    expect(rule).toContain('height: 8px');
    expect(rule).toContain('border-radius: 50%');
    expect(rule).toContain('background: var(--danger)');
    expect(rule).toContain('pointer-events: none');
    expect(rule).not.toContain('border:');
  });

  it('两处红点都不做动效（规范 §7：瞬时，不脉冲）', () => {
    for (const rule of [
      ruleOf(base, '.icon-btn.has-badge::after'),
      ruleOf(calendar, '.settings__tabs button.has-badge::after'),
    ]) {
      expect(rule).not.toContain('transition');
      expect(rule).not.toContain('animation');
    }
  });

  it('红点只用既有颜色变量，没有新增色值', () => {
    for (const rule of [
      ruleOf(base, '.icon-btn.has-badge::after'),
      ruleOf(calendar, '.settings__tabs button.has-badge::after'),
    ]) {
      expect(rule).toContain('var(--danger)');
      // 不出现 #hex / rgb() 这类硬编码颜色。
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(rule).not.toMatch(/rgba?\(/);
    }
  });
});

/* ============================================================================
 * 5. 接线（源码层，防止「状态源改了、两处没接上」）
 * ========================================================================= */

describe('0.3.7 · 红点接线', () => {
  const app = readSrc('../src/js/app.js');
  const dialog = readSrc('../src/js/account-dialog.js');
  const aiSettings = readSrc('../src/js/ai-settings.js');

  it('app.js：齿轮用 toolbar.settingsWithPending，空闲回 toolbar.settings，并在拼好 header 后 start', () => {
    expect(app).toContain("labelKey: 'toolbar.settingsWithPending'");
    expect(app).toContain("idleLabel: 'toolbar.settings'");
    expect(app).toMatch(/onAiBadgeChange\(\(next\) => paintSettingsBadge\(next\)\)/);
    expect(app).toContain('startAiBadge();');
    // destroy() 里要停轮询并退订，否则 HMR/重新挂载会叠定时器。
    expect(app).toMatch(/unsubscribeAiBadge\(\);\s*\n\s*stopAiBadge\(\);/);
  });

  it('account-dialog.js：AI 页签用 settings.tab.aiWithPending，关窗退订，切到 AI 页后刷计数', () => {
    expect(dialog).toContain("labelKey: 'settings.tab.aiWithPending'");
    expect(dialog).toMatch(/const unsubscribeAiBadge = onAiBadgeChange/);
    expect(dialog).toMatch(/unsubscribeAiBadge\(\)/);
    expect(dialog).toMatch(/refresh\(\)\)\s*\n?\s*\.then\(\(\) => refreshAiBadge\(\)\)/);
  });

  it('ai-settings.js：受理与驳回成功后各刷一次计数（两处红点立即灭）', () => {
    const hits = aiSettings.match(/void refreshAiBadge\(\);/g) || [];
    expect(hits.length).toBe(2);
  });
});
