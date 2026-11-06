/**
 * 0.5.10（S5 / S6，用户 2026-11-06 截图）：
 *   S5 月 / 周 / 四日 / 日 / 日程五个视图的节日文字统一主题色（--accent）；
 *      月视图其它月格仍灰；只改文字色，底色/旗子/字号不动。
 *   S6 日程视图日期列「周X · M月」下方加一行节日全名（主题色、可省略、title 全名）；
 *      只在当天有节日时出现；受「显示公共假日」开关控制；列表里不重复节日行，
 *      也不参与「这一段有没有内容」的到底判定。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderAgenda } from '../src/js/views/agenda.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');
const agendaJs = readFileSync(path.join(HERE, '..', 'src/js/views/agenda.js'), 'utf8');

/** 取包含 marker 的规则体（单条选择器，不处理嵌套）。 */
function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const end = css.indexOf('}', at);
  return css.slice(at, end + 1);
}

const CURSOR = new Date(2026, 9, 1); // 2026-10-01 周四，国庆节

const holiday = (title, date) => ({
  id: `holiday-${title}`,
  title,
  start: startOfDay(date).getTime(),
  end: endOfDay(date).getTime(),
  allDay: true,
  holiday: true,
  readOnly: true,
  color: 'red',
  reminders: [],
});

const timed = (title, date, h) => ({
  id: `ev-${title}`,
  title,
  start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h).getTime(),
  end: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h + 1).getTime(),
  allDay: false,
  color: 'violet',
  reminders: [],
});

/**
 * 真实 store 的 includeHolidays 受 settings.holidaysEnabled 控制
 * （store.js:1191）；这里复刻同一口径，测「关掉开关节日行消失」。
 */
function makeCtx(events, settings = {}) {
  const all = { hour12: true, holidaysEnabled: true, weekStartsOn: 0, ...settings };
  return {
    store: {
      getEventsInRange: (from, to, opts = {}) =>
        events
          .filter((e) => e.start < to && e.end > from)
          .filter((e) => !e.readOnly || (opts.includeHolidays && all.holidaysEnabled)),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getSettings: () => all,
    },
    settings: all,
    cursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
    },
  };
}

const dateHeads = (node) =>
  [...node.querySelectorAll('.agenda__day')].map((d) => ({
    num: d.querySelector('.agenda__date-num').textContent,
    dow: d.querySelector('.agenda__date-dow').textContent,
    holiday: d.querySelector('.agenda__date-holiday')
      ? {
          text: d.querySelector('.agenda__date-holiday').textContent,
          title: d.querySelector('.agenda__date-holiday').getAttribute('title'),
          afterDow: d.querySelector('.agenda__date-holiday').previousElementSibling ===
            d.querySelector('.agenda__date-dow'),
        }
      : null,
    rows: d.querySelectorAll('.agenda__event, .agenda__task').length,
  }));

