/**
 * Planets that are too small to draw as geometry.
 *
 * A star system is mostly empty, and from anywhere useful in it almost every
 * planet subtends far less than a pixel. At the default system view of seed 20
 * the *largest* world in frame is 0.57px across and the outermost is 0.005px —
 * so a sphere mesh is the wrong tool for nearly all of them. A triangle smaller
 * than a pixel either misses every sample point and disappears, or catches one
 * and flickers; either way the system view ends up showing a star, some orbit
 * furniture, and no planets at all, which reads as an empty diagram rather than
 * as somewhere with worlds in it.
 *
 * Below the resolution limit a planet is not a disc, it is a point source, and
 * the right thing to draw is its point spread. That is what this does: one
 * sprite per body, positioned in the same compressed space as the meshes, sized
 * and coloured by how bright the thing actually is.
 *
 * BRIGHTNESS IS DERIVED, NOT CHOSEN. The irradiance a lit sphere delivers to
 * the eye goes as
 *
 *     E  ∝  albedo · F_star · (R / d)²  =  albedo · flux · angular²
 *
 * with `flux` already relative to Earth's in the catalogue and `angular` the
 * body's angular radius. Across one system that spans about nine orders of
 * magnitude, which no display can hold, so it is compressed with a power curve
 * the same way the realm compresses illumination — the ordering survives, the
 * inner worlds stay obviously brighter, and nothing falls off the bottom.
 *
 * The floor is the point of the exercise. A world at 75 AU contributes almost
 * nothing on a linear scale; clamped to a dim minimum it stays a faint, steady
 * point, which is both what a telescope would show and what makes the system
 * read as populated.
 *
 * Sprites carry no diffraction spikes, deliberately. The star field draws its
 * cross; a planet gets a calm round PSF. That difference is exactly how the eye
 * separates the two at the eyepiece, and it costs nothing to honour.
 */

