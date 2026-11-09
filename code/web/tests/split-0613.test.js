/**
 * 0.6.13 A（源码层）：首包拆分。
 *
 *   - `search.js`、`proposals-panel.js`、`ai-settings.js` 不再静态 import；
 *   - 三个入口都有动态 `import()`，且懒加载期间有加载态（骨架 / aria-busy）；
 *   - `modal.js` 仍静态加载（月视图点事件立刻弹详情，拆出去会多一次网络等待）。
 *
 * 构建产物体积由 `vite build` 实测（记录里有表），这里只锁源码结构，避免回归。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'js');
const read = (name) => readFileSync(path.join(SRC, name), 'utf8');

describe('0.6.13 首包拆分（源码结构）', () => {
  it('app.js 不静态 import 搜索与提案面板，改为动态 import', () => {
    const app = read('app.js');
    expect(app).not.toContain("from './search.js'");
    expect(app).not.toContain("from './proposals-panel.js'");
    expect(app).toContain("import('./search.js')");
    expect(app).toContain("import('./proposals-panel.js')");
  });

  it('搜索懒加载有骨架/占位，失败有提示；提案面板有 aria-busy 与骨架', () => {
    const app = read('app.js');
    expect(app).toContain('searchPromise');
    expect(app).toContain("toast(t('search.loadFailed')");
    expect(app).toContain('proposalsSkeleton');
    expect(app).toMatch(/aria-busy': 'true'/);
    expect(app).toContain("t('proposals.loadFailed')");
  });

  it('account-dialog.js 不静态 import AI 页，切到 AI 页签时动态 import 并显示骨架', () => {
    const account = read('account-dialog.js');
    expect(account).not.toContain("from './ai-settings.js'");
    expect(account).toContain("import('./ai-settings.js')");
    expect(account).toContain('aiSkeleton');
    expect(account).toContain("t('settings.ai.loadFailed')");
  });

  it('modal.js 仍静态加载（不拆）', () => {
    const app = read('app.js');
    expect(app).toContain("import { createEventModal } from './modal.js';");
  });
});
