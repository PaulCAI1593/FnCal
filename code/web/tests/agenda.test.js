import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { renderAgenda, scrollAgendaToToday } from '../src/js/views/agenda.js';
import { startOfDay, endOfDay, addDays } from '../src/js/date-utils.js';

const CURSOR = new Date(2026, 7, 17); // Mon 17 Aug 2026
const day = (n, h = 0, m = 0) => new Date(2026, 7, n, h, m).getTime();

function makeCtx(events, tasks = [], settings = {}) {
  return {
    store: {
      getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
      getTasksInRange: (from, to) => tasks.filter((t) => t.due >= from && t.due < to),
      getEvent: (id) => events.find((e) => e.id === id) || null,
      getSettings: () => ({ hour12: true, ...settings }),
    },
    settings: { hour12: true, weekStartsOn: 0, ...settings },
    cursor: CURSOR,
    now: CURSOR,
    actions: {
      createAt() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      // 0.5.19：空态按钮按「分类 / 日历」分桶清筛选；本桩没有分桶（旧口径），
      // 走分类这一支，等价于 0.5.18 的行为。
      showAllCategories() {},
      showHiddenFilters(hidden) {
        if (hidden.byColor > 0) this.showAllCategories();
      },
    },
  };
}

/** [{ dayNumber, rows: [[time, title]] }] as the list renders it. */
function readList(node) {
  return [...node.querySelectorAll('.agenda__day')].map((d) => ({
    day: Number(d.querySelector('.agenda__date-num').textContent),
    rows: [...d.querySelectorAll('.agenda__event')].map((r) => [
      // 0.7.17（总监 m00333）：跨天标注搬进时间列，时间列的文本现在含「（第 n/m 天）」。
      // 这些用例只断言时间本身，先摘掉标注节点再读（标注另有专门用例）。
      (() => {
        const t = r.querySelector('.agenda__event-time').cloneNode(true);
        t.querySelectorAll('.agenda__event-daypart').forEach((n) => n.remove());
        // A time holds its AM/PM with a no-break space (see date-utils); these
        // rows are about which event lands on which day, so read it as a plain
        // space and leave the character itself to the formatter's own test.
        return t.textContent.replace(/\u00a0/g, ' ');
      })(),
      r.querySelector('.agenda__event-title').textContent,
    ]),
  }));
}

