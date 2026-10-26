/**
 * M3 走查硬证据：30 个汉字 + emoji 组合的最坏标题用例（jsdom）。
 *
 * 覆盖：
 *   - 月视图事件块（.chip / .chip__title）
 *   - 周视图时间网格事件块（.tevent / .tevent__title）
 *   - 事件编辑弹窗标题输入与底部按钮
 *
 * 断言：
 *   - 不抛异常，textContent 与 title/aria 属性完整保留（emoji ZWJ 组合不拆散）；
 *   - 截断走样式规则（.chip__title / .tevent__title 的 overflow+text-overflow），
 *     并用完整标题作为原生 title 提示；
 *   - 弹窗按钮在独立的 .modal__foot 容器里、文案短（≤4 汉字）、不被长标题撑宽。
 *
 * 末行固定输出 `SUMMARY: pass=N fail=0`，供走查记录引用。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderMonth } from '../src/js/views/month.js';
import { renderTimeGrid } from '../src/js/views/timegrid.js';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { endOfDay, startOfDay } from '../src/js/date-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const styles = {
  layout: readFileSync(path.join(HERE, '..', 'src', 'styles', 'layout.css'), 'utf8'),
  views: readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8'),
  base: readFileSync(path.join(HERE, '..', 'src', 'styles', 'base.css'), 'utf8'),
};

// 6 汉字 × 5 = 30 个汉字，再加一个 emoji 与一个 ZWJ 家庭组合 emoji。
const TITLE = `${'超长中文标题'.repeat(5)}🎉👨‍👩‍👧‍👦`;
const DAY = new Date(2026, 7, 19); // Wed 19 Aug 2026
const START = new Date(2026, 7, 19, 10, 0, 0).getTime();
const END = new Date(2026, 7, 19, 11, 0, 0).getTime();
const EVENT = { id: 'worst-title', title: TITLE, start: START, end: END, allDay: false, color: 'blue', reminders: [] };

function makeStore() {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEventsInRange: (from, to) => [EVENT].filter((e) => e.start < to && e.end > from),
    getTasksInRange: () => [],
    getEvent: (id) => (id === EVENT.id ? EVENT : null),
    getTask: () => null,
    getAllEvents: () => [EVENT],
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

function makeCtx(cursor = DAY) {
  return {
    store: makeStore(),
    settings: { ...DEFAULT_SETTINGS, weekStartsOn: 0, hour12: false },
    cursor,
    miniCursor: cursor,
    now: cursor,
    actions: {
      createAt() {},
      gotoDayView() {},
      slotContextMenu() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      moveEvent() {},
      moveTask() {},
      edgePage() {},
    },
  };
}

const cssRule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
};

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('M3 走查：30 字中文 + emoji 最坏标题', () => {
  it('月/周视图与编辑弹窗不截断、不抛异常，按钮独立', () => {
    checks.length = 0;

    /* ---------------- 月视图 ---------------- */
    let monthNode = null;
    check('月视图渲染不抛异常', () => {
      const { node } = renderMonth(makeCtx());
      monthNode = node;
      expect(node).toBeTruthy();
    });
    const chip = monthNode && [...monthNode.querySelectorAll('.chip')]
      .find((node) => node.querySelector('.chip__title')?.textContent === TITLE);
    check('月视图事件块存在', () => expect(chip).toBeTruthy());
    check('月视图 textContent 完整保留 30 汉字 + emoji', () => {
      expect(chip.querySelector('.chip__title').textContent).toBe(TITLE);
      expect(chip.textContent).toContain('🎉');
      expect(chip.textContent).toContain('👨‍👩‍👧‍👦');
    });
    check('月视图 title 属性带完整标题（原生悬停）', () => expect(chip.getAttribute('title')).toBe(TITLE));
    check('月视图 aria-label 含完整标题', () => expect(chip.getAttribute('aria-label')).toContain(TITLE));
    check('月视图截断规则（.chip__title overflow+ellipsis）', () => {
      const rule = cssRule(styles.views, '.chip__title');
      expect(rule).toMatch(/overflow:\s*hidden/);
      expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    });

    /* ---------------- 周视图（时间网格） ---------------- */
    let gridNode = null;
    check('周视图渲染不抛异常', () => {
      const { node } = renderTimeGrid([DAY], makeCtx());
      gridNode = node;
      expect(node).toBeTruthy();
    });
    const tevent = gridNode && [...gridNode.querySelectorAll('.tevent')]
      .find((node) => node.querySelector('.tevent__title')?.textContent === TITLE);
    check('周视图事件块存在', () => expect(tevent).toBeTruthy());
    check('周视图 textContent 完整保留 30 汉字 + emoji', () => {
      expect(tevent.querySelector('.tevent__title').textContent).toBe(TITLE);
      expect(tevent.getAttribute('title')).toBe(TITLE);
    });
    check('周视图截断规则（.tevent__title ellipsis+nowrap）', () => {
      const rule = cssRule(styles.views, '.tevent__title');
      expect(rule).toMatch(/overflow:\s*hidden/);
      expect(rule).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule).toMatch(/white-space:\s*nowrap/);
    });

    /* ---------------- 编辑弹窗 ---------------- */
    const modal = createEventModal({ store: makeStore() });
    check('编辑弹窗打开不抛异常', () => {
      modal.openEdit({ ...EVENT });
      expect(document.querySelector('.modal-scrim')).toBeTruthy();
    });
    const scrim = document.querySelector('.modal-scrim');
    const titleInput = scrim && scrim.querySelector('input[aria-label="事件标题"]');
    check('弹窗标题输入框完整保留标题（含 emoji）', () => {
      expect(titleInput).toBeTruthy();
      expect(titleInput.value).toBe(TITLE);
    });
    check('标题输入是文本输入、不解析为 HTML', () => {
      expect(titleInput.type).toBe('text');
      expect(titleInput.value).not.toContain('<');
      expect(titleInput.value.length).toBe(TITLE.length);
    });
    const buttons = scrim ? [...scrim.querySelectorAll('.modal__foot .btn')] : [];
    check('底部按钮存在且文案短（≤4 汉字）', () => {
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      for (const button of buttons) {
        const text = button.textContent.trim();
        const han = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        expect(han).toBeGreaterThan(0);
        expect(han).toBeLessThanOrEqual(4);
        expect(text).not.toContain(TITLE);
      }
    });
    check('按钮独立于标题容器（.modal__foot，不在 .field--title 内）', () => {
      for (const button of buttons) {
        expect(button.closest('.modal__foot')).toBeTruthy();
        expect(button.closest('.field--title')).toBeNull();
        expect(button.closest('.modal__title')).toBeNull();
      }
    });
    check('按钮样式独立（.btn inline-flex / .modal__foot flex）', () => {
      const btnRule = cssRule(styles.base, '.btn');
      expect(btnRule).toMatch(/display:\s*inline-flex/);
      const footRule = cssRule(styles.layout, '.modal__foot');
      expect(footRule).toMatch(/display:\s*flex/);
    });
    modal.close();

    /* ---------------- 汇总 ---------------- */
    const failed = checks.filter((item) => !item.ok);
    console.log(`SUMMARY: pass=${checks.length - failed.length} fail=${failed.length}`);
    for (const item of failed) console.log(`[FAIL] ${item.name}: ${item.error}`);
    expect(failed).toEqual([]);
  });
});
