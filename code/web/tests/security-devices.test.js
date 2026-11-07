/**
 * 0.6.1（M5 §S3）／0.6.2：「我的安全」→「登录设备与接入」。
 *
 * 0.6.2 起：
 *   - 设备行两行明细：`设备：<机型> · <系统>` / `客户端：<客户端> · <IP> · 最近使用 <相对时间>`；
 *   - 分组：「登录设备」与「接入」两组，中间一条浅分割线；
 *   - 0.6.2 之前创建的会话没有 UA → 显示「设备信息不可用（此会话创建于 0.6.2 之前）」；
 *   - 卡片不再单独发凭据：接入只剩 MCP 一类，并支持改名。
 *
 * 覆盖：分区位置、UA 归一（Android 机型 / 桌面 / APK 新旧格式）、IP 打码、相对时间、
 * 当前设备无撤销、撤销二次确认、接入行两行明细 + 改名、空态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecuritySettings: vi.fn(),
  updateSecuritySettings: vi.fn(),
  generateSelfSignedCertificate: vi.fn(),
  uploadSecurityCertificate: vi.fn(),
  deleteSecurityCertificate: vi.fn(),
  getSecurityAudit: vi.fn(),
  unlockSecurityTarget: vi.fn(),
  beginTotpFor: vi.fn(),
  confirmTotpFor: vi.fn(),
  disableTotpFor: vi.fn(),
  regenerateRecoveryCodesFor: vi.fn(),
  listAppPasswordsFor: vi.fn(),
  createAppPasswordFor: vi.fn(),
  revokeAppPasswordFor: vi.fn(),
  beginOwnTotp: vi.fn(),
  confirmOwnTotp: vi.fn(),
  disableOwnTotp: vi.fn(),
  regenerateOwnRecoveryCodes: vi.fn(),
  listOwnAppPasswords: vi.fn(),
  createOwnAppPassword: vi.fn(),
  revokeOwnAppPassword: vi.fn(),
  listAuthSessions: vi.fn(),
  revokeAuthSession: vi.fn(),
  listAuthConnections: vi.fn(),
  revokeAuthConnection: vi.fn(),
  updateAiCredential: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...mocks };
});
vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { openMySecurityDialog } = await import('../src/js/security-settings.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await flush();
  await flush();
};

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function device(overrides = {}) {
  return {
    id: 'sess-1',
    current: false,
    kind: 'web',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ip: '203.0.113.42',
    loginAt: iso(NOW - 90 * 60 * 1000),
    lastSeenAt: iso(NOW - 90 * 60 * 1000),
    ...overrides,
  };
}

function connection(overrides = {}) {
  return {
    id: 'conn-1',
    kind: 'mcp',
    label: 'CLI',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    loginAt: iso(NOW - 3 * 24 * 60 * 60 * 1000),
    lastUsedAt: iso(NOW - 5 * 60 * 1000),
    ...overrides,
  };
}

function sectionByTitle(title) {
  return [...document.querySelectorAll('.security-section')]
    .find((node) => node.querySelector('.security-section__title')?.textContent === title);
}

function rowsOf(section) {
  return [...section.querySelectorAll('.security-app-password')];
}

let handle = null;

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.listOwnAppPasswords.mockResolvedValue([]);
  mocks.listAuthSessions.mockResolvedValue({ ok: true, sessions: [device({ id: 'me', current: true, lastSeenAt: iso(NOW - 30 * 1000) })] });
  mocks.listAuthConnections.mockResolvedValue({ ok: true, connections: [] });
  mocks.revokeAuthSession.mockResolvedValue({ ok: true, current: false });
  mocks.revokeAuthConnection.mockResolvedValue({ ok: true, kind: 'mcp' });
  mocks.updateAiCredential.mockResolvedValue({ ok: true });
  mocks.toast.mockReset();
});

afterEach(() => {
  if (handle) handle.close();
  handle = null;
  vi.clearAllMocks();
});

describe('0.6.1 / 0.6.2 登录设备与接入', () => {
  it('分区在 TOTP 之后、CalDAV 专用密码之前；内部两组 + 分割线', async () => {
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const titles = [...document.querySelectorAll('.security-section__title')].map((node) => node.textContent);
    const totp = titles.indexOf('两步验证（TOTP）');
    const devices = titles.indexOf('登录设备与接入');
    const dav = titles.indexOf('CalDAV 专用密码');
    expect(totp).toBeGreaterThanOrEqual(0);
    expect(devices).toBe(totp + 1);
    expect(dav).toBe(devices + 1);

    const section = sectionByTitle('登录设备与接入');
    const groups = [...section.querySelectorAll('.security-group__title')].map((node) => node.textContent);
    expect(groups).toEqual(['登录设备', '接入']);
    // 组标题是可被读屏识别的标题（h4 / role=heading + aria-level）。
    const first = section.querySelector('.security-group__title');
    expect(first.tagName).toBe('H4');
    expect(first.getAttribute('role')).toBe('heading');
    expect(first.getAttribute('aria-level')).toBe('4');
    const divider = section.querySelector('.security-group__divider');
    expect(divider).toBeTruthy();
    // 分割线纯装饰：不进无障碍树。
    expect(divider.getAttribute('aria-hidden')).toBe('true');
  });

  it('设备行两行明细：机型 / 系统、客户端 / IP / 相对时间', async () => {
    mocks.listAuthSessions.mockResolvedValue({
      ok: true,
      sessions: [
        device({ id: 'me', current: true, kind: 'web', lastSeenAt: iso(NOW - 20 * 1000) }),
        device({
          id: 'a',
          ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36 FnCalAndroid/0.3.0 (Xiaomi 13)',
          kind: 'android',
          ip: '198.51.100.7',
          lastSeenAt: iso(NOW - 5 * 60 * 1000),
        }),
        device({ id: 'b', ua: 'Mozilla/5.0 (Windows NT 10.0) Edg/120.0.0.0', ip: '2001:db8:1234:5678:abcd::1', lastSeenAt: iso(NOW - 3 * 60 * 60 * 1000) }),
        device({ id: 'c', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Version/17.2 Mobile Safari/604.1', lastSeenAt: iso(NOW - 2 * 24 * 60 * 60 * 1000) }),
        device({ id: 'd', ua: '', lastSeenAt: iso(NOW - 4 * 24 * 60 * 60 * 1000) }),
      ],
    });
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const rows = rowsOf(sectionByTitle('登录设备与接入'));
    const text = rows.map((row) => row.textContent);

    // 第一行是当前设备（Chrome / Windows），两行结构齐全。
    expect(text[0]).toContain('本机');
    expect(text[0]).toMatch(/设备：/);
    expect(text[0]).toMatch(/客户端：/);

    // FnCal 新 UA：括号里的机型优先；系统取 Android 版本。
    expect(text[1]).toContain('设备：Xiaomi 13 · Android 14');
    expect(text[1]).toContain('客户端：安卓壳 0.3.0');
    expect(text[1]).toContain('198.51.x.x');

    // 桌面 UA：台式机 + Edge；IPv6 只留前四组。
    expect(text[2]).toContain('设备：台式机 · Windows 10/11');
    expect(text[2]).toContain('客户端：Edge 120');
    expect(text[2]).toContain('2001:db8:1234:5678…');

    // iOS 只到 iPhone，不编机型。
    expect(text[3]).toContain('设备：iPhone · iOS 17.2');
    expect(text[3]).toContain('客户端：Safari 17.2');

    // 0.6.2 之前创建的会话：没有 UA，明确说明而不是留空。
    expect(text[4]).toContain('设备信息不可用（此会话创建于 0.6.2 之前）');

    const joined = text.join('\n');
    expect(joined).toContain('刚刚');
    expect(joined).toContain('5 分钟前');
    expect(joined).toContain('3 小时前');
    expect(joined).toContain('2 天前');
  });

  it('当前设备没有撤销按钮，其它设备有', async () => {
    mocks.listAuthSessions.mockResolvedValue({
      ok: true,
      sessions: [device({ id: 'me', current: true }), device({ id: 'other', current: false })],
    });
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const rows = rowsOf(sectionByTitle('登录设备与接入'));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('button')).toBeNull();
    expect(rows[1].querySelector('button')).toBeTruthy();
  });

  it('撤销其它设备：二次确认 → 调接口 → 刷新列表 → toast', async () => {
    mocks.listAuthSessions
      .mockResolvedValueOnce({ ok: true, sessions: [device({ id: 'me', current: true }), device({ id: 'other' })] })
      .mockResolvedValue({ ok: true, sessions: [device({ id: 'me', current: true })] });
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    let rows = rowsOf(sectionByTitle('登录设备与接入'));
    expect(rows).toHaveLength(2);
    rows[1].querySelector('button').click();
    await settle();
    const confirm = document.querySelector('.security-confirm-modal');
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain('撤销「设备：台式机 · Windows 10/11」这台设备？');
    const okBtn = [...confirm.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定');
    okBtn.click();
    await settle();
    expect(mocks.revokeAuthSession).toHaveBeenCalledWith('other');
    expect(mocks.toast).toHaveBeenCalledWith('已撤销', { variant: 'success' });
    rows = rowsOf(sectionByTitle('登录设备与接入'));
    expect(rows).toHaveLength(1);
  });

  it('接入只剩 MCP：两行明细 + 改名 + 撤销', async () => {
    mocks.listAuthConnections.mockResolvedValue({
      ok: true,
      connections: [connection({ id: 'mcp-1', kind: 'mcp', label: 'CLI' })],
    });
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const section = sectionByTitle('登录设备与接入');
    const rows = rowsOf(section);
    // 第 1 行是当前设备，第 2 行是接入。
    expect(rows[1].textContent).toContain('MCP 接入 · CLI');
    expect(rows[1].textContent).toContain('客户端：Chrome 131');
    expect(rows[1].textContent).toContain('最近使用 5 分钟前');
    expect(section.textContent).toContain('此连接的名称可改，建议写成助手名字。');
    expect(section.textContent).not.toContain('桌面卡片');

    // 改名：行内输入框 → 保存 → PATCH label → 重新拉列表。
    const renameBtn = [...rows[1].querySelectorAll('button')].find((node) => node.textContent.trim() === '改名');
    renameBtn.click();
    await settle();
    const input = section.querySelector('.security-app-password--editing input');
    expect(input).toBeTruthy();
    expect(input.value).toBe('CLI');
    input.value = '我的助手';
    const saveBtn = [...document.querySelectorAll('.security-app-password--editing button')]
      .find((node) => node.textContent.trim() === '确认');
    saveBtn.click();
    await settle();
    expect(mocks.updateAiCredential).toHaveBeenCalledWith('mcp-1', { label: '我的助手' });
    expect(mocks.toast).toHaveBeenCalledWith('已改名', { variant: 'success' });

    // 撤销走同一个接入接口。
    const rows2 = rowsOf(sectionByTitle('登录设备与接入'));
    const revokeBtn = [...rows2[1].querySelectorAll('button')].find((node) => node.textContent.trim() === '撤销');
    revokeBtn.click();
    await settle();
    const confirm = document.querySelector('.security-confirm-modal');
    expect(confirm.textContent).toContain('撤销接入「MCP 接入 · CLI」？');
    [...confirm.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定').click();
    await settle();
    expect(mocks.revokeAuthConnection).toHaveBeenCalledWith('mcp-1');
  });

  it('空态：只有当前设备在登录 / 还没有 MCP 接入', async () => {
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const section = sectionByTitle('登录设备与接入');
    expect(section.textContent).toContain('只有当前设备在登录');
    expect(section.textContent).toContain('还没有 MCP 接入。');
  });

  // 0.6.4（用户 m00854）：诊断包只在管理员「安全设置」④ 审计页，普通用户「我的安全」不加。
  it('普通用户「我的安全」没有「系统诊断」与「导出诊断包」', async () => {
    handle = openMySecurityDialog({ user: { id: 'me', role: 'admin', username: 'me' } });
    await settle();
    const titles = [...document.querySelectorAll('.security-section__title')].map((node) => node.textContent);
    expect(titles).not.toContain('系统诊断');
    expect(document.body.textContent).not.toContain('导出诊断包');
  });
});