describe('agenda view — multi-day events', () => {
  it('lists an all-day event under every day it covers', () => {
    const trip = {
      id: 'trip',
      title: 'Conference trip',
      start: startOfDay(new Date(day(17))).getTime(),
      end: endOfDay(new Date(day(19))).getTime(),
      allDay: true,
      color: 'violet',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([trip]));
    expect(readList(node)).toEqual([
      { day: 17, rows: [['全天', 'Conference trip']] },
      { day: 18, rows: [['全天', 'Conference trip']] },
      { day: 19, rows: [['全天', 'Conference trip']] },
    ]);
  });

  it('reads a cross-midnight event from midnight on its second day', () => {
    const deploy = {
      id: 'd',
      title: 'Late night deploy',
      start: day(18, 23, 0),
      end: day(19, 1, 30),
      allDay: false,
      color: 'red',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([deploy]));
    expect(readList(node)).toEqual([
      // The end is named with its date on the day the event starts: it is
      // past the midnight that closes the 18th, so a bare "1:30 AM" would
      // read as a range running backwards.
      { day: 18, rows: [['下午11:00-8月19日 上午1:30', 'Late night deploy']] },
      // Present from midnight on the 19th — the original 11 PM start would file
      // a row under the 19th claiming it begins the night before. The end is
      // on this row's own day, so it needs no date.
      { day: 19, rows: [['上午12:00-上午1:30', 'Late night deploy']] },
    ]);
  });

  it('names the end date of an event saved as 9 AM to 8 AM the next morning', () => {
    // The editor reads an end time earlier than the start on the same date as
    // the next morning (timeOrderProblem in modal.js). The reported reading
    // of the result — "List view shows 09:00-08:00" — is what the date is
    // here to prevent.
    const ev = {
      id: 'e',
      title: 'Overnight',
      start: day(18, 9),
      end: day(19, 8),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    expect(readList(node)).toEqual([
      { day: 18, rows: [['上午9:00-8月19日 上午8:00', 'Overnight']] },
      { day: 19, rows: [['上午12:00-上午8:00', 'Overnight']] },
    ]);
  });

  it('keeps naming the end date on a middle day of a longer timed event', () => {
    const ev = {
      id: 'e',
      title: 'Hackathon',
      start: day(18, 9),
      end: day(20, 8),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    expect(readList(node)).toEqual([
      { day: 18, rows: [['上午9:00-8月20日 上午8:00', 'Hackathon']] },
      { day: 19, rows: [['上午12:00-8月20日 上午8:00', 'Hackathon']] },
      { day: 20, rows: [['上午12:00-上午8:00', 'Hackathon']] },
    ]);
  });

  it('names the end date on a 24-hour clock too', () => {
    const ev = {
      id: 'e',
      title: 'Overnight',
      start: day(18, 9),
      end: day(19, 8),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev], [], { hour12: false }));
    expect(readList(node)[0].rows).toEqual([['09:00-8月19日 08:00', 'Overnight']]);
  });

  it('joins the end date and its time with no-break spaces so the label wraps only at the dash', () => {
    const ev = {
      id: 'e',
      title: 'Overnight',
      start: day(18, 22, 30),
      end: day(19, 1, 30),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    // The fixed-width time column cannot hold "10:30 PM-Aug 19, 1:30 AM" on
    // one line; the only plain spaces are the ones around the dash.
    // 0.7.17（总监 m00333）：跨天标注搬进时间列，时间列文本尾部带「（第 1/2 天）」。
    // 这里只断言时间本身，取时间列的 `.agenda__event-time-text`；标注单独断言。
    const timeEl = node.querySelector('.agenda__event-time');
    const textEl = timeEl.querySelector('.agenda__event-time-text') || timeEl;
    expect(textEl.textContent).toBe(
      '下午10:30-8月19日 上午1:30',
    );
    // 0.7.21（总监 m02610）：标注渲染两份，时间列那份带 `--time`。
    expect(timeEl.querySelector('.agenda__event-daypart--time').textContent).toBe('（第 1/2 天）');
  });

  // 0.7.17（总监 m00333）：非全天跨天行的标注挂时间列，时间在上、标注在下。
  // 0.7.21（总监 m02610）：宽屏那份回名称行右侧（`--name`），窄屏那份在时间列
  // （`--time`）；两份都渲染，显示由 CSS 520px 断点切换。
  it('非全天跨天行：窄屏标注在时间列（时间在上、标注在下），宽屏那份在名称行', () => {
    const ev = {
      id: 'd',
      title: 'Late night deploy',
      start: day(18, 23, 0),
      end: day(19, 1, 30),
      allDay: false,
      color: 'red',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    const row = node.querySelector('.agenda__event');
    const time = row.querySelector('.agenda__event-time');
    expect(time.classList.contains('agenda__event-time--stacked')).toBe(true);
    const order = [...time.children].map((c) => c.className.split(' ')[0]);
    expect(order).toEqual(['agenda__event-time-text', 'agenda__event-daypart']);
    const inTime = row.querySelector('.agenda__event-time .agenda__event-daypart');
    expect(inTime.classList.contains('agenda__event-daypart--time')).toBe(true);
    const inMain = row.querySelector('.agenda__event-main .agenda__event-daypart');
    expect(inMain.classList.contains('agenda__event-daypart--name')).toBe(true);
    expect(inMain.textContent).toBe('（第 1/2 天）');
  });

  it('lists an ordinary same-day event exactly once', () => {
    const ev = {
      id: 'e',
      title: 'Standup',
      start: day(18, 9),
      end: day(18, 9, 30),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    expect(readList(node)).toEqual([{ day: 18, rows: [['上午9:00-上午9:30', 'Standup']] }]);
  });

  it('does not spill an event that ends exactly at midnight onto the next day', () => {
    const ev = {
      id: 'e',
      title: 'Evening shift',
      start: day(18, 21),
      end: day(19, 0, 0),
      allDay: false,
      color: 'blue',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([ev]));
    expect(readList(node).map((d) => d.day)).toEqual([18]);
    // And its end needs no date: "下午9:00-上午12:00" is read as tonight's midnight
    // by everyone, and the event is not filed under the 19th either.
    expect(readList(node)[0].rows).toEqual([['下午9:00-上午12:00', 'Evening shift']]);
  });

  it('stops at the end of the 60-day window', () => {
    const start = startOfDay(addDays(CURSOR, 58)).getTime();
    const long = {
      id: 'long',
      title: 'Sabbatical',
      start,
      end: endOfDay(addDays(CURSOR, 90)).getTime(),
      allDay: true,
      color: 'teal',
      reminders: [],
    };
    const { node } = renderAgenda(makeCtx([long]));
    // Days 58 and 59 of the window, and no further.
    expect(readList(node)).toHaveLength(2);
  });
});

describe('agenda view — the empty state', () => {
  /** ctx whose store hides everything unless `includeHidden` is passed — the
   *  shape a category filter produces. */
  function filteredCtx(events, shown = []) {
    const ctx = makeCtx(events);
    const all = ctx.store.getEventsInRange;
    ctx.store.getEventsInRange = (from, to, opts = {}) =>
      opts.includeHidden ? all(from, to) : shown;
    ctx.actions.showAllCategories = () => {
      ctx.actions.showAllCategories.calls = (ctx.actions.showAllCategories.calls || 0) + 1;
    };
    ctx.actions.showHiddenFilters = (hidden) => {
      ctx.actions.showHiddenFilters.calls = (ctx.actions.showHiddenFilters.calls || 0) + 1;
      if (hidden.byColor > 0) ctx.actions.showAllCategories();
    };
    return ctx;
  }

  const ev = {
    id: 'e1',
    title: 'Dentist',
    start: day(18, 9),
    end: day(18, 10),
    allDay: false,
    color: 'blue',
    reminders: [],
  };

  it('says the calendar is empty only when it really is', () => {
    const { node } = renderAgenda(makeCtx([]));
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内没有事件。',
    );
    expect(node.querySelector('.empty .btn').textContent).toContain('新建事件');
  });

  it('blames the category filter instead of claiming there is nothing on', () => {
    // Every event hidden: "No upcoming events in the next 60 days" would be
    // false, and reads as data loss.
    const ctx = filteredCtx([ev]);
    const { node } = renderAgenda(ctx);
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内，1 个事件被分类筛选隐藏了。',
    );
    const btn = node.querySelector('.empty .btn');
    expect(btn.textContent).toContain('显示全部分类');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(ctx.actions.showAllCategories.calls).toBe(1);
  });

  it('pluralises the count', () => {
    const second = { ...ev, id: 'e2', start: day(19, 9), end: day(19, 10) };
    const { node } = renderAgenda(filteredCtx([ev, second]));
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内，2 个事件被分类筛选隐藏了。',
    );
  });

  /** A task the category filter hid: the range query returns it only when
   *  asked to include hidden items, exactly as the store now behaves. */
  const hiddenTask = {
    id: 't1',
    title: 'Buy milk',
    due: day(18, 9),
    allDay: false,
    done: false,
    color: 'indigo',
    isTask: true,
  };
  const hideTasks = (ctx) => {
    ctx.store.getTasksInRange = (from, to, opts = {}) => (opts.includeHidden ? [hiddenTask] : []);
    return ctx;
  };

  it('counts a hidden task, and calls it a task rather than an event', () => {
    const ctx = hideTasks(filteredCtx([]));
    const { node } = renderAgenda(ctx);
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内，1 个任务被分类筛选隐藏了。',
    );
    expect(node.querySelector('.empty .btn').textContent).toContain('显示全部分类');
  });

  it('names both events and tasks when the filter hid some of each', () => {
    const { node } = renderAgenda(hideTasks(filteredCtx([ev])));
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内，1 个事件和 1 个任务被分类筛选隐藏了。',
    );
  });

  it('does not count public holidays as hidden events', () => {
    // Holidays carry no palette colour, so the filter never touches them —
    // offering "Show all categories" over them would fix nothing.
    const holiday = { id: 'h', title: 'Labour Day', start: day(20), end: day(21), allDay: true, holiday: true, readOnly: true };
    const { node } = renderAgenda(filteredCtx([holiday]));
    expect(node.querySelector('.empty p').textContent).toBe(
      '接下来 60 天内没有事件。',
    );
  });
});

