/**
 * 0.6.2（M5 §F）：桌面卡片不再单独发凭据，改为跟随 App 内登录态。
 *
 * 用户 2026-11-07 原话：「桌面卡片能不能不要这么复杂再多一个凭据？他能读取APK里的内容吗，
 * 跟着APK走」。总监定：服务端 `/api/widget/v1/summary` 只认会话 Cookie；删掉 `fncal_wd_`
 * Bearer、令牌路由、令牌页签与令牌类目；安卓用 `CookieManager` 取 Cookie。
 *
 * 这里锁「入口已消失」这一类静态事实（`security-devices.test.js` 已从渲染结果断言
 * 「接入只剩 MCP」）。运行期几何（行高、分割线位置）由台架实测并写进记录。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const apiClient = READ('src/js/api-client.js');
const i18n = READ('src/i18n/zh-CN.js');
const accountDialog = READ('src/js/account-dialog.js');
const securitySettings = READ('src/js/security-settings.js');

const WIDGET_REST = path.join(HERE, '..', '..', 'app', 'api', 'widget-rest.mjs');
const API_INDEX = path.join(HERE, '..', '..', 'app', 'api', 'index.mjs');
const ROOT = path.join(HERE, '..', '..', '..');
const ANDROID = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'paulcai1593', 'fncal', 'app');

describe('0.6.2 桌面卡片跟随 App 登录态', () => {
  it('网页端不再有卡片令牌接口', () => {
    expect(apiClient).not.toMatch(/widget/i);
  });

  it('设置里没有「卡片」页签（0.6.4 起「日历」也并入 CalDAV，共 4 枚）', () => {
    expect(accountDialog).not.toMatch(/settings\.tab\.widget/);
    expect(accountDialog).not.toMatch(/settings\.widget\./);
    const tabs = [...accountDialog.matchAll(/settings\.tab\.([a-z]+)/g)].map((m) => m[1]);
    // 0.6.4（用户 m00800）：「日历」页签收进 CalDAV 页，`settings.tab.calendar` 键与页签一起删除。
    expect([...new Set(tabs)]).toEqual(['general', 'account', 'ai', 'shortcuts']);
  });

  it('i18n 不再有令牌页签与令牌页文案（AI 凭据的「令牌」是另一件事，不动）', () => {
    expect(i18n).not.toMatch(/settings\.tab\.widget/);
    expect(i18n).not.toMatch(/settings\.widget\./);
    expect(i18n).not.toContain('桌面卡片令牌');
  });

  it('「接入」组只剩 MCP 一类，没有卡片令牌类目', () => {
    expect(securitySettings).not.toMatch(/widget/i);
    expect(securitySettings).toContain('security.connections.mcp');
    expect(securitySettings).not.toContain('security.connections.widget');
  });

  it('服务端只认会话 Cookie，Bearer 路径已删', () => {
    const rest = readFileSync(WIDGET_REST, 'utf8');
    expect(rest).toContain('requireSession');
    expect(rest).not.toMatch(/Bearer\s+fncal_wd_/);
    expect(rest).not.toContain("startsWith('fncal_wd_')");
    // 用户侧令牌路由不应再注册。
    const index = readFileSync(API_INDEX, 'utf8');
    expect(index).not.toContain('/api/widget/v1/tokens');
    expect(index).not.toContain('/api/v1/widget/tokens');
  });

  it('安卓用 CookieManager 取会话 Cookie，不再读令牌', () => {
    const client = readFileSync(path.join(ANDROID, 'WidgetClient.kt'), 'utf8');
    expect(client).toContain('CookieManager.getInstance().getCookie');
    expect(client).toContain('setRequestProperty("Cookie"');
    expect(client).toContain('FnCalWidget/');
    expect(client).not.toContain('fncal_wd_');

    const prefs = readFileSync(path.join(ANDROID, 'WidgetPrefs.kt'), 'utf8');
    expect(prefs).not.toMatch(/KeyStore|AES\/GCM|Cipher/);
  });

  it('安卓未登录态文案明确（撤销会话后卡片提示重新登录）', () => {
    const strings = readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
    expect(strings).toContain('widget_no_token');
    expect(strings).toContain('打开 FnCal 登录');
  });
});
