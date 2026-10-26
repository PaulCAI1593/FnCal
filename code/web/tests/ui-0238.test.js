import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgenda } from '../src/js/views/agenda.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

// 0.2.38（用户 m01831「日程视图，名称下面加一行小字地址」）：
// 日程视图每个事件行在标题下面多一行小字地址（event.location），
// 没有地址的事件不多出任何节点、行高不变。

const CURSOR = new Date(2026, 7, 17); // Mon 17 Aug 2026
const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = fs.readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

function makeCtx(events, actions = {}) {
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getSettings: () => ({ hour12: true }),
    },
    settings: { hour12: true, weekStartsOn: 0 },
    cursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      ...actions,
    },
  };
}

const timed = (over = {}) => ({
  id: 'ev1',
  title: '人工智能专项能力考核',
  start: new Date(2026, 7, 17, 13, 0).getTime(),
  end: new Date(2026, 7, 17, 15, 0).getTime(),
  allDay: false,
  color: 'blue',
  reminders: [],
  ...over,
});

describe('0.2.38 日程视图：标题下的地址小字', () => {
  it('有地址时在标题下面渲染一行小字，并给行加 --has-location', () => {
    const ev = timed({ location: '上海市黄浦区中山东一路 1 号 · 外滩' });
    const { node } = renderAgenda(makeCtx([ev]));
    const row = node.querySelector('.agenda__event');
    expect(row.classList.contains('agenda__event--has-location')).toBe(true);

    const main = row.querySelector('.agenda__event-main');
    const kids = [...main.children].map((c) => c.className);
    expect(kids).toEqual(['agenda__event-title', 'agenda__event-location']);

    const loc = row.querySelector('.agenda__event-location');
    expect(loc.textContent).toBe('上海市黄浦区中山东一路 1 号 · 外滩');
    // 标题仍然是原来那一个，没有被地址替代。
    expect(row.querySelector('.agenda__event-title').textContent).toBe('人工智能专项能力考核');
    // 读屏也念地址。
    expect(row.getAttribute('aria-label')).toContain('上海市黄浦区中山东一路 1 号');
  });

  it('没有地址（或只有空白）时不多出节点、不加修饰类', () => {
    for (const location of [undefined, '', '   ']) {
      const { node } = renderAgenda(makeCtx([timed({ location })]));
      const row = node.querySelector('.agenda__event');
      expect(row.querySelector('.agenda__event-location')).toBeNull();
      expect(row.classList.contains('agenda__event--has-location')).toBe(false);
      expect([...row.querySelector('.agenda__event-main').children]).toHaveLength(1);
    }
  });

  it('跨天事件：第一行「标题 +（第 n/m 天）」，第二行地址', () => {
    const trip = {
      id: 'trip',
      title: '建筑设计双年展',
      start: startOfDay(new Date(2026, 7, 17)).getTime(),
      end: endOfDay(new Date(2026, 7, 19)).getTime(),
      allDay: true,
      color: 'violet',
      reminders: [],
      location: '上海当代艺术博物馆',
    };
    const { node } = renderAgenda(makeCtx([trip]));
    const row = node.querySelector('.agenda__event');
    const kids = [...row.querySelector('.agenda__event-main').children].map((c) => c.className);
    expect(kids).toEqual(['agenda__event-title', 'agenda__event-daypart', 'agenda__event-location']);
    expect(row.querySelector('.agenda__event-daypart').textContent).toBe('（第 1/3 天）');
    expect(row.querySelector('.agenda__event-location').textContent).toBe('上海当代艺术博物馆');
  });

  it('地址过长不换行而是省略（样式口径）', () => {
    const rule = viewsCss.slice(viewsCss.indexOf('.agenda__event-location {'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toContain('white-space: nowrap');
    expect(block).toContain('text-overflow: ellipsis');
    expect(block).toContain('color: var(--text-3)');
    expect(block).toContain('grid-column: 1 / -1');
    // 两行行的对齐：圆点与时间对齐第一行。
    expect(viewsCss).toContain('.agenda__event--has-location {');
  });

  it('加入地址后行仍然可点开事件', () => {
    const opened = [];
    const ev = timed({ location: '静安区愚园路 68 号' });
    const { node } = renderAgenda(makeCtx([ev], { openEvent: (e) => opened.push(e.id) }));
    node.querySelector('.agenda__event').click();
    expect(opened).toEqual(['ev1']);
  });

  it('任务行与节日行不受影响（不出现地址行）', () => {
    const task = {
      id: 't1',
      title: '交稿',
      due: new Date(2026, 7, 17, 18, 0).getTime(),
      allDay: false,
      done: false,
      color: 'green',
      reminders: [],
    };
    const ctx = makeCtx([], {});
    ctx.store.getTasksInRange = () => [task];
    const { node } = renderAgenda(ctx);
    expect(node.querySelectorAll('.agenda__event-location')).toHaveLength(0);
  });
});
