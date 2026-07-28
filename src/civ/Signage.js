/**
 * Alien typography, and the neon that carries it.
 *
 * Invented scripts fail in one specific way: they get drawn as squiggles. What
 * makes an unreadable script read as *language* is not complexity, it is
 * constraint — a fixed stroke budget, a shared set of motifs that recur across
 * the alphabet, a consistent relationship to the baseline, and diacritics that
 * always attach in the same place. Give a generator those four rules and thirty
 * glyphs later the eye is convinced it could learn to read it. Leave them out
 * and thirty glyphs later it is wallpaper.
 *
 * So the alphabet here is built from a small pool of per-culture motifs. Each
 * glyph is one or two motifs plus a little unique material, laid on a lattice
 * whose shape comes from the culture's writing direction. Then whole *words*
 * are pre-composed into the cells of one atlas, which means a sign is a single
 * instanced quad with an integer cell index — hundreds of signs, one draw call,
 * and no per-sign texture work at runtime.
 *
 * The rasteriser is written against a raw Uint8Array rather than a 2D canvas.
 * That is not purity for its own sake: it means the atlas is byte-identical in
 * Node and in the browser, so layout can be generated and tested headlessly,
 * and a worker can produce it without a DOM.
 *
 * Draw-call cost of this whole module: 2 (emissive plates, holograms).
 */

import * as THREE from 'three';
import { Rng, hashInt } from '../core/Rng.js';
import { clamp, lerp, smoothstep } from '../core/Noise.js';

// --- glyph construction ------------------------------------------------------

/**
 * A motif is a reusable stroke shape in unit space. Sharing a handful of these
 * across an entire alphabet is the single thing that makes generated writing
 * look designed rather than sampled.
 */
function makeMotifs(g, rng) {
  const n = rng.int(4, 7);
  const motifs = [];
  for (let i = 0; i < n; i++) {
    const kind = rng.weighted(['bar', 'hook', 'arc', 'fork', 'cross', 'loop'],
      [1.0, 0.8, g.curvature * 1.4 + 0.2, 0.6, g.angularity + 0.2, g.curvature * 1.2]);
    motifs.push(buildMotif(kind, g, rng));
  }
  return motifs;
}

function buildMotif(kind, g, rng) {
  const curl = g.curvature;
  const pts = [];
  const strokes = [];
  const jit = () => rng.range(-0.06, 0.06) * (1 - g.angularity * 0.7);

  switch (kind) {
    case 'bar': {
      const vertical = rng.bool(g.baseline === 'stacked' ? 0.75 : 0.5);
      if (vertical) strokes.push(curve([[0.5 + jit(), 0.05], [0.5 + jit(), 0.95]], curl, rng));
      else strokes.push(curve([[0.05, 0.5 + jit()], [0.95, 0.5 + jit()]], curl, rng));
      break;
    }
    case 'hook': {
      const y = rng.range(0.15, 0.5);
      strokes.push(curve([[0.15, 0.9], [0.15, y], [0.6, y - 0.15]], curl, rng));
      break;
    }
    case 'arc': {
      const a0 = rng.range(0, Math.PI);
      const a1 = a0 + rng.range(1.2, 2.8);
      const p = [];
      for (let i = 0; i <= 6; i++) {
        const a = lerp(a0, a1, i / 6);
        p.push([0.5 + Math.cos(a) * 0.38, 0.5 + Math.sin(a) * 0.38]);
      }
      strokes.push(p);
      break;
    }
    case 'fork': {
      const x = rng.range(0.25, 0.45);
      strokes.push(curve([[x, 0.05], [x, 0.6]], curl, rng));
      strokes.push(curve([[x, 0.6], [x + 0.35, 0.95]], curl, rng));
      strokes.push(curve([[x, 0.6], [x - 0.2, 0.95]], curl, rng));
      break;
    }
    case 'cross': {
      const y = rng.range(0.3, 0.7);
      strokes.push([[0.12, y], [0.88, y]]);
      strokes.push([[rng.range(0.35, 0.65), 0.08], [rng.range(0.35, 0.65), 0.92]]);
      break;
    }
    case 'loop':
    default: {
      const p = [];
      const cx = rng.range(0.4, 0.6), cy = rng.range(0.4, 0.6);
      const rx = rng.range(0.2, 0.34), ry = rng.range(0.2, 0.34);
      const steps = g.angularity > 0.7 ? 4 : 9;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      strokes.push(p);
      break;
    }
  }
  return strokes;
}

