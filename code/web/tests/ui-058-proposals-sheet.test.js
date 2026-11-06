/**
 * 0.5.8 手机提案浮层：底边锚定、向上展开（静态防回退断言）。
 *
 * 背景：底栏铃铛的浮层原来按 top = 铃铛顶 − 面板高 − 8 定位，面板刚挂载时高度还没
 * 算完（提案列表异步填充），top 偏下，长高后一路向下压，手机上看着贴在屏幕下半截。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(path.join(HERE, '..', 'src/js/app.js'), 'utf8');

describe('0.5.8 手机提案浮层', () => {
  it('底栏铃铛走 bottom 锚定 + 最大高度，向上生长', () => {
    const openStart = appJs.indexOf('function openProposalsPanel(');
const open = appJs.slice(openStart, openStart + 6000);
    expect(open).toMatch(/if \(bottomMode\) \{/);
    expect(open).toMatch(/box\.style\.bottom = /);
    expect(open).toMatch(/box\.style\.maxHeight = /);
    // 旧口径：拿尚未算完的 offsetHeight 反推 top
    expect(open).not.toMatch(/rect\.top - box\.offsetHeight/);
  });

  it('0.5.10 S4：底边与铃铛/底栏留 16px，maxHeight 同步多留 8px', () => {
    // 0.5.10（用户 2026-11-06）：「提案列表底部稍微和底栏空开一点距离」——8 → 16px。
    const openStart = appJs.indexOf('function openProposalsPanel(');
    const open = appJs.slice(openStart, openStart + 6000);
    expect(open).toMatch(/window\.innerHeight - rect\.top \+ 16/);
    expect(open).toMatch(/Math\.max\(16, window\.innerHeight - rect\.top \+ 16\)/);
    expect(open).toMatch(/rect\.top - 24/);
    // 旧的 8px 留距不得残留
    expect(open).not.toMatch(/window\.innerHeight - rect\.top \+ 8\b/);
  });

  it('顶栏铃铛仍向下弹（top 定位保留）', () => {
    const openStart = appJs.indexOf('function openProposalsPanel(');
const open = appJs.slice(openStart, openStart + 6000);
    expect(open).toMatch(/box\.style\.top = /);
    expect(open).toMatch(/rect\.bottom \+ 8/);
  });
});
