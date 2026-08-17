#!/usr/bin/env node
/**
 * Cross-check the CPU port of the Zel'dovich field against the GPU.
 *
 * `src/cosmos/ZeldovichField.js` carries the same field twice — once as the
 * GLSL the shaders include, once as JavaScript the cluster finder calls. The
 * whole point of the CPU copy is to say "there is a node at this Lagrangian
 * coordinate" and have the GPU draw a filament crossing at the same place. If
 * the two drift, nothing looks broken: the sprites are still smooth, still
 * warm, still the right size, and they sit in the middle of voids.
 *
 * The previous attempt at a CPU mirror (`tools/probe-web.mjs`) used a different
 * simplex implementation entirely and said so in a comment, which was fine for
 * what it did — sweeping an amplitude and reading a contrast ratio, both
 * statistical. It would have been silently useless here.
 *
 * So: compile the real shader chunk, evaluate it at a few hundred query points
 * spread over the actual simulation volume, read the values back as floats, and
 * compare against the JS. Exits non-zero on divergence.
 *
 *   node tools/verify-field.mjs
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { GLSL_LIB } from '../src/shaders/common.js';
import {
  ZELDOVICH_GLSL, snoise, potential, zeldovich, fieldScratch,
} from '../src/cosmos/ZeldovichField.js';

// The volume and field parameters CosmosRealm actually builds with, so the
// check exercises the range of coordinates the cluster finder will see.
const BOX = 36;
const FIELD_SCALE = 6 / BOX;
const PSI_AMP = 0.006 * BOX;
// Query points travel as a uniform array, so this stays well inside the
// guaranteed MAX_FRAGMENT_UNIFORM_VECTORS of 224 — each vec3 costs a slot.
const N = 128;

// Query points: a deterministic scatter through the box, plus the corners and
// centre, which is where a skew/floor mismatch would show up first.
const pts = [];
let s = 12345;
const rnd = () => {
  s = (s * 1664525 + 1013904223) >>> 0;
  return s / 4294967296;
};
pts.push([0, 0, 0]);
for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
  pts.push([sx * BOX * 0.5, sy * BOX * 0.5, sz * BOX * 0.5]);
}
while (pts.length < N) {
  pts.push([(rnd() - 0.5) * BOX, (rnd() - 0.5) * BOX, (rnd() - 0.5) * BOX]);
}

const FRAG = `#version 300 es
precision highp float;
${GLSL_LIB}
${ZELDOVICH_GLSL}
uniform vec3 uQ[${N}];
out vec4 fragColor;
void main(){
  int k = int(gl_FragCoord.x);
  vec3 q = uQ[k];
  float lap;
  vec3 psi = zeldovich(q, lap);
  // snoise is sampled at the same coordinate the potential's first octave uses,
  // so a mismatch in the base function is visible separately from one in the
  // octave stack or the stencil.
  fragColor = vec4(snoise(q * uFieldScale), potential(q * uFieldScale), lap, psi.x);
}`;

const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const localChrome = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || localChrome || undefined,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox',
  ],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

const gpu = await page.evaluate(
  ({ frag, vert, flat, n, fieldScale, psiAmp }) => {
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = 1;
    const gl = cv.getContext('webgl2', { antialias: false });
    if (!gl) return { error: 'no webgl2' };
    // Float readback is the whole point — a byte target would quantise the
    // comparison to 1/255 and hide exactly the drift we are looking for.
    if (!gl.getExtension('EXT_color_buffer_float')) return { error: 'no EXT_color_buffer_float' };

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        return { error: 'link: ' + gl.getProgramInfoLog(prog) };
      }
    } catch (e) {
      return { error: 'compile: ' + e.message };
    }

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return { error: 'framebuffer incomplete' };
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform3fv(gl.getUniformLocation(prog, 'uQ'), new Float32Array(flat));
    gl.uniform1f(gl.getUniformLocation(prog, 'uFieldScale'), fieldScale);
    gl.uniform1f(gl.getUniformLocation(prog, 'uPsiAmp'), psiAmp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uGrowth'), 1.0);

    gl.viewport(0, 0, n, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const out = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, out);
    return { data: Array.from(out) };
  },
  {
    frag: FRAG, vert: VERT, n: N,
    flat: pts.flat(), fieldScale: FIELD_SCALE, psiAmp: PSI_AMP,
  },
);

await browser.close();

if (gpu.error) {
  console.error(`[verify-field] GPU side failed: ${gpu.error}`);
  process.exit(2);
}

const scratch = fieldScratch();
const names = ['snoise', 'potential', 'lap', 'psi.x'];

// The gate is relative to each channel's own spread, not an absolute epsilon.
//
// An absolute tolerance has to be picked per channel and then quietly widened
// whenever it trips, which makes it a record of what the code does rather than
// a check on it. The channels here genuinely differ in scale by five orders —
// snoise lives in [-1,1] while `lap` divides by e^2 = 0.0256 and spans several
// hundred — so one number cannot serve all four, and four hand-tuned numbers
// are four opportunities to hide a real defect.
//
// Relative-to-range needs no tuning and stays honest. float32 rounding lands
// around 1e-5 of a channel's range; the transliteration bug this tool caught on
// its first run produced errors of 30-100% of range. Anything failing at 1e-3
// is a logic divergence, not precision, with two orders of margin either side.
const REL_TOL = 1e-3;

const cpuAll = [];
for (let k = 0; k < N; k++) {
  const [qx, qy, qz] = pts[k];
  zeldovich(qx, qy, qz, FIELD_SCALE, PSI_AMP, scratch);
  cpuAll.push([
    snoise(qx * FIELD_SCALE, qy * FIELD_SCALE, qz * FIELD_SCALE),
    potential(qx * FIELD_SCALE, qy * FIELD_SCALE, qz * FIELD_SCALE),
    scratch.lap,
    scratch.psiX,
  ]);
}

console.log(`[verify-field] ${N} query points across a ${BOX}-unit box`);
console.log(`  gate: max |GPU-CPU| below ${REL_TOL} of each channel's range\n`);

let fails = 0;
for (let c = 0; c < 4; c++) {
  let lo = Infinity, hi = -Infinity, worst = 0, worstAt = null;
  for (let k = 0; k < N; k++) {
    const g = gpu.data[k * 4 + c];
    if (g < lo) lo = g;
    if (g > hi) hi = g;
    const d = Math.abs(cpuAll[k][c] - g);
    if (d > worst) { worst = d; worstAt = pts[k]; }
  }
  const range = hi - lo;
  const rel = worst / range;
  const ok = rel <= REL_TOL;
  if (!ok) fails++;
  const at = worstAt ? worstAt.map((v) => v.toFixed(2)).join(', ') : '-';
  console.log(`  ${names[c].padEnd(10)} range ${range.toFixed(3).padStart(9)}`
    + `   max |GPU-CPU| = ${worst.toExponential(2)}`
    + `   = ${rel.toExponential(2)} of range   ${ok ? 'ok' : 'FAIL'}   at (${at})`);
}

if (fails) {
  console.error(`\n[verify-field] ${fails} channel(s) diverged beyond float32 rounding.`);
  console.error('The CPU port and the shader disagree — cluster positions from');
  console.error('the bake cannot be trusted until this passes.');
  process.exit(1);
}
console.log('\n[verify-field] CPU port matches the shader.');
