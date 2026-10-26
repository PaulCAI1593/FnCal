/**
 * 0.2.9（用户 16）：日程视图「加载更多」分页。
 *
 * 覆盖：点击后追加一段（原有条目顺序/节点不变）、滚动位置不跳、加载中禁用并
 * 显示「加载中…」、防重复点击、连续 2 段无事件或到 5 年上限后换成「已无更多
 * 日程」、首屏空态下按钮仍可用、失败显示中文可重试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderAgenda, resetAgendaPaging } from '../src/js/views/agenda.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { startOfDay, addDays } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const zhCN = readFileSync(path.join(HERE, '../src/i18n/zh-CN.js'), 'utf8');

const CURSOR = new Date(2026, 7, 17); // Mon 17 Aug 2026
const SEG1 = startOfDay(CURSOR).getTime();

function eventAt(id, date, title = id) {
  const start = date.getTime();
  return { id, title, start, end: start + 3_600_000, allDay: false, color: 'blue', reminders: [] };
}

function makeCtx(store) {
  return {
    store,
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0 },
    cursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      showAllCategories() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
    },
  };
}

function makeStore(events = []) {
  let queries = 0;
  return {
    queries: () => queries,
    resetQueries() {
      queries = 0;
    },
    getEventsInRange: (from, to) => {
      queries += 1;
      return events.filter((e) => e.start < to && e.end > from);
    },
    getTasksInRange: () => [],
    getEvent: (id) => events.find((e) => e.id === id) || null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dayCount = (node) => node.querySelectorAll('.agenda__day').length;
const moreBtn = (node) => node.querySelector('.agenda__more');

describe('⑯ 日程视图加载更多', () => {
  beforeEach(() => {
    resetAgendaPaging();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('点击一次：追加下一段，原有条目节点与顺序不变', async () => {
    // 第一段（8/17–10/16）一条；第二段（10/16–12/15）一条。
    const store = makeStore([
      eventAt('a', new Date(2026, 7, 20, 9)),
      eventAt('b', new Date(2026, 10, 5, 9)),
    ]);
    const { node } = renderAgenda(makeCtx(store));
    document.body.append(node);
    expect(dayCount(node)).toBe(1);
    const firstDay = node.querySelector('.agenda__day');

    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    expect(moreBtn(node).disabled).toBe(true);
    expect(moreBtn(node).textContent).toBe('加载中…');
    await flush();

    expect(dayCount(node)).toBe(2);
    // append-only：原第一条仍是第一条、还是同一个节点
    expect(node.querySelector('.agenda__day')).toBe(firstDay);
    expect(node.querySelectorAll('.agenda__day')[1].textContent).toContain('5');
    expect(moreBtn(node).disabled).toBe(false);
    expect(moreBtn(node).textContent).toBe('加载更多');
  });

  it('加载后滚动位置不跳（代码不改 scrollTop）', async () => {
    const store = makeStore([eventAt('b', new Date(2026, 10, 5, 9))]);
    const { node } = renderAgenda(makeCtx(store));
    document.body.append(node);
    let scroll = 240;
    let writes = 0;
    Object.defineProperty(node, 'scrollTop', {
      configurable: true,
      get: () => scroll,
      set: (v) => {
        writes += 1;
        scroll = v;
      },
    });
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(writes).toBe(0);
    expect(node.scrollTop).toBe(240);
  });

  it('加载中再点不会重复加载（防重复点击）', async () => {
    const store = makeStore([eventAt('b', new Date(2026, 10, 5, 9))]);
    const { node } = renderAgenda(makeCtx(store));
    document.body.append(node);
    store.resetQueries();
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    // 只查询了第二段一次（第一段在初始渲染时已查）
    expect(store.queries()).toBe(1);
    expect(dayCount(node)).toBe(1);
  });

  it('连续 2 段无事件 → 换成「已无更多日程」，按钮消失', async () => {
    const store = makeStore([]);
    const { node } = renderAgenda(makeCtx(store));
    document.body.append(node);
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    const noMore = node.querySelector('.agenda__no-more');
    expect(noMore).toBeTruthy();
    expect(noMore.textContent).toBe('已无更多日程');
    expect(moreBtn(node)).toBeNull();
    // 再点也不会有反应（按钮已不存在）
    expect(node.querySelectorAll('.agenda__day')).toHaveLength(0);
  });

  it('首屏空态下「加载更多」仍可用，且空态文案不变', async () => {
    const store = makeStore([]);
    const { node } = renderAgenda(makeCtx(store));
    document.body.append(node);
    expect(node.querySelector('.empty')).toBeTruthy();
    expect(node.querySelector('.empty p').textContent).toBe('接下来 60 天内没有事件。');
    expect(moreBtn(node)).toBeTruthy();
    expect(moreBtn(node).disabled).toBe(false);

    // 第 3 段（12/15–2027/2/13）有事件：点击后探测到它就追加，空态应消失。
    resetAgendaPaging();
    const later = makeStore([eventAt('late', new Date(2026, 11, 20, 9))]);
    const rendered = renderAgenda(makeCtx(later));
    document.body.append(rendered.node);
    expect(rendered.node.querySelector('.empty')).toBeTruthy();
    moreBtn(rendered.node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(rendered.node.querySelector('.empty')).toBeNull();
    expect(dayCount(rendered.node)).toBe(1);
  });

  it('加载失败 → 中文提示并恢复可点，重试可继续', async () => {
    const store = makeStore([eventAt('b', new Date(2026, 10, 5, 9))]);
    let fail = false;
    const flaky = {
      ...store,
      getEventsInRange: (from, to) => {
        if (fail) throw new Error('boom');
        return store.getEventsInRange(from, to);
      },
    };
    const { node } = renderAgenda(makeCtx(flaky));
    document.body.append(node);
    fail = true;
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(moreBtn(node).textContent).toBe('加载失败，请重试');
    expect(moreBtn(node).disabled).toBe(false);

    // 恢复后重试：追加第二段内容
    fail = false;
    moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(dayCount(node)).toBe(1);
    expect(moreBtn(node).textContent).toBe('加载更多');
  });

  it('到光标日起 5 年上限即「已无更多日程」（不再请求）', async () => {
    // 每一段都有事件 → 每次点击加载一段；5 年 = 1825 天，共 31 段（最后一段封顶）。
    const events = [];
    for (let i = 0; i < 31; i++) {
      events.push(eventAt(`e${i}`, addDays(CURSOR, i * 60 + 5)));
    }
    const store = makeStore(events);
    let queries = 0;
    const counted = {
      ...store,
      getEventsInRange: (from, to) => {
        queries += 1;
        return store.getEventsInRange(from, to);
      },
    };
    const { node } = renderAgenda(makeCtx(counted));
    document.body.append(node);
    for (let i = 0; i < 31 && moreBtn(node); i++) {
      moreBtn(node).dispatchEvent(new Event('click', { bubbles: true }));
      await flush();
    }
    expect(node.querySelector('.agenda__no-more').textContent).toBe('已无更多日程');
    expect(moreBtn(node)).toBeNull();
    // 上限之后不再查询：31 段初始 1 次 + 30 次加载 = 31 次
    expect(queries).toBe(31);
  });

  it('i18n 四个键都在词典里（不写死中文）', () => {
    for (const key of ['agenda.loadMore', 'agenda.loading', 'agenda.noMore', 'agenda.loadError']) {
      expect(zhCN).toContain(`'${key}'`);
    }
  });
});
