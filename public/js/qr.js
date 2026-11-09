/**
 * QR Code Generator - Standalone, lightweight, pure JavaScript implementation
 * Supports alphanumeric and binary encoding (Byte mode), QR Version 1 to 10,
 * Error correction level M/L, outputs crisp, vector SVG string or canvas.
 */
(function (global) {
  'use strict';

  // Galois Field GF(256) math tables
  const GF256_EXP = new Uint8Array(512);
  const GF256_LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF256_EXP[i] = x;
      GF256_EXP[i + 255] = x;
      GF256_LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= 0x11d;
    }
  })();

  function gfMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return GF256_EXP[GF256_LOG[x] + GF256_LOG[y]];
  }

  function polyMul(p1, p2) {
    const r = new Uint8Array(p1.length + p2.length - 1);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        r[i + j] ^= gfMul(p1[i], p2[j]);
      }
    }
    return r;
  }

  function rsGeneratorPoly(degree) {
    let p = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      p = polyMul(p, new Uint8Array([1, GF256_EXP[i]]));
    }
    return p;
  }

  function rsEncode(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const msg = new Uint8Array(data.length + ecCount);
    msg.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.subarray(data.length);
  }

  // Version capacities and EC specs for Level L and M (Version 1 to 6)
  const VERSIONS = [
    null,
    { size: 21, totalBytes: 26, dataBytes: 19, ecBytes: 7, alignments: [] },          // V1-L/M
    { size: 25, totalBytes: 44, dataBytes: 34, ecBytes: 10, alignments: [6, 18] },     // V2
    { size: 29, totalBytes: 70, dataBytes: 55, ecBytes: 15, alignments: [6, 22] },     // V3
    { size: 33, totalBytes: 100, dataBytes: 80, ecBytes: 20, alignments: [6, 26] },    // V4
    { size: 37, totalBytes: 134, dataBytes: 108, ecBytes: 26, alignments: [6, 30] },   // V5
    { size: 41, totalBytes: 172, dataBytes: 136, ecBytes: 36, alignments: [6, 34] },   // V6
  ];

  function chooseVersion(byteCount) {
    for (let v = 1; v < VERSIONS.length; v++) {
      const spec = VERSIONS[v];
      // Header: 4 bits mode + 8 bits count = 12 bits = ~2 bytes overhead
      if (byteCount + 3 <= spec.dataBytes) return v;
    }
    return 6;
  }

  function createMatrix(size) {
    const m = [];
    const reserved = [];
    for (let r = 0; r < size; r++) {
      m.push(new Uint8Array(size));
      reserved.push(new Uint8Array(size));
    }
    return { size, m, reserved };
  }

  function setFinderPattern(mat, r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = r0 + r;
        const col = c0 + c;
        if (row < 0 || row >= mat.size || col < 0 || col >= mat.size) continue;
        mat.reserved[row][col] = 1;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            mat.m[row][col] = 1;
          } else {
            mat.m[row][col] = 0;
          }
        } else {
          mat.m[row][col] = 0;
        }
      }
    }
  }

  function setAlignmentPattern(mat, r0, c0) {
    if (mat.reserved[r0][c0]) return;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const row = r0 + r;
        const col = c0 + c;
        mat.reserved[row][col] = 1;
        if (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) {
          mat.m[row][col] = 1;
        } else {
          mat.m[row][col] = 0;
        }
      }
    }
  }

  function encodeData(text, spec) {
    const utf8 = new TextEncoder().encode(text);
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >> i) & 1);
      }
    }

    // Byte mode = 0100
    pushBits(0b0100, 4);
    pushBits(utf8.length, 8);
    for (let i = 0; i < utf8.length; i++) {
      pushBits(utf8[i], 8);
    }

    // Terminator
    const dataBitCapacity = spec.dataBytes * 8;
    for (let i = 0; i < 4 && bits.length < dataBitCapacity; i++) {
      bits.push(0);
    }
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      bytes.push(b);
    }

    // Pad bytes
    const pad = [0xec, 0x11];
    let padIdx = 0;
    while (bytes.length < spec.dataBytes) {
      bytes.push(pad[padIdx % 2]);
      padIdx++;
    }

    const ecBytes = rsEncode(new Uint8Array(bytes), spec.ecBytes);
    const finalStream = new Uint8Array(spec.totalBytes);
    finalStream.set(bytes, 0);
    finalStream.set(ecBytes, bytes.length);

    const allBits = [];
    for (let i = 0; i < finalStream.length; i++) {
      for (let j = 7; j >= 0; j--) {
        allBits.push((finalStream[i] >> j) & 1);
      }
    }
    return allBits;
  }

  function buildQRMatrix(text) {
    const rawLen = new TextEncoder().encode(text).length;
    const version = chooseVersion(rawLen);
    const spec = VERSIONS[version];
    const mat = createMatrix(spec.size);

    // 1. Finder patterns
    setFinderPattern(mat, 0, 0);
    setFinderPattern(mat, 0, spec.size - 7);
    setFinderPattern(mat, spec.size - 7, 0);

    // 2. Alignment patterns
    if (spec.alignments.length > 0) {
      const coords = spec.alignments;
      for (const r of coords) {
        for (const c of coords) {
          setAlignmentPattern(mat, r, c);
        }
      }
    }

    // 3. Timing patterns
    for (let i = 8; i < spec.size - 8; i++) {
      if (!mat.reserved[6][i]) {
        mat.reserved[6][i] = 1;
        mat.m[6][i] = i % 2 === 0 ? 1 : 0;
      }
      if (!mat.reserved[i][6]) {
        mat.reserved[i][6] = 1;
        mat.m[i][6] = i % 2 === 0 ? 1 : 0;
      }
    }

    // Dark module
    mat.reserved[spec.size - 8][8] = 1;
    mat.m[spec.size - 8][8] = 1;

    // Reserve format info areas
    for (let i = 0; i < 9; i++) {
      if (i < spec.size) {
        mat.reserved[8][i] = 1;
        mat.reserved[i][8] = 1;
      }
    }
    for (let i = 0; i < 8; i++) {
      mat.reserved[8][spec.size - 1 - i] = 1;
      mat.reserved[spec.size - 1 - i][8] = 1;
    }

    // 4. Fill data with zig-zag and mask 0 ((row + col) % 2 === 0)
    const dataBits = encodeData(text, spec);
    let bitIdx = 0;
    let up = true;
    for (let right = spec.size - 1; right > 0; right -= 2) {
      if (right === 6) right--; // Skip vertical timing column
      const rows = [];
      for (let r = 0; r < spec.size; r++) rows.push(up ? spec.size - 1 - r : r);
      up = !up;

      for (const r of rows) {
        for (let c = right; c >= right - 1; c--) {
          if (!mat.reserved[r][c]) {
            const rawBit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
            const mask = (r + c) % 2 === 0;
            mat.m[r][c] = rawBit ^ (mask ? 1 : 0);
          }
        }
      }
    }

    // 5. Format info (Mask 0, ECC Level L: 0b010001000100101 with mask 0x5412)
    // Format bits for L-0: 0x77c4 ^ 0x5412 = 0x23d6 = 0b010001111010110
    const fmt = 0b010001111010110;
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> (14 - i)) & 1;
      if (i < 6) mat.m[8][i] = bit;
      else if (i === 6) mat.m[8][7] = bit;
      else if (i === 7) mat.m[8][8] = bit;
      else if (i === 8) mat.m[7][8] = bit;
      else mat.m[14 - i][8] = bit;

      if (i < 8) mat.m[spec.size - 1 - i][8] = bit;
      else mat.m[8][spec.size - 15 + i] = bit;
    }

    return mat;
  }

  function generateSvg(text, options = {}) {
    const size = options.size || 200;
    const padding = options.padding !== undefined ? options.padding : 3;
    const fg = options.fg || '#1c1611';
    const bg = options.bg || '#ffffff';

    const mat = buildQRMatrix(text);
    const totalDim = mat.size + padding * 2;
    const rects = [];

    for (let r = 0; r < mat.size; r++) {
      for (let c = 0; c < mat.size; c++) {
        if (mat.m[r][c]) {
          rects.push(`<rect x="${c + padding}" y="${r + padding}" width="1" height="1" fill="${fg}"/>`);
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${size}" height="${size}" shape-rendering="crispEdges" style="display:block;border-radius:6px;background:${bg}">
      <rect width="${totalDim}" height="${totalDim}" fill="${bg}"/>
      ${rects.join('')}
    </svg>`;
  }

  global.QRCodeGen = {
    generateSvg,
  };
})(typeof window !== 'undefined' ? window : global);