import * as THREE from 'three';
import { clamp } from '../core/Noise.js';

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main(){
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  // Round and steady: a broad core inside a soft halo, no spikes. See the note
  // in the file header on why planets and stars are drawn with different point
  // spreads.
  //
  // The falloff has to be gentle relative to the sprite. A tight Gaussian
  // confines everything visible to the inner third, so a 5px point renders as a
  // 1.5px speck and the size computed from magnitude never reaches the screen —
  // the sprite is mostly transparent margin.
  float core = exp(-r2 * 2.4);
  float halo = exp(-r2 * 0.7) * 0.45;
  float a = core + halo;
  gl_FragColor = vec4(vColor * a, a);
}
`;

/**
 * Reference irradiance, in the same arbitrary units as
 * `albedo * flux * angular^2`. Defines the zero point of the magnitude scale
 * below; set from the brightest inner-system case.
 */
const REF = 2.0e-6;

/**
 * The magnitude window that maps onto visible brightness. Anything brighter
 * than BRIGHT is drawn at full strength, anything fainter than FAINT sits on
 * the floor, and the range between is linear in magnitude — which is linear in
 * perceived brightness, that being the entire reason the scale exists.
 *
 * A power curve was tried first and could not do this: one system spans about
 * nine orders of magnitude in irradiance, and no exponent gentle enough to lift
 * the outer worlds off the floor left the inner ones distinguishable. Eight of
 * ten bodies clamped to the same value and the luminosity ordering — the one
 * thing this pass exists to show — was lost.
 */
const MAG_BRIGHT = 1.0;
const MAG_FAINT = 28.0;

/**
 * The faint end, decided rather than inherited.
 *
 * Left at its first value this clamp did the work for eight of ten bodies, so
 * the outer system collapsed into one indistinguishable dim value and the view
 * read as a two-planet system. Strictly that is correct photometry — a world at
 * 75 AU really is that faint — but it is the wrong answer for a frame whose job
 * is to show that a system has worlds in it.
 *
 * The resolution is the one the realm already applies to illumination: a real
 * camera exposes for its subject. The subject here is the system, so the floor
 * sits where the faintest planet still records as a planet. Every world in the
 * frame registers; the magnitude scale above still orders them, so the inner
 * giants remain visibly brighter. What is given up is a couple of stops of
 * contrast at the bright end, which no viewer can miss, in exchange for eight
 * bodies that were previously indistinguishable from each other.
 */
const MAG_FLOOR = 0.30;

/**
 * Peak emitted level for the brightest body.
 *
 * Set so the FAINTEST planet still outshines the brightest background star, not
 * so the population merely overlaps the star field's range. Matching the two
 * ranges was the earlier mistake and it had the sky backwards: seen from inside
 * a planetary system the planets are the brightest points in it after the star
 * itself — Venus reaches magnitude -4.9 and Jupiter -2.9 against Sirius at -1.5,
 * a difference of more than twenty in flux. Drawing a world at 40 AU dimmer than
 * an arbitrary background star is not conservative, it is wrong, and it is why
 * eight of the ten here were indistinguishable from the field around them.
 *
 * The sky field peaks near 4.0 with a 5.8px sprite, so the floor lands about
 * there and the inner giants sit well above it.
 */
const AMP = 12.0;

/** Below this projected diameter (px) a body is drawn only as a point. */
export const RESOLVE_LO = 2.5;
/** Above this projected diameter (px) the mesh carries it alone. */
export const RESOLVE_HI = 7.0;

export class DistantBodies {
  constructor(count) {
    this.count = count;
    this._pos = new Float32Array(count * 3);
    this._col = new Float32Array(count * 3);
    this._siz = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._siz, 1));
    // Positions are rewritten every frame in compressed space, so a fixed
    // generous bound is cheaper and safer than recomputing one.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Test but do not write, exactly as the sky field does: a point behind
      // the star or behind a nearer world has to be occluded by it.
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this._c = new THREE.Color();
  }

  get object3d() {
    return this.points;
  }

  /**
   * `planets` are the realm's planet wrappers, already positioned for this
   * frame. `radPerPx` converts angular size to projected pixels; `starColor`
   * tints the reflected light.
   */
  update(planets, radPerPx, starColor) {
    const n = Math.min(planets.length, this.count);
    for (let i = 0; i < n; i++) {
      const p = planets[i];
      const rec = p.record;
      const o = i * 3;

      // Projected diameter. Once a body is genuinely resolvable the mesh is the
      // truthful thing to look at, so the sprite fades out rather than sitting
      // on top of it as a permanent bloom.
      const px = (2 * p.angular) / radPerPx;
      const fade = 1 - clamp((px - RESOLVE_LO) / (RESOLVE_HI - RESOLVE_LO), 0, 1);

      if (fade <= 0.001) {
        this._siz[i] = 0;
        this._col[o] = this._col[o + 1] = this._col[o + 2] = 0;
        continue;
      }

      this._pos[o] = p.holder.position.x;
      this._pos[o + 1] = p.holder.position.y;
      this._pos[o + 2] = p.holder.position.z;

      const raw = (rec.albedo ?? 0.3) * rec.flux * p.angular * p.angular;
      // Apparent magnitude: each step of 1 is a factor of 2.512 in irradiance,
      // which is how a nine-order range fits in a span of about 23.
      const mag = -2.5 * Math.log10(Math.max(raw / REF, 1e-30));
      const b = clamp(1 - (mag - MAG_BRIGHT) / (MAG_FAINT - MAG_BRIGHT), MAG_FLOOR, 1);

      // Reflected light is the star's, coloured by what the surface returns.
      const base = rec.palette.base;
      this._c.setRGB(base[0], base[1], base[2]);
      // Normalise to unit luminance first. Hue belongs to the surface;
      // brightness belongs to the magnitude above, which has already accounted
      // for albedo. Skipping this dims a dark world twice over — once for being
      // far away and once for being dark — and the outer system disappears.
      const lum = Math.max(0.2126 * this._c.r + 0.7152 * this._c.g + 0.0722 * this._c.b, 1e-3);
      this._c.multiplyScalar(1 / lum);
      // Toward the star's colour, but not all the way: an ochre world and an ice
      // giant reading warm and cool respectively is a real cue, and it is what
      // separates a planet from the star field it sits in.
      this._c.lerp(starColor, 0.45);

      const amp = b * fade * AMP;
      this._col[o] = this._c.r * amp;
      this._col[o + 1] = this._c.g * amp;
      this._col[o + 2] = this._c.b * amp;
      // Floor size sits above the sky field's median star too, so a planet is
      // the larger mark as well as the brighter one.
      this._siz[i] = 2.6 + 4.2 * b;
    }

    for (let i = n; i < this.count; i++) this._siz[i] = 0;

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
