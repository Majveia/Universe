/**
 * A star system you fly through.
 *
 * The hard problem at this scale is not what to draw, it is arithmetic. A
 * system spans from a 1.6e4 m neutron star to a 3.6e13 m outer orbit — nine
 * orders of magnitude — and float32 has seven digits. Two things make it work:
 *
 *  FLOATING ORIGIN. The camera never moves. It sits at the world origin and
 *  only rotates; the entire system is translated by -viewPos each frame. That
 *  keeps every coordinate the GPU sees small and centred on the viewer, so
 *  precision is spent where the detail is instead of on the distance from an
 *  arbitrary zero. Star and PlanetBody both assume this — their `sync()`
 *  methods derive the camera position by transforming the world origin into
 *  local space, which is only correct if the camera is at that origin.
 *
 *  LOGARITHMIC DISTANCE COMPRESSION. Even centred, the depth buffer cannot
 *  hold 1e13. So a body at true distance d is drawn at
 *
 *      d' = A · ln(1 + d/B)
 *
 *  and its radius is scaled by d'/d. Because position and size are compressed
 *  by exactly the same factor, the *angular* size of everything is preserved
 *  perfectly — the image is geometrically correct. What changes is only the
 *  depth ordering metric, and ln is monotonic, so ordering survives. The
 *  parallax you get from moving is real; only the ruler is bent.
 *
 * Orbits are Keplerian, solved from the Catalog's real periods and
 * eccentricities, so the inner planets genuinely do lap the outer ones.
 */

import * as THREE from 'three';
import { Realm } from '../core/Director.js';
import { Star } from './Star.js';
import { PlanetBody } from './PlanetBody.js';
import { Rings } from './Rings.js';
import { AsteroidBelt } from './AsteroidBelt.js';
import { DistantBodies, RESOLVE_LO } from './DistantBodies.js';
import { makeStar, makeSystem, orbitalPosition, AU } from '../universe/Catalog.js';
import { settings } from '../core/Settings.js';
import { clamp, damp } from '../core/Noise.js';
import { Rng } from '../core/Rng.js';

/** Compression constants, in metres. B sets where compression starts to bite. */
const COMP_A = 900;
const COMP_B = 2.2e7;

function compress(d) {
  return COMP_A * Math.log(1 + d / COMP_B);
}

export class SystemRealm extends Realm {
  constructor(ctx) {
    super(ctx);
    this.near = 0.02;
    this.far = 2.2e4;
    this.ambience = 'system';

    /** Camera position in true system coordinates (metres). */
    this.viewPos = new THREE.Vector3();
    this.viewVel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.simTime = 0;
    // Slow enough that a close orbit is a visible drift rather than a blur,
    // fast enough that the outer system is not frozen.
    this.timeScale = 60 * 60 * 10; // ~10 hours of orbit per real second
    this.planets = [];
    this.belts = [];
    this.distant = null;
    this.followTarget = null;
    this.followOffset = null;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._orbit = { x: 0, y: 0, z: 0 };
    this._light = {
      dirWorld: new THREE.Vector3(),
      color: new THREE.Color(1, 1, 1),
      intensity: 1,
      angularRadius: 0.01,
    };
  }

  async build() {
    this.scene.background = null;
    // A faint field of distant stars so the system never sits in a void. These
    // are far enough that no parallax is meaningful, so they ride with the
    // camera and are drawn first with depth writes off.
    this._buildSkyStars();
    return this;
  }

