/**
 * Global search — a command-palette-style overlay that finds events by title,
 * location, or description and tasks by title or notes across the whole
 * calendar and jumps to them.
 *
 * The searchable index (one entry per stored event, with a representative
 * occurrence resolved for recurring series, plus one entry per task) is
 * snapshotted when the overlay opens, so filtering on every keystroke is a
 * cheap in-memory scan. Picking a result hands the resolved event/occurrence
 * or task back through `onPick`.
 */
import { el, clear } from './dom.js';
import { closeOnBackdrop } from './scrim.js';
import { icon } from './icons.js';
import { EVENT_COLORS, colorHex, colorFg, colorKeyOfHex, isValidColor } from './colors.js';
// 0.7.0：标签筛选按记录解析出的标签（tagId 优先，其次 categories 名称）。
import { DEFAULT_TAG_GROUP_ID, tagForRecord, tagDisplayName } from './store.js';
// 0.7.5（用户「下拉菜单的分组也可以折叠」）：与编辑器标签下拉共用折叠状态。
import { expandAllGroups, isGroupCollapsed, toggleGroupCollapsed } from './tag-dropdown-collapse.js';
// 0.7.5（用户「搜索里的任务没带emoji」）：结果标题与详情卡共用同一套拆分。
import { splitTagTitle } from './tag-display.js';
import { describeRecurrence, occurrenceNear } from './recurrence.js';
import {
  formatFullDate,
  formatTime,
  formatTimeRange,
  MS_PER_DAY,
  startOfDay,
} from './date-utils.js';
import { t } from '../i18n/index.js';
// 0.2.36（M1）：时间范围的日期字段改用弹层日历（与编辑器 0.2.19 D3 同一套），
// 这样空态文案是我们自己的「年/月/日」，不再由浏览器按 locale 画原生占位符。
import { isInsideDatePopover, openDatePopover } from './date-popover.js';
// 0.2.15（D6）：结果面板宽度与「展开态槽宽」同源（lib/segment.js），不再量搜索条自身宽度。
import { searchPanelWidth } from './lib/segment.js';

const MAX_RESULTS = 40;
const OCC_WINDOW_DAYS = 400; // how far to look for a recurring series' representative

/**
 * 0.2.10（1-12）：搜索框内的「清空」小叉（一键清空已输入文字）。
 * - 只有有输入时出现：用 `visibility` 切换而不是 display，输入区宽度不抖动；
 * - 点击：清空内容 → 派发 `input` → 焦点回到输入框（光标可见），
 *   结果区由现有的 input 监听按「空关键词」规则回到初始态（不新造状态）。
 * @param {HTMLInputElement} target 搜索输入框
 * @param {HTMLElement} [before] 插入位置（该元素之前，通常是「筛选」按钮）
 */
export function attachSearchClear(target, before) {
  const btn = el('button', {
    class: 'icon-btn search__clear is-hidden',
    type: 'button',
    tabindex: '-1',
    'aria-label': t('search.clear'),
    title: t('search.clear'),
    html: icon('close', { size: 'sm' }),
    on: {
      click: (e) => {
        e.stopPropagation();
        target.value = '';
        sync();
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.focus();
      },
    },
  });
  function sync() {
    const empty = !target.value;
    btn.classList.toggle('is-hidden', empty);
    btn.setAttribute('aria-hidden', String(empty));
    btn.tabIndex = empty ? -1 : 0;
  }
  target.addEventListener('input', sync);
  sync();
  if (before && before.parentNode) before.parentNode.insertBefore(btn, before);
  else if (target.parentNode) target.parentNode.insertBefore(btn, target.nextSibling);
  return btn;
}

