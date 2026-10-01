import * as THREE from 'three';
import { reserve } from './rng.js';

/**
 * The post chain.
 *
 * The world and the view model are rendered into one floating-point target,
 * the parts of it brighter than the scene's own white are blurred into a
 * bloom, and a final pass tone-maps, grades, vignettes and grains the result
 * on its way to the canvas.
 *
 * three's `EffectComposer` lives in examples/, which this repo does not
 * vendor, so this is the three passes the game actually wants and nothing
 * else. It is about a hundred lines and no download.
 *
 * Two things move when this is switched on, and both move back when it is
 * switched off again (see `configure`):
 *
 * - **Tone mapping leaves the renderer.** Bloom has to be gathered from the
 *   scene's real intensities, so the scene pass stays linear and the final
 *   pass does the ACES curve itself, with the same fit and exposure three
 *   uses so the picture does not jump between quality tiers.
 * - **Antialiasing leaves the canvas.** The canvas's own MSAA does nothing
 *   once the scene is drawn into a target, so the target carries `samples`
 *   instead. That is real MSAA rather than an FXAA smear over the top.
 */

const QUAD_SCENE = new THREE.Scene();
const QUAD_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const QUAD = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
QUAD.frustumCulled = false;
QUAD_SCENE.add(QUAD);

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Everything above the knee, falling off smoothly so edges do not crawl. */
const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float threshold;
  uniform float knee;
  varying vec2 vUv;

  // A pixel that is not a number, or not finite, becomes black here, and
  // nothing past this point can spread it. Tested on the exponent bits, not
  // with isnan(), which a compiler is allowed to fold to false. Without this,
  // one bad pixel — a driver's NaN, a glint past half-float's 65504 — went
  // through nine taps of blur at half and quarter resolution and came out a
  // black box, blinking with whatever made it.
  // So is anything past 1024: the sun disc is the brightest real thing in
  // the sector at about 40, and some drivers store an overflow as half
  // float's largest finite value, 65504, rather than as infinity — which a
  // bilinear read at half resolution then blends down to a quarter of that,
  // and a sixteenth at a corner, both still far past anything real.
  vec3 sane(vec3 c, float hi) {
    uvec3 e = (floatBitsToUint(c) >> 23u) & 255u;
    bvec3 bad = bvec3(e.x == 255u || c.x > 1024.0, e.y == 255u || c.y > 1024.0, e.z == 255u || c.z > 1024.0);
    return clamp(vec3(bad.x ? 0.0 : c.x, bad.y ? 0.0 : c.y, bad.z ? 0.0 : c.z), 0.0, hi);
  }

  void main() {
    // and capped: the sun disc is the brightest thing in the sector at about
    // 40, so the cap costs it nothing and stops any lone spike from blooming
    vec3 c = sane(texture2D(tDiffuse, vUv).rgb, 64.0);
    float peak = max(max(c.r, c.g), c.b);
    float w = clamp((peak - threshold) / max(knee, 1e-4), 0.0, 1.0);
    gl_FragColor = vec4(c * w * w, 1.0);
  }
