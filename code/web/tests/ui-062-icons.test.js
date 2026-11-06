// 0.5.11 S5（用户）：「今天 / 周 / 月的图标做个区分，不要用一样的」。
// 六项视图图标 + 「今天」必须互不相同，且沿用 24×24 线稿 / currentColor / 单色。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon } from '../src/js/icons.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(path.join(HERE, '..', 'src/js/app.js'), 'utf8');
const iconsJs = readFileSync(path.join(HERE, '..', 'src/js/icons.js'), 'utf8');

const VIEW_ICONS = {
  year: 'grid',
  month: 'view-month',
  week: 'view-week',
  '4day': 'columns',
  day: 'clock',
  agenda: 'align-left',
};

describe('0.5.11 S5：今天 / 月 / 周图标区分', () => {
  it('tabIcon 六项映射：月用 view-month、周用 view-week，其余不变', () => {
    const at = appJs.indexOf('function tabIcon(key)');
    const body = appJs.slice(at, appJs.indexOf('}\n', at));
    const map = {};
    for (const m of body.matchAll(/'?([a-z0-9]+)'?:\s*'([a-z-]+)'/g)) map[m[1]] = m[2];
    expect(map).toEqual(VIEW_ICONS);
  });

  it('六项图标名互不相同，且「今天」的 calendar-today 不在其中', () => {
    const names = Object.values(VIEW_ICONS);
    expect(new Set(names).size).toBe(6);
    expect(names).not.toContain('calendar-today');
    // 底栏「今天」用 calendar-today（与桌面今天按钮同一枚）。
    const todayAt = appJs.indexOf("class: 'tabbar__btn tabbar__today'");
    expect(todayAt).toBeGreaterThan(-1);
    const btn = appJs.slice(todayAt, todayAt + 400);
    expect(btn).toContain("icon('calendar-today', { size: 'sm' })");
    // 旧的「月=calendar / 周=calendar-blank」不再出现在 tabIcon 里。
    expect(bodyOfTabIcon(appJs)).not.toMatch(/calendar/);
  });

  it('新图标：24×24 网格上的 view-month（3×3 点）与 view-week（7 条竖线）', () => {
    const month = icon('view-month');
    const week = icon('view-week');
    expect(month).toContain('viewBox="0 0 24 24"');
    expect(week).toContain('viewBox="0 0 24 24"');
    // 月：日历框 + 3×3 = 9 个实心点（fill=currentColor）。
    expect((month.match(/fill="currentColor"/g) || []).length).toBe(9);
    expect(month).toContain('y="12.5"');
    expect(month).toContain('y="15.5"');
    expect(month).toContain('y="18.5"');
    // 周：7 条竖线，x 从 6 到 18，同一段 y。
    const verticals = [...week.matchAll(/<line x1="(\d+)" y1="12" x2="\1" y2="18\.5"/g)].map((m) => m[1]);
    expect(verticals).toEqual(['6', '8', '10', '12', '14', '16', '18']);
  });

  it('线稿口径：currentColor、无彩色/无第三方图标、wrapper 仍是 24×24 stroke', () => {
    for (const name of ['view-month', 'view-week']) {
      const html = icon(name);
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-linecap="round"');
      expect(html).toContain('stroke-linejoin="round"');
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
      expect(html).not.toMatch(/rgb\(/);
    }
    const monthBody = iconsJs.slice(iconsJs.indexOf("'view-month':"), iconsJs.indexOf("'view-week':"));
    expect(monthBody).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    // wrapper 不变：stroke-width 仍是既有 2（全局改会动到所有既有图标，本版不动）。
    expect(iconsJs).toContain('stroke-width="2"');
  });
});

function bodyOfTabIcon(src) {
  const at = src.indexOf('function tabIcon(key)');
  return src.slice(at, src.indexOf('\n}', at));
}
