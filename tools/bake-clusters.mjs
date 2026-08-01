#!/usr/bin/env node
/**
 * Find the cosmic web's collapsed nodes, offline.
 *
 * Round 10 established what this has to be and why the obvious alternative
 * cannot work. Nodes read as differently-tinted filament rather than as
 * clusters, and the tempting fix — a density-gated multiplier on per-tracer
 * brightness in the fragment shader — was tried at two settings and brought
 * back per-tracer speckle both times. The reason rules out the whole approach:
 * the density available in the shader is the Zel'dovich Jacobian, which every
 * particle carries individually. It says how much that one mass element was
 * compressed, not how many neighbours it has. A lone tracer in an ordinary
 * sheet can hold a high value, so any multiplier keyed to it turns that tracer
 * into a hard dot, and no threshold separates "in a cluster" from "individually
 * dense" because the quantity does not carry the distinction.
 *
 * Counting neighbours needs somewhere neighbours exist. So: displace a mass
 * sampling of the Lagrangian grid, bin it in EULERIAN space, and read the
 * occupancy of each cell. That number is real crowding — how much mass landed
 * in one place — and it is exactly what the GPU cannot compute per-vertex.
 * Peaks in it are clusters, and clusters get drawn as objects.
 *
 * Why offline: one pass is ~900k displacement evaluations, each seven taps of a
 * three-octave warped potential — about twelve seconds. That is fine for a bake
 * and impossible on a loading screen. The field is deterministic, so the answer
 * is a constant of the build.
 *
 * What gets stored is the LAGRANGIAN centroid of each cluster, not its Eulerian
 * position. The growth factor keeps evolving at runtime, so a fixed Eulerian
 * point would drift off its node; a Lagrangian one gets re-displaced by the
 * live field in the vertex shader and stays locked to the web, the same way the
 * galaxy sprites already do it. This is only sound because a collapse centre
 * sits at a stationary point of the displacement — phi is extremal there, so
 * psi = -grad(phi) is near zero and the centroid barely moves. That is an
 * argument, so the tool measures it and prints the residual rather than
 * asserting it.
 *
 *   node tools/bake-clusters.mjs
 *   node tools/bake-clusters.mjs --side 128 --percentile 99.95
 */

import { writeFileSync } from 'node:fs';
import { zeldovich, fieldScratch } from '../src/cosmos/ZeldovichField.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? parseFloat(args[i + 1]) : d;
};

// These must match what CosmosRealm builds. The generated file records them and
// CosmicWeb refuses the data if they do not match at runtime, so a change here
// that is not re-baked fails loudly instead of drawing clusters in voids.
const BOX = arg('box', 36);
const FIELD_SCALE = 6 / BOX;
const PSI_AMP = 0.006 * BOX;

// The epoch to detect at. CosmicWeb runs uGrowth = D(t) * 3.4 with t starting
// at 0.72 and creeping at 0.010/s, which puts the captured frames between 2.17
// and 2.25 — the Lambda plateau, where structure formation has frozen out and
// cluster membership is no longer changing. Detection happens once at 2.2; the
// live shader still re-displaces every centroid at the actual current growth.
const GROWTH_REF = arg('growth', 2.2);

const SIDE = arg('side', 96);
// Eulerian cell size. Nodes in this field sit ~6 units apart (the potential
// carries ~6 structures across the box), and their cores are 1-2 units across,
// so 0.75 resolves a core into a handful of cells without slicing it so finely
// that shot noise invents maxima.
const CELL = arg('cell', 0.75);
const PERCENTILE = arg('percentile', 99.9);
// Two maxima closer than this are the same object seen twice.
const MERGE_DIST = arg('merge', 2.2);
const OUT = 'src/cosmos/clusters.generated.js';

// --- sample the displaced mass distribution ---------------------------------

const GRID = Math.ceil(BOX / CELL);
const counts = new Int32Array(GRID * GRID * GRID);
// Lagrangian centroid accumulators, so a peak cell can say which part of the
// initial grid collapsed into it.
const sumQx = new Float64Array(GRID * GRID * GRID);
const sumQy = new Float64Array(GRID * GRID * GRID);
const sumQz = new Float64Array(GRID * GRID * GRID);