/** Subdivides a polyline into a curve, controlled by the culture's curvature. */
function curve(pts, amount, rng) {
  if (amount < 0.12 || pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const bulge = amount * rng.range(0.12, 0.32) * rng.sign();
    const cx = mx - dy * bulge, cy = my + dx * bulge;
    for (let s = 1; s <= 5; s++) {
      const t = s / 5;
      const u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * cx + t * t * b[0],
        u * u * a[1] + 2 * u * t * cy + t * t * b[1],
      ]);
    }
  }
  return out;
}

/**
 * The alphabet. Each glyph is motifs plus a little unique material, so the set
 * has a family resemblance without any two members colliding.
 */
export function makeGlyphSet(civ) {
  const g = civ.glyphs;
  const rng = new Rng(hashInt(g.seed ^ 0x6c1f));
  const motifs = makeMotifs(g, rng);
  const glyphs = [];

  for (let i = 0; i < g.count; i++) {
    const gr = new Rng(hashInt(g.seed ^ (i * 0x9e3779b9)));
    const budget = gr.int(g.strokes[0], g.strokes[1]);
    const strokes = [];

    // One or two shared motifs carry the family resemblance.
    const nMotif = gr.int(1, Math.min(2, budget));
    for (let m = 0; m < nMotif; m++) {
      const src = motifs[gr.int(0, motifs.length - 1)];
      const flipX = gr.bool(0.35), flipY = gr.bool(0.25);
      const sc = gr.range(0.7, 1.0);
      const ox = gr.range(-0.1, 0.1), oy = gr.range(-0.08, 0.08);
      for (const s of src) {
        strokes.push(s.map(([x, y]) => [
          clamp((flipX ? 1 - x : x) * sc + (1 - sc) * 0.5 + ox, 0.02, 0.98),
          clamp((flipY ? 1 - y : y) * sc + (1 - sc) * 0.5 + oy, 0.02, 0.98),
        ]));
      }
    }

    // Then the differentiating strokes, snapped to a lattice so they align with
    // the motifs instead of floating free.
    const lat = g.baseline === 'stacked' ? [3, 5] : [3, 3];
    const remaining = Math.max(0, budget - nMotif);
    for (let s = 0; s < remaining; s++) {
      const ax = gr.int(0, lat[0] - 1) / (lat[0] - 1);
      const ay = gr.int(0, lat[1] - 1) / (lat[1] - 1);
      let bx = gr.int(0, lat[0] - 1) / (lat[0] - 1);
      let by = gr.int(0, lat[1] - 1) / (lat[1] - 1);
      if (Math.abs(ax - bx) < 1e-6 && Math.abs(ay - by) < 1e-6) bx = 1 - ax;
      const p = [[lerp(0.1, 0.9, ax), lerp(0.08, 0.92, ay)], [lerp(0.1, 0.9, bx), lerp(0.08, 0.92, by)]];
      strokes.push(curve(p, g.curvature, gr));
    }

    // Boxed scripts get a partial enclosure. It is the loudest possible family
    // signature and instantly separates this culture from its neighbours.
    if (g.baseline === 'boxed' && gr.bool(0.8)) {
      const open = gr.int(0, 3);
      const box = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92], [0.08, 0.08]];
      for (let e = 0; e < 4; e++) if (e !== open) strokes.push([box[e], box[e + 1]]);
    }
    if (g.baseline === 'hanging') {
      strokes.push([[0.06, 0.06], [0.94, 0.06]]);   // the rail the glyph hangs from
    }

    if (g.diacritics && gr.next() < g.diacriticRate) {
      const yy = g.baseline === 'hanging' ? 0.88 : 0.06;
      const n = gr.int(1, 3);
      for (let d = 0; d < n; d++) {
        const x = lerp(0.25, 0.75, n === 1 ? 0.5 : d / (n - 1));
        strokes.push([[x, yy], [x + 0.02, yy + 0.02]]);
      }
    }

    glyphs.push({ strokes, width: g.aspect * gr.range(0.9, 1.1) });
  }
  return glyphs;
}

