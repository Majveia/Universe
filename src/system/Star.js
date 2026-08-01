/**
 * A star, rendered as the thing it actually is: a ball of plasma with a
 * boiling surface, a thin pink shell of chromosphere, and a corona that
 * extends for millions of kilometres and is only visible because it is hot
 * enough to emit on its own.
 *
 * Everything here is emissive and unlit. Nothing about a star is diffuse
 * shading, so there is no light term anywhere in these shaders — only
 * radiance, in HDR, at 20-200x white. The bloom in the post chain is what
 * turns that into glare; baking a glow into the albedo would double-count it
 * and flatten the disc into a sticker.
 *
 * The physical pieces, and why each one is here:
 *
 *   Limb darkening. A line of sight at the edge of the disc grazes the
 *   photosphere and only reaches cool, shallow gas; a line of sight at the
 *   centre punches down to hotter gas. So the limb is both darker AND redder.
 *   Doing only the darkening (the usual shortcut) makes a star read as a
 *   shaded sphere, which is exactly wrong — it has no shaded side.
 *
 *   Granulation. The photosphere is the top of the convection zone: rising
 *   columns of hot gas roughly 1000 km across, separated by narrow cooler
 *   downflow lanes. That is a Voronoi topology, not fbm, which is why the
 *   cells come from worley and only the irregularity comes from noise. The
 *   lookup is advected by a curl field so the pattern boils in place instead
 *   of sliding across the surface.
 *
 *   Corona. Optically thin, so the render is a pure emission integral along
 *   the ray with no extinction — physically the easy case. Structure comes
 *   from the magnetic field: helmet streamers concentrated near the magnetic
 *   equator, thinner polar plumes, everything stretched radially because the
 *   field is dragged out by the solar wind.
 *
 *   Prominences. Cool dense plasma suspended in magnetic loops rooted in
 *   active regions. Modelled as actual arc ribbons rather than as density in
 *   the corona march, because an arc SDF inside a raymarch costs more than the
 *   entire rest of the star.
 *
 * Compact objects take a different path. A neutron star is 11 km across: at
 * system scale it is a point source, and what you would actually perceive is
 * the point spread of your own optics. So its render radius is the glare
 * envelope, not the body, and the body itself sits inside it at true scale
 * (sub-pixel, correctly). Pulsar beams are two counter-rotating cones on a
 * magnetic axis tilted from the spin axis — the lighthouse geometry that makes
 * the pulse.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { settings } from '../core/Settings.js';
import { Rng } from '../core/Rng.js';
import { clamp, lerp } from '../core/Noise.js';

const AU_M = 1.495978707e11;

/** Per-tier shader budgets. Index by settings.tier. */
function budget() {
  const t = clamp(settings.tier | 0, 0, 4);
  return {
    sphereSeg: [32, 48, 72, 112, 144][t],
    granOct: [2, 3, 3, 4, 5][t],
    coronaSteps: [8, 12, 18, 26, 34][t],
    coronaOct: [2, 3, 4, 4, 5][t],
    coronaSeg: [16, 20, 28, 40, 48][t],
    prominences: [0, 2, 3, 5, 7][t],
    promSamples: [8, 10, 14, 18, 22][t],
  };
}

// -----------------------------------------------------------------------------
// photosphere
// -----------------------------------------------------------------------------

