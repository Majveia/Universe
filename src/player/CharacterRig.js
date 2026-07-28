/**
 * A human being, generated and animated from nothing but numbers.
 *
 * There is no model file and there is no animation data. The silhouette is
 * lathed from profile curves at construction; the motion is solved every frame
 * from the state of the motor. That constraint is not an aesthetic pose — it is
 * what lets the character exist on a planet that was itself generated a second
 * ago, at whatever gravity that planet turned out to have, with a gait that
 * responds to a slope the level designer never saw.
 *
 * What makes procedural character motion read as alive, in the order the eye
 * notices it going wrong:
 *
 *   Feet must not slide. A planted foot is nailed to a *world* position for the
 *   whole stance phase and the body travels past it. Every rig that drives feet
 *   from a sine wave skates, and once you have seen it you cannot unsee it. Here
 *   the stance foot is captured in world space at the moment of contact and
 *   converted back into rig space each frame, so it stays exactly where it was
 *   put no matter what the body does afterwards.
 *
 *   Feet must find the ground. The plant point is sampled against the actual
 *   heightfield, so on a slope one leg straightens and the other folds — the
 *   single strongest cue that a character is standing *on* terrain rather than
 *   near it. Two-bone IK does the rest.
 *
 *   The spine must fight the legs. A walk is a controlled fall that the torso
 *   spends its whole time cancelling: hips rotate one way, shoulders the other,
 *   and the head stays pointed where you are looking. Take the counter-rotation
 *   out and the character reads as a mannequin on a conveyor.
 *
 *   Timing comes from distance, never from the clock. The stride phase arrives
 *   from the motor, where it is integrated from distance travelled. Walk into a
 *   wall and the legs stop, because the distance stops.
 *
 * The state machine is deliberately not a state machine in the animation sense.
 * There are no clips to blend, so "run" is not a thing you play — it is a set of
 * continuous parameters (stride amplitude, torso pitch, arm swing, knee lift)
 * that are all functions of speed, and the transition between walk and run is
 * the transition of those numbers. The only genuinely discrete events are
 * contact, launch, and land, and each of those pokes a spring rather than
 * starting a clip.
 */

import * as THREE from 'three';
import { clamp, saturate, damp, lerp, smoothstep, smootherstep } from '../core/Noise.js';
import { Rng } from '../core/Rng.js';

const DEG = Math.PI / 180;

/** Body proportions, in metres, for a 1.8 m suit. Scaled by `opts.height`. */
const PROPORTIONS = {
  hipHeight: 0.92,
  spineLower: 0.17,
  spineUpper: 0.22,
  neck: 0.085,
  headRadius: 0.115,
  shoulderWidth: 0.205,
  hipWidth: 0.108,
  upperArm: 0.30,
  foreArm: 0.27,
  thigh: 0.44,
  shin: 0.42,
  footLength: 0.27,
  footHeight: 0.075,
};

/**
 * Gait constants. These are the numbers that were actually tuned by watching,
 * not derived — the comments record what each one is buying.
 */
const GAIT = {
  // Fraction of the cycle a foot spends on the ground. Human walking is about
  // 0.62 (both feet down briefly); running drops below 0.5 and gains a flight
  // phase. Interpolating between them by speed is what turns a walk into a run.
  dutyWalk: 0.64,
  dutyRun: 0.36,
  // Peak swing height. A walk barely clears the ground; a run picks the knee up.
  stepClearWalk: 0.085,
  stepClearRun: 0.30,
  // How far ahead of the body the foot is placed, as a fraction of stride.
  reachAhead: 0.46,
  // Vertical travel of the hips per step. Small — a big bob reads as a limp.
  hipBob: 0.028,
  hipSway: 0.030,
  hipRoll: 3.6 * DEG,
  hipYaw: 5.0 * DEG,
  chestYaw: 7.5 * DEG,      // opposes the hips, and is larger: shoulders lead
  chestPitchRun: 11 * DEG,  // lean into a sprint
  armSwingWalk: 22 * DEG,
  armSwingRun: 58 * DEG,
  elbowBase: 12 * DEG,
  elbowRun: 78 * DEG,
};

// --- scratch -----------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _hint = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _wp = new THREE.Vector3();
const _wn = new THREE.Vector3();
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * Tapered capsule as a lathe profile. Bones hang from their joint: the origin is
 * the top of the bone and it extends down local -Y, which makes every aim
 * operation "point local -Y at the child joint" and removes a whole class of
 * off-by-a-quarter-turn bugs.
 */
function boneGeometry(rTop, rBot, len, segments = 10) {
  const pts = [];
  const capB = 4;
  const capT = 3;
  for (let i = 0; i <= capB; i++) {
    const ang = -Math.PI / 2 + (i / capB) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rBot * Math.cos(ang), -len + rBot * Math.sin(ang)));
  }
  // Two intermediate rings give the taper somewhere to happen; without them the
  // silhouette is a cylinder with domes and reads as a robot.
  pts.push(new THREE.Vector2(lerp(rBot, rTop, 0.42), -len * 0.62));
  pts.push(new THREE.Vector2(lerp(rBot, rTop, 0.78), -len * 0.28));
  for (let i = 0; i <= capT; i++) {
    const ang = (i / capT) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rTop * Math.cos(ang), rTop * Math.sin(ang)));
  }
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return g;
}