`;

/** Separable nine-tap gaussian, run once per axis. */
const BLUR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 direction;
  varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
    sum += (texture2D(tDiffuse, vUv + direction * 1.3846153846).rgb
          + texture2D(tDiffuse, vUv - direction * 1.3846153846).rgb) * 0.3162162162;
    sum += (texture2D(tDiffuse, vUv + direction * 3.2307692308).rgb
          + texture2D(tDiffuse, vUv - direction * 3.2307692308).rgb) * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

const FINAL_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform sampler2D tBloomWide;
  uniform float bloomStrength;
  uniform float exposure;
  uniform float vignette;
  uniform float grain;
  uniform float aberration;
  uniform float time;
  varying vec2 vUv;

  // A pixel that is not a number, or not finite, becomes black here, and
  // nothing past this point can spread it. Tested on the exponent bits, not
  // with isnan(), which a compiler is allowed to fold to false. Without this,
  // one bad pixel — a driver's NaN, a glint past half-float's 65504 — went
  // through nine taps of blur at half and quarter resolution and came out a
  // black box, blinking with whatever made it.
  // So is anything past 1024: the sun disc is the brightest real thing in
  // the sector at about 40, and some drivers store an overflow as half
  // float's largest finite value, 65504, rather than as infinity — which a
  // bilinear read at half resolution then blends down to a quarter of that,
  // and a sixteenth at a corner, both still far past anything real.
  vec3 sane(vec3 c, float hi) {
    uvec3 e = (floatBitsToUint(c) >> 23u) & 255u;
    bvec3 bad = bvec3(e.x == 255u || c.x > 1024.0, e.y == 255u || c.y > 1024.0, e.z == 255u || c.z > 1024.0);
    return clamp(vec3(bad.x ? 0.0 : c.x, bad.y ? 0.0 : c.y, bad.z ? 0.0 : c.z), 0.0, hi);
  }

  // the same ACES fit three's ACESFilmicToneMapping uses, so the picture does
  // not shift when post is turned off
  vec3 rrtAndOdtFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 acesFilmic(vec3 color) {
    const mat3 toRRT = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 fromODT = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );
    return clamp(fromODT * rrtAndOdtFit(toRRT * color), 0.0, 1.0);
  }

  void main() {
    vec2 centred = vUv - 0.5;
    float r2 = dot(centred, centred);

    // the lens misses focus at the edges and nowhere near the middle. r2 tops
    // out near 0.5 in the corners, so this is a few pixels there and nothing
    // at the crosshair, which is the only place it would read as a fault.
    vec2 off = centred * r2 * aberration;
    vec3 color = sane(vec3(
      texture2D(tDiffuse, vUv + off).r,
      texture2D(tDiffuse, vUv).g,
      texture2D(tDiffuse, vUv - off).b
    ), 65000.0);

    // sanitised again even though the bright pass already was: with the bloom
    // off these are bound to the scene itself at strength 0, and NaN * 0 is NaN
    color += (sane(texture2D(tBloom, vUv).rgb, 64.0) + sane(texture2D(tBloomWide, vUv).rgb, 64.0) * 1.25) * bloomStrength;
    color = acesFilmic(color * (exposure / 0.6));

    // Grade. Under the dust everything is a little less coloured than it
    // would be in clean air, so saturation comes down rather than up — the
    // old grade pushed it 8% past neutral, which is how a game looks, not a
    // street. The split-tone is a nudge, warm in the light and cool in the
    // shade, not a tint: the sky already makes the shade blue.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, 0.88);
    color *= mix(vec3(0.975, 0.99, 1.03), vec3(1.03, 1.0, 0.965), smoothstep(0.08, 0.68, luma));

    color *= 1.0 - vignette * smoothstep(0.1, 0.5, r2);

    float n = fract(sin(dot(vUv + fract(time * 0.37), vec2(12.9898, 78.233))) * 43758.5453);
    color += (n - 0.5) * grain;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    #include <colorspace_fragment>
  }
`;

/*
 * Ambient occlusion, in three passes over the world's own depth.
 *
 * The city already bakes occlusion into its floors (see `shadeGeometry`), but
 * that only darkens the ground under a wall. Nothing darkened where a barrier
 * meets the pavement, where two walls meet in a corner, under a car, or
 * around a hostile's boots — and contact shading is the first thing an eye
 * uses to decide whether an object is standing on something or pasted over
 * it. This is the screen-space version of that, after McGuire's Alchemy/SAO
 * estimator: a spiral of taps around each pixel, each one asking how much of
 * the hemisphere above the surface is filled by something nearby.
 *
 * It runs at half resolution and carries linear depth alongside the result,
 * so the blur and the upsample can refuse to smear occlusion across a
 * silhouette — without that, every object gets a dark outline against
 * whatever is behind it, which is the tell of cheap SSAO.
 */

