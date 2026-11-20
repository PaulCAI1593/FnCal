/**
 * 0.8.43（用户 2026-11-19）：「MCP 配置片段的下面也给一下skill的配置prompt」。
 *
 * 断言写 DOM 事实、纯函数输出与源码文本，不写「实现了什么函数名字」以外的空话：
 *   - Prompt 五段、两条链接、两个占位符；不含真实 origin、不含真实令牌前缀；
 *   - 单一来源：版本串只在 `SKILL_PACKAGE` 出现一次；
 *   - 结构：skillRow 紧跟 configRow，两者 class 与子元素顺序一致；
 *   - 复制成功写整段并 toast「已复制技能配置 Prompt」；剪贴板缺失时聚焦 pre、toast 失败；
 *   - CSS 允许换行（pre-wrap + anywhere），390 宽不出横向滚动。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logoutAll: vi.fn(async () => ({ ok: true })),
  updateProfile: vi.fn(async () => ({ ok: true })),
  listAdminUsers: vi.fn(async () => []),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  getCalDavSyncStatus: vi.fn(async () => ({ ok: true })),
  exportDiagnostics: vi.fn(async () => ({ ok: true })),
  fixCalDavDavAccess: vi.fn(async () => ({ ok: true })),
  getAiSettings: vi.fn(),
  updateAiSettings: vi.fn(),
  listAiCredentials: vi.fn(),
  createAiCredential: vi.fn(),
  updateAiCredential: vi.fn(),
  deleteAiCredential: vi.fn(),
  listAiProposals: vi.fn(),
  acceptAiProposal: vi.fn(),
  rejectAiProposal: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/js/api-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    changePassword: mocks.changePassword,
    logoutAll: mocks.logoutAll,
    updateProfile: mocks.updateProfile,
    listAdminUsers: mocks.listAdminUsers,
    createAdminUser: mocks.createAdminUser,
    updateAdminUser: mocks.updateAdminUser,
    getCalDavSyncStatus: mocks.getCalDavSyncStatus,
    exportDiagnostics: mocks.exportDiagnostics,
    fixCalDavDavAccess: mocks.fixCalDavDavAccess,
    getAiSettings: mocks.getAiSettings,
    updateAiSettings: mocks.updateAiSettings,
    listAiCredentials: mocks.listAiCredentials,
    createAiCredential: mocks.createAiCredential,
    updateAiCredential: mocks.updateAiCredential,
    deleteAiCredential: mocks.deleteAiCredential,
    listAiProposals: mocks.listAiProposals,
    acceptAiProposal: mocks.acceptAiProposal,
    rejectAiProposal: mocks.rejectAiProposal,
  };
});

vi.mock('../src/js/toast.js', () => ({ toast: mocks.toast }));

const { mcpSkillPrompt, SKILL_PACKAGE, mcpConfigJson } = await import('../src/js/ai-settings.js');
const { openAccountDialog } = await import('../src/js/account-dialog.js');
const { DEFAULT_SETTINGS } = await import('../src/js/store.js');
const { hasKey } = await import('../src/i18n/index.js');

const SRC = path.resolve(process.cwd(), 'src');
const settingsSource = fs.readFileSync(path.join(SRC, 'js', 'ai-settings.js'), 'utf8');
const calendarCss = fs.readFileSync(path.join(SRC, 'styles', 'calendar.css'), 'utf8');

function makeStore() {
  const state = { ...DEFAULT_SETTINGS };
  const calendars = [{ id: 'default', displayName: '我的日历', type: 'vevent', color: '#3272d9' }];
  return {
    getSettings: () => ({ ...state }),
    saveSettings: async (patch) => Object.assign(state, patch),
    getCalendars: () => calendars.map((c) => ({ ...c })),
    getCalendar: (id) => calendars.find((c) => c.id === id) || null,
    isCalendarVisible: () => true,
    updateCalendar: vi.fn(async () => ({ ok: true })),
    refreshCalendars: async () => calendars.map((c) => ({ ...c })),
  };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const aiReady = async (dialog) => {
  for (let i = 0; i < 100; i++) {
    const host = dialog.querySelector('#settings-page-ai');
    if (host && host.dataset.loaded === 'true') return;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('0.8.43 · AI 页「技能配置 Prompt」', () => {
  let opened = null;

  beforeEach(() => {
    document.body.replaceChildren();
    Object.values(mocks).forEach((fn) => fn.mockClear());
    mocks.getAiSettings.mockImplementation(async () => ({
      ok: true,
      settings: { enabled: false, mcpPath: '/mcp', updatedAt: null, updatedBy: null },
    }));
    mocks.listAiCredentials.mockResolvedValue({ ok: true, credentials: [] });
    mocks.listAiProposals.mockResolvedValue({ ok: true, proposals: [] });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    if (opened) opened.close();
    opened = null;
    document.body.replaceChildren();
  });

  function open() {
    opened = openAccountDialog({ user: { username: 'alice', displayName: 'Alice', role: 'admin' }, store: makeStore() });
    return opened.dialog;
  }

  async function openAiTab(dialog) {
    dialog.querySelector('#settings-tab-ai').click();
    await tick();
    await aiReady(dialog);
    await aiReady(dialog);
  }

  const skillPre = (dialog) => dialog.querySelector('.ai-skill-prompt');

  it('Prompt 主链接是 Gitee，末行给 GitHub 备用', () => {
    const text = mcpSkillPrompt();
    const lines = text.split('\n');
    expect(lines[0]).toBe('请帮我配置 FnCal 技能：');
    expect(lines).toHaveLength(6);
    // 第 1、2 行必须是 Gitee（用户 2026-11-19：「默认用gitee的网址吧」）
    expect(lines[1]).toBe('1. 读取技能说明：https://gitee.com/Paul1593/FnCal/raw/main/skills/fncal-mcp/SKILL.md');
    expect(lines[2]).toBe('2. 安装技能包：https://gitee.com/Paul1593/FnCal/releases/download/mcp-skill-v0.8.40/FnCal-MCP-Skill-0.8.40.zip');
    expect(text).toContain('mcp-skill-v0.8.40');
    expect(text).toContain('FnCal-MCP-Skill-0.8.40.zip');
    expect(text).toContain('https://<你的地址>/mcp');
    expect(text).toContain('Bearer <你的令牌>');
    expect(text).toContain('list_calendars');
    // 末行备用：GitHub 两条原地址
    expect(lines[5]).toMatch(/^（Gitee 打不开时改用 GitHub：/);
    expect(lines[5]).toContain('https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md');
    expect(lines[5]).toContain('https://github.com/PaulCAI1593/FnCal/releases/download/mcp-skill-v0.8.40/FnCal-MCP-Skill-0.8.40.zip');
    // Gitee 用户名不得写成 GitHub 的 PaulCAI1593
    expect(SKILL_PACKAGE.giteeSkillMd).toContain('gitee.com/Paul1593/');
    expect(SKILL_PACKAGE.giteeDownload).toContain('gitee.com/Paul1593/');
    expect(SKILL_PACKAGE.giteeSkillMd).not.toContain('PaulCAI1593');
    expect(SKILL_PACKAGE.giteeDownload).not.toContain('PaulCAI1593');
    // 不得写真实 origin 或真实令牌前缀
    expect(text).not.toContain('fncal_ai_');
    expect(text).not.toContain(location.hostname);
    expect(text).not.toContain('localhost');
    // 占位符与 JSON 片段一致（同一套写法）
    expect(mcpConfigJson('https://<你的地址>/mcp')).toContain('Bearer <你的令牌>');
  });

  it('版本串只有 SKILL_PACKAGE 一处来源', () => {
    const hits = settingsSource.match(/mcp-skill-v0\.8\.40/g) || [];
    expect(hits).toHaveLength(1);
    expect(settingsSource).toContain("version: '0.8.40'");
    // 文件名也只写一处，四个链接里不再各写一遍
    expect(settingsSource.match(/FnCal-MCP-Skill-0\.8\.40\.zip/g) || []).toHaveLength(1);
    expect(Object.isFrozen(SKILL_PACKAGE)).toBe(true);
    // 四个链接字段都在
    for (const key of ['giteeSkillMd', 'giteeDownload', 'githubSkillMd', 'githubDownload']) {
      expect(typeof SKILL_PACKAGE[key], key).toBe('string');
    }
  });

  it('skillRow 紧跟 configRow，class 与子元素顺序同构', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const pre = skillPre(dialog);
    expect(pre).not.toBe(null);
    expect(pre.className).toContain('ai-mcp-json');
    expect(pre.getAttribute('tabindex')).toBe('0');

    const row = pre.closest('.settings__row');
    const configRowEl = dialog.querySelector('.ai-mcp-json:not(.ai-skill-prompt)').closest('.settings__row');
    expect(row).not.toBe(null);
    expect(row.className).toBe(configRowEl.className);
    expect(configRowEl.nextElementSibling).toBe(row);

    const kids = [...row.children].map((n) => `${n.tagName}.${n.className}`);
    const configKids = [...configRowEl.children].map((n) => `${n.tagName}.${n.className}`);
    expect(kids).toEqual(configKids);
    expect(row.children[0].textContent).toBe('技能配置 Prompt');
    // control 里：pre → 复制按钮 → 两条提示
    const control = row.children[1];
    expect(control.children[0]).toBe(pre);
    expect(control.children[1].querySelector('button.ai-skill-prompt-copy')).not.toBe(null);
    expect([...control.querySelectorAll('.ai-hint')].map((n) => n.textContent)).toEqual([
      '把这段发给支持技能的 AI 客户端：它会读技能说明、装技能包，再用上面的配置连上 MCP。',
      '地址与令牌同上面的 MCP 配置；令牌只填一次，不要发到公开渠道。',
    ]);
  });

  it('复制按钮写入整段 Prompt 并 toast 成功文案', async () => {
    const dialog = open();
    await openAiTab(dialog);
    const pre = skillPre(dialog);
    const btn = dialog.querySelector('.ai-skill-prompt-copy');
    expect(btn).not.toBe(null);
    expect(btn.type).toBe('button');
    btn.click();
    await tick();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe(mcpSkillPrompt());
    expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe(pre.textContent);
    expect(mocks.toast).toHaveBeenCalledWith('已复制技能配置 Prompt', { variant: 'success' });
  });

  it('剪贴板不可用时 toast 失败并把焦点交给 pre', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const dialog = open();
    await openAiTab(dialog);
    const pre = skillPre(dialog);
    dialog.querySelector('.ai-skill-prompt-copy').click();
    await tick();
    await tick();
    expect(document.activeElement).toBe(pre);
    expect(mocks.toast).toHaveBeenCalledWith('复制失败，请手动选择地址复制。', { variant: 'danger' });
  });

  it('CSS 允许长 URL 换行，不留横向滚动', () => {
    const rule = calendarCss.match(/\.ai-skill-prompt\s*\{[^}]*\}/);
    expect(rule).not.toBe(null);
    expect(rule[0]).toMatch(/white-space:\s*pre-wrap/);
    expect(rule[0]).toMatch(/overflow-wrap:\s*anywhere/);
    // 沿用配置片段底样式（等宽、边框、内边距）时不得再锁 white-space: pre
    const base = calendarCss.match(/\.ai-mcp-json\s*\{[^}]*\}/)[0];
    expect(base).toMatch(/white-space:\s*pre;/);
  });

  it('五条新文案键都存在', () => {
    for (const key of [
      'settings.ai.skillPrompt',
      'settings.ai.copySkillAria',
      'settings.ai.skillPromptHint',
      'settings.ai.skillTokenHint',
      'settings.ai.toast.skillCopied',
    ]) {
      expect(hasKey(key), key).toBe(true);
    }
  });
});
