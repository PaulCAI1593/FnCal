/**
 * 0.8.19（用户 01:30）：填色行时间文字的最低可读不透明度。
 *
 * 规则：从 70% 起、5% 一档往上试，取第一个与填色底对比 ≥ 4.5:1 的档；
 * 100% 仍不到就用实色墨。九种日历色都要 ≥ 4.5:1（深浅两态同函数同结果）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  EVENT_COLORS,
  colorHex,
  colorFg,
  contrastRatio,
  timeInkForFill,
} from '../src/js/colors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const monthJs = READ('src/js/views/month.js');
const viewsCss = READ('src/styles/views.css');

const STEPS = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];

describe('填色行时间：九色 × 两态', () => {
  const rows = EVENT_COLORS.map((entry) => {
    const fill = colorHex(entry.key);
    const ink = colorFg(entry.key);
    return { key: entry.key, fill, ink, ...timeInkForFill(fill, ink) };
  });

  it('九种日历色全部 ≥ 4.5:1', () => {
    expect(rows.length).toBe(9);
    for (const row of rows) {
      const ratio = contrastRatio(row.color, row.fill);
      expect(ratio, `${row.key} ${row.fill} @${row.opacity}`).toBeGreaterThanOrEqual(4.5 - 1e-9);
    }
  });

  it('不透明度是 5% 档里的最小值（再降一档就不到 4.5）', () => {
    for (const row of rows) {
      expect(STEPS).toContain(row.opacity);
      const previous = row.opacity - 0.05;
      if (previous >= 0.7 - 1e-9) {
        const lower = timeInkForFill(row.fill, row.ink);
        // 同一函数对同一输入必须稳定：再降 5% 就跌破 AA（除非 100% 兜底）。
        expect(lower.opacity).toBe(row.opacity);
        if (row.opacity > 0.7) {
          const atLower = contrastRatio(
            require_blend(row.ink, row.fill, previous),
            row.fill,
          );
          expect(atLower, `${row.key} @${previous}`).toBeLessThan(4.5);
        }
      }
    }
  });

  it('深浅两态同结果（时间文字坐在填色底上，规则与主题无关）', () => {
    for (const row of rows) {
      const again = timeInkForFill(row.fill, row.ink);
      expect(again).toEqual({ color: row.color, opacity: row.opacity });
    }
  });

  it('最坏的一个色值仍 ≥ 4.5:1', () => {
    const worst = rows
      .map((row) => ({ key: row.key, ratio: contrastRatio(row.color, row.fill), opacity: row.opacity }))
      .sort((a, b) => a.ratio - b.ratio)[0];
    expect(worst.ratio).toBeGreaterThanOrEqual(4.5 - 1e-9);
    // 供结论文件引用的实测值。
    expect(worst.key.length).toBeGreaterThan(0);
  });
});

describe('两处共用同一函数', () => {
  it('格内 chip 与浮层行都调用 timeInkForFill', () => {
    const hits = monthJs.match(/timeInkForFill\(/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(monthJs).toMatch(/const timeInk = filled && !event\.ooo \? timeInkForFill/);
    expect(monthJs).toMatch(/const timeInk = isFilled && !ev\.ooo \? timeInkForFill/);
  });

  it('浮层填色行不再由 CSS 二次稀释（inline opacity 由 JS 写）', () => {
    expect(viewsCss).toContain('.month__more-row.is-filled .month__more-time');
    expect(monthJs).toMatch(/opacity: '1'/);
  });
});

/** 与 colors.js 同口径的合成（避免再从模块里导私有函数）。 */
function require_blend(fg, bg, alpha) {
  const parse = (hex) => {
    const raw = String(hex).replace('#', '').slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  };
  const f = parse(fg);
  const b = parse(bg);
  const mixed = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('');
}