const PHOTO_VERT = /* glsl */ `
varying vec3 vLocal;
void main(){
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const photoFrag = (b) => /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform float uGranScale;
uniform float uSpotAmount;
uniform float uLimbU1;
uniform float uLimbU2;
uniform float uFlow;
uniform float uDegenerate;   // 1 for white dwarfs / neutron stars: no convection
uniform vec3  uCamLocal;
uniform vec3  uSeed;

varying vec3 vLocal;

void main(){
  vec3 N = normalize(vLocal);
  vec3 V = normalize(uCamLocal - N);
  float mu = saturate(dot(N, V));

  // Convection. Worley cell interiors are the rising granules; the ridge
  // between the two nearest sites is the cool downflow lane.
  vec3 flow = curlNoise(N * 1.9 + uSeed + vec3(0.0, uTime * 0.02, 0.0)) * uFlow;
  vec3 gp = N * uGranScale + flow + uSeed;
  vec3 cell = worley(gp);
  float lane = smoothstep(0.0, 0.18, cell.y - cell.x);
  float gran = mix(0.52, 1.20, lane);

  // Supergranulation: a much larger, much fainter cellular pattern driven by
  // the deeper convection layer. Without it the surface reads as a single
  // uniform grain size, which no real star has.
  vec3 sg = worley(N * (uGranScale * 0.12) + flow * 0.3 + 31.7);
  gran *= mix(0.86, 1.10, smoothstep(0.0, 0.24, sg.y - sg.x));
  gran *= 0.84 + 0.32 * (fbm(gp * 0.6, ${b.granOct}) * 0.5 + 0.5);
  gran = mix(1.0, gran, 1.0 - uDegenerate);

  // Starspots. Strong field chokes convection, so the gas there is genuinely
  // cooler — darker and redder together, never just dimmer.
  float sfield = fbm(N * 2.3 + uSeed * 3.0 + vec3(0.0, uTime * 0.006, 0.0), 4);
  float spot  = smoothstep(0.24, 0.58, sfield) * uSpotAmount;
  float umbra = smoothstep(0.44, 0.74, sfield) * uSpotAmount;

  // Faculae: the bright magnetic walls around spots. They are invisible at
  // disc centre and obvious at the limb, because you are looking down into a
  // hot wall rather than at its top. That mu dependence is the whole effect.
  float fac = smoothstep(0.10, 0.26, sfield) * (1.0 - smoothstep(0.26, 0.44, sfield));
  fac *= uSpotAmount * (1.0 - mu) * 1.8;

  float ld = 1.0 - uLimbU1 * (1.0 - mu) - uLimbU2 * (1.0 - mu) * (1.0 - mu);
  ld = max(ld, 0.015);

  // Redden toward the limb by cooling the effective temperature, then let
  // blackbody() do the colour. Hand-tinting the limb never lands right.
  float tLocal = uTemp * (0.90 + 0.10 * mu) * (1.0 - spot * 0.20 - umbra * 0.12);
  vec3 col = blackbody(tLocal);

  float bright = ld * gran * (1.0 - spot * 0.55 - umbra * 0.30) + fac * 0.35;
  col *= max(bright, 0.0) * uIntensity;

  gl_FragColor = vec4(col, 1.0);
}
`;

// -----------------------------------------------------------------------------
// chromosphere
// -----------------------------------------------------------------------------
//
// A 2000 km shell above the photosphere, optically thin and dominated by
// H-alpha, which is why it is pink. It is only visible where the sightline
// grazes it — i.e. beyond the limb — so the shell is drawn back-facing and the
// photosphere's own depth write removes the on-disc half for free.

const chromoFrag = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform vec3  uCamLocal;
uniform vec3  uSeed;
uniform float uThickness;
varying vec3 vLocal;

void main(){
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  float R = 1.0 + uThickness;
  vec2 tShell = raySphere(ro, rd, vec3(0.0), R);
  if (tShell.x > tShell.y) discard;
  vec2 tCore = raySphere(ro, rd, vec3(0.0), 1.0);
  // Chord length through the shell — this is the emission measure, and it is
  // what makes the rim brighten sharply right at the limb.
  float t0 = max(tShell.x, 0.0);
  float t1 = (tCore.x > t0) ? tCore.x : tShell.y;
  float chord = max(t1 - t0, 0.0);
  if (chord <= 0.0) discard;

  vec3 mid = ro + rd * (t0 + chord * 0.5);
  vec3 d = normalize(mid);
  // Spicules: jets of gas along the field, a few hundred km wide, giving the
  // limb its characteristic burning-grass texture.
  float sp = fbm(d * 46.0 + uSeed + vec3(0.0, uTime * 0.05, 0.0), 3) * 0.5 + 0.5;
  float amt = chord / max(uThickness, 1e-4);
  amt = pow(saturate(amt * 0.55), 1.4) * (0.55 + 0.9 * sp);

  vec3 hAlpha = vec3(1.0, 0.20, 0.19);
  vec3 col = mix(blackbody(uTemp * 0.72), hAlpha, 0.72) * amt * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}