  _buildSkyStars() {
    const rng = new Rng(9161);
    const n = Math.min(60000, settings.starCount);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const c = new THREE.Color();
    // The sky is not isotropic and a uniform scatter is the one thing that
    // guarantees it reads as wallpaper. We sit inside a disc galaxy, so looking
    // along the plane stacks thousands of light-years of stars into a band and
    // looking out of it hits the halo almost immediately. Two thirds of the
    // field is therefore drawn concentrated toward a galactic plane, with a
    // sech-squared profile in galactic latitude — the same vertical profile the
    // Catalog uses for stellar density — while the rest stays isotropic to give
    // the foreground halo population.
    //
    // A tilted plane, not the ecliptic: the two are unrelated in reality, and
    // aligning them would make the band sit exactly along the orbit furniture.
    const gN = new THREE.Vector3(0.31, 0.87, -0.38).normalize();
    const gU = new THREE.Vector3();
    const gV = new THREE.Vector3();
    if (Math.abs(gN.y) < 0.9) gU.set(0, 1, 0).cross(gN).normalize();
    else gU.set(1, 0, 0).cross(gN).normalize();
    gV.copy(gN).cross(gU).normalize();
    const tmp = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      let d;
      const inDisc = rng.next() < 0.55;
      if (inDisc) {
        // sech^2 in height above the plane, sampled by inverting tanh. The
        // scale height wants to be generous: too tight and the band stops being
        // a diffuse glow and becomes a stripe of confetti with a hard edge,
        // which is a different artefact from the uniform scatter it replaced but
        // no more convincing.
        const scaleH = 0.14;
        const u = rng.range(-0.999, 0.999);
        const h = scaleH * Math.atanh(u);
        const phi = rng.range(0, Math.PI * 2);
        d = tmp.copy(gU).multiplyScalar(Math.cos(phi))
          .addScaledVector(gV, Math.sin(phi))
          .addScaledVector(gN, h)
          .normalize()
          .clone();
      } else {
        d = rng.onSphere();
      }

      const r = 1.6e4;
      pos[i * 3] = d.x * r;
      pos[i * 3 + 1] = d.y * r;
      pos[i * 3 + 2] = d.z * r;

      // Dust lanes. The band is not a clean stripe — it is bisected by the Great
      // Rift and mottled by foreground clouds, and that patchiness is most of
      // what makes it read as a real galaxy rather than an airbrushed streak.
      // Extinguished stars keep their position and are drawn at zero size; the
      // slot cannot simply be skipped or it would leave a star sitting at the
      // origin, which is where the camera is.
      if (inDisc) {
        const lane = Math.sin(Math.atan2(d.z, d.x) * 3.1 + 1.7) * 0.5 + 0.5;
        const near = 1 - Math.min(1, Math.abs(gN.dot(d)) / 0.06);
        if (near > 0 && rng.next() < near * lane * 0.72) {
          siz[i] = 0;
          continue;
        }
      }
      // Magnitude distribution: a very few bright, overwhelmingly faint. Stars
      // in the band are pushed fainter still — what the eye reads as the Milky
      // Way is not a line of resolvable stars but the unresolved light of very
      // many of them, so the band has to be built from a dense population of
      // sub-pixel dots that sum rather than from brighter individual points.
      const m = Math.pow(rng.next(), inDisc ? 5.0 : 3.1);
      siz[i] = 0.6 + m * 5.2;
      const t = 2600 + Math.pow(rng.next(), 2.4) * 24000;
      const k = t / 100;
      let r0, g0, b0;
      if (k <= 66) {
        r0 = 1;
        g0 = clamp(0.39008 * Math.log(k) - 0.63184, 0, 1);
        b0 = k <= 19 ? 0 : clamp(0.54321 * Math.log(k - 10) - 1.19625, 0, 1);
      } else {
        r0 = clamp(1.29294 * Math.pow(k - 60, -0.1332), 0, 1);
        g0 = clamp(1.12989 * Math.pow(k - 60, -0.07551), 0, 1);
        b0 = 1;
      }
      c.setRGB(r0 * r0, g0 * g0, b0 * b0);
      const bright = 0.25 + m * 2.6;
      col[i * 3] = c.r * bright;
      col[i * 3 + 1] = c.g * bright;
      col[i * 3 + 2] = c.b * bright;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2e4);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 900 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        varying vec3 vColor;
        uniform float uViewportH;
        void main(){
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uViewportH / 900.0;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        void main(){
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          // A tight core with a faint cross: the diffraction spikes a real
          // aperture produces are most of why a bright star reads as a star
          // and not as a dot.
          float core = exp(-r2 * 7.0);
          float spike = exp(-abs(uv.x) * 9.0) * exp(-abs(uv.y) * 1.2)
                      + exp(-abs(uv.y) * 9.0) * exp(-abs(uv.x) * 1.2);
          float a = core + spike * 0.12;
          gl_FragColor = vec4(vColor * a * 1.4, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Test but do not write: the field sits behind everything, and anything
      // solid in front of it must occlude it. With the test off, stars shine
      // straight through planets, which is the single most immersion-breaking
      // artefact available at this scale.
      depthWrite: false,
      depthTest: true,
    });
    this.skyStars = new THREE.Points(geo, this.skyMat);
    this.skyStars.frustumCulled = false;
    this.skyStars.renderOrder = -10;
    this.scene.add(this.skyStars);
  }

