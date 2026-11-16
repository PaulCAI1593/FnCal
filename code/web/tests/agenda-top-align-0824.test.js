/**
 * 0.8.24（用户 m01043，总监 m02982 / m02983）：日程行顶部对齐。
 *   时间列两行都取 20px 行盒，首行文字顶与标题文字顶差 ≤1px；
 *   圆点在首行里居中（10px + 5px 上边距，360 档 4px）；
 *   ≤520 行内上下内距各收 2px 把净行高压到 +8 以内；行高不低于 44；
 *   0.8.23 的竖线水平居中不被改坏。
 * 0.8.26（用户 m01209，总监 m03145）：结束行不再留 6px、地址与结束行同 20px 行盒，
 *   竖线改从首行行盒底边上移 1px 起画（`calc(100% - 1px)`），上下空隙相等。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');

function rule(selector) {
  const at = viewsCss.indexOf(selector);
  expect(at, `missing ${selector}`).toBeGreaterThan(-1);
  return viewsCss.slice(at, viewsCss.indexOf('}', at));
}

const AGENDA_520_AT = viewsCss.lastIndexOf(
  '@media (max-width: 520px)',
  viewsCss.indexOf('.agenda__event-main {\n    grid-template-columns: minmax(0, 1fr);'),
);
const MEDIA_520 = viewsCss.slice(
  AGENDA_520_AT,
  viewsCss.indexOf('@media (max-width: 360px)', AGENDA_520_AT),
);
const MEDIA_360 = viewsCss.slice(viewsCss.lastIndexOf('@media (max-width: 360px)'));

describe('0.8.24 日程行顶部对齐', () => {
  it('行容器改为顶部对齐，不再垂直居中', () => {
    const base = rule('.agenda__event {');
    expect(base).toMatch(/align-items:\s*flex-start;/);
    expect(base).not.toMatch(/align-items:\s*center;/);
  });

  it('时间列首行行盒 20px，两行时间（stack）与宽屏两行（stacked）同样 20px', () => {
    expect(rule('.agenda__event-time {')).toMatch(/line-height:\s*20px;/);
    expect(rule('.agenda__event-time--stack {')).toMatch(/line-height:\s*20px;/);
    expect(rule('.agenda__event-time--stacked {')).toMatch(/line-height:\s*20px;/);
  });

  it('圆点与飞机图标跟首行：flex-start + 5px 上边距，旗子不覆盖上边距', () => {
    const shared = viewsCss.slice(
      viewsCss.indexOf('.agenda__event-dot,\n.agenda__event-icon {'),
      viewsCss.indexOf('}', viewsCss.indexOf('.agenda__event-dot,\n.agenda__event-icon {')),
    );
    expect(shared).toMatch(/align-self:\s*flex-start;/);
    expect(shared).toMatch(/margin-top:\s*5px;/);
    expect(rule('.agenda__event--holiday .agenda__event-icon')).toMatch(/margin:\s*5px -3px 0;/);
  });

  it('≤520 行内上下内距各收 2px（8 → 6），360 档 shorthand 同样 6px', () => {
    expect(MEDIA_520).toMatch(/\.agenda__event {\s*padding-top:\s*6px;\s*padding-bottom:\s*6px;/);
    expect(MEDIA_360).toMatch(/\.agenda__event {\s*gap:\s*var\(--sp-2\);\s*\/\*[\s\S]*?\*\/\s*padding:\s*6px var\(--sp-2\);/);
  });

  it('360 档 10px 字号用 18px 行盒，圆点/图标边距 4px（含带地址行）', () => {
    expect(MEDIA_360).toMatch(/\.agenda__event-time {\s*width:\s*36px;\s*font-size:\s*10px;[\s\S]{0,200}line-height:\s*18px;/);
    expect(MEDIA_360).toMatch(/\.agenda__event-dot,\s*\.agenda__event-icon,[\s\S]{0,160}margin-top:\s*4px;/);
  });

  it('竖线挂在开始时间冒号上：冒号中心为锚点，0.8.26 起 `100% - 1px` 画在两行文字空隙里', () => {
    const colon = rule('.agenda__event-time-colon {');
    expect(colon).toMatch(/display:\s*inline-block;/);
    expect(colon).toMatch(/height:\s*20px;/);
    const line = viewsCss.slice(
      viewsCss.indexOf('.agenda__event-time-colon::after'),
      viewsCss.indexOf('}', viewsCss.indexOf('.agenda__event-time-colon::after')),
    );
    expect(line).toMatch(/left:\s*50%;/);
    // 0.8.26（总监 m03145）：结束行不再留 6px，竖线从行盒底边上移 1px 起画。
    expect(line).toMatch(/top:\s*calc\(100% - 1px\);/);
    expect(line).toMatch(/translateX\(-50%\);/);
    // 0.8.25（用户 m01163，总监 m03093）：线高 6 → 4，行距 8 → 6（1 + 4 + 1）。
    expect(line).toMatch(/height:\s*4px;/);
    // 0.8.26：结束行 6px → 0，与右侧地址同一行盒节奏。
    expect(rule('.agenda__event-time--stack > .agenda__event-time-end {')).toMatch(/margin-top:\s*0;/);
  });
});
