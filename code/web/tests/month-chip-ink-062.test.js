import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colorFg, colorHex, contrastRatio, EVENT_COLORS, inkForFill } from '../src/js/colors.js';

/**
 * 0.6.2（用户：「有些是白色的……，有些黑色的，不统一」）
 *
 * 9/8、9/30 两条浅色跨天 chip 的「…」是白的，同页别的 chip 是深色。根因是
 * `colorFg()` 用未做 gamma 校正的平均亮度 + 0.62 阈值：#E8A0BF 的加权平均是
 * 0.696（判成白字），但白字实际只有 2.06:1，未达 WCAG 4.5:1。
 *
 * 本文件锁住三件事：
 * 1. 实色底的墨色按 WCAG 2.1 相对亮度取，对比度 ≥ 4.5:1；
 * 2. 浅色 / 中间调一律深墨，不出现白字；
 * 3. 调色板各色的既有墨色都不低于 4.5:1（同类一致）。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const viewsCss = readFileSync(path.join(HERE, '..', 'src/styles/views.css'), 'utf8');

describe('0.6.2 跨天 chip 墨色：按合成后实色算 WCAG，同类一致', () => {
  it('复现旧阈值的问题：#E8A0BF 上的白字只有约 2:1', () => {
    expect(contrastRatio('#ffffff', '#E8A0BF')).toBeLessThan(4.5);
    expect(contrastRatio('#ffffff', '#E8A0BF')).toBeGreaterThan(1.9);
  });

  it('四种代表色取墨后都 ≥ 4.5:1', () => {
    const cases = [
      { fill: '#F8BBD0', ink: '#101216', label: '浅粉' },
      { fill: '#E8A0BF', ink: '#101216', label: '中间粉' },
      { fill: colorHex('orange'), ink: '#101216', label: '调色板橙' },
      { fill: colorHex('pink'), ink: '#ffffff', label: '调色板粉' },
    ];
    for (const item of cases) {
      const ink = item.fill === colorHex('orange')
        ? colorFg('orange')
        : item.fill === colorHex('pink')
          ? colorFg('pink')
          : inkForFill(item.fill);
      expect(ink, item.label).toBe(item.ink);
      expect(contrastRatio(ink, item.fill), item.label).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('浅色 / 中间调一律深墨，不许出现白字', () => {
    for (const fill of ['#F8BBD0', '#E8A0BF', '#FDE68A', '#BFDBFE']) {
      expect(inkForFill(fill), fill).toBe('#101216');
      expect(contrastRatio('#ffffff', fill), fill).toBeLessThan(4.5);
    }
  });

  it('调色板各色的墨色都 ≥ 4.5:1，且同色固定同一墨色', () => {
    for (const entry of EVENT_COLORS) {
      expect(contrastRatio(entry.fg, entry.hex), entry.key).toBeGreaterThanOrEqual(4.5);
      expect(colorFg(entry.key), entry.key).toBe(entry.fg);
      expect(colorFg(entry.hex), entry.key).toBe(entry.fg);
    }
  });

  it('自定义色无论深浅都取对比度更高的一方（不会两边都低）', () => {
    for (const fill of ['#000000', '#0f172a', '#f8fafc', '#7c3aed', '#94a3b8']) {
      const ink = inkForFill(fill);
      const other = ink === '#ffffff' ? '#101216' : '#ffffff';
      expect(contrastRatio(ink, fill), fill).toBeGreaterThanOrEqual(contrastRatio(other, fill));
    }
  });

  it('CSS：跨天实色段用 --ev-fg，单日 16% 混色段不写白字', () => {
    // 跨天段：实色底 + 变量墨色（nullish 兜底不能是会让白字漏出的写死值）
    const spanRule = viewsCss.match(/\.chip\.chip--span-[a-z]+[^{]*\{[^}]*\}/g) || [];
    expect(spanRule.length).toBeGreaterThan(0);
    expect(viewsCss).toMatch(/color:\s*var\(--ev-fg,\s*#101216\)/);
    // 单日 16% 混色段：文字用默认 --text / --text-3，不出现 #fff / #ffffff
    const mixRule = viewsCss.match(/\.chip \{[^}]*background:[^}]*\}/g) || [];
    expect(mixRule.length).toBeGreaterThan(0);
    expect(viewsCss).not.toMatch(/--ev-fg[^;]*#fff\b/i);
  });
});