describe('agenda view — 「今天」定位（0.7.18，总监：日程列表点今天定位）', () => {
  const todayEvent = {
    id: 'today',
    title: 'Today standup',
    start: day(17, 9),
    end: day(17, 10),
    allDay: false,
    color: 'indigo',
    calendarId: 'c1',
  };
  const laterEvent = {
    id: 'later',
    title: 'Later review',
    start: day(20, 9),
    end: day(20, 10),
    allDay: false,
    color: 'indigo',
    calendarId: 'c1',
  };

  function scrollerFor(node) {
    const scroller = document.createElement('div');
    scroller.append(node);
    scroller.scrollTop = 500;
    scroller.getBoundingClientRect = () => ({ top: 40, left: 0, width: 390, height: 800, bottom: 840, right: 390 });
    scroller.scrollTo = (opts) => {
      scroller.lastScroll = opts;
    };
    return scroller;
  }

  it('给今天这一天挂 agenda__day--today 与 data-day', () => {
    const { node } = renderAgenda(makeCtx([todayEvent, laterEvent]));
    const todayNode = node.querySelector('.agenda__day--today');
    expect(todayNode).toBeTruthy();
    expect(todayNode.dataset.day).toBe(String(startOfDay(CURSOR).getTime()));
    // 列表里只有今天这一段被标成今天。
    expect(node.querySelectorAll('.agenda__day--today').length).toBe(1);
  });

  it('滚到今天那一段：落点 = 段顶相对容器顶 + 当前滚动量；日期头闪一下', () => {
    const { node } = renderAgenda(makeCtx([todayEvent, laterEvent]));
    const scroller = scrollerFor(node);
    const todayNode = node.querySelector('.agenda__day--today');
    todayNode.getBoundingClientRect = () => ({ top: 300, left: 0, width: 390, height: 120, bottom: 420, right: 390 });
    const res = scrollAgendaToToday(scroller, { reduceMotion: false });
    expect(res).toBe('scrolled');
    // 300 − 40（容器顶）+ 500（原滚动量）= 760：段顶对齐容器顶，吸顶日期头完整可见。
    expect(scroller.lastScroll.top).toBe(760);
    expect(scroller.lastScroll.behavior).toBe('smooth');
    expect(todayNode.querySelector('.agenda__date').classList.contains('agenda__date--flash')).toBe(true);
  });

  it('prefers-reduced-motion：不平滑滚动、不闪', () => {
    const { node } = renderAgenda(makeCtx([todayEvent, laterEvent]));
    const scroller = scrollerFor(node);
    node.querySelector('.agenda__day--today').getBoundingClientRect = () => ({
      top: 300, left: 0, width: 390, height: 120, bottom: 420, right: 390,
    });
    const res = scrollAgendaToToday(scroller, { reduceMotion: true });
    expect(res).toBe('scrolled');
    expect(scroller.lastScroll.behavior).toBe('auto');
    expect(node.querySelector('.agenda__date--flash')).toBeNull();
  });

  it('今天没有条目：不滚，返回 no-today（由调用方给轻提示）', () => {
    const { node } = renderAgenda(makeCtx([laterEvent]));
    const scroller = scrollerFor(node);
    expect(scrollAgendaToToday(scroller, { reduceMotion: true })).toBe('no-today');
    expect(scroller.lastScroll).toBeUndefined();
  });

  it('没有滚动容器时返回 none，不抛错', () => {
    expect(scrollAgendaToToday(null)).toBe('none');
  });
});