`;

// -----------------------------------------------------------------------------
// corona
// -----------------------------------------------------------------------------

const coronaFrag = (b) => /* glsl */ `
precision highp float;
${GLSL_LIB}

uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform float uOuter;
uniform float uScaleH;
uniform float uStreamer;
uniform vec3  uCamLocal;
uniform vec3  uSeed;

varying vec3 vLocal;

// Optically thin emission per unit length, in units where the star is r=1.
float coronaDensity(vec3 p){
  float r = length(p);
  if (r < 1.0) return 0.0;
  vec3 d = p / r;

  // The field is dragged radially outward by the wind, so structure is
  // correlated along r and decorrelated across it. Sampling the noise mostly
  // on the DIRECTION and only weakly on the radius is what produces streamers
  // instead of a lumpy shell.
  float n1 = fbm(d * 3.2 + vec3(0.0, r * 0.28, 0.0) + uSeed, ${b.coronaOct});
  float n2 = fbm(d * 9.0 - vec3(0.0, r * 0.55, 0.0) + uSeed * 1.7, 3);
  float streak = pow(saturate(n1 * 0.5 + 0.5), 2.3) * (0.62 + 0.62 * (n2 * 0.5 + 0.5));
  streak = mix(1.0, streak, uStreamer);

  // Dipole signature: fat helmet streamers around the magnetic equator, thin
  // fast plumes over the poles. Visible at every total eclipse.
  float lat = abs(d.y);
  float belt = mix(1.0, 0.30, smoothstep(0.30, 0.92, lat));
  float plume = smoothstep(0.86, 1.0, lat) * (0.35 + 0.65 * (fbm(d * 16.0 + uSeed, 2) * 0.5 + 0.5));

  // Two components: the smooth K-corona (Thomson scattering off free
  // electrons, a steep power law) and the structured E-corona.
  float k = pow(1.0 / max(r, 1.0), 5.5) * 0.9;
  float e = exp(-(r - 1.0) / max(uScaleH, 1e-3));
  return (k + e * (streak * belt + plume * 0.45)) ;
}

void main(){
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);

  vec2 tOut = raySphere(ro, rd, vec3(0.0), uOuter);
  if (tOut.x > tOut.y) discard;
  float t0 = max(tOut.x, 0.0);
  float t1 = tOut.y;
  vec2 tCore = raySphere(ro, rd, vec3(0.0), 1.0);
  if (tCore.x > t0 && tCore.x < tCore.y) t1 = min(t1, tCore.x);
  float span = t1 - t0;
  if (span <= 0.0) discard;

  const int STEPS = ${b.coronaSteps};
  float dt = span / float(STEPS);
  // Dither the entry point: with this few steps the alternative is visible
  // concentric banding, which reads as rings around the star.
  float jitter = ign(gl_FragCoord.xy) * dt;

  float acc = 0.0;
  for (int i = 0; i < STEPS; i++){
    float t = t0 + jitter + (float(i) + 0.5) * dt;
    if (t > t1) break;
    acc += coronaDensity(ro + rd * t) * dt;
  }

  // The corona is a million kelvin but most of that radiates in X-ray; what
  // reaches the eye is a faint pearl-white with a warm inner cast.
  vec3 hot = mix(vec3(1.0, 0.94, 0.86), blackbody(uTemp), 0.35);
  vec3 col = hot * acc * uIntensity;

  col += (ign(gl_FragCoord.xy + 17.0) - 0.5) * 1e-3;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// -----------------------------------------------------------------------------