/** Occlusion plus linear depth, at half resolution, off full-res depth. */
const AO_FRAG = /* glsl */`
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform mat4 projInv;
  uniform float p11;
  uniform float radius;
  uniform float intensity;
  uniform float bias;
  uniform float fadeStart;
  uniform float fadeEnd;
  uniform float cameraFar;
  varying vec2 vUv;

  vec3 viewPos(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    vec4 v = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }

  void main() {
    vec2 texel = 1.0 / resolution;
    // This pass runs at half resolution, so vUv sits exactly on the edge
    // between two full-resolution depth texels, and which one a nearest
    // lookup returns is decided by float rounding. That decision flips in
    // bands across the screen, and wherever it made the centre and a
    // neighbour read the same texel the normal collapsed: evenly spaced dark
    // lines across every flat surface. Address a texel centre instead.
    vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + 0.5) * texel;

    float d = texture2D(tDepth, uv).x;
    if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }   // sky

    vec3 p = viewPos(uv);

    // Normal from depth, taking whichever neighbour on each axis is on the
    // same surface. Always taking the right-hand one tilts every pixel along
    // a silhouette toward the thing behind it, and it occludes itself.
    vec3 pr = viewPos(uv + vec2(texel.x, 0.0)), pl = viewPos(uv - vec2(texel.x, 0.0));
    vec3 pu = viewPos(uv + vec2(0.0, texel.y)), pd = viewPos(uv - vec2(0.0, texel.y));
    vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
    vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
    vec3 n = normalize(cross(dx, dy));

    // the world radius as a disc on screen, capped so a wall at arm's length
    // does not send every tap across half the frame
    float rPx = min(radius * p11 * 0.5 * resolution.y / -p.z, 90.0);
    if (rPx < 1.5) { gl_FragColor = vec4(1.0, -p.z / cameraFar, 0.0, 1.0); return; }

    // interleaved gradient noise spins the spiral per pixel; the blur eats it
    float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float r2 = radius * radius;
    float sum = 0.0;
    const int N = 12;
    for (int i = 0; i < N; i++) {
      float a = (float(i) + 0.5) / float(N);
      float ang = a * 31.4159265 + spin;          // five turns of the spiral
      vec2 off = vec2(cos(ang), sin(ang)) * (a * rPx);
      vec2 suv = uv + off * texel;
      // A tap off the edge of the frame reads the clamped edge texel, which
      // is a surface that is not there, and darkens a band round the border.
      // It knows nothing; it does not get a vote.
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
      vec3 v = viewPos(suv) - p;
      float vv = dot(v, v);
      float vn = dot(v, n);
      float f = max(r2 - vv, 0.0);
      sum += f * f * f * max((vn - bias) / (0.01 + vv), 0.0);
    }
    float ao = max(0.0, 1.0 - sum * intensity / (r2 * r2 * r2) * (5.0 / float(N)));
    ao = mix(ao, 1.0, smoothstep(fadeStart, fadeEnd, -p.z));
    gl_FragColor = vec4(ao, -p.z / cameraFar, 0.0, 1.0);
  }
`;

/** Depth-aware blur: a nine-tap gaussian that will not cross a depth edge. */
const AO_BLUR_FRAG = /* glsl */`
  uniform sampler2D tAO;
  uniform vec2 direction;
  varying vec2 vUv;

  void tap(vec2 uv, float gw, float z0, inout float s, inout float ws) {
    vec2 t = texture2D(tAO, uv).rg;
    float w = gw * max(0.0, 1.0 - abs(t.g - z0) / (z0 * 0.04 + 1e-5));
    s += t.r * w; ws += w;
  }

  void main() {
    vec2 c = texture2D(tAO, vUv).rg;
    if (c.g >= 1.0) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
    float s = c.r * 0.2270270, ws = 0.2270270;
    tap(vUv + direction, 0.1945946, c.g, s, ws); tap(vUv - direction, 0.1945946, c.g, s, ws);
    tap(vUv + direction * 2.0, 0.1216216, c.g, s, ws); tap(vUv - direction * 2.0, 0.1216216, c.g, s, ws);
    tap(vUv + direction * 3.0, 0.0540540, c.g, s, ws); tap(vUv - direction * 3.0, 0.0540540, c.g, s, ws);
    tap(vUv + direction * 4.0, 0.0162162, c.g, s, ws); tap(vUv - direction * 4.0, 0.0162162, c.g, s, ws);
    gl_FragColor = vec4(s / ws, c.g, 0.0, 1.0);
  }
`;

