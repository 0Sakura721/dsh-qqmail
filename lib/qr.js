/**
 * dsh-qqmail / lib/qr.js
 *
 * 零依赖二维码生成器。
 *
 * 为什么自己写：插件要能"装完就能扫码授权"，就得在终端里画出二维码。
 * 但 qrcode 通常只是被别的插件顺带 hoist 上来的（不是本插件的直接依赖），
 * 依赖它等于赌别人的安装顺序。QR 编码算法本身不长，自己实现反而稳。
 *
 * 实现范围：Byte 模式、纠错等级 M、版本 1–10（足以容纳 OAuth 授权 URL，
 * 实测这类 URL 约 250–400 字节）。超出容量会抛错，不静默出错图。
 *
 * 注：掩码按规范对 8 种候选逐一评分取最优（规则 1–4），而不是固定掩码 ——
 * 固定掩码在部分扫码器上会明显变慢。
 */

// ── GF(256) 算术 ────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成 degree 阶生成多项式（Reed-Solomon）。 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字。 */
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const result = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < ecCount; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

// ── 容量表：纠错等级 M，版本 1–20 ────────────────────────────────
// 每项给出**真实的块结构**。这些数字不是手抄的：用标准实现反查生成，
// 并用「Σcount×data = 总数据码字」「Σcount×(data+ec) = 总码字」双约束校验。
//
// 为什么必须写死、不能用「总数 ÷ 块数」推导：QR 同一版本内的数据块可以有多种尺寸
// （v10-M 是 4×43 + 1×44，v11-M 是 1×50 + 4×51），而且不同版本的纠错码字数也不同。
// 早期版本靠算式推导，v8 起块长顺序反、v10 块数错、v11+ 完全对不上。
//
// groups 按「短块在前」排列。
const CAPACITY_M = {
  1: { groups: [{ count: 1, dataCodewords: 16, ecCodewords: 10 }] },
  2: { groups: [{ count: 1, dataCodewords: 28, ecCodewords: 16 }] },
  3: { groups: [{ count: 1, dataCodewords: 44, ecCodewords: 26 }] },
  4: { groups: [{ count: 2, dataCodewords: 32, ecCodewords: 18 }] },
  5: { groups: [{ count: 2, dataCodewords: 43, ecCodewords: 24 }] },
  6: { groups: [{ count: 4, dataCodewords: 27, ecCodewords: 16 }] },
  7: { groups: [{ count: 4, dataCodewords: 31, ecCodewords: 18 }] },
  8: { groups: [{ count: 2, dataCodewords: 38, ecCodewords: 22 }, { count: 2, dataCodewords: 39, ecCodewords: 22 }] },
  9: { groups: [{ count: 3, dataCodewords: 36, ecCodewords: 22 }, { count: 2, dataCodewords: 37, ecCodewords: 22 }] },
  10: { groups: [{ count: 4, dataCodewords: 43, ecCodewords: 26 }, { count: 1, dataCodewords: 44, ecCodewords: 26 }] },
  11: { groups: [{ count: 1, dataCodewords: 50, ecCodewords: 30 }, { count: 4, dataCodewords: 51, ecCodewords: 30 }] },
  12: { groups: [{ count: 6, dataCodewords: 36, ecCodewords: 22 }, { count: 2, dataCodewords: 37, ecCodewords: 22 }] },
  13: { groups: [{ count: 8, dataCodewords: 37, ecCodewords: 22 }, { count: 1, dataCodewords: 38, ecCodewords: 22 }] },
  14: { groups: [{ count: 4, dataCodewords: 40, ecCodewords: 24 }, { count: 5, dataCodewords: 41, ecCodewords: 24 }] },
  15: { groups: [{ count: 5, dataCodewords: 41, ecCodewords: 24 }, { count: 5, dataCodewords: 42, ecCodewords: 24 }] },
  16: { groups: [{ count: 7, dataCodewords: 45, ecCodewords: 28 }, { count: 3, dataCodewords: 46, ecCodewords: 28 }] },
  17: { groups: [{ count: 10, dataCodewords: 46, ecCodewords: 28 }, { count: 1, dataCodewords: 47, ecCodewords: 28 }] },
  18: { groups: [{ count: 9, dataCodewords: 43, ecCodewords: 26 }, { count: 4, dataCodewords: 44, ecCodewords: 26 }] },
  19: { groups: [{ count: 3, dataCodewords: 44, ecCodewords: 26 }, { count: 11, dataCodewords: 45, ecCodewords: 26 }] },
  20: { groups: [{ count: 3, dataCodewords: 41, ecCodewords: 26 }, { count: 13, dataCodewords: 42, ecCodewords: 26 }] },
};