// prominences
// -----------------------------------------------------------------------------

const PROM_VERT = /* glsl */ `
uniform vec3  uCamLocal;
uniform float uTime;
uniform float uWidth;
attribute vec3 aTangent;
attribute float aSide;
attribute float aU;
attribute float aLoop;
varying float vU;
varying float vLoop;
varying float vSide;

void main(){
  // Ribbon billboarded about its own tangent, so a loop never disappears when
  // it happens to be seen edge-on.
  vec3 vd = normalize(uCamLocal - position);
  vec3 off = normalize(cross(normalize(aTangent), vd));
  float taper = sin(aU * 3.14159265) * 0.75 + 0.25;
  vec3 p = position + off * aSide * uWidth * taper;
  vU = aU;
  vLoop = aLoop;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PROM_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uTime;
uniform float uIntensity;
uniform float uTemp;
varying float vU;
varying float vLoop;
varying float vSide;

void main(){
  // Plasma draining down the loop toward both footpoints.
  float flow = fract(vU * 3.0 - uTime * 0.08 + vLoop * 0.37);
  float clump = 0.45 + 0.55 * (fbm(vec3(vU * 9.0, vLoop * 5.0, uTime * 0.05), 3) * 0.5 + 0.5);
  // Loops fill and drain over hours; each gets its own phase so the limb is
  // never uniformly busy.
  float life = 0.5 + 0.5 * sin(uTime * 0.045 + vLoop * 2.399);
  float across = 1.0 - abs(vSide);
  float a = across * across * clump * (0.6 + 0.4 * flow) * smoothstep(0.0, 0.35, life);
  a *= smoothstep(0.0, 0.10, vU) * (1.0 - smoothstep(0.90, 1.0, vU));
  vec3 col = mix(vec3(1.0, 0.22, 0.16), blackbody(uTemp * 0.6), 0.30);
  gl_FragColor = vec4(col * a * uIntensity, 1.0);
}
`;

// -----------------------------------------------------------------------------
// compact-object glare + pulsar beams
// -----------------------------------------------------------------------------

const GLARE_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uIntensity;
uniform float uTemp;
uniform vec3  uCamLocal;
varying vec3 vLocal;

