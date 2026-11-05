/**
 * 0.4.10（M19 规范 `design/M19-提案卡片排版-规范.md` §2–§9）：
 * 提案卡片的固定行序、时间格式、单行省略与操作区布局。
 *
 * 本文件锁四类事实：
 *   1. 时间格式化（纯函数）：定时/全天 × 同日/跨天、跨年、缺 end 只给起点、
 *      字段按「书写值」解释（不换时区）、缺 start 整行为空；
 *   2. 地点与备注：真实换行折叠成单空格、单行省略并给 `title` 全文；
 *   3. DOM 行序：名称+徽标 → 日历 → 时间地点 → 备注 → diff → 操作区；
 *      缺失行不渲染（不留空壳）、新建类不渲染 diff、删除类取 before 的时间；
 *   4. CSS：头部 sticky、刷新右贴、各行 nowrap + ellipsis、
 *      操作区按钮组靠右、coarse 指针 44px。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const {
  createProposalsPanel,
  collapseWhitespace,
  formatSnapshotTime,
  formatProposalTime,
  proposalLocation,
  proposalBodyLine,
} = await import('../src/js/proposals-panel.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { t } = await import('../src/i18n/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const CSS = readSrc('src/styles/calendar.css');

const ALL_DAY = t('settings.ai.proposal.allDay');
const futureIso = (hours = 5) => new Date(Date.now() + hours * 3600_000).toISOString();

/**
 * 0.4.12：用本地时间分量构造瞬时。测试机在哪个时区都行——函数按本地时区显示，
 * 所以「显示的本地时分」恒等于这里给的分量。旧的「按书写值拆串」断言已作废。
 */
const localIso = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).toISOString();

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

function proposal(overrides = {}) {
  return {
    id: 'p-1',
    action: 'create',
    uid: 'uid-1',
    calendarId: 'default',
    expiresAt: futureIso(),
    note: '',
    after: { title: '评审会' },
    ...overrides,
  };
}

async function mount(list) {
  mocks.listAiProposals.mockResolvedValue({ proposals: list });
  const panel = createProposalsPanel({ store: makeStore(), now: () => Date.now() });
  await panel.load();
  await flush();
  return panel;
}

const cardOf = (panel) => panel.node.querySelector('.ai-proposal');
const rowClasses = (card) => [...card.children].map((node) => node.className);

