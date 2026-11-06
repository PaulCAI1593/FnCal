// 0.5.3 屏幕适配（S1–S4）：把四条修复的关键 CSS/JS 形状钉住，防止以后回退。
// 这些断言只读源码文本（与既有 CSS 形状类测试同口径），不做像素断言；
// 像素级验证见 code/web/build-tmp/harness-053/reports/ 与记录 §5。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.resolve(here, '..', rel), 'utf8');
const calendarCss = read('src/styles/calendar.css');
const viewsCss = read('src/styles/views.css');
const layoutCss = read('src/styles/layout.css');
const appJs = read('src/js/app.js');

const block = (css, selector) => {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
};

// calendar.css 里有多个 @media (pointer: coarse) 块；返回「包含目标选择器的那个」块，
// 而不是简单取最后一个（否则拿到的可能是页签等其它粗指针规则）。
const coarseBlockContaining = (css, selector) => {
  const marker = '@media (pointer: coarse)';
  let from = 0;
  for (;;) {
    const start = css.indexOf(marker, from);
    if (start < 0) return '';
    const open = css.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = css.slice(open, end + 1);
    if (body.includes(selector)) return body;
    from = end + 1;
  }
};

describe('0.5.3 屏幕适配', () => {
  it('S1：触屏不再把迷你月历日期格抬到 44px（7 列会溢出侧栏）', () => {
    // 触屏块里不能有 .mini__cell 的最小高度；日期格保持 aspect-ratio:1 的方格。
    const coarseBlock = coarseBlockContaining(calendarCss, '.mini__cell');
    expect(coarseBlock).not.toBe('');
    expect(coarseBlock).not.toMatch(/\.mini__cell\s*\{[^}]*min-height:\s*44px/);
    expect(block(layoutCss, '.mini__cell')).toContain('aspect-ratio: 1');
  });

  it('S2：触屏开关只扩命中区，不改 40×24 的视觉尺寸', () => {
    const coarseBlock = coarseBlockContaining(calendarCss, '.switch input');
    expect(coarseBlock).not.toBe('');
    // 旧写法（把 .switch 抬到 min-height:44px）已被移除
    expect(coarseBlock).not.toMatch(/\.switch\s*\{[^}]*min-height:\s*44px/);
    // 命中层外扩到 44×44（40+2×2 × 24+2×10）
    expect(coarseBlock).toMatch(/\.switch input\s*\{[^}]*inset:\s*-10px\s+-2px/);
    // 命中层下沿不压住紧跟其后的提示文字
    expect(coarseBlock).toMatch(/\.settings__control\s*>\s*\.switch\s*\+\s*\.settings__hint\s*\{[^}]*margin-top:\s*10px/);
  });

  it('S3：≤720px 年视图保留多日胶囊，只有 .year--compact 才隐藏', () => {
    expect(viewsCss).not.toMatch(/@media \(max-width: 720px\)\s*\{[^}]*\.year__bar\s*\{\s*display:\s*none/);
    expect(block(viewsCss, '.year--compact .year__bar')).toContain('display: none');
  });

  it('0.5.4（U2/U4/U6）：≤520 保留 logo 与标题、齿轮仍隐藏，顶栏「今天」由底栏接管', () => {
    // 0.5.9（S4）口径变更：views.css 现在有多段 `@media (max-width: 520px)`（新增的
    // 月视图/日程紧凑段在文件末尾），旧的「取最后一段」会取到日程段、把顶栏规则漏掉。
    // 改成取**包含 .header__settings 的那一段**，断言内容本身不变。
    let idx = -1;
    for (let at = viewsCss.indexOf('@media (max-width: 520px)'); at > -1; at = viewsCss.indexOf('@media (max-width: 520px)', at + 1)) {
      if (viewsCss.slice(at, at + 6000).includes('.header__settings')) idx = at;
    }
    expect(idx).toBeGreaterThan(-1);
    const narrow = viewsCss.slice(idx, idx + 6000);
    // 0.5.3 曾在本档隐藏品牌标与标题、把宽度让给「今天」；0.5.4 U2/U4 反过来：
    // 标题常驻（省略号收缩）、logo 作侧栏开关，因此这两条断言按新口径改写。
    expect(narrow).not.toMatch(/\.header__brand\s*\{\s*display:\s*none/);
    expect(narrow).not.toMatch(/\.header__title\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.header__settings\s*\{\s*display:\s*none/);
    // U6：≤720 顶栏「今天」整体隐藏（底栏 `.tabbar__today` 接管）。
    expect(viewsCss).toMatch(
      /@media \(max-width: 720px\)\s*\{[\s\S]*?\.header__today\s*\{\s*display:\s*none/,
    );
  });

  it('S4：齿轮按钮有可隐藏的类名，窄屏设置入口走头像菜单（仅 ≤520）', () => {
    expect(appJs).toMatch(/class:\s*'icon-btn header__settings'/);
    expect(appJs).toMatch(/matchMedia\('\(max-width: 520px\)'\)/);
    expect(appJs).toMatch(/settingsEntry\(\)/);
    // 菜单项只在窄屏出现：条件命中才返回节点
    expect(appJs).toMatch(/narrowHeaderQuery\s*&&\s*narrowHeaderQuery\.matches\s*\?/);
  });
});
