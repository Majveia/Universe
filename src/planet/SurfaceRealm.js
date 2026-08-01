/**
 * Standing on it.
 *
 * This realm is the join between two halves of the project that were built to
 * meet and never introduced. On one side, `TerrainGen.js` grows a planet out of
 * plate tectonics, orogeny and hydraulic erosion, and `terrain.worker.js` can
 * turn any patch of it into a mesh. On the other, `player/` implements a
 * character motor that asks its world for exactly five things — documented in
 * `player/__flatWorld.js` and reproduced here:
 *
 *     sampleHeight(x, z) -> number
 *     sampleNormal(x, z) -> THREE.Vector3
 *     gravity            -> m/s^2
 *     up(worldPos)       -> THREE.Vector3
 *     sunDirection       -> THREE.Vector3
 *
 * So that contract is what this file implements, plus the optional
 * `surfaceAt(x, z)` the motor feature-detects for footstep material and
 * friction. Everything else here — sky, sun, haze — exists because ground with
 * nothing above it does not read as a place.
 *
 * The frame of reference is the important decision. Rather than moving a player
 * around a globe in planet coordinates, where float32 gives up at about a metre
 * of precision on an Earth-sized body, the realm picks a landing site and builds
 * a `LocalFrame` there: a tangent plane whose origin is the site, with `x` east
 * and `z` south, curving away with real planetary curvature. Everything inside
 * the realm — camera, terrain nodes, the player — lives in that frame, where
 * coordinates stay in the tens of kilometres and precision is never in doubt.
 * Walking far enough to matter is a re-frame, which is a problem this file does
 * not have yet and is noted at the bottom.
 */

import * as THREE from 'three';
import { Realm } from '../core/Director.js';
import { TerrainField, LocalFrame, findLandingSite } from './TerrainGen.js';
import { biomeProfile } from './Biomes.js';
import { QuadSphere } from './QuadSphere.js';
import { makeStar, makeSystem } from '../universe/Catalog.js';
import { settings } from '../core/Settings.js';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Gravity from mass and radius, so a small world genuinely feels small. */
function surfaceGravity(planet) {
  // Records carry radius in metres; where a mass is absent, assume the body has
  // roughly Earth's density rather than inventing a gravity outright.
  const R = planet.radius;
  const rho = planet.density ?? 5514;
  const G = 6.674e-11;
  return Math.min(40, (4 / 3) * Math.PI * G * rho * R);
}

export class SurfaceRealm extends Realm {
  constructor(ctx) {
    super(ctx);
    // Near plane at 0.1 m so a body's own feet do not clip; far plane past the
    // root patch so the horizon is terrain rather than a fog wall.
    this.near = 0.1;
    this.far = 400000;
    this.ambience = 'surface';
    this.field = null;
    this.terrain = null;
    this.player = null;
    this.planet = null;
    this._t = 0;
  }

