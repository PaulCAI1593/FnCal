/**
 * 0.2.0 移动端布局断言（jsdom 无排版引擎，这里做静态 + 结构断言）：
 *   - 最小 360px 不出现横向滚动：body 固定 overflow hidden，且样式里没有
 *     超过 360px 的 min-width（固定宽度改用 min()/百分比）；
 *   - hover 规则全部包在 `(hover: hover) and (pointer: fine)` 里（触屏不粘滞、
 *     桌面仍保留悬停效果）；
 *   - 交互元素带 touch-action: manipulation（去掉 300ms 延迟/双击缩放）；
 *   - ≤720 的任务栏是全屏抽屉、≤720 搜索面板全屏、≤520 设置字段单列；
 *   - 抽屉开合（侧栏与任务栏）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(here, '..', 'src', 'styles');
const STYLES = ['tokens', 'base', 'layout', 'views', 'calendar']
  .map((name) => fs.readFileSync(path.join(stylesDir, `${name}.css`), 'utf8'))
  .join('\n');

/** 与 scripts/wrap-hover.mjs 相同的解析：找出未加设备条件的 :hover 规则。 */
function ungatedHoverRules(text) {
  const stack = [];
  const hits = [];
  const segmentStarts = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(segmentStart, i).trim();
      const parentGated = stack.length ? stack[stack.length - 1].gated : false;
      const gated = parentGated || /@media[^{]*\(\s*hover\s*:/.test(prelude);
      stack.push({ prelude, gated });
      segmentStarts.push(segmentStart);
      segmentStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame && !frame.prelude.startsWith('@') && /:hover/.test(frame.prelude) && !frame.gated) {
        hits.push(frame.prelude);
      }
      segmentStart = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      segmentStart = i + 1;
    }
  }
  return hits;
}

function mediaBlock(maxWidth) {
  const marker = `@media (max-width: ${maxWidth}px)`;
  const parts = [];
  let from = 0;
  for (;;) {
    const start = STYLES.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = start; i < STYLES.length; i += 1) {
      if (STYLES[i] === '{') depth += 1;
      else if (STYLES[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          parts.push(STYLES.slice(start, i + 1));
          from = i + 1;
          break;
        }
      }
    }
    if (from <= start) break;
  }
  return parts.join('\n');
}

/** 所有 `@media (pointer: coarse)` 块（layout.css 既有的 + 0.2.0 新增的）。 */
function coarseBlocks() {
  const marker = '@media (pointer: coarse)';
  const parts = [];
  let from = 0;
  for (;;) {
    const start = STYLES.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = start; i < STYLES.length; i += 1) {
      if (STYLES[i] === '{') depth += 1;
      else if (STYLES[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          parts.push(STYLES.slice(start, i + 1));
          from = i + 1;
          break;
        }
      }
    }
    if (from <= start) break;
  }
  return parts.join('\n');
}

describe('移动端布局断言', () => {
  it('最小 360px 不出现横向滚动：没有超过 360px 的 min-width', () => {
    const offenders = [...STYLES.matchAll(/min-width:\s*(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((value) => value > 360);
    expect(offenders).toEqual([]);
    // 页面本身不参与横向滚动（所有滚动都在内部容器里）。
    expect(/body\s*{[^}]*overflow:\s*hidden/s.test(STYLES)).toBe(true);
  });

  it('所有 :hover 规则都只在鼠标设备生效', () => {
    expect(ungatedHoverRules(STYLES)).toEqual([]);
    expect(STYLES).toContain('@media (hover: hover) and (pointer: fine)');
  });

  it('交互元素带 touch-action: manipulation', () => {
    expect(STYLES).toMatch(/touch-action:\s*manipulation/);
    const block = STYLES.slice(STYLES.indexOf('touch-action: manipulation') - 500);
    for (const selector of ['button', '.cal-row', '.task-row', '.swatch', '.switch', '.timegrid']) {
      expect(block).toContain(selector);
    }
  });

  it('触屏可点目标 ≥44×44（日历行/任务行/色块/开关/⋯ 菜单）', () => {
    const block = coarseBlocks();
    for (const selector of ['.cal-row', '.task-row', '.swatch', '.menu-item', '.settings__row', '.mini__cell']) {
      expect(block).toContain(selector);
    }
    expect(block).toMatch(/\.cal-row,[^}]*min-height:\s*44px/s);
    expect(block).toMatch(/\.swatch,[^}]*width:\s*44px/s);
    expect(block).toMatch(/\.cal-row__more,[^}]*width:\s*44px/s);
    expect(block).toMatch(/\.switch[^}]*min-height:\s*44px/s);
  });

  it('≤720：编辑器「日历」下拉是全屏列表（含标题与关闭）', () => {
    const block = mediaBlock(720);
    expect(block).toMatch(/\.cal-select__list[^}]*position:\s*fixed/s);
    expect(block).toMatch(/\.cal-select__list[^}]*inset:\s*0/s);
    expect(block).toContain('.cal-select__mobile-head');
  });

  it('≤720：任务栏全屏抽屉、搜索面板全屏', () => {
    const block = mediaBlock(720);
    expect(block).toContain('.taskbar');
    expect(block).toMatch(/\.taskbar[^}]*width:\s*100%/s);
    expect(block).toContain('.search__panel');
    expect(block).toMatch(/\.search__panel[^}]*height:\s*100%/s);
  });

  it('≤520：设置弹窗字段单列', () => {
    const block = mediaBlock(520);
    expect(block).toContain('.settings__row');
    expect(block).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});

describe('移动端抽屉开合', () => {
  let app;
  let root;

  function makeStore() {
    const settings = { ...DEFAULT_SETTINGS, defaultView: 'month' };
    const listeners = new Set();
    return {
      getSettings: () => ({ ...settings }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      saveSettings: async (patch) => Object.assign(settings, patch),
      getAllEvents: () => [],
      getEventsInRange: () => [],
      getAllTasks: () => [],
      getTasksInRange: () => [],
      getEvent: () => null,
      getTask: () => null,
      getCalendars: () => [
        { id: 'default', displayName: '我的日历', type: 'vevent', visible: true, order: 0 },
        { id: 'tasks', displayName: '任务', type: 'vtodo', visible: true, order: 1 },
      ],
      getCalendar: (id) => ({ id, displayName: id, type: id === 'tasks' ? 'vtodo' : 'vevent' }),
      getTaskCalendars: () => [{ id: 'tasks', displayName: '任务', type: 'vtodo' }],
      isCalendarVisible: () => true,
      toggleTask: async () => {},
    };
  }

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'alice' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    document.body.replaceChildren();
  });

  it('侧栏抽屉：菜单按钮开、Esc 关、焦点回到按钮', () => {
    const shell = document.querySelector('.app');
    const menu = document.querySelector('.menu-toggle');
    expect(shell.classList.contains('sidebar-open')).toBe(false);
    menu.click();
    expect(shell.classList.contains('sidebar-open')).toBe(true);
    expect(document.querySelector('.scrim')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.classList.contains('sidebar-open')).toBe(false);
    expect(document.activeElement).toBe(menu);
  });

  it('任务栏在窄屏是抽屉：开关切换 has-taskbar 并带遮罩', () => {
    const shell = document.querySelector('.app');
    const toggle = document.querySelector('.taskbar-toggle');
    const taskbar = document.querySelector('#taskbar');
    expect(taskbar.hidden).toBe(true);
    toggle.click();
    expect(shell.classList.contains('has-taskbar')).toBe(true);
    expect(taskbar.hidden).toBe(false);
    expect(document.querySelector('.taskbar-scrim').hidden).toBe(false);
    document.querySelector('.taskbar__close').click();
    expect(taskbar.hidden).toBe(true);
  });
});
