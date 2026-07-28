/**
 * Terrain chunk generation, off the frame.
 *
 * A single leaf of the quadtree costs something like a quarter of a million
 * noise evaluations. At sixty frames a second that is four whole frames of
 * budget for one chunk, and a walk downhill asks for several a second. So the
 * work happens in a pool of module workers, and the main thread only ever
 * uploads finished buffers.
 *
 * The important property of this file is not that it is fast — it is that it is
 * *the same code*. The worker rebuilds the TerrainField from a serialised
 * record and calls the identical `elevation()` the character motor calls
 * through `sampleHeight`. There is no second, cheaper approximation of the
 * ground. A mesh that disagrees with the collision surface by even a few
 * centimetres reads instantly as sinking or hovering, and no amount of art
 * covers it.
 *
 * Both entry points live here on purpose: `createContext`/`buildNode` are plain
 * exports, so when a browser refuses to give us a module worker (or the build is
 * running from file://) QuadSphere imports this module directly and generates on
 * the main thread against exactly the same code path, time-sliced.
 */

import {
  TerrainField, LocalFrame, buildErosionGrid, initNeighbours, clamp, saturate,
} from './TerrainGen.js';
import { biomeProfile } from './Biomes.js';

/** Rebuild the world from the structured-cloned record the realm sent us. */
export function createContext(payload) {
  const field = TerrainField.deserialize(payload.field);
  const profile = biomeProfile(payload.field.planet);
  field.profile = profile;
  return {
    field,
    profile,
    season: payload.season || 0,
    radius: field.radius,
    pole: payload.field.pole,
  };
}

/**
 * Run the erosion simulation.
 *
 * This is the one piece of world-building that cannot be deferred or streamed:
 * the hydraulic pass has to see the whole catchment before it knows where a
 * river goes, so it is a single blocking second of arithmetic. A second is four
 * dozen dropped frames if it happens on the main thread, and the player is
 * watching a landing sequence at the time. So it happens here, before any node
 * is asked for, and the finished grid is handed back and then broadcast to
 * every other worker so they all carve the same valleys.
 */
export function buildErosion(payload) {
  const frame = LocalFrame.deserialize(payload.frame);
  const field = new TerrainField(payload.planet, frame, null);
  field.setPole(payload.pole[0], payload.pole[1], payload.pole[2]);
  initNeighbours(payload.n);
  return buildErosionGrid(field, frame, {
    n: payload.n,
    half: payload.half,
    strength: payload.strength,
  });
}

/**
 * A coarse raster of elevation around the landing site, for the water.
 *
 * Water needs to know how deep it is at every pixel — that is what drives the
 * depth tint, the shoreline foam and the shallow subsurface glow — and the
 * renderer has no cheap way to ask the terrain that question, because reading
 * the depth buffer it is currently writing into is a feedback loop. Baking the
 * height field into a texture sidesteps it entirely, and a texel every few
 * metres is ample: surf zones are tens of metres wide, and the shader breaks
 * the sampled edge up with noise anyway.
 */
export function buildDepthField(ctx, payload) {
  const { field } = ctx;
  const n = payload.n;
  const half = payload.half;
  const cell = (half * 2) / (n - 1);
  const out = new Float32Array(n * n);
  const dir = new Float64Array(3);
  for (let j = 0; j < n; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < n; i++) {
      const x = -half + i * cell;
      field.frame.directionAt(x, z, dir);
      out[j * n + i] = field.elevation(dir[0], dir[1], dir[2]);
    }
  }
  return { n, half, height: out };
}

// Scratch, module-scoped so a build allocates nothing per vertex.
const _dir = new Float64Array(3);

/**
 * Build one quadtree node.
 *
 * `desc` is { id, level, x0, z0, size, res } in local-frame metres. The output
 * is a padded (res+2)^2 lattice: the interior res^2 is the node proper, and the
 * one-vertex border ring is a *skirt* — the same column dropped straight down.
 *
 * The padding earns its keep twice. It supplies the neighbours the central
 * difference needs, so normals are continuous right up to the node edge instead
 * of degenerating into a one-sided difference that shows as a bright seam under
 * a low sun. And re-using those samples as the skirt costs nothing.
 */
