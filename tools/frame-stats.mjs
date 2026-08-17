#!/usr/bin/env node
/**
 * Measure a captured frame.
 *
 * Verdicts in this project quote numbers — "the 99.5th percentile sits at
 * 45/255", "the median is near 11" — and until now nothing computed them, so
 * they were re-derived by eye each round and could not be compared across
 * rounds. This does the arithmetic.
 *
 * It reports two things the rubric keeps asking about and one it has been
 * burned by:
 *
 *   - the luminance distribution, so "voids stay near black" and "filaments sit
 *     above the bloom threshold" become checkable rather than assertable;
 *   - the bleached fraction: pixels that are both bright and desaturated. AgX
 *     rolls a bright saturated colour toward white, so a layer pushed too hard
 *     loses its hue entirely. Round 11 found the cluster sprites doing exactly
 *     this while every percentile still looked reasonable — the distribution
 *     alone cannot see it, because a white pixel and a gold one of the same
 *     luminance are the same number.
 *
 * Note the standing warning in docs/CRITIQUE.md: a metric is not a criterion.
 * A frame taken from inside a translucent medium legitimately has a low peak,
 * and raising exposure to fix the number makes the picture worse. These are
 * inputs to a judgement, not the judgement.
 *
 *   node tools/frame-stats.mjs shots/critique/round-11/cosmos-wide.png
 *   node tools/frame-stats.mjs shots/critique/round-11/*.png
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Minimal decoder: 8-bit non-interlaced PNG, which is what Chromium writes. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colour type ${colorType} not supported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row picks its own, and the predictors
  // reference the row above, so this has to run in order.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? dst[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      let v = src[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      dst[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/frame-stats.mjs <frame.png> [...]');
  process.exit(2);
}

// Bright enough to be structure rather than background, and desaturated enough
// that whatever hue the layer was supposed to carry has been lost.
const BLEACH_LUMA = 200;
const BLEACH_SAT = 0.12;

for (const file of files) {
  let img;
  try {
    img = decodePng(readFileSync(file));
  } catch (e) {
    console.error(`${file}: ${e.message}`);
    continue;
  }
  const { width, height, channels, data } = img;
  const n = width * height;
  const luma = new Uint8Array(n);
  let bleached = 0, nearBlack = 0;
  let sumSat = 0;

  for (let i = 0; i < n; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
    // Rec.709 luma, on the sRGB values as displayed — this is about what the
    // frame looks like, not about scene-referred radiance.
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    luma[i] = y;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    sumSat += sat;
    if (y >= BLEACH_LUMA && sat < BLEACH_SAT) bleached++;
    if (y <= 4) nearBlack++;
  }

  const sorted = Uint8Array.from(luma).sort();
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(n * p / 100))];

  console.log(`\n${file}  ${width}x${height}`);
  console.log(`  luma   median ${pct(50)}   p90 ${pct(90)}   p99 ${pct(99)}`
    + `   p99.5 ${pct(99.5)}   p99.9 ${pct(99.9)}   max ${sorted[n - 1]}`);
  console.log(`  void   ${(nearBlack / n * 100).toFixed(1)}% of pixels at or below 4/255`);
  console.log(`  colour mean saturation ${(sumSat / n).toFixed(3)}`);
  console.log(`  bleach ${(bleached / n * 100).toFixed(3)}% of pixels above ${BLEACH_LUMA}/255`
    + ` with saturation below ${BLEACH_SAT}`
    + `${bleached / n > 0.001 ? '   <-- a layer is losing its hue' : ''}`);
}
