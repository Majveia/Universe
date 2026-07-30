#!/usr/bin/env node
/**
 * Offline probe for the Zel'dovich displacement field.
 *
 * Rendering a million points through SwiftShader to find out whether the
 * amplitude is right takes minutes. Doing the same arithmetic in Node and
 * projecting it to a column-density image takes under a second, and it answers
 * the only question that matters: does this field actually collapse into
 * sheets and filaments, and at what amplitude?
 *
 * The JS simplex here is not bit-identical to the GLSL one, but both are unit-
 * scale simplex noise, so the structural conclusions transfer.
 *
 *   node tools/probe-web.mjs --amp 0.013 --growth 2.0 --field 6
 */

import { Noise } from '../src/core/Noise.js';
import { Rng } from '../src/core/Rng.js';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? parseFloat(args[i + 1]) : d;
};

const BOX = arg('box', 36);
const FIELD = arg('field', 6) / BOX;
const AMP = arg('amp', 0.013) * BOX;
const GROWTH = arg('growth', 2.0);
const SIDE = arg('side', 150);
const RES = arg('res', 640);

const n = new Noise(20260728);

// Mirror of the shader's `potential()`.
function potential(x, y, z) {
  const wx = n.noise3(x * 0.55 + 11.3, y * 0.55 + 11.3, z * 0.55 + 11.3);
  const wy = n.noise3(x * 0.55 + 27.1, y * 0.55 + 27.1, z * 0.55 + 27.1);
  const wz = n.noise3(x * 0.55 + 41.7, y * 0.55 + 41.7, z * 0.55 + 41.7);
  const px = x + wx * 0.45, py = y + wy * 0.45, pz = z + wz * 0.45;
  return n.noise3(px, py, pz) * 1.0
       + n.noise3(px * 2.03 + 5.1, py * 2.03 + 5.1, pz * 2.03 + 5.1) * 0.28
       + n.noise3(px * 4.11 + 9.7, py * 4.11 + 9.7, pz * 4.11 + 9.7) * 0.075;
}

const E = 0.16;
function zeldovich(qx, qy, qz) {
  const px = qx * FIELD, py = qy * FIELD, pz = qz * FIELD;
  const f0 = potential(px, py, pz);
  const fx1 = potential(px + E, py, pz), fx0 = potential(px - E, py, pz);
  const fy1 = potential(px, py + E, pz), fy0 = potential(px, py - E, pz);
  const fz1 = potential(px, py, pz + E), fz0 = potential(px, py, pz - E);
  const gx = (fx1 - fx0) / (2 * E);
  const gy = (fy1 - fy0) / (2 * E);
  const gz = (fz1 - fz0) / (2 * E);
  const lap = (fx1 + fx0 + fy1 + fy0 + fz1 + fz0 - 6 * f0) / (E * E);
  return { dx: -gx * AMP, dy: -gy * AMP, dz: -gz * AMP, lap, gmag: Math.hypot(gx, gy, gz) };
}

// Project a slab onto a column-density grid: this is exactly what the additive
// blend does on the GPU, so the image is a faithful preview of the render.
const grid = new Float64Array(RES * RES);
const rng = new Rng(7);
let maxDisp = 0, sumDisp = 0, count = 0;
let lapMin = 1e9, lapMax = -1e9;

const step = BOX / SIDE;
for (let iz = 0; iz < SIDE; iz++) {
  for (let iy = 0; iy < SIDE; iy++) {
    for (let ix = 0; ix < SIDE; ix++) {
      const qx = (ix + 0.5 + rng.range(-0.45, 0.45)) * step - BOX / 2;
      const qy = (iy + 0.5 + rng.range(-0.45, 0.45)) * step - BOX / 2;
      const qz = (iz + 0.5 + rng.range(-0.45, 0.45)) * step - BOX / 2;
      const d = zeldovich(qx, qy, qz);
      const disp = Math.hypot(d.dx, d.dy, d.dz) * GROWTH;
      maxDisp = Math.max(maxDisp, disp);
      sumDisp += disp; count++;
      lapMin = Math.min(lapMin, d.lap); lapMax = Math.max(lapMax, d.lap);

      // Only project a slab so filaments are not washed out by depth.
      if (Math.abs(qz) > BOX * 0.12) continue;
      const x = qx + GROWTH * d.dx;
      const y = qy + GROWTH * d.dy;
      const u = Math.floor(((x / BOX) + 0.5) * RES);
      const v = Math.floor(((y / BOX) + 0.5) * RES);
      if (u >= 0 && u < RES && v >= 0 && v < RES) grid[v * RES + u] += 1;
    }
  }
}

let gmax = 0, nonzero = 0;
for (const g of grid) { if (g > gmax) gmax = g; if (g > 0) nonzero++; }

// Contrast metric: the ratio of the 99.5th percentile to the median of the
// occupied cells. A uniform cloud sits near 1.5; real filamentary structure is
// several times that. This is the number to optimise.
const occ = Array.from(grid).filter((g) => g > 0).sort((a, b) => a - b);
const median = occ[Math.floor(occ.length * 0.5)] || 1;
const p995 = occ[Math.floor(occ.length * 0.995)] || 1;
const fillFraction = nonzero / (RES * RES);

console.log(`box=${BOX} field=${(FIELD * BOX).toFixed(1)}/box amp=${(AMP / BOX).toFixed(4)}*box growth=${GROWTH}`);
console.log(`  mean displacement : ${(sumDisp / count).toFixed(3)} units  (grid spacing ${step.toFixed(3)})`);
console.log(`  max  displacement : ${maxDisp.toFixed(3)} units  = ${(maxDisp / step).toFixed(1)} cells`);
console.log(`  laplacian range   : ${lapMin.toFixed(2)} .. ${lapMax.toFixed(2)}`);
console.log(`  column density    : median=${median} p99.5=${p995} max=${gmax}`);
console.log(`  CONTRAST p99.5/med: ${(p995 / median).toFixed(2)}   fill=${(fillFraction * 100).toFixed(1)}%`);

// --- write a PNG so the structure can actually be looked at ------------------
function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[o++] = rgb[i]; raw[o++] = rgb[i + 1]; raw[o++] = rgb[i + 2];
    }
  }
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = Buffer.alloc(RES * RES * 3);
for (let i = 0; i < RES * RES; i++) {
  // Same four-stop ramp as the shader, so the preview reads like the render.
  const t = Math.min(1, Math.pow(grid[i] / (p995 * 1.1), 0.6));
  let r, g, b;
  if (t < 0.35) { const u = t / 0.35; r = 0.10 + u * 0.24; g = 0.13 + u * 0.17; b = 0.32 + u * 0.46; }
  else if (t < 0.7) { const u = (t - 0.35) / 0.35; r = 0.34 + u * 0.02; g = 0.30 + u * 0.42; b = 0.78 + u * 0.22; }
  else { const u = (t - 0.7) / 0.3; r = 0.36 + u * 0.64; g = 0.72 + u * 0.10; b = 1.0 - u * 0.52; }
  const s = Math.pow(t, 0.85);
  rgb[i * 3] = Math.min(255, r * s * 255) | 0;
  rgb[i * 3 + 1] = Math.min(255, g * s * 255) | 0;
  rgb[i * 3 + 2] = Math.min(255, b * s * 255) | 0;
}
writeFileSync('shots/probe-web.png', png(RES, RES, rgb));
console.log('  wrote shots/probe-web.png');
