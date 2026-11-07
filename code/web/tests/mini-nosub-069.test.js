/**
 * 0.6.9 C（用户截图 + 原话：「迷你日历不要农历这些啊」）：
 * 侧栏迷你月历不再显示农历 / 节日 / 节气的副文字，格内只剩日期数字 + 事件点 / 跨天点线。
 *
 * 0.6.6 加的那行副文字把单日圆点逼到格子右上角，点与跨天点线的基线分叉；0.6.9 把
 * `.mini__sub` / `has-sub` 整条删除，圆点回到格内底部居中（`bottom:3px; left:50%`），
 * 同一行所有点同 y。这里锁四件事：DOM 无副文字、CSS 无残留规则、开关不影响结构、
 * 圆点/点线的单一基线仍在。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderSidebar } from '../src/js/sidebar.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sidebarJs = readFileSync(path.join(HERE, '..', 'src/js/sidebar.js'), 'utf8');
const layoutCss = readFileSync(path.join(HERE, '..', 'src/styles/layout.css'), 'utf8');

const dayKey = (y, m, d) => new Date(y, m, d).getTime();

/** 只读叠加项：节日 / 节气。（0.6.9 起迷你月历不再消费它们，但 store 仍会返回。） */
const overlay = (day, title, kind) => ({
  id: `${kind}:${day}`,
  title,
  start: dayKey(2026, 6, day),
  end: dayKey(2026, 6, day) + 24 * 3600 * 1000,
  allDay: true,
  readOnly: true,
  holiday: kind === 'hol',
  term: kind === 'term',
});

function makeCtx({ settings = {}, events = [] } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const store = {
    getAllEvents: () => [],
    getAllTasks: () => [],
    getEventsInRange: () => events,
    getSettings: () => ({ ...s }),
  };
  const now = new Date(2026, 6, 15);
  return {
    store,
    settings: s,
    cursor: now,
    miniCursor: new Date(2026, 6, 1),
    now,
    actions: {
      createAt() {},
      miniShift() {},
      selectDate() {},
      toggleColor() {},
      renameCategory() {},
      toggleCategories() {},
      toggleBookingLinks() {},
      newBookingPage() {},
      editBookingPage() {},
      copyBookingLink() {},
    },
  };
}

const cells = (node) => [...node.querySelectorAll('.mini__cell')];

afterEach(() => {
  document.body.replaceChildren();
});

describe('0.6.9 C：迷你月历取消副文字行', () => {
  it('迷你格不再生成 .mini__sub，也不加 has-sub 类', () => {
    const ctx = makeCtx({
      events: [overlay(7, '立冬', 'term'), overlay(22, '小雪', 'term'), overlay(1, '元旦', 'hol')],
    });
    const node = renderSidebar(ctx);
    document.body.append(node);
    expect(cells(node).length).toBe(42);
    expect(node.querySelector('.mini__sub')).toBeNull();
    expect(node.querySelector('.mini__sub--holiday')).toBeNull();
    expect(node.querySelector('.mini__sub--term')).toBeNull();
    expect(node.querySelector('.has-sub')).toBeNull();
    for (const cell of cells(node)) {
      expect(cell.classList.contains('has-sub')).toBe(false);
    }
  });

  it('格内只有填色圆 + 数字（跨天格另有 .mini__run），没有第三层文字', () => {
    const node = renderSidebar(makeCtx());
    document.body.append(node);
    for (const cell of cells(node)) {
      const own = [...cell.children].filter((c) => !c.classList.contains('mini__run'));
      expect(own.map((c) => c.className)).toEqual(['mini__fill', 'mini__num']);
    }
    // 日号仍是真实数字，没有被副文字替换
    const num = cells(node)[0].querySelector('.mini__num');
    expect(/^\d{1,2}$/.test(num.textContent)).toBe(true);
  });

  it('节日 / 节气开关开或关，迷你格结构完全相同', () => {
    const on = renderSidebar(makeCtx({ settings: { solarTerms: true, lunar: true } }));
    const off = renderSidebar(makeCtx({ settings: { solarTerms: false, lunar: false } }));
    document.body.append(on, off);
    const shape = (node) =>
      cells(node).map((cell) => [
        cell.className,
        cell.querySelector('.mini__num').textContent,
        cell.children.length,
      ]);
    expect(shape(on)).toEqual(shape(off));
    expect(off.querySelector('.mini__sub')).toBeNull();
  });

  it('源码与样式：副文字整条删除，不留死代码', () => {
    expect(sidebarJs).not.toMatch(/mini__sub/);
    expect(sidebarJs).not.toMatch(/has-sub/);
    expect(sidebarJs).not.toMatch(/dayLunarText/);
    // 只为副文字取数的 overlay 循环一并删除
    expect(sidebarJs).not.toMatch(/overlayByDay/);
    expect(layoutCss).not.toMatch(/\.mini__sub/);
    expect(layoutCss).not.toMatch(/has-sub/);
  });

  it('点与点线共用同一条基线：单日点格内底部居中，不再让到右上角', () => {
    // 单一基线：单日点是格内底部居中（bottom 3px + translateX(-50%)），
    // 跨天点线同样落在底部 3px 起，锚点为首格中心。
    expect(layoutCss).toMatch(/\.mini__cell\.has-events::after \{[^}]*bottom: 3px/);
    expect(layoutCss).toMatch(/\.mini__cell\.has-events::after \{[^}]*left: 50%/);
    expect(layoutCss).toMatch(/\.mini__cell\.has-events::after \{[^}]*translateX\(-50%\)/);
    expect(layoutCss).toMatch(/\.mini__run \{[^}]*bottom: 3px/);
    expect(layoutCss).toMatch(/\.mini__run \{[^}]*left: calc\(50% - 1\.5px\)/);
    // 0.6.6 的「有副文字时点让到右上角」覆盖必须不存在
    expect(layoutCss).not.toMatch(/right: 3px;\s*top: 3px;\s*bottom: auto/);
    // 格子仍是正方形，底边留 3px 后点圆心在格中心 x 上
    expect(layoutCss).toMatch(/\.mini__cell \{[^}]*aspect-ratio: 1/);
  });
});