const scratch = fieldScratch();
const step = BOX / SIDE;
// Stratified jitter, same reasoning as the tracer grid: a perfect lattice beats
// against the Eulerian bins and manufactures periodic maxima.
let rs = 987654321;
const rnd = () => {
  rs = (rs * 1664525 + 1013904223) >>> 0;
  return rs / 4294967296;
};

const cellOf = (v) => {
  const c = Math.floor((v / BOX + 0.5) * GRID);
  return c < 0 || c >= GRID ? -1 : c;
};

console.log(`[bake] sampling ${SIDE}^3 = ${(SIDE ** 3 / 1e6).toFixed(2)}M mass elements`
  + ` at growth ${GROWTH_REF}...`);
const t0 = Date.now();
let placed = 0;

for (let iz = 0; iz < SIDE; iz++) {
  for (let iy = 0; iy < SIDE; iy++) {
    for (let ix = 0; ix < SIDE; ix++) {
      const qx = (ix + 0.5 + (rnd() - 0.5) * 0.9) * step - BOX * 0.5;
      const qy = (iy + 0.5 + (rnd() - 0.5) * 0.9) * step - BOX * 0.5;
      const qz = (iz + 0.5 + (rnd() - 0.5) * 0.9) * step - BOX * 0.5;

      // Only the sphere the renderer actually shows. The tracers fade out over
      // 0.80..1.0 of the box half-width, so a "cluster" found in the corner of
      // the cube is one nothing will ever draw.
      if (Math.hypot(qx, qy, qz) > BOX * 0.5) continue;

      zeldovich(qx, qy, qz, FIELD_SCALE, PSI_AMP, scratch);
      // The runtime also adds a curl-noise drift, amplitude 0.06 against a
      // 36-unit box and a 6-unit structure spacing. It is a slow breathing
      // motion, not a displacement that decides membership, and it is omitted
      // here so the bake is time-independent.
      const x = qx + GROWTH_REF * scratch.psiX;
      const y = qy + GROWTH_REF * scratch.psiY;
      const z = qz + GROWTH_REF * scratch.psiZ;

      const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
      if (cx < 0 || cy < 0 || cz < 0) continue;
      const idx = (cz * GRID + cy) * GRID + cx;
      counts[idx]++;
      sumQx[idx] += qx; sumQy[idx] += qy; sumQz[idx] += qz;
      placed++;
    }
  }
}
console.log(`[bake] ${placed} elements binned into ${GRID}^3 cells`
  + ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// --- pick the threshold from the data ---------------------------------------

const occupied = [];
for (let i = 0; i < counts.length; i++) if (counts[i] > 0) occupied.push(counts[i]);
occupied.sort((a, b) => a - b);
const pct = (p) => occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * p / 100))];
const median = pct(50);
const threshold = pct(PERCENTILE);

console.log(`[bake] occupied cells ${occupied.length}`
  + `  median ${median}  p99 ${pct(99)}  p${PERCENTILE} ${threshold}  max ${occupied[occupied.length - 1]}`);
console.log(`[bake] contrast peak/median = ${(occupied[occupied.length - 1] / median).toFixed(1)}x`);

// --- local maxima ------------------------------------------------------------

const peaks = [];
const at = (x, y, z) => counts[(z * GRID + y) * GRID + x];
for (let z = 1; z < GRID - 1; z++) {
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const c = at(x, y, z);
      if (c < threshold) continue;
      let isMax = true;
      for (let dz = -1; dz <= 1 && isMax; dz++) {
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy && !dz) continue;
            // Strictly greater on one side of the tie keeps a flat-topped peak
            // from registering as several adjacent maxima.
            if (at(x + dx, y + dy, z + dz) > c) { isMax = false; break; }
          }
        }
      }
      if (isMax) peaks.push({ x, y, z, count: c });
    }
  }
}
peaks.sort((a, b) => b.count - a.count);
console.log(`[bake] ${peaks.length} local maxima above the threshold`);

// --- merge, and gather each cluster's members --------------------------------

const cellCentre = (c) => (c + 0.5) / GRID * BOX - BOX * 0.5;
const clusters = [];

