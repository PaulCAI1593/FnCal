/**
 * 0.6.2（M5 §B）：把原始 User-Agent 归一成「设备 / 系统 / 客户端」三段。
 *
 * 纯函数，不碰 DOM、不读全局，浏览器与 Node 测试都能直接用：
 *   parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S918B) ...') →
 *   { device: 'SM-S918B', os: 'Android 14', client: 'Chrome 131' }
 *
 * 口径（范围文档 M5-0.6.1…「0.6.2 追加」）：
 * - Android 只取 UA 里能确认的机型（`Android 14; SM-S918B` / `; Pixel 7 Build/`）；
 *   取不到就写「Android 设备」，不猜品牌。
 * - iOS 只到 `iPhone` / `iPad`（UA 不带机型），不编造。
 * - 桌面统一「台式机」；系统取 `Windows 10/11` / `macOS 14` / `Linux`。
 * - 客户端取主版本号；`wv` + Android 先判 Android WebView；FnCal 的两个自有 UA 优先。
 * - 任何一段解析不出都写「未知」，不用空串、不 undefined。
 */

const UNKNOWN = '未知';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function androidModel(ua, osMatch) {
  // 形如：Android 14; SM-S918B Build/UP1A.231005.007
  //       Android 14; Pixel 7 Build/UQ1A...
  //       Android 14; SM-S918B)
  const afterOs = ua.slice((osMatch && osMatch.index ? osMatch.index : 0) + (osMatch ? osMatch[0].length : 0));
  const segment = afterOs.split(')')[0];
  const pieces = segment.split(';').map(clean).filter(Boolean);
  for (const piece of pieces) {
    const model = piece.replace(/\s+Build\/.*$/i, '').trim();
    if (!model) continue;
    if (/^(?:wv|Mobile|Tablet|Linux|U)$/i.test(model)) continue;
    return model;
  }
  return '';
}

function clientOf(ua) {
  const widget = ua.match(/FnCalWidget\/(\d+(?:\.\d+)*)/i);
  if (widget) return `桌面卡片 ${widget[1]}`;
  const shell = ua.match(/FnCalAndroid\/(\d+(?:\.\d+)*)/i);
  if (shell) return `安卓壳 ${shell[1]}`;
  if (/Android/i.test(ua) && /\bwv\b/i.test(ua)) return 'Android WebView';
  const edge = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/i);
  if (edge) return `Edge ${edge[1]}`;
  const firefox = ua.match(/(?:Firefox|FxiOS)\/(\d+)/i);
  if (firefox) return `Firefox ${firefox[1]}`;
  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+)/i);
  if (chrome) return `Chrome ${chrome[1]}`;
  const version = ua.match(/Version\/(\d+(?:\.\d+)*)/i);
  if (/Safari/i.test(ua)) return version ? `Safari ${version[1]}` : 'Safari';
  return UNKNOWN;
}

function osOf(ua) {
  const android = ua.match(/Android\s+(\d+(?:\.\d+)*)/i);
  if (android) return { os: `Android ${android[1]}`, match: android, family: 'android' };
  const ios = ua.match(/(?:iPhone|iPad).*?OS\s+(\d+)[._](\d+)/i);
  if (ios) return { os: `iOS ${ios[1]}.${ios[2]}`, match: ios, family: 'ios' };
  const windows = ua.match(/Windows NT\s+(\d+\.\d+)/i);
  if (windows) {
    const map = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' };
    return { os: map[windows[1]] || `Windows NT ${windows[1]}`, match: windows, family: 'windows' };
  }
  const mac = ua.match(/Mac OS X\s+(\d+)(?:[._]\d+)*/i);
  if (mac) {
    // 只到主版本（口径：`macOS 14`）；10_15_7 这类老版本也不展开小版本。
    return { os: `macOS ${mac[1]}`, match: mac, family: 'mac' };
  }
  if (/CrOS/i.test(ua)) return { os: 'ChromeOS', match: null, family: 'cros' };
  if (/Linux/i.test(ua)) return { os: 'Linux', match: null, family: 'linux' };
  return { os: UNKNOWN, match: null, family: 'unknown' };
}

/**
 * @param {string} ua 原始 User-Agent
 * @returns {{device: string, os: string, client: string}}
 */
export function parseUserAgent(ua) {
  const text = clean(ua);
  if (!text) return { device: UNKNOWN, os: UNKNOWN, client: UNKNOWN };

  const info = osOf(text);
  let device = UNKNOWN;

  // FnCal 自有 UA：`FnCalAndroid/0.3.0 (Xiaomi 13)` / `FnCalWidget/0.3.0 (Xiaomi 13)`
  // 括号里是机型；旧格式没有括号，不猜，交给下面的系统规则。
  const shell = text.match(/FnCal(?:Android|Widget)\/\d+(?:\.\d+)*\s*\(([^)]+)\)/i);
  if (shell && clean(shell[1])) {
    device = clean(shell[1]);
  } else if (info.family === 'android') {
    device = androidModel(text, info.match) || 'Android 设备';
  } else if (info.family === 'ios') {
    device = /iPad/i.test(text) ? 'iPad' : 'iPhone';
  } else if (info.family === 'windows' || info.family === 'mac' || info.family === 'cros' || info.family === 'linux') {
    device = '台式机';
  }

  return { device, os: info.os, client: clientOf(text) };
}
