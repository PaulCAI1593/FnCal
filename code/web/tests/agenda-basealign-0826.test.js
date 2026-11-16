/**
 * 0.8.26（用户 m01209，总监 m03145）：手机档「结束时间」与右侧「地址」共用同一 20px
 * 行盒、文字底齐平；竖线改从首行行盒底边上移 1px 起画，落在两行文字空隙里、上下等距。
 *
 * 真因：结束行 `margin-top: 6px` + 名称区 `row-gap: 2px` 把结束时间压到地址下方约
 * 6.7px，竖线看着被往下拉、下面空隙比上面大。
 * 修法（仅 ≤520）：结束行 `margin-top: 0`、名称区 `row-gap: 0`、地址 `line-height: 20px`
 * + `margin-top: 0`；≤360 档时间列两行各 18px，地址行盒取 16px（20 + 16 = 36）才齐平。
 * 桌面 >520 一律不动。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');

const MEDIA_520_AT = viewsCss.lastIndexOf(
  '@media (max-width: 520px)',
  viewsCss.lastIndexOf('@media (max-width: 360px)'),
);
const MD520 = viewsCss.slice(MEDIA_520_AT);
const MEDIA_360 = viewsCss.slice(viewsCss.lastIndexOf('@media (max-width: 360px)'));

function block(css, selector) {
  const at = css.indexOf(selector);
  expect(at, `missing ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('0.8.26 结束时间与地址底对齐', () => {
  it('≤520：名称区两行与时间列两行同节奏，去掉 2px 行间距', () => {
    const main = block(MD520, '.agenda__event-main {');
    expect(main).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(main).toMatch(/row-gap:\s*0;/);
  });

  it('≤520：地址与结束时间同为 20px 行盒、地址去掉 2px 上边距', () => {
    const loc = block(MD520, '.agenda__event-location {');
    expect(loc).toMatch(/grid-row:\s*2;/);
    expect(loc).toMatch(/line-height:\s*20px;/);
    expect(loc).toMatch(/margin-top:\s*0;/);
  });

  it('结束行不再留 6px，直接接在开始行下一行', () => {
    const end = block(MD520, '.agenda__event-time--stack > .agenda__event-time-end {');
    expect(end).toMatch(/display:\s*block;/);
    expect(end).toMatch(/line-height:\s*20px;/);
    expect(end).toMatch(/margin-top:\s*0;/);
  });

  it('≤360：时间列两行各 18px，地址行盒取 16px（20 + 16 = 36）才与结束时间齐平', () => {
    const loc = block(MEDIA_360, '.agenda__event-location {');
    expect(loc).toMatch(/line-height:\s*16px;/);
    // 这一档标题行盒仍是 20px（由 0.8.24 那条契约守）。
    expect(viewsCss).toMatch(/\.agenda__event-title \{[\s\S]{0,200}line-height:\s*20px;/);
  });

  it('桌面 >520 不受影响：地址仍是 11px / 1.35 行高 + 2px 上边距', () => {
    const base = viewsCss.slice(
      viewsCss.indexOf('.agenda__event-location {'),
      viewsCss.indexOf('}', viewsCss.indexOf('.agenda__event-location {')),
    );
    expect(base).toMatch(/margin-top:\s*2px;/);
    expect(base).toMatch(/line-height:\s*1\.35;/);
  });
});
