/**
 * 0.8.21（用户 m00745 / m01007，总监 m02540）：手机日程时间列竖向、跨夜在日界截到 00:00。
 *   单日 08:30 / │ / 10:00；跨夜第一天 22:00 / 00:00；后续天 00:00 / 04:00；
 *   整天都在事件内的中间日与全天事件写「全天」单行、不加竖线；
 *   时间列任何一行都不出现「月」「日」；aria-label 仍含真实结束时间。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderAgenda, compactDayPartText } from '../src/js/views/agenda.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');
const agendaJs = readFileSync(path.join(HERE, '..', 'src/js/views/agenda.js'), 'utf8');

const D1 = new Date(2026, 6, 1);
const D2 = new Date(2026, 6, 2);
const D3 = new Date(2026, 6, 3);
const realMatchMedia = globalThis.window ? window.matchMedia : undefined;

function setCompact() {
  window.matchMedia = () => ({ matches: true, media: '(max-width: 520px)', addEventListener() {}, removeEventListener() {} });
}
afterEach(() => {
  if (realMatchMedia) window.matchMedia = realMatchMedia;
});

const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
const ev = (extra) => ({ id: `ev-${extra.title}`, title: extra.title, color: 'violet', reminders: [], allDay: false, ...extra });

function makeCtx(events, cursor) {
  const settings = { hour12: true, holidaysEnabled: false, solarTermsEnabled: false, weekStartsOn: 0 };
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getSettings: () => settings,
    },
    settings,
    cursor,
    now: cursor,
    actions: { createAt() {}, openEvent() {}, openTask() {}, toggleTask() {}, eventContextMenu() {}, taskContextMenu() {} },
  };
}

function rowFor(events, cursor, title) {
  const node = renderAgenda(makeCtx(events, cursor)).node;
  return [...node.querySelectorAll('.agenda__event')].find(
    (r) => r.getAttribute('aria-label').startsWith(title),
  );
}
const timeOf = (row) => row.querySelector('.agenda__event-time');

describe('0.8.21 手机日程时间列竖向与日界截断', () => {
  it('单日 08:30-10:00：竖向两行，开始行不带「-」', () => {
    setCompact();
    const row = rowFor([ev({ title: '评审', start: at(D1, 8, 30), end: at(D1, 10) })], D1, '评审');
    const time = timeOf(row);
    expect(time.classList.contains('agenda__event-time--stack')).toBe(true);
    const start = time.querySelector('.agenda__event-time-start');
    expect(start.textContent).toBe('08:30');
    // 0.8.24（用户 m01077）：开始时间拆「时 / : / 分」，竖线挂在冒号上。
    expect(start.querySelector('.agenda__event-time-h').textContent).toBe('08');
    expect(start.querySelector('.agenda__event-time-colon').textContent).toBe(':');
    expect(start.querySelector('.agenda__event-time-min').textContent).toBe('30');
    expect(time.querySelector('.agenda__event-time-end').textContent).toBe('10:00');
  });

  it('跨夜第一天：22:00 / 00:00，不出现日期', () => {
    setCompact();
    const row = rowFor([ev({ title: '值班', start: at(D1, 22), end: at(D2, 4) })], D1, '值班');
    const time = timeOf(row);
    expect(time.querySelector('.agenda__event-time-start').textContent).toBe('22:00');
    expect(time.querySelector('.agenda__event-time-end').textContent).toBe('00:00');
    expect(time.textContent).not.toMatch(/[月日]/);
  });

  it('跨夜第二天：00:00 / 04:00，不出现日期', () => {
    setCompact();
    const row = rowFor([ev({ title: '值班', start: at(D1, 22), end: at(D2, 4) })], D2, '值班');
    const time = timeOf(row);
    expect(time.querySelector('.agenda__event-time-start').textContent).toBe('00:00');
    expect(time.querySelector('.agenda__event-time-end').textContent).toBe('04:00');
    expect(time.textContent).not.toMatch(/[月日]/);
  });

  it('中间日（整天都在事件内）：写「全天」并挂上紧凑标注，不画竖线', () => {
    setCompact();
    const events = [ev({ title: '出差', start: at(D1, 9), end: at(new Date(2026, 6, 4), 18) })];
    const row = rowFor(events, D2, '出差');
    const time = timeOf(row);
    // 0.8.22（总监 m02747）：中间日与其它天一致地挂标注，列结构同 --stack。
    expect(time.classList.contains('agenda__event-time--stack')).toBe(true);
    expect(time.querySelector('.agenda__event-time-start').textContent).toBe('全天');
    expect(time.querySelector('.agenda__event-daypart--time').textContent).toBe('第2/4天');
    // 没有结束行，竖线（挂在 --end::before）就不会出现。
    expect(time.querySelector('.agenda__event-time-end')).toBeNull();
    expect(time.textContent).not.toMatch(/[月日]/);
  });

  it('中间日与前后两天的标注顺序连续（第1/2/3/4天都在）', () => {
    setCompact();
    const events = [ev({ title: '出差', start: at(D1, 9), end: at(new Date(2026, 6, 4), 18) })];
    const days = [D1, D2, D3, new Date(2026, 6, 4)];
    const parts = days.map((d) => rowFor(events, d, '出差').querySelector('.agenda__event-daypart--time').textContent);
    expect(parts).toEqual(['第1/4天', '第2/4天', '第3/4天', '第4/4天']);
  });

  it('全天事件：单行「全天」、不挂 --stack', () => {
    setCompact();
    const events = [ev({ title: '放假', start: at(D3, 0), end: at(D3, 0) + 24 * 3600 * 1000, allDay: true })];
    const row = rowFor(events, D3, '放假');
    const time = timeOf(row);
    expect(time.textContent).toBe('全天');
    expect(time.classList.contains('agenda__event-time--stack')).toBe(false);
  });

  it('aria-label 仍含真实结束时间（读屏不丢跨天信息）', () => {
    setCompact();
    const row = rowFor([ev({ title: '值班', start: at(D1, 22), end: at(D2, 4) })], D1, '值班');
    const label = row.getAttribute('aria-label');
    // aria-label 走 12 小时制，但日期与真实结束时间必须在
    expect(label).toContain('下午10:00');
    expect(label).toContain('7月2日 上午4:00');
  });

  it('紧凑文案：第1/3天、第10/12天都正确，两位数列宽仍放得下', () => {
    const three = { start: at(D1, 9), end: at(new Date(2026, 6, 3), 18) };
    expect(compactDayPartText(three, D1)).toBe('第1/3天');
    const twelve = { start: at(D1, 9), end: at(new Date(2026, 6, 12), 18) };
    expect(compactDayPartText(twelve, new Date(2026, 6, 10))).toBe('第10/12天');
  });

  it('跨天首日行：时间列标注用紧凑文案，aria-label 用完整文案', () => {
    setCompact();
    const events = [ev({ title: '出差', start: at(D1, 9), end: at(new Date(2026, 6, 3), 18) })];
    const row = rowFor(events, D1, '出差');
    const time = timeOf(row);
    expect(time.classList.contains('agenda__event-time--stack')).toBe(true);
    expect(time.querySelector('.agenda__event-daypart--time').textContent).toBe('第1/3天');
    expect(row.getAttribute('aria-label')).toContain('（第 1/3 天）');
    expect(time.textContent).not.toMatch(/[月日]/);
  });

  it('竖线挂在开始时间冒号上：冒号中心对齐、竖线 4px（0.8.26 起结束行无额外间距、线画在 100%-1）', () => {
    const stackAt = viewsCss.indexOf('.agenda__event-time--stack {');
    const stack = viewsCss.slice(stackAt, viewsCss.indexOf('}', stackAt));
    // 0.8.24（用户 m01077）：竖线不再在整列居中，冒号才是锚点。
    expect(stack).toMatch(/align-items:\s*flex-start;/);
    const endAt = viewsCss.indexOf('.agenda__event-time--stack > .agenda__event-time-end {');
    const endRule = viewsCss.slice(endAt, viewsCss.indexOf('}', endAt));
    expect(endRule).toMatch(/display:\s*block;/);
    expect(endRule).toMatch(/line-height:\s*20px;/);
    // 0.8.26（总监 m03145 / 用户 m01209）：结束行 6px → 0，与右侧地址同一行盒节奏。
    expect(endRule).toMatch(/margin-top:\s*0;/);
    expect(endRule).not.toMatch(/width:\s*100%;/);
    const colonAt = viewsCss.indexOf('.agenda__event-time-colon {');
    const colon = viewsCss.slice(colonAt, viewsCss.indexOf('}', colonAt));
    expect(colon).toMatch(/position:\s*relative;/);
    expect(colon).toMatch(/display:\s*inline-block;/);
    expect(colon).toMatch(/height:\s*20px;/);
    const connAt = viewsCss.indexOf('.agenda__event-time-colon::after');
    const connector = viewsCss.slice(connAt, viewsCss.indexOf('}', connAt));
    expect(connector).toMatch(/left:\s*50%;/);
    // 0.8.26：竖线从首行行盒底边上移 1px 起画，落在两行文字空隙里。
    expect(connector).toMatch(/top:\s*calc\(100% - 1px\);/);
    expect(connector).toMatch(/transform:\s*translateX\(-50%\);/);
    expect(viewsCss).not.toContain('.agenda__event-time--stack .agenda__event-time-end::before');
    // 360 档冒号块同步 18px（0.8.26 起地址行盒 16px 与结束行底齐平，见 agenda-basealign-0826）。
    const narrow = viewsCss.slice(viewsCss.lastIndexOf('@media (max-width: 360px)'));
    expect(narrow).toMatch(/\.agenda__event-time-colon {\s*height:\s*18px;\s*line-height:\s*18px;/);
  });

  it('CSS：--stack 44px（≤360 为 36px）、竖线 1px×4px 45%、没有 --wide、标注 9px', () => {
    const stackAt = viewsCss.indexOf('.agenda__event-time--stack {');
    const stack = viewsCss.slice(stackAt, viewsCss.indexOf('}', stackAt));
    expect(stack).toMatch(/flex-direction:\s*column;/);
    expect(stack).toMatch(/width:\s*44px;/);
    const connectorAt = viewsCss.indexOf('.agenda__event-time-colon::after');
    const connector = viewsCss.slice(connectorAt, viewsCss.indexOf('}', connectorAt));
    expect(connector).toMatch(/width:\s*1px;/);
    expect(connector).toMatch(/height:\s*4px;/);
    expect(connector).toMatch(/opacity:\s*0\.45;/);
    expect(viewsCss).not.toContain('.agenda__event-time--wide');
    // 0.8.24（用户 m01077）：竖线跟着开始时间的冒号，不再是整列居中。
    expect(stack).toMatch(/align-items:\s*flex-start;/);
    const narrow = viewsCss.slice(viewsCss.lastIndexOf('@media (max-width: 360px)'));
    expect(narrow).toMatch(/\.agenda__event-time--stack {\s*width:\s*36px;/);
    expect(viewsCss).toMatch(/\.agenda__event-daypart--time {\s*display:\s*inline;[\s\S]{0,200}font-size:\s*9px;/);
    expect(viewsCss).toMatch(/\.agenda__event-daypart--time {[\s\S]{0,200}white-space:\s*nowrap;/);
    // 可见时间列里不再有「拼日期」的代码（桌面 rowTimeRange 的日期保留）
    const fnAt = agendaJs.indexOf('function compactRangeParts(');
    const fn = agendaJs.slice(fnAt, agendaJs.indexOf('\n}', fnAt));
    expect(fn).not.toContain('MONTHS_SHORT');
    expect(fn).not.toContain('endDate');
  });
});
