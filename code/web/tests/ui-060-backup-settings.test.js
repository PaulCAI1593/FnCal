/**
 * 0.9.2（`product/0.9.2-备份与恢复-任务书.md`）备份设置的静态口径：
 *   S1 接口按会话身份，七个端点，不带 userId 参数。
 *   S2 范围默认：我的设置开、我的日程开、我的附件关。
 *   S3 四个目的地 local / nas / webdav / s3。
 *   S4 打开自动备份前必须先测试成功。
 *   S5 「覆盖」恢复必须手输「恢复」。
 *   S6 备份节放进「设置 → 高级」，在所有登录用户可见（不在管理员专属块内）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const apiClient = READ('src/js/api-client.js');
const section = READ('src/js/backup-settings.js');
const dialog = READ('src/js/account-dialog.js');
const zh = READ('src/i18n/zh-CN.js');

describe('0.9.2 备份设置（静态）', () => {
  it('S1 七个端点，且不带 userId 参数', () => {
    for (const fn of ['getBackupSettings', 'putBackupSettings', 'runBackup', 'getBackupStatus',
      'listBackupFiles', 'restoreBackupFile', 'testBackupDestination']) {
      expect(apiClient).toContain(`export function ${fn}(`);
    }
    const backupPart = apiClient.slice(apiClient.indexOf('const BACKUP_BASE'));
    expect(backupPart).not.toContain('userId=');
    expect(backupPart).not.toMatch(/query\.(set|append)\('userId'/);
  });

  it('S2 三个勾选默认：设置开、日程开、附件关', () => {
    expect(section).toMatch(/scope\.settings'\)\, true/);
    expect(section).toMatch(/scope\.calendars'\)\, true/);
    expect(section).toMatch(/scope\.attachments'\)\, false/);
  });

  it('S3 目的地分段含 local/nas/webdav/s3', () => {
    for (const kind of ['local', 'nas', 'webdav', 's3']) {
      expect(section).toContain(`'${kind}'`);
    }
  });

  it('S4 开启自动备份前先测试', () => {
    expect(section).toMatch(/if \(on && !state\.testOk\)/);
    expect(section).toMatch(/await runTest\(true\)/);
  });

  it('S5 覆盖恢复必须输入「恢复」', () => {
    expect(section).toMatch(/confirm !== '恢复'/);
  });

  it('S6 备份节在高级页，且不在管理员专属容器里', () => {
    expect(dialog).toContain('createBackupSection()');
    expect(dialog).toContain('backupSection.node');
    const tabsFrom = dialog.indexOf('const tabs = [');
    const tabs = dialog.slice(tabsFrom, dialog.indexOf('];', tabsFrom) + 2);
    const order = ['general', 'advanced', 'tags', 'account', 'ai'].map((id) => tabs.indexOf(`id: '${id}'`));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(zh).toContain("'settings.tab.advanced'");
  });
});