  async build() {
    this.sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
    this.scene.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0x88a6c8, 0x3a3128, 0.35));
    this._buildSky();
    return this;
  }

  /**
   * `params` selects the world: `{ record }` for a planet already resolved by
   * the system realm, or `{ seed, index }` to look one up. Entering with
   * neither is a programming error rather than something to paper over, so it
   * throws instead of quietly generating a different planet than the one the
   * player was looking at.
   */
  async enter(params = {}) {
    const record = params.record ?? this._lookup(params);
    if (!record) throw new Error('SurfaceRealm.enter needs a planet record or a seed/index');

    // Re-entering the same world keeps the terrain that is already generated;
    // walking back to a place should not regenerate it.
    if (this.planet && record.id === this.planet.id && this.terrain) {
      this._placeCamera();
      return;
    }

    await this._buildWorld(record);
    this._placeCamera();
  }

  _lookup(params) {
    if (params.seed == null) return null;
    const sys = makeSystem(makeStar(params.seed));
    const planets = sys?.planets || [];
    if (!planets.length) return null;
    // Without an explicit index, land on something you could stand on rather
    // than on the first body in the list, which is as likely to be a gas giant.
    const i = params.index ?? planets.findIndex((p) => !p.isGiant);
    return planets[i >= 0 ? i : 0];
  }

  async _buildWorld(record) {
    if (this.terrain) { this.terrain.dispose(); this.scene.remove(this.terrain.object3d); }

    this.planet = record;

    // The field has to exist before a landing site can be chosen, and the frame
    // has to exist before the field can answer a local query — so the field is
    // built frameless, asked where to land, and then told.
    const field = new TerrainField(record);
    const poleHint = record.poleHint ?? [0, 1, 0];
    const site = findLandingSite(field, record.seed ?? 1, poleHint);
    const dir = site && site.length === 3 ? site : (site?.dir ?? [0, 1, 0]);

    field.frame = new LocalFrame(record.radius, dir, poleHint);
    field.setPole(poleHint[0], poleHint[1], poleHint[2]);
    field.profile = biomeProfile(record);
    this.field = field;
    this.profile = field.profile;

    this.gravity = surfaceGravity(record);

    // Sun direction, in the LOCAL frame — which is the space the terrain, the
    // camera and the player all live in, so no basis change belongs here.
    //
    // The first version of this built the vector from the frame's east/up/north
    // basis, which converts a local direction into PLANET coordinates. It
    // type-checks, it normalises, and it points somewhere unrelated to the sky
    // above the landing site: the ground came back unlit because the sun was
    // effectively below the horizon in the only space that mattered. Same class
    // of error as the view-space/object-space mix in the standing failure list.
    //
    // Elevation is a stated choice rather than a simulation. Real time-of-day
    // needs the planet's rotation and its position in its orbit, which this
    // realm does not own yet; 34 degrees is late-afternoon light, which rakes
    // the terrain and shows relief instead of flattening it the way noon does.
    const elev = 34 * Math.PI / 180;
    const azim = (record.seed ?? 1) % 360 * Math.PI / 180;
    this.sunDirection = new THREE.Vector3(
      Math.cos(elev) * Math.cos(azim),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(azim),
    ).normalize();

    const tier = settings.tier ?? 2;
    this.terrain = new QuadSphere(field, {
      extent: tier >= 3 ? 200000 : 120000,
      leafSize: tier >= 3 ? 32 : 48,
      split: tier >= 3 ? 2.6 : 2.2,
    });
    await this.terrain.init();
    this.scene.add(this.terrain.object3d);
    this._applyLighting();

    // Prime the tree around the landing site before the first frame, so the
    // transition covers generation instead of dropping the player through a
    // hole in the ground.
    const h = field.localHeight(0, 0);
    _v.set(0, h + 1.7, 0);
    for (let i = 0; i < 8 && !this.terrain.settled; i++) {
      this.terrain.update(_v);
      await new Promise((r) => setTimeout(r, 16));
    }
  }

  _applyLighting() {
    const u = this.terrain.material.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uUpLocal.value.set(0, 1, 0);
    this.sun.position.copy(this.sunDirection).multiplyScalar(1000);

    // Sun level, anchored to the tonemapper rather than picked by eye.
    //
    // AgX places 0.18 linear at mid grey. A rock with albedo near 0.2 lit at
    // this elevation returns about 0.13 of whatever the sun uniform is, so a
    // uniform of 1.0 lands the whole landscape at a third of mid grey — which
    // is what the first capture measured: median 30/255 against a max of 83,
    // three stops under a daylit scene. SUN_LEVEL puts a sunlit slope near mid
    // grey and leaves headroom for the highlights.
    //
    // It is not scaled by the star's actual irradiance, and deliberately so.
    // Flux across the catalogue spans orders of magnitude, and a camera on the
    // ground would expose for whatever it was standing in — brightness here is
    // an exposure decision, not a physical one. What the star does change is
    // colour, which is not something exposure compensates away.
    const SUN_LEVEL = 3.0;
    const t = this.planet.starTemperature ?? 5778;
    // Crude blackbody tint: cool stars redden, hot ones go blue-white.
    const warm = Math.min(1.6, 5778 / Math.max(t, 2200));
    u.uSunColor.value.setRGB(
      SUN_LEVEL * Math.min(1.15, 0.86 + warm * 0.22),
      SUN_LEVEL * 0.95,
      SUN_LEVEL * Math.min(1.1, 1.28 - warm * 0.30),
    );

    // An atmosphere is what makes a sky, and worlds without one get a black one
    // with hard shadows. Scaling the ambient and the haze off the same number
    // keeps those two from disagreeing about whether there is any air.
    const atm = Math.min(1.4, this.planet.atmosphere ?? 0);
    const sky = new THREE.Color().setHSL(0.58, 0.45 * Math.min(1, atm), 0.06 + 0.30 * Math.min(1, atm));
    // Sky ambient scales with how much air there is to scatter it. On an
    // airless world this collapses toward black and shadows go correctly hard.
    u.uSkyColor.value.copy(sky).multiplyScalar(0.55 + 0.9 * Math.min(1, atm));
    u.uGroundColor.value.set(0.09, 0.075, 0.062);
    u.uFogColor.value.copy(sky);
    // Visibility collapses fast as air thickens: ~120 km on a thin world, ~25 km
    // in something like Earth's atmosphere.
    u.uFogDensity.value = 1 / (120000 / (1 + atm * 4));
    u.uSnowFactor.value = this.planet.hasWater ? 1 : 0.25;

    this.skyMat.uniforms.uSunDir.value.copy(this.sunDirection);
    this.skyMat.uniforms.uSky.value.copy(sky);
    this.skyMat.uniforms.uAtm.value = atm;
    this.scene.fog = null;   // the terrain shader does its own, in local space
  }

  _buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSky: { value: new THREE.Color(0.2, 0.32, 0.5) },
        uAtm: { value: 1 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          // Translation is dropped so the dome is nailed to the camera and
          // cannot be walked out of.
          mat4 v = viewMatrix; v[3].xyz = vec3(0.0);
          gl_Position = projectionMatrix * v * vec4(position, 1.0);
          gl_Position.z = gl_Position.w;   // park it on the far plane
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSunDir;
        uniform vec3 uSky;
        uniform float uAtm;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float up = clamp(d.y, -1.0, 1.0);
          // Rayleigh-ish: thickest air along the horizon, so the zenith is
          // darkest and the limb warms. With uAtm at zero this collapses to
          // black and the stars behind it carry the sky, which is correct for
          // an airless body.
          float air = pow(1.0 - max(up, 0.0), 3.0);
          vec3 col = mix(uSky * 0.35, uSky, air) * uAtm;
          // Forward scattering around the sun, and a horizon glow that survives
          // when the sun is below it.
          float mu = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSky * pow(mu, 8.0) * 0.6 * uAtm;
          col += vec3(1.0, 0.72, 0.42) * pow(mu, 40.0) * uAtm * 0.8;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  _placeCamera() {
    const cam = this.ctx.camera;
    const h = this.field.localHeight(0, 0);
    cam.position.set(0, h + 1.7, 0);
    cam.lookAt(30, h + 1.7, -60);
  }

  // --- the world contract -----------------------------------------------------
  //
  // These five members are what `player/` requires. They are deliberately thin
  // wrappers over the field: the motor and the mesh must be reading the same
  // function, and the moment this file starts approximating is the moment the
  // player starts hovering.

  sampleHeight(x, z) {
    return this.field ? this.field.localHeight(x, z) : 0;
  }

  sampleNormal(x, z) {
    if (!this.field) return _n.set(0, 1, 0);
    // Central differences at a quarter-metre. Small enough to keep a kerb sharp,
    // large enough that the highest terrain octave does not turn the normal into
    // sparkle — the same frequency-ceiling argument as the planet shader.
    const e = 0.25;
    const hx = this.field.localHeight(x + e, z) - this.field.localHeight(x - e, z);
    const hz = this.field.localHeight(x, z + e) - this.field.localHeight(x, z - e);
    return _n.set(-hx, 2 * e, -hz).normalize();
  }

  up(pos) {
    if (!this.field) return _up;
    // Radial, with the planet centre one radius below the frame origin. At the
    // landing site this is (0,1,0) exactly and it tilts away as you walk, which
    // is what stops a long traverse from feeling like a treadmill.
    const R = this.field.radius;
    return _n.set(pos.x, pos.y + R, pos.z).normalize();
  }

  surfaceAt(x, z) {
    if (!this.profile) return null;
    const h = this.sampleHeight(x, z);
    const nrm = this.sampleNormal(x, z);
    const slope = 1 - nrm.y;
    const out = [0, 0, 0, 0];
    const f = this.field.frame;
    const d = f.directionAt(x, z, [0, 0, 0]);
    const moisture = this.field.moistureAt(d[0], d[1], d[2], h);
    const flow = this.field.flowAt(d[0], d[1], d[2]);
    const absLat = Math.abs(f.latitude);
    const temp = this.profile.temperatureAt(absLat, h, this._t);
    this.profile.classify(out, h, slope, absLat, moisture, temp, flow,
      this.planet.hasWater ? 1 : 0.25);
    return this.profile.surfaceFor(out[0], out[1], out[2], out[3], h);
  }

  update(dt) {
    if (!this.terrain) return;
    this._t += dt;
    const cam = this.ctx.camera;
    if (this.player) this.player.update(dt);
    this.terrain.update(cam.position);
  }

  exit() {
    // Terrain is kept: coming back to a world you have already walked should
    // not pay for it twice.
  }

  dispose() {
    if (this.terrain) this.terrain.dispose();
    this.sky?.geometry.dispose();
    this.skyMat?.dispose();
    this.terrain = null;
  }
}

// TODO — re-framing. The tangent plane is exact near the site and drifts as you
// walk: at 200 km the gnomonic mapping is off by roughly 2 km of arc. Nothing
// can walk that far yet, but a vehicle will, and the fix is to rebuild the frame
// and translate everything in it once the player passes some fraction of the
// root extent. Noted here rather than half-built.
