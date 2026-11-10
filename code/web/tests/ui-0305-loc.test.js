/**
 * 0.3.5（M10 规范）：时间网格视图「地点行」。
 *
 * 覆盖（规范 §1/§2/§4/§5）：
 *   - C 档（height ≥ 50，含 1 小时块 52px）渲染 `.tevent__loc`，位置在 `.tevent__time` 之后；
 *   - B 档 45 分钟（39px）两行、无地点；A 档 30/15 分钟（26/18px）单行横排、无地点；
 *   - 地点为空 / 全空格 / 字段缺失 → 不生成节点（不留空行）；
 *   - 超长地点仍是单行省略（CSS 规则断言），文本完整保留；
 *   - aria-label 含地点；空地点不留多余逗号；
 *   - 跨天事件的每一片独立按自身块高判档（矮片无地点、高片有地点）；
 *   - CSS：`.tevent__loc` 的 10px / 1.3 / inherit / .85 / 无 margin，以及
 *     `@container (max-width:108px)` 的隐藏规则（规范 §3.1，实现期改为容器查询）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

const DAY = new Date(2026, 7, 19); // Wed 19 Aug 2026
const LONG_LOC = '北京市朝阳区望京街道望京SOHO T1 座 B1 层 会议室 3（西侧电梯直达）';

function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
}

function makeEvent({ id = 'ev-1', title = '评审会', start, end, location = '', color = 'blue' } = {}) {
  const event = { id, title, start, end, allDay: false, color, reminders: [] };
  if (location !== undefined) event.location = location;
  return event;
}

function makeCtx(events, cursor = DAY) {
  return {
    store: {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getTask: () => null,
      getAllEvents: () => events,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
    },
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor,
    miniCursor: cursor,
    now: cursor,
    actions: {
      createAt() {}, gotoDayView() {}, slotContextMenu() {}, openEvent() {}, openTask() {},
      toggleTask() {}, eventContextMenu() {}, taskContextMenu() {}, moveEvent() {},
      moveTask() {}, edgePage() {},
    },
  };
}

/** 渲染给定天，返回该视图里所有定时事件块。 */
function renderBlocks(event, days = [DAY]) {
  const { node } = renderTimeGrid(days, makeCtx([event]));
  return [...node.querySelectorAll('.tevent')];
}

