/**
 * The post chain. This is where "renders correctly" becomes "looks like film".
 *
 * Pipeline (HDR throughout until the very last step):
 *   scene -> HDR half-float target
 *        -> bright-pass + progressive downsample/upsample bloom (energy conserving)
 *        -> composite: AgX tonemap, exposure, filmic grade, bloom, streaks
 *        -> lens: chromatic aberration, vignette, grain, blue-noise dither
 *        -> optional SMAA
 *
 * Two decisions worth naming:
 *  1. AgX rather than ACES. ACES clips hue on very bright saturated sources —
 *     star coronae and neon signage turn into flat magenta blobs. AgX rolls
 *     them toward white the way a real sensor does.
 *  2. Dither before quantisation. On an OLED, near-black gradients (nebula
 *     falloff, terminator shadow) band horribly at 8 bits. A ±0.5 LSB
 *     interleaved-gradient dither costs nothing and removes it entirely.
 */

import * as THREE from 'three';
import { GLSL_LIB } from '../shaders/common.js';
import { settings } from '../core/Settings.js';

// --- bloom -------------------------------------------------------------------

const DOWNSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform float threshold;
  uniform float softKnee;
  uniform float firstPass;
  varying vec2 vUv;
  ${GLSL_LIB}

  vec3 sampleBox13(vec2 uv){
    // Jimenez's 13-tap partial Karis average: kills fireflies without the
    // temporal shimmer a naive box filter produces on specular highlights.
    vec3 a = texture2D(tDiffuse, uv + texel * vec2(-1.0,-1.0)).rgb;
    vec3 b = texture2D(tDiffuse, uv + texel * vec2( 0.0,-1.0)).rgb;
    vec3 c = texture2D(tDiffuse, uv + texel * vec2( 1.0,-1.0)).rgb;
    vec3 d = texture2D(tDiffuse, uv + texel * vec2(-0.5,-0.5)).rgb;
    vec3 e = texture2D(tDiffuse, uv + texel * vec2( 0.5,-0.5)).rgb;
    vec3 f = texture2D(tDiffuse, uv + texel * vec2(-1.0, 0.0)).rgb;
    vec3 g = texture2D(tDiffuse, uv).rgb;
    vec3 h = texture2D(tDiffuse, uv + texel * vec2( 1.0, 0.0)).rgb;
    vec3 i = texture2D(tDiffuse, uv + texel * vec2(-0.5, 0.5)).rgb;
    vec3 j = texture2D(tDiffuse, uv + texel * vec2( 0.5, 0.5)).rgb;
    vec3 k = texture2D(tDiffuse, uv + texel * vec2(-1.0, 1.0)).rgb;
    vec3 l = texture2D(tDiffuse, uv + texel * vec2( 0.0, 1.0)).rgb;
    vec3 m = texture2D(tDiffuse, uv + texel * vec2( 1.0, 1.0)).rgb;
    vec3 inner = (d + e + i + j) * 0.5;
    vec3 c1 = (a + b + f + g) * 0.125;
    vec3 c2 = (b + c + g + h) * 0.125;
    vec3 c3 = (f + g + k + l) * 0.125;
    vec3 c4 = (g + h + l + m) * 0.125;
    return (inner * 0.5 + c1 + c2 + c3 + c4) * 0.25 + inner * 0.0;
  }

  void main(){
    vec3 c = sampleBox13(vUv);
    if (firstPass > 0.5){
      // Soft-knee bright pass: no hard edge where bloom starts.
      float br = max(c.r, max(c.g, c.b));
      float knee = threshold * softKnee;
      float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 1e-5);
      float contrib = max(soft, br - threshold) / max(br, 1e-5);
      c *= contrib;
      c = min(c, vec3(400.0)); // clamp supernova-scale outliers
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

const UPSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tPrev;
  uniform vec2 texel;
  uniform float radius;
  varying vec2 vUv;

  vec3 tent9(sampler2D t, vec2 uv, vec2 tx, float r){
    vec4 d = vec4(tx, -tx.x, 0.0) * r;
    vec3 s = texture2D(t, uv - d.xy).rgb;
    s += texture2D(t, uv - d.wy).rgb * 2.0;
    s += texture2D(t, uv - d.zy).rgb;
    s += texture2D(t, uv + d.zw).rgb * 2.0;
    s += texture2D(t, uv).rgb * 4.0;
    s += texture2D(t, uv + d.xw).rgb * 2.0;
    s += texture2D(t, uv + d.zy).rgb;
    s += texture2D(t, uv + d.wy).rgb * 2.0;
    s += texture2D(t, uv + d.xy).rgb;
    return s * (1.0 / 16.0);
  }
  void main(){
    vec3 up = tent9(tDiffuse, vUv, texel, radius);
    vec3 prev = texture2D(tPrev, vUv).rgb;
    gl_FragColor = vec4(up + prev, 1.0);
  }
`;

const BLIT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

class BloomChain {
  constructor(renderer, width, height, levels) {
    this.renderer = renderer;
    this.levels = levels;
    this.targets = [];
    this._fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene();
    this._scene.add(this._fsQuad);

    this.downMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        texel: { value: new THREE.Vector2() },
        threshold: { value: 1.15 },
        softKnee: { value: 0.6 },
        firstPass: { value: 0 },
      },
      vertexShader: BLIT_VERT,
      fragmentShader: DOWNSAMPLE_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tPrev: { value: null },
        texel: { value: new THREE.Vector2() },
        radius: { value: 1.0 },
      },
      vertexShader: BLIT_VERT,
      fragmentShader: UPSAMPLE_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.setSize(width, height);
  }

  setSize(width, height) {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (let i = 0; i < this.levels; i++) {
      const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      this.targets.push(rt);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      if (w <= 2 || h <= 2) { this.levels = i + 1; break; }
    }
    this.upTargets = this.targets;
  }

  render(sourceTexture, threshold, knee, radius) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    this._fsQuad.material = this.downMat;
    this.downMat.uniforms.threshold.value = threshold;
    this.downMat.uniforms.softKnee.value = knee;

    let src = sourceTexture;
    let srcW = this.targets[0].width * 2;
    let srcH = this.targets[0].height * 2;
    for (let i = 0; i < this.targets.length; i++) {
      this.downMat.uniforms.tDiffuse.value = src;
      this.downMat.uniforms.texel.value.set(1 / srcW, 1 / srcH);
      this.downMat.uniforms.firstPass.value = i === 0 ? 1 : 0;
      r.setRenderTarget(this.targets[i]);
      r.clear();
      r.render(this._scene, this._camera);
      src = this.targets[i].texture;
      srcW = this.targets[i].width;
      srcH = this.targets[i].height;
    }

    // Upsample back up, accumulating into the coarser mips in place.
    this._fsQuad.material = this.upMat;
    this.upMat.uniforms.radius.value = radius;
    for (let i = this.targets.length - 1; i > 0; i--) {
      const from = this.targets[i];
      const to = this.targets[i - 1];
      this.upMat.uniforms.tDiffuse.value = from.texture;
      this.upMat.uniforms.tPrev.value = to.texture;
      this.upMat.uniforms.texel.value.set(1 / from.width, 1 / from.height);
      // Ping through a scratch target to avoid read/write hazard.
      const scratch = this._scratchFor(to);
      r.setRenderTarget(scratch);
      r.clear();
      r.render(this._scene, this._camera);
      // Copy back
      this._copy(scratch.texture, to);
    }
    r.setRenderTarget(prevTarget);
    return this.targets[0].texture;
  }

  _scratchFor(rt) {
    if (!this._scratch || this._scratch.width !== rt.width || this._scratch.height !== rt.height) {
      this._scratch?.dispose();
      this._scratch = new THREE.WebGLRenderTarget(rt.width, rt.height, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      this._scratch.texture.colorSpace = THREE.NoColorSpace;
    }
    return this._scratch;
  }

  _copy(texture, target) {
    if (!this._copyMat) {
      this._copyMat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: BLIT_VERT,
        fragmentShader: `precision highp float; uniform sampler2D tDiffuse; varying vec2 vUv;
          void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }`,
        depthTest: false, depthWrite: false,
      });
    }
    this._copyMat.uniforms.tDiffuse.value = texture;
    this._fsQuad.material = this._copyMat;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this._scene, this._camera);
    this._fsQuad.material = this.upMat;
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this._scratch?.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this._copyMat?.dispose();
    this._fsQuad.geometry.dispose();
  }
}

// --- final composite ---------------------------------------------------------

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform float bloomStrength;
  uniform float exposure;
  uniform float time;
  uniform vec2 resolution;
  uniform float vignette;
  uniform float grainAmount;
  uniform float aberration;
  uniform float saturation;
  uniform float contrast;
  uniform float lift;
  uniform vec3  shadowTint;
  uniform vec3  highlightTint;
  uniform float flashAmount;
  uniform vec3  flashColor;
  uniform float warpAmount;
  uniform float scanline;
  varying vec2 vUv;
  ${GLSL_LIB}

  void main(){
    vec2 uv = vUv;
    vec2 centered = uv - 0.5;
    float r2 = dot(centered, centered);

    // Barrel distortion, essentially zero at rest. Ramps up during warp so the
    // frame itself feels stretched by the transition.
    if (warpAmount > 0.001){
      uv = 0.5 + centered * (1.0 + warpAmount * r2 * 1.6);
    }

    // Lateral chromatic aberration, increasing with radius like a real lens.
    // Kept very subtle: the frame is full of one- and two-pixel highlights
    // (stars, tracers), and anything stronger fringes every one of them into
    // rainbow speckle rather than reading as a lens characteristic.
    vec3 color;
    float ca = aberration * (0.00025 + 0.0016 * r2);
    if (ca > 0.00002){
      vec2 dir = normalize(centered + 1e-6);
      color.r = texture2D(tDiffuse, uv - dir * ca).r;
      color.g = texture2D(tDiffuse, uv).g;
      color.b = texture2D(tDiffuse, uv + dir * ca).b;
    } else {
      color = texture2D(tDiffuse, uv).rgb;
    }

    vec3 bloom = texture2D(tBloom, uv).rgb;
    color += bloom * bloomStrength;

    color *= exposure;

    // --- tonemap ---
    color = agx(color);
    color = agxLook(color, saturation, vec3(1.0), contrast);
    color = agxEotf(color);

    // --- grade: split-tone shadows cool / highlights warm ---
    float l = lum(color);
    color = mix(color * shadowTint, color * highlightTint, smoothstep(0.15, 0.85, l));
    color += lift * (1.0 - l) * shadowTint * 0.02;

    // --- vignette (natural cos^4 falloff, not a black ring) ---
    float vig = pow(max(0.0, 1.0 - r2 * 1.05), 1.6);
    color *= mix(1.0, vig, vignette);

    // --- transition flash ---
    color = mix(color, flashColor, flashAmount);

    // --- film grain, luminance-weighted so blacks stay clean ---
    if (grainAmount > 0.001){
      float g = ign(gl_FragCoord.xy + vec2(fract(time * 61.0) * 512.0, fract(time * 37.0) * 512.0));
      float weight = 1.0 - abs(l * 2.0 - 1.0);
      color += (g - 0.5) * grainAmount * 0.055 * (0.35 + 0.65 * weight);
    }

    if (scanline > 0.001){
      color *= 1.0 - scanline * 0.06 * (0.5 + 0.5 * sin(gl_FragCoord.y * 2.2 + time * 3.0));
    }

    color = max(color, 0.0);

    // --- ordered dither before 8-bit quantisation ---
    float d = ign(gl_FragCoord.xy) - 0.5;
    color += d / 255.0;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.hdrTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.hdrTarget.texture.colorSpace = THREE.NoColorSpace;
    this.hdrTarget.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.hdrTarget.depthTexture.type = THREE.FloatType;

    this.bloom = new BloomChain(renderer, size.x, size.y, settings.bloomIterations);

    this.composite = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.hdrTarget.texture },
        tBloom: { value: null },
        bloomStrength: { value: 0.055 },
        exposure: { value: 1.0 },
        time: { value: 0 },
        resolution: { value: new THREE.Vector2(size.x, size.y) },
        vignette: { value: 0.55 },
        grainAmount: { value: settings.filmGrain },
        aberration: { value: settings.chromaticAberration },
        saturation: { value: 1.06 },
        contrast: { value: 1.02 },
        lift: { value: 0.0 },
        shadowTint: { value: new THREE.Vector3(0.94, 0.98, 1.10) },
        highlightTint: { value: new THREE.Vector3(1.04, 1.005, 0.965) },
        flashAmount: { value: 0 },
        flashColor: { value: new THREE.Vector3(1, 1, 1) },
        warpAmount: { value: 0 },
        scanline: { value: 0 },
      },
      vertexShader: BLIT_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.bloomThreshold = 1.05;
    this.bloomKnee = 0.65;
    this.bloomRadius = 1.0;
    this.enabled = true;
  }

  setSize(width, height) {
    this.hdrTarget.setSize(width, height);
    this.bloom.setSize(width, height);
    this.composite.uniforms.resolution.value.set(width, height);
  }

  get depthTexture() {
    return this.hdrTarget.depthTexture;
  }

  /** Uniform accessor so gameplay can drive grade without reaching into shaders. */
  set(name, value) {
    const u = this.composite.uniforms[name];
    if (!u) return;
    if (u.value && u.value.isVector3 && Array.isArray(value)) u.value.set(...value);
    else u.value = value;
  }

  render(scene, camera, time) {
    const r = this.renderer;
    r.setRenderTarget(this.hdrTarget);
    r.clear();
    r.render(scene, camera);

    let bloomTex = null;
    if (settings.bloom) {
      bloomTex = this.bloom.render(this.hdrTarget.texture, this.bloomThreshold, this.bloomKnee, this.bloomRadius);
    }
    this.composite.uniforms.tDiffuse.value = this.hdrTarget.texture;
    this.composite.uniforms.tBloom.value = bloomTex || this.hdrTarget.texture;
    this.composite.uniforms.bloomStrength.value = settings.bloom ? this._bloomStrength ?? 0.6 : 0;
    this.composite.uniforms.time.value = time;
    this.composite.uniforms.grainAmount.value = settings.filmGrain;
    this.composite.uniforms.aberration.value = settings.chromaticAberration;

    r.setRenderTarget(null);
    r.clear();
    r.render(this._quadScene, this._quadCam);
  }

  set bloomStrength(v) { this._bloomStrength = v; }
  get bloomStrength() { return this._bloomStrength ?? 0.6; }

  dispose() {
    this.hdrTarget.dispose();
    this.bloom.dispose();
    this.composite.dispose();
    this._quad.geometry.dispose();
  }
}