/** Torso: a lathe with a waist, then squashed on Z so it has a front and a back. */
function torsoGeometry(height, chestR, waistR, hipR, segments = 14) {
  const pts = [];
  const rings = [
    [0.0, hipR * 0.72],
    [0.08, hipR],
    [0.26, waistR],
    [0.48, lerp(waistR, chestR, 0.72)],
    [0.72, chestR],
    [0.88, chestR * 0.9],
    [0.97, chestR * 0.6],
    [1.0, chestR * 0.24],
  ];
  pts.push(new THREE.Vector2(0.001, 0));
  for (const [t, r] of rings) pts.push(new THREE.Vector2(r, t * height));
  pts.push(new THREE.Vector2(0.001, height));
  const g = new THREE.LatheGeometry(pts, segments);
  // Humans are elliptical in cross-section. 0.68 depth is the difference between
  // a person and a bollard.
  g.scale(1, 1, 0.68);
  g.computeVertexNormals();
  return g;
}

/** Two-bone IK. Returns the knee/elbow position; writes nothing else. */
function solveTwoBone(hip, target, l1, l2, poleHint, outJoint) {
  _d.subVectors(target, hip);
  let dist = _d.length();
  const reach = (l1 + l2) * 0.998;
  if (dist > reach) {
    _d.multiplyScalar(reach / dist);
    dist = reach;
  }
  if (dist < 1e-4) {
    _d.set(0, -1e-4, 0);
    dist = 1e-4;
  }
  _dir.copy(_d).multiplyScalar(1 / dist);

  // Cosine rule for the angle between the first bone and the hip-to-target line.
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const ang = Math.acos(cosA);

  // The pole decides which way the joint bends. Projected perpendicular to the
  // chain so a near-straight leg does not flip its knee when the hint drifts.
  _pole.copy(poleHint).addScaledVector(_dir, -poleHint.dot(_dir));
  if (_pole.lengthSq() < 1e-8) {
    _pole.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  _pole.normalize();

  outJoint
    .copy(hip)
    .addScaledVector(_dir, Math.cos(ang) * l1)
    .addScaledVector(_pole, Math.sin(ang) * l1);
  return outJoint;
}

/**
 * Point a bone's local -Y from `from` to `to`, with `twistHint` fixing the roll
 * so knees and elbows keep a consistent axis instead of spinning as the limb
 * passes through vertical.
 */
function aimBone(node, from, to, twistHint) {
  _up.subVectors(from, to);
  const len = _up.length();
  if (len < 1e-6) return;
  _up.multiplyScalar(1 / len);
  _hint.copy(twistHint).addScaledVector(_up, -twistHint.dot(_up));
  if (_hint.lengthSq() < 1e-8) {
    _hint.set(0, 0, 1).addScaledVector(_up, -_up.z);
    if (_hint.lengthSq() < 1e-8) _hint.set(1, 0, 0);
  }
  _hint.normalize();
  _rt.crossVectors(_up, _hint).normalize();
  _fw.crossVectors(_rt, _up);
  _mat.makeBasis(_rt, _up, _fw);
  node.quaternion.setFromRotationMatrix(_mat);
  node.position.copy(from);
}

/** Deterministic suit palette. Every explorer looks like they were issued kit. */
function suitPalette(rng) {
  const hue = rng.next();
  const base = new THREE.Color().setHSL(hue, rng.range(0.05, 0.16), rng.range(0.62, 0.82));
  const panel = new THREE.Color().setHSL((hue + rng.range(-0.04, 0.04) + 1) % 1, rng.range(0.02, 0.09), rng.range(0.18, 0.3));
  const accent = new THREE.Color().setHSL((hue + rng.range(0.34, 0.62)) % 1, rng.range(0.6, 0.92), rng.range(0.45, 0.6));
  const visor = new THREE.Color().setHSL((hue + rng.range(0.4, 0.66)) % 1, rng.range(0.55, 0.85), rng.range(0.42, 0.58));
  return { base, panel, accent, visor };
}

export class CharacterRig {
  constructor(opts = {}) {
    this.rng = new Rng(opts.seed ?? 0xc0ffee);
    this.height = opts.height ?? 1.8;
    this.scale = this.height / 1.8;
    this.quality = opts.quality ?? 1;

    const P = {};
    for (const k in PROPORTIONS) P[k] = PROPORTIONS[k] * this.scale;
    this.P = P;
    this.palette = opts.palette || suitPalette(this.rng);

    this.group = new THREE.Group();
    this.group.name = 'character';

    /** Rig-local root. Everything below is expressed in this frame. */
    this.root = new THREE.Group();
    this.group.add(this.root);

    this.visible = true;
    this.firstPerson = false;

    // --- animation state ------------------------------------------------------
    this.yaw = 0;                 // body facing, radians about local up
    this._bodyYaw = 0;            // smoothed, lags the aim
    this.lean = 0;
    this.leanSide = 0;
    this.crouchBlend = 0;
    this.slideBlend = 0;
    this.airBlend = 0;
    this.speedBlend = 0;          // 0 idle .. 1 sprint
    this.landSpring = 0;
    this.landSpringV = 0;
    this.breath = 0;
    this.stridePhase = 0;
    this._prevPhase = 0;

    /** Per-foot planting state, all in world space so nothing skates. */
    this.feet = [makeFoot(), makeFoot()];
    // Feet carry their own lateral sign so the placement code can offset them
    // without having to know which array slot it is looking at. Left is -1 to
    // match `legs[0]`, so foot i and leg i are always the same limb.
    this.feet[0].side = -1;
    this.feet[1].side = 1;
    /** Fired the tick a foot makes contact: (index, worldPos, worldNormal, speed). */
    this.onFootPlant = null;

    this._meshes = [];
    this._materials = [];
    this._build();
  }

  // ---------------------------------------------------------------------------
  // Construction.
  // ---------------------------------------------------------------------------

  _build() {
    const P = this.P;
    const pal = this.palette;
    const seg = this.quality > 0.6 ? 12 : 8;

    const suit = new THREE.MeshStandardMaterial({
      color: pal.base, roughness: 0.68, metalness: 0.04,
    });
    const panel = new THREE.MeshStandardMaterial({
      color: pal.panel, roughness: 0.4, metalness: 0.55,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: pal.accent, roughness: 0.35, metalness: 0.2,
      emissive: pal.accent, emissiveIntensity: 0.25,
    });
    const joint = new THREE.MeshStandardMaterial({
      color: 0x24262b, roughness: 0.85, metalness: 0.1,
    });
    // The visor is the face. It is written far above 1.0 so the bloom chain
    // picks it out — a lit visor in a dark canyon is the single most valuable
    // silhouette cue a spacesuit has.
    const visor = new THREE.MeshStandardMaterial({
      color: 0x05080d, roughness: 0.06, metalness: 1.0,
      emissive: pal.visor, emissiveIntensity: 1.65,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0b1018, roughness: 0.03, metalness: 1.0,
      transparent: true, opacity: 0.55,
    });
    this._materials.push(suit, panel, accent, joint, visor, glass);
    this.visorMaterial = visor;
    this.accentMaterial = accent;

    // --- torso chain ----------------------------------------------------------
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = P.hipHeight;
    this.root.add(this.pelvis);

    const pelvisMesh = new THREE.Mesh(
      torsoGeometry(P.spineLower, P.hipWidth * 1.5, P.hipWidth * 1.42, P.hipWidth * 1.62, seg),
      panel
    );
    pelvisMesh.position.y = -P.spineLower * 0.5;
    this._add(pelvisMesh);
    this.pelvis.add(pelvisMesh);

    this.spine = new THREE.Group();
    this.spine.position.y = P.spineLower * 0.5;
    this.pelvis.add(this.spine);

    this.chest = new THREE.Group();
    this.chest.position.y = P.spineLower * 0.5;
    this.spine.add(this.chest);

    const chestMesh = new THREE.Mesh(
      torsoGeometry(P.spineUpper + P.spineLower * 0.6, P.shoulderWidth * 0.84, P.hipWidth * 1.24, P.hipWidth * 1.44, seg),
      suit
    );
    chestMesh.position.y = -P.spineLower * 0.55;
    this._add(chestMesh);
    this.chest.add(chestMesh);
    this.chestMesh = chestMesh;

    // Chest plate: a flattened box across the front. Reads at silhouette range
    // as "equipment" without costing a texture.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(P.shoulderWidth * 1.08, P.spineUpper * 0.78, P.hipWidth * 0.5),
      panel
    );
    plate.position.set(0, P.spineUpper * 0.32, P.hipWidth * 0.72);
    this._add(plate);
    this.chest.add(plate);

    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(P.shoulderWidth * 0.2, P.spineUpper * 0.5, P.hipWidth * 0.08),
      accent
    );
    stripe.position.set(P.shoulderWidth * 0.36, P.spineUpper * 0.34, P.hipWidth * 0.95);
    this._add(stripe);
    this.chest.add(stripe);

    // --- head -----------------------------------------------------------------
    this.neck = new THREE.Group();
    this.neck.position.y = P.spineUpper + P.spineLower * 0.05;
    this.chest.add(this.neck);

    this.head = new THREE.Group();
    this.head.position.y = P.neck;
    this.neck.add(this.head);

    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(P.headRadius * 1.28, seg + 6, seg + 4),
      suit
    );
    helmet.scale.set(1, 1.06, 1.08);
    helmet.position.y = P.headRadius * 0.72;
    this._add(helmet);
    this.head.add(helmet);
    this.helmet = helmet;

    // Visor: a spherical cap carved out of the front of the helmet, slightly
    // proud of it so it never z-fights.
    const visorGeo = new THREE.SphereGeometry(
      P.headRadius * 1.3, seg + 8, seg + 4,
      -Math.PI * 0.42, Math.PI * 0.84,
      Math.PI * 0.22, Math.PI * 0.5
    );
    visorGeo.rotateY(Math.PI * 0.5);
    const visorMesh = new THREE.Mesh(visorGeo, visor);
    visorMesh.scale.set(1, 1.06, 1.1);
    visorMesh.position.y = P.headRadius * 0.72;
    this._add(visorMesh);
    this.head.add(visorMesh);
    this.visorMesh = visorMesh;

    const glassMesh = new THREE.Mesh(visorGeo, glass);
    glassMesh.scale.set(1.02, 1.08, 1.12);
    glassMesh.position.y = P.headRadius * 0.72;
    this.head.add(glassMesh);

    // A crown lamp. The flashlight system drives its intensity; here it is just
    // a shape that makes the helmet read as directional.
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(P.headRadius * 0.24, P.headRadius * 0.3, P.headRadius * 0.2, 8),
      panel
    );
    lamp.rotation.x = Math.PI * 0.5;
    lamp.position.set(0, P.headRadius * 1.62, P.headRadius * 0.55);
    this._add(lamp);
    this.head.add(lamp);
    this.lampNode = lamp;

    /** Where a first-person camera would sit if it lived in the skull. */
    this.eyeAnchor = new THREE.Object3D();
    this.eyeAnchor.position.set(0, P.headRadius * 0.86, P.headRadius * 0.6);
    this.head.add(this.eyeAnchor);

    // --- backpack -------------------------------------------------------------
    this.backpack = new THREE.Group();
    this.backpack.position.set(0, P.spineUpper * 0.25, -P.hipWidth * 1.15);
    this.chest.add(this.backpack);
    const packMesh = new THREE.Mesh(
      new THREE.BoxGeometry(P.shoulderWidth * 1.02, P.spineUpper * 1.35, P.hipWidth * 0.78),
      panel
    );
    this._add(packMesh);
    this.backpack.add(packMesh);
    const tankGeo = new THREE.CapsuleGeometry(P.hipWidth * 0.32, P.spineUpper * 0.85, 4, 8);
    for (const sx of [-1, 1]) {
      const tank = new THREE.Mesh(tankGeo, suit);
      tank.position.set(sx * P.shoulderWidth * 0.36, 0, -P.hipWidth * 0.52);
      this._add(tank);
      this.backpack.add(tank);
    }
    /** Node the jetpack hangs its nozzles from. */
    this.jetpackMount = new THREE.Object3D();
    this.jetpackMount.position.set(0, -P.spineUpper * 0.6, -P.hipWidth * 0.3);
    this.backpack.add(this.jetpackMount);

    // --- arms (FK, nested) ----------------------------------------------------
    this.arms = [];
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * P.shoulderWidth, P.spineUpper * 0.62, 0);
      this.chest.add(shoulder);

      const pad = new THREE.Mesh(new THREE.SphereGeometry(P.hipWidth * 0.52, seg, seg - 2), panel);
      pad.scale.set(1, 0.85, 1);
      this._add(pad);
      shoulder.add(pad);

      const upper = new THREE.Group();
      shoulder.add(upper);
      const upperMesh = new THREE.Mesh(boneGeometry(P.hipWidth * 0.42, P.hipWidth * 0.33, P.upperArm, seg), suit);
      this._add(upperMesh);
      upper.add(upperMesh);

      const fore = new THREE.Group();
      fore.position.y = -P.upperArm;
      upper.add(fore);
      const foreMesh = new THREE.Mesh(boneGeometry(P.hipWidth * 0.33, P.hipWidth * 0.27, P.foreArm, seg), suit);
      this._add(foreMesh);
      fore.add(foreMesh);
      const cuff = new THREE.Mesh(
        new THREE.CylinderGeometry(P.hipWidth * 0.34, P.hipWidth * 0.34, P.hipWidth * 0.18, seg),
        accent
      );
      cuff.position.y = -P.foreArm * 0.82;
      this._add(cuff);
      fore.add(cuff);

      const hand = new THREE.Group();
      hand.position.y = -P.foreArm;
      fore.add(hand);
      const handMesh = new THREE.Mesh(
        new THREE.BoxGeometry(P.hipWidth * 0.5, P.hipWidth * 0.62, P.hipWidth * 0.28),
        joint
      );
      handMesh.position.y = -P.hipWidth * 0.28;
      this._add(handMesh);
      hand.add(handMesh);

      this.arms.push({ shoulder, upper, fore, hand, side: sx });
    }

    // --- legs (IK, flat under root) -------------------------------------------
    this.legs = [];
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const thigh = new THREE.Group();
      this.root.add(thigh);
      const thighMesh = new THREE.Mesh(boneGeometry(P.hipWidth * 0.56, P.hipWidth * 0.42, P.thigh, seg), suit);
      this._add(thighMesh);
      thigh.add(thighMesh);

      const shin = new THREE.Group();
      this.root.add(shin);
      const shinMesh = new THREE.Mesh(boneGeometry(P.hipWidth * 0.42, P.hipWidth * 0.3, P.shin, seg), suit);
      this._add(shinMesh);
      shin.add(shinMesh);
      const kneePad = new THREE.Mesh(new THREE.SphereGeometry(P.hipWidth * 0.44, seg, seg - 2), panel);
      kneePad.position.z = P.hipWidth * 0.16;
      this._add(kneePad);
      shin.add(kneePad);

      const foot = new THREE.Group();
      this.root.add(foot);
      const bootGeo = new THREE.BoxGeometry(P.hipWidth * 0.78, P.footHeight, P.footLength);
      const boot = new THREE.Mesh(bootGeo, panel);
      boot.position.set(0, -P.footHeight * 0.5, P.footLength * 0.16);
      this._add(boot);
      foot.add(boot);
      const toe = new THREE.Mesh(
        new THREE.CylinderGeometry(P.footHeight * 0.55, P.footHeight * 0.55, P.hipWidth * 0.78, 8),
        joint
      );
      toe.rotation.z = Math.PI * 0.5;
      toe.position.set(0, -P.footHeight * 0.5, P.footLength * 0.56);
      this._add(toe);
      foot.add(toe);

      this.legs.push({ thigh, shin, foot, side: sx });
    }

    for (const m of this._meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  }

  _add(mesh) {
    this._meshes.push(mesh);
    return mesh;
  }

  // ---------------------------------------------------------------------------
  // Visibility.
  // ---------------------------------------------------------------------------

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  /**
   * In first person the camera lives inside the skull, so the head has to go —
   * but only the head. Keeping the body means looking down shows you your own
   * chest and boots, which is worth far more than it costs.
   */
  setFirstPerson(fp) {
    if (this.firstPerson === fp) return;
    this.firstPerson = fp;
    this.helmet.visible = !fp;
    this.visorMesh.visible = !fp;
    this.head.children.forEach((c) => {
      if (c !== this.eyeAnchor) c.visible = !fp;
    });
  }

  // ---------------------------------------------------------------------------
  // The frame.
  // ---------------------------------------------------------------------------

  /**
   * @param {number} dt render dt (this is presentation; it may vary)
   * @param {object} s {
   *   position: Vector3 (feet, world), up: Vector3, aimYaw, aimPitch,
   *   velocity: Vector3, world, locomotion, jetting: boolean
   * }
   */
  update(dt, s) {
    const P = this.P;
    const loco = s.locomotion;
    const up = s.up || Y_UP;

    // --- place and orient the rig root ---------------------------------------
    // The root's +Y is the planet's up and its -Z is where the body faces, so
    // every local computation below is in a comfortable Y-up frame even though
    // the world underneath is a sphere.
    this.group.position.copy(s.position);
    this._orientRoot(dt, up, s.aimYaw, s.velocity, loco);

    // --- continuous parameters -----------------------------------------------
    const speed = loco ? loco.tangentSpeed : 0;
    const walk = loco ? loco.p.walkSpeed : 4.2;
    const run = loco ? loco.p.runSpeed : 7.6;
    // Two separate blends: gait (walk vs run shape) and effort (idle vs moving).
    const gait = saturate((speed - walk * 0.55) / Math.max(run - walk * 0.55, 0.1));
    this.speedBlend = damp(this.speedBlend, gait, 8, dt);
    const moving = saturate(speed / Math.max(walk * 0.5, 0.1));

    const grounded = loco ? loco.grounded : true;
    this.airBlend = damp(this.airBlend, grounded ? 0 : 1, grounded ? 16 : 9, dt);
    this.crouchBlend = damp(this.crouchBlend, loco && loco.crouching ? 1 : 0, 13, dt);
    this.slideBlend = damp(this.slideBlend, loco && loco.sliding ? 1 : 0, 15, dt);

    this.stridePhase = loco ? loco.stridePhase : 0;
    this.breath += dt * (0.9 + this.speedBlend * 2.4);

    // Landing spring. A critically damped second-order system rather than a
    // decay, because a knee that absorbs and returns is the whole read of weight.
    const k = 78;
    const c = 2 * Math.sqrt(k) * 0.72; // slightly under-damped: one soft rebound
    this.landSpringV += (-k * this.landSpring - c * this.landSpringV) * dt;
    this.landSpring += this.landSpringV * dt;

    // --- solve ----------------------------------------------------------------
    this._updateFeet(dt, s, up, speed, grounded);
    this._updateHips(dt, s, speed, moving);
    this._updateLegs(dt, s, up);
    this._updateArms(dt, s, speed, moving);
    this._updateHead(dt, s);
  }

  /** Poke the landing spring. Called by whoever owns the motor's `land` event. */
  land(impactSpeed) {
    // Normalised against a comfortable two-metre drop; harder landings fold the
    // knees further but the response saturates so a cliff does not fold you flat.
    const e = saturate(impactSpeed / 12);
    this.landSpringV -= 3.4 * (0.25 + e * e * 2.2);
  }

  /** Poke it the other way on launch, so a jump extends before it rises. */
  jump(impulse) {
    this.landSpringV += 1.2 * saturate(impulse / 6);
  }

  _orientRoot(dt, up, aimYaw, velocity, loco) {
    // Build a frame whose +Y is world up and whose yaw matches the aim. The
    // body yaw lags the aim: turning your head does not instantly turn your
    // hips, and the lag is what makes an over-the-shoulder camera look right.
    const speed = loco ? loco.tangentSpeed : 0;
    // At speed you face where you are going; standing still you face where you
    // look, but lazily. Both are the same damp with a different rate.
    const rate = lerp(6.5, 16, saturate(speed / 6));
    let target = aimYaw;
    let delta = target - this._bodyYaw;
    // Shortest way round, so crossing +-pi does not spin the character.
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this._bodyYaw += delta * (1 - Math.exp(-rate * dt));
    this.yaw = this._bodyYaw;

    // Orient the group: align local +Y to world up, then spin by body yaw.
    _q.setFromUnitVectors(Y_UP, _a.copy(up).normalize());
    _q2.setFromAxisAngle(Y_UP, this._bodyYaw);
    this.group.quaternion.copy(_q).multiply(_q2);

    // Turn rate feeds a lean, so a hard corner banks the body into it.
    const turn = clamp(delta / Math.max(dt, 1e-4), -6, 6);
    this.leanSide = damp(this.leanSide, clamp(-turn * 0.035, -0.28, 0.28) * saturate(speed / 4), 7, dt);
  }

  // --- feet ------------------------------------------------------------------

  /**
   * Foot placement, in world space.
   *
   * Each foot owns a phase offset half a cycle from the other. Within its own
   * phase it is either in stance — pinned to the world point where it landed —
   * or in swing, arcing from where it left the ground to where it is going to
   * land next. The landing point is predicted from the body's velocity and then
   * dropped onto the actual terrain, which is what makes a slope produce one
   * straight leg and one folded one for free.
   */
  _updateFeet(dt, s, up, speed, grounded) {
    const P = this.P;
    const loco = s.locomotion;
    const world = s.world;
    const stride = loco ? loco.strideLength : 1.3;
    const duty = lerp(GAIT.dutyWalk, GAIT.dutyRun, this.speedBlend);
    const clear = lerp(GAIT.stepClearWalk, GAIT.stepClearRun, this.speedBlend) * this.scale;

    // Body-relative axes in world space.
    _fw.set(0, 0, -1).applyQuaternion(this.group.quaternion);
    _rt.set(1, 0, 0).applyQuaternion(this.group.quaternion);

    // Where the body will be in half a stride. Placing the foot under the
    // *future* hip rather than the current one is what stops the legs trailing.
    const lead = speed * (stride / Math.max(speed, 0.35)) * GAIT.reachAhead;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const phase = ((this.stridePhase + (i === 0 ? 0.5 : 0)) % 1 + 1) % 1;
      const inStance = phase < duty;

      if (!grounded) {
        // Airborne: no contact, so the targets follow the body and the legs
        // adopt a tuck. Nothing is pinned, so nothing can skate on landing.
        f.contact = false;
        const vUp = s.velocity ? s.velocity.dot(up) : 0;
        const tuck = saturate(vUp / 4) * 0.5 - saturate(-vUp / 8) * 0.28;
        _a.copy(s.position)
          .addScaledVector(_rt, f.side * P.hipWidth * 1.1)
          .addScaledVector(up, P.footHeight + (0.34 + tuck * 0.3) * this.scale * (i === 0 ? 1 : 0.82))
          .addScaledVector(_fw, (i === 0 ? 0.14 : -0.1) * this.scale + tuck * 0.22);
        f.target.lerp(_a, 1 - Math.exp(-14 * dt));
        f.normal.lerp(up, 1 - Math.exp(-9 * dt));
        f.wasStance = false;
        continue;
      }

      if (inStance) {
        if (!f.wasStance) {
          // Contact. Commit the plant point that was predicted during swing.
          f.plant.copy(f.pending);
          f.plantNormal.copy(f.pendingNormal);
          f.contact = true;
          f.wasStance = true;
          if (this.onFootPlant) this.onFootPlant(i, f.plant, f.plantNormal, speed);
        }
        // Pinned. The body moves past the foot; the foot does not move.
        f.target.copy(f.plant);
        f.normal.copy(f.plantNormal);
        // Roll through the stance: heel down at the start, toe off at the end.
        f.roll = smoothstep(0.55, 1.0, phase / duty) * 0.55 - smoothstep(0.2, 0.0, phase / duty) * 0.3;
      } else {
        if (f.wasStance) {
          // Lift off. Predict where this foot is going and remember where it left.
          f.lift.copy(f.plant);
          f.wasStance = false;
          f.contact = false;
        }
        const t = (phase - duty) / Math.max(1 - duty, 0.05);

        // Re-predict every frame so a mid-swing direction change is honoured.
        _a.copy(s.position)
          .addScaledVector(_rt, f.side * P.hipWidth * 1.05)
          .addScaledVector(_fw, lead * (0.6 + t * 0.55));
        if (s.velocity) {
          const vUp = s.velocity.dot(up);
          _b.copy(s.velocity).addScaledVector(up, -vUp);
          _a.addScaledVector(_b, 0.09);
        }
        if (world) {
          const h = world.sampleHeight(_a.x, _a.z);
          // Move the predicted point onto the surface along the local up. On a
          // plane this is just "set y"; on a sphere it stays correct.
          _c.set(_a.x, h, _a.z);
          const gap = _d.subVectors(_a, _c).dot(up);
          _a.addScaledVector(up, -gap);
          const n = world.sampleNormal(_a.x, _a.z);
          f.pendingNormal.set(n.x, n.y, n.z).normalize();
        } else {
          f.pendingNormal.copy(up);
        }
        f.pending.copy(_a);

        // The swing arc. Ease-in-out horizontally so the foot accelerates out of
        // the ground and decelerates into it; a sine for the vertical, because
        // the foot has to leave and arrive at exactly zero height.
        const e = smootherstep(0, 1, t);
        _b.copy(f.lift).lerp(f.pending, e);
        // Terrain clearance mid-swing, plus a little extra when running.
        _b.addScaledVector(up, Math.sin(Math.PI * t) * clear);
        f.target.copy(_b);
        f.normal.lerp(f.pendingNormal, 1 - Math.exp(-11 * dt));
        // Toe up on the way through, flat at touchdown: the ankle does this and
        // it is very visible when it is missing.
        f.roll = -Math.sin(Math.PI * t) * 0.42 * (0.4 + this.speedBlend);
      }
    }
  }

  // --- hips ------------------------------------------------------------------

  _updateHips(dt, s, speed, moving) {
    const P = this.P;
    const loco = s.locomotion;
    const cyc = this.stridePhase * Math.PI * 2;

    // Vertical: two dips per cycle, one per stance, plus the landing spring and
    // the crouch. Amplitude tracks effort, not speed, so a slow careful walk is
    // nearly flat and a sprint pumps.
    const bob = -Math.abs(Math.cos(cyc)) * GAIT.hipBob * this.scale * moving * (0.5 + this.speedBlend);
    const crouchDrop = this.crouchBlend * P.hipHeight * 0.36 + this.slideBlend * P.hipHeight * 0.14;
    const landDrop = clamp(this.landSpring, -0.42, 0.16) * this.scale;

    this.pelvis.position.y = P.hipHeight + bob + landDrop - crouchDrop;
    // Lateral sway: once per cycle, toward the stance leg. This is the single
    // cue that separates a walk from a shuffle.
    this.pelvis.position.x = Math.sin(cyc) * GAIT.hipSway * this.scale * moving;
    this.pelvis.position.z = 0;

    // Hips counter-rotate against the shoulders. Real gait has the pelvis lead
    // the swing leg, so the yaw is in phase with the stride and the chest is
    // 180 out.
    const swing = Math.sin(cyc) * moving;
    _e.set(
      this.crouchBlend * 0.22 + this.slideBlend * 0.16,
      swing * GAIT.hipYaw * (0.6 + this.speedBlend),
      -Math.cos(cyc) * GAIT.hipRoll * moving + this.leanSide * 0.5
    );
    this.pelvis.quaternion.setFromEuler(_e);

    // Torso lean: forward with speed, extra in a slide, back a touch when
    // braking hard so deceleration reads on the body.
    const targetLean =
      this.speedBlend * GAIT.chestPitchRun +
      this.slideBlend * 26 * DEG +
      this.crouchBlend * 12 * DEG +
      this.airBlend * 6 * DEG;
    this.lean = damp(this.lean, targetLean, 7, dt);

    const chestSwing = -swing * GAIT.chestYaw * (0.5 + this.speedBlend);
    _e.set(this.lean * 0.55, chestSwing * 0.45, this.leanSide * 0.35);
    this.spine.quaternion.setFromEuler(_e);
    _e.set(this.lean * 0.45 - this.landSpring * 0.35, chestSwing * 0.55, this.leanSide * 0.4);
    this.chest.quaternion.setFromEuler(_e);

    // Breathing. Only readable when almost still, which is exactly when the
    // absence of any motion at all would be uncanny.
    const rest = 1 - saturate(moving * 1.6);
    const br = Math.sin(this.breath * 1.15) * rest;
    this.chestMesh.scale.set(1 + br * 0.016, 1 + br * 0.008, 1 + br * 0.028);
  }

  // --- legs ------------------------------------------------------------------

  _updateLegs(dt, s, up) {
    const P = this.P;
    // Hip joints in rig-local space: pelvis transform applied to the hip offset.
    this.pelvis.updateMatrix();

    // Knees point along the body's forward, biased outward slightly so the legs
    // do not scissor when the feet cross under the body.
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const f = this.feet[i];

      _a.set(leg.side * P.hipWidth, 0, 0).applyMatrix4(this.pelvis.matrix);

      // Foot target, converted from world into rig space. The world-space pin is
      // the whole trick: the conversion happens here, once, per foot, per frame.
      _b.copy(f.target);
      this.group.worldToLocal(_b);
      // Lift the ankle off the sole so the boot sits on the ground, not in it.
      _b.y += P.footHeight * 0.92;

      _hint.set(leg.side * 0.24, 0, 1).normalize();

      solveTwoBone(_a, _b, P.thigh, P.shin, _hint, _knee);
      aimBone(leg.thigh, _a, _knee, _hint);
      aimBone(leg.shin, _knee, _b, _hint);

      // Ankle: align the boot to the surface it is standing on, blended with the
      // swing roll. Converting the normal to rig space keeps this correct on a
      // sphere where "up" is not (0,1,0).
      _c.copy(f.normal);
      _c.transformDirection(_mat.copy(this.group.matrixWorld).invert());
      _c.normalize();
      leg.foot.position.copy(_b);
      _q.setFromUnitVectors(Y_UP, _c);
      _e.set(f.roll, 0, 0);
      _q2.setFromEuler(_e);
      leg.foot.quaternion.copy(_q).multiply(_q2);
      // The foot points where the body points, then gets rolled by the gait.
      _e.set(0, 0, 0);
    }
  }

  // --- arms ------------------------------------------------------------------

  _updateArms(dt, s, speed, moving) {
    const cyc = this.stridePhase * Math.PI * 2;
    const swingAmp = lerp(GAIT.armSwingWalk, GAIT.armSwingRun, this.speedBlend) * moving;
    const elbow = lerp(GAIT.elbowBase, GAIT.elbowRun, this.speedBlend * moving);

    const jet = s.jetting ? 1 : 0;
    this._jetBlend = damp(this._jetBlend ?? 0, jet, 9, dt);
    const air = this.airBlend;

    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      // Arms oppose legs: the left arm swings with the right leg. That is one
      // line of code and it is the difference between walking and marching.
      const ph = i === 0 ? cyc : cyc + Math.PI;
      const swing = Math.sin(ph);

      let pitch = swing * swingAmp;
      let roll = -arm.side * (0.11 + this.speedBlend * 0.1 + moving * 0.04);
      let bend = elbow * (0.55 + 0.45 * saturate(swing * 0.5 + 0.5));

      // In the air the arms come up and out for balance; under jetpack thrust
      // they drop and brace, which sells the pack as something being carried.
      if (air > 0.001) {
        pitch = lerp(pitch, -0.55 - saturate(-(s.velocity ? s.velocity.dot(s.up || Y_UP) : 0) / 12) * 0.5, air);
        roll = lerp(roll, -arm.side * 0.75, air);
        bend = lerp(bend, 0.9, air);
      }
      if (this._jetBlend > 0.001) {
        pitch = lerp(pitch, 0.35, this._jetBlend);
        roll = lerp(roll, -arm.side * 0.45, this._jetBlend);
        bend = lerp(bend, 0.35, this._jetBlend);
      }
      if (this.slideBlend > 0.001) {
        pitch = lerp(pitch, -0.9, this.slideBlend);
        bend = lerp(bend, 1.35, this.slideBlend);
      }
      // Crouch tucks the arms in rather than leaving them swinging in space.
      if (this.crouchBlend > 0.001) {
        pitch = lerp(pitch, pitch * 0.45 - 0.25, this.crouchBlend);
        bend = lerp(bend, bend + 0.5, this.crouchBlend);
      }

      _e.set(pitch, 0, roll);
      arm.upper.quaternion.setFromEuler(_e);
      _e.set(-bend, 0, 0);
      arm.fore.quaternion.setFromEuler(_e);
      // Shoulders shrug a little with the swing, which keeps the deltoid from
      // looking like it is hinged on a pin.
      _e.set(0, 0, -arm.side * swing * 0.06 * moving);
      arm.shoulder.quaternion.setFromEuler(_e);
    }
  }

  // --- head ------------------------------------------------------------------

  _updateHead(dt, s) {
    // The head holds the aim while the body catches up. Whatever yaw the body
    // has not yet taken up is absorbed here, clamped to a human neck, and the
    // remainder is quietly forgotten rather than snapping.
    let dy = (s.aimYaw ?? this._bodyYaw) - this._bodyYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const neckYaw = clamp(dy, -78 * DEG, 78 * DEG);
    const pitch = clamp(s.aimPitch ?? 0, -62 * DEG, 58 * DEG);

    // Split between neck and head: a real neck bends along its whole length.
    _e.set(-pitch * 0.35 - this.lean * 0.5, neckYaw * 0.42, 0);
    this.neck.quaternion.setFromEuler(_e);
    _e.set(-pitch * 0.65, neckYaw * 0.58, this.leanSide * 0.25);
    this.head.quaternion.setFromEuler(_e);

    // Head stabilisation: the eye counter-bobs against the hips, which is what
    // real vestibulo-ocular reflex does and why people do not see the world
    // bouncing when they run.
    this.neck.position.y = this.P.spineUpper + this.P.spineLower * 0.05 - this.pelvis.position.y * 0.05;
  }

  // ---------------------------------------------------------------------------

  /** World position of a foot's sole, for FX that need the exact contact point. */
  footWorld(i, out = new THREE.Vector3()) {
    return out.copy(this.feet[i].target);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const m of this._meshes) m.geometry.dispose();
    for (const m of this._materials) m.dispose();
    this._meshes.length = 0;
  }
}

function makeFoot() {
  return {
    side: 0,
    target: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    plant: new THREE.Vector3(),
    plantNormal: new THREE.Vector3(0, 1, 0),
    pending: new THREE.Vector3(),
    pendingNormal: new THREE.Vector3(0, 1, 0),
    lift: new THREE.Vector3(),
    contact: false,
    wasStance: false,
    roll: 0,
  };
}
