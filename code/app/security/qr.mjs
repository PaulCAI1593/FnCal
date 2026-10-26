// QR 码生成（2FA 绑定用）——字节模式、纠错等级 M、版本 1–10，纯 JS 无依赖。
// 布局/掩码/纠错与 qrcode-generator（MIT, kazuhikoarase）同源实现；只用字节模式，
// 足以编码 otpauth:// URI。不联网、不调用外部命令。
const EC_LEVEL_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const PATTERN_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const G15 = 0x0537;
const G18 = 0x1f25;
const G15_MASK = 0x5412;

function bchDigit(value) {
  let digit = 0;
  let rest = value;
  while (rest !== 0) {
    digit += 1;
    rest >>>= 1;
  }
  return digit;
}

export function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

export function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

// GF(256)，本原多项式 0x11d
const EXP = new Array(512);
const LOG = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}());

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(count) {
  let poly = [1];
  for (let i = 0; i < count; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// RS 纠错码字（返回 count 个校验字节），供矩阵与单测共用。
export function rsCodewords(data, count) {
  const generator = rsGeneratorPoly(count);
  const out = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift();
    out.push(0);
    for (let i = 0; i < count; i += 1) out[i] ^= gfMul(generator[i + 1], factor);
  }
  return out;
}

function utf8Bytes(text) {
  return Array.from(Buffer.from(String(text), 'utf8'));
}

function rawDataBits(text, version) {
  const bytes = utf8Bytes(text);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  return bits;
}

function capacityBytes(version) {
  const [ecCodewords, g1Count, g1Data, g2Count, g2Data] = EC_LEVEL_M[version];
  const dataCodewords = g1Count * g1Data + g2Count * g2Data;
  const lengthBits = version <= 9 ? 8 : 16;
  const availableBits = dataCodewords * 8 - 4 - lengthBits;
  void ecCodewords;
  return Math.floor(availableBits / 8);
}

export function detectVersion(text) {
  const byteLength = utf8Bytes(text).length;
  for (const version of Object.keys(EC_LEVEL_M).map(Number).sort((a, b) => a - b)) {
    if (byteLength <= capacityBytes(version)) return version;
  }
  const error = new Error(`内容过长，无法生成二维码（${byteLength} 字节）`);
  error.code = 'QR_TOO_LONG';
  throw error;
}

function buildCodewords(text, version) {
  const [ecCodewords, g1Count, g1Data, g2Count, g2Data] = EC_LEVEL_M[version];
  const totalData = g1Count * g1Data + g2Count * g2Data;
  const bits = rawDataBits(text, version);
  const capacityBits = totalData * 8;
  if (bits.length > capacityBits) throw new Error('内容超出二维码容量');
  // 终止符 + 补齐到字节
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (dataCodewords.length < totalData) {
    dataCodewords.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1Count; i += 1) {
    blocks.push({ data: dataCodewords.slice(offset, offset + g1Data), ecCount: ecCodewords });
    offset += g1Data;
  }
  for (let i = 0; i < g2Count; i += 1) {
    blocks.push({ data: dataCodewords.slice(offset, offset + g2Data), ecCount: ecCodewords });
    offset += g2Data;
  }
  for (const block of blocks) block.ec = rsCodewords(block.data, block.ecCount);

  const result = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  const maxEc = Math.max(...blocks.map(b => b.ec.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of blocks) if (i < block.ec.length) result.push(block.ec[i]);
  }
  return result;
}

function maskFn(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
    default: return false;
  }
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (row, col, dark) => {
    if (row >= 0 && row < size && col >= 0 && col < size) modules[row][col] = Boolean(dark);
  };

  // 定位图案 + 分隔符
  const probe = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, dark);
      }
    }
  };
  probe(0, 0);
  probe(size - 7, 0);
  probe(0, size - 7);

  // 校正图案
  const positions = PATTERN_POSITIONS[version];
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const row = positions[i];
      const col = positions[j];
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  // 时序图案
  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] == null) set(6, i, i % 2 === 0);
    if (modules[i][6] == null) set(i, 6, i % 2 === 0);
  }

  // 版本信息（v7+）
  if (version >= 7) {
    const bits = bchTypeNumber(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      set(row, col, dark);
      set(col, row, dark);
    }
  }

  // 预留格式信息区（含固定暗模块）：必须先占位，否则 placeData 会把数据写进格式区，
  // 被 placeFormat 覆盖后数据流整体错位（历史上真实存在过的 bug）。
  for (const [row, col] of formatPositions(size)) set(row, col, false);
  return { size, modules, set };
}