/**
 * Upsample and apply. Blended as a multiply straight into the scene target,
 * before the view model is drawn, so the gun never inherits the occlusion of
 * the wall it happens to be held in front of.
 */
const AO_APPLY_FRAG = /* glsl */`
  uniform sampler2D tAO;
  uniform sampler2D tDepth;
  uniform vec2 aoResolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float strength;
  varying vec2 vUv;

  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
    float viewZ = (cameraNear * cameraFar) / ((cameraFar - cameraNear) * d - cameraFar);
    float z0 = -viewZ / cameraFar;

    // bilinear over the four nearest half-res texels, each one weighted down
    // by how far its depth is from this pixel's, so a foreground edge does
    // not pick up the occlusion of the wall behind it
    vec2 hp = vUv * aoResolution - 0.5;
    vec2 base = floor(hp), f = hp - base;
    vec2 inv = 1.0 / aoResolution;
    vec2 t00 = texture2D(tAO, (base + vec2(0.5, 0.5)) * inv).rg;
    vec2 t10 = texture2D(tAO, (base + vec2(1.5, 0.5)) * inv).rg;
    vec2 t01 = texture2D(tAO, (base + vec2(0.5, 1.5)) * inv).rg;
    vec2 t11 = texture2D(tAO, (base + vec2(1.5, 1.5)) * inv).rg;
    float k = 1.0 / (z0 * 0.03 + 1e-5);
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y)
           * exp(-abs(vec4(t00.g, t10.g, t01.g, t11.g) - z0) * k);
    float ws = w.x + w.y + w.z + w.w;
    float ao = ws > 1e-4
      ? dot(w, vec4(t00.r, t10.r, t01.r, t11.r)) / ws
      : texture2D(tAO, vUv).r;
    gl_FragColor = vec4(vec3(mix(1.0, ao, strength)), 1.0);
  }
`;

