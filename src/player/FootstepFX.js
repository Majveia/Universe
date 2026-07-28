/**
 * Ground contact effects — dust, footprints, impacts.
 *
 * Everything a body does to the ground it is standing on. The rule this file
 * follows is that an effect is only ever spawned from a *physical* event: a foot
 * that the IK solver actually planted, a landing whose impact speed the motor
 * actually measured, a slide that is actually happening. Nothing here runs on a
 * timer. That is the difference between dust that reads as consequence and dust
 * that reads as a particle system someone bolted on.
 *
 * The implementation is one static pool of GPU-simulated particles plus one
 * instanced ring buffer of footprint decals. Both are allocated once at build
 * time and never grow — a phone cannot afford a garbage collection in the middle
 * of a sprint, and the whole point of a pool is that the worst case is the only
 * case.
 *
 * Particles are integrated entirely in the vertex shader from (spawn, velocity,
 * acceleration, birth) so the CPU touches a particle exactly once, when it is
 * born. Sixteen floats written on a footstep is cheaper than any CPU update loop
 * could ever be, and it means the cost of dust is independent of how much dust
 * is in the air.
 *
 * Surface material drives colour, quantity and lifetime. Kicking up regolith on
 * a dead moon should look nothing like scuffing wet grass, and since the surface
 * realm already tells us what we are standing on, that comes for free.
 */

import * as THREE from 'three';
import { Rng } from '../core/Rng.js';
import { clamp, saturate, damp } from '../core/Noise.js';

/**
 * Per-material response. `dust` is how much makes it into the air, `grip` biases
 * particle drag (sand hangs, rock chips fall), `print` is how visible a boot
 * leaves a mark — you do not leave footprints on bare rock.
 */
const MATERIAL_FX = {
  regolith: { colour: 0xa89a86, dust: 1.0, drag: 1.1, print: 0.95, spread: 1.0, life: 1.5 },
  sand:     { colour: 0xd3b98a, dust: 1.35, drag: 0.75, print: 1.0, spread: 1.25, life: 2.1 },
  rock:     { colour: 0x8b8781, dust: 0.35, drag: 2.4, print: 0.12, spread: 0.7, life: 0.8 },
  ice:      { colour: 0xd6f0fa, dust: 0.45, drag: 2.8, print: 0.3, spread: 0.9, life: 0.7 },
  snow:     { colour: 0xf0f6fb, dust: 1.15, drag: 1.5, print: 1.0, spread: 1.1, life: 1.7 },
  grass:    { colour: 0x7f9166, dust: 0.4, drag: 2.0, print: 0.45, spread: 0.8, life: 0.9 },
  metal:    { colour: 0xa9b2bd, dust: 0.08, drag: 3.2, print: 0.0, spread: 0.5, life: 0.4 },
  mud:      { colour: 0x6b5844, dust: 0.5, drag: 2.6, print: 1.2, spread: 0.6, life: 0.9 },
  water:    { colour: 0xa8d8e8, dust: 1.2, drag: 1.8, print: 0.0, spread: 1.4, life: 1.0 },
};

function fxFor(surface) {
  if (!surface) return MATERIAL_FX.regolith;
  return MATERIAL_FX[surface.material] || MATERIAL_FX.regolith;
}

const PARTICLE_VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uPixelScale;

attribute vec3 aVel;
attribute vec3 aAccel;
attribute vec4 aParams;   // birth, life, size, seed
attribute vec3 aColor;
attribute float aDrag;

varying float vAge;
varying float vSeed;
varying vec3 vColor;
varying float vSoft;