/** 该版本的数据码字总数。 */
function dataCodewordsOf(version) {
  return CAPACITY_M[version].groups.reduce((sum, g) => sum + g.count * g.dataCodewords, 0);
}

/** 该版本的总码字（数据 + 纠错）。 */
function totalCodewordsOf(version) {
  return CAPACITY_M[version].groups.reduce(
    (sum, g) => sum + g.count * (g.dataCodewords + g.ecCodewords),
    0,
  );
}

/**
 * 把数据码字切成数据块。
 * 直接按容量表里声明的块结构切，短块在前。
 */
function splitIntoBlocks(codewords, version) {
  const blocks = [];
  let offset = 0;
  for (const group of CAPACITY_M[version].groups) {
    for (let i = 0; i < group.count; i += 1) {
      blocks.push(codewords.slice(offset, offset + group.dataCodewords));
      offset += group.dataCodewords;
    }
  }
  return blocks;
}

/** 取该版本的每个块的纠错码字数（同版本内各块相同）。 */
function ecPerBlockOf(version) {
  return CAPACITY_M[version].groups[0].ecCodewords;
}

/** 各版本可用于装载数据（不含纠错）的字节数。 */
function dataCapacityBytes(version) {
  return dataCodewordsOf(version);
}

/** 版本 1–10 的字节模式头部：4 位模式 + 8 位长度。 */
/**
 * 字节模式的字符计数字段位宽。
 * 版本 1–9 是 8 位，版本 10 及以上是 16 位（ISO/IEC 18004 表 3）。
 *
 * 踩过的坑：早期版本固定用 8 位，v10 起长度字段宽度不足，
 * 位流整体错位，表现为数据区大面积不匹配。
 */
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

// ── 位流 ────────────────────────────────────────────────────────
class BitBuffer {
  constructor() {
    this.bits = [];
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length() {
    return this.bits.length;
  }
}

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

// ── 矩阵工具 ────────────────────────────────────────────────────
function makeMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

/**
 * 版本 1–10 的校正图案中心坐标（ISO/IEC 18004 表 E.1）。
 *
 * 不能靠公式现场算：常见写法 `ceil((size-13)/(count*2-2))*2` 在 v7 会得到错误的步长
 * （44/4=11 → 取偶 12，正确值也是 12 但起点不同），v8 之后偏差更大。
 * 踩过的坑：早期版本用公式生成，v7 起校正图案位置错，整块数据区错位 300+ 模块。
 */
const ALIGNMENT_CENTERS = {
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
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

/** 画定位图案、分隔符、校正图案、时序图案。 */
function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[rr][cc] = inRing || inCore ? 1 : 0;
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // 时序图案
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === null) matrix[6][i] = bit;
    if (matrix[i][6] === null) matrix[i][6] = bit;
  }

  // 校正图案
  // 只跳过与三个定位图案重叠的角点。判据必须是「坐标是否在定位图案的 9×9 范围内」，
  // 不能用「该点是否已被占用」—— 因为时序图案先画了整行 6 / 整列 6，
  // 会把 (6,22)、(22,6) 这类校正图案误判成已占用，导致 v7 只画出 4 个而不是 9 个，
  // 数据区多出 40 个模块，整张图错位。
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  const overlapsFinder = (row, col, size) => {
    const inBox = (r0, c0) => row >= r0 && row <= r0 + 8 && col >= c0 && col <= c0 + 8;
    return inBox(0, 0) || inBox(0, size - 9) || inBox(size - 9, 0);
  };
  for (const row of centers) {
    for (const col of centers) {
      if (overlapsFinder(row, col, size)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const isRing = Math.abs(r) === 2 || Math.abs(c) === 2;
          const isCore = r === 0 && c === 0;
          matrix[row + r][col + c] = isRing || isCore ? 1 : 0;
        }
      }
    }
  }

  // 格式信息区先占位（稍后写入真值），避免数据区踩到
  reserveFormatAreas(matrix, size);

  // 深色模块（固定 1）
  matrix[size - 8][8] = 1;
}

function reserveFormatAreas(matrix, size) {
  // 第 6 行 / 第 6 列是时序图案，格式信息要绕开它们。
  // 踩过坑：早期版本在这里无差别写 0，把 (8,6) 和 (6,8) 两个时序模块抹掉了，
  // 与标准库逐模块比对时差 4 个点，扫码成功率明显下降。
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue;
    if (matrix[8][i] === null) matrix[8][i] = 0;
    if (matrix[i][8] === null) matrix[i][8] = 0;
  }
  for (let i = 0; i < 8; i += 1) {
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = 0;
  }
}