export function createSearch({ store, onPick, onDockedChange = null }) {
  let scrim = null;
  let input = null;
  let listEl = null;
  let panelEl = null;
  let filterPanel = null;
  let filterBtn = null;
  let filters = null;
  let index = []; // snapshot of searchable entries, built on open
  let results = [];
  let activeIndex = -1;
  let lastFocused = null;
  // 0.2.3：顶部常驻搜索条（docked）。input 由 header 提供，结果面板挂在 body 上
  // 定位到输入框正下方；移动端仍用原来的全屏 overlay（open()）。
  let docked = false;
  let dockedInput = null;
  let dockedPanel = null;
  // 0.6.6（§三）：常驻条模式的遮罩（与全屏搜索的 scrim 分开，层级不同）。
  let dockedScrim = null;
  let filterHost = null; // 0.2.4：桌面常驻条里放「筛选」按钮的容器（由 header 提供）
  let filterHostInput = null; // 同一 header 的输入框：搜索未展开时点筛选先展开它
  let debounceTimer = null;
  let outsideHandler = null;
  let repositionHandler = null;
  // 0.7.1（用户）：标签筛选收起态的宽度测量——观察 trigger，面板重建/关闭时断开。
  let tagTriggerObserver = null;

  function isOpen() {
    return Boolean(scrim) || docked;
  }

  /** 筛选状态（B6）：日历多选、颜色多选、时间范围。
   *  0.2.10（1-10）：不再有「含任务」开关——任务是否出现只由「我的任务」日历
   *  是否被勾选决定（任务日历本身就是日历多选里的一项）。 */
  function defaultFilters() {
    const cals = typeof store.getCalendars === 'function' ? store.getCalendars() : [];
    const visible = cals
      .filter((cal) => (typeof store.isCalendarVisible === 'function' ? store.isCalendarVisible(cal.id) : cal.visible !== false))
      .map((cal) => cal.id);
    return {
      calendars: new Set(visible),
      colors: null, // null = 全部颜色
      // 0.7.0（用户）：标签多选，多值取并集，与其它条件取交集；空集 = 全部。
      tags: new Set(),
      // 0.7.5（用户「筛选标签下拉多一个选择无标签」）：只筛没挂任何标签的项，
      // 与具体标签互斥。
      noTag: false,
      from: '',
      to: '',
    };
  }

  function filtersActive() {
    if (!filters) return false;
    const all = typeof store.getCalendars === 'function' ? store.getCalendars() : [];
    const visible = all.filter((cal) =>
      typeof store.isCalendarVisible === 'function' ? store.isCalendarVisible(cal.id) : cal.visible !== false,
    );
    if (filters.colors) return true;
    if (filters.tags && filters.tags.size) return true;
    // 0.7.5：单独选「无标签」也是一条生效的筛选。
    if (filters.noTag) return true;
    if (filters.from || filters.to) return true;
    return filters.calendars.size !== visible.length;
  }

  function itemCalendar(item) {
    return item && item.calendarId ? item.calendarId : 'default';
  }

  /** 0.2.1（#13）：筛选按**实际显示色**匹配。
   *  显示色可能是调色板 key（`pink`）也可能是后端下发的 `#RRGGBB`（日历色），
   *  统一归一到调色板 key 再比较，否则「选了颜色却匹配不上」。
   *  手动色（`colorOverride`）优先；继承日历色时事件自身色与日历色都算命中。 */
  function paletteKey(color) {
    if (!color) return '';
    if (isValidColor(color)) return color;
    return colorKeyOfHex(color);
  }

  function effectiveColorKeys(item) {
    if (!item) return [];
    if (item.colorOverride) {
      const own = paletteKey(item.color);
      return own ? [own] : [];
    }
    const keys = new Set();
    const own = paletteKey(item.color);
    if (own) keys.add(own);
    const cal = typeof store.getCalendar === 'function' ? store.getCalendar(itemCalendar(item)) : null;
    const fromCal = paletteKey(cal && cal.color);
    if (fromCal) keys.add(fromCal);
    return [...keys];
  }

  /** 组合规则：关键词 AND、不同筛选 AND、同组多值 OR。 */
  function passesFilters(entry) {
    if (!filters) return true;
    const item = entry.event;
    // 0.2.10（1-10）：任务不再有独立开关，只有「我的任务」日历被勾选才出现
    // （任务的 itemCalendar() 就是 tasks，走下面的日历多选判断）。
    if (filters.calendars.size && !filters.calendars.has(itemCalendar(item))) return false;
    // 0.7.0：标签多选取并集——命中任一已选标签即可；与其它条件仍是 AND。
    if (filters.tags && filters.tags.size) {
      const tag = tagForRecord(item);
      if (!tag || !filters.tags.has(tag.id)) return false;
    }
    // 0.7.5（用户「筛选标签下拉多一个选择无标签」）：解析不到标签（含旧分类
    // 名称能对上标签的情况）才算「无标签」，带标签的旧事件不会被误算进来。
    if (filters.noTag && tagForRecord(item)) return false;
    if (filters.colors && !effectiveColorKeys(item).some((key) => filters.colors.has(key))) return false;
    if (filters.from) {
      if (startOfDay(new Date(entry.rep.start)).getTime() < startOfDay(new Date(`${filters.from}T00:00:00`)).getTime()) {
        return false;
      }
    }
    if (filters.to) {
      if (startOfDay(new Date(entry.rep.start)).getTime() > startOfDay(new Date(`${filters.to}T00:00:00`)).getTime()) {
        return false;
      }
    }
    return true;
  }

  /** The occurrence a recurring series should represent in results: the current
   *  or next occurrence (the earliest-starting one in the forward window, so an
   *  in-progress occurrence wins), else the most recent past one, else — for a
   *  series with no occurrence in the ±window — the nearest occurrence to now.
   *  `fwd`/`back` are this series' occurrences in the forward/backward window.
   *  We pick by start rather than array position: getEventsInRange sorts all-day
   *  events first GLOBALLY, so a per-occurrence all-day override would otherwise
   *  pull a distant occurrence to fwd[0]/back[last] and mis-date the series. */
  function representative(ev, fwd, back, now) {
    if (!ev.recurrence) return ev;
    if (fwd && fwd.length) return fwd.reduce((a, b) => (b.start < a.start ? b : a));
    if (back && back.length) return back.reduce((a, b) => (b.start > a.start ? b : a));
    // No occurrence within the ±window (e.g. a count/until series that ended
    // long ago, one starting far in the future, or a long-interval series like
    // every-4-years whose neighbours straddle the window). Resolve the nearest
    // occurrence rather than the series' FIRST one, so it is dated and bucketed
    // by its real closest occurrence. Materializing (vs. the raw master) also
    // keeps a seriesId, so picking it still routes through the recurring-edit
    // scope dialog instead of the plain-event editor.
    return occurrenceNear(ev, now) || ev;
  }

  /** Bucket expanded occurrences by their series id, preserving order. */
  function groupBySeries(occurrences) {
    const map = new Map();
    for (const o of occurrences) {
      if (!o.seriesId) continue;
      let arr = map.get(o.seriesId);
      if (!arr) map.set(o.seriesId, (arr = []));
      arr.push(o);
    }
    return map;
  }

  function buildIndex() {
    // Expand each window ONCE and bucket occurrences by series, so resolving a
    // representative is a map lookup per event. Previously representative()
    // re-expanded the whole 400-day range (twice) for every recurring master —
    // O(recurring² × window) — which could freeze the palette on open for a
    // calendar with many recurring series. Equivalent result: same
    // getEventsInRange calls, same per-series order, same first/last selection.
    const now = Date.now();
    const win = OCC_WINDOW_DAYS * MS_PER_DAY;
    const fwd = groupBySeries(store.getEventsInRange(now, now + win, { includeHidden: true }));
    const back = groupBySeries(store.getEventsInRange(now - win, now, { includeHidden: true }));
    index = store.getAllEvents().map((ev) => ({
      event: ev,
      rep: representative(ev, fwd.get(ev.id), back.get(ev.id), now),
      title: ev.title || '',
      hay: `${ev.title || ''}\n${ev.location || ''}\n${ev.description || ''}`.toLowerCase(),
    }));
    // A "this event" edit can retitle / relocate / re-describe a single
    // occurrence. The calendar renders that override text, so search must find
    // it too — the master's entry above only carries the series' own text. Add
    // one entry per occurrence whose override changes searchable text, dated at
    // that exact occurrence (no repeat badge: it is a one-off exception).
    for (const ev of store.getAllEvents()) {
      if (!ev.recurrence) continue;
      const exdates = new Set((ev.exdates || []).map(Number));
      for (const [rid, o] of Object.entries(ev.overrides || {})) {
        if (!o) continue;
        // Imported/foreign data can carry an override AND an exdate for the
        // same slot; the calendar never renders it (expandOccurrences skips
        // exdates), so search must not surface a phantom the user could
        // "edit" — updateOccurrence would strip the exdate and resurrect a
        // cancelled occurrence.
        if (exdates.has(Number(rid))) continue;
        const textChanged = ['title', 'location', 'description'].some(
          (k) => o[k] != null && o[k] !== ev[k],
        );
        if (!textChanged) continue;
        const occ = store.getEvent(`${ev.id}::${rid}`);
        if (!occ) continue;
        index.push({
          event: occ,
          rep: occ,
          title: occ.title || '',
          hay: `${occ.title || ''}\n${occ.location || ''}\n${occ.description || ''}`.toLowerCase(),
        });
      }
    }
    // Tasks live in their own store map, so they never came through
    // getAllEvents — a task was visible on the calendar but "No events match"
    // in search. Index each one by title + notes. A task has a single `due`
    // instant rather than start/end; the row builder and the ranking sort
    // read `start`/`end` off `rep`, so give it both (a zero-length span) and
    // keep the task itself as `event` so picking it opens the task card.
    for (const t of store.getAllTasks()) {
      index.push({
        event: t,
        rep: { ...t, start: t.due, end: t.due },
        title: t.title || '',
        hay: `${t.title || ''}\n${t.notes || ''}`.toLowerCase(),
      });
    }
  }

  function open() {
    if (scrim) {
      input.focus();
      input.select();
      return;
    }
    lastFocused = document.activeElement;
    buildIndex();
    filters = defaultFilters();
    build();
    document.body.append(scrim);
    document.addEventListener('keydown', onKeydown, true);
    // Guard against the overlay being closed before this frame fires (close()
    // nulls `input`), which would otherwise throw on the deferred focus.
    requestAnimationFrame(() => input && input.focus());
    runQuery('');
  }

  function close() {
    if (!scrim) return;
    if (tagTriggerObserver) {
      tagTriggerObserver.disconnect();
      tagTriggerObserver = null;
    }
    document.removeEventListener('keydown', onKeydown, true);
    scrim.remove();
    scrim = null;
    const btn = filterBtn;
    input = null;
    listEl = null;
    filterPanel = null;
    filterBtn = null;
    filters = null;
    index = [];
    results = [];
    activeIndex = -1;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
    // 0.2.4：全屏搜索关闭后，把「筛选」按钮放回桌面常驻条。
    if (btn && filterHost) filterHost.append(btn);
    // 0.2.9：全屏搜索是从 header 图标打开的，关闭后 header 不该处于「搜索激活」态。
    setHostActive(false);
  }

  /** 0.2.4（真机 P0-3）：桌面常驻搜索条的「筛选」按钮挂载点（header 传入）。 */
  function setFilterHost(host, inputEl = null) {
    filterHost = host || null;
    filterHostInput = inputEl || null;
    ensureFilterControls();
    attachFilterButton();
  }

  /** 0.2.9：筛选按钮只在搜索激活（常驻条展开 / 全屏搜索打开）时显示。 */
  function setHostActive(active) {
    const bar = filterHost && filterHost.closest ? filterHost.closest('.header__search') : null;
    if (bar) bar.classList.toggle('is-search-active', Boolean(active));
  }

  function attachFilterButton() {
    if (!filterBtn || !filterHost) return;
    // 0.2.9（用户）：单实例——任何历史遗留的同名按钮都清掉，只保留这一个，
    // 避免「每点一次筛选就多一个按钮」。
    document.querySelectorAll('.search__filter-btn').forEach((node) => {
      if (node !== filterBtn) node.remove();
    });
    if (filterBtn.parentNode !== filterHost) filterHost.append(filterBtn);
  }

  /* ---- 0.2.3：顶部常驻搜索条（docked） --------------------------------- */

  /** 结果面板定位。0.2.18（C5）：面板宽度**不再与搜索槽位耦合**——桌面按
   *  lib/segment.js 的 `SEARCH_PANEL_PX`（600）开，视口不足时收到 `innerWidth - 16`；
   *  窄屏（≤720）沿用 0.2.15 的原路径（面板 = 窄屏槽位宽，视口不够时同样收边）。
   *  左界仍按条的**右缘**反推（`rect.right - width`）——右缘对齐锚点这条口径不变，
   *  所以面板变宽时向左张开。 */
  function positionDockedPanel() {
    if (!dockedPanel || !dockedInput) return;
    const bar = dockedInput.closest ? dockedInput.closest('.header__search') : null;
    const anchor = bar || dockedInput;
    const rect = anchor.getBoundingClientRect();
    const narrow = Boolean(
      typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches,
    );
    const width = Math.max(searchPanelWidth({ narrow, viewportWidth: window.innerWidth }), 1);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = rect.bottom + 6;
    dockedPanel.style.left = `${left}px`;
    dockedPanel.style.top = `${top}px`;
    dockedPanel.style.width = `${width}px`;
    // 0.2.10（1-11）：面板高度按可用视口算，底边与窗口底边留 16px；
    // 软键盘导致视口变小时同步收缩，面板不会被顶出屏幕。
    const viewport = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    dockedPanel.style.maxHeight = `${Math.max(180, Math.round(viewport - top - 16))}px`;
  }

  function closeDocked() {
    if (!docked) return;
    docked = false;
    document.removeEventListener('keydown', onKeydown, true);
    if (outsideHandler) document.removeEventListener('pointerdown', outsideHandler, true);
    if (repositionHandler) window.removeEventListener('resize', repositionHandler);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    outsideHandler = null;
    repositionHandler = null;
    if (dockedPanel) dockedPanel.remove();
    dockedPanel = null;
    if (dockedScrim) dockedScrim.remove();
    dockedScrim = null;
    const btn = filterBtn;
    if (dockedInput) {
      dockedInput.removeEventListener('input', onDockedInput);
      dockedInput.setAttribute('aria-expanded', 'false');
      dockedInput.removeAttribute('aria-activedescendant');
    }
    dockedInput = null;
    input = null;
    listEl = null;
    filterPanel = null;
    filterBtn = null;
    filters = null;
    index = [];
    results = [];
    activeIndex = -1;
    // 0.2.4：常驻条收起后，筛选按钮回到 header（下次聚焦搜索条时仍可用）；
    // 0.2.9：同时收起「搜索激活」态，按钮随输入框一起隐藏。
    if (btn && filterHost) filterHost.append(btn);
    setHostActive(false);
    // 0.2.19（D8）：通知 header 把输入框一并收回胶囊——三者只有一个展开状态源。
    if (onDockedChange) onDockedChange(false);
  }

  /** 打开/聚焦顶部常驻搜索条。inputEl 由 header 提供，模块只负责面板与查询。 */
  function openDocked(inputEl) {
    if (docked && dockedInput === inputEl) {
      inputEl.focus();
      runQuery(inputEl.value);
      return;
    }
    if (docked) closeDocked();
    if (scrim) close();
    docked = true;
    dockedInput = inputEl;
    input = inputEl;
    lastFocused = document.activeElement;
    buildIndex();
    filters = defaultFilters();
    ensureFilterControls();
    attachFilterButton();
    setHostActive(true);
    listEl = el('div', {
      class: 'search__results',
      id: 'search-results',
      role: 'listbox',
      'aria-label': t('search.results'),
    });
    dockedPanel = el('div', {
      class: 'search__panel search__panel--docked',
      role: 'dialog',
      'aria-label': t('search.aria'),
    }, [filterPanel, listEl]);
    // 0.6.6（§三）：先铺遮罩再挂面板。遮罩只压暗页面内容（z 低于顶栏与面板），
    // 点它 = 收起（与点外部同一条路径）。
    dockedScrim = el('div', {
      class: 'search-scrim search-scrim--docked',
      'aria-hidden': 'true',
    });
    dockedScrim.addEventListener('click', () => closeDocked());
    document.body.append(dockedScrim, dockedPanel);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'search-results');
    input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', onDockedInput);
    document.addEventListener('keydown', onKeydown, true);
    outsideHandler = (e) => {
      if (dockedPanel && dockedPanel.contains(e.target)) return;
      // 0.2.4：点 header 里的「筛选」按钮不算「点外面」（否则面板刚开就被关）。
      if (e.target === dockedInput) return;
      if (filterBtn && (e.target === filterBtn || filterBtn.contains(e.target))) return;
      // 0.2.39（M1）：日期弹层挂在 body 下、不在 dockedPanel 里。点日历格子或翻月
      // 若被当成「点外面」，搜索条会连筛选一起收起——用户 m00633「筛选-选择日期
      // 点击直接缩回去了」。弹层自己有单例与 outside 监听，这里放行即可。
      if (isInsideDatePopover(e.target)) return;
      closeDocked();
    };
    document.addEventListener('pointerdown', outsideHandler, true);
    repositionHandler = positionDockedPanel;
    window.addEventListener('resize', repositionHandler);
    positionDockedPanel();
    runQuery('');
    input.focus();
    // 0.2.19（D8）：常驻条打开 = 唯一展开态，header 的输入框随之展开。
    if (onDockedChange) onDockedChange(true);
  }

  /** 输入即搜：120ms 防抖（避免每击键重建长列表；3000 事件单次扫描本身 <10ms）。 */
  function onDockedInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    const value = input.value;
    if (!value.trim()) {
      runQuery('');
      return;
    }
    clear(listEl);
    listEl.append(el('div', { class: 'search__empty', role: 'status', text: t('search.state.searching') }));
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (docked && input) runQuery(input.value);
    }, 120);
  }

  function onDockedInputDetach() {
    if (dockedInput) dockedInput.removeEventListener('input', onDockedInput);
  }

  /** 筛选按钮 + 筛选面板（overlay 与常驻条共用一套控件）。 */
  function ensureFilterControls() {
    if (filterBtn) return;
    // 0.2.9（用户）：**单实例**——重建前先清掉历史遗留的按钮/面板节点，
    // 避免重复点击/重渲染后 DOM 里堆出多个「筛选」按钮。
    document.querySelectorAll('.search__filter-btn').forEach((node) => node.remove());
    document.querySelectorAll('#search-filters').forEach((node) => node.remove());
    // B6：搜索条右侧「筛选」纯文字按钮（icons.js 无漏斗图标，规范 §42）；
    // 生效时右上角 6px accent 圆点。
    filterBtn = el('button', {
      class: 'btn btn--ghost search__filter-btn',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': 'search-filters',
      on: {
        click: () => {
          // 搜索条收起时按钮仍在 header：先展开搜索条再显示筛选，避免点到空按钮。
          if (!filterPanel) {
            if (!filterHostInput) return;
            openDocked(filterHostInput);
            if (dockedInput) dockedInput.focus();
          }
          if (!filterPanel) return;
          const open = filterPanel.hidden;
          filterPanel.hidden = !open;
          filterBtn.setAttribute('aria-expanded', String(open));
          filterBtn.classList.toggle('is-open', open);
          if (open) renderFilterPanel();
        },
      },
    }, [
      el('span', { text: t('search.filter') }),
      el('span', { class: 'search__filter-dot', 'aria-hidden': 'true' }),
    ]);
    filterPanel = el('div', {
      class: 'search__filters',
      id: 'search-filters',
      hidden: true,
    });
  }

  /**
   * 0.2.36（M1）：时间范围的一个日期字段。
   *
   * 用户原话：「这里应该写年/月/日」——原来直接放 `<input type="date">`，空态占位符
   * 由浏览器按自己的 locale 渲染，在用户机器上是「yyyy/mm/日」（年、月是英文占位符、
   * 日却是中文），既不是中文也不是英文；原生占位符在 shadow DOM 里，改不了文案。
   *
   * 所以改成与编辑器日期字段同一套（0.2.19 D3）：可见按钮 + 弹层日历 +
   * 视觉隐藏的 `<input type="date">` 存公历真值。空态永远显示我们自己的
   * 「年/月/日」；`type=date` 的 input 仍留在 DOM 里，筛选、清除筛选与既有测试都不受影响。
   */
  function buildDateField(kind, labelKey) {
    const native = el('input', {
      class: 'search__date-native',
      type: 'date',
      'aria-label': t(labelKey),
      tabindex: '-1',
      value: filters[kind] || '',
      on: {
        change: (e) => {
          filters[kind] = e.target.value;
          renderFilterPanel();
          runQuery(input.value);
        },
      },
    });
    const text = el('span', { class: 'search__date-text' });
    const trigger = el('button', {
      class: 'search__date-btn',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-label': t(labelKey),
      on: {
        click: () =>
          openDatePopover({
            anchor: trigger,
            value: native.value,
            lunar: false,
            // 时间范围没有农历概念：不给「公历 | 农历」两段式。
            showModeToggle: false,
            weekStartsOn: (store.getSettings() || {}).weekStartsOn,
            onPick: (next) => {
              if (next === native.value) return;
              native.value = next;
              native.dispatchEvent(new Event('change', { bubbles: true }));
            },
          }),
      },
    }, [
      text,
      el('span', { class: 'search__date-icon', html: icon('calendar', { size: 'sm' }), 'aria-hidden': 'true' }),
    ]);
    text.textContent = native.value || t('search.filter.datePlaceholder');
    text.classList.toggle('is-empty', !native.value);
    return el('span', { class: 'search__date-field' }, [trigger, native]);
  }

  function build() {
    input = el('input', {
      class: 'search__input',
      type: 'text',
      placeholder: t('search.placeholder'),
      autocomplete: 'off',
      autocapitalize: 'off',
      'aria-label': t('search.aria'),
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'search-results',
      'aria-autocomplete': 'list',
      on: { input: () => runQuery(input.value) },
    });
    // Set imperatively: the `el` helper skips any prop whose value is `false`,
    // and spellcheck defaults to on for text fields, so passing `spellcheck:
    // false` through `el` would be silently dropped and leave it enabled.
    input.spellcheck = false;
    listEl = el('div', {
      class: 'search__results',
      id: 'search-results',
      role: 'listbox',
      'aria-label': t('search.results'),
    });

    ensureFilterControls();
    // 0.2.10（1-12）：输入框右侧、「筛选」按钮左侧的清空小叉（窄屏全屏搜索）。
    const mobileClearBtn = attachSearchClear(input);

    const panel = el(
      'div',
      { class: 'search__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('search.aria') },
      [
        el('div', { class: 'search__bar' }, [
          el('span', { class: 'search__icon', html: icon('search', { size: 'sm' }) }),
          input,
          mobileClearBtn,
          filterBtn,
          el('kbd', { class: 'search__esc', text: 'Esc' }),
          // 0.2.3：窄屏全屏搜索给一个明确的关闭按钮（Esc 在手机上不可用）。
          el('button', {
            class: 'icon-btn search__close',
            type: 'button',
            'aria-label': t('common.close'),
            html: icon('close', { size: 'sm' }),
            on: { click: () => close() },
          }),
        ]),
        filterPanel,
        listEl,
      ],
    );

    scrim = el('div', { class: 'search-scrim' }, [panel]);
    closeOnBackdrop(scrim, close);
  }

  /** 渲染筛选区：日历 chip 多选、颜色 swatch 多选、时间范围、含任务开关。 */
  function renderFilterPanel() {
    if (!filterPanel) return;
    if (tagTriggerObserver) {
      tagTriggerObserver.disconnect();
      tagTriggerObserver = null;
    }
    clear(filterPanel);
    filterBtn.classList.toggle('has-filter', filtersActive());
    const calendars = typeof store.getCalendars === 'function' ? store.getCalendars() : [];
    const visible = calendars.filter((cal) =>
      typeof store.isCalendarVisible === 'function' ? store.isCalendarVisible(cal.id) : cal.visible !== false,
    );

    const calRow = el('div', { class: 'search__filter-row', role: 'group', 'aria-label': t('search.filter.calendars') }, [
      el('span', { class: 'search__filter-label', text: t('search.filter.calendars') }),
      el('div', { class: 'search__filter-chips' },
        visible.map((cal) => {
          const on = filters.calendars.has(cal.id);
          const chip = el('button', {
            class: 'btn btn--ghost search__chip',
            type: 'button',
            'aria-pressed': String(on),
            on: {
              click: () => {
                if (filters.calendars.has(cal.id)) filters.calendars.delete(cal.id);
                else filters.calendars.add(cal.id);
                renderFilterPanel();
                runQuery(input.value);
              },
            },
          }, [
            el('span', { class: 'chip__dot', style: { background: colorHex(cal.color) } }),
            el('span', { text: cal.displayName }),
          ]);
          chip.dataset.calendarId = cal.id;
          return chip;
        }),
      ),
    ]);

    const colorRow = el('div', { class: 'search__filter-row', role: 'group', 'aria-label': t('search.filter.colors') }, [
      el('span', { class: 'search__filter-label', text: t('search.filter.colors') }),
      el('div', { class: 'search__filter-swatches' },
        EVENT_COLORS.map((color) => {
          const on = filters.colors ? filters.colors.has(color.key) : true;
          return el('button', {
            class: 'swatch search__swatch',
            type: 'button',
            'aria-pressed': String(on),
            'aria-label': t(`color.${color.key}`),
            title: t(`color.${color.key}`),
            style: { background: color.hex, '--swatch-color': color.hex, opacity: on ? '' : '.35' },
            on: {
              click: () => {
                // 0.2.1（#13）：第一次点颜色 = 「只看这个颜色」（结果收窄），
                // 再点其它颜色 = 叠加；把已选颜色取消到空 = 回到「全部」。
                if (!filters.colors) {
                  filters.colors = new Set([color.key]);
                } else if (filters.colors.has(color.key)) {
                  filters.colors.delete(color.key);
                  if (!filters.colors.size) filters.colors = null;
                } else {
                  filters.colors.add(color.key);
                  if (filters.colors.size === EVENT_COLORS.length) filters.colors = null;
                }
                renderFilterPanel();
                runQuery(input.value);
              },
            },
          });
        }),
      ),
    ]);

    const dateRow = el('div', { class: 'search__filter-row' }, [
      el('span', { class: 'search__filter-label', text: t('search.filter.range') }),
      el('div', { class: 'search__filter-dates' }, [
        buildDateField('from', 'search.filter.from'),
        el('span', { class: 'search__filter-dash', text: '–' }),
        buildDateField('to', 'search.filter.to'),
      ]),
    ]);

    const clearBtn = el('button', {
      class: 'btn btn--ghost search__filter-clear',
      type: 'button',
      text: t('search.filter.clear'),
      on: {
        click: () => {
          filters = defaultFilters();
          renderFilterPanel();
          runQuery(input.value);
        },
      },
    });

    /**
     * 0.7.1（用户）：收起态**先显示 emoji**，宽度放不下才省略成「N 个标签」。
     * 判据是实测宽度（测量层 scrollWidth 与 trigger 可用宽），不是条数。
     */
    function tagGroupsForFilter() {
      // 0.7.4（用户「未分组0个的时候隐藏」）：下拉只列至少有一个标签的分组；
      // 空分组只在标签管理页保留（新分组要能改名/删除/拖入）。
      if (store && typeof store.getTagsForDisplay === 'function') {
        return store.getTagsForDisplay()
          .filter((section) => section.tags.length)
          .map((section, index) => ({ ...section.group, order: index }));
      }
      const tags = typeof store?.getTags === 'function' ? store.getTags() : [];
      const known = new Set(tags.map((tag) => tag.groupId || DEFAULT_TAG_GROUP_ID));
      let list = typeof store?.getTagGroups === 'function' ? store.getTagGroups().slice() : [];
      list = list.filter((group) => known.has(group.id));
      if (!list.length && known.has(DEFAULT_TAG_GROUP_ID)) {
        list = [{ id: DEFAULT_TAG_GROUP_ID, name: t('settings.tags.groupDefault'), order: 0 }];
      }
      if (known.has(DEFAULT_TAG_GROUP_ID) && !list.some((group) => group.id === DEFAULT_TAG_GROUP_ID)) {
        list.unshift({ id: DEFAULT_TAG_GROUP_ID, name: t('settings.tags.groupDefault'), order: -1 });
      }
      return list
        .map((group, index) => ({ ...group, order: Number.isFinite(group.order) ? group.order : index }))
        .sort((a, b) => {
          if (a.id === DEFAULT_TAG_GROUP_ID) return -1;
          if (b.id === DEFAULT_TAG_GROUP_ID) return 1;
          return a.order - b.order;
        });
    }

    function tagTriggerParts() {
      // 0.7.4（N）：收起/展开的 emoji 串也用显示顺序，与下拉一致。
      const tags = store && typeof store.getTagsForDisplay === 'function'
        ? store.getTagsForDisplay().flatMap((section) => section.tags)
        : (typeof store.getTags === 'function' ? store.getTags() : []);
      const selected = tags.filter((tag) => filters.tags.has(tag.id));
      const emojis = selected
        .map((tag) => tag.emoji || [...(tag.name || '')][0] || '')
        .filter(Boolean)
        .join(' ');
      return { selected, emojis, count: selected.length };
    }

    /** 完整列表给 aria-label / title，收起成数量时也不丢名字。 */
    function applyTagTriggerFit(trigger, measure, labelEl) {
      // 0.7.5：选中「无标签」时直接显示这四个字（不带 emoji），不过宽度判定。
      if (filters && filters.noTag) {
        labelEl.textContent = t('tags.none');
        trigger.classList.remove('is-compact');
        trigger.title = t('tags.none');
        trigger.setAttribute('aria-label', `${t('tags.filterAria')}：${t('tags.none')}`);
        return;
      }
      const { selected, emojis, count } = tagTriggerParts();
      if (!count) {
        labelEl.textContent = t('tags.filter');
        trigger.classList.remove('is-compact');
        trigger.setAttribute('aria-label', t('search.filter.tags'));
        trigger.removeAttribute('title');
        return;
      }
      const aria = t('tags.filterSelected', { names: selected.map((tag) => tag.name).join('、') });
      trigger.setAttribute('aria-label', aria);
      trigger.setAttribute('title', aria);
      measure.textContent = emojis;
      let padding = 0;
      try {
        const computed = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(trigger) : null;
        if (computed) padding = (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.paddingRight) || 0);
      } catch {
        padding = 0;
      }
      const available = Math.max(0, (trigger.clientWidth || 0) - padding);
      const needed = measure.scrollWidth || measure.offsetWidth || 0;
      // 0.7.4（用户）：面板隐藏时 clientWidth 为 0，先按「放不下」收起成数量；
      // 面板展开或框变宽后由 ResizeObserver / rAF 重算，放得下再回到 emoji。
      const fits = available > 0 && (needed <= 0 || needed <= available);
      if (fits) {
        labelEl.textContent = emojis || t('tags.selectedCount', { count });
        trigger.classList.remove('is-compact');
      } else {
        labelEl.textContent = t('tags.selectedCount', { count });
        trigger.classList.add('is-compact');
      }
    }

    function buildTagFilterRow() {
      const tags = store && typeof store.getTagsForDisplay === 'function'
        ? store.getTagsForDisplay().flatMap((section) => section.tags)
        : (typeof store.getTags === 'function' ? store.getTags() : []);
      const groups = tagGroupsForFilter();
      const known = new Set(groups.map((group) => group.id));

      // 0.7.5：所有条目（含「无标签」）的选中态与触发器文案由这里统一刷新，
      // 避免两套代码各自改 aria-selected。
      const syncOptions = () => {
        for (const opt of menu.querySelectorAll('.search__tag-option')) {
          const id = opt.dataset.tagId || '';
          const on = id ? filters.tags.has(id) : filters.noTag;
          opt.setAttribute('aria-selected', String(on));
          const box = opt.querySelector('.search__tag-check');
          if (box) box.innerHTML = icon(on ? 'check' : 'plus', { size: 'sm' });
        }
        trigger.classList.toggle('has-filter', filters.tags.size > 0 || filters.noTag);
        trigger.classList.remove('is-compact');
        filterBtn.classList.toggle('has-filter', filtersActive());
        applyTagTriggerFit(trigger, measure, labelEl);
        runQuery(input.value);
      };

      const optionFor = (tag) => {
        const on = filters.tags.has(tag.id);
        const option = el('button', {
          class: 'search__tag-option',
          type: 'button',
          role: 'option',
          'aria-selected': String(on),
          dataset: { tagId: tag.id },
          on: {
            click: () => {
              // 0.7.5：点具体标签时自动取消「无标签」，两者互斥。
              filters.noTag = false;
              if (filters.tags.has(tag.id)) filters.tags.delete(tag.id);
              else filters.tags.add(tag.id);
              syncOptions();
            },
          },
        }, [
          el('span', { class: 'search__tag-check', html: icon(on ? 'check' : 'plus', { size: 'sm' }) }),
          el('span', { class: 'search__tag-option-name', text: tagDisplayName(tag) }),
        ]);
        return option;
      };

      const menuChildren = [];
      // 0.7.5（用户「筛选标签下拉多一个选择无标签」）：最上面一项，位于所有
      // 分组标题之前，与分组之间一条分隔线；点它清空已选标签，反之亦然。
      const noTagOn = Boolean(filters.noTag);
      const noTagOption = el('button', {
        class: 'search__tag-option search__tag-option--notag',
        type: 'button',
        role: 'option',
        'aria-selected': String(noTagOn),
        dataset: { tagId: '' },
        on: {
          click: () => {
            filters.noTag = !filters.noTag;
            if (filters.noTag) filters.tags.clear();
            syncOptions();
          },
        },
      }, [
        el('span', { class: 'search__tag-check', html: icon(noTagOn ? 'check' : 'plus', { size: 'sm' }) }),
        el('span', { class: 'search__tag-option-name', text: t('tags.none') }),
      ]);
      menuChildren.push(noTagOption);
      if (tags.length) menuChildren.push(el('div', { class: 'search__tag-sep', role: 'presentation' }));
      if (tags.length) {
        // 0.7.1：标签下拉按分组分段，组名是小标题、不可点选（并集语义不变）。
        // 0.7.5（用户「下拉菜单的分组也可以折叠」）：标题整行是 button，共用
        // tag-dropdown-collapse 的会话内折叠状态；折叠只藏条目，已选状态不受影响。
        for (const group of groups) {
          const rows = tags.filter((tag) => (known.has(tag.groupId) ? tag.groupId : DEFAULT_TAG_GROUP_ID) === group.id);
          if (!rows.length) continue;
          const groupId = group.id;
          const bodyId = `search-tag-group-${groupId}`;
          const body = el('div', {
            class: 'search__tag-group-body',
            role: 'presentation',
            id: bodyId,
          });
          for (const tag of rows) body.append(optionFor(tag));
          const isCollapsed = isGroupCollapsed(groupId);
          const caret = el('span', {
            class: 'search__tag-group-caret',
            'aria-hidden': 'true',
            text: isCollapsed ? '▸' : '▾',
          });
          const label = el('span', {
            class: 'search__tag-group-name',
            text: `${group.name} ${t('settings.tags.groupCount', { count: rows.length })}`,
          });
          const toggle = el('button', {
            class: 'search__tag-group-toggle',
            type: 'button',
            'aria-expanded': String(!isCollapsed),
            'aria-controls': bodyId,
            on: {
              click: () => {
                const next = toggleGroupCollapsed(groupId);
                body.hidden = next;
                toggle.setAttribute('aria-expanded', String(!next));
                caret.textContent = next ? '▸' : '▾';
              },
            },
          }, [caret, label]);
          body.hidden = isCollapsed;
          menuChildren.push(el('div', { class: 'search__tag-group', role: 'presentation' }, [toggle]), body);
        }
      } else {
        menuChildren.push(el('p', { class: 'search__tag-empty', text: t('settings.tags.empty') }));
      }

      const menu = el('div', {
        class: 'search__tag-menu',
        role: 'listbox',
        'aria-multiselectable': 'true',
        'aria-label': t('search.filter.tags'),
        hidden: true,
      }, menuChildren);

      const labelEl = el('span', { class: 'search__tag-trigger-text' });
      const measure = el('span', {
        class: 'search__tag-trigger-measure',
        'aria-hidden': 'true',
      });
      const trigger = el('button', {
        class: 'btn btn--ghost search__tag-trigger',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'aria-label': t('search.filter.tags'),
      }, [labelEl, measure]);
      trigger.classList.toggle('has-filter', filters.tags.size > 0);
      applyTagTriggerFit(trigger, measure, labelEl);
      // 面板展开或布局刚落地时 clientWidth 才有值；下一帧再量一次，避免首帧误判。
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          if (trigger.isConnected) applyTagTriggerFit(trigger, measure, labelEl);
        });
      }

      // 窗口/容器变宽变窄时重新判定；面板重建或关闭时断开旧观察。
      if (typeof ResizeObserver === 'function') {
        tagTriggerObserver = new ResizeObserver(() => applyTagTriggerFit(trigger, measure, labelEl));
        tagTriggerObserver.observe(trigger);
      }

      /* 0.7.6（用户「下拉菜单默认都是全展开，不用记忆折叠与否」）：每次打开都重置为全展开，
         本次打开期间仍可折叠；关闭即丢弃（不写 localStorage、不同步服务端）。
         菜单只在面板构建时生成一次，所以这里同时把 DOM 的折叠态复位。 */
      const resetGroupCollapse = () => {
        expandAllGroups();
        for (const toggle of menu.querySelectorAll('.search__tag-group-toggle')) {
          toggle.setAttribute('aria-expanded', 'true');
          const caret = toggle.querySelector('.search__tag-group-caret');
          if (caret) caret.textContent = '▾';
        }
        for (const body of menu.querySelectorAll('.search__tag-group-body')) body.hidden = false;
      };

      /* 0.7.6（用户「下拉菜单点击旁边失焦的时候也关闭」）：点菜单与触发器以外的区域关闭。
         pointerdown 捕获（鼠标与触屏都覆盖）；打开时只挂一个监听，关闭即解绑。 */
      function onMenuOutside(event) {
        if (event.target instanceof Node && (menu.contains(event.target) || trigger.contains(event.target))) return;
        closeMenu();
      }

      function closeMenu() {
        if (menu.hidden) return;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onMenuOutside, true);
      }

      trigger.addEventListener('click', () => {
        if (menu.hidden) {
          resetGroupCollapse();
          menu.hidden = false;
          trigger.setAttribute('aria-expanded', 'true');
          document.addEventListener('pointerdown', onMenuOutside, true);
          applyTagTriggerFit(trigger, measure, labelEl);
        } else {
          closeMenu();
        }
      });
      menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
          trigger.focus();
          return;
        }
        // 0.7.5：↑/↓ 在可见条目间移动（含顶部「无标签」），Home/End 到首末，
        // Enter/Space 选中；折叠组里的条目被 [hidden] 排除，不参与遍历。
        const opts = [...menu.querySelectorAll('.search__tag-option')].filter((opt) => !opt.closest('[hidden]'));
        const at = opts.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!opts.length) return;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const from = at < 0 ? (step > 0 ? -1 : 0) : at;
          opts[(from + step + opts.length) % opts.length].focus();
          return;
        }
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          if (opts.length) (e.key === 'Home' ? opts[0] : opts[opts.length - 1]).focus();
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          if (at < 0) return;
          e.preventDefault();
          document.activeElement.click();
        }
      });

      const clearBtn = el('button', {
        class: 'btn btn--ghost search__tag-clear',
        type: 'button',
        text: t('tags.clear'),
        on: {
          click: () => {
            filters.tags.clear();
            // 0.7.5：清除同时清掉「无标签」。
            filters.noTag = false;
            renderFilterPanel();
            runQuery(input.value);
          },
        },
      });
      if (tags.length) menu.append(el('div', { class: 'search__tag-menu-foot' }, [clearBtn]));

      return el('div', { class: 'search__filter-row', role: 'group', 'aria-label': t('search.filter.tags') }, [
        el('span', { class: 'search__filter-label', text: t('search.filter.tags') }),
        el('div', { class: 'search__tag-filter' }, [trigger, menu]),
      ]);
    }

    filterPanel.append(
      calRow,
      buildTagFilterRow(),
      colorRow,
      dateRow,
      el('div', { class: 'search__filter-foot' }, [clearBtn]),
    );
  }

  function matchRank(title, q) {
    const t = title.toLowerCase();
    if (t.startsWith(q)) return 0;
    if (t.includes(q)) return 1;
    return 2; // matched via location/description, or title substring past start
  }

  function runQuery(raw) {
    const q = raw.trim().toLowerCase();
    const now = Date.now();
    const pool = index.filter((x) => (!q || x.hay.includes(q)) && passesFilters(x));

    pool.sort((a, b) => {
      const ra = q ? matchRank(a.title, q) : 0;
      const rb = q ? matchRank(b.title, q) : 0;
      if (ra !== rb) return ra - rb;
      // "Current or upcoming" = hasn't ended yet. Using the end (not the start)
      // keeps an event that is happening right now — e.g. an in-progress
      // recurring occurrence, whose representative starts before `now` — in the
      // upcoming bucket instead of demoting it below every future event.
      const au = a.rep.end > now;
      const bu = b.rep.end > now;
      if (au !== bu) return au ? -1 : 1; // current/upcoming before past
      return au ? a.rep.start - b.rep.start : b.rep.start - a.rep.start;
    });

    results = pool.slice(0, MAX_RESULTS);
    // `q` is lowercased for matching/highlighting; pass the trimmed original-case
    // query for display so the empty-state echoes what the user actually typed.
    renderResults(q, raw.trim());
  }

  function renderResults(q, display = q) {
    clear(listEl);
    // 0.2.3：常驻条在「还没输入」时给一句空态提示（结果列表仍显示全部）。
    if (docked && !q && !filtersActive()) {
      listEl.append(el('div', { class: 'search__empty search__empty--hint', text: t('search.state.hint') }));
    }
    if (results.length === 0) {
      const msg = index.length === 0
        ? t('search.empty.noData')
        : q
          ? t('search.empty.noMatch', { query: display })
          : t('search.empty.none');
      const box = el('div', { class: 'search__empty' }, [el('p', { text: msg })]);
      if (filtersActive()) {
        box.append(
          el('p', { class: 'search__empty-hint', text: t('search.empty.widenFilters') }),
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: t('search.filter.clear'),
            on: {
              click: () => {
                filters = defaultFilters();
                renderFilterPanel();
                runQuery(input.value);
              },
            },
          }),
        );
      }
      listEl.append(box);
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    // 结果计数（B6：「找到 N 个」）。
    if (q || filtersActive()) {
      listEl.append(
        el('div', {
          class: 'search__count',
          role: 'status',
          text: t('search.count', { count: results.length }),
        }),
      );
    }
    const hour12 = store.getSettings().hour12;
    results.forEach((r, i) => listEl.append(buildRow(r, i, q, hour12)));
    setActive(0, false);
  }

  function buildRow(r, i, q, hour12) {
    const ev = r.event;
    const rep = r.rep;
    const start = new Date(rep.start);
    const end = new Date(rep.end);
    const isTask = Boolean(ev.isTask);
    let timeText;
    if (isTask) {
      // Mirror the agenda: an all-day task is a plain "To-do"; a timed one
      // shows its due time (a task has an instant, not a range).
      timeText = rep.allDay ? t('search.result.todo') : formatTime(start, { hour12 });
    } else {
      timeText = rep.allDay ? t('editor.allDay') : formatTimeRange(start, end, { hour12 });
    }
    let meta = ev.recurrence
      ? `${describeRecurrence(ev.recurrence, ev.start)} · ${timeText}`
      : `${formatFullDate(start)} · ${timeText}`;
    if (ev.location) meta += ` · ${ev.location}`;
    if (isTask && ev.done) meta += ` ${t('search.result.done')}`;

    const fallbackTitle = isTask ? t('search.result.untitledTask') : t('search.result.untitled');
    // 0.7.5（用户「搜索里的任务没带emoji」）：条目标题统一走显示层拆分，
    // 标题自带 emoji 就用拆出的那个、没带但有标签则用标签 emoji 兜底；
    // 无标签无 emoji 时与原来一致。事件与任务共用这一处。
    const titleTag = tagForRecord(ev);
    const split = splitTagTitle(titleTag, ev.title || fallbackTitle);
    const titleEl = el('span', { class: 'search__title' });
    if (split.emoji) {
      titleEl.append(
        el('span', { class: 'search__title-emoji', 'aria-hidden': 'true', text: split.emoji }),
        el('span', { class: 'tag-gap' }, [document.createTextNode(' ')]),
      );
    }
    const titleText = el('span', { class: 'search__title-text' });
    titleText.append(highlight(split.label || fallbackTitle, q));
    titleEl.append(titleText);

    // Tasks get the same ring-with-check marker the calendar chips use, so a
    // result reads as a task at a glance (and as done when it is).
    const marker = isTask
      ? el('span', {
          class: `search__check${ev.done ? ' is-checked' : ''}`,
          style: { '--chip-color': colorHex(ev.color), '--ev-fg': colorFg(ev.color) },
          html: ev.done ? icon('check', { size: 'sm' }) : '',
          'aria-hidden': 'true',
        })
      : el('span', { class: 'search__dot', style: { '--chip-color': colorHex(ev.color) } });

    const row = el(
      'div',
      {
        class: `search__result${isTask ? ' search__result--task' : ''}${isTask && ev.done ? ' is-done' : ''}`,
        role: 'option',
        id: `search-opt-${i}`,
        'aria-selected': 'false',
        title: ev.title || fallbackTitle,
      },
      [
        marker,
        el('span', { class: 'search__text' }, [
          titleEl,
          el('span', { class: 'search__meta', text: meta }),
        ]),
        ev.recurrence
          ? el('span', { class: 'search__badge', html: icon('repeat', { size: 'sm' }), title: t('search.badge.repeats') })
          : null,
      ],
    );
    row.addEventListener('click', () => pick(i));
    row.addEventListener('pointermove', () => {
      if (activeIndex !== i) setActive(i, false);
    });
    return row;
  }

  function setActive(i, scroll = true) {
    if (!results.length) return;
    activeIndex = Math.max(0, Math.min(i, results.length - 1));
    const rows = listEl.querySelectorAll('.search__result');
    rows.forEach((row, idx) => {
      const on = idx === activeIndex;
      row.setAttribute('aria-selected', String(on));
      if (on && scroll && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    });
    input.setAttribute('aria-activedescendant', `search-opt-${activeIndex}`);
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    // For a task the rep is a display shim (due mirrored into start/end); hand
    // back the stored task so the card and editor see the real record.
    const target = r.event.isTask ? r.event : r.rep;
    const barInput = docked ? dockedInput : null;
    if (docked) closeDocked();
    else close();
    // 常驻条的查询清空，避免下次聚焦还显示上一次的结果。
    if (barInput) barInput.value = '';
    onPick(target);
  }

  function onKeydown(e) {
    // During IME composition, Enter commits the composed text, Escape cancels
    // the composition, and the arrows navigate the candidate list — none of
    // them are palette commands. Without this guard, committing e.g. Japanese
    // input picked a result and closed the overlay mid-word. (keyCode 229
    // covers engines that don't set isComposing on the final Enter.)
    if (e.isComposing || e.keyCode === 229) return;
    // 0.7.5：标签下拉自己处理键盘（↑/↓/Home/End/Enter/Escape）。全局监听是
    // 捕获阶段，不先放行的话 Enter 会被当成「选中结果」并关掉整个搜索。
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('.search__tag-menu')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (docked) {
        // 常驻条：Esc 关闭面板并清空输入，焦点留在输入框（再按 Esc 退出输入框）。
        if (input) input.value = '';
        closeDocked();
        if (dockedInput) dockedInput.blur();
      } else {
        close();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        pick(activeIndex);
      }
    } else if (e.key === 'Tab') {
      // Overlay 里 input 是唯一可聚焦元素，Tab 被 trap；常驻条不 trap，
      // 让 Tab 正常走「输入框 → 结果/筛选 → 关闭」。
      if (!docked) e.preventDefault();
    }
  }

  return { open, close, isOpen, openDocked, closeDocked, setFilterHost };
}

/** Wrap case-insensitive matches of `q` in the title with <mark>. */
function highlight(title, q) {
  const frag = document.createDocumentFragment();
  if (!q) {
    frag.append(document.createTextNode(title));
    return frag;
  }
  const lower = title.toLowerCase();
  // toLowerCase() can change length (e.g. 'İ' U+0130 → 'i̇', two code units), which
  // desyncs offsets found in `lower` from slices of the original-case `title` —
  // yielding an empty or wrong <mark>. `q` is already matched case-insensitively
  // against `hay` for filtering, so here just emit the title unhighlighted rather
  // than slice the wrong span. Ordinary titles (1:1 lowercasing) are unaffected.
  if (lower.length !== title.length) {
    frag.append(document.createTextNode(title));
    return frag;
  }
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(q, i)) !== -1) {
    if (idx > i) frag.append(document.createTextNode(title.slice(i, idx)));
    frag.append(el('mark', { text: title.slice(idx, idx + q.length) }));
    i = idx + q.length;
  }
  if (i < title.length) frag.append(document.createTextNode(title.slice(i)));
  return frag;
}