export function buildNode(ctx, desc) {
  const { field, profile } = ctx;
  const frame = field.frame;
  const R = field.radius;
  const res = desc.res;
  const s = desc.size / (res - 1);
  const n = res + 2;                     // padded lattice width
  const count = n * n;
  const cx = desc.x0 + desc.size * 0.5;
  const cz = desc.z0 + desc.size * 0.5;

  // Padded sample pass. `sy` is the local-frame y that puts the surface where
  // `TerrainField.localHeight` puts it — same expression, same inputs, so the
  // mesh and the collision query cannot drift apart.
  const sy = new Float64Array(count);
  const sh = new Float32Array(count);    // elevation above sea level
  const sflow = new Float32Array(count);
  const slat = new Float32Array(count);

  const px = ctx.pole[0], py = ctx.pole[1], pz = ctx.pole[2];
  let minY = Infinity, maxY = -Infinity;

  for (let j = 0; j < n; j++) {
    const z = desc.z0 + (j - 1) * s;
    for (let i = 0; i < n; i++) {
      const x = desc.x0 + (i - 1) * s;
      frame.directionAt(x, z, _dir);
      const h = field.elevation(_dir[0], _dir[1], _dir[2]);
      const inner = R * R + 2 * R * h + h * h - x * x - z * z;
      const y = -R + Math.sqrt(inner > 1 ? inner : 1);
      const k = j * n + i;
      sy[k] = y;
      sh[k] = h;
      sflow[k] = field.flowAt(_dir[0], _dir[1], _dir[2]);
      slat[k] = Math.asin(clamp(_dir[0] * px + _dir[1] * py + _dir[2] * pz, -1, 1));
      if (i > 0 && i < n - 1 && j > 0 && j < n - 1) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Moisture is a synoptic field — it is decided by where the ocean is and what
  // range lies upwind, and it costs a second macro-elevation probe per sample.
  // Evaluating it at every vertex of a thirty-metre chunk would be paying for
  // detail the physics does not contain, so it is sampled on a 9x9 lattice and
  // interpolated. That is not a shortcut, it is the correct resolution.
  const MS = 9;
  const moist = new Float32Array(MS * MS);
  for (let j = 0; j < MS; j++) {
    const z = desc.z0 - s + (j / (MS - 1)) * (desc.size + 2 * s);
    for (let i = 0; i < MS; i++) {
      const x = desc.x0 - s + (i / (MS - 1)) * (desc.size + 2 * s);
      frame.directionAt(x, z, _dir);
      const h = field.elevation(_dir[0], _dir[1], _dir[2]);
      moist[j * MS + i] = field.moistureAt(_dir[0], _dir[1], _dir[2], h);
    }
  }

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const morph = new Float32Array(count * 4);
  const terra = new Float32Array(count * 4);

  // Skirt depth scales with the node, so a hundred-kilometre chunk on the
  // horizon hangs a proportionate curtain and a thirty-metre chunk at your feet
  // hangs a two-metre one. See QuadSphere for why the skirt exists at all when
  // the morph is supposed to make it unnecessary.
  const skirt = desc.size * 0.055 + 0.5;
  const inv = 1 / (MS - 1);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const ring = i === 0 || j === 0 || i === n - 1 || j === n - 1;
      // Source lattice index: the ring borrows from the vertex it hangs off.
      const si = ring ? (i === 0 ? 1 : i === n - 1 ? n - 2 : i) : i;
      const sj = ring ? (j === 0 ? 1 : j === n - 1 ? n - 2 : j) : j;
      const sk = sj * n + si;

      const x = desc.x0 + (si - 1) * s;
      const z = desc.z0 + (sj - 1) * s;
      const y = sy[sk] - (ring ? skirt : 0);

      position[k * 3] = x - cx;
      position[k * 3 + 1] = y;
      position[k * 3 + 2] = z - cz;

      // Central difference of the *rendered* surface, curvature and all. The
      // gradient is in metres per metre, so the normal falls straight out.
      const dydx = (sy[sk + 1] - sy[sk - 1]) / (2 * s);
      const dydz = (sy[sk + n] - sy[sk - n]) / (2 * s);
      const nl = 1 / Math.sqrt(dydx * dydx + 1 + dydz * dydz);
      normal[k * 3] = -dydx * nl;
      normal[k * 3 + 1] = nl;
      normal[k * 3 + 2] = -dydz * nl;

      // Morph target: the vertex this one collapses onto when the node hands
      // back to its parent. Even indices are shared with the parent lattice and
      // do not move; odd ones slide onto their lower neighbour. At full morph
      // every odd vertex is coincident with an even one and the surface *is*
      // the parent's, exactly.
      const ii = si - 1, jj = sj - 1;
      const mi = (ii - (ii & 1)) + 1;
      const mj = (jj - (jj & 1)) + 1;
      const mk = mj * n + mi;
      morph[k * 4] = (desc.x0 + (mi - 1) * s - cx) - position[k * 3];
      morph[k * 4 + 1] = (sy[mk] - (ring ? skirt : 0)) - position[k * 3 + 1];
      morph[k * 4 + 2] = (desc.z0 + (mj - 1) * s - cz) - position[k * 3 + 2];
      morph[k * 4 + 3] = desc.level;

      // Bilinear lift of the coarse moisture lattice.
      const fu = clamp((si / (n - 1)) * (MS - 1), 0, MS - 1.0001);
      const fv = clamp((sj / (n - 1)) * (MS - 1), 0, MS - 1.0001);
      const u0 = fu | 0, v0 = fv | 0;
      const tu = fu - u0, tv = fv - v0;
      const m00 = moist[v0 * MS + u0], m10 = moist[v0 * MS + u0 + 1];
      const m01 = moist[(v0 + 1) * MS + u0], m11 = moist[(v0 + 1) * MS + u0 + 1];
      const m = (m00 * (1 - tu) + m10 * tu) * (1 - tv) + (m01 * (1 - tu) + m11 * tu) * tv;

      const h = sh[sk];
      terra[k * 4] = m;
      terra[k * 4 + 1] = profile.temperatureAt(Math.abs(slat[sk]), h, ctx.season);
      terra[k * 4 + 2] = saturate(sflow[sk]);
      terra[k * 4 + 3] = h;
    }
  }

  return {
    id: desc.id,
    res,
    n,
    ox: cx,
    oz: cz,
    minY: minY === Infinity ? 0 : minY - skirt,
    maxY: maxY === -Infinity ? 0 : maxY,
    position, normal, morph, terra,
  };
}