/** 取某选择器的全部规则内容（同名规则可能分多处声明，后出现的覆盖前面的）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...CSS.matchAll(pattern)].map((matched) => matched[1]).join('\n');
}

function compact(text) {
  return text.replace(/\s+/g, ' ');
}

describe('0.4.10 · 提案卡片时间格式化（M19 §4）', () => {
  it('定时同日：MM-DD 周X HH:MM–HH:MM（en dash）', () => {
    const text = formatSnapshotTime({
      start: localIso(2026, 11, 9, 18, 30),
      end: localIso(2026, 11, 9, 19, 30),
      allDay: false,
    });
    expect(text).toBe('11-09 周一 18:30–19:30');
    expect(text).toContain('–');
    expect(text).not.toContain(' - ');
  });

  it('全天同日：MM-DD 周X 全天（end 为排他边界，start=11-09 / end=11-10 只显示 11-09）', () => {
    expect(formatSnapshotTime({
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-10T00:00:00Z',
      allDay: true,
    })).toBe(`11-09 周一 ${ALL_DAY}`);
  });

  it('定时跨天：MM-DD HH:MM → MM-DD HH:MM（不带星期）', () => {
    expect(formatSnapshotTime({
      start: localIso(2026, 11, 9, 22, 0),
      end: localIso(2026, 11, 10, 8, 0),
      allDay: false,
    })).toBe('11-09 22:00 → 11-10 08:00');
  });

  it('全天跨天：起点 → 最后一天（end 排他，11-12 显示 11-11）', () => {
    expect(formatSnapshotTime({
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-12T00:00:00Z',
      allDay: true,
    })).toBe(`11-09 → 11-11 ${ALL_DAY}`);
  });

  it('跨年两端各带年，同年不带年', () => {
    expect(formatSnapshotTime({
      start: localIso(2025, 12, 31, 22, 0),
      end: localIso(2026, 1, 1, 8, 0),
      allDay: false,
    })).toBe('2025-12-31 22:00 → 2026-01-01 08:00');
    expect(formatSnapshotTime({
      start: localIso(2026, 11, 9, 22, 0),
      end: localIso(2026, 11, 10, 8, 0),
      allDay: false,
    })).not.toMatch(/2026/);
  });

  it('缺 end 只显示起点；缺 start 返回空串（整行不渲染）', () => {
    expect(formatSnapshotTime({ start: localIso(2026, 11, 9, 18, 30), allDay: false }))
      .toBe('11-09 周一 18:30');
    expect(formatSnapshotTime({ start: '2026-11-09T00:00:00Z', allDay: true }))
      .toBe(`11-09 周一 ${ALL_DAY}`);
    expect(formatSnapshotTime({ start: null, end: null, allDay: false })).toBe('');
    expect(formatSnapshotTime(null)).toBe('');
  });

  it('同一瞬时三种写法（Z / +08:00 / -05:00）格式化结果一致（0.4.12 按本地时区换算）', () => {
    // 三者是同一瞬时：2026-11-10T02:30:00Z；不管测试机在哪个时区，显示的本地时分都必须相同。
    const asZ = formatSnapshotTime({ start: '2026-11-10T02:30:00Z', end: '2026-11-10T03:30:00Z', allDay: false });
    const asPlus8 = formatSnapshotTime({ start: '2026-11-10T10:30:00+08:00', end: '2026-11-10T11:30:00+08:00', allDay: false });
    const asMinus5 = formatSnapshotTime({ start: '2026-11-09T21:30:00-05:00', end: '2026-11-09T22:30:00-05:00', allDay: false });
    expect(asPlus8).toBe(asZ);
    expect(asMinus5).toBe(asZ);
    // 且确实等于本机时区下的本地时分（不是原样拆串的 02:30）。
    const local = new Date('2026-11-10T02:30:00Z');
    const hh = String(local.getHours()).padStart(2, '0');
    const mm = String(local.getMinutes()).padStart(2, '0');
    expect(asZ).toContain(`${hh}:${mm}`);
  });
  it('时间取哪个快照：删除取 before，修改/新建取 after', () => {
    const before = { start: localIso(2026, 11, 9, 10, 0), end: localIso(2026, 11, 9, 11, 0), allDay: false };
    const after = { start: localIso(2026, 11, 10, 10, 0), end: localIso(2026, 11, 10, 11, 0), allDay: false };
    expect(formatProposalTime({ action: 'delete', before, after: null })).toBe('11-09 周一 10:00–11:00');
    expect(formatProposalTime({ action: 'update', before, after })).toBe('11-10 周二 10:00–11:00');
    expect(formatProposalTime({ action: 'create', before: null, after })).toBe('11-10 周二 10:00–11:00');
  });
});

describe('0.4.10 · 地点与备注折叠（M19 §3）', () => {
  it('collapseWhitespace 把真实换行与连续空白折成单空格', () => {
    expect(collapseWhitespace('5F 大会议室, B 座\n请带电脑')).toBe('5F 大会议室, B 座 请带电脑');
    expect(collapseWhitespace('  A\r\n\n\tB  ')).toBe('A B');
    expect(collapseWhitespace(null)).toBe('');
    expect(collapseWhitespace(undefined)).toBe('');
  });

  it('proposalLocation 取提案后的地点并折叠；删除类取 before 的地点', () => {
    expect(proposalLocation({
      action: 'update',
      before: { location: '3F 会议室' },
      after: { location: '5F 大会议室, B 座\n请带电脑' },
    })).toBe('5F 大会议室, B 座 请带电脑');
    expect(proposalLocation({
      action: 'delete',
      before: { location: '3F 会议室' },
      after: null,
    })).toBe('3F 会议室');
    expect(proposalLocation({ action: 'create', after: { title: '无地点' } })).toBe('');
  });

  // 0.5.2（用户 m01011/m01024）：正文行是**日程描述**，与审批页同一口径；描述为空才回落 AI 备注。
  it('proposalBodyLine 取日程描述并折叠；描述为空回落 AI 备注；删除类取 before', () => {
    expect(proposalBodyLine({
      action: 'update',
      before: { description: '旧描述' },
      after: { description: '周会：同步进度\n带上报表' },
      note: 'AI：为周会新建',
    })).toBe('周会：同步进度 带上报表');
    expect(proposalBodyLine({
      action: 'delete',
      before: { description: '被删那条的描述' },
      after: null,
      note: 'AI：重复日程',
    })).toBe('被删那条的描述');
    expect(proposalBodyLine({ action: 'create', after: { title: '无描述' }, note: 'AI：只有备注' }))
      .toBe('AI：只有备注');
    expect(proposalBodyLine({ action: 'create', after: { title: '都没有' } })).toBe('');
  });
});

describe('0.4.10 · 卡片 DOM 行序与缺失行（M19 §3/§5）', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('修改类完整六行，顺序固定', async () => {
    const panel = await mount([proposal({
      action: 'update',
      before: { title: '周会', start: localIso(2026, 11, 5, 13, 0), end: localIso(2026, 11, 5, 14, 0), allDay: false },
      after: {
        title: '周会（改期）',
        summary: '',
        start: localIso(2026, 11, 9, 18, 30),
        end: localIso(2026, 11, 9, 19, 30),
        allDay: false,
        location: '5F 大会议室, B 座\n请带电脑',
      },
      note: '总经理临时加入\n请提前十分钟到',
    })]);
    const card = cardOf(panel);
    expect(rowClasses(card)).toEqual([
      'ai-proposal__head',
      'ai-proposal__meta',
      'ai-proposal__when',
      'ai-proposal__note ai-proposal__desc',
      'ai-proposal__diff',
      'ai-proposal__actions',
    ]);
    expect(card.querySelector('.ai-proposal__head .ai-proposal__title').textContent).toBe('周会（改期）');
    expect(card.querySelector('.ai-proposal__head .ai-badge').textContent).toBe(t('settings.ai.proposal.update'));
    expect(card.querySelector('.ai-proposal__meta .ai-proposal__calendar').textContent).toBe('我的日历');
    expect(card.querySelector('.ai-proposal__meta .ai-proposal__dot').getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.ai-proposal__when .ai-proposal__time').textContent).toBe('11-09 周一 18:30–19:30');
    const location = card.querySelector('.ai-proposal__when .ai-proposal__location');
    expect(location.textContent).toBe('5F 大会议室, B 座 请带电脑');
    expect(location.getAttribute('title')).toBe('5F 大会议室, B 座 请带电脑');
    const note = card.querySelector('.ai-proposal__note');
    expect(note.textContent).toBe('总经理临时加入 请提前十分钟到');
    expect(note.getAttribute('title')).toBe('总经理临时加入 请提前十分钟到');
    expect(note.textContent).not.toContain('\n');
  });

  it('正文行显示日程描述（0.5.2）：描述优先，AI 备注只进 title', async () => {
    const panel = await mount([proposal({
      action: 'update',
      before: { title: '周会', start: localIso(2026, 11, 5, 13, 0), end: localIso(2026, 11, 5, 14, 0), allDay: false },
      after: {
        title: '周会（改期）',
        summary: '',
        start: localIso(2026, 11, 9, 18, 30),
        end: localIso(2026, 11, 9, 19, 30),
        allDay: false,
        location: '5F 大会议室, B 座\n请带电脑',
        description: '周会：同步进度\n带上报表',
      },
      note: '总经理临时加入',
    })]);
    const card = cardOf(panel);
    const body = card.querySelector('.ai-proposal__note');
    expect(body.textContent).toBe('周会：同步进度 带上报表');
    expect(body.getAttribute('title')).toBe('周会：同步进度 带上报表 · AI 备注：总经理临时加入');
    expect(body.classList.contains('ai-proposal__desc')).toBe(true);
  });

  it('新建类不渲染 diff 行（与名称行重复）', async () => {
    const panel = await mount([proposal({
      action: 'create',
      after: { title: '评审会', start: localIso(2026, 11, 9, 18, 30), end: localIso(2026, 11, 9, 19, 30), allDay: false },
    })]);
    const card = cardOf(panel);
    expect(card.querySelector('.ai-proposal__diff')).toBe(null);
    expect(rowClasses(card)).toEqual(['ai-proposal__head', 'ai-proposal__meta', 'ai-proposal__when', 'ai-proposal__actions']);
  });

  // 0.4.15（M23 §2）：删除类**不再渲染**行⑤ diff（原断言「diff 是删除提示」按规范改语义），
  // 行④改为固定影响文案、不复制时间；覆盖不减弱：行数、影响文案、按钮集合都在新文件 ui-055 里断言。
  it('删除类取 before 的时间与地点；不出 diff 行，行④是固定影响文案', async () => {
    const panel = await mount([proposal({
      action: 'delete',
      before: { title: '周会', start: localIso(2026, 11, 9, 18, 30), end: localIso(2026, 11, 9, 19, 30), allDay: false, location: '3F 会议室' },
      after: null,
    })]);
    const card = cardOf(panel);
    expect(card.querySelector('.ai-proposal__title').textContent).toBe('周会');
    expect(card.querySelector('.ai-proposal__time').textContent).toBe('11-09 周一 18:30–19:30');
    expect(card.querySelector('.ai-proposal__location').textContent).toBe('3F 会议室');
    expect(card.querySelector('.ai-proposal__diff')).toBe(null);
    expect(card.textContent).not.toContain(t('settings.ai.proposal.before'));
    const impact = card.querySelector('.ai-proposal__impact');
    expect(impact.textContent).toBe(t('settings.ai.proposal.deleteImpact', { n: 7 }));
  });

  it('缺时间字段：时间地点整行不渲染；地点为空只显示时间', async () => {
    const noTime = await mount([proposal({ action: 'create', after: { title: '只有标题' } })]);
    expect(noTime.node.querySelector('.ai-proposal__when')).toBe(null);
    expect(rowClasses(cardOf(noTime))).toEqual(['ai-proposal__head', 'ai-proposal__meta', 'ai-proposal__actions']);
    noTime.destroy();

    const noLocation = await mount([proposal({
      action: 'create',
      after: { title: '无地点', start: localIso(2026, 11, 9, 18, 30), end: localIso(2026, 11, 9, 19, 30), allDay: false },
    })]);
    const when = noLocation.node.querySelector('.ai-proposal__when');
    expect(when.querySelector('.ai-proposal__time')).not.toBe(null);
    expect(when.querySelector('.ai-proposal__location')).toBe(null);
    noLocation.destroy();
  });

  it('操作区：剩余时间在左，按钮组在右且接受左、拒绝右；过期条目不再渲染', async () => {
    const panel = await mount([proposal({
      action: 'create',
      after: { title: '评审会', start: localIso(2026, 11, 9, 18, 30), allDay: false },
    })]);
    const actions = cardOf(panel).querySelector('.ai-proposal__actions');
    expect(actions.children[0].className).toBe('ai-proposal__expires');
    const group = actions.querySelector('.ai-proposal__buttons');
    expect(group).not.toBe(null);
    expect([...group.children].map((n) => n.className)).toEqual([
      'btn btn--primary ai-proposal__accept',
      'btn btn--danger ai-proposal__reject',
    ]);
    panel.destroy();

    // 0.4.12 起过期提案在渲染前就被过滤（取代 M19 §6「过期态只留文案」）：
    // 整张卡不出现，列表退回空态。
    const expired = await mount([proposal({
      action: 'create',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      after: { title: '过期提案', start: localIso(2026, 11, 9, 18, 30), allDay: false },
    })]);
    expect(expired.node.querySelectorAll('.ai-proposal').length).toBe(0);
    expect(expired.node.querySelector('.ai-proposals__empty')).not.toBe(null);
    expired.destroy();
  });

  it('冲突态：状态文案在左，按钮组内是刷新重试 + 拒绝，没有接受', async () => {
    mocks.acceptAiProposal.mockRejectedValue({ status: 409 });
    const panel = await mount([proposal({
      action: 'create',
      after: { title: '评审会', start: localIso(2026, 11, 9, 18, 30), allDay: false },
    })]);
    cardOf(panel).querySelector('.ai-proposal__accept').click();
    await flush();
    const card = cardOf(panel);
    expect(card.querySelector('.ai-proposal__state--conflict')).not.toBe(null);
    const group = card.querySelector('.ai-proposal__buttons');
    expect([...group.children].map((n) => n.className)).toEqual([
      'btn btn--ghost ai-proposal__refresh',
      'btn btn--danger ai-proposal__reject',
    ]);
    expect(card.querySelector('.ai-proposal__accept')).toBe(null);
    panel.destroy();
  });
});

describe('0.4.10 · 卡片排版 CSS（M19 §2/§3/§5）', () => {
  it('面板头部 sticky：吸顶、刷新右贴、有背景与下边框（不改滚动容器）', () => {
    const head = compact(ruleBody('.proposals-panel .ai-section__head'));
    expect(head).toContain('position: sticky');
    expect(head).toContain('top: 0');
    expect(head).toContain('z-index: 1');
    expect(head).toContain('flex-wrap: nowrap');
    expect(head).toContain('background: var(--surface)');
    expect(head).toContain('border-bottom: 1px solid var(--border)');
    expect(compact(ruleBody('.proposals-panel .ai-proposals-refresh'))).toContain('margin-left: auto');
  });

  it('每一行单行省略：名称 / 日历 / 地点 / 备注 nowrap + ellipsis', () => {
    const title = compact(ruleBody('.ai-proposal__title'));
    expect(title).toContain('white-space: nowrap');
    expect(title).toContain('text-overflow: ellipsis');
    expect(title).not.toContain('overflow-wrap: anywhere');
    const calendar = compact(ruleBody('.ai-proposal__calendar'));
    expect(calendar).toContain('text-overflow: ellipsis');
    const location = compact(ruleBody('.ai-proposal__location'));
    expect(location).toContain('white-space: nowrap');
    expect(location).toContain('text-overflow: ellipsis');
    const note = compact(ruleBody('.ai-proposal__note'));
    expect(note).toContain('white-space: nowrap');
    expect(note).toContain('text-overflow: ellipsis');
    expect(compact(ruleBody('.ai-proposal__time'))).toContain('white-space: nowrap');
  });

  it('行容器不换行；操作区按钮组靠右、间距 8px；色点 8px', () => {
    expect(compact(ruleBody('.ai-proposal__head'))).toContain('flex-wrap: nowrap');
    expect(compact(ruleBody('.ai-proposal__actions'))).toContain('flex-wrap: nowrap');
    const buttons = compact(ruleBody('.ai-proposal__buttons'));
    expect(buttons).toContain('margin-left: auto');
    expect(buttons).toContain('gap: var(--sp-2)');
    expect(compact(ruleBody('.ai-proposal__dot'))).toContain('width: 8px');
    // 状态文案不可压缩；剩余时间可收缩（320px 长文案走省略号，不把按钮组挤出卡片）。
    expect(compact(ruleBody('.ai-proposal__state'))).toContain('flex: 0 0 auto');
    const expires = compact(ruleBody('.ai-proposal__expires'));
    expect(expires).toContain('flex: 0 1 auto');
    expect(expires).toContain('text-overflow: ellipsis');
  });

  it('diff 行单行省略：flex + nowrap + 值省略号，不再用两列 grid（否则换行抖高度）', () => {
    const diff = compact(ruleBody('.ai-proposal__diff'));
    expect(diff).toContain('display: flex');
    expect(diff).toContain('white-space: nowrap');
    expect(diff).toContain('overflow: hidden');
    expect(diff).not.toContain('grid-template-columns');
    const value = compact(ruleBody('.ai-proposal__diff-value'));
    expect(value).toContain('white-space: nowrap');
    expect(value).toContain('text-overflow: ellipsis');
    expect(value).not.toContain('overflow-wrap: anywhere');
  });

  it('触屏（coarse）按钮与刷新命中区 ≥44px', () => {
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{[\s\S]*?\.ai-proposal \.btn,[\s\S]*?min-height: 44px/);
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{[\s\S]*?\.proposals-panel \.ai-proposals-refresh[\s\S]*?min-height: 44px/);
  });
});

describe('0.4.12 · 徽标凭据名前缀与全天日期（客户端）', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('徽标 = 凭据名 + 动作词（用户：「test新建」），title 给全文', async () => {
    const panel = await mount([proposal({
      action: 'create',
      credentialName: 'test',
      after: { title: '评审会', start: localIso(2026, 11, 9, 18, 30), end: localIso(2026, 11, 9, 19, 30), allDay: false },
    })]);
    const badge = cardOf(panel).querySelector('.ai-proposal__head .ai-badge');
    // 0.4.15（M23 §4）：两段式——凭据名 │ 动作词；视觉靠 gap，textContent 仍是「名+词」，
    // 但悬停 title 按规范给「名 空格 词」。
    expect(badge.textContent).toBe(`test${t('settings.ai.proposal.create')}`);
    expect(badge.querySelector('.ai-badge__cred').textContent).toBe('test');
    expect(badge.querySelector('.ai-badge__sep')).not.toBe(null);
    expect(badge.querySelector('.ai-badge__action').textContent).toBe(t('settings.ai.proposal.create'));
    expect(badge.getAttribute('title')).toBe(`test ${t('settings.ai.proposal.create')}`);
    panel.destroy();
  });

  it('没有凭据名（null / 空串）时只显示动作词，不出现「null」或多余空格', async () => {
    const panel = await mount([proposal({
      action: 'update',
      credentialName: null,
      before: { title: '周会' },
      after: { title: '周会（改期）' },
    })]);
    const badge = cardOf(panel).querySelector('.ai-proposal__head .ai-badge');
    expect(badge.textContent).toBe(t('settings.ai.proposal.update'));
    expect(badge.textContent).not.toContain('null');
    panel.destroy();
  });

  it('长凭据名不截文本（交给 CSS 省略号），title 保留全名', async () => {
    const longName = '超长凭据名称'.repeat(10); // 60 字符，接近 64 上限
    const panel = await mount([proposal({
      action: 'create',
      credentialName: longName,
      after: { title: '评审会' },
    })]);
    const badge = cardOf(panel).querySelector('.ai-badge');
    expect(badge.textContent).toBe(`${longName}${t('settings.ai.proposal.create')}`);
    expect(badge.getAttribute('title')).toBe(`${longName} ${t('settings.ai.proposal.create')}`);
    panel.destroy();
  });

  it('徽标 CSS：max-width + 单行省略，长名不撑破名称行', () => {
    const badge = compact(ruleBody('.ai-proposal .ai-badge'));
    expect(badge).toContain('max-width:');
    expect(badge).toContain('white-space: nowrap');
    expect(badge).toContain('overflow: hidden');
    expect(badge).toContain('text-overflow: ellipsis');
  });

  it('全天显示按书写日期，不随测试机时区漂移（Z 串与压缩 8 位都认）', () => {
    expect(formatSnapshotTime({
      start: '2026-11-21T00:00:00Z',
      end: '2026-11-22T00:00:00Z',
      allDay: true,
    })).toBe(`11-21 周六 ${ALL_DAY}`);
    expect(formatSnapshotTime({ start: '20261121', end: '20261122', allDay: true }))
      .toBe(`11-21 周六 ${ALL_DAY}`);
  });
});