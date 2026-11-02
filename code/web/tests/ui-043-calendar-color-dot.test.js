/**
 * 0.4.3：日历色点必须跟随日历自定义 hex。
 *
 * 根因回归：`modal.js` 在 createEventModal 作用域里声明过局部 `colorHex()`，
 * 遮蔽了从 `colors.js` 导入的同名函数；局部版只认调色板 key，收到 `#RRGGBB`
 * 时回落 indigo，导致三处色点都不跟日历色：
 *   1. 编辑器「日历」触发器色点
 *   2. 日历下拉 chip 色点
 *   3. 事件详情卡标题旁的大色块
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { colorHex } from '../src/js/colors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(path.join(HERE, '../src/js/app.js'), 'utf8');

const HEX = '#d73b3c';
const CUSTOM = {
  id: 'cal-custom',
  displayName: '自定义色日历',
  color: HEX,
  colorHex: HEX,
  type: 'vevent',
  visible: true,
  order: 0,
};
const BLUE = {
  id: 'cal-blue',
  displayName: '蓝色日历',
  color: 'blue',
  colorHex: colorHex('blue'),
  type: 'vevent',
  visible: true,
  order: 1,
};

function makeStore({ settings = {} } = {}) {
  const list = [CUSTOM, BLUE];
  const state = { ...DEFAULT_SETTINGS, defaultCalendarId: 'cal-custom', ...settings };
  return {
    getSettings: () => ({ ...state }),
    getCalendars: () => list.map((c) => ({ ...c })),
    getCalendar: (id) => list.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    getEvent: () => null,
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

const bg = (node) => node.style.getPropertyValue('background') || node.style.background;
const HEX_RE = /#d73b3c|215,\s*59,\s*60/i;
const BLUE_RE = /#3171e0|49,\s*113,\s*224/i;
const INDIGO_RE = /#5b5ef4|91,\s*94,\s*244/i;

describe('0.4.3 日历色点跟随日历自定义色', () => {
  let modal;

  afterEach(() => {
    modal && modal.close();
    document.body.replaceChildren();
  });

  it('编辑器「日历」触发器色点 = 日历自定义 hex', () => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew();
    const dot = document.querySelector('.cal-select__trigger .chip__dot');
    expect(dot).toBeTruthy();
    expect(bg(dot)).toMatch(HEX_RE);
  });

  it('日历下拉 chip 色点 = 日历自定义 hex', () => {
    modal = createEventModal({ store: makeStore() });
    modal.openNew();
    document.querySelector('.cal-select__trigger').click();
    const rows = [...document.querySelectorAll('.cal-select__list .cal-select__item')];
    const row = rows.find((r) => r.textContent.includes('自定义色日历'));
    expect(row).toBeTruthy();
    expect(bg(row.querySelector('.chip__dot'))).toMatch(HEX_RE);
  });

  it('事件详情卡大色块 = 事件自定义 hex', () => {
    modal = createEventModal({ store: makeStore() });
    const start = new Date(2026, 10, 3, 9).getTime();
    modal.openView({
      id: 'e1',
      title: '评审',
      start,
      end: start + 3_600_000,
      calendarId: 'cal-custom',
      color: HEX,
      reminders: [],
    });
    const block = document.querySelector('.modal-scrim .view__color');
    expect(block).toBeTruthy();
    expect(bg(block)).toMatch(HEX_RE);
  });

  it('调色板 key 仍映射到对应 hex（key 路径不退化）', () => {
    modal = createEventModal({ store: makeStore({ settings: { defaultCalendarId: 'cal-blue' } }) });
    modal.openNew();
    expect(bg(document.querySelector('.cal-select__trigger .chip__dot'))).toMatch(BLUE_RE);
  });

  it('无法识别的颜色值回退默认 indigo（与导入版 colorHex 一致）', () => {
    modal = createEventModal({ store: makeStore() });
    const start = new Date(2026, 10, 3, 10).getTime();
    modal.openView({
      id: 'e2',
      title: '无颜色',
      start,
      end: start + 600_000,
      calendarId: 'cal-custom',
      color: 'not-a-color',
      reminders: [],
    });
    expect(bg(document.querySelector('.modal-scrim .view__color'))).toMatch(INDIGO_RE);
  });

  it('侧栏日历菜单的勾选按 hex 判定（app.js 不再比较 key）', () => {
    expect(appJs).toContain('checked: colorHex(cal.color) === c.hex');
    expect(appJs).not.toContain('checked: cal.color === c.key');
  });
});