// --- rasteriser --------------------------------------------------------------

/**
 * Antialiased polyline rasterisation straight into RGBA bytes. Coverage is
 * computed from true distance-to-segment rather than by supersampling, because
 * at atlas resolution a stroke is two or three pixels wide and any sampling
 * scheme cheap enough to run 2000 times would alias visibly.
 */
function strokeInto(buf, W, H, pts, halfW, gain = 1) {
  const aa = 0.9;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0] * W, ay = pts[i][1] * H;
    const bx = pts[i + 1][0] * W, by = pts[i + 1][1] * H;
    const minx = Math.max(0, Math.floor(Math.min(ax, bx) - halfW - aa - 1));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + halfW + aa + 1));
    const miny = Math.max(0, Math.floor(Math.min(ay, by) - halfW - aa - 1));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(ay, by) + halfW + aa + 1));
    const ex = bx - ax, ey = by - ay;
    const el = ex * ex + ey * ey || 1e-6;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        let t = (px * ex + py * ey) / el;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - ex * t, dy = py - ey * t;
        const d = Math.sqrt(dx * dx + dy * dy);
        let cov = (halfW + aa - d) / (2 * aa);
        cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
        if (cov <= 0) continue;
        const a = Math.min(255, Math.round(cov * 255 * gain));
        const o = (y * W + x) * 4 + 3;
        if (a > buf[o]) buf[o] = a;
      }
    }
  }
}

function fillRect(buf, W, H, x0, y0, x1, y1, a) {
  for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) {
      const o = (y * W + x) * 4 + 3;
      if (a > buf[o]) buf[o] = a;
    }
  }
}

/**
 * Composes whole words into the cells of one atlas.
 *
 * Pre-composing rather than assembling glyphs at runtime is what buys the draw
 * call: a sign becomes one quad plus an integer. The cost is that the city has
 * a finite vocabulary of about sixty phrases, which nobody has ever noticed in
 * a game, because nobody reads the same alien sign twice.
 */
export function makeSignAtlas(civ, opts = {}) {
  const size = opts.size || 1024;
  const vertical = civ.glyphs.direction === 'ttb';
  // Cell aspect follows the writing direction: horizontal fascia boards for a
  // culture that reads across, hanging columns for one that reads down.
  const cols = vertical ? 16 : 4;
  const rows = vertical ? 4 : 16;
  const cw = Math.floor(size / cols);
  const ch = Math.floor(size / rows);
  const count = cols * rows;

  const buf = new Uint8Array(size * size * 4);
  // RGB stays white; the instance tint supplies the colour, so one atlas serves
  // every neon hue in the city.
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 255; buf[i * 4 + 1] = 255; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 0;
  }

  const glyphs = makeGlyphSet(civ);
  const rng = new Rng(hashInt(civ.glyphs.seed ^ 0xa7c3));
  const hw = Math.max(1.0, civ.glyphs.strokeWidth * Math.min(cw, ch) * 0.5);

  for (let c = 0; c < count; c++) {
    const cx0 = (c % cols) * cw;
    const cy0 = Math.floor(c / cols) * ch;
    const gr = new Rng(hashInt(civ.glyphs.seed ^ (c * 0x27d4eb2d)));

    const n = gr.int(civ.glyphs.wordLength[0], civ.glyphs.wordLength[1] + (vertical ? 1 : 2));
    const pad = Math.round(Math.min(cw, ch) * 0.12);

    // Frame furniture. A rule under the text, a bracket, a tick row — small,
    // consistent, and the difference between "text" and "a manufactured sign".
    const frame = gr.next();
    if (frame < 0.3) fillRect(buf, size, size, cx0 + pad, cy0 + ch - pad * 0.9, cx0 + cw - pad, cy0 + ch - pad * 0.45, 235);
    else if (frame < 0.45) {
      fillRect(buf, size, size, cx0 + pad * 0.5, cy0 + pad * 0.5, cx0 + pad * 0.9, cy0 + ch - pad * 0.5, 235);
      fillRect(buf, size, size, cx0 + cw - pad * 0.9, cy0 + pad * 0.5, cx0 + cw - pad * 0.5, cy0 + ch - pad * 0.5, 235);
    }

    if (vertical) {
      const slot = (ch - pad * 2) / n;
      const gw = Math.min(cw - pad * 2, slot * 0.92);
      for (let i = 0; i < n; i++) {
        const gi = glyphs[gr.int(0, glyphs.length - 1)];
        const ox = cx0 + (cw - gw) * 0.5;
        const oy = cy0 + pad + i * slot + (slot - gw) * 0.5;
        drawGlyph(buf, size, gi, ox, oy, gw, gw, hw);
      }
    } else {
      const slot = (cw - pad * 2) / n;
      const gh = Math.min(ch - pad * 2.2, slot * 1.25);
      for (let i = 0; i < n; i++) {
        const gi = glyphs[gr.int(0, glyphs.length - 1)];
        const gw = slot * 0.88;
        const ox = cx0 + pad + i * slot + (slot - gw) * 0.5;
        const oy = cy0 + (ch - gh) * 0.45;
        drawGlyph(buf, size, gi, ox, oy, gw, gh, hw);
      }
    }
  }

  return { data: buf, size, cols, rows, count, vertical, cellAspect: cw / ch };
}