/** 格式信息：纠错等级 + 掩码号，BCH(15,5) + 0x5412 异或。 */
function formatBits(ecLevelBits, mask) {
  const data = (ecLevelBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function writeFormatInfo(matrix, mask) {
  const size = matrix.length;
  const bits = formatBits(0, mask); // 纠错等级 M 的两位是 00

  // 第一份：围绕左上定位图案的 L 形。
  // 位序（bit0 = LSB）：
  //   bit0..bit5  → 纵向 (0,8),(1,8),(2,8),(3,8),(4,8),(5,8)
  //   bit6        → (7,8)
  //   bit7        → (8,8)
  //   bit8        → (8,7)
  //   bit9..bit14 → 横向 (8,5),(8,4),(8,3),(8,2),(8,1),(8,0)
  //
  // 踩过的坑：早期版本把这两组对调了（bit0..5 走横向、bit9..14 走纵向），
  // 逐模块比对时行 8 与列 8 的序列正好互换，差 4–6 个点。
  // 注意 (8,6) 与 (6,8) 是时序图案，格式信息必须跳过它们。
  const firstCopy = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = firstCopy[i];
    matrix[r][c] = (bits >>> i) & 1;
  }

  // 第二份：右上一列 + 左下一行
  for (let i = 0; i < 8; i += 1) {
    matrix[8][size - 1 - i] = (bits >>> i) & 1;
  }
  for (let i = 8; i < 15; i += 1) {
    matrix[size - 15 + i][8] = (bits >>> i) & 1;
  }
}

/** 版本信息（版本 ≥ 7 才有）。 */
function writeVersionInfo(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (version << 12) | remainder;

  // 18 位版本信息放在两个 3×6 区块：
  //   右上：列从 size-11 起，行 0..5，每行 3 位
  //   左下：行从 size-11 起，列 0..5，每列 3 位（与右上转置）
  // bit i 的落点用 i 的「3 位一组」编号推导：
  //   row = floor(i / 3)，col = i % 3
  // 踩过的坑：早期版本直接把 (row, col) 当作绝对坐标写进右上角，
  // 却没做 size-11 的偏移，v7 起整块位置错位。
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    // 右上区块：(row, size-11+col)
    matrix[row][size - 11 + col] = bit;
    // 左下区块：(size-11+col, row) —— 转置位置
    matrix[size - 11 + col][row] = bit;
  }
}

/** 数据模块的之字形放置顺序。 */
function dataModulePositions(matrix) {
  const size = matrix.length;
  const positions = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // 跳过时序列
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k += 1) {
        const c = col - k;
        if (matrix[row][c] === null) positions.push([row, c]);
      }
    }
    upward = !upward;
  }
  return positions;
}

