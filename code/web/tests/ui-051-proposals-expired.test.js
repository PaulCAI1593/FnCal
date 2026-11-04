/**
 * 0.4.12：过期提案不再渲染。
 *
 * 后端已把 pending 过期的条目收敛成 `expired`（列表默认只请求 pending，不会再返回它们）；
 * 前端再过滤一次是双保险：万一把 `status=pending,expired` 或缓存里的旧数据送进来，
 * 面板也不能显示一条永远点不动的「已过期」卡片，计数与空态要跟着同一个口径走。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAiProposals: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listAiProposals: mocks.listAiProposals,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: vi.fn() }));

const { createProposalsPanel } = await import('../src/js/proposals-panel.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
];

function makeStore() {
  const s = { ...DEFAULT_SETTINGS, defaultView: 'month' };
  return {
    getSettings: () => ({ ...s }),
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
    subscribe: () => () => {},
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const HOUR = 3600_000;
const active = (id) => ({
  id,
  action: 'create',
  uid: id,
  calendarId: 'default',
  expiresAt: new Date(Date.now() + 5 * HOUR).toISOString(),
  note: '',
  after: { title: `待确认 ${id}` },
});
const expired = (id) => ({
  id,
  action: 'create',
  uid: id,
  calendarId: 'default',
  expiresAt: new Date(Date.now() - HOUR).toISOString(),
  note: '',
  after: { title: `已过期 ${id}` },
});

async function mount(list) {
  mocks.listAiProposals.mockResolvedValue({ proposals: list });
  const panel = createProposalsPanel({ store: makeStore(), now: () => Date.now() });
  await panel.load();
  await flush();
  return panel;
}

describe('0.4.12 · 过期提案不渲染', () => {
  beforeEach(() => {
    mocks.listAiProposals.mockReset();
    mocks.acceptAiProposal.mockReset();
    mocks.rejectAiProposal.mockReset();
  });

  it('过期条目不进列表，计数只算未过期', async () => {
    const panel = await mount([active('a'), expired('b'), active('c')]);
    const cards = panel.node.querySelectorAll('.ai-proposal');
    expect(cards.length).toBe(2);
    const text = panel.node.textContent;
    expect(text).toContain('待确认 a');
    expect(text).toContain('待确认 c');
    expect(text).not.toContain('已过期 b');
    const count = panel.node.querySelector('.ai-count');
    expect(count.getAttribute('data-count')).toBe('2');
  });

  it('只剩过期条目时给空态文案（复用既有键，不新增）', async () => {
    const panel = await mount([expired('b'), expired('d')]);
    expect(panel.node.querySelectorAll('.ai-proposal').length).toBe(0);
    const empty = panel.node.querySelector('.ai-proposals__empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toBe(t('settings.ai.proposals.empty'));
    expect(panel.node.querySelector('.ai-count').getAttribute('data-count')).toBe('0');
  });

  it('全部未过期时列表与计数不受影响（回归）', async () => {
    const panel = await mount([active('a'), active('e')]);
    expect(panel.node.querySelectorAll('.ai-proposal').length).toBe(2);
    expect(panel.node.querySelector('.ai-proposals__empty')).toBeNull();
    expect(panel.node.querySelector('.ai-count').getAttribute('data-count')).toBe('2');
  });
});
