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
    for (let i = 0; i < n; i++) {
      const d = rng.onSphere();
      const r = 1.6e4;
      pos[i * 3] = d.x * r;
      pos[i * 3 + 1] = d.y * r;
      pos[i * 3 + 2] = d.z * r;
      // Magnitude distribution: a very few bright, overwhelmingly faint.
      const m = Math.pow(rng.next(), 3.1);
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
      });
    }

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

  _buildOrbitLines() {
    // Drawn in compressed space, rebuilt every frame in `_updateOrbitLines`
    // because compression depends on where the camera is.
    const segs = 192;
    this.orbitLines = [];
    for (const p of this.planets) {
      const pos = new Float32Array((segs + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(...p.record.palette.atmo).multiplyScalar(0.5),
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = -1;
      this.scene.add(line);
      this.orbitLines.push({ line, geo, mat, segs, planet: p });
    }
  }

  _updateOrbitLines() {
    for (const o of this.orbitLines) {
      const rec = o.planet.record;
      const arr = o.geo.attributes.position.array;
      const period = rec.period;
      for (let i = 0; i <= o.segs; i++) {
        const t = (i / o.segs) * period;
        orbitalPosition(rec, t, this._orbit);
        const v = this._tmp.set(this._orbit.x, this._orbit.y, this._orbit.z).sub(this.viewPos);
        const d = v.length();
        const s = d > 1 ? compress(d) / d : 0;
        arr[i * 3] = v.x * s;
        arr[i * 3 + 1] = v.y * s;
        arr[i * 3 + 2] = v.z * s;
      }
      o.geo.attributes.position.needsUpdate = true;
      // Orbit lines are navigational furniture: useful when you are far enough
      // to be choosing a destination, clutter once you have arrived.
      const near = o.planet.renderDist;
      o.mat.opacity = 0.20 * clamp((near - 40) / 400, 0, 1);
      o.line.visible = o.mat.opacity > 0.005;
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
  focus(index) {
    const p = this.planets[index];
    if (!p) return;
    const r = p.record.radius;
    // Three-quarter view from slightly above the orbital plane: enough of the
    // terminator in frame to read the atmosphere, enough of the lit face to
    // read the surface.
    // `outward` runs from the star to the planet, so the lit hemisphere faces
    // -outward. Sitting on the +outward side would frame the night face; the
    // camera belongs sunward of the planet. Mostly sunward gives a gibbous
    // disc, and a large sideways component keeps the terminator in shot —
    // that is where all the atmospheric scattering lives, the limb glow and
    // the sunset band — while leaving the star itself visible off to one side.
    const outward = this._tmp.copy(p.truePos).normalize();
    const side = new THREE.Vector3().copy(outward).cross(new THREE.Vector3(0, 1, 0)).normalize();
    this.followTarget = p;
    this.followOffset = new THREE.Vector3()
      .copy(outward).multiplyScalar(-r * 1.7)
      .addScaledVector(side, r * 3.0)
      .add(this._tmp2.set(0, r * 0.85, 0));
    this.viewPos.copy(p.truePos).add(this.followOffset);
    this.viewVel.set(0, 0, 0);
    const look = this._tmp.copy(p.truePos).sub(this.viewPos).normalize();
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

      // Cull below about a pixel of angular size. Because compression preserves
      // angular size exactly, this is just radius / true distance — the same
      // number an observer would measure.
      p.angular = p.record.radius / d;
      p.holder.visible = p.angular > 1.5e-4;
    }

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

    this._updateOrbitLines();

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