void main(){
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  // Impact parameter of the ray about the source: an unresolved point source
  // is, perceptually, its point spread function. Integrating a steep radial
  // profile along the sightline is the honest way to draw one.
  float tc = -dot(ro, rd);
  float b = length(ro + rd * tc);
  float core = exp(-b * b * 30.0) * 3.0;
  float halo = 1.0 / (1.0 + b * b * 26.0);
  vec3 col = blackbody(uTemp) * (core + halo * 0.55) * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BEAM_VERT = /* glsl */ `
varying vec3 vLocal;
varying float vAxial;
void main(){
  vLocal = position;
  vAxial = abs(position.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAG = /* glsl */ `
precision highp float;
${GLSL_LIB}
uniform float uTime;
uniform float uIntensity;
uniform float uLength;
uniform vec3  uCamLocal;
uniform vec3  uBeamDir;   // magnetic axis in the beam group's frame
varying vec3 vLocal;
varying float vAxial;

void main(){
  float f = saturate(vAxial / uLength);
  // Synchrotron emission thins out as the field opens up; the cone is a shell,
  // not a solid, so the rim is brighter than the middle.
  float radial = length(vLocal.xz) / max(vAxial * 0.19 + 1e-4, 1e-4);
  float shell = exp(-pow(abs(radial - 0.72) * 3.4, 2.0)) + 0.28;
  float striae = 0.65 + 0.35 * (fbm(vec3(atan(vLocal.z, vLocal.x) * 2.4, f * 6.0, uTime * 0.25), 3) * 0.5 + 0.5);
  float fall = pow(1.0 - f, 1.6) * (1.0 - smoothstep(0.86, 1.0, f));

  // Relativistic beaming: the cone is only bright when it sweeps near the
  // line of sight, which is the entire reason a pulsar pulses.
  vec3 toCam = normalize(uCamLocal);
  float align = abs(dot(normalize(uBeamDir), toCam));
  float doppler = pow(saturate(align), 6.0) * 0.85 + 0.15;

  vec3 col = mix(vec3(0.55, 0.75, 1.0), vec3(0.85, 0.92, 1.0), f);
  gl_FragColor = vec4(col * shell * striae * fall * doppler * uIntensity, 1.0);
}
`;

// -----------------------------------------------------------------------------

export class Star {
  /**
   * `record` is a Catalog star. `opts.exposure` scales all emissive output if a
   * realm wants to trade star brightness against the rest of the frame.
   */
  constructor(record, opts = {}) {
    this.record = record;
    this.b = budget();
    this.exposure = opts.exposure ?? 1;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    this._disposables = [];
    this._camLocal = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this.time = 0;

    const rng = new Rng(record.seed ^ 0x5ee1);
    this.rng = rng;
    this.kind = record.kind;

    const compact = this.kind === 'NS' || this.kind === 'PSR';
    // For an unresolved source the render radius is the glare envelope, not
    // the body — see the header.
    this.renderRadius = compact ? 1.1e7 : Math.max(record.radius, 1e5);
    this.bodyScale = compact ? Math.max(record.radius / this.renderRadius, 0.004) : 1;

    // Emissive level. Hot stars are genuinely more luminous per unit area, but
    // the range from 2400 K to 50000 K is 2e5 in flux, which no display and no
    // bloom curve survives. Compress it hard and keep the ordering.
    const tNorm = clamp(Math.log(record.temp / 2400) / Math.log(20), 0, 1.4);
    this.intensity = (18 + 62 * tNorm) * this.exposure;
    if (this.kind === 'WD') this.intensity *= 1.4;
    if (compact) this.intensity *= 2.6;
    if (this.kind === 'RG') this.intensity *= 0.62; // huge, cool, low surface brightness

    this.seedVec = new THREE.Vector3(rng.range(-60, 60), rng.range(-60, 60), rng.range(-60, 60));

    this._buildPhotosphere();
    if (!compact) {
      this._buildChromosphere();
      this._buildCorona();
      this._buildProminences();
    } else {
      this._buildGlare();
      if (this.kind === 'PSR') this._buildBeams();
    }

    // Spin. Cosmetically slowed: a 25-day rotation is invisible, and the point
    // of the granulation is that you can see it move.
    this.spinRate = (Math.PI * 2) / Math.max(record.rotationPeriod, 60) * 6000;
    if (compact) this.spinRate = (Math.PI * 2) * rng.range(0.6, 3.2); // PSR: sub-second, shown fast
  }

  get object3d() {
    return this.group;
  }

  /** Colour and strength of the light this star casts, for the planet shaders. */
  get lightColor() {
    return this._lightColor || (this._lightColor = blackbodyJS(this.record.temp));
  }

  _mat(m) {
    this._disposables.push(m);
    return m;
  }

  _buildPhotosphere() {
    const b = this.b;
    const geo = new THREE.SphereGeometry(1, b.sphereSeg, Math.max(12, b.sphereSeg >> 1));
    this._disposables.push(geo);

    // Limb darkening coefficients run with temperature: cool stars have deep,
    // strongly stratified photospheres and darken far more at the edge.
    const t = clamp((this.record.temp - 3000) / 9000, 0, 1);
    const u1 = lerp(0.82, 0.36, t);
    const u2 = lerp(0.10, 0.28, t);
    const degenerate = this.kind === 'WD' || this.kind === 'NS' || this.kind === 'PSR' ? 1 : 0;

    // Granule size scales with pressure scale height, so a red giant has a
    // handful of enormous cells and a dwarf has millions of small ones.
    const granScale = this.kind === 'RG' ? 3.4 : lerp(46, 22, clamp(this.record.radiusSolar / 3, 0, 1));

    this.photoUniforms = {
      uTime: { value: 0 },
      uTemp: { value: this.record.temp },
      uIntensity: { value: this.intensity },
      uGranScale: { value: granScale },
      uSpotAmount: { value: clamp(this.record.flareActivity * 0.9, 0, 1) },
      uLimbU1: { value: u1 },
      uLimbU2: { value: u2 },
      uFlow: { value: this.kind === 'RG' ? 0.16 : 0.05 },
      uDegenerate: { value: degenerate },
      uCamLocal: { value: new THREE.Vector3(0, 0, 6) },
      uSeed: { value: this.seedVec },
    };

    this.photosphere = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.photoUniforms,
        vertexShader: PHOTO_VERT,
        fragmentShader: photoFrag(b),
        depthWrite: true,
        depthTest: true,
      }))
    );
    this.photosphere.scale.setScalar(this.bodyScale);
    this.photosphere.renderOrder = 0;
    this.group.add(this.photosphere);
  }

  _buildChromosphere() {
    const thickness = this.kind === 'RG' ? 0.06 : 0.022;
    const geo = new THREE.SphereGeometry(1 + thickness, 48, 24);
    this._disposables.push(geo);
    this.chromoUniforms = {
      uTime: { value: 0 },
      uTemp: { value: this.record.temp },
      uIntensity: { value: this.intensity * 0.55 },
      uThickness: { value: thickness },
      uCamLocal: { value: new THREE.Vector3(0, 0, 6) },
      uSeed: { value: this.seedVec },
    };
    this.chromosphere = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.chromoUniforms,
        vertexShader: PHOTO_VERT,
        fragmentShader: chromoFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
      }))
    );
    this.chromosphere.renderOrder = 1;
    this.group.add(this.chromosphere);
  }

  _buildCorona() {
    const b = this.b;
    // Red giants have tenuous, enormous coronae; hot dwarfs have compact
    // bright ones. Outer radius is where the emission has fallen below what
    // the tonemapper can show.
    this.coronaOuter = this.kind === 'RG' ? 3.2 : 5.0;
    const geo = new THREE.SphereGeometry(this.coronaOuter, b.coronaSeg, Math.max(10, b.coronaSeg >> 1));
    this._disposables.push(geo);

    this.coronaUniforms = {
      uTime: { value: 0 },
      uTemp: { value: Math.max(this.record.temp, 4000) },
      uIntensity: { value: this.intensity * (this.kind === 'RG' ? 0.10 : 0.20) },
      uOuter: { value: this.coronaOuter },
      uScaleH: { value: this.kind === 'RG' ? 1.1 : 0.62 },
      uStreamer: { value: clamp(0.45 + this.record.flareActivity * 0.6, 0, 1) },
      uCamLocal: { value: new THREE.Vector3(0, 0, 20) },
      uSeed: { value: this.seedVec },
    };

    this.coronaMat = this._mat(new THREE.ShaderMaterial({
      uniforms: this.coronaUniforms,
      vertexShader: PHOTO_VERT,
      fragmentShader: coronaFrag(b),
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      depthWrite: false,
      depthTest: true,
    }));
    this.corona = new THREE.Mesh(geo, this.coronaMat);
    this.corona.renderOrder = 2;
    this.group.add(this.corona);
  }

  /**
   * Loop arcs rooted in pairs of nearby active-region footpoints. The arc is a
   * great-circle interpolation lifted by a sine, which is what a dipole loop
   * actually traces, and the ribbon is billboarded about its own tangent.
   */
  _buildProminences() {
    const b = this.b;
    const count = Math.round(b.prominences * clamp(0.3 + this.record.flareActivity, 0.3, 1.4));
    if (count <= 0) return;

    const rng = this.rng.fork('prom');
    const N = b.promSamples;
    const positions = [];
    const tangents = [];
    const sides = [];
    const us = [];
    const loops = [];
    const index = [];
    let base = 0;

    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const P = new THREE.Vector3();
    const Pn = new THREE.Vector3();

    for (let l = 0; l < count; l++) {
      // Active regions cluster at mid latitudes — the butterfly diagram.
      const lat = (rng.bool() ? 1 : -1) * rng.range(0.12, 0.62);
      const lon = rng.range(0, Math.PI * 2);
      const sep = rng.range(0.10, 0.34);
      const twist = rng.range(-1, 1) * 0.8;
      const height = rng.range(0.08, 0.42);

      const dirAt = (dlat, dlon, out) => {
        const la = lat + dlat;
        const lo = lon + dlon;
        const c = Math.cos(la);
        return out.set(c * Math.cos(lo), Math.sin(la), c * Math.sin(lo)).normalize();
      };
      dirAt(-sep * 0.5 * twist, -sep * 0.5, A);
      dirAt(sep * 0.5 * twist, sep * 0.5, B);

      const pointAt = (s, out) => {
        // Normalised lerp is a fine stand-in for slerp at these separations and
        // costs a fraction of the trig.
        out.copy(A).lerp(B, s).normalize();
        const lift = 1.0 + height * Math.sin(Math.PI * s);
        return out.multiplyScalar(lift);
      };

      for (let i = 0; i < N; i++) {
        const s = i / (N - 1);
        pointAt(s, P);
        pointAt(Math.min(1, s + 1 / (N - 1)), Pn);
        if (i === N - 1) {
          pointAt(s - 1 / (N - 1), Pn);
          Pn.sub(P).multiplyScalar(-1).add(P);
        }
        const tx = Pn.x - P.x, ty = Pn.y - P.y, tz = Pn.z - P.z;
        for (const sd of [-1, 1]) {
          positions.push(P.x, P.y, P.z);
          tangents.push(tx, ty, tz);
          sides.push(sd);
          us.push(s);
          loops.push(l);
        }
        if (i < N - 1) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      base += N * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
    geo.setAttribute('aLoop', new THREE.Float32BufferAttribute(loops, 1));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    this._disposables.push(geo);

    this.promUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: this.intensity * 0.55 },
      uTemp: { value: this.record.temp },
      uWidth: { value: 0.035 },
      uCamLocal: { value: new THREE.Vector3(0, 0, 6) },
    };
    this.prominences = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.promUniforms,
        vertexShader: PROM_VERT,
        fragmentShader: PROM_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
      }))
    );
    this.prominences.frustumCulled = false;
    this.prominences.renderOrder = 3;
    this.group.add(this.prominences);
  }

  _buildGlare() {
    const geo = new THREE.SphereGeometry(1.0, 32, 16);
    this._disposables.push(geo);
    this.glareUniforms = {
      uIntensity: { value: this.intensity * 0.9 },
      uTemp: { value: Math.min(this.record.temp, 40000) },
      uCamLocal: { value: new THREE.Vector3(0, 0, 6) },
    };
    this.glare = new THREE.Mesh(
      geo,
      this._mat(new THREE.ShaderMaterial({
        uniforms: this.glareUniforms,
        vertexShader: PHOTO_VERT,
        fragmentShader: GLARE_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
      }))
    );
    this.glare.renderOrder = 2;
    this.group.add(this.glare);
  }

  /**
   * Two cones on a magnetic axis tilted away from the spin axis. The tilt is
   * the entire mechanism: without it the beams would not sweep and there would
   * be no pulse.
   */
  _buildBeams() {
    const rng = this.rng.fork('beam');
    // Length in units of the glare envelope; ~0.1 AU of visible beam.
    const L = (0.09 * AU_M) / this.renderRadius;
    const halfAngle = rng.range(0.10, 0.20);
    const geo = new THREE.CylinderGeometry(L * halfAngle, 0.02, L, 24, 1, true);
    geo.translate(0, L * 0.5, 0);
    this._disposables.push(geo);

    this.beamUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: this.intensity * 0.20 },
      uLength: { value: L },
      uCamLocal: { value: new THREE.Vector3(0, 0, 20) },
      uBeamDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    const mat = this._mat(new THREE.ShaderMaterial({
      uniforms: this.beamUniforms,
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    }));

    this.beamGroup = new THREE.Group();
    const up = new THREE.Mesh(geo, mat);
    const down = new THREE.Mesh(geo, mat);
    down.rotation.z = Math.PI;
    up.frustumCulled = false;
    down.frustumCulled = false;
    up.renderOrder = 3;
    down.renderOrder = 3;
    this.beamGroup.add(up, down);
    // Magnetic axis offset from the spin axis.
    this.beamGroup.rotation.z = rng.range(0.25, 0.9);
    this.beamTilt = new THREE.Group();
    this.beamTilt.add(this.beamGroup);
    this.group.add(this.beamTilt);
  }

  /** Animation only. Placement is the realm's job. */
  update(dt, time) {
    this.time = time;
    this.group.rotation.y += this.spinRate * dt;
    if (this.photoUniforms) this.photoUniforms.uTime.value = time;
    if (this.chromoUniforms) this.chromoUniforms.uTime.value = time;
    if (this.coronaUniforms) this.coronaUniforms.uTime.value = time;
    if (this.promUniforms) this.promUniforms.uTime.value = time;
    if (this.beamUniforms) this.beamUniforms.uTime.value = time;
  }

  /**
   * Called after the realm has placed the group and refreshed world matrices.
   * Every shader here works in the star's own unit-radius local space, so all
   * they need is where the camera is in that space.
   */
  sync() {
    const cam = this._camLocal.set(0, 0, 0);
    this.group.worldToLocal(cam);

    if (this.photoUniforms) this.photoUniforms.uCamLocal.value.copy(cam).divideScalar(this.bodyScale);
    if (this.chromoUniforms) this.chromoUniforms.uCamLocal.value.copy(cam);
    if (this.promUniforms) this.promUniforms.uCamLocal.value.copy(cam);
    if (this.glareUniforms) this.glareUniforms.uCamLocal.value.copy(cam);
    if (this.coronaUniforms) {
      this.coronaUniforms.uCamLocal.value.copy(cam);
      // Inside the corona shell we need its far face; outside, its near face.
      // Front-facing when outside keeps the shell in front of the photosphere
      // so the depth test never eats the inner corona.
      const inside = cam.length() < this.coronaOuter;
      const want = inside ? THREE.BackSide : THREE.FrontSide;
      if (this.coronaMat.side !== want) {
        this.coronaMat.side = want;
        this.coronaMat.needsUpdate = true;
      }
    }
    if (this.beamUniforms && this.beamGroup) {
      this.beamGroup.updateMatrixWorld();
      const c = this._tmp.set(0, 0, 0);
      this.beamGroup.worldToLocal(c);
      this.beamUniforms.uCamLocal.value.copy(c);
    }
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
  }
}

/**
 * CPU mirror of the GLSL blackbody fit, so the light a planet shader receives
 * is the same colour as the star it can see in the same frame.
 */
export function blackbodyJS(K) {
  const k = clamp(K, 1000, 40000);
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 1;
    g = clamp(0.39008157876 * Math.log(t) - 0.63184144378, 0, 1);
    b = t <= 19 ? 0 : clamp(0.54320678911 * Math.log(t - 10) - 1.19625408914, 0, 1);
  } else {
    r = clamp(1.29293618606 * Math.pow(t - 60, -0.1332047592), 0, 1);
    g = clamp(1.12989086089 * Math.pow(t - 60, -0.0755148492), 0, 1);
    b = 1;
  }
  return new THREE.Color(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2));
}
