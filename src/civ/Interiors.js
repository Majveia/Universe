/**
 * What is behind the glass.
 *
 * A night city lives or dies on its windows, and the failure mode is always the
 * same: the lit ones are flat rectangles of colour and the unlit ones are holes.
 * Both are wrong. A real lit window is a *room seen edge-on* — you get parallax,
 * a ceiling fixture, the silhouette of a wall, and the geometry slides as you
 * walk past. A real unlit window is not black either; it is dark glass with the
 * street reflected in it.
 *
 * Interior mapping gives both for the price of one quad. The trick (Andersson,
 * 2007) is to never build a room: intersect the view ray with a virtual box
 * behind the window plane, entirely in the fragment shader, and shade whichever
 * face it hit. The parallax is exact, the cost is a handful of divisions, and
 * a hundred thousand windows are still one draw call.
 *
 * The room contents are procedural rather than textured, which matters here
 * because a texture atlas of interiors repeats visibly across a facade of two
 * thousand identical openings. Hashed per window: room depth, wall tone, where
 * the ceiling panel sits, whether there is furniture against the back wall, and
 * whether anybody is standing in front of it.
 *
 * The second half of this file builds the handful of interiors you can actually
 * walk into — ground-floor rooms with real geometry, at the addresses a player
 * is most likely to try a door.
 */

import * as THREE from 'three';
import { Rng, hashInt } from '../core/Rng.js';
import { clamp, lerp } from '../core/Noise.js';

// --- shared GLSL -------------------------------------------------------------

const HASH = /* glsl */ `
  float ih11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  vec3 ih31(float p){
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
  }
`;

/**
 * The interior ray-march. Returns radiance for one window, given a point on the
 * quad in [-1,1]^2 and the view direction already rotated into the window's
 * tangent frame.
 */
export const INTERIOR_GLSL = /* glsl */ `
  ${HASH}

  // Axis-aligned box behind the plane: x,y in [-1,1], z in [-depth, 0].
  vec3 interiorRadiance(vec2 p, vec3 vt, float seed, float lit, vec3 warm){
    vec3 h = ih31(seed * 91.7 + 3.1);
    float depth = mix(0.7, 2.1, h.x);

    // Rooms are not all aligned with the window. Rotating the virtual box by a
    // per-room angle removes the single strongest tell of interior mapping,
    // which is that every room on a facade shares one vanishing point.
    float a = (h.y - 0.5) * 0.5;
    float ca = cos(a), sa = sin(a);
    mat2 rot = mat2(ca, -sa, sa, ca);
    p.x = (rot * vec2(p.x, 0.0)).x + p.x * 0.0 + p.x; // keep p.x, rotation applied to ray only
    vec3 d = vec3(rot * vt.xz, vt.y).xzy;
    d = vec3((rot * vec2(vt.x, vt.z)), vt.y).xzy;

    // Guard against a ray that is parallel to an axis.
    vec3 inv = 1.0 / (abs(d) < vec3(1e-4) ? vec3(1e-4) * sign(d + 1e-6) : d);

    float tx = ((d.x > 0.0 ? 1.0 : -1.0) - p.x) * inv.x;
    float ty = ((d.y > 0.0 ? 1.0 : -1.0) - p.y) * inv.y;
    float tz = (-depth) * inv.z;
    if (d.z >= 0.0) tz = 1e5;

    float t = min(min(tx, ty), max(tz, 0.0001));
    vec3 hit = vec3(p, 0.0) + d * t;

    // Which face. Cheap and branchless enough.
    float isBack  = step(tz, min(tx, ty));
    float isSide  = step(tx, min(ty, tz));
    float isFloor = step(ty, min(tx, tz)) * step(0.0, -d.y);
    float isCeil  = step(ty, min(tx, tz)) * step(0.0, d.y);

    // Palette per room: some are warm domestic, some are cold institutional,
    // and the variance between neighbours is what makes a facade read as
    // hundreds of separate lives rather than one lighting pass.
    float cold = step(0.55, h.z);
    vec3 lamp = mix(warm, warm.bgr * vec3(0.55, 0.9, 1.35), cold);
    vec3 wall = mix(vec3(0.36, 0.30, 0.25), vec3(0.30, 0.33, 0.36), cold);

    // Back wall gets the detail: a bright ceiling wash falling down it, and a
    // dark block of furniture at the bottom.
    vec2 bw = hit.xy;
    float wash = smoothstep(-0.2, 1.0, bw.y);
    float furniture = (1.0 - smoothstep(-0.75, -0.55, bw.y)) * step(0.35, ih11(seed * 13.7));
    float poster = step(abs(bw.x - (h.x - 0.5)), 0.22) * step(abs(bw.y - 0.1), 0.18)
                 * step(0.62, ih11(seed * 5.3));

    vec3 back = wall * (0.35 + wash * 0.9);
    back = mix(back, wall * 0.12, furniture);
    back += lamp * poster * 0.55;

    // An occupant: one dark vertical bar, occasionally. It costs nothing and it
    // is the detail that makes a tower feel inhabited rather than illuminated.
    float occ = step(0.80, ih11(seed * 29.1))
              * step(abs(bw.x - (ih11(seed * 3.7) - 0.5) * 1.2), 0.10)
              * smoothstep(-0.9, -0.1, bw.y) * step(bw.y, 0.35);
    back = mix(back, back * 0.06, occ);

    vec3 side  = wall * (0.22 + 0.35 * (hit.y * 0.5 + 0.5));
    vec3 floorC = wall * 0.18;
    // The ceiling is the light source, so it is the only thing allowed above 1.
    vec3 ceil  = lamp * (1.6 + 1.4 * step(abs(hit.x), 0.55));

    vec3 col = back * isBack + side * isSide + floorC * isFloor + ceil * isCeil;
    // Falloff into the depth of the room — without it every interior is evenly
    // lit and reads as a printed image rather than a volume.
    col *= mix(1.0, 0.35, clamp(-hit.z / depth, 0.0, 1.0));
    return col * lit;
  }
`;

