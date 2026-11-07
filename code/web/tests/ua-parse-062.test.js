/**
 * 0.6.2 §B / §C：UA 解析（设备 / 系统 / 客户端）。
 *
 * 口径：只按 UA 里能确认的信息显示；解析不出一律「未知」，不猜机型。
 * 用例覆盖：Android 机型（新旧 APK UA）、Pixel 无厂商、iPhone / iPad、Windows / macOS / Linux、
 * Chrome / Edge / Firefox / Safari / Android WebView、空 UA。
 */
import { describe, it, expect } from 'vitest';
import { parseUserAgent } from '../src/js/ua-parse.js';

const CASES = [
  {
    name: 'Chrome / Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    want: { device: '台式机', os: 'Windows 10/11', client: 'Chrome 131' },
  },
  {
    name: 'Edge / Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    want: { device: '台式机', os: 'Windows 10/11', client: 'Edge 131' },
  },
  {
    name: 'Firefox / macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:133.0) Gecko/20100101 Firefox/133.0',
    want: { device: '台式机', os: 'macOS 14', client: 'Firefox 133' },
  },
  {
    name: 'Safari / macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    want: { device: '台式机', os: 'macOS 10', client: 'Safari 17.2' },
  },
  {
    name: 'Chrome / Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    want: { device: '台式机', os: 'Linux', client: 'Chrome 130' },
  },
  {
    name: 'Chrome / Android（无机型）',
    ua: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    want: { device: 'Android 设备', os: 'Android 14', client: 'Chrome 131' },
  },
  {
    name: 'Chrome / Android（有型号）',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    want: { device: 'SM-S918B', os: 'Android 13', client: 'Chrome 131' },
  },
  {
    name: 'Android WebView',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36; wv',
    want: { device: 'Pixel 7', os: 'Android 14', client: 'Android WebView' },
  },
  {
    name: 'FnCal 安卓壳 0.3.0（新格式，括号带机型）',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 FnCalAndroid/0.3.0 (Xiaomi 13)',
    want: { device: 'Xiaomi 13', os: 'Android 14', client: '安卓壳 0.3.0' },
  },
  {
    name: 'FnCal 安卓壳旧格式（无括号机型）',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 FnCalAndroid/0.3.0',
    want: { device: 'SM-S918B', os: 'Android 14', client: '安卓壳 0.3.0' },
  },
  {
    name: 'FnCal 桌面卡片请求',
    ua: 'FnCalWidget/0.3.0 (Xiaomi 13)',
    want: { device: 'Xiaomi 13', os: '未知', client: '桌面卡片 0.3.0' },
  },
  {
    name: 'Safari / iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    want: { device: 'iPhone', os: 'iOS 17.2', client: 'Safari 17.2' },
  },
  {
    name: 'Safari / iPad',
    ua: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    want: { device: 'iPad', os: 'iOS 16.6', client: 'Safari 16.6' },
  },
  {
    name: 'Chrome / iOS（CriOS）',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
    want: { device: 'iPhone', os: 'iOS 17.2', client: 'Chrome 131' },
  },
  { name: '空 UA', ua: '', want: { device: '未知', os: '未知', client: '未知' } },
  { name: '无法识别', ua: 'curl/8.4.0', want: { device: '未知', os: '未知', client: '未知' } },
];

describe('0.6.2 UA 解析', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(parseUserAgent(c.ua)).toEqual(c.want);
    });
  }

  it('机型不编造：UA 里只有系统版本时给「Android 设备」，不给具体型号', () => {
    const parsed = parseUserAgent('Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/100.0.0.0 Mobile Safari/537.36');
    expect(parsed.device).toBe('Android 设备');
    expect(parsed.os).toBe('Android 12');
  });

  it('widths 里带空值也不抛错', () => {
    expect(() => parseUserAgent(undefined)).not.toThrow();
    expect(parseUserAgent(null)).toEqual({ device: '未知', os: '未知', client: '未知' });
  });
});