describe('「今天」入口接线（0.7.18，总监）', () => {
  // 沙箱里不能用 `new URL(..., import.meta.url)`：vite 的 asset 插件会 spawn EPERM。
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const appJs = fs.readFileSync(path.join(HERE, '..', 'src', 'js', 'app.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(HERE, '..', 'src', 'i18n', 'zh-CN.js'), 'utf8');

  it('goToday 在日程列表里调用 scrollAgendaToToday，缺今天时给轻提示', () => {
    expect(appJs).toContain("if (scrollAgendaToToday(scroller) !== 'scrolled')");
    expect(appJs).toContain("toast(t('agenda.noTodayHint'))");
    // 只在日程列表里滚动：其它视图的「今天」行为不变。
    expect(appJs).toContain("const jumpAgenda = state.view === 'agenda';");
  });

  it('日程列表里「今天」按钮的 aria-label 说明会跳到今天，按钮仍是 button', () => {
    expect(appJs).toContain("state.view === 'agenda' ? t('toolbar.todayJump') : t('toolbar.today')");
    expect(appJs).toMatch(/class: 'btn header__today',\s*\n?\s*type: 'button'/);
    expect(i18n).toContain("'toolbar.todayJump': '今天（跳到日程列表里的今天）'");
    expect(i18n).toContain("'agenda.noTodayHint': '今天没有日程'");
  });
});