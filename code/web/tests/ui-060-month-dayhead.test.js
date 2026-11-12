/**
 * 0.5.10（S1–S3，用户 2026-11-06 真机反馈）：
 *   S1 ≤520 月视图「农历 + 公历日号同一行」；有节日时不显示农历，只显示去掉「节」
 *      的节日名（无旗子），单行不换行；
 *   S2 事件区（chip / 跨天长条 /「还有 N 个」）顶边不得被农历行拉上去（不给
 *      `.month__events` 加负 margin）；
 *   S3 ≤520 空白格**短按直接新建事件**（0.5.17 用户 2026-11-07：「手机月视图短按
 *      直接弹出新建事件窗口，和其他端操作逻辑上一致」），长按 ≥500ms 且位移 <8px
 *      仍弹两项菜单（新建事件 / 新建任务，没有「新建全天事件」）；一次手势只出一
 *      个结果；桌面点格子与右键不变。
 *
 * 断言取向：S1/S2 看渲染出的 DOM 与 ≤520 CSS 段；S3 用 jsdom 指针事件 + 假计时器
 * 验证短按 / 长按 / 位移超限 / 日号 / 桌面五条路径。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth, holidayDisplayName } from '../src/js/views/month.js';
import { closeContextMenu } from '../src/js/context-menu.js';
import { dayLunarText, dayLunarFullText } from '../src/js/lib/lunar-view.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';
import { startOfDay, endOfDay } from '../src/js/date-utils.js';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const viewsCss = READ('src/styles/views.css');
const monthJs = READ('src/js/views/month.js');
const appJs = READ('src/js/app.js');
const timegridJs = READ('src/js/views/timegrid.js');

/** 取某个 520 媒体块（块内含 marker 的那一段）。 */
function mediaBlock(css, header, marker) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(header, from);
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = css.slice(at, i + 1);
          if (!marker || block.includes(marker)) return block;
          from = i + 1;
          break;
        }
      }
    }
    if (from === 0) return css.slice(at);
  }
}

const storeOf = (events = []) => ({
  getEventsInRange: (from, to) => events.filter((e) => e.start < to && e.end > from),
  getTasksInRange: () => [],
  getEvent: (id) => events.find((e) => e.id === id) || null,
  getSettings: () => ({ hour12: true }),
});

function viewActions(overrides = {}) {
  return {
    gotoDayView: vi.fn(),
    gotoMonthView: vi.fn(),
    createAt: vi.fn(),
    createTask: vi.fn(),
    slotContextMenu: vi.fn(),
    openEvent: vi.fn(),
    openTask: vi.fn(),
    toggleTask: vi.fn(),
    toggleTaskbar: vi.fn(),
    eventContextMenu: vi.fn(),
    taskContextMenu: vi.fn(),
    moveEvent: vi.fn(),
    moveTask: vi.fn(),
    edgePage: vi.fn(),
    showAllCategories: vi.fn(),
    ...overrides,
  };
}

/** jsdom 没有 matchMedia；这里按查询串决定 matches。 */
function stubMatchMedia({ compact }) {
  const saved = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: compact && query === '(max-width: 520px)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  return () => {
    window.matchMedia = saved;
  };
}

const holiday = (title, day) => ({
  id: `holiday-${day}`,
  title,
  start: startOfDay(new Date(2026, 9, day)).getTime(),
  end: endOfDay(new Date(2026, 9, day)).getTime(),
  allDay: true,
  holiday: true,
  readOnly: true,
  color: 'red',
  reminders: [],
});

function render({ events = [], compact = true, settings = {}, actions = viewActions() } = {}) {
  const restore = stubMatchMedia({ compact });
  const { node, afterMount } = renderMonth({
    store: storeOf(events),
    settings: { ...SETTINGS, weekStartsOn: 0, ...settings },
    cursor: new Date(2026, 9, 15),
    now: new Date(2026, 9, 15),
    actions,
  });
  document.body.append(node);
  afterMount();
  return { node, actions, restore, afterMount };
}

const cellAt = (node, day) =>
  node.querySelector(`.month__cell[data-day="${startOfDay(new Date(2026, 9, day)).getTime()}"]`);

const pointer = (type, target, init = {}) => {
  const ev = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(ev);
  return ev;
};