// 15 位格式信息的两份副本（顺序 = 位序 bit0…bit14）与固定暗模块位置。
function formatPositions(size) {
  const out = [];
  for (let i = 0; i < 15; i += 1) {
    // 左上角竖向（含左下角竖向）
    if (i < 6) out.push([i, 8]);
    else if (i < 8) out.push([i + 1, 8]);
    else out.push([size - 15 + i, 8]);
    // 右上角横向 + 左上角横向
    if (i < 8) out.push([8, size - i - 1]);
    else if (i < 9) out.push([8, 15 - i]);
    else out.push([8, 14 - i]);
  }
  out.push([size - 8, 8]);
  return out;
}

function placeFormat(matrix, { size }, maskPattern) {
  const data = (0b00 << 3) | maskPattern; // 纠错等级 M = 00
  const bits = bchTypeInfo(data);
  const { set } = matrix;
  const positions = formatPositions(size);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    const vertical = positions[i * 2];
    const horizontal = positions[i * 2 + 1];
    set(vertical[0], vertical[1], dark);
    set(horizontal[0], horizontal[1], dark);
  }
  set(size - 8, 8, true); // 固定暗模块
}

function placeData(matrix, codewords, maskPattern) {
  const { size, modules } = matrix;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const targetRow = row;
        const targetCol = col - c;
        if (modules[targetRow][targetCol] == null) {
          let dark = false;
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskFn(maskPattern, targetRow, targetCol)) dark = !dark;
          modules[targetRow][targetCol] = dark;
          bitIndex -= 1;
          if (bitIndex === -1) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

// 掩码罚分（规则 1/2/3/4 的简化实现，用于挑选观感最好的掩码）。
function penalty(modules, size) {
  let score = 0;
  const runs = (line) => {
    let count = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) count += 1;
      else {
        if (count >= 5) score += count - 2;
        count = 1;
      }
    }
    if (count >= 5) score += count - 2;
  };
  for (let r = 0; r < size; r += 1) {
    runs(modules[r]);
    const column = [];
    for (let c = 0; c < size; c += 1) column.push(modules[c][r]);
    runs(column);
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = modules[r][c];
      if (value === modules[r][c + 1] && value === modules[r + 1][c] && value === modules[r + 1][c + 1]) score += 3;
    }
  }
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  const scan = (line) => {
    for (let i = 0; i + 11 <= line.length; i += 1) {
      let matchA = true;
      let matchB = true;
      for (let j = 0; j < 11; j += 1) {
        if (line[i + j] !== patternA[j]) matchA = false;
        if (line[i + j] !== patternB[j]) matchB = false;
      }
      if (matchA || matchB) score += 40;
    }
  };
  for (let r = 0; r < size; r += 1) {
    scan(modules[r]);
    const column = [];
    for (let c = 0; c < size; c += 1) column.push(modules[c][r]);
    scan(column);
  }
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (modules[r][c]) dark += 1;
  const total = size * size;
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10;
  return score;
}

// 返回 { version, size, mask, modules（boolean[][]，无静区） }
export function buildQr(text, { version: forcedVersion } = {}) {
  const payload = String(text);
  const version = forcedVersion || detectVersion(payload);
  const codewords = buildCodewords(payload, version);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = createMatrix(version);
    placeData(matrix, codewords, mask);
    placeFormat(matrix, matrix, mask);
    const score = penalty(matrix.modules, matrix.size);
    if (!best || score < best.score) best = { mask, score, modules: matrix.modules, size: matrix.size };
  }
  return { version, size: best.size, mask: best.mask, modules: best.modules };
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 输出 SVG（含 4 模块静区），可以直接插到页面里 <img src="data:image/svg+xml;base64,..."> 或 innerHTML。
export function qrSvg(text, { moduleSize = 4, quietZone = 4, dark = '#111111', light = '#ffffff', title = '二维码', version } = {}) {
  const qr = buildQr(text, { version });
  const total = (qr.size + quietZone * 2) * moduleSize;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${escapeXml(title)}">`);
  parts.push(`<rect width="${total}" height="${total}" fill="${light}"/>`);
  const path = [];
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.modules[row][col]) continue;
      const x = (col + quietZone) * moduleSize;
      const y = (row + quietZone) * moduleSize;
      path.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  parts.push(`<path d="${path.join('')}" fill="${dark}"/>`);
  parts.push('</svg>');
  return { svg: parts.join(''), version: qr.version, mask: qr.mask, size: qr.size };
}

export { capacityBytes };
