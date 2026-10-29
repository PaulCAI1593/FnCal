/**
 * 0.2.3 命名与署名（RC3 硬要求）+ B2/B3/B4 静态断言。
 *   - 应用名/显示名/项目名一律 FnCal；「日历」「CalDAV」只作普通名词/协议名。
 *   - 开发者/发布者 PaulCAI1593；版权行统一。
 *   - B2 设置页签不被裁（不再用 overflow-x:auto 横滚容器）；
 *   - B3 表格行高 ≥44、窄屏卡片式、表头/数据同一套 grid；
 *   - B4 Service Worker 缓存名带版本占位 + 版本号由 /api/version 取得（前端不写死）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (p) => readFileSync(path.resolve(p), 'utf8');
const codeDir = path.resolve('..');

describe('0.2.3 命名与署名', () => {
  it('manifest：display_name=FnCal、描述不提「日历」作应用名、维护者/发布者字段齐全', () => {
    const m = read('../fnos/manifest');
    expect(m).toMatch(/^display_name=FnCal$/m);
    expect(m).toMatch(/^maintainer=PaulCAI1593$/m);
    // 0.2.44（用户：应用开发者和发布者连接到该项目仓库）：两处 URL 由个人主页改为项目仓库。
    expect(m).toMatch(/^maintainer_url=https:\/\/github\.com\/PaulCAI1593\/FnCal$/m);
    expect(m).toMatch(/^distributor=PaulCAI1593$/m);
    expect(m).toMatch(/^distributor_url=https:\/\/github\.com\/PaulCAI1593\/FnCal$/m);
    expect(m).not.toContain('display_name=日历');
    expect(m).not.toContain('FnCal 日历');
  });

  it('桌面入口标题 = FnCal（ui/config）', () => {
    const ui = JSON.parse(read('../fnos/app/ui/config'));
    expect(ui['.url']['FnCal.main'].title).toBe('FnCal');
  });

  it('i18n：应用名/标题 = FnCal，不再出现「FnCal 日历」', () => {
    const s = read('src/i18n/zh-CN.js');
    expect(s).toMatch(/'app\.name': 'FnCal'/);
    expect(s).toMatch(/'app\.title': 'FnCal'/);
    expect(s).toMatch(/'login\.title': 'FnCal'/);
    expect(s).not.toContain('FnCal 日历');
  });

  it('index.html：标题/应用名/PWA 名称 = FnCal，描述不再宣传「提醒」', () => {
    const h = read('index.html');
    expect(h).toContain('<title>FnCal</title>');
    expect(h).toContain('<meta name="application-name" content="FnCal" />');
    expect(h).toContain('<meta name="apple-mobile-web-app-title" content="FnCal" />');
    expect(h).toContain('content="FnCal"'); // og:site_name / og:title
    expect(h).not.toContain('FnCal 日历');
    expect(h).not.toContain('提醒');
  });

  it('webmanifest：name = FnCal，描述不再宣传「提醒」', () => {
    const wm = JSON.parse(read('public/site.webmanifest'));
    expect(wm.name).toBe('FnCal');
    expect(wm.short_name).toBe('FnCal');
    expect(JSON.stringify(wm)).not.toContain('提醒');
  });

  it('许可与署名：LICENSE/声明文件含 PaulCAI1593 与团队原创图标条款', () => {
    const lic = read('LICENSE');
    expect(lic).toContain('Copyright (c) 2026 PaulCAI1593');
    // 上游 MIT 声明必须保留（不能因改名丢掉）
    expect(lic).toContain('Puter Technologies Inc.');
    const notices = read('THIRD_PARTY_NOTICES.md');
    expect(notices).toContain('PaulCAI1593');
    expect(notices).toContain('团队原创');
    expect(notices).toContain('不含任何第三方商标');
    expect(notices).toContain('字标为「Cal」');
    expect(notices).toContain('所有尺寸（含 16/32px favicon）统一使用该字标');
    expect(notices).not.toContain('单字标 F');
    expect(notices).not.toContain('或经授权');
    // 包内也有一份（assemble 会带进 server/）
    const pkgNotices = read('../app/THIRD_PARTY_NOTICES.md');
    expect(pkgNotices).toContain('PaulCAI1593');
    expect(pkgNotices).toContain('bcryptjs');
  });
});

describe('B2 设置页签不被裁', () => {
  const css = read('src/styles/calendar.css');
  it('页签容器不用 overflow-x:auto 横滚（会连带裁纵向），改为可换行', () => {
    const rule = css.slice(css.indexOf('.settings__tabs {'), css.indexOf('.settings__tabs {') + 420);
    expect(rule).toContain('display: inline-flex');
    expect(rule).toContain('flex-wrap: wrap');
    expect(rule).toContain('overflow: visible');
    expect(rule).not.toContain('overflow-x: auto');
  });
  it('页签按钮不固定高度、单行不换行、窄屏命中 >=44px', () => {
    const btn = css.slice(css.indexOf('.settings__tabs button {'), css.indexOf('.settings__tabs button {') + 300);
    expect(btn).toContain('height: auto');
    expect(btn).toContain('white-space: nowrap');
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]{0,400}\.settings__tabs button[\s\S]{0,80}min-height: 44px/);
  });
});

describe('B3 日历表格自适应', () => {
  const css = read('src/styles/calendar.css');
  it('表头与数据行同一套 grid（1fr / 72px / 132px）、表头单行不换行', () => {
    expect(css).toMatch(/\.cal-table__row \{[\s\S]{0,300}grid-template-columns: minmax\(160px, 1fr\) 88px 148px/);
    expect(css).toMatch(/\.cal-table__row--head \.cal-table__cell \{[\s\S]{0,80}white-space: nowrap/);
  });
  it('权限列靠右；≤720 两行卡片式（权限另起一行占满）；触屏行高 >=44px', () => {
    expect(css).toMatch(/\.cal-table__cell--dav \{[\s\S]{0,80}justify-content: flex-end/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]{0,600}grid-template-columns: minmax\(0, 1fr\) 72px/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]{0,900}\.cal-table__cell--dav \{[\s\S]{0,80}grid-column: 1 \/ -1/);
    expect(css).toMatch(/@media \(hover: none\)[\s\S]{0,80}\.cal-table__row \{[\s\S]{0,60}min-height: 44px/);
  });
});

describe('B4 版本可自证', () => {
  it('Service Worker 缓存名是构建期可替换的占位', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/fncal-shell-v\d+/);
  });
  it('版本号由 /api/version 取得，不在前端源码写死', () => {
    const v = read('src/js/app-version.js');
    expect(v).toContain("'/api/version'");
    expect(v).not.toMatch(/version\s*[:=]\s*['\"]0\.2\./);
  });
  it('设置页脚显示「FnCal <version>」', () => {
    const i18n = read('src/i18n/zh-CN.js');
    expect(i18n).toContain("'settings.version': 'FnCal {version}'");
  });
});
