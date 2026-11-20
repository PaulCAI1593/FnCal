/**
 * 0.9.2 8.5.2 上传进度与取消（静态口径）：
 *   S1 客户端上传走 XHR，用 upload.onprogress 回进度。
 *   S2 编辑器有进度条与取消按钮，取消走 AbortController。
 *   S3 上传链接页有进度条与取消，取消调 xhr.abort()。
 *   S4 390 宽进度条不撑破：CSS 有换行/最小宽度处理。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const apiClient = READ('src/js/api-client.js');
const modalJs = READ('src/js/modal.js');
const css = READ('src/styles/calendar.css');
const uploadPage = READ('../app/api/upload-link-page.mjs');

describe('0.9.2 上传进度与取消（静态）', () => {
  it('S1 uploadAttachment 用 XHR + upload.onprogress', () => {
    const start = apiClient.indexOf('export function uploadAttachment');
    const body = apiClient.slice(start, start + 2600);
    expect(body).toContain('XMLHttpRequest');
    expect(body).toContain('xhr.upload.onprogress');
    expect(body).toContain('onProgress');
    expect(body).toContain("signal.addEventListener('abort'");
  });

  it('S2 编辑器有进度条与取消', () => {
    expect(modalJs).toContain('attachmentProgress');
    expect(modalJs).toContain('attachmentCancel');
    expect(modalJs).toContain('AbortController');
    expect(modalJs).toContain('.abort()');
    expect(css).toContain('.attach__progress');
    expect(css).toContain('.attach__bar');
  });

  it('S3 上传链接页有进度条与取消', () => {
    expect(uploadPage).toContain('id="progress"');
    expect(uploadPage).toContain('id="cancel"');
    expect(uploadPage).toContain('upload.onprogress');
    expect(uploadPage).toContain('xhr.abort()');
  });

  it('S4 窄屏进度条可换行、不撑破行', () => {
    const bar = css.slice(css.indexOf('.attach__progress {'), css.indexOf('.attach__progress {') + 600);
    expect(bar).toMatch(/min-width|flex-wrap|overflow-wrap|word-break/);
    expect(css).toMatch(/\.backup__row/);
  });
});
