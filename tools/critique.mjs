#!/usr/bin/env node
/**
 * The critic harness.
 *
 * Captures a fixed, reproducible set of frames covering every scale and every
 * hero subject in the build, so a reviewer — human or agent — is always
 * looking at the same shots and can say whether the render got better or
 * worse between two runs. Nothing in this project gets called good-looking
 * without a frame on disk, and nothing gets called *improved* without the
 * previous frame next to it.
 *
 * The shot list is deliberately unflattering. Each entry targets a situation
 * that is known to expose a specific class of failure:
 *
 *   cosmos-wide     structure legibility, void blackness, banding in near-black
 *   cosmos-close    per-tracer speckle — does the medium survive being close?
 *   system-wide     scale believability, star bloom behaviour
 *   planet-lit      surface detail, terminator softness, albedo plausibility
 *   planet-crescent atmospheric limb, night side, aurora, star occlusion
 *   rings           optical depth inversion, umbra shape, gap structure
 *   gasgiant        band structure, storm vortices, pole treatment
 *
 * Usage:
 *   node tools/critique.mjs                     # full set at review resolution
 *   node tools/critique.mjs --out shots/round2  # keep rounds side by side
 *   node tools/critique.mjs --only rings,planet-lit
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const OUT = resolve(arg('out', 'shots/critique'));
const W = arg('w', '1440');
const H = arg('h', '810');
// SwiftShader is the only rasteriser available here, so the budgets below are
// what actually completes rather than what the app is capable of on a GPU.
const Q = arg('q', 'tier=2&still=1&particles=900000&stars=30000&dpr=1&scale=1');
const only = (arg('only', '') || '').split(',').filter(Boolean);

mkdirSync(OUT, { recursive: true });

const enc = (s) => encodeURIComponent(s);

/** Each shot is a name plus a script that drives the app into position. */
const SHOTS = [
  ['cosmos-wide', 8, `
    const r = ctx.director.current;
    r.orbit.radius = 26; r._radiusTarget = 26; r.orbit.phi = 1.05; r.orbit.theta = 0.6;
  `],
  ['cosmos-close', 8, `
    const r = ctx.director.current;
    r.orbit.radius = 8; r._radiusTarget = 8; r.orbit.phi = 1.2;
  `],
  ['system-wide', 8, `
    await ctx.director.goTo('system', { seed: 4242 }, 'fade', 0.05);
  `],
  ['planet-lit', 9, `
    await ctx.director.goTo('system', { seed: 911 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    let best = 0, bs = -1;
    r.planets.forEach((p, i) => {
      const s = (p.record.hasLife ? 3 : 0) + p.record.atmosphere + p.record.oceanCoverage * 2;
      if (s > bs) { bs = s; best = i; }
    });
    r.focus(best);
  `],
  ['planet-crescent', 9, `
    await ctx.director.goTo('system', { seed: 70117 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    let best = 0, bs = -1;
    r.planets.forEach((p, i) => { if (p.record.atmosphere > bs) { bs = p.record.atmosphere; best = i; } });
    r.focus(best);
    // Swing round to the night side to test limb glow and star occlusion.
    const p = r.planets[best];
    const out = p.truePos.clone().normalize();
    r.followOffset.copy(out).multiplyScalar(p.record.radius * 3.0);
    r.followOffset.y += p.record.radius * 0.5;
  `],
  ['rings', 9, `
    await ctx.director.goTo('system', { seed: 1 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    const i = r.planets.findIndex(p => p.record.hasRings);
    r.focus(i >= 0 ? i : 0);
  `],
  ['gasgiant', 9, `
    await ctx.director.goTo('system', { seed: 1 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    const i = r.planets.findIndex(p => p.record.isGiant);
    if (i >= 0) {
      r.focus(i);
      const p = r.planets[i];
      // Close in until the body fills the frame; band structure only reads
      // when the planet is large enough to resolve it.
      r.followOffset.multiplyScalar(0.55);
    }
  `],
];

const selected = only.length ? SHOTS.filter((s) => only.includes(s[0])) : SHOTS;

const shotArgs = [];
for (const [name, secs, script] of selected) {
  shotArgs.push('--shot', `${name}:${secs}:${enc(script.trim())}`);
}

if (!existsSync(resolve('dist'))) {
  console.error('[critique] dist/ missing — run `npm run build` first.');
  process.exit(2);
}

console.log(`[critique] capturing ${selected.length} shots -> ${OUT}`);
const child = spawn(
  'node',
  ['tools/screenshot.mjs', '--out', OUT, '--w', W, '--h', H, '--settle', '6',
   '--timeout', '300000', '--q', Q, ...shotArgs],
  { stdio: 'inherit' }
);
child.on('exit', (code) => {
  console.log(`\n[critique] done. Review every frame in ${OUT} against the`);
  console.log('[critique] rubric in docs/CRITIQUE.md before claiming any of it looks good.');
  process.exit(code ?? 0);
});
