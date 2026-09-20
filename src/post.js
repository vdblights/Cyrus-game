import * as THREE from 'three';

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
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
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
    vec3 color = vec3(
      texture2D(tDiffuse, vUv + off).r,
      texture2D(tDiffuse, vUv).g,
      texture2D(tDiffuse, vUv - off).b
    );

    color += (texture2D(tBloom, vUv).rgb + texture2D(tBloomWide, vUv).rgb * 1.25) * bloomStrength;
    color = acesFilmic(color * (exposure / 0.6));

    // grade: hold the dust-orange in the highlights, let the shade go cold
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luma), color, 1.08);
    color *= mix(vec3(0.93, 0.97, 1.07), vec3(1.05, 1.0, 0.95), smoothstep(0.08, 0.68, luma));

    color *= 1.0 - vignette * smoothstep(0.1, 0.5, r2);

    float n = fract(sin(dot(vUv + fract(time * 0.37), vec2(12.9898, 78.233))) * 43758.5453);
    color += (n - 0.5) * grain;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    #include <colorspace_fragment>
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
    this.samples = 4;
    this.width = 0;
    this.height = 0;
    this.targets = null;

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
  configure({ enabled, bloom = true, samples = 4 }) {
    const was = this.enabled;
    this.enabled = enabled;
    this.bloom = bloom;

    if (samples !== this.samples) {
      this.samples = samples;
      this.dispose();                 // sample count is fixed at allocation
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

  _allocate() {
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
      scene: rt(width, height, { depthBuffer: true, samples: this.samples }),
      bright: rt(half.w, half.h),
      brightTmp: rt(half.w, half.h),
      wide: rt(quarter.w, quarter.h),
      wideTmp: rt(quarter.w, quarter.h),
      half,
      quarter,
    };
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
    r.clearDepth();
    r.render(viewScene, viewCamera);

    if (this.bloom) {
      this.brightMat.uniforms.tDiffuse.value = t.scene.texture;
      this._draw(this.brightMat, t.bright);
      this._blur(t.bright, t.brightTmp, t.bright, t.half, 1);

      // a second, wider pass off the first: a broad halo around the sun and
      // the barrel fires that a single blur at this radius cannot reach
      this.blurMat.uniforms.tDiffuse.value = t.bright.texture;
      this.blurMat.uniforms.direction.value.set(1 / t.quarter.w, 0);
      this._draw(this.blurMat, t.wide);
      this._blur(t.wide, t.wideTmp, t.wide, t.quarter, 2);
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