// -----------------------------------------------------------------------------
// Worker glue. Skipped entirely when this module is imported on the main thread
// as the synchronous fallback — `WorkerGlobalScope` simply does not exist there.
// -----------------------------------------------------------------------------

const inWorker =
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (inWorker) {
  let ctx = null;

  self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'prep') {
      const g = buildErosion(msg);
      self.postMessage(
        { type: 'erosion', job: msg.job, n: g.n, half: g.half, cell: g.cell, delta: g.delta, flow: g.flow },
        [g.delta.buffer, g.flow.buffer]
      );
      return;
    }
    if (msg.type === 'init') {
      ctx = createContext(msg);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'season') {
      if (ctx) ctx.season = msg.season;
      return;
    }
    if (msg.type === 'depth') {
      if (!ctx) { self.postMessage({ type: 'fail', job: msg.job }); return; }
      const d = buildDepthField(ctx, msg);
      self.postMessage(
        { type: 'depth', job: msg.job, n: d.n, half: d.half, height: d.height },
        [d.height.buffer]
      );
      return;
    }
    if (msg.type === 'node') {
      if (!ctx) { self.postMessage({ type: 'fail', id: msg.desc.id }); return; }
      let out;
      try {
        out = buildNode(ctx, msg.desc);
      } catch (err) {
        self.postMessage({ type: 'fail', id: msg.desc.id, error: String(err) });
        return;
      }
      out.type = 'node';
      self.postMessage(out, [
        out.position.buffer, out.normal.buffer, out.morph.buffer, out.terra.buffer,
      ]);
    }
  };
}