function drawGlyph(buf, size, glyph, ox, oy, w, h, hw) {
  for (const s of glyph.strokes) {
    const pts = s.map(([x, y]) => [(ox + x * w) / size, (oy + y * h) / size]);
    strokeInto(buf, size, size, pts, hw);
  }
}

/** DataTexture from an atlas descriptor. Node-safe: no canvas anywhere. */
export function makeSignTexture(atlas) {
  const tex = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

// --- materials ---------------------------------------------------------------

const SIGN_COMMON = /* glsl */ `
  attribute float aCell;
  attribute vec3 aTint;
  attribute float aSeed;
  varying vec2 vUv;
  varying vec3 vTint;
  varying float vSeed;
  uniform vec2 uGrid;
`;

const SIGN_VERT = /* glsl */ `
  ${SIGN_COMMON}
  void main(){
    vSeed = aSeed;
    vTint = aTint;
    float col = mod(aCell, uGrid.x);
    float row = floor(aCell / uGrid.x);
    // Atlas rows are laid out top-down in the byte buffer, so flip V here once
    // rather than flipping the whole texture and fighting mipmap edges.
    vUv = (uv + vec2(col, uGrid.y - 1.0 - row)) / uGrid;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

/**
 * Emissive plate. Additive so it composites like light rather than like paint,
 * and deliberately pushed well above the post chain's 1.15 bloom threshold —
 * a sign that does not bloom is a sticker.
 */
const PLATE_FRAG = /* glsl */ `
  ${SIGN_COMMON}
  uniform sampler2D uAtlas;
  uniform float uTime;
  uniform float uNight;
  void main(){
    vec4 t = texture2D(uAtlas, vUv);
    // Per-sign flicker: most signs are steady, a few are dying. The rare
    // failing tube does more for a street than any amount of uniform glow.
    float bad = step(0.86, fract(vSeed * 7.31));
    float f = 1.0 - bad * (0.55 + 0.45 * sin(uTime * (11.0 + vSeed * 40.0)))
              * step(0.5, fract(sin(uTime * 2.3 + vSeed * 90.0) * 43.0));
    float a = t.a;
    if (a < 0.02) discard;
    vec3 c = vTint * a * f * uNight;
    gl_FragColor = vec4(c, a);
  }
`;

/** Free-floating hologram: scanlines, edge falloff, and a slow vertical roll. */
const HOLO_FRAG = /* glsl */ `
  ${SIGN_COMMON}
  uniform sampler2D uAtlas;
  uniform float uTime;
  uniform float uNight;
  void main(){
    vec2 uv = vUv;
    // A projected image is never quite stable. One slow roll plus a rare
    // horizontal tear is enough; more reads as a broken effect.
    float roll = fract(uTime * 0.07 + vSeed);
    float tear = step(0.995, fract(sin((uv.y + roll) * 90.0 + vSeed * 30.0) * 137.0));
    uv.x += tear * 0.02;
    vec4 t = texture2D(uAtlas, uv);
    float scan = 0.62 + 0.38 * sin(vUv.y * 520.0 - uTime * 6.0);
    float edge = smoothstep(0.0, 0.12, vUv.y) * smoothstep(0.0, 0.12, 1.0 - vUv.y);
    float a = t.a * scan * edge;
    if (a < 0.015) discard;
    gl_FragColor = vec4(vTint * a * uNight, a * 0.85);
  }
`;

// --- build -------------------------------------------------------------------

/**
 * `placements` is a flat list of { position:[x,y,z], yaw, width, height, tint,
 * cell, holo } produced by whoever owns the facades. Everything becomes two
 * instanced meshes.
 */
export function buildSignage(civ, placements, opts = {}) {
  const atlas = opts.atlas || makeSignAtlas(civ, { size: opts.atlasSize || 1024 });
  const tex = makeSignTexture(atlas);

  const plates = placements.filter((p) => !p.holo);
  const holos = placements.filter((p) => p.holo);

  const uniforms = {
    uAtlas: { value: tex },
    uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
    uTime: { value: 0 },
    uNight: { value: 1 },
  };

  const group = new THREE.Group();
  group.name = 'signage';
  const meshes = [];

  const build = (list, frag, name, renderOrder) => {
    if (!list.length) return null;
    const geo = new THREE.PlaneGeometry(1, 1);
    const cell = new Float32Array(list.length);
    const tint = new Float32Array(list.length * 3);
    const seed = new Float32Array(list.length);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SIGN_VERT,
      fragmentShader: frag,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      p.set(it.position[0], it.position[1], it.position[2]);
      e.set(it.pitch || 0, it.yaw || 0, it.roll || 0);
      q.setFromEuler(e);
      s.set(it.width, it.height, 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      cell[i] = it.cell % atlas.count;
      tint[i * 3] = it.tint[0]; tint[i * 3 + 1] = it.tint[1]; tint[i * 3 + 2] = it.tint[2];
      seed[i] = it.seed ?? (i * 0.6180339887) % 1;
    }
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    group.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  build(plates, PLATE_FRAG, 'sign-plates', 3);
  build(holos, HOLO_FRAG, 'sign-holos', 4);

  return {
    group,
    atlas,
    texture: tex,
    stats: { plates: plates.length, holograms: holos.length, drawCalls: meshes.length, atlasCells: atlas.count },
    update(dt, ctx = {}) {
      uniforms.uTime.value += dt;
      // Signs stay on in daylight but stop carrying the image; dropping their
      // contribution rather than their existence avoids a visible switch.
      const night = ctx.night ?? 1;
      uniforms.uNight.value = lerp(0.35, 1.0, night);
    },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.material.dispose();
      }
      tex.dispose();
      group.clear();
    },
  };
}

/**
 * Helper for facade owners: picks a plausible sign for a wall of given size,
 * or returns null. Kept here so the rules about what gets a sign (ground floors
 * and roofs, not the fortieth storey; markets more than necropolises) live next
 * to the thing that draws them.
 */
export function proposeSign(civ, rng, ctx) {
  const density = civ.tech.signageDensity * (ctx.districtSignage ?? 1);
  if (rng.next() > density * 0.5) return null;
  const holo = civ.tech.holograms && rng.next() < 0.32;
  const vertical = civ.glyphs.direction === 'ttb';
  const tint = rng.bool(0.62) ? civ.palette.neonHDR : civ.palette.neon2HDR;
  const scale = ctx.scale ?? 1;
  const w = vertical ? rng.range(0.9, 1.8) * scale : rng.range(2.6, 6.5) * scale;
  const h = vertical ? rng.range(3.5, 9) * scale : rng.range(0.9, 1.9) * scale;
  return {
    holo,
    width: w,
    height: h,
    tint: [tint[0], tint[1], tint[2]],
    cell: rng.int(0, 63),
    seed: rng.next(),
  };
}
