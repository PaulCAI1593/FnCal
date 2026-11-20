/**
 * 0.8.53（任务书 F.8，总监自审 D5）：日期弹层高度上限。
 *
 * 旧实现只做上下翻转，视口矮（390×500）时弹层底边会越界。
 * 现在先按 `innerHeight - 16` 写 `maxHeight`，超出内部滚动，底边留 ≥8px。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const SETTINGS = { ...DEFAULT_SETTINGS, weekStartsOn: 1, hour12: true };
const store = {
  getSettings: () => ({ ...SETTINGS }),
  getEvent: () => null,
  getTask: () => null,
  saveEvent: async (e) => e,
  saveTask: async (t) => t,
  deleteTask: async () => {},
  applyOutOfOffice: async () => ({ declined: [], undo() {} }),
};

let modal = null;

afterEach(() => {
  if (modal) modal.close();
  modal = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const rectOf = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});

/**
 * 打开编辑器并点开日期弹层。
 * `popHeight` 模拟弹层自然高度（jsdom 里 getBoundingClientRect 恒为 0）。
 */
function openPopover({ innerWidth = 390, innerHeight = 500, anchor, popHeight = 900 } = {}) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(innerWidth);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList?.contains('date-pop')) return rectOf(0, 0, 288, popHeight);
    if (this.classList?.contains('editor__date-btn')) return anchor;
    return rectOf(0, 0, 0, 0);
  });

  modal = createEventModal({ store });
  const start = at(2026, 10, 24);
  modal.openNew({ start, end: start + 3600 * 1000, allDay: false });
  document.querySelector('.modal-scrim .editor__date-btn').click();
  const pop = document.querySelector('.date-pop');
  expect(pop).toBeTruthy();
  return pop;
}

const topOf = (pop) => Number.parseFloat(pop.style.top);

describe('0.8.53 · 日期弹层限高（D5）', () => {
  it('390×500 且内容很高：maxHeight = innerHeight-16，底边留 8px', () => {
    const pop = openPopover({
      innerHeight: 500,
      anchor: rectOf(360, 430, 120, 32), // 贴右下角
    });
    expect(pop.style.maxHeight).toBe('484px');
    expect(pop.style.overflowY).toBe('auto');
    expect(topOf(pop)).toBe(8);
    expect(topOf(pop) + 484).toBe(500 - 8);
  });

  it('顶部有空间时向下展开，不越底', () => {
    const pop = openPopover({
      innerHeight: 800,
      anchor: rectOf(20, 100, 200, 32),
      popHeight: 320,
    });
    expect(topOf(pop)).toBe(138); // rect.bottom(132) + gap(6)
    expect(topOf(pop) + 320).toBeLessThanOrEqual(800 - 8);
  });

  it('右侧贴边时横向夹进视口，不产生横向溢出', () => {
    const pop = openPopover({
      innerWidth: 390,
      innerHeight: 800,
      anchor: rectOf(380, 200, 120, 32),
      popHeight: 320,
    });
    const left = Number.parseFloat(pop.style.left);
    expect(left).toBe(390 - 288 - 8);
    expect(left + 288).toBeLessThanOrEqual(390 - 8);
  });

  it('视口极矮（390×300）时 maxHeight 不低于 160，仍不越界', () => {
    const pop = openPopover({
      innerHeight: 300,
      anchor: rectOf(20, 240, 120, 32),
      popHeight: 900,
    });
    expect(pop.style.maxHeight).toBe('284px'); // 300 - 16
    expect(topOf(pop)).toBe(8);
    expect(topOf(pop) + 284).toBe(300 - 8);
  });
});
