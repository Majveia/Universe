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

import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Seeds are chosen, not arbitrary. A shot can only test what its subject
 * actually exercises: "albedo plausible for the stated type" says nothing when
 * the framed world is an EXOTIC one whose palette is deliberately alien, and
 * band structure cannot be judged through a ring plane crossing the disc. Every
 * seed below was picked by sweeping the catalogue offline (see the note on each)
 * for a subject that puts the rubric criterion in frame, under a sun-like star
 * so exposure is not fighting a red dwarf.
 */
const TERRESTRIAL = "['temperate','jungle','ocean','desert']";

/** Each shot is a name plus a script that drives the app into position. */
const SHOTS = [
  ['cosmos-wide', 8, `
    const r = ctx.director.current;
    r.orbit.radius = 16; r._radiusTarget = 16; r.orbit.phi = 1.05; r.orbit.theta = 0.6;
  `],
  ['cosmos-close', 8, `
    const r = ctx.director.current;
    r.orbit.radius = 8; r._radiusTarget = 8; r.orbit.phi = 1.2;
  `],
  // G0V, ten planets: enough orbit furniture to read as a system rather than a
  // star with a couple of specks.
  ['system-wide', 8, `
    await ctx.director.goTo('system', { seed: 20 }, 'fade', 0.05);
  `],
  // G1V with a living temperate world at 57% ocean. Balance is the point: an
  // all-ocean world is a blue ball and says nothing about surface detail.
  ['planet-lit', 9, `
    await ctx.director.goTo('system', { seed: 558 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    const TERRA = ${TERRESTRIAL};
    let best = -1, bs = -1;
    r.planets.forEach((p, i) => {
      const rec = p.record;
      if (rec.isGiant || !TERRA.includes(rec.type)) return;
      const bal = 1 - Math.min(1, Math.abs(rec.oceanCoverage - 0.55) * 2);
      const s = (rec.hasLife ? 3 : 0) + rec.atmosphere + bal * 2;
      if (s > bs) { bs = s; best = i; }
    });
    r.focus(best >= 0 ? best : 0);
  `],
  // G8V with a jungle world carrying 1.44 atmospheres — a thick limb to grade.
  ['planet-crescent', 9, `
    await ctx.director.goTo('system', { seed: 17 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    let best = -1, bs = -1;
    r.planets.forEach((p, i) => {
      if (p.record.isGiant) return;
      if (p.record.atmosphere > bs) { bs = p.record.atmosphere; best = i; }
    });
    // The realm owns the framing so position and aim stay derived together.
    r.focus(best >= 0 ? best : 0, 'crescent');
  `],
  // G5V with a ringed gas giant whose axis is tilted ~54 degrees, putting the
  // star about 47 degrees above the ring plane. That elevation is the whole
  // shot: single-scattering reflectance carries a mu0/(mu+mu0) factor, so a ring
  // lit edge-on is *correctly* almost black — Saturn at equinox all but
  // disappears. Seeds were swept live for the largest sun elevation rather than
  // for the largest axial tilt, because orbital phase decides the rest.
  ['rings', 9, `
    await ctx.director.goTo('system', { seed: 479 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    const i = r.planets.findIndex(p => p.record.hasRings && p.record.isGiant);
    r.focus(i >= 0 ? i : 0);
  `],
  // G3V with a RINGLESS gas giant, so nothing crosses the bands. Deliberately a
  // different system from the rings shot: reusing one body made the two frames
  // the same picture at two zooms and cost a whole rubric line.
  ['gasgiant', 9, `
    await ctx.director.goTo('system', { seed: 22 }, 'fade', 0.05);
    await new Promise(r => setTimeout(r, 700));
    const r = ctx.director.current;
    let i = r.planets.findIndex(p => p.record.type === 'gasgiant' && !p.record.hasRings);
    if (i < 0) i = r.planets.findIndex(p => p.record.isGiant);
    if (i >= 0) {
      r.focus(i);
      // Close in until the body fills the frame; band structure only reads
      // when the planet is large enough to resolve it.
      r.followOffset.multiplyScalar(0.55);
      r.aimAtFollowTarget();
    }
  `],
];

const selected = only.length ? SHOTS.filter((s) => only.includes(s[0])) : SHOTS;

const shotArgs = [];
for (const [name, secs, script] of selected) {
  shotArgs.push('--shot', `${name}:${secs}:${enc(script.trim())}`);
}

// Build before capturing, unless told not to.
//
// Leaving this to the caller means a failed build is invisible: dist/ still
// exists from last time, the capture runs happily against it, and the round
// produces frames that do not correspond to the source they are supposed to be
// judging. A critic that silently reviews stale output is worse than no critic,
// so the build is part of the run and a failure stops it.
if (!args.includes('--no-build')) {
  console.log('[critique] building...');
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('\n[critique] build FAILED — refusing to capture against a stale dist/.');
    process.exit(2);
  }
}

if (!existsSync(resolve('dist'))) {
  console.error('[critique] dist/ missing and --no-build was given.');
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
