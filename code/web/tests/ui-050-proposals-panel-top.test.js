/**
 * 0.4.11：提案面板顶部透出。
 *
 * 现象（真机）：`popover--proposals` 顶部有一条 12px 横向条带，滚上去的卡片从
 * 「面板顶边 → 吸顶标题行」之间透出来。
 *
 * 根因：`.popover` 的 `padding: var(--sp-3)`（12px）作用在**滚动容器自身**上，
 * 而 sticky 头部的 `top: 0` 是相对滚动容器的 padding 边（内容盒）定位，所以头部
 * 吸顶后停在距面板外沿 12 + 1（边框）= 13px 处，这 13px 是滚动内容可见区。
 *
 * 本文件锁三件事：
 *   1. 滚动容器（`.popover--proposals`）顶部内边距为 0；
 *   2. 吸顶头部自带 12px 顶部留白 + 不透明背景，吸顶后盖住面板内沿；
 *   3. 结构与前提匹配：头部是面板第一个子元素、滚动容器就是浮层本身（sticky 生效范围）。
 */
import { describe, it, expect, vi } from 'vitest';
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

const { createProposalsPanel } = await import('../src/js/proposals-panel.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const LAYOUT = readSrc('src/styles/layout.css');
const CALENDAR = readSrc('src/styles/calendar.css');
const VIEWS = readSrc('src/styles/views.css');
const TOKENS = readSrc('src/styles/tokens.css');

const compact = (text) => text.replace(/\s+/g, ' ');

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`);
  const matched = css.match(pattern);
  return matched ? compact(matched[1]) : '';
}

/** 同名选择器出现多次时取最后一条（后者覆盖前者）。 */
function lastRuleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const matched = [...css.matchAll(pattern)];
  return matched.length ? compact(matched[matched.length - 1][1]) : '';
}

const CALENDARS = [
  { id: 'default', displayName: '我的日历', color: '#3272d9', type: 'vevent', visible: true },
];

function makeStore() {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS, defaultView: 'month' }),
    getCalendars: () => CALENDARS.map((c) => ({ ...c })),
    getCalendar: (id) => CALENDARS.find((c) => c.id === id) || null,
    subscribe: () => () => {},
  };
}

describe('0.4.11 · 提案面板顶部不透出', () => {
  it('滚动容器顶部内边距归零：sticky 头部之外不再留 12px 可见带', () => {
    const pop = ruleBody(LAYOUT, '.popover--proposals');
    // 左右/底部内边距保持 12px（卡片与面板边缘的留白不变）。
    expect(pop).toContain('padding: var(--sp-3)');
    // 顶部必须是 0，且不能被后面的 shorthand 覆盖回去。
    expect(pop).toContain('padding-top: 0');
    expect(pop).not.toMatch(/padding-top:\s*var\(--sp-3\)/);
    expect(pop.indexOf('padding-top: 0')).toBeGreaterThan(pop.indexOf('padding: var(--sp-3)'));
  });

  it('吸顶头部自带顶部留白、不透明背景、top: 0：吸顶后贴住面板内沿', () => {
    const head = ruleBody(CALENDAR, '.proposals-panel .ai-section__head');
    expect(head).toContain('position: sticky');
    expect(head).toContain('top: 0');
    expect(head).toContain('z-index: 1');
    expect(head).toContain('padding-top: var(--sp-3)');
    expect(head).toContain('background: var(--surface)');
    expect(head).not.toContain('background: transparent');
    expect(head).not.toContain('background-color: transparent');
  });

  it('视觉留白守恒：头部 12px + 浮层 0 = 原 12px（--sp-3 = 12px）', () => {
    expect(TOKENS).toMatch(/--sp-3:\s*12px/);
    expect(ruleBody(CALENDAR, '.proposals-panel .ai-section__head')).toContain('padding-top: var(--sp-3)');
    expect(ruleBody(LAYOUT, '.popover--proposals')).toContain('padding-top: 0');
  });

  it('结构前提：滚动容器就是浮层本身，头部是面板第一个子元素（sticky 在其内吸顶）', async () => {
    expect(ruleBody(LAYOUT, '.popover')).toContain('overflow-y: auto');
    mocks.listAiProposals.mockResolvedValue({
      proposals: [
        {
          id: 'p-1',
          action: 'create',
          uid: 'uid-1',
          calendarId: 'default',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          note: '',
          after: { title: '评审会', start: '2026-11-09T18:30:00+08:00', allDay: false },
        },
      ],
    });
    const panel = createProposalsPanel({ store: makeStore(), now: () => Date.now() });
    document.body.append(panel.node);
    await panel.load();
    expect(panel.node.classList.contains('proposals-panel')).toBe(true);
    expect(panel.node.firstElementChild.className).toBe('ai-section__head');
    expect(panel.node.querySelector('.ai-section__body')).not.toBe(null);
    panel.destroy();
  });
});

/**
 * 同一类问题的议程视图：`.agenda` 也是滚动容器，改前 `padding: var(--sp-4) 0`
 * 让顶部出现 16px 可见带（滚上去的日程从带里透出）；日期头 `position: sticky`
 * 因 grid 默认 stretch 撑满整行而没有吸顶余量，且背景透明。
 */
describe('0.4.11 · 议程视图顶部不透出、日期头吸顶', () => {
  /** 同名选择器的所有规则体（媒体断点里会重复定义，按条判断）。 */
  function ruleBodies(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
    return [...css.matchAll(pattern)].map((m) => compact(m[1]));
  }
  const anyBody = (selector, predicate) => ruleBodies(VIEWS, selector).some(predicate);

  it('滚动容器 `.agenda` 顶部内边距归零（底部 16px 保留）', () => {
    expect(anyBody('.agenda', (b) => b.includes('overflow-y: auto'))).toBe(true);
    // 0.5.6（B）新增窄屏 `@media (max-width:720px){ .agenda { touch-action: pan-y } }`，
    // 所以同名规则变成 2 条；本用例的意图是「唯一那条带滚动定义的基础规则」，断言按滚动定义定位。
    const agendaRules = ruleBodies(VIEWS, '.agenda').filter((b) => b.includes('overflow-y: auto'));
    expect(agendaRules).toHaveLength(1);
    const agenda = agendaRules[0];
    expect(agenda).toContain('padding: 0 0 var(--sp-4)');
    // 不允许多值 shorthand 再把顶部内边距加回来（`var(--sp-4) 0` 即上下 16px）。
    expect(agenda).not.toMatch(/padding:\s*var\(--sp-4\)\s+0\b/);
    expect(agenda).not.toMatch(/padding-top:\s*var\(--sp-4\)/);
  });

  it('日期头吸顶：align-self: start + sticky top 0 + 不透明底色 + z-index', () => {
    const matches = ruleBodies(VIEWS, '.agenda__date').filter(
      (b) => b.includes('position: sticky') && b.includes('align-self: start'),
    );
    expect(matches.length).toBeGreaterThan(0);
    const date = matches[0];
    expect(date).toContain('top: 0');
    expect(date).toContain('z-index: 2');
    expect(date).toContain('padding-top: var(--sp-4)');
    expect(date).toContain('background: var(--surface)');
    expect(date).not.toContain('background: transparent');
    expect(date).not.toContain('background-color: transparent');
  });

  it('视觉留白守恒：改前 `.agenda` 16 + `.agenda__day` 16 = 改后 `.agenda__day` 16 + 日期头 16', () => {
    expect(TOKENS).toMatch(/--sp-4:\s*16px/);
    // 基准规则（非移动断点）保留 day 的上下 16px。
    expect(ruleBodies(VIEWS, '.agenda__day')[0]).toContain('padding: var(--sp-4) 0');
    expect(anyBody('.agenda__date', (b) => b.includes('padding-top: var(--sp-4)'))).toBe(true);
    // 日程列也接住 day 的顶部留白，首条日程与日期数字同高（实测 81 / 81）。
    expect(anyBody('.agenda__events', (b) => b.includes('padding-top: var(--sp-4)'))).toBe(true);
  });

  it('日期头背景只覆盖日期列：背景画在日期头自己的盒子里，不横贯整行', () => {
    // 日期头是 `.agenda__day` 网格首项（96px 列），背景不作为行的伪元素铺满整行。
    expect(ruleBodies(VIEWS, '.agenda__day')[0]).toContain('grid-template-columns: 96px minmax(0, 1fr)');
    expect(VIEWS).not.toMatch(/\.agenda__day::?(before|after)/);
    expect(VIEWS).not.toMatch(/\.agenda__date::?(before|after)/);
  });
});
