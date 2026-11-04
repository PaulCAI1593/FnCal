/**
 * 0.3.7（用户 m00779）：AI 待审批提案的状态源（`ai-badge.js`）。
 *
 * 0.4.8（用户 2026-11-04 / 规范 M18 §2、§5）：入口收成顶栏铃铛一个，旧「两处红点 +
 * `paintAiBadge()`」整体删除。本文件因此只锁**状态机**这一件事：
 *   1. 可见当且仅当 `enabled === true` 且 `pending > 0`；
 *   2. 请求失败/形状不对一律 fail-closed（宁可不亮，也不给用户点不掉的入口状态）；
 *   3. `refreshAiBadge()` 后订阅者收到新状态；60 秒轮询、`document.hidden` 时不发请求、
 *      前台补刷 15 秒限流。
 * 铃铛的两态渲染、面板、旧入口移除由 `ui-048-bell-proposals.test.js` 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    expect(badge.isAiBadgeVisible({ pending: 1, enabled: true })).toBe(true);
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