afterEach(() => {
  closeContextMenu();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ S1 */

describe('0.5.10 S1：≤520 农历与日号同一行；节日只留名字', () => {
  it('holidayDisplayName：去掉尾部「节」，但「春节」这类单字节日保留全名', () => {
    // 0.5.10（总监裁决 4）：只有去掉后仍是完整词（≥2 字）才去。
    expect(holidayDisplayName('国庆节')).toBe('国庆');
    expect(holidayDisplayName('清明节')).toBe('清明');
    expect(holidayDisplayName('劳动节')).toBe('劳动');
    expect(holidayDisplayName('端午节')).toBe('端午');
    expect(holidayDisplayName('中秋节')).toBe('中秋');
    expect(holidayDisplayName('春节')).toBe('春节');
    expect(holidayDisplayName('元旦')).toBe('元旦');
    expect(holidayDisplayName('')).toBe('');
  });

  it('DOM：无节日的格子里，农历在日号行内（左），日号仍是最后一个', () => {
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      expect(head).toBeTruthy();
      const lunar = head.querySelector('.month__lunar--inline');
      expect(lunar).toBeTruthy();
      expect(lunar.parentElement).toBe(head);
      const day = startOfDay(new Date(2026, 9, 8)).getTime();
      expect(lunar.querySelector('.month__lunar-text').textContent).toBe(
        dayLunarText(day, { short: true }),
      );
      // 完整农历名留在 title（视觉只有短名）
      expect(lunar.title).toBe(dayLunarFullText(day));
      expect(head.lastElementChild).toBe(head.querySelector('.month__daynum'));
      // 桌面的独立农历行在紧凑档不再创建：格子直接是 dayhead → events
      expect(cell.querySelector(':scope > .month__lunar')).toBeNull();
    } finally {
      restore();
    }
  });

  it('DOM：节日格只显示名字（无旗子、无「节」字），title/aria 仍是全名', () => {
    const { node, restore } = render({ events: [holiday('国庆节', 1)] });
    try {
      const cell = cellAt(node, 1);
      const head = cell.querySelector('.month__dayhead');
      const label = head.querySelector('.month__holiday');
      expect(label).toBeTruthy();
      expect(label.querySelector('.month__holiday-icon')).toBeNull();
      const name = label.querySelector('.month__holiday-name');
      expect(name.textContent).toBe('国庆');
      expect(label.title).toBe('国庆节');
      expect(label.getAttribute('aria-label')).toContain('国庆节');
      // 有节日就不渲染农历（同位置让给节日名）
      expect(head.querySelector('.month__lunar')).toBeNull();
      expect(head.lastElementChild).toBe(head.querySelector('.month__daynum'));
    } finally {
      restore();
    }
  });

  it('农历关闭时不渲染任何农历节点，日号行仍单行', () => {
    const { node, restore } = render({ settings: { lunar: false } });
    try {
      const cell = cellAt(node, 8);
      expect(cell.querySelector('.month__lunar')).toBeNull();
      expect(cell.querySelector('.month__dayhead .month__daynum')).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('CSS：≤520 日号行 nowrap；农历与节日名共用 10px 基准 + --dayhead-scale；承载盒不再参与 flex 收缩', () => {
    const block = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__dayhead');
    expect(block).toMatch(/\.month__dayhead \{[\s\S]*?flex-wrap: nowrap/);
    expect(block).toMatch(/\.month__dayhead \{[\s\S]*?width: 100%/);
    expect(block).toMatch(/\.month__holiday-icon \{[\s\S]*?display: none/);
    // 0.7.8（最终口径 m04435，用户「不用省略，当中还空着，调整一下位置就可以了」）：
    // 节日名保持完整（clip 兜底，不省略）；空间由「今天」胶囊内收 + month.js 负外边距吸收。
    expect(block).toMatch(/\.month__holiday-name \{[\s\S]*?text-overflow: clip/);
    expect(block).toMatch(/\.month__holiday-name \{[\s\S]*?white-space: nowrap/);
    // 0.5.18（W3）口径变更：旧的两套变量（农历 12px×--lunar-scale 0.8、节日 10px×--holiday-scale 1）
    // 让同一格的农历与节日字号对不上（用户：字体不统一）。改为统一 10px 基准 + 同一个 --dayhead-scale，
    // 由 month.js 一格写一个值。旧变量在手机档必须彻底消失，防止两套口径并存再次漂移。
    expect(block).toMatch(
      /\.month__holiday-name \{[\s\S]*?font-size: 10px[\s\S]*?transform: scale\(var\(--dayhead-scale, 1\)\)/
    );
    expect(block).toMatch(
      /\.month__lunar-text \{[\s\S]*?font-size: 10px[\s\S]*?transform: scale\(var\(--dayhead-scale, 1\)\)/
    );
    expect(block).not.toMatch(/--holiday-scale/);
    expect(block).not.toMatch(/--lunar-scale/);
    // 0.5.18（W3）：承载盒宽度由 JS 写成「自然宽 × scale」。
    // 0.7.8（最终口径 m04435）：农历/节日名不省略也不收缩，日号胶囊 flex: none 不压缩；
    // 两个承载盒保持 0 0 auto（不收缩、不放大），间距由「今天」胶囊内收与负外边距吸收。
    expect(block).toMatch(/\.month__holiday \{[\s\S]*?flex: 0 0 auto/);
    expect(block).toMatch(/\.month__lunar--inline \{[\s\S]*?flex: 0 0 auto/);
    expect(block).toMatch(/\.month__lunar-text \{[\s\S]*?white-space: nowrap/);
    // 旧 hack（内层 width:125%）撤掉：缩放比改由 JS 用实测宽度写，自然宽直接可量。
    expect(block).not.toMatch(/\.month__lunar--inline \.month__lunar-text \{[^}]*width: 125%/);
    expect(block).toMatch(/\.month__lunar--inline \.month__lunar-text \{[\s\S]*?flex: 0 0 auto/);
    // 到 0.5 下限才启用的省略模式（title 仍是全名）
    expect(block).toMatch(/\.is-truncated \{[\s\S]*?text-overflow: ellipsis/);
  });

  it('桌面（>520）保持原结构：节日有旗子、全名，农历是日号下方的独立行', () => {
    const { node, restore } = render({ compact: false, events: [holiday('国庆节', 1)] });
    try {
      const holCell = cellAt(node, 1);
      const label = holCell.querySelector('.month__holiday');
      expect(label.querySelector('.month__holiday-icon')).toBeTruthy();
      expect(label.querySelector('.month__holiday-name').textContent).toBe('国庆节');
      const plain = cellAt(node, 8);
      expect(plain.querySelector('.month__dayhead .month__lunar')).toBeNull();
      const lunar = plain.querySelector(':scope > .month__lunar');
      expect(lunar).toBeTruthy();
      expect(lunar.classList.contains('month__lunar--inline')).toBe(false);
    } finally {
      restore();
    }
  });
});

/**
 * jsdom 不做布局：把日号行的实测宽度手动塞进去，再触发 afterMount 的 applyLayout，
 * 验证 month.js 的 fitCompactDayheads 按 `可用宽 / 自然宽` 写 CSS 变量。
 */
function stubHeadGeometry(head, daynum, label, { headW, numW, naturalW }) {
  Object.defineProperty(head, 'clientWidth', { configurable: true, value: headW });
  Object.defineProperty(daynum, 'offsetWidth', { configurable: true, value: numW });
  // 0.5.11：节日名会被减到 1 个汉字，宽度要跟着文字长度变；按初始字数折算每字宽，
  // 再用 getter 返回「当前文字宽」，与真实布局的 scrollWidth 行为一致。
  const chars = Math.max(1, [...(label.textContent || '')].length);
  const charW = naturalW / chars;
  Object.defineProperty(label, 'scrollWidth', {
    configurable: true,
    get: () => charW * [...(label.textContent || '')].length,
  });
}

describe('0.5.10 S1 细则：窄格优先缩字号（不折行、不省略）', () => {
  it('农历：按实测可用宽写 --dayhead-scale，并把「自然宽 × scale」写进承载盒', () => {
    const { node, restore, afterMount } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      const host = head.querySelector('.month__lunar--inline');
      const label = head.querySelector('.month__lunar--inline .month__lunar-text');
      const daynum = head.querySelector('.month__daynum');
      // 45.7 − 14 − 2 = 29.7 可用；扣掉 0.6.7 的 1px 保护边后 28.7，28.7 / 48 = 0.598
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 48 });
      afterMount();
      // 0.5.18（W3）口径变更：scale 写在日号行容器上（一格一个值，农历与节日名共用），
      // 不再写在文字节点上、也不再分 --lunar-scale / --holiday-scale 两套。
      // 0.7.10（用户：「小雪」被裁、「立冬」完整）：逐格算比例时向下取 3 位小数，
      // 28.7 / 48 = 0.59792 → 0.597（不再 toFixed 上舍入成 0.598，否则下一轮会被
      // 重新判成放不下而改走截断）。写进容器的值因此从 0.598 变 0.597。
      expect(head.style.getPropertyValue('--dayhead-scale')).toBe('0.597');
      expect(label.style.getPropertyValue('--dayhead-scale')).toBe('');
      // 0.6.10 起（真机 393 DPR 2.75 裁掉末字）：承载盒按**缩放前**的自然宽给宽，
      // 上限 = 可用宽 ÷ scale；48 自然宽 → min(49, 48+1) = 49，缩放后 29.3，仍 ≤ 可用 29.7。
      expect(host.style.width).toBe('49px');
      expect(Math.abs(parseFloat(host.style.width) * 0.597 - 48 * 0.597)).toBeLessThanOrEqual(2);
      // 更窄的一格必然更小：可用 28.7 / 自然 60 = 0.478 → 触底 0.5，并切到省略模式
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 60 });
      afterMount();
      expect(head.style.getPropertyValue('--dayhead-scale')).toBe('0.500');
      expect(label.classList.contains('is-truncated')).toBe(true);
      // 文字布局宽 = 可用宽 ÷ 0.5，缩放后正好铺满承载盒（28.7/0.5 = 57.4）
      expect(label.style.width).toBe('57.4px');
      // 0.6.10 起：承载盒同按缩放前坐标给宽（可用宽 ÷ 0.5 + 1px），否则盒会先把文字裁一刀。
      expect(host.style.width).toBe('58px');
      expect(parseFloat(host.style.width) * 0.5).toBeCloseTo(parseFloat(label.style.width) * 0.5, 0);
    } finally {
      restore();
    }
  });

  it('农历：宽格不放大（10px 基准，scale 上限 1），不写内联变量与宽度', () => {
    const { node, restore, afterMount } = render();
    try {
      const cell = cellAt(node, 8);
      const head = cell.querySelector('.month__dayhead');
      const host = head.querySelector('.month__lunar--inline');
      const label = head.querySelector('.month__lunar--inline .month__lunar-text');
      const daynum = head.querySelector('.month__daynum');
      // 可用 60、扣保护边后 59 / 自然 40 = 1.475 → 上限 1（0.5.18 起基准是 10px，不再回落到 0.8）
      stubHeadGeometry(head, daynum, label, { headW: 76, numW: 14, naturalW: 40 });
      afterMount();
      expect(head.style.getPropertyValue('--dayhead-scale')).toBe('');
      // 0.6.7 起：宽格也写承载盒宽 = 自然宽 + 1px 保护边（旧实现到上限不写宽度，
      // 真机字体略宽时右缘正好压住裁切边）。
      expect(host.style.width).toBe('41px');
      expect(label.classList.contains('is-truncated')).toBe(false);
    } finally {
      restore();
    }
  });

  it('节日名：同样按实测宽缩放（基准 1，下限 0.5；下限仍放不下带省略号）', () => {
    const { node, restore, afterMount } = render({ events: [holiday('国庆节', 1)] });
    try {
      const head = cellAt(node, 1).querySelector('.month__dayhead');
      const host = head.querySelector('.month__holiday');
      const label = head.querySelector('.month__holiday-name');
      const daynum = head.querySelector('.month__daynum');
      // 可用 29.7、扣保护边后 28.7 / 自然 36 = 0.797
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 36 });
      afterMount();
      expect(head.style.getPropertyValue('--dayhead-scale')).toBe('0.797');
      // 0.6.10 起：承载盒 = min(ceil(36) + 1, 可用宽 ÷ 0.797 + 1) = 37。
      expect(host.style.width).toBe('37px');
      expect(label.textContent).toBe('国庆');
      // 0.6.9 起（用户：390 档「立冬」只显「立」、「小雪」只显「小」）：删掉
      // 「缩到 0.5 仍放不下就只留 1 个完整汉字、不画省略号」的中间态。可用 28.7 /
      // 自然 80 = 0.359 低于下限时，文字保持全名、加 is-truncated，宽度写成
      // 可用宽 ÷ 0.5 = 57.4，缩放后铺满承载盒，最后可见字后面显示省略号。
      stubHeadGeometry(head, daynum, label, { headW: 45.7, numW: 14, naturalW: 80 });
      afterMount();
      expect(label.textContent).toBe('国庆');
      expect(head.style.getPropertyValue('--dayhead-scale')).toBe('0.500');
      expect(label.classList.contains('is-truncated')).toBe(true);
      expect(label.style.width).toBe('57.4px');
      expect(host.style.width).toBe('58px');
    } finally {
      restore();
    }
  });

  it('JS：同一格的农历与节日名取同一个 scale；无实测宽度（未布局）时不动变量', () => {
    const { node, restore, afterMount } = render({ events: [holiday('国庆节', 1)] });
    try {
      const lunarCell = cellAt(node, 8);
      const lunarHead = lunarCell.querySelector('.month__dayhead');
      const lunarText = lunarHead.querySelector('.month__lunar--inline .month__lunar-text');
      stubHeadGeometry(lunarHead, lunarHead.querySelector('.month__daynum'), lunarText, {
        headW: 45.7,
        numW: 14,
        naturalW: 36,
      });
      const holidayHead = cellAt(node, 1).querySelector('.month__dayhead');
      const holidayText = holidayHead.querySelector('.month__holiday-name');
      stubHeadGeometry(holidayHead, holidayHead.querySelector('.month__daynum'), holidayText, {
        headW: 45.7,
        numW: 14,
        naturalW: 36,
      });
      afterMount();
      // 同几何、同自然宽 → 两种类型必须同值（用户：农历和节日的字体要统一）
      expect(lunarHead.style.getPropertyValue('--dayhead-scale')).toBe('0.797');
      expect(holidayHead.style.getPropertyValue('--dayhead-scale')).toBe(
        lunarHead.style.getPropertyValue('--dayhead-scale')
      );
      // 未布局（headW 0）：早退，不许写任何内联几何
      stubHeadGeometry(lunarHead, lunarHead.querySelector('.month__daynum'), lunarText, {
        headW: 0,
        numW: 14,
        naturalW: 48,
      });
      afterMount();
      expect(lunarHead.style.getPropertyValue('--dayhead-scale')).toBe('');
      // 源码层：fitCompactDayheads 只在 compact 里跑；下限 0.5 硬编码；宽度写「自然宽 × scale」
      expect(monthJs).toMatch(/function fitCompactDayheads\(root\)/);
      // 0.7.10（用户：11/22「小雪」被裁、11/7「立冬」完整）：缩放改成逐格按本格
      // 可用宽算比例，不再取整页统一最小值——宽格不会跟着最紧的一格一起缩。
      expect(monthJs).not.toMatch(/const uniform = Math\.min\(/);
      // 0.7.15（用户：「初一的字号比初一 23 的初一大」）：缩放按字素数分组，组内取最小
      // 比例并向下取 3 位小数；逐格 clamp 的旧写法退场（否则同字数落到不同字号）。
      expect(monthJs).toMatch(/const scale = groupScale\.get\(entry\.chars\) \?\? 1;/);
      expect(monthJs).toMatch(
        /groupScale\.set\(chars, Math\.max\(0\.5, Math\.min\(1, Math\.floor\(ratio \* 1000\) \/ 1000\)\)\);/,
      );
      expect(monthJs).toMatch(/const chars = Array\.from\(text\.textContent\.trim\(\)\)\.length \|\| 1;/);
      // 0.6.7 起了 1px 保护边；0.6.10 起承载盒按缩放前的自然宽给宽，上限 = usable ÷ scale。
      expect(monthJs).toMatch(/Math\.ceil\(entry\.natural\) \+ DAYHEAD_SLACK/);
      expect(monthJs).toMatch(/Math\.floor\(entry\.usable \/ scale\) \+ DAYHEAD_SLACK/);
      expect(monthJs).toMatch(/const DAYHEAD_SLACK = 1;/);
      expect(monthJs).toMatch(/if \(compact\) fitCompactDayheads\(root\);/);
    } finally {
      restore();
    }
  });
});

/**
 * 0.5.21（W1，用户：「月视图的农历字体大小，一页还是没有统一」）：
 * 一页只用同一个缩放值——取所有可见格「可用宽 / 自然宽」的最小值，上限 1、下限 0.5。
 */
describe('0.5.21 W1：整页日号行取同一个缩放值', () => {
  function headOf(node, day) {
    const head = cellAt(node, day).querySelector('.month__dayhead');
    return {
      head,
      host: head.querySelector('.month__lunar--inline'),
      label: head.querySelector('.month__lunar--inline .month__lunar-text'),
      daynum: head.querySelector('.month__daynum'),
    };
  }

  it('统一值取全屏最小值：宽格跟着窄格一起缩，不再出现「1 号大、17 号小」', () => {
    const { node, restore, afterMount } = render();
    try {
      const narrow = headOf(node, 8); // 可用 28.7（已扣 1px 保护边）/ 自然 48 = 0.598
      const wide = headOf(node, 17); // 可用 59 / 自然 40 = 1.475（上限）
      stubHeadGeometry(narrow.head, narrow.daynum, narrow.label, {
        headW: 45.7,
        numW: 14,
        naturalW: 48,
      });
      stubHeadGeometry(wide.head, wide.daynum, wide.label, {
        headW: 76,
        numW: 14,
        naturalW: 40,
      });
      afterMount();
      // 0.7.15（用户：「初一的字号比初一 23 的初一大」）：逐格算仍会因日号宽度差落到不同
      // 字号；改为按字素数分组后，两格同为两字农历，宽格取组内最小值 0.597（不再留空 = 1）。
      expect(narrow.head.style.getPropertyValue('--dayhead-scale')).toBe('0.597');
      expect(wide.head.style.getPropertyValue('--dayhead-scale')).toBe('0.597');
      // 0.6.10 起：承载盒按缩放前的自然宽给宽 = 40 + 1 = 41（视觉宽 41 × 1 = 41 ≤ 可用 59）
      expect(wide.host.style.width).toBe('41px');
      expect(wide.label.classList.contains('is-truncated')).toBe(false);
    } finally {
      restore();
    }
  });

  it('统一值到 0.5 仍放不下的格才减字 / 省略，其余格保持 0.5', () => {
    const { node, restore, afterMount } = render();
    try {
      const tooNarrow = headOf(node, 8); // 可用 29.7 / 自然 100 = 0.297 → 触底
      const normal = headOf(node, 9); // 可用 59.7 / 自然 40 → 本可放大
      stubHeadGeometry(tooNarrow.head, tooNarrow.daynum, tooNarrow.label, {
        headW: 45.7,
        numW: 14,
        naturalW: 100,
      });
      stubHeadGeometry(normal.head, normal.daynum, normal.label, {
        headW: 75.7,
        numW: 14,
        naturalW: 40,
      });
      afterMount();
      // 0.7.15（按字素数分组，规格同 ui-060 上一条）：两格同为两字农历，组最小值 0.297
      // 触底成 0.500 —— 两格同用 0.500（宽格也被同组最紧的一格拉齐，这正是「字号统一」）；
      // 只有 ratio < 0.5 的那格进入省略模式，宽格仍完整显示。
      expect(tooNarrow.head.style.getPropertyValue('--dayhead-scale')).toBe('0.500');
      expect(tooNarrow.label.classList.contains('is-truncated')).toBe(true);
      expect(normal.head.style.getPropertyValue('--dayhead-scale')).toBe('0.500');
      expect(normal.label.classList.contains('is-truncated')).toBe(false);
      // 0.6.10 起：放得下就按缩放前自然宽给盒（40 + 1），不再写 40 × 0.5 + 1。
      expect(normal.host.style.width).toBe('41px');
      // 盒宽是缩放前坐标，视觉宽只有 40 × 0.5 = 20，多出的 21px 用负 margin 收回。
      expect(normal.host.style.marginInlineEnd).toBe('-21px');
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ S2 */

describe('0.5.10 S2：事件区顶边不被日号行上提', () => {
  it('紧凑档日号行是事件区前一个兄弟，桌面那条负 margin 规则不会作用到它', () => {
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const events = cell.querySelector('.month__events');
      expect(events.previousElementSibling).toBe(cell.querySelector('.month__dayhead'));
      // 桌面规则还在（桌面零回归），但 ≤520 段里不许重新加回负 margin
      expect(viewsCss).toMatch(
        /\.month__lunar \+ \.month__events \{[\s\S]*?margin-top: calc\(11px - var\(--month-chip-h, 20px\)\)/,
      );
      const block = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__dayhead');
      expect(block).not.toMatch(/\.month__lunar \+ \.month__events/);
      expect(block).not.toMatch(/\.month__events \{[^}]*margin-top: -/);
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------------ S3 */

describe('0.5.10 S3 / 0.5.17：≤520 空白格短按新建事件，长按两项菜单', () => {
  // 0.5.17（用户 2026-11-07）：旧断言「≤520 短按什么都不做」是 0.5.10 口径，已被
  // 用户新要求推翻——短按改为与桌面同一路径 `actions.createAt`。只改这一条断言，
  // 长按 / 位移 / 日号 / 桌面各条保持原样。
  it('短按：直接打开新建事件（与桌面同一路径），不弹菜单、不弹 toast', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointerup', cell, { clientX: 40, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(actions.createAt).toHaveBeenCalledTimes(1);
      expect(actions.createAt.mock.calls[0][0]).toEqual({
        start: startOfDay(new Date(2026, 9, 8)).getTime() + 9 * 3600_000,
        allDay: false,
      });
      expect(document.querySelector('.ctx-menu')).toBeNull();
      expect(actions.createTask).not.toHaveBeenCalled();
      expect(actions.gotoDayView).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('长按 ≥500ms：走同一份槽位菜单（调用 slotContextMenu，参数是当天 09:00）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      vi.advanceTimersByTime(499);
      expect(actions.slotContextMenu).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const [evt, startMs] = actions.slotContextMenu.mock.calls[0];
      expect(evt.clientX).toBe(40);
      expect(evt.clientY).toBe(80);
      const day = startOfDay(new Date(2026, 9, 8)).getTime();
      expect(startMs).toBe(day + 9 * 3600_000);
      // 视图层不再自己建菜单（内容统一由 app.js 的 slotContextMenu 给）
      expect(document.querySelector('.ctx-menu')).toBeNull();
      expect(actions.createAt).not.toHaveBeenCalled();
      expect(actions.createTask).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('长按期间位移 20px：不弹菜单（交给滚动/横滑）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 60, clientY: 80 });
      vi.advanceTimersByTime(600);
      expect(document.querySelector('.ctx-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('长按期间位移 5px（阈值内）：仍弹菜单', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 45, clientY: 82 });
      vi.advanceTimersByTime(500);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('长按日号不弹菜单；点日号仍进日视图', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const daynum = cellAt(node, 8).querySelector('.month__daynum');
      pointer('pointerdown', daynum, { clientX: 60, clientY: 60 });
      vi.advanceTimersByTime(600);
      expect(document.querySelector('.ctx-menu')).toBeNull();
      daynum.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 60 }));
      expect(actions.gotoDayView).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('≤520 右键被压住（没按住时：不弹系统菜单、不调桌面槽位菜单）', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(actions.slotContextMenu).not.toHaveBeenCalled();
      expect(document.querySelector('.ctx-menu')).toBeNull();
    } finally {
      restore();
    }
  });

  it('0.5.11 S3：真机原生 contextmenu 先到（计时器还没响）→ 直接开菜单，不再被吞掉', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 44, clientY: 90 });
      // Android 在长按 ~500ms 会补一次原生 contextmenu；它可能比计时器早到。
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const [evt, startMs] = actions.slotContextMenu.mock.calls[0];
      expect(evt.clientX).toBe(44);
      expect(evt.clientY).toBe(90);
      expect(startMs).toBe(startOfDay(new Date(2026, 9, 8)).getTime() + 9 * 3600_000);
      // 计时器已清掉，不会再补一次菜单。
      vi.advanceTimersByTime(800);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('0.5.11 S3：计时器已开菜单后原生 contextmenu 才到 → 不重复开、菜单不被关', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 44, clientY: 90 });
      vi.advanceTimersByTime(500);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 });
      cell.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      restore();
    }
  });

  it('桌面：点格子直接新建事件，右键走同一份两项槽位菜单（桌面零回归）', () => {
    const { node, actions, restore } = render({ compact: false });
    try {
      const cell = cellAt(node, 8);
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(actions.createAt).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.ctx-menu')).toBeNull();
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('源码：长按常量 500ms / 8px，长按与右键共用 slotContextMenu；全应用没有「新建全天事件」', () => {
    expect(monthJs).toMatch(/const LONG_PRESS_MS = 500;/);
    expect(monthJs).toMatch(/const LONG_PRESS_SLOP = 8;/);
    const at = monthJs.indexOf('const openCreateMenu');
    expect(at).toBeGreaterThan(-1);
    const block = monthJs.slice(at, at + 400);
    expect(block).toContain('actions.slotContextMenu(');
    expect(block).toContain('defaultCreateTime(day)');
    // 视图层不自建菜单项（唯一来源是 app.js）
    expect(monthJs).not.toContain("t('editor.newEvent')");
    // 0.5.10（用户第三次确认）：全应用两项，slotContextMenu 不再有「新建全天事件」。
    const slotAt = appJs.indexOf('slotContextMenu:');
    const slot = appJs.slice(slotAt, slotAt + 900);
    expect(slot).toContain("t('editor.newEvent')");
    expect(slot).toContain("t('editor.newTask')");
    expect(slot).not.toContain('newAllDayEvent');
    expect(appJs).not.toContain('newAllDayEvent');
    // 时间网格右键也走同一个槽位动作（改一处两边都两项）
    expect(timegridJs).toMatch(/actions\.slotContextMenu\(e, timeFromPointer/);
  });
});

/* ------------------------------------------------ 0.5.17 短按与长按互斥 */

describe('0.5.17：手机短按新建事件，一次手势只出一个结果', () => {
  it('长按 600ms 开菜单后松手：click 不再打开新建事件（A1-3）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      vi.advanceTimersByTime(600);
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      pointer('pointerup', cell, { clientX: 40, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(actions.createAt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('原生 contextmenu 开菜单后松手：click 不再打开新建事件（A1-3 系统补发分支）', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 44, clientY: 90 });
      cell.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 44, clientY: 90 }),
      );
      expect(actions.slotContextMenu).toHaveBeenCalledTimes(1);
      pointer('pointerup', cell, { clientX: 44, clientY: 90 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 44, clientY: 90 }));
      expect(actions.createAt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('位移 20px（滚动 / 横滑）后松手：click 不新建、也不弹菜单（A2-4）', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 60, clientY: 80 });
      pointer('pointerup', cell, { clientX: 60, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 60, clientY: 80 }));
      expect(actions.createAt).not.toHaveBeenCalled();
      expect(actions.slotContextMenu).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('被吞掉一次后，下一次短按仍能正常新建（抑制只影响当次手势）', () => {
    const { node, actions, restore } = render();
    try {
      const cell = cellAt(node, 8);
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointermove', cell, { clientX: 70, clientY: 80 });
      pointer('pointerup', cell, { clientX: 70, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 70, clientY: 80 }));
      expect(actions.createAt).not.toHaveBeenCalled();
      pointer('pointerdown', cell, { clientX: 40, clientY: 80 });
      pointer('pointerup', cell, { clientX: 40, clientY: 80 });
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 80 }));
      expect(actions.createAt).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('点事件条：打开事件详情，不落回格子新建（A2-1）', () => {
    const day = startOfDay(new Date(2026, 9, 8)).getTime();
    const evt = {
      id: 'e-0517',
      title: '评审会',
      start: day + 9 * 3600_000,
      end: day + 10 * 3600_000,
      allDay: false,
      readOnly: false,
      color: 'blue',
      reminders: [],
    };
    const { node, actions, restore } = render({ events: [evt] });
    try {
      const chip = cellAt(node, 8).querySelector('.chip');
      expect(chip).toBeTruthy();
      chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(actions.openEvent).toHaveBeenCalledTimes(1);
      expect(actions.createAt).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('源码：「还有 N 个」仍在格子 click 入口被拦下（A2-1 另一半，溢出时才有该节点）', () => {
    const at = monthJs.indexOf('click: (e) => {');
    expect(at).toBeGreaterThan(-1);
    const block = monthJs.slice(at, at + 400);
    expect(block).toContain("e.target.closest('.chip')");
    expect(block).toContain("e.target.closest('.month__more')");
  });
});
