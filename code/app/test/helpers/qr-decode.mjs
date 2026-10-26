// 测试辅助：把 buildQr() 产出的模块矩阵**独立解码**回文本。
//
// 目的：给「2FA 绑定二维码」一个真实验证——只要编码器在布局/掩码/纠错块交织上写错，
// 这里的解码（另写一套读取逻辑与掩码公式，不 import 编码器内部函数）就会还原失败，
// 而不是自己编码自己读、错也一起错。
//
// 支持范围与编码器一致：字节模式、纠错等级 M、版本 1–10。

const EC_M = {
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

const ALIGN = {
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

function maskAt(pattern, row, col) {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`unknown mask ${pattern}`);
  }
}

function readFormat(modules, size) {
  // 15 位格式信息（低 5 位是 EC 等级 + 掩码，其余为 BCH），矩阵里存两份：
  //   副本 1：列 8 的 0..5、7、8 行 = bit0..7；第 8 行的 7、5、4…0 列 = bit8..14。
  //   副本 2：第 8 行的 size-1..size-8 列 = bit0..7；列 8 的 size-7..size-1 行 = bit8..14。
  const copy1 = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const copy2 = [
    [8, size - 1], [8, size - 2], [8, size - 3], [8, size - 4], [8, size - 5], [8, size - 6], [8, size - 7], [8, size - 8],
    [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8], [size - 3, 8], [size - 2, 8], [size - 1, 8],
  ];
  let bits = 0;
  for (let i = 0; i < copy1.length; i += 1) {
    const [r, c] = copy1[i];
    if (modules[r][c]) bits |= 1 << i;
  }
  let mirrorBits = 0;
  for (let i = 0; i < copy2.length; i += 1) {
    const [r, c] = copy2[i];
    if (modules[r][c]) mirrorBits |= 1 << i;
  }
  const data = bits ^ 0x5412;
  const ecBits = (data >> 13) & 0x3; // M = 0b00
  const mask = (data >> 10) & 0x7;
  return { ecBits, mask, formatConsistent: (mirrorBits ^ 0x5412) === data };
}

function isFunctionModule(row, col, size, version) {
  // 定位图案 + 分隔符（含左上、右上、左下三块 9×9/9×8 区域）
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= size - 8) return true;
  if (row >= size - 8 && col < 9) return true;
  // 定时图案
  if (row === 6 || col === 6) return true;
  // 校正图案（3×3 中心）
  const centers = ALIGN[version];
  for (const cr of centers) {
    for (const cc of centers) {
      const nearFinder =
        (cr < 9 && cc < 9) ||
        (cr < 9 && cc > size - 9) ||
        (cr > size - 9 && cc < 9);
      if (nearFinder) continue;
      if (Math.abs(row - cr) <= 2 && Math.abs(col - cc) <= 2) return true;
    }
  }
  // 版本信息（版本 7 起：右上 6×3、左下 3×6）
  if (version >= 7) {
    if (row < 6 && col >= size - 11 && col <= size - 9) return true;
    if (col < 6 && row >= size - 11 && row <= size - 9) return true;
  }
  return false;
}

function readRawBits(modules, size, mask, version) {
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过定时图案所在列
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k += 1) {
        const col = right - k;
        if (isFunctionModule(row, col, size, version)) continue;
        const value = modules[row][col] !== maskAt(mask, row, col);
        bits.push(value ? 1 : 0);
      }
    }
    upward = !upward;
  }
  return bits;
}

function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let value = 0;
    for (let k = 0; k < 8; k += 1) value = (value << 1) | bits[i + k];
    bytes.push(value);
  }
  return bytes;
}

/**
 * 解码 buildQr() 的模块矩阵。
 * @param {boolean[][]} modules 行优先、true = 深色
 * @returns {{text: string, version: number, mask: number, formatConsistent: boolean}}
 */
export function decodeQr(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  if (!EC_M[version]) throw new Error(`unsupported version ${version}`);
  const { ecBits, mask, formatConsistent } = readFormat(modules, size);
  if (ecBits !== 0) throw new Error(`unexpected EC bits ${ecBits}`);

  const bits = readRawBits(modules, size, mask, version);
  const stream = bitsToBytes(bits);

  const [ecLen, blocks1, data1, blocks2, data2] = EC_M[version];
  const dataLens = [];
  for (let i = 0; i < blocks1; i += 1) dataLens.push(data1);
  for (let i = 0; i < blocks2; i += 1) dataLens.push(data2);
  const maxData = Math.max(...dataLens);
  const blocks = dataLens.map(() => []);
  let cursor = 0;
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < dataLens.length; b += 1) {
      if (i < dataLens[b]) {
        blocks[b].push(stream[cursor]);
        cursor += 1;
      }
    }
  }
  const data = [];
  for (const block of blocks) data.push(...block);
  // 交织区之后是每块的纠错码字：这里只确认长度足够，不再做 RS 校验。
  const expected = dataLens.reduce((sum, n) => sum + n, 0) + ecLen * dataLens.length;
  if (stream.length < expected) throw new Error(`stream too short: ${stream.length} < ${expected}`);

  const dataBits = [];
  for (const byte of data) {
    for (let k = 7; k >= 0; k -= 1) dataBits.push((byte >> k) & 1);
  }
  const take = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1) value = (value << 1) | dataBits.shift();
    return value;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`unexpected mode ${mode.toString(2)}`);
  // 字节模式的字符计数位宽：v1–v9 = 8 位，v10+ = 16 位。
  const length = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(8));
  const text = Buffer.from(bytes).toString('utf8');
  return { text, version, mask, formatConsistent };
}