  enter(params = {}) {
    this._teardownSystem();
    this.releaseFocus();

    const seed = params.seed ?? 0x51a4;
    this.starRecord = makeStar(seed);
    this.system = makeSystem(this.starRecord);

    this.star = new Star(this.starRecord, { exposure: 1 });
    this.starHolder = new THREE.Group();
    this.starHolder.add(this.star.object3d);
    this.scene.add(this.starHolder);

    for (const rec of this.system.planets) {
      // Only the nearest few worlds get clouds and a full atmosphere shell;
      // the rest are simple until you approach them.
      const body = new PlanetBody(rec, { simple: false });
      const holder = new THREE.Group();
      holder.add(body.object3d);
      this.scene.add(holder);

      // Rings hang off the planet's tilted frame, not its spinning surface,
      // so they inherit axial tilt and stay in the equatorial plane.
      let rings = null;
      if (rec.hasRings) {
        rings = new Rings(rec);
        body.group.add(rings.object3d);
      }

      this.planets.push({
        record: rec,
        body,
        rings,
        holder,
        truePos: new THREE.Vector3(),
        renderDist: 0,
        angular: 0,
      });
    }

    // The point-spread pass for everything the meshes are too small to carry.
    this.distant = new DistantBodies(this.planets.length);
    this.scene.add(this.distant.object3d);

    // Belts do their own floating-origin and compression in the vertex shader,
    // so they are added to the scene root rather than to a holder.
    this.belts = [];
    for (const b of this.system.belts) {
      const belt = new AsteroidBelt(b, this.starRecord.mass, {
        compA: COMP_A, compB: COMP_B,
      });
      this.scene.add(belt.object3d);
      this.belts.push(belt);
    }

    this._buildOrbitLines();

    // Open on a three-quarter view of the innermost interesting world, far
    // enough out that the star is in frame. Establishing shot, not a cockpit.
    const target = this.planets[Math.min(1, this.planets.length - 1)];
    const a = target ? target.record.orbitRadius : 1.2 * AU;
    this.viewPos.set(a * 0.55, a * 0.22, a * 0.95);
    this.viewVel.set(0, 0, 0);
    const look = this._tmp.set(0, 0, 0).sub(this.viewPos).normalize();
    this.yaw = Math.atan2(-look.x, -look.z);
    this.pitch = Math.asin(clamp(look.y, -1, 1));
    this.simTime = 0;
  }

  /**
   * Orbit furniture, drawn as screen-space ribbons rather than hardware lines.
   *
   * `THREE.Line` rasterises a one-pixel line with no coverage information, so
   * every orbit that runs near-horizontal across the frame stair-steps visibly,
   * and `lineWidth` above 1 does nothing on virtually every WebGL driver. A
   * two-triangle-wide strip, offset perpendicular to the segment *in screen
   * space*, gives a line of controllable pixel width whose alpha can fall off
   * across that width — which is the antialiasing.
   */
  _buildOrbitLines() {
    // Rebuilt every frame in `_updateOrbitLines` because compression depends on
    // where the camera is.
    const segs = 192;
    this.orbitLines = [];
    for (const p of this.planets) {
      const n = segs + 1;
      // Two vertices per sample, one either side of the centreline.
      const pos = new Float32Array(n * 2 * 3);
      const nxt = new Float32Array(n * 2 * 3);
      const side = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        side[i * 2] = -1;
        side[i * 2 + 1] = 1;
      }
      const idx = new Uint32Array(segs * 6);
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx[i * 6] = a; idx[i * 6 + 1] = a + 1; idx[i * 6 + 2] = a + 2;
        idx[i * 6 + 3] = a + 1; idx[i * 6 + 4] = a + 3; idx[i * 6 + 5] = a + 2;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aNext', new THREE.BufferAttribute(nxt, 3));
      geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(...p.record.palette.atmo).multiplyScalar(0.5) },
          uOpacity: { value: 0.16 },
          uWidthPx: { value: 1.6 },
          uHalfRes: { value: new THREE.Vector2(720, 405) },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aNext;
          attribute float aSide;
          uniform float uWidthPx;
          uniform vec2 uHalfRes;
          varying float vSide;
          void main(){
            vSide = aSide;
            vec4 cA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            vec4 cB = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);