// --- window material ---------------------------------------------------------

const WINDOW_VERT = /* glsl */ `
  precision highp float;
  attribute vec3 aPos;
  attribute vec3 aRight;
  attribute vec3 aUp;
  attribute vec3 aColor;
  attribute vec2 aFlags;   // x = seed, y = lit strength

  varying vec3 vWorld;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;
  varying vec3 vTint;
  varying vec2 vLocal;
  varying float vSeed;
  varying float vLit;

  void main(){
    vLocal = position.xy * 2.0;
    vec3 world = aPos + aRight * position.x * 2.0 + aUp * position.y * 2.0;
    vec4 wp = modelMatrix * vec4(world, 1.0);
    vWorld = wp.xyz;
    vT = normalize(mat3(modelMatrix) * aRight);
    vB = normalize(mat3(modelMatrix) * aUp);
    vN = normalize(cross(vT, vB));
    vTint = aColor;
    vSeed = aFlags.x;
    vLit = aFlags.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WINDOW_FRAG = /* glsl */ `
  precision highp float;
  ${INTERIOR_GLSL}

  uniform vec3 uSkyColor;
  uniform vec3 uNeon;
  uniform float uNight;
  uniform float uTime;
  uniform float uGlassRough;

  varying vec3 vWorld;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;
  varying vec3 vTint;
  varying vec2 vLocal;
  varying float vSeed;
  varying float vLit;

  void main(){
    vec3 V = normalize(vWorld - cameraPosition);
    // Tangent-space view ray. z is measured along the outward normal, so a ray
    // entering the room has negative z.
    vec3 vt = vec3(dot(V, vT), dot(V, vB), dot(V, vN));
    // A grazing ray would march forever; clamping the depth component keeps the
    // silhouette sane at the edge of a tower.
    vt.z = min(vt.z, -0.04);

    // Flicker and daily rhythm. Most windows hold; a few pulse (a screen), a
    // few are on a failing ballast.
    float rr = ih11(vSeed * 17.3);
    float screen = step(0.88, rr) * (0.72 + 0.28 * sin(uTime * (2.0 + rr * 9.0) + vSeed * 30.0));
    float lit = vLit * uNight * mix(1.0, screen, step(0.88, rr));

    vec3 room = interiorRadiance(vLocal, vt, vSeed, lit, vTint);

    // The glass itself. Fresnel-weighted reflection of sky and street neon; this
    // is what stops unlit windows from being holes cut in the building.
    float f = pow(1.0 - clamp(-vt.z, 0.0, 1.0), 4.0);
    vec3 refl = mix(uSkyColor, uNeon * 0.09, 0.35 + 0.35 * ih11(vSeed * 3.1));
    // Grime on the outside of the pane, strongest at the bottom.
    float grime = 0.72 + 0.28 * ih11(vSeed * 11.9);
    grime *= mix(0.7, 1.0, smoothstep(-1.0, 0.4, vLocal.y));

    vec3 col = room * grime + refl * (0.08 + f * 0.95);

    // Mullion: a thin dark border. Windows without a frame read as decals.
    float border = min(1.0 - abs(vLocal.x), 1.0 - abs(vLocal.y));
    col *= smoothstep(0.0, 0.10, border);

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * The material every window in the city shares. Unlit and tone-mapping-exempt:
 * the values it writes are radiance, and the post chain owns the curve.
 */
export function makeWindowMaterial(civ, opts = {}) {
  const neon = civ?.palette?.neonHDR || [1.0, 0.4, 0.8];
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSkyColor: { value: new THREE.Color(0.03, 0.045, 0.075) },
      uNeon: { value: new THREE.Vector3(neon[0], neon[1], neon[2]) },
      uNight: { value: 1 },
      uTime: { value: 0 },
      uGlassRough: { value: opts.glassRoughness ?? 0.2 },
    },
    vertexShader: WINDOW_VERT,
    fragmentShader: WINDOW_FRAG,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  mat.name = 'window-interior';
  return mat;
}