void main(){
  float birth = aParams.x;
  float life  = aParams.y;
  float t = uTime - birth;
  vAge = clamp(t / max(life, 0.0001), 0.0, 1.0);
  vSeed = aParams.w;
  vColor = aColor;

  // Analytic integration of  v' = a - k v  gives an exponential settle that
  // looks like air resistance rather than like a ballistic arc. Written out in
  // closed form so no state has to survive between frames.
  float k = max(aDrag, 0.02);
  float e = (1.0 - exp(-k * t)) / k;
  vec3 p = position + aVel * e + aAccel * (t - e) / k;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // Grow as they disperse: a puff is a puff because it expands.
  float grow = 1.0 + vAge * 2.6;
  float fade = smoothstep(1.0, 0.72, vAge);
  float size = aParams.z * grow * fade;
  vSoft = fade;

  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * uPixelScale / max(-mv.z, 0.35);
  // A dead particle is pushed behind the camera rather than drawn transparent —
  // cheaper than blending a thousand invisible quads.
  if (vAge >= 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;

varying float vAge;
varying float vSeed;
varying vec3 vColor;
varying float vSoft;

void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  // Soft-edged blob with a slightly hot core. The core fades faster than the
  // halo, which is how real dust dissipates: it goes thin before it goes away.
  float core = exp(-r2 * 3.4);
  float halo = exp(-r2 * 1.15);
  float a = mix(halo, core, 0.55) * vSoft;

  // Late in life the puff cools and darkens as it thins out against the sky.
  vec3 c = vColor * mix(1.25, 0.55, vAge);
  gl_FragColor = vec4(c, a * 0.5);
}
`;

const DECAL_VERT = /* glsl */ `
precision highp float;

uniform float uTime;

attribute vec2 aDecal;    // birth, life
attribute vec3 aTint;

varying vec2 vUv;
varying float vFade;
varying vec3 vTint;

void main(){
  vUv = uv;
  vTint = aTint;
  float age = (uTime - aDecal.x) / max(aDecal.y, 0.001);
  vFade = 1.0 - smoothstep(0.55, 1.0, age);
  vec4 world = instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * world;
  if (age >= 1.0 || aDecal.x < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const DECAL_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying float vFade;
varying vec3 vTint;

void main(){
  // A boot sole: a rounded rectangle with a heel notch, drawn as a field so it
  // needs no texture and stays crisp at any distance.
  vec2 p = vUv * 2.0 - 1.0;
  vec2 q = abs(vec2(p.x * 1.85, p.y)) - vec2(0.55, 0.72);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.24;
  float sole = smoothstep(0.06, -0.05, d);
  // Tread: three lateral bars pressed deeper than the sole around them.
  float tread = smoothstep(0.45, 0.85, abs(sin(p.y * 7.5)));
  float arch = smoothstep(0.22, 0.0, abs(p.y + 0.02)) * 0.6;
  float mark = sole * (0.55 + tread * 0.45) * (1.0 - arch);

  float a = mark * vFade * 0.62;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vTint, a);
}
`;

const RING_VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
uniform float uAge;
uniform vec3 uColor;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // An expanding shell: the ring rides outward as it fades, so a hard landing
  // reads as a pressure wave rather than as a decal that grew.
  float edge = smoothstep(0.06, 0.0, abs(r - mix(0.15, 1.0, uAge)));
  float a = edge * (1.0 - uAge) * (1.0 - uAge);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a * 0.55);
}
`;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();
const _upRef = new THREE.Vector3(0, 1, 0);

export class FootstepFX {
  /**
   * @param {THREE.Object3D} parent scene or realm group to attach to
   * @param {object} opts { maxParticles, maxPrints, seed, quality }
   */
  constructor(parent, opts = {}) {
    this.parent = parent;
    this.rng = new Rng(opts.seed ?? 0x510e57);
    this.time = 0;
    this.enabled = true;

    // Scaled by quality rather than by tier directly, so the caller (who knows
    // whether this is the player or a distant NPC) decides how much it is worth.
    const q = clamp(opts.quality ?? 1, 0.15, 2);
    this.maxParticles = Math.max(96, Math.floor((opts.maxParticles ?? 900) * q));
    this.maxPrints = Math.max(16, Math.floor((opts.maxPrints ?? 96) * q));
    this.quality = q;

    this._cursor = 0;
    this._printCursor = 0;
    this._particlesDirty = false;
    this._printsDirty = false;

    this.group = new THREE.Group();
    this.group.name = 'footstep-fx';
    this.group.frustumCulled = false;
    this.group.matrixAutoUpdate = false;

    this._buildParticles();
    this._buildPrints();
    this._buildRings();

    if (parent) parent.add(this.group);
  }

  // ---------------------------------------------------------------------------
  // Construction.
  // ---------------------------------------------------------------------------

  _buildParticles() {
    const n = this.maxParticles;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const acc = new Float32Array(n * 3);
    const par = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const drg = new Float32Array(n);
    // Birth far in the past so nothing is visible on the first frame.
    for (let i = 0; i < n; i++) par[i * 4] = -1000;

    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aAccel', new THREE.BufferAttribute(acc, 3));
    g.setAttribute('aParams', new THREE.BufferAttribute(par, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aDrag', new THREE.BufferAttribute(drg, 1));
    // The bounding sphere would have to be recomputed every spawn otherwise, and
    // dust is always near the player anyway.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._pMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 340 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this._pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.group.add(this.points);
    this._pGeo = g;
  }

  _buildPrints() {
    const n = this.maxPrints;
    const plane = new THREE.PlaneGeometry(1, 1);
    // Lying flat: the decal is authored in XY and then rotated onto the ground.
    plane.rotateX(-Math.PI / 2);

    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.attributes.position = plane.attributes.position;
    g.attributes.uv = plane.attributes.uv;
    g.attributes.normal = plane.attributes.normal;
    g.instanceCount = n;

    const decal = new Float32Array(n * 2);
    const tint = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) decal[i * 2] = -1000;
    g.setAttribute('aDecal', new THREE.InstancedBufferAttribute(decal, 2));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._dMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      // Decals sit exactly on the surface they mark, so they need a depth nudge
      // or they z-fight with the terrain they are describing.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.prints = new THREE.InstancedMesh(g, this._dMat, n);
    this.prints.frustumCulled = false;
    this.prints.renderOrder = 4;
    this.prints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Park every instance at a degenerate scale until it is used.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) this.prints.setMatrixAt(i, _m);
    this.prints.instanceMatrix.needsUpdate = true;
    this.group.add(this.prints);
    this._dGeo = g;
  }

  _buildRings() {
    // Only a handful of impact rings can plausibly overlap, so this pool is
    // deliberately tiny and each ring gets its own uniform rather than an
    // attribute — simpler, and the draw call count barely moves.
    this.rings = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uAge: { value: 2 }, uColor: { value: new THREE.Color(0xbdb2a0) } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 2, life: 1 });
    }
    this._ringCursor = 0;
  }

  // ---------------------------------------------------------------------------
  // Spawning.
  // ---------------------------------------------------------------------------

  /** Write one particle into the ring buffer. All vectors are world space. */
  _emit(px, py, pz, vx, vy, vz, ax, ay, az, size, life, drag, r, g, b) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.maxParticles;
    const A = this._pGeo.attributes;
    const p = A.position.array;
    const V = A.aVel.array;
    const Ac = A.aAccel.array;
    const P = A.aParams.array;
    const C = A.aColor.array;
    const D = A.aDrag.array;
    const i3 = i * 3;
    p[i3] = px; p[i3 + 1] = py; p[i3 + 2] = pz;
    V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    Ac[i3] = ax; Ac[i3 + 1] = ay; Ac[i3 + 2] = az;
    C[i3] = r; C[i3 + 1] = g; C[i3 + 2] = b;
    const i4 = i * 4;
    P[i4] = this.time;
    P[i4 + 1] = life;
    P[i4 + 2] = size;
    P[i4 + 3] = this.rng.next();
    D[i] = drag;
    this._particlesDirty = true;
  }

  /**
   * Build an orthonormal basis around a normal so puffs spray *along the
   * surface* rather than straight up. Dust kicked by a boot travels mostly
   * sideways; only the fine fraction rises.
   */
  _basis(n) {
    const ref = Math.abs(n.y) > 0.94 ? _upRef.set(1, 0, 0) : _upRef.set(0, 1, 0);
    _t1.crossVectors(ref, n).normalize();
    _t2.crossVectors(n, _t1).normalize();
    _upRef.set(0, 1, 0);
  }

  /**
   * A footfall. `opts.speed` is the body speed at the moment of contact, which
   * decides whether this is a soft placement or a hard slap.
   */
  footstep(position, normal, opts = {}) {
    if (!this.enabled) return;
    const fx = fxFor(opts.surface);
    const speed = opts.speed ?? 2;
    const gravity = opts.gravity ?? 9.81;
    const n = _v.copy(normal || _upRef).normalize();
    this._basis(n);

    // Below a walk there is essentially nothing to see, and spawning it anyway
    // is how you end up with a permanent dust cloud around an idle character.
    const energy = saturate((speed - 1.1) / 5.5);
    if (energy <= 0.01 && !opts.force) return;

    const count = Math.round(clamp(2 + energy * 9, 0, 14) * fx.dust * this.quality);
    _col.setHex(opts.surface?.colour ?? fx.colour);

    for (let i = 0; i < count; i++) {
      const rng = this.rng;
      const ang = rng.next() * Math.PI * 2;
      const rad = Math.sqrt(rng.next()) * 0.16 * fx.spread;
      const px = position.x + _t1.x * Math.cos(ang) * rad + _t2.x * Math.sin(ang) * rad;
      const py = position.y + _t1.y * Math.cos(ang) * rad + _t2.y * Math.sin(ang) * rad + 0.03;
      const pz = position.z + _t1.z * Math.cos(ang) * rad + _t2.z * Math.sin(ang) * rad;

      // Mostly lateral, biased backwards along travel: a foot pushes the ground
      // behind it, so the plume trails you.
      const lateral = (0.6 + rng.next() * 1.5) * (0.4 + energy) * fx.spread;
      const rise = (0.25 + rng.next() * 0.9) * (0.35 + energy * 0.9);
      let vx = (_t1.x * Math.cos(ang) + _t2.x * Math.sin(ang)) * lateral + n.x * rise;
      let vy = (_t1.y * Math.cos(ang) + _t2.y * Math.sin(ang)) * lateral + n.y * rise;
      let vz = (_t1.z * Math.cos(ang) + _t2.z * Math.sin(ang)) * lateral + n.z * rise;
      if (opts.velocity) {
        vx -= opts.velocity.x * 0.14;
        vy -= opts.velocity.y * 0.14;
        vz -= opts.velocity.z * 0.14;
      }

      // Gravity along the world's own down, so dust falls correctly on a sphere.
      const gd = opts.up || _upRef;
      const jitter = 0.82 + rng.next() * 0.5;
      this._emit(
        px, py, pz,
        vx, vy, vz,
        -gd.x * gravity * 0.32, -gd.y * gravity * 0.32, -gd.z * gravity * 0.32,
        (0.055 + rng.next() * 0.1) * (0.7 + energy), fx.life * (0.6 + rng.next() * 0.7), fx.drag * jitter,
        _col.r * jitter, _col.g * jitter, _col.b * jitter
      );
    }

    if (fx.print > 0.05 && opts.yaw !== undefined) {
      this.footprint(position, n, opts.yaw, fx, opts.surface, clamp(0.55 + energy, 0.4, 1.4));
    }
  }

  /** Stamp a boot decal. Oriented to the surface, scaled by how hard it landed. */
  footprint(position, normal, yaw, fx, surface, weight = 1) {
    if (!this.enabled) return;
    fx = fx || fxFor(surface);
    if (fx.print <= 0.02) return;

    const i = this._printCursor;
    this._printCursor = (this._printCursor + 1) % this.maxPrints;

    // Align +Y to the surface normal, then spin about it to face travel.
    _q.setFromUnitVectors(_upRef.set(0, 1, 0), _v2.copy(normal).normalize());
    _q2.setFromAxisAngle(_v2, -yaw);
    _q.premultiply(_q2);
    const size = 0.42 * clamp(weight, 0.6, 1.3);
    _s.set(size, size, size * 1.35);
    // Lift a centimetre off the surface: enough to clear the polygon offset on
    // a coarse LOD tile, small enough to still read as contact.
    _v.copy(position).addScaledVector(_v2, 0.012);
    _m.compose(_v, _q, _s);
    this.prints.setMatrixAt(i, _m);
    this.prints.instanceMatrix.needsUpdate = true;

    const A = this._dGeo.attributes;
    A.aDecal.array[i * 2] = this.time;
    // Prints on loose ground survive; on rock they scuff away almost at once.
    A.aDecal.array[i * 2 + 1] = 14 * fx.print;
    _col.setHex(surface?.colour ?? fx.colour).multiplyScalar(0.55);
    A.aTint.array[i * 3] = _col.r;
    A.aTint.array[i * 3 + 1] = _col.g;
    A.aTint.array[i * 3 + 2] = _col.b;
    this._printsDirty = true;
  }

  /**
   * A landing. Impact is the vertical speed at contact in m/s, straight from the
   * motor, so a two metre drop and a twenty metre drop genuinely differ.
   */
  impact(position, normal, impactSpeed, opts = {}) {
    if (!this.enabled) return;
    const fx = fxFor(opts.surface);
    const e = saturate((impactSpeed - 2.4) / 12);
    if (e <= 0.005) return;

    const n = _v.copy(normal || _upRef).normalize();
    this._basis(n);
    _col.setHex(opts.surface?.colour ?? fx.colour);
    const gravity = opts.gravity ?? 9.81;
    const gd = opts.up || _upRef;

    const count = Math.round(clamp(6 + e * 34, 0, 46) * fx.dust * this.quality);
    for (let i = 0; i < count; i++) {
      const rng = this.rng;
      const ang = rng.next() * Math.PI * 2;
      const rad = Math.sqrt(rng.next()) * 0.3 * fx.spread;
      const cx = Math.cos(ang);
      const sx = Math.sin(ang);
      // A landing pushes the ring outward hard and low. The upward component is
      // small, which is what makes it read as a splash rather than a fountain.
      const out = (1.2 + rng.next() * 2.8) * (0.5 + e * 1.6) * fx.spread;
      const rise = (0.2 + rng.next() * 0.8) * (0.4 + e);
      this._emit(
        position.x + (_t1.x * cx + _t2.x * sx) * rad,
        position.y + (_t1.y * cx + _t2.y * sx) * rad + 0.02,
        position.z + (_t1.z * cx + _t2.z * sx) * rad,
        (_t1.x * cx + _t2.x * sx) * out + n.x * rise,
        (_t1.y * cx + _t2.y * sx) * out + n.y * rise,
        (_t1.z * cx + _t2.z * sx) * out + n.z * rise,
        -gd.x * gravity * 0.3, -gd.y * gravity * 0.3, -gd.z * gravity * 0.3,
        (0.07 + rng.next() * 0.16) * (0.7 + e), fx.life * (0.75 + rng.next() * 0.8),
        fx.drag * (0.7 + rng.next() * 0.6),
        _col.r, _col.g, _col.b
      );
    }

    if (e > 0.18) this._ring(position, n, _col, 1.3 + e * 2.6, 0.45 + e * 0.5);
  }

  /** Continuous emission — slides, skids, wheels, hover wash. Rate-limited. */
  scuff(position, normal, dt, opts = {}) {
    if (!this.enabled) return;
    const fx = fxFor(opts.surface);
    const intensity = clamp(opts.intensity ?? 1, 0, 3);
    // Accumulate fractional particles so a low rate still emits, just sparsely,
    // and the rate does not quietly become frame-rate dependent.
    this._scuffAccum = (this._scuffAccum ?? 0) + dt * 46 * intensity * fx.dust * this.quality;
    let n = Math.floor(this._scuffAccum);
    if (n <= 0) return;
    this._scuffAccum -= n;
    n = Math.min(n, 12);

    const nrm = _v.copy(normal || _upRef).normalize();
    this._basis(nrm);
    _col.setHex(opts.surface?.colour ?? fx.colour);
    const gravity = opts.gravity ?? 9.81;
    const gd = opts.up || _upRef;
    const vel = opts.velocity;

    for (let i = 0; i < n; i++) {
      const rng = this.rng;
      const ang = rng.next() * Math.PI * 2;
      const rad = Math.sqrt(rng.next()) * 0.22 * fx.spread;
      const cx = Math.cos(ang);
      const sx = Math.sin(ang);
      const out = (0.4 + rng.next() * 1.3) * intensity;
      const rise = (0.3 + rng.next() * 1.0) * (0.4 + intensity * 0.35);
      this._emit(
        position.x + (_t1.x * cx + _t2.x * sx) * rad,
        position.y + (_t1.y * cx + _t2.y * sx) * rad + 0.04,
        position.z + (_t1.z * cx + _t2.z * sx) * rad,
        (_t1.x * cx + _t2.x * sx) * out + nrm.x * rise - (vel ? vel.x * 0.3 : 0),
        (_t1.y * cx + _t2.y * sx) * out + nrm.y * rise - (vel ? vel.y * 0.3 : 0),
        (_t1.z * cx + _t2.z * sx) * out + nrm.z * rise - (vel ? vel.z * 0.3 : 0),
        -gd.x * gravity * 0.26, -gd.y * gravity * 0.26, -gd.z * gravity * 0.26,
        (0.07 + rng.next() * 0.14) * intensity, fx.life * (0.7 + rng.next() * 0.8),
        fx.drag * (0.8 + rng.next() * 0.5),
        _col.r * 1.02, _col.g * 1.02, _col.b * 1.02
      );
    }
  }

  _ring(position, normal, colour, size, life) {
    const slot = this.rings[this._ringCursor];
    this._ringCursor = (this._ringCursor + 1) % this.rings.length;
    _q.setFromUnitVectors(_upRef.set(0, 1, 0), _v2.copy(normal).normalize());
    _upRef.set(0, 1, 0);
    slot.mesh.position.copy(position).addScaledVector(_v2, 0.03);
    slot.mesh.quaternion.copy(_q);
    slot.mesh.scale.setScalar(size);
    slot.mesh.visible = true;
    slot.mat.uniforms.uColor.value.copy(colour);
    slot.mat.uniforms.uAge.value = 0;
    slot.t = 0;
    slot.life = life;
  }

  // ---------------------------------------------------------------------------
  // Frame.
  // ---------------------------------------------------------------------------

  update(dt, viewportHeight) {
    if (!this.enabled) return;
    this.time += dt;
    this._pMat.uniforms.uTime.value = this.time;
    this._dMat.uniforms.uTime.value = this.time;
    if (viewportHeight) this._pMat.uniforms.uPixelScale.value = viewportHeight * 0.5;

    if (this._particlesDirty) {
      const A = this._pGeo.attributes;
      A.position.needsUpdate = true;
      A.aVel.needsUpdate = true;
      A.aAccel.needsUpdate = true;
      A.aParams.needsUpdate = true;
      A.aColor.needsUpdate = true;
      A.aDrag.needsUpdate = true;
      this._particlesDirty = false;
    }
    if (this._printsDirty) {
      this._dGeo.attributes.aDecal.needsUpdate = true;
      this._dGeo.attributes.aTint.needsUpdate = true;
      this._printsDirty = false;
    }

    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const a = r.t / r.life;
      if (a >= 1) { r.mesh.visible = false; continue; }
      r.mat.uniforms.uAge.value = a;
      // Expand as it ages; the shader rides the ring outward within the quad,
      // and the quad itself grows a little so the wave keeps travelling. The
      // exponential form keeps the growth identical at any frame rate.
      r.mesh.scale.setScalar(r.mesh.scale.x * Math.exp(0.5 * dt));
    }
  }

  clear() {
    const P = this._pGeo.attributes.aParams.array;
    for (let i = 0; i < this.maxParticles; i++) P[i * 4] = -1000;
    const D = this._dGeo.attributes.aDecal.array;
    for (let i = 0; i < this.maxPrints; i++) D[i * 2] = -1000;
    this._particlesDirty = true;
    this._printsDirty = true;
    for (const r of this.rings) r.mesh.visible = false;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this._pGeo.dispose();
    this._pMat.dispose();
    this._dGeo.dispose();
    this._dMat.dispose();
    for (const r of this.rings) r.mat.dispose();
    this.prints.dispose?.();
  }
}

export { MATERIAL_FX };