            // Drop any segment with an endpoint at or behind the eye. The
            // offset below is divided back through w, so a w near zero turns a
            // 1.6px ribbon into a wedge across the whole frame — which is
            // exactly what happens on a close approach, where the orbit
            // ellipse passes the camera. A hardware line clipped at the near
            // plane is still one pixel wide; a screen-space ribbon is not, and
            // has to be culled instead.
            if (cA.w <= 1e-4 || cB.w <= 1e-4){
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }

            // Segment direction measured in pixels, so the width below is in
            // pixels too and does not change with distance or aspect.
            vec2 sA = (cA.xy / cA.w) * uHalfRes;
            vec2 sB = (cB.xy / cB.w) * uHalfRes;
            vec2 d = sB - sA;
            float len = length(d);
            d = len > 1e-6 ? d / len : vec2(1.0, 0.0);
            vec2 nrm = vec2(-d.y, d.x);
            vec2 offNdc = (nrm * uWidthPx * 0.5 * aSide) / uHalfRes;
            gl_Position = vec4(cA.xy + offNdc * cA.w, cA.zw);
          }`,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform vec3 uColor;
          uniform float uOpacity;
          varying float vSide;
          void main(){
            // Coverage across the ribbon's width. This is the whole point of
            // the strip: a hardware line has no such value, so its edges can
            // only ever be hard.
            float a = 1.0 - vSide * vSide;
            gl_FragColor = vec4(uColor, a * a * uOpacity);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const line = new THREE.Mesh(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = -1;
      this.scene.add(line);

      // The orbit plane's normal is fixed, so take it once. Used below to tell
      // a legible ellipse from one collapsed edge-on.
      const a0 = { x: 0, y: 0, z: 0 }, a1 = { x: 0, y: 0, z: 0 }, a2 = { x: 0, y: 0, z: 0 };
      orbitalPosition(p.record, 0, a0);
      orbitalPosition(p.record, p.record.period / 3, a1);
      orbitalPosition(p.record, (2 * p.record.period) / 3, a2);
      const v1 = new THREE.Vector3(a1.x - a0.x, a1.y - a0.y, a1.z - a0.z);
      const v2 = new THREE.Vector3(a2.x - a0.x, a2.y - a0.y, a2.z - a0.z);
      const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();

      this.orbitLines.push({ line, geo, mat, segs, planet: p, normal });
    }
  }

  _updateOrbitLines(halfFovV) {
    const distToCentre = Math.max(this.viewPos.length(), 1);
    const W = Math.max(this.ctx.engine?.width || 1440, 1);
    const H = Math.max(this.ctx.engine?.height || 810, 1);

    for (const o of this.orbitLines) {
      const rec = o.planet.record;
      const pos = o.geo.attributes.position.array;
      const nxt = o.geo.attributes.aNext.array;
      const period = rec.period;
      const n = o.segs + 1;

      // Sample the ellipse once, then write each point into both of its
      // vertices and into the previous sample's `aNext`.
      for (let i = 0; i < n; i++) {
        const t = (i / o.segs) * period;
        orbitalPosition(rec, t, this._orbit);
        const v = this._tmp.set(this._orbit.x, this._orbit.y, this._orbit.z).sub(this.viewPos);
        const d = v.length();
        const s = d > 1 ? compress(d) / d : 0;
        const x = v.x * s, y = v.y * s, z = v.z * s;
        const a = i * 6;
        pos[a] = x; pos[a + 1] = y; pos[a + 2] = z;
        pos[a + 3] = x; pos[a + 4] = y; pos[a + 5] = z;
        if (i > 0) {
          const b = (i - 1) * 6;
          nxt[b] = x; nxt[b + 1] = y; nxt[b + 2] = z;
          nxt[b + 3] = x; nxt[b + 4] = y; nxt[b + 5] = z;
        }
      }
      // The loop closes, so the last sample's neighbour is the first.
      const last = (n - 1) * 6;
      for (let k = 0; k < 6; k++) nxt[last + k] = pos[k % 3];
      o.geo.attributes.position.needsUpdate = true;
      o.geo.attributes.aNext.needsUpdate = true;

      o.mat.uniforms.uHalfRes.value.set(W / 2, H / 2);

      // Orbit lines are navigational furniture: useful when you are far enough
      // to be choosing a destination, clutter once you have arrived.
      const near = o.planet.renderDist;
      let opacity = 0.20 * clamp((near - 40) / 400, 0, 1);

      // And useful only while you can still see the shape. An orbit whose
      // angular radius exceeds the field of view no longer reads as an ellipse
      // — it is a line crossing the frame, carrying no information about where
      // anything is. Six of those stacked near-parallel across the top of the
      // frame is what made this furniture dominate rather than inform, so they
      // fade out once they stop fitting.
      const angR = Math.atan(rec.orbitRadius / distToCentre);
      opacity *= 1 - clamp((angR / (halfFovV * 1.25) - 1) / 0.8, 0, 1);

      o.mat.uniforms.uOpacity.value = opacity;
      o.line.visible = opacity > 0.005;
    }
  }

  /**
   * Frame a planet and ride with it.
   *
   * Following matters more than it sounds. An inner world can complete an
   * orbit in a few seconds of wall time at the default time rate, so a camera
   * parked at an inertial point watches its subject sail out of frame almost
   * immediately. Holding a *relative* offset is also what a real spacecraft in
   * formation does — it matches orbits rather than hovering in absolute space.
   *
   * Releasing the follow (any thrust input) converts the offset back into a
   * free-flying position without a jump, so taking manual control never
   * teleports you.
   */
  focus(index, framing = 'gibbous') {
    const p = this.planets[index];
    if (!p) return;
    const r = p.record.radius;
    // `outward` runs from the star to the planet, so the lit hemisphere faces
    // -outward and the night face +outward.
    const outward = this._tmp.copy(p.truePos).normalize();
    const side = new THREE.Vector3().copy(outward).cross(new THREE.Vector3(0, 1, 0)).normalize();
    this.followTarget = p;

    if (framing === 'crescent') {
      // Mostly anti-sunward, so the star is behind the planet and only a thin
      // rind of the disc is lit. The sideways term is what stops it being a
      // pure eclipse: at dead-on anti-sunward the crescent closes to nothing.
      // This is the framing that puts the atmospheric limb — the graded band
      // that runs orange at the terminator and blue at altitude — across the
      // whole silhouette, which is the entire subject of the shot.
      this.followOffset = new THREE.Vector3()
        .copy(outward).multiplyScalar(r * 2.6)
        .addScaledVector(side, r * 1.7)
        .add(this._tmp2.set(0, r * 0.45, 0));
    } else {
      // Three-quarter view from slightly above the orbital plane: enough of the
      // terminator in frame to read the atmosphere, enough of the lit face to
      // read the surface. Mostly sunward gives a gibbous disc, and a large
      // sideways component keeps the terminator in shot — that is where all the
      // atmospheric scattering lives, the limb glow and the sunset band — while
      // leaving the star itself visible off to one side.
      this.followOffset = new THREE.Vector3()
        .copy(outward).multiplyScalar(-r * 1.7)
        .addScaledVector(side, r * 3.0)
        .add(this._tmp2.set(0, r * 0.85, 0));
    }

    this.viewVel.set(0, 0, 0);
    this.aimAtFollowTarget();
  }

  /**
   * Point the camera at whatever it is following, from wherever `followOffset`
   * currently puts it.
   *
   * This is split out because position and aim have to be derived together.
   * Anything that moves the camera by writing `followOffset` directly and
   * leaves yaw/pitch alone flies to the new vantage still looking along the old
   * one — which, for offsets on opposite sides of the body, points at empty sky
   * and drops the subject out of frame entirely.
   */
  aimAtFollowTarget() {
    if (!this.followTarget || !this.followOffset) return;
    this.viewPos.copy(this.followTarget.truePos).add(this.followOffset);
    const look = this._tmp.copy(this.followTarget.truePos).sub(this.viewPos).normalize();
    this.yaw = Math.atan2(-look.x, -look.z);
    this.pitch = Math.asin(clamp(look.y, -1, 1));
  }

  releaseFocus() {
    this.followTarget = null;
    this.followOffset = null;
  }

  update(dt, time) {
    const { input, camera } = this.ctx;

    // --- time -----------------------------------------------------------
    const warp = input.down('timeWarp') ? 240 : 1;
    this.simTime += dt * this.timeScale * warp;

    // --- look -----------------------------------------------------------
    const engaged = input.pointerLocked || input.down('primary') || input.usingTouch;
    if (engaged) {
      this.yaw -= input.look.x;
      this.pitch = clamp(this.pitch - input.look.y, -1.5, 1.5);
    }
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    // --- flight ---------------------------------------------------------
    // Thrust is scaled by how far the nearest body is, so the same stick
    // deflection is a gentle nudge next to a moon and a hard burn in deep
    // space. Without this you either crawl across the system or overshoot
    // every planet by a hundred radii.
    const nearest = this._nearestDistance();
    const scaleRef = clamp(nearest, 4e6, 6e12);
    const boost = input.down('boost') ? 26 : 1;
    const thrust = scaleRef * 0.85 * boost;

    const fwd = this._tmp.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = this._tmp2.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.viewVel.addScaledVector(fwd, input.move.y * thrust * dt);
    this.viewVel.addScaledVector(right, input.move.x * thrust * dt);
    if (input.down('jump')) this.viewVel.y += thrust * dt;
    if (input.down('crouch')) this.viewVel.y -= thrust * dt;

    // Inertial damping. Real vacuum has none, but a spacecraft with RCS does,
    // and without it the camera is unflyable.
    const damping = input.down('sprint') ? 0.15 : 1.8;
    this.viewVel.multiplyScalar(Math.exp(-damping * dt));

    // Any deliberate thrust hands control back to the pilot.
    if (this.followTarget && (input.move.x || input.move.y || input.down('jump') || input.down('crouch'))) {
      this.releaseFocus();
    }
    if (this.followTarget) {
      this.viewPos.copy(this.followTarget.truePos).add(this.followOffset);
    } else {
      this.viewPos.addScaledVector(this.viewVel, dt);
    }

    // Solve the followed body's orbit before the camera reads it, or the view
    // lags one frame behind its subject and the planet visibly jitters.
    if (this.followTarget) {
      orbitalPosition(this.followTarget.record, this.simTime, this._orbit);
      this.followTarget.truePos.set(this._orbit.x, this._orbit.y, this._orbit.z);
      this.viewPos.copy(this.followTarget.truePos).add(this.followOffset);
    }

    // --- place bodies ---------------------------------------------------
    // Star and PlanetBody both build unit-radius geometry, so a holder's scale
    // has to carry the body's physical radius as well as the compression
    // factor. Radius x (compressed/true) is exactly the scale at which
    // apparent angular size equals radius/trueDistance — i.e. the real thing.
    // Radians of vertical field per pixel — the conversion that turns an
    // angular size into "how big will this actually be on screen", which is the
    // only sensible basis for deciding whether to draw geometry at all.
    const halfFovV = ((camera.fov * Math.PI) / 180) / 2;
    const radPerPx = ((camera.fov * Math.PI) / 180) / Math.max(this.ctx.engine?.height || 900, 1);

    const sv = this._tmp.set(0, 0, 0).sub(this.viewPos);
    const sd = Math.max(sv.length(), 1);
    const sComp = compress(sd) / sd;
    this.starHolder.position.copy(sv).multiplyScalar(sComp);
    this.starHolder.scale.setScalar(this.star.renderRadius * sComp);
    this.star.update(dt, time);

    for (const p of this.planets) {
      orbitalPosition(p.record, this.simTime, this._orbit);
      p.truePos.set(this._orbit.x, this._orbit.y, this._orbit.z);
      const v = this._tmp.copy(p.truePos).sub(this.viewPos);
      const d = Math.max(v.length(), 1);
      const comp = compress(d) / d;
      p.renderDist = compress(d);
      p.holder.position.copy(v).multiplyScalar(comp);
      p.holder.scale.setScalar(p.record.radius * comp);
      p.body.update(dt, time);

      // Because compression preserves angular size exactly, this is just
      // radius / true distance — the same number an observer would measure.
      p.angular = p.record.radius / d;

      // Hand a body over to the sprite pass as soon as its mesh stops being
      // worth rasterising. The old threshold of 1.5e-4 rad is about a fifth of
      // a pixel at this field of view, which kept sub-pixel spheres in the draw
      // list where they contributed nothing but still cost a terrain shader —
      // and, worse, made "visible" mean something that could not be seen.
      p.holder.visible = (2 * p.angular) / radPerPx > RESOLVE_LO - 0.5;
    }

    // Everything below the resolution limit is drawn as its point spread
    // instead. Without this the system view has a star, orbit furniture, and
    // nothing else — ten worlds in frame and not one of them visible.
    this.distant?.update(this.planets, radPerPx, this.star.lightColor);

    this.scene.updateMatrixWorld(true);

    // --- lighting -------------------------------------------------------
    this._light.color.copy(this.star.lightColor);
    this.star.sync();
    for (const p of this.planets) {
      if (!p.holder.visible) continue;
      // Direction from the planet toward the star, in world (compressed) space.
      this._light.dirWorld.copy(this.starHolder.position).sub(p.holder.position).normalize();
      // Illumination follows the inverse-square law, but the raw ratio spans
      // four orders of magnitude across a single system and a world at 0.02
      // flux renders as pure black. A real camera would simply expose for its
      // subject, so the falloff is compressed with a power curve: the ordering
      // survives — inner worlds are still visibly harsher, outer worlds still
      // dim and blue — without anything falling off the bottom of the display.
      this._light.intensity = clamp(Math.pow(p.record.flux, 0.35), 0.34, 2.6);
      this._light.angularRadius = Math.atan(this.starRecord.radius / Math.max(p.record.orbitRadius, 1));
      p.body.sync(this._light);
      if (p.rings) p.rings.sync(this._light);
    }

    // Belts are lit from the star's direction at the belt, which for a body
    // that far out is close enough to the star's own bearing from the camera.
    this._light.dirWorld.copy(this.starHolder.position).normalize();
    this._light.intensity = 1.1;
    for (const belt of this.belts) {
      belt.update(this.simTime, this.viewPos, this._light);
    }

    this._updateOrbitLines(halfFovV);

    // Sky stars ride with the camera — no parallax is meaningful at parsecs.
    this.skyStars.position.set(0, 0, 0);
    camera.position.set(0, 0, 0);
  }

  _nearestDistance() {
    let best = this.viewPos.length();
    for (const p of this.planets) {
      const d = this._tmp2.copy(p.truePos).sub(this.viewPos).length() - p.record.radius;
      if (d < best) best = d;
    }
    return Math.max(best, 1e3);
  }

  _teardownSystem() {
    for (const p of this.planets) {
      p.rings?.dispose();
      p.body.dispose();
      this.scene.remove(p.holder);
    }
    this.planets.length = 0;
    if (this.distant) {
      this.distant.dispose();
      this.scene.remove(this.distant.object3d);
      this.distant = null;
    }
    for (const b of this.belts || []) {
      b.dispose();
      this.scene.remove(b.object3d);
    }
    this.belts = [];
    for (const o of this.orbitLines || []) {
      o.geo.dispose();
      o.mat.dispose();
      this.scene.remove(o.line);
    }
    this.orbitLines = [];
    if (this.star) {
      this.star.dispose();
      this.scene.remove(this.starHolder);
      this.star = null;
    }
  }

  dispose() {
    this._teardownSystem();
    this.skyStars.geometry.dispose();
    this.skyMat.dispose();
  }
}
