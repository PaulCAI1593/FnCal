/**
 * 0.5.6 手机端四项交互修正（A–D）静态防回退断言。
 *
 * 与 `ui-054-mobile-nav.test.js` 同口径：只读源码文本锁实现形状；真机数字在
 * `code/M5-0.5.6-手机交互修正-记录.md`。覆盖：
 *   A 底栏「任务」第二次点击退回进入前视图；
 *   B 六个视图在触屏窄屏都能横滑切周期（含 pointercancel 路径）；
 *   C 日程列表顶部下拉加载更早（按钮兜底、加载锁、到底静态文案）；
 *   D logo 在手机上开合抽屉（click 主路径 + pointerup 兜底）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(HERE, '..', p), 'utf8');

const appJs = read('src/js/app.js');
const swipeJs = read('src/js/swipe-nav.js');
const agendaJs = read('src/js/views/agenda.js');
const layoutCss = read('src/styles/layout.css');
const viewsCss = read('src/styles/views.css');
const i18n = read('src/i18n/zh-CN.js');

describe('0.5.6 手机交互修正', () => {
  it('A：再点「任务」退回进入前的视图，桌面仍走任务栏开关', () => {
    // state 记录进入前的视图
    expect(appJs).toMatch(/tasksReturnView:\s*null/);
    // 桌面行为不变：仍在窄屏判断前分流到 toggleTaskbar()
    const entry = appJs.slice(appJs.indexOf('function toggleTaskEntry()'), appJs.indexOf('function focusTasksHeading()'));
    expect(entry).toMatch(/if \(!narrowSearchMedia\.matches\)\s*\{\s*toggleTaskbar\(\)/);
    expect(entry).toMatch(/state\.tasksReturnView\s*=\s*state\.view/);
    // 退出分支：恢复视图 + 清记录 + 重渲染（不再只把焦点丢到标题就 return）
    expect(entry).toMatch(/const back = state\.tasksReturnView \|\| state\.view;/);
    expect(entry).toMatch(/state\.tasksView\s*=\s*false;[\s\S]{0,120}state\.tasksReturnView\s*=\s*null;/);
    expect(entry).toMatch(/state\.view\s*=\s*back;[\s\S]{0,80}render\(\);/);
  });

  it('B：pointercancel 路径按最后一次 pointermove 判定，不再直接丢弃手势', () => {
    expect(swipeJs).toMatch(/export function cancelIntent\(/);
    expect(swipeJs).toMatch(/SWIPE_CANCEL_MIN_DX\s*=\s*60/);
    expect(swipeJs).toMatch(/SWIPE_CANCEL_AXIS_RATIO\s*=\s*2/);
    expect(swipeJs).toMatch(/window\.addEventListener\('pointermove'/);
    expect(swipeJs).toMatch(/window\.addEventListener\('pointercancel'/);
    const cancel = swipeJs.slice(swipeJs.indexOf('function onPointerCancel()'), swipeJs.indexOf('function attach('));
    expect(cancel).toMatch(/fire\(cancelIntent\)/);
    expect(cancel).toMatch(/if \(!start\) return;/);
  });

  it('B：年视图格子/月名按钮放行，chip/按钮/任务行仍不劫持', () => {
    expect(swipeJs).toMatch(/export const ALLOWED_SELECTOR = '\.year__month, \.year__day'/);
    const excl = swipeJs.slice(swipeJs.indexOf('export const EXCLUDED_SELECTOR'), swipeJs.indexOf('export const ALLOWED_SELECTOR'));
    expect(excl).toMatch(/\.chip/);
    expect(excl).toMatch(/\.task-row/);
    expect(excl).toMatch(/button/);
    expect(excl).toMatch(/\[role="button"\]/);
    // ALLOWED 先于 EXCLUDED 判断
    const fn = swipeJs.slice(swipeJs.indexOf('export function isSwipeExcluded'), swipeJs.indexOf('export function createSwipeNav'));
    expect(fn.indexOf('ALLOWED_SELECTOR')).toBeLessThan(fn.indexOf('EXCLUDED_SELECTOR'));
  });

  it('B：窄屏滚动容器显式 pan-y，横向留给滑动', () => {
    expect(viewsCss).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.timegrid__scroll,[\s\S]*?touch-action: pan-y;/);
    expect(viewsCss).toMatch(/\.year,[\s\S]{0,120}\.agenda \{[\s\S]{0,80}touch-action: pan-y;/);
  });

  it('C：日程顶部按段向过去翻页，状态与底部同源去重', () => {
    expect(agendaJs).toMatch(/pastSegments/);
    expect(agendaJs).toMatch(/pastNoMore/);
    expect(agendaJs).toMatch(/pastEmptyStreak/);
    expect(agendaJs).toMatch(/function loadEarlier\(/);
    expect(agendaJs).toMatch(/async function loadEarlier\(/);
    // 加载锁：进入即置位，避免重复请求
    expect(agendaJs).toMatch(/if \(loadingEarlier \|\| paging\.pastNoMore\) return;/);
    // 段边界向过去推进
    expect(agendaJs).toMatch(/const pastSegmentFrom = \(j\) =>/);
    expect(agendaJs).toMatch(/const pastSegmentTo = \(j\) =>/);
  });

  it('C：顶部下拉手势 + 按钮兜底 + 到底静态文字', () => {
    expect(agendaJs).toMatch(/export const PULL_THRESHOLD = 70/);
    expect(agendaJs).toMatch(/function onPullTouchStart\(/);
    expect(agendaJs).toMatch(/function onPullTouchMove\(/);
    expect(agendaJs).toMatch(/function onPullTouchEnd\(/);
    // 只在触屏、只在列表顶部起手
    expect(agendaJs).toMatch(/e\.touches\.length !== 1/);
    expect(agendaJs).toMatch(/root\.scrollTop > 0/);
    // 到底用静态文字（不是只把按钮禁用）
    expect(agendaJs).toMatch(/agenda__past-end', text: t\('agenda\.noEarlier'\)/);
    // 按钮仍是兜底
    expect(agendaJs).toMatch(/class: 'btn btn--ghost agenda__earlier'/);
    expect(i18n).toMatch(/'agenda\.loadEarlier':/);
    expect(i18n).toMatch(/'agenda\.noEarlier':/);
    expect(i18n).toMatch(/'agenda\.loadEarlierError':/);
  });

  it('C：日程滚动容器接管顶部回弹；下拉提示只给触屏', () => {
    expect(viewsCss).toMatch(/\.agenda \{[\s\S]{0,160}overscroll-behavior-y: contain;/);
    expect(viewsCss).toMatch(/\.agenda__pull-hint \{\s*display: none;[\s\S]{0,120}@media \(pointer: coarse\) \{\s*\.agenda__pull-hint \{\s*display: inline;/);
    expect(viewsCss).toMatch(/\.agenda__past-end/);
  });

  it('D：logo 窄屏开合抽屉，宽屏折叠侧栏；两条路径不互相污染', () => {
    expect(appJs).toMatch(/function isNarrowViewport\(\)/);
    expect(appJs).toMatch(/return narrowSearchMedia\.matches \|\| window\.innerWidth <= 720/);
    expect(appJs).toMatch(/function doBrandToggle\(\)/);
    expect(appJs).toMatch(/if \(isNarrowViewport\(\)\) toggleSidebar\(\);/);
    expect(appJs).toMatch(/toggleDesktopSidebar\(\)/);
    expect(appJs).toMatch(/click: onBrandClick/);
    expect(appJs).toMatch(/pointerup: onBrandPointerUp/);
  });

  it('D：pointerup 兜底有防双触发的冷却窗（0.5.7 改为按 click 时序判定）', () => {
    expect(appJs).toMatch(/brandClickAt = Date\.now\(\)/);
    expect(appJs).toMatch(/brandPointerUpAt = Date\.now\(\);/);
    expect(appJs).toMatch(/if \(!shouldFallbackToggle\(brandClickAt, brandPointerUpAt\)\) return;/);
    expect(appJs).toMatch(/brandSuppressUntil = Date\.now\(\) \+ 900/);
    expect(appJs).toMatch(/if \(Date\.now\(\) < brandSuppressUntil\) return;/);
    // 兜底只对非鼠标指针生效
    expect(appJs).toMatch(/onBrandPointerUp[\s\S]{0,200}e\.pointerType === 'mouse'/);
  });

  it('D：logo 里的图标不吞点击，命中元素就是按钮本身', () => {
    expect(layoutCss).toMatch(/\.brand-mark img \{[\s\S]{0,60}pointer-events: none;/);
  });
});