for (const p of peaks) {
  const ex = cellCentre(p.x), ey = cellCentre(p.y), ez = cellCentre(p.z);
  const dup = clusters.find((c) => Math.hypot(c.ex - ex, c.ey - ey, c.ez - ez) < MERGE_DIST);
  if (dup) { dup.absorbed++; continue; }

  // Collect the neighbourhood that belongs to this peak: cells within the merge
  // radius holding at least a fifth of the peak's occupancy. The fraction sets
  // where the cluster stops and the filament feeding it begins.
  const R = Math.ceil(MERGE_DIST / CELL);
  let n = 0, qx = 0, qy = 0, qz = 0, wex = 0, wey = 0, wez = 0;
  const members = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const X = p.x + dx, Y = p.y + dy, Z = p.z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= GRID || Y >= GRID || Z >= GRID) continue;
        const idx = (Z * GRID + Y) * GRID + X;
        const c = counts[idx];
        if (c < p.count * 0.2) continue;
        const cx = cellCentre(X), cy = cellCentre(Y), cz = cellCentre(Z);
        if (Math.hypot(cx - ex, cy - ey, cz - ez) > MERGE_DIST) continue;
        n += c;
        qx += sumQx[idx]; qy += sumQy[idx]; qz += sumQz[idx];
        wex += cx * c; wey += cy * c; wez += cz * c;
        members.push({ cx, cy, cz, c });
      }
    }
  }
  if (!n) continue;

  // Mass-weighted Eulerian centre, and the RMS spread of the members about it —
  // a real core radius rather than a chosen sprite size.
  const mex = wex / n, mey = wey / n, mez = wez / n;
  let varSum = 0;
  for (const m of members) {
    varSum += m.c * ((m.cx - mex) ** 2 + (m.cy - mey) ** 2 + (m.cz - mez) ** 2);
  }
  const radius = Math.sqrt(varSum / n / 3);

  clusters.push({
    qx: qx / n, qy: qy / n, qz: qz / n,
    ex: mex, ey: mey, ez: mez,
    richness: n, peak: p.count, radius, absorbed: 0,
  });
}

console.log(`[bake] ${clusters.length} clusters after merging within ${MERGE_DIST} units`);

// --- solve for each cluster's Lagrangian pre-image ---------------------------
//
// The first version of this stored the Lagrangian centroid of the members and
// relied on psi being near zero there, on the grounds that a collapse centre is
// an extremum of the potential. Measured, that was wrong by 0.46 units on
// average and 1.18 at worst, against a mean core radius of 0.67 — sprites would
// have sat visibly off their nodes. The argument ignored that a collapsing
// region also moves bodily toward the node, so its pre-image centroid carries
// the bulk flow as well as the convergence.
//
// What is actually wanted is a q whose displaced position IS the cluster
// centre, so solve x(q) = q + D*psi(q) = target for q directly. Damped fixed
// point from the target itself: q <- q + w*(target - x(q)). The undamped
// iteration is marginally stable here by construction — a caustic is exactly
// where d(x)/d(q) passes through zero — so w = 0.6 rather than 1.
//
// Shell crossing means several q map to the same x at a node. That is fine:
// any one of them is a valid anchor, and this finds the one nearest the centre.

const SOLVE_TOL = 0.02;
let converged = 0, worstResid = 0, sumResid = 0;

for (const c of clusters) {
  let qx = c.ex, qy = c.ey, qz = c.ez;
  let r = Infinity;
  for (let it = 0; it < 64; it++) {
    zeldovich(qx, qy, qz, FIELD_SCALE, PSI_AMP, scratch);
    const dx = c.ex - (qx + GROWTH_REF * scratch.psiX);
    const dy = c.ey - (qy + GROWTH_REF * scratch.psiY);
    const dz = c.ez - (qz + GROWTH_REF * scratch.psiZ);
    r = Math.hypot(dx, dy, dz);
    if (r < SOLVE_TOL) break;
    qx += 0.6 * dx; qy += 0.6 * dy; qz += 0.6 * dz;
  }
  // Keep the solved anchor in place of the member centroid.
  c.qx = qx; c.qy = qy; c.qz = qz;
  c.resid = r;
  if (r < SOLVE_TOL) converged++;
  sumResid += r;
  if (r > worstResid) worstResid = r;
}