const passMaterial = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT, fragmentShader,
  depthTest: false, depthWrite: false,
});

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = false;
    this.bloom = true;
    this.ao = false;
    this.samples = 4;
    this.width = 0;
    this.height = 0;
    this.targets = null;
    // Built on first use, not here. This constructor runs before the city is
    // laid out and outside any `reserve`, so every material minted in it is
    // four draws the layout pays for — one more here moves every seed's city.
    this.aoMats = null;

    this.brightMat = passMaterial(BRIGHT_FRAG, {
      tDiffuse: { value: null },
      threshold: { value: 0.72 },
      knee: { value: 0.6 },
    });
    this.blurMat = passMaterial(BLUR_FRAG, {
      tDiffuse: { value: null },
      direction: { value: new THREE.Vector2() },
    });
    this.finalMat = passMaterial(FINAL_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tBloomWide: { value: null },
      bloomStrength: { value: 0.62 },
      exposure: { value: 1.45 },
      // the HUD already lays a vignette over the frame in CSS, so this only
      // has to do the part that has to happen before the grade
      vignette: { value: 0.22 },
      grain: { value: 0.01 },
      aberration: { value: 0.012 },
      time: { value: 0 },
    });
  }

  /**
   * Turn the chain on or off and pick how much of it runs.
   *
   * Tone mapping belongs to whichever of the two is drawing the final pixel,
   * never both, or the curve is applied twice and the picture goes chalky.
   */
  configure({ enabled, bloom = true, samples = 4, ao = false }) {
    const was = this.enabled;
    this.enabled = enabled;
    this.bloom = bloom;

    if (samples !== this.samples) {
      this.samples = samples;
      this.dispose();                 // sample count is fixed at allocation
    }

    // Occlusion reads the world's depth while drawing into the same target,
    // which is only safe when that target is multisampled: then the depth
    // texture is a resolve copy, not the attachment being written. Without
    // MSAA it would be a feedback loop, so it is simply not offered.
    const wantAO = ao && samples > 0;
    if (wantAO !== this.ao) {
      this.ao = wantAO;
      this.dispose();                 // the scene target gains or loses its depth texture
    }

    this.renderer.toneMapping = enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    if (!enabled && was) this.dispose();
  }

  setSize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.dispose();
  }

  /**
   * Where the scene is drawn, so its shaders can be compiled ahead of time
   * against the right thing: a program's key includes its output colour
   * space, which is linear into this target and sRGB onto the canvas, and a
   * program compiled for the wrong one is simply compiled again on first use.
   * Null when post is off and the scene is drawn straight to the canvas.
   */
  sceneTarget() {
    if (!this.enabled) return null;
    if (!this.targets) this._allocate();
    return this.targets.scene;
  }

  /**
   * Targets are allocated at first draw and again after every resize or tier
   * change, which is to say in the middle of play, where the seeded stream is
   * deciding spawn points and spread. Each target mints a texture and each
   * texture a UUID, so this runs inside `reserve` and costs the run nothing.
   */
  _allocate() {
    reserve(() => {
      const { width, height } = this;
      const half = { w: Math.max(1, width >> 1), h: Math.max(1, height >> 1) };
      const quarter = { w: Math.max(1, width >> 2), h: Math.max(1, height >> 2) };
      const rt = (w, h, opts = {}) => new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        ...opts,
      });

      this.targets = {
        scene: rt(width, height, {
          depthBuffer: true,
          samples: this.samples,
          // 32-bit float: the far plane is 600 m from a 6 cm near plane, and
          // 24 bits of that leaves a distant wall stepping in centimetres
          depthTexture: this.ao ? new THREE.DepthTexture(width, height, THREE.FloatType) : null,
        }),
        bright: rt(half.w, half.h),
        brightTmp: rt(half.w, half.h),
        wide: rt(quarter.w, quarter.h),
        wideTmp: rt(quarter.w, quarter.h),
        half,
        quarter,
      };

      if (this.ao) {
        // nearest, not linear: the second channel is depth, and a filtered
        // depth is a depth that exists nowhere in the scene
        const near = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
        this.targets.ao = rt(half.w, half.h, near);
        this.targets.aoTmp = rt(half.w, half.h, near);
        if (!this.aoMats) this.aoMats = this._buildAOMaterials();
      }
    });
  }

  _buildAOMaterials() {
    return {
      ao: passMaterial(AO_FRAG, {
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2() },
        projInv: { value: new THREE.Matrix4() },
        p11: { value: 1 },
        // A metre of reach: the gap under a car, the foot of a barrier, the
        // inside of a doorway. Much more and whole façades go grey.
        radius: { value: 1.0 },
        intensity: { value: 0.9 },
        // Five centimetres: the road paint sits 2 cm proud of the asphalt and
        // its polygon offset pulls its depth further toward the camera, so at
        // 2 cm every marking drew a grey halo. A kerb is fifteen.
        bias: { value: 0.05 },
        fadeStart: { value: 45 },
        fadeEnd: { value: 90 },
        cameraFar: { value: 600 },
      }),
      blur: passMaterial(AO_BLUR_FRAG, {
        tAO: { value: null },
        direction: { value: new THREE.Vector2() },
      }),
      apply: Object.assign(passMaterial(AO_APPLY_FRAG, {
        tAO: { value: null },
        tDepth: { value: null },
        aoResolution: { value: new THREE.Vector2() },
        cameraNear: { value: 0.06 },
        cameraFar: { value: 600 },
        strength: { value: 1 },
      }), {
        // result = destination * source: a pure multiply, whatever alpha says
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
      }),
    };
  }

  /** Occlusion from the world's depth, multiplied into the world's colour. */
  _occlude(camera) {
    const t = this.targets, m = this.aoMats;
    const depth = t.scene.depthTexture;

    const u = m.ao.uniforms;
    u.tDepth.value = depth;
    u.resolution.value.set(this.width, this.height);
    u.projInv.value.copy(camera.projectionMatrixInverse);
    u.p11.value = camera.projectionMatrix.elements[5];
    u.cameraFar.value = camera.far;
    this._draw(m.ao, t.ao);

    m.blur.uniforms.tAO.value = t.ao.texture;
    m.blur.uniforms.direction.value.set(1 / t.half.w, 0);
    this._draw(m.blur, t.aoTmp);
    m.blur.uniforms.tAO.value = t.aoTmp.texture;
    m.blur.uniforms.direction.value.set(0, 1 / t.half.h);
    this._draw(m.blur, t.ao);

    const a = m.apply.uniforms;
    a.tAO.value = t.ao.texture;
    a.tDepth.value = depth;
    a.aoResolution.value.set(t.half.w, t.half.h);
    a.cameraNear.value = camera.near;
    a.cameraFar.value = camera.far;
    this._draw(m.apply, t.scene);
  }

  _draw(material, target) {
    QUAD.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(QUAD_SCENE, QUAD_CAMERA);
  }

  /** One separable blur, source to target, via `tmp`. */
  _blur(source, tmp, target, size, radius) {
    this.blurMat.uniforms.tDiffuse.value = source.texture;
    this.blurMat.uniforms.direction.value.set(radius / size.w, 0);
    this._draw(this.blurMat, tmp);
    this.blurMat.uniforms.tDiffuse.value = tmp.texture;
    this.blurMat.uniforms.direction.value.set(0, radius / size.h);
    this._draw(this.blurMat, target);
  }

  /**
   * Draw the frame. Takes both scenes because the view model shares the
   * target: a gun graded differently from the street it is held over reads
   * as a sticker on the lens.
   */
  render(scene, camera, viewScene, viewCamera, time = 0) {
    const r = this.renderer;
    if (!this.targets) this._allocate();
    const t = this.targets;

    r.setRenderTarget(t.scene);
    r.clear();
    r.render(scene, camera);
    if (this.ao) this._occlude(camera);
    r.setRenderTarget(t.scene);
    r.clearDepth();
    r.render(viewScene, viewCamera);

    if (this.bloom) {
      this.brightMat.uniforms.tDiffuse.value = t.scene.texture;
      this._draw(this.brightMat, t.bright);
      this._blur(t.bright, t.brightTmp, t.bright, t.half, 1);

      // A second, wider pass off the first: a broad halo around the sun and
      // the barrel fires that a single blur at this radius cannot reach.
      // Widened by running the blur twice at radius 1, not once at radius 2:
      // the nine taps are placed for radius 1, and stretched to 2 they leave
      // gaps, which turns a point as bright as the sun into a square grid of
      // blobs. Two passes of a gaussian is a wider gaussian.
      this.blurMat.uniforms.tDiffuse.value = t.bright.texture;
      this.blurMat.uniforms.direction.value.set(1 / t.quarter.w, 0);
      this._draw(this.blurMat, t.wide);
      this._blur(t.wide, t.wideTmp, t.wide, t.quarter, 1);
      this._blur(t.wide, t.wideTmp, t.wide, t.quarter, 1);
    }

    // with the bloom off the strength is zero, but the samplers still need
    // something bound: a null one is a driver warning on some machines
    this.finalMat.uniforms.tDiffuse.value = t.scene.texture;
    this.finalMat.uniforms.tBloom.value = this.bloom ? t.bright.texture : t.scene.texture;
    this.finalMat.uniforms.tBloomWide.value = this.bloom ? t.wide.texture : t.scene.texture;
    this.finalMat.uniforms.bloomStrength.value = this.bloom ? 0.62 : 0;
    this.finalMat.uniforms.time.value = time;
    this._draw(this.finalMat, null);
  }

  dispose() {
    if (!this.targets) return;
    for (const value of Object.values(this.targets)) value.dispose?.();
    this.targets = null;
  }
}