describe('0.5.10 S5：节日文字统一主题色', () => {
  it('月视图：节日名与旗子用 --accent；其它月格仍是灰', () => {
    const css = rule(viewsCss, '.month__holiday');
    expect(css).toContain('color: var(--accent)');
    expect(rule(viewsCss, '.month__holiday-icon')).toContain('color: var(--accent)');
    expect(viewsCss).toMatch(
      /\.month__cell\.is-othermonth \.month__holiday[^{]*\{[^}]*var\(--gray-400\)/,
    );
    // 底色/字号不变（只改文字色）
    expect(css).toContain('font-size: 10px');
    expect(css).not.toMatch(/background/);
  });

  it('周 / 四日 / 日：全天节日 chip 文字与旗子都为主题色，底色不变', () => {
    const css = rule(viewsCss, '.chip.chip--holiday,\n.allday-chip.allday-chip--holiday');
    expect(css).toContain('color: var(--accent)');
    expect(css).toContain('background: var(--surface-3)');
    // 0.5.11（S2，用户）：「小旗子图标和节日一样是主题色」。
    expect(rule(viewsCss, '.chip__holiday-icon')).toContain('color: var(--accent)');
    expect(
      rule(viewsCss, '.allday-chip.allday-chip--holiday .allday-chip__icon'),
    ).toContain('color: var(--accent)');
  });

  it('日程：节日行文字与旗子都用 --accent（时间 / 标题 / 整行 / 图标）', () => {
    expect(rule(viewsCss, '.agenda__event.agenda__event--holiday')).toContain(
      'color: var(--accent)',
    );
    const line = rule(
      viewsCss,
      '.agenda__event--holiday .agenda__event-time,\n.agenda__event--holiday .agenda__event-title',
    );
    expect(line).toContain('color: var(--accent)');
    expect(rule(viewsCss, '.agenda__event--holiday .agenda__event-icon')).toContain(
      'color: var(--accent)',
    );
  });
});

describe('0.5.11 S1：≤520 恢复节日旗子并保留完整节日名', () => {
  it('≤520 节日旗子恢复显示、收到 12px，间距/内边距 2px，并允许每侧 3px 外扩', () => {
    const at = viewsCss.indexOf(
      '@media (max-width: 520px) {\n  .chip.chip--holiday .chip__holiday-icon,',
    );
    expect(at).toBeGreaterThan(-1);
    const block = viewsCss.slice(at, viewsCss.indexOf('\n}', at) + 2);
    expect(block).toContain('.allday-chip.allday-chip--holiday .allday-chip__icon');
    expect(block).toMatch(/display: inline-flex/);
    expect(block).not.toMatch(/display: none/);
    expect(block).toMatch(/width: 12px/);
    expect(block).toMatch(/\.chip\.chip--holiday,\n  \.allday-chip\.allday-chip--holiday \{[\s\S]*gap: 2px/);
    expect(block).toMatch(/padding-left: 2px/);
    expect(block).toMatch(/margin-left: -3px/);
    // 名字不再画省略号（由 JS 裁成完整汉字）。
    expect(block).toMatch(/\.allday-chip__title \{\n    text-overflow: clip/);
  });

  it('>520 不动：全天 chip 仍有 8px 内边距、图标仍是 inline-flex（旗子保留）', () => {
    expect(viewsCss).toMatch(/\.allday-chip \{[^}]*display: flex[^}]*padding: 2px var\(--sp-2\)/);
    expect(viewsCss).toMatch(
      /\.chip__ooo-icon,\n\.allday-chip__icon,\n\.agenda__event-icon \{[^}]*display: inline-flex/,
    );
  });
});

describe('0.5.10 S6：日程日期头下加节日', () => {
  it('有节日的日期头在「周X · M月」下方显示全名 + title；无节日的日期头没有该行', () => {
    // 日程只列有内容的日期；10-01 放一条事件让这一天的日期头出现。
    const { node } = renderAgenda(
      makeCtx([holiday('国庆节', CURSOR), timed('评审', CURSOR, 10)]),
    );
    const heads = dateHeads(node);
    const first = heads.find((h) => h.num === '1');
    expect(first.holiday).toEqual({ text: '国庆节', title: '国庆节', afterDow: true });
    const second = heads.find((h) => h.num === '2');
    expect(second).toBeUndefined();
    // 日期头顺序：日号 → 周X · M月 → 节日
    expect(agendaJs).toMatch(/class: 'agenda__date-holiday'/);
    expect(agendaJs).toMatch(/title: holidayName/);
  });

  it('列表里不再有节日行（不重复），普通事件仍照常列出', () => {
    const { node } = renderAgenda(makeCtx([holiday('国庆节', CURSOR)]));
    expect(node.querySelectorAll('.agenda__event--holiday').length).toBe(0);
    expect(node.textContent).not.toContain('国庆节国庆节');
    const withEvent = renderAgenda(makeCtx([holiday('国庆节', CURSOR), timed('评审', CURSOR, 10)]));
    const day1 = [...withEvent.node.querySelectorAll('.agenda__day')].find(
      (d) => d.querySelector('.agenda__date-num').textContent === '1',
    );
    expect(day1.querySelectorAll('.agenda__event').length).toBe(1);
    expect(day1.querySelector('.agenda__event-title').textContent).toBe('评审');
  });

  it('关掉「显示公共假日」：日期头节日行消失；重新打开恢复', () => {
    const events = [holiday('国庆节', CURSOR), timed('评审', CURSOR, 10)];
    const off = renderAgenda(makeCtx(events, { holidaysEnabled: false }));
    expect(off.node.querySelector('.agenda__date-holiday')).toBeNull();
    const on = renderAgenda(makeCtx(events, { holidaysEnabled: true }));
    expect(on.node.querySelector('.agenda__date-holiday').textContent).toBe('国庆节');
  });

  it('节日不参与到底判定：只有节日的段仍判「没有事件」', () => {
    const { node } = renderAgenda(makeCtx([holiday('国庆节', CURSOR)]));
    expect(node.querySelector('.empty p').textContent).toContain('没有事件');
    // ownCount 仍只数非 readOnly 事件
    expect(agendaJs).toMatch(/const ownCount = events\.filter\(\(ev\) => !ev\.readOnly\)\.length/);
  });

  it('CSS：日期头节日行主题色、小于日期标签、超长省略且不换行', () => {
    const css = rule(viewsCss, '.agenda__date-holiday');
    expect(css).toContain('color: var(--accent)');
    expect(css).toContain('white-space: nowrap');
    expect(css).toContain('text-overflow: ellipsis');
    expect(css).toContain('font-size: 10px');
  });
});