/** 掩码函数。 */
const MASK_FUNCS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 掩码评分（规则 1–4），分数越小越好。 */
function scoreMask(matrix) {
  const size = matrix.length;
  let score = 0;

  // 规则 1：同色连续 5 个以上
  const scanLine = (get) => {
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      let prev = get(i, 0);
      for (let j = 1; j < size; j += 1) {
        const cur = get(i, j);
        if (cur === prev) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += run - 2;
    }
  };
  scanLine((i, j) => matrix[i][j]);
  scanLine((i, j) => matrix[j][i]);

  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  // 规则 3：形如 1:1:3:1:1 的图案
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (row, col, pattern, horizontal) => {
    for (let k = 0; k < pattern.length; k += 1) {
      const r = horizontal ? row : row + k;
      const c = horizontal ? col + k : col;
      if (r >= size || c >= size) return false;
      if (matrix[r][c] !== pattern[k]) return false;
    }
    return true;
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size - 10; c += 1) {
      if (matchAt(r, c, patternA, true) || matchAt(r, c, patternB, true)) score += 40;
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r < size - 10; r += 1) {
      if (matchAt(r, c, patternA, false) || matchAt(r, c, patternB, false)) score += 40;
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (matrix[r][c] === 1) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/**
 * 生成二维码矩阵。
 * @param {string} text
 * @returns {number[][]} 0/1 矩阵
 */
export function encodeQr(text) {
  const bytes = utf8Bytes(text);

  // 选版本：必须同时满足「位流长度」和「该版本的数据码字容量」。
  // 字符计数字段宽度随版本变化（v10 起 16 位），所以要按候选版本逐个算。
  const MAX_VERSION = 20;
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const capacityBits = dataCapacityBytes(v) * 8;
    const needed = 4 + charCountBits(v) + bytes.length * 8;
    if (needed <= capacityBits) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    const maxBytes = dataCapacityBytes(MAX_VERSION) - 3;
    throw new Error(`内容过长（${bytes.length} 字节），超出本实现容量上限（版本 ${MAX_VERSION}-M，约 ${maxBytes} 字节）。`);
  }

  const dataBytes = dataCapacityBytes(version);

  // ── 位流：模式 + 长度 + 数据 + 终止符 + 填充 ──
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // Byte 模式
  buffer.put(bytes.length, charCountBits(version));
  for (const byte of bytes) buffer.put(byte, 8);

  const capacityBits = dataBytes * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.put(0, 1);

  const codewords = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k += 1) byte = (byte << 1) | buffer.bits[i + k];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataBytes) {
    codewords.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  // ── 分块 + 纠错 + 交织 ──
  // 块结构按容量表声明切（v10-M 就是 4×43 + 2×44，不是均分）。
  const ecPerBlock = ecPerBlockOf(version);
  const blockDatas = splitIntoBlocks(codewords, version);
  const blocks = blockDatas.map((data) => ({ data, ec: rsEncode(data, ecPerBlock) }));

  const interleaved = [];
  const maxDataLen = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const block of blocks) if (i < block.data.length) interleaved.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) if (i < block.ec.length) interleaved.push(block.ec[i]);
  }

  // ── 放置 ──
  const size = version * 4 + 17;
  const base = makeMatrix(size);
  placeFunctionPatterns(base, version);
  writeVersionInfo(base, version);

  const positions = dataModulePositions(base);
  const bits = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }

  // 剩余位（余数位）补 0
  while (bits.length < positions.length) bits.push(0);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = base.map((row) => row.slice());
    const fn = MASK_FUNCS[mask];
    for (let i = 0; i < positions.length; i += 1) {
      const [r, c] = positions[i];
      const bit = bits[i] ?? 0;
      matrix[r][c] = fn(r, c) ? bit ^ 1 : bit;
    }
    writeFormatInfo(matrix, mask);
    const score = scoreMask(matrix);
    if (score < bestScore) {
      bestScore = score;
      best = matrix;
    }
  }

  return best;
}

/**
 * 渲染成终端可扫的文本。
 *
 * 用「两个全块字符」表示一个模块。单字符在多数终端里宽高比约 1:2，
 * 若把一行模块画成一个字符，整张图会变成竖长条，手机很难扫；
 * 一个模块画成 ██ 才能让长宽比接近 1:1。
 *
 * 曾经试过用半块字符（▀▄）把两行模块压成一行来省高度，但那样会依赖终端
 * 是否支持半块、行高是否等宽 —— 截图后经常扫不出来。这里选择更笨但更稳的画法。
 *
 * @param {number[][]} matrix
 * @param {{ quietZone?: number }} options
 */
export function renderTerminal(matrix, { quietZone = 2 } = {}) {
  const size = matrix.length;
  const lines = [];
  for (let r = -quietZone; r < size + quietZone; r += 1) {
    let line = '';
    for (let c = -quietZone; c < size + quietZone; c += 1) {
      line += getModule(matrix, r, c) === 1 ? '██' : '  ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function getModule(matrix, row, col) {
  if (row < 0 || col < 0 || row >= matrix.length || col >= matrix.length) return 0;
  return matrix[row][col];
}

/** 渲染成 SVG 字符串（给 Web 界面用）。 */
export function renderSvg(matrix, { moduleSize = 6, quietZone = 2 } = {}) {
  const size = matrix.length;
  const total = (size + quietZone * 2) * moduleSize;

  // 按行合并连续深色模块，输出一条 path。
  // 逐模块输出 <rect> 时，v13 的 SVG 有 100KB+；按行游程编码后降到 10KB 左右，
  // 对 Web 界面直接内联进 DOM 更友好。
  const commands = [];
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (matrix[r][c] !== 1) {
        c += 1;
        continue;
      }
      let run = 1;
      while (c + run < size && matrix[r][c + run] === 1) run += 1;
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;
      commands.push(`M${x} ${y}h${run * moduleSize}v${moduleSize}h${-run * moduleSize}z`);
      c += run;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#ffffff"/>`
    + `<path fill="#000000" d="${commands.join('')}"/></svg>`;
}

/** ASCII 降级：极简终端或不支持块字符时用。 */
export function renderAscii(matrix, { quietZone = 4 } = {}) {
  const size = matrix.length;
  const lines = [];
  for (let r = -quietZone; r < size + quietZone; r += 1) {
    let line = '';
    for (let c = -quietZone; c < size + quietZone; c += 1) {
      line += getModule(matrix, r, c) === 1 ? '##' : '  ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
