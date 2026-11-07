/**
 * 0.6.11（用户真机 0.6.10：日程列表 22 日「小雪」是主题蓝、且没有太阳图标）：
 *   1. 日期列的节日 / 节气改成「图标 + 名字」，节日 flag + --accent，节气 sun + --term-ink；
 *   2. 图标一律 currentColor，做到「图标什么颜色，文字就什么颜色」；
 *   3. 日期列「周日 · 11月」必须单行，不许把「月」折到第二行。
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

function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
}

const OCT1 = new Date(2026, 9, 1); // 2026-10-01 周四，国庆节（与 ui-061 同一夹具）
const NOV = new Date(2026, 10, 22); // 2026-11-22 周日，小雪

const holiday = (title, date, extra = {}) => ({
  id: `holiday-${title}`,
  title,
  start: startOfDay(date).getTime(),
  end: endOfDay(date).getTime(),
  allDay: true,
  holiday: true,
  readOnly: true,
  reminders: [],
  ...extra,
});

const term = (title, date) => ({
  id: `term-${title}`,
  title,
  start: startOfDay(date).getTime(),
  end: startOfDay(date).getTime() + 24 * 60 * 60 * 1000,
  allDay: true,
  term: true,
  readOnly: true,
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

function makeCtx(events, cursor, settings = {}) {
  const all = { hour12: true, holidaysEnabled: true, solarTermsEnabled: true, weekStartsOn: 0, ...settings };
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
    cursor,
    now: cursor,
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

const dayHead = (node, num) =>
  [...node.querySelectorAll('.agenda__day')].find(
    (d) => d.querySelector('.agenda__date-num').textContent === String(num),
  ) || null;

describe('0.6.11 日程列表日期列：节日 / 节气各一套颜色与图标', () => {
  it('节气：sun 图标 + --term-ink 修饰类 + 「节气」aria-label', () => {
    const node = renderAgenda(makeCtx([term('小雪', NOV), timed('评审', NOV, 10)], NOV)).node;
    const head = dayHead(node, 22);
    const line = head.querySelector('.agenda__date-holiday');
    expect(line.classList.contains('agenda__date-holiday--term')).toBe(true);
    expect(line.getAttribute('title')).toBe('小雪');
    expect(line.getAttribute('aria-label')).toBe('节气：小雪');
    expect(line.querySelector('.agenda__date-holiday-name').textContent).toBe('小雪');
    const iconEl = line.querySelector('.agenda__date-holiday-icon');
    expect(iconEl).not.toBeNull();
    // sun = 圆心 + 八道光线；flag 没有 circle，用这两点区分（不只数 path）。
    expect(iconEl.innerHTML).toContain('<svg');
    expect(iconEl.innerHTML).toContain('r="4"');
    expect(iconEl.innerHTML).toContain('M12 2v2');
  });

  it('节日：flag 图标 + 无节气修饰类 + 「公共假日」aria-label', () => {
    const node = renderAgenda(makeCtx([holiday('国庆节', OCT1), timed('评审', OCT1, 10)], OCT1)).node;
    const head = dayHead(node, 1);
    const line = head.querySelector('.agenda__date-holiday');
    expect(line.classList.contains('agenda__date-holiday--term')).toBe(false);
    expect(line.getAttribute('title')).toBe('国庆节');
    expect(line.getAttribute('aria-label')).toBe('公共假日：国庆节');
    const iconEl = line.querySelector('.agenda__date-holiday-icon');
    expect(iconEl.innerHTML).toContain('<svg');
    expect(iconEl.innerHTML).toContain('M4 21V4.5');
    expect(iconEl.innerHTML).not.toContain('r="4"');
  });

  it('CSS：节日 --accent、节气 --term-ink、图标 currentColor 与文字同色', () => {
    const box = rule(viewsCss, '.agenda__date-holiday');
    expect(box).toContain('color: var(--accent)');
    expect(box).toContain('display: flex');
    expect(box).toContain('align-items: center');
    expect(rule(viewsCss, '.agenda__date-holiday--term')).toContain('color: var(--term-ink)');
    const iconRule = rule(viewsCss, '.agenda__date-holiday-icon');
    expect(iconRule).toContain('color: currentColor');
    expect(iconRule).toContain('width: 12px');
    expect(iconRule).toContain('height: 12px');
  });

  it('图标与文字同色：四类图标规则都写 currentColor，不再各自写死主题色', () => {
    for (const selector of [
      '.month__holiday-icon',
      '.chip__holiday-icon',
      '.allday-chip.allday-chip--holiday .allday-chip__icon',
      '.agenda__event--holiday .agenda__event-icon',
    ]) {
      const body = rule(viewsCss, selector);
      expect(body, selector).toContain('color: currentColor');
      expect(body, selector).not.toContain('color: var(--accent)');
    }
  });
});

describe('0.6.11 日程列表日期列：周日 · 11月 不折行', () => {
  it('DOM 文案保留完整月份（「11月」不省字、不拆开）', () => {
    const node = renderAgenda(makeCtx([timed('评审', NOV, 10)], NOV)).node;
    const head = dayHead(node, 22);
    const dow = head.querySelector('.agenda__date-dow');
    expect(dow.textContent).toBe('周日 · 11月');
    expect(agendaJs).toMatch(/text: `\$\{WEEKDAYS_SHORT\[day\.getDay\(\)\]\} · \$\{MONTHS_SHORT\[day\.getMonth\(\)\]\}`/);
  });

  it('CSS：单行 nowrap；窄档只降字号与字距，不省月份', () => {
    const dow = rule(viewsCss, '.agenda__date-dow');
    expect(dow).toContain('white-space: nowrap');
    expect(dow).toContain('font-size: var(--fs-sm)');
    const at = viewsCss.indexOf('@media (max-width: 430px) {');
    expect(at).toBeGreaterThan(-1);
    const block = viewsCss.slice(at, viewsCss.indexOf('\n}', at) + 2);
    expect(block).toContain('.agenda__date-dow');
    expect(block).toContain('font-size: var(--fs-xs)');
    expect(block).toContain('letter-spacing: -0.01em');
    // 文案格式里不许出现「省略月份」的处理。
    expect(agendaJs).not.toMatch(/MONTHS_SHORT\[day\.getMonth\(\)\][^\n]*(slice|substring|substr|replace)/);
  });
});