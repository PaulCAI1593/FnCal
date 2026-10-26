/**
 * 0.2.32（L1）：年视图里**非本月的日期不再显示日号**，只留空格子。
 *
 * 真机依据：用户 m01515 原话「年视图里不是该月的日期就留空吧，不显示数字了」，
 * 并且截图上用红框圈出的正是月卡首/末行那些「上月末 / 下月初」的灰色数字
 * （如 4 月卡首行的 29 30 31、2 月卡末行的 1 2 3 …）。
 *
 * 这里锁四件事：
 *   A. 相邻月份的格子仍然占位（.year__day.is-muted，数量与 7 的整数倍一致），
 *      否则月卡的行首会错位、日期和星期对不上；
 *   B. 这些格子**没有任何文字**（textContent 为空），也没有 .year__daynum 子节点；
 *   C. 本月格子不受影响：仍然有 .year__daynum，日号与真实日期一致；
 *   D. CSS 几何不受影响：.year__day 仍是 aspect-ratio: 1（空格子不改高度），
 *      且 .is-muted 只做降色、不靠 ::before/::after 补内容。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderYear } from '../src/js/views/year.js';
import { DEFAULT_SETTINGS as SETTINGS } from '../src/js/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const READ = (rel) => strip(readFileSync(path.join(WEB_ROOT, rel), 'utf8'));

const viewsCss = READ('src/styles/views.css');
const yearJs = READ('src/js/views/year.js');

afterEach(() => {
  document.body.innerHTML = '';
});

function renderYearView() {
  return renderYear({
    store: {
      getEventsInRange: () => [],
      getTasksInRange: () => [],
      getEvent: () => null,
      getSettings: () => ({ hour12: false }),
      getAllEvents: () => [],
      getAllTasks: () => [],
    },
    settings: { ...SETTINGS, weekStartsOn: 0 },
    cursor: new Date(2026, 7, 16),
    now: new Date(2026, 7, 16),
    actions: {},
  });
}

/** 12 个月卡，按 1 月…12 月排列。 */
function monthCards(root) {
  const cards = [...root.querySelectorAll('.year__month')];
  expect(cards.length).toBe(12);
  return cards;
}

function mountYear() {
  const view = renderYearView();
  document.body.append(view.node);
  return view.node;
}

describe('0.2.32 L1：年视图非本月日期留空', () => {
  it('A. 相邻月份格子仍占位：每卡格子数是 7 的整数倍，muted 格子存在', () => {
    const cards = monthCards(mountYear());
    for (const [index, card] of cards.entries()) {
      const cells = [...card.querySelectorAll('.year__day')];
      expect(cells.length % 7, `month ${index + 1} cells=${cells.length}`).toBe(0);
      expect(cells.length).toBeGreaterThanOrEqual(35);
      // 2 月（28 天）必然有首/末行的相邻月格子；其余月多数也有。
      const muted = cells.filter((cell) => cell.classList.contains('is-muted'));
      if (index === 1) expect(muted.length).toBeGreaterThan(0);
    }
  });

  it('B. 相邻月份格子没有任何文字，也没有 .year__daynum 子节点', () => {
    const cards = monthCards(mountYear());
    let checked = 0;
    for (const card of cards) {
      for (const cell of card.querySelectorAll('.year__day.is-muted')) {
        expect(cell.textContent, 'muted cell must be blank').toBe('');
        expect(cell.querySelector('.year__daynum')).toBeNull();
        expect(cell.getAttribute('aria-hidden')).toBe('true');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('C. 本月格子不受影响：仍有 .year__daynum，且日号与 1..N 对应', () => {
    const cards = monthCards(mountYear());
    // 2 月 2026：28 天，本格数字集合应为 1..28 各一次。
    const feb = cards[1];
    const nums = [...feb.querySelectorAll('.year__daynum')].map((node) => node.textContent.trim());
    expect(nums.length).toBe(28);
    expect(new Set(nums).size).toBe(28);
    expect(nums).toContain('1');
    expect(nums).toContain('28');
    // 8 月 2026：31 天。
    const augNums = [...cards[7].querySelectorAll('.year__daynum')].map((node) => node.textContent.trim());
    expect(augNums.length).toBe(31);
    expect(augNums).toContain('31');
  });

  it('D. 代码与 CSS：muted 分支不再写 text；几何与降色保持不变', () => {
    // 相邻月份分支里不再把日号塞进单元格。
    expect(yearJs).toMatch(/class: 'year__day is-muted', 'aria-hidden': 'true' \}/);
    expect(yearJs).not.toMatch(/class: 'year__day is-muted', 'aria-hidden': 'true', text:/);
    expect(viewsCss).toMatch(/\.year__day \{[^}]*aspect-ratio: 1;/);
    const mutedRule = /\.year__day\.is-muted \{([^}]*)\}/.exec(viewsCss);
    expect(mutedRule, 'missing .year__day.is-muted').toBeTruthy();
    expect(mutedRule[1]).not.toMatch(/content:/);
  });
});