// --- enterable interiors -----------------------------------------------------

/**
 * A small number of rooms with real geometry, at ground level, where a player
 * would actually try a door: on plazas, at the market, beside the transit
 * stops. Everything else stays a shader.
 *
 * These are built as two merged meshes — a lit shell and an emissive fixture
 * set — so the whole "you can go inside" promise costs two draw calls for the
 * entire city.
 */
export function buildInteriors(spots, civ, opts = {}) {
  const rng = new Rng(hashInt((civ.seed ^ 0x1e7e21a) >>> 0));
  const shell = new ShellBuilder();
  const glow = new ShellBuilder();

  const warm = civ.palette.interior;
  const neon = civ.palette.neonHDR;

  for (const spot of spots) {
    const w = spot.width ?? rng.range(6, 12);
    const d = spot.depth ?? rng.range(5, 9);
    const h = spot.height ?? rng.range(3.0, 4.2);
    const cx = spot.position[0], cy = spot.position[1], cz = spot.position[2];
    const yaw = spot.yaw || 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const T = (x, y, z) => [cx + x * c - z * s, cy + y, cz + x * s + z * c];

    const kind = rng.weighted(['shop', 'bar', 'workshop', 'shrine', 'transit'],
      [1.2, 1.0, 0.8, civ.tech.level < 0.6 ? 0.9 : 0.35, civ.tech.level > 0.5 ? 0.8 : 0.1]);

    // Rooms are read from outside through a doorway, so the back wall and the
    // ceiling do almost all the work. The side walls barely matter and are
    // deliberately plain.
    const wallCol = kind === 'bar' ? [0.16, 0.11, 0.10]
      : kind === 'shrine' ? [0.22, 0.19, 0.14]
      : kind === 'workshop' ? [0.20, 0.20, 0.19] : [0.26, 0.25, 0.23];
    const surf = [0.85, 0.05, 0];

    shell.quad(T(-w / 2, 0, -d), T(w / 2, 0, -d), T(w / 2, h, -d), T(-w / 2, h, -d), wallCol, surf);   // back
    shell.quad(T(-w / 2, 0, 0), T(-w / 2, 0, -d), T(-w / 2, h, -d), T(-w / 2, h, 0), wallCol, surf);   // left
    shell.quad(T(w / 2, 0, -d), T(w / 2, 0, 0), T(w / 2, h, 0), T(w / 2, h, -d), wallCol, surf);       // right
    shell.quad(T(-w / 2, 0, 0), T(w / 2, 0, 0), T(w / 2, 0, -d), T(-w / 2, 0, -d),
      [wallCol[0] * 0.55, wallCol[1] * 0.55, wallCol[2] * 0.55], [0.7, 0.02, 0]);                       // floor
    shell.quad(T(-w / 2, h, -d), T(w / 2, h, -d), T(w / 2, h, 0), T(-w / 2, h, 0),
      [0.12, 0.12, 0.12], [0.95, 0, 0]);                                                                // ceiling

    // Counter or altar: one horizontal mass that reads as function.
    const cw = w * rng.range(0.5, 0.8);
    const cd = rng.range(0.7, 1.2);
    const chh = kind === 'shrine' ? h * 0.35 : 1.05;
    const cz0 = -d * rng.range(0.45, 0.7);
    box(shell, T, -cw / 2, 0, cz0 - cd / 2, cw / 2, chh, cz0 + cd / 2,
      [wallCol[0] * 1.4, wallCol[1] * 1.25, wallCol[2] * 1.1], [0.5, 0.15, 0]);

    // Shelving on the back wall — vertical rhythm, which is what a room needs
    // to not read as a box.
    const shelves = rng.int(2, 4);
    for (let i = 0; i < shelves; i++) {
      const y = lerp(1.3, h - 0.4, shelves === 1 ? 0.5 : i / (shelves - 1));
      box(shell, T, -w * 0.42, y, -d + 0.05, w * 0.42, y + 0.08, -d + 0.45,
        [0.30, 0.26, 0.21], [0.8, 0.05, 0]);
    }

    // Light fixtures, HDR so they bloom through the doorway and read from the
    // street as a warm hole in a dark facade.
    const fixtures = rng.int(1, 3);
    const tint = kind === 'shrine' ? neon : warm;
    for (let i = 0; i < fixtures; i++) {
      const z = lerp(-d * 0.85, -d * 0.15, fixtures === 1 ? 0.5 : i / (fixtures - 1));
      glow.quad(T(-w * 0.3, h - 0.06, z - 0.25), T(w * 0.3, h - 0.06, z - 0.25),
        T(w * 0.3, h - 0.06, z + 0.25), T(-w * 0.3, h - 0.06, z + 0.25),
        [tint[0], tint[1], tint[2]], [1, 0, 1]);
    }
    if (kind === 'bar' || kind === 'shop') {
      // A strip under the counter lip. Cheap, and it does more for the read of
      // an interior than any amount of furniture.
      glow.quad(T(-cw / 2, chh - 0.12, cz0 + cd / 2 + 0.01), T(cw / 2, chh - 0.12, cz0 + cd / 2 + 0.01),
        T(cw / 2, chh - 0.02, cz0 + cd / 2 + 0.01), T(-cw / 2, chh - 0.02, cz0 + cd / 2 + 0.01),
        [neon[0], neon[1], neon[2]], [1, 0, 1]);
    }
  }

  const group = new THREE.Group();
  group.name = 'interiors';
  const meshes = [];

  if (shell.count) {
    const m = new THREE.Mesh(shell.build(), opts.shellMaterial || fallbackShellMaterial());
    m.name = 'interior-shells';
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
    meshes.push(m);
  }
  if (glow.count) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(glow.build(), mat);
    m.name = 'interior-lights';
    group.add(m);
    meshes.push(m);
  }

  return {
    group,
    stats: { rooms: spots.length, drawCalls: meshes.length, triangles: (shell.count + glow.count) / 3 },
    update() {},
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        if (m.material !== opts.shellMaterial) m.material.dispose();
      }
      group.clear();
    },
  };
}

function fallbackShellMaterial() {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
}

function box(b, T, x0, y0, z0, x1, y1, z1, col, surf) {
  const p = (x, y, z) => T(x, y, z);
  b.quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), col, surf);
  b.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), col, surf);
  b.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), col, surf);
  b.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), col, surf);
  b.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), col, surf);
}

/**
 * Minimal local accumulator. BuildingKit exports a richer one; duplicating the
 * four methods used here keeps this module importable on its own, which is what
 * lets the interior shader be tested without dragging the city generator in.
 */
class ShellBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.srf = [];
    this.idx = [];
    this.count = 0;
  }
  quad(a, b, c, d, col, surf) {
    const base = this.pos.length / 3;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(col[0], col[1], col[2]);
      this.srf.push(surf[0], surf[1], surf[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.count += 6;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.srf, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