console.log(`[bake] Lagrangian anchors solved: ${converged}/${clusters.length} to within ${SOLVE_TOL} units`);
console.log(`[bake] residual over all candidates: mean ${(sumResid / Math.max(1, clusters.length)).toFixed(3)}`
  + `  worst ${worstResid.toFixed(3)} units`);

// Drop what did not converge. The iteration fails where the map from Lagrangian
// to Eulerian space is degenerate enough that no nearby q lands on the target,
// and an anchor with a residual of a whole unit draws a bright object a core
// radius off its node — worse than not drawing it, because it puts a cluster
// where the tracers say there is none. Two lost out of fifty-one is not a
// population worth compromising placement for.
const rejected = clusters.filter((c) => c.resid >= SOLVE_TOL);
const kept = clusters.filter((c) => c.resid < SOLVE_TOL);
if (rejected.length) {
  console.log(`[bake] dropped ${rejected.length} cluster(s) whose anchor would not converge:`);
  for (const c of rejected) {
    console.log(`         n=${c.richness} at (${c.ex.toFixed(1)}, ${c.ey.toFixed(1)},`
      + ` ${c.ez.toFixed(1)}) resid=${c.resid.toFixed(2)}`);
  }
}
clusters.length = 0;
clusters.push(...kept);

const meanRadius = clusters.reduce((s, c) => s + c.radius, 0) / Math.max(1, clusters.length);
const keptWorst = clusters.reduce((m, c) => Math.max(m, c.resid), 0);
console.log(`[bake] ${clusters.length} clusters kept, worst placement error ${keptWorst.toFixed(3)} units`
  + ` against a mean core radius of ${meanRadius.toFixed(3)}`);

// Richness is normalised so the shader gets a 0..1 weight and does not have to
// know how many mass elements this particular bake happened to sample.
const maxRich = clusters.reduce((m, c) => Math.max(m, c.richness), 1);

const rows = clusters.map((c) => `  [${c.qx.toFixed(4)}, ${c.qy.toFixed(4)}, ${c.qz.toFixed(4)},`
  + ` ${(c.richness / maxRich).toFixed(4)}, ${c.radius.toFixed(4)}],`).join('\n');

const src = `/**
 * Collapsed nodes of the cosmic web. GENERATED — do not edit.
 *
 *   node tools/bake-clusters.mjs
 *
 * Produced by binning ${(placed / 1e6).toFixed(2)}M displaced mass elements into ${GRID}^3 Eulerian
 * cells and taking local maxima of the occupancy. See tools/bake-clusters.mjs
 * for why this cannot be done in the shader.
 *
 * Each row is [qx, qy, qz, richness, radius]:
 *   qx,qy,qz  Lagrangian centroid — the vertex shader re-displaces this by the
 *             live growth factor, so the sprite tracks the node as the web
 *             evolves instead of being pinned to a stale Eulerian point.
 *   richness  member count, normalised to the richest cluster in the volume.
 *   radius    RMS spread of the members, in the same units as the box.
 *
 * Detection ran at growth ${GROWTH_REF}; the centroid re-displacement residual was
 * ${worstResid.toFixed(3)} units at worst against a mean core radius of ${meanRadius.toFixed(3)}.
 */

/** The configuration this was baked for. CosmicWeb checks it before using the data. */
export const CLUSTER_BAKE = {
  boxSize: ${BOX},
  fieldScale: ${FIELD_SCALE},
  psiAmp: ${PSI_AMP},
  growthRef: ${GROWTH_REF},
};

export const CLUSTERS = [
${rows}
];
`;

writeFileSync(OUT, src);
console.log(`[bake] wrote ${OUT} (${clusters.length} clusters, richest ${maxRich} members)`);

const top = clusters.slice(0, 8).map((c) => `    r=${c.radius.toFixed(2)} n=${c.richness}`
  + ` at (${c.ex.toFixed(1)}, ${c.ey.toFixed(1)}, ${c.ez.toFixed(1)}) resid=${c.resid.toFixed(2)}`);
console.log('[bake] richest:\n' + top.join('\n'));
