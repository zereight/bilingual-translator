// Generates src/icons/icon-{16,32,48,128}.png (no dependencies).
// Design: rounded gradient square with two "original" lines (solid) and two "translated" lines (dimmer).
// Usage: node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/icons');

// ---- PNG encoding ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing (coordinates are 0..1) ----------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const BARS = [
  { x0: 0.2, x1: 0.8, y0: 0.2, y1: 0.31, alpha: 1 },
  { x0: 0.2, x1: 0.6, y0: 0.36, y1: 0.47, alpha: 1 },
  { x0: 0.2, x1: 0.8, y0: 0.57, y1: 0.68, alpha: 0.6 },
  { x0: 0.2, x1: 0.55, y0: 0.73, y1: 0.84, alpha: 0.6 },
];

function render(size) {
  const SS = 4; // supersampling per axis
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!insideRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) continue;
          const t = (x + y) / 2;
          let cr = lerp(0x4f, 0x06, t);
          let cg = lerp(0x46, 0xb6, t);
          let cb = lerp(0xe5, 0xd4, t);
          for (const bar of BARS) {
            if (insideRoundedRect(x, y, bar.x0, bar.y0, bar.x1, bar.y1, 0.04)) {
              cr = lerp(cr, 255, bar.alpha);
              cg = lerp(cg, 255, bar.alpha);
              cb = lerp(cb, 255, bar.alpha);
            }
          }
          r += cr; g += cg; b += cb; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(outDir, `icon-${size}.png`), encodePng(size, render(size)));
  console.log(`wrote icon-${size}.png`);
}