const at = (h, m = 0, dayOffset = 0) => new Date(2026, 7, 19 + dayOffset, h, m, 0).getTime();
/** 只取文本行（排除 resize 手柄等非文本子节点），按 DOM 顺序。 */
const textLines = (block) => [...block.children]
  .filter((child) => /^tevent__(title|time|loc)$/.test(child.className))
  .map((child) => child.className);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('0.3.5 M10 · 时间网格地点行', () => {
  it('C 档：1 小时块（52px）渲染地点行，文本取 source，位置在时间行之后', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(11), location: '3 号会议室' }));
    expect(block).toBeTruthy();
    expect(block.style.height).toBe('52px'); // 60/60*52
    const loc = block.querySelector('.tevent__loc');
    expect(loc).toBeTruthy();
    expect(loc.textContent).toBe('3 号会议室');
    expect(textLines(block)).toEqual(['tevent__title', 'tevent__time', 'tevent__loc']);
  });

  it('C 档：90 分钟（78px）与 120 分钟（104px）也显示地点行', () => {
    const cases = [
      { end: at(11, 30), height: '78px' },
      { end: at(12), height: '104px' },
    ];
    for (const item of cases) {
      const [block] = renderBlocks(makeEvent({ start: at(10), end: item.end, location: 'A 座 12F' }));
      expect(block.style.height).toBe(item.height);
      expect(block.querySelector('.tevent__loc').textContent).toBe('A 座 12F');
    }
  });

  it('B 档：45 分钟（39px）两行，不生成地点节点', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(10, 45), location: '3 号会议室' }));
    expect(block.style.height).toBe('39px');
    expect(block.classList.contains('is-short')).toBe(false);
    expect(block.querySelector('.tevent__time')).toBeTruthy();
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(textLines(block)).toEqual(['tevent__title', 'tevent__time']);
  });

  it('A 档：30 分钟（26px）与 15 分钟（18px）单行横排，不生成地点节点', () => {
    for (const item of [{ end: at(10, 30), height: '26px' }, { end: at(10, 15), height: '18px' }]) {
      const [block] = renderBlocks(makeEvent({ start: at(10), end: item.end, location: '3 号会议室' }));
      expect(block.style.height).toBe(item.height);
      expect(block.classList.contains('is-short')).toBe(true);
      expect(block.querySelector('.tevent__loc')).toBeNull();
    }
  });

  it('空地点 / 只有空格 / 缺字段：C 档也不生成地点节点，不留空行', () => {
    for (const location of ['', '   ', '\t \n']) {
      const [block] = renderBlocks(makeEvent({ start: at(10), end: at(11), location }));
      expect(block.querySelector('.tevent__loc')).toBeNull();
      expect(textLines(block)).toEqual(['tevent__title', 'tevent__time']);
    }
    // 字段缺失（任务/外部导入的数据源可能没有 location 键）
    const noField = makeEvent({ start: at(10), end: at(11) });
    delete noField.location;
    const [block] = renderBlocks(noField);
    expect(block.style.height).toBe('52px');
    expect(block.querySelector('.tevent__loc')).toBeNull();
  });

  it('超长地点：节点文本完整保留，按 --tevent-lines-loc 多行截断（0.6.3 起）', () => {
    const [block] = renderBlocks(makeEvent({ start: at(10), end: at(11), location: LONG_LOC }));
    const loc = block.querySelector('.tevent__loc');
    expect(loc.textContent).toBe(LONG_LOC);
    const rule = cssRule(views, '.tevent__loc');
    // 0.6.3（B）：地点由「单行省略」改为按行数变量多行截断——52px 的 1 小时块只有
    // 1 行预算，90px+ 才可能拿到 2 行；因此 white-space/text-overflow 不再是判据。
    expect(rule).toMatch(/-webkit-line-clamp:\s*var\(--tevent-lines-loc/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('1');
  });

  it('aria-label：地点非空时拼在时间后；为空不留多余逗号', () => {
    const [withLoc] = renderBlocks(makeEvent({ start: at(10), end: at(11), location: '3 号会议室' }));
    expect(withLoc.getAttribute('aria-label')).toBe('评审会，10:00 – 11:00，3 号会议室');

    for (const location of ['', '   ']) {
      const [empty] = renderBlocks(makeEvent({ start: at(10), end: at(11), location }));
      const label = empty.getAttribute('aria-label');
      expect(label).toBe('评审会，10:00 – 11:00');
      expect(label.endsWith('，')).toBe(false);
    }

    // A 档（不渲染地点节点）仍按 §5 拼地点：aria 只看数据，不看档位。
    const [short] = renderBlocks(makeEvent({ start: at(10), end: at(10, 30), location: '3 号会议室' }));
    expect(short.querySelector('.tevent__loc')).toBeNull();
    expect(short.getAttribute('aria-label')).toBe('评审会，10:00 – 10:30，3 号会议室');
  });

  it('跨天定时事件：0.7.9 起裁进时间网格，15 分钟残段放不下地点行', () => {
    // 23:45→次日 01:00：当天只裁出 15 分钟（23:45–24:00）。0.7.9（D）起跨天定时事件
    // 进时间轴而不再升到多日轨（用户：周/四日/日应进时间轴）；块高不足地点行，
    // 因此既没有 tevent__loc，也不再是全天条。
    const event = makeEvent({ start: at(23, 45), end: at(1, 0, 1), location: '夜间值班室' });
    const { node } = renderTimeGrid([new Date(2026, 7, 19)], makeCtx([event]));
    expect(node.querySelectorAll('.tevent')).toHaveLength(1);
    expect(node.querySelectorAll('.tevent__loc')).toHaveLength(0);
    expect(node.textContent).toContain('评审会');
  });
  it('CSS：地点行 10px / 1.3 / inherit 墨色 / .85 透明，不加 margin', () => {
    const rule = cssRule(views, '.tevent__loc');
    expect(rule).toMatch(/font-size:\s*10px/);
    expect(rule).toMatch(/line-height:\s*1\.3/);
    expect(rule).toMatch(/color:\s*inherit/);
    expect(rule).toMatch(/opacity:\s*0\.85/);
    expect(rule).not.toMatch(/margin/);
    // 规范 §2：不得用 --text-3（彩色块上灰字对比不足）
    expect(rule).not.toMatch(/--text-3/);
  });

  it('CSS：容器宽 <108px 时隐藏地点行（§3.1 实现期改为容器查询）', () => {
    expect(views).toContain('@container (max-width: 108px)');
    // 定位到包含 .tevent__loc 的那条容器查询：块内必须是 display: none
    const marker = '.tevent__loc {';
    const index = views.lastIndexOf(marker);
    expect(index).toBeGreaterThan(-1);
    const open = views.lastIndexOf('{', index);
    const close = views.indexOf('}', index);
    expect(views.slice(close + 1, close + 16)).toMatch(/^\s*\}\s*$/m); // 查询块闭合
    const rule = views.slice(open + 1, close);
    expect(rule).toMatch(/display:\s*none/);
    // 判据与既有短块时间行同源：.tevent 自己就是容器
    expect(cssRule(views, '.tevent')).toMatch(/container-type:\s*inline-size/);
    // 并且该规则确实在 @container 里（前文最近一条 @container 与它之间没有其他顶层规则）
    const before = views.slice(0, open);
    expect(before.lastIndexOf('@container (max-width: 108px)')).toBeGreaterThan(-1);
  });
});
