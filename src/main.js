import * as THREE from 'three';
import { buildCity, CITY_PAINT } from './city.js';
import { LoadingScreen, yieldToPaint } from './loading.js';
import { Player, Input } from './player.js';
import { WeaponSystem, MELEE_RANGE, MELEE_DAMAGE } from './weapons.js';
import { GrenadeSystem, FUSE, BLAST_RADIUS, BLAST_DAMAGE } from './grenades.js';
import { Effects } from './effects.js';
import { Enemy, ENEMY_TYPES, HostileBatches, primeEnemyKits, sampleBodies } from './enemies.js';
import { ObjectiveSystem, objectiveForWave } from './objectives.js';
import { BRIEFING, ACTS, FINALE, RADIO, actFor, pickLine, radioLine } from './story.js';
import { HUD } from './hud.js';
import { Post } from './post.js';
import { audio } from './audio.js';
import * as TEX from './textures.js';
import { TILE } from './textures.js';
import { buildDropPrototypes, DROP_COST } from './drops.js';
import { randRange, SUPPORT_RADIUS } from './world.js';
import { NavGrid } from './nav.js';
import { ArmouryScreen, EFFECT, freshKit } from './armoury.js';
import { PerfMeter } from './perf.js';
import { installAtmosphere, skyMaterial, environmentFrom, SUN_DIR, SUN_COLOR } from './atmosphere.js';
import { installShadowCascade, placeShadow, sizeShadow, SUN_DISTANCE } from './shadows.js';
import { initRandom, getSeed, reserve, spend } from './rng.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const SIZE = new THREE.Vector2();

/** Where every run starts: the plaza near the middle of the sector. */
const INSERTION = { x: -17, z: 24 };

/** What each objective pays, times the wave it is finished on. */
const OBJECTIVE_PAY = { cache: 300, hold: 500, extraction: 750, relay: 600, sabotage: 600, hunt: 700, rescue: 800, convoy: 1500 };

/**
 * A marksman at a window: how far back from the glass it stands, its eye
 * over the floor, the fan of street it is judged on (radians off the way
 * the window faces, metres out), and how much of that fan it has to see.
 */
const WINDOW_PERCH = {
  back: 0.95, eye: 1.5, least: 6,
  rays: { turn: [-0.5, -0.25, 0, 0.25, 0.5], out: [12, 20, 30, 42, 55] },
};

/** Every material slot that can hold a texture boot should upload. */
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'alphaMap', 'bumpMap', 'lightMap'];

/** `auto` quality: judged over windows of this many seconds of play… */
const AUTO_WINDOW = 3;
/**
 * …against this frame rate… It was 45, which let a machine sit at 46 fps
 * for a whole run: playable on paper, and exactly what "laggy" means in the
 * hand, because every frame under the display's own rate is another frame
 * between moving the mouse and seeing the view move.
 */
const AUTO_FPS = 55;
/** …and never drawing at less than this fraction of the tier's resolution. */
const AUTO_MIN_SCALE = 0.7;
/**
 * A browser drawing without a graphics card — the GPU's own name says so
 * (`PerfMeter.software`), or a frame takes a quarter of a second — starts
 * on low at `scale` of its resolution, and `auto` may keep giving resolution
 * back down to `min`. Every pixel is the CPU's there: low at 55% draws in a
 * third of the time it takes at full size (550 → 152 ms, seed 1 under
 * SwiftShader), and under 40% the frame is mostly the vertices and stops
 * paying. `gap` is how long a frame may take and still count as one: at
 * the quarter second a GPU machine is held to, every frame on these
 * machines read as a pause and `auto` never moved at all.
 */
const NO_GPU = { scale: 0.7, min: 0.4, gap: 2, slow: 250 };
/**
 * The frame a starting tier must draw an empty street in, in ms. A dozen
 * hostiles is about a third more work than the empty street the boot stage
 * can measure, so a tier that only just holds 60 there (16.7 ms) is short of
 * it in the first fight; 12.5 leaves that third.
 */
const START_BUDGET_MS = 12.5;
/** The longest single step the simulation takes, in seconds… */
const MAX_STEP = 0.05;
/** …and the longest frame it will catch up on rather than drop. */
const MAX_FRAME = 0.2;
/** How far off a hostile's steps carry, in metres… */
const FOOTFALL_RANGE = 26;
/** …how many of them play in any quarter second… */
const FOOTFALL_VOICES = 4;
/** …and the feet height above which it is on a prop, not the ground (every floor is under it). */
const DECK_HEIGHT = 0.55;
/** The hemisphere light under the sky's environment… */
const HEMI = 0.28;
/**
 * …and standing in for it on the low tier, where nothing reads the
 * environment. Chosen by matching the frame: across three views on seed 1
 * the PBR low tier averages 82.2 (sRGB, 0-255) with its darkest fifth at
 * 39.5; Lambert under 3.0 gives 82.1 and 42.5, under 0.28 it gave 59.8 and
 * 16.4 — shaded walls gone black.
 */
const HEMI_PLAIN = 2.8;
/** What a low-tier Lambert twin takes from the material it stands in for. */
const TWIN_PROPS = ['color', 'map', 'vertexColors', 'emissive', 'emissiveMap', 'emissiveIntensity',
  'aoMap', 'aoMapIntensity', 'alphaMap', 'alphaTest', 'transparent', 'opacity', 'side',
  'depthWrite', 'depthTest', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits',
  'blending', 'fog', 'toneMapped', 'flatShading', 'wireframe', 'visible'];
const RAY = new THREE.Raycaster();
const SHADOW_AT = new THREE.Vector3();
const SHADOW_AHEAD = new THREE.Vector3();

class Game {
  constructor() {
    // the fog and shadow shader chunks are rewritten before anything can
    // compile them
    installAtmosphere();
    this.shadowCascade = installShadowCascade();
    // seed first: everything below this line draws on Math.random()
    this.seed = initRandom();
    this.canvas = document.getElementById('scene');
    // No multisampling on the canvas. High and medium draw the scene into the
    // post chain's own multisampled target, so the canvas's samples only ever
    // antialiased the low tier — and cost every tier a full-screen resolve,
    // and the low tier more than a quarter of its frame (707 ms against 970
    // under software rendering), on the machines least able to pay it.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.perf = new PerfMeter(this.renderer);
    // the headless suite draws in software and was written against the high tier
    this.suite = !!window.__ashfallSuite;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;

    // ---- world scene ----------------------------------------------------
    this.scene = new THREE.Scene();
    // Height fog: `fogDensity` is its density at street level, and it thins
    // with height (see atmosphere.js). The colour is not this one — it is the
    // sky's own horizon in whichever direction you are looking.
    this.scene.fog = new THREE.FogExp2(0x8a6748, 0.0050);
    this.baseFov = 78;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, innerWidth / innerHeight, 0.06, 600);

    // ---- view-model scene (drawn on top so the gun never clips) ----------
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 12);
    this.viewScene.add(new THREE.AmbientLight(0xbdac98, 0.85));
    const vKey = new THREE.DirectionalLight(0xffdcae, 1.35);
    vKey.position.set(-0.6, 1.2, 0.8);
    this.viewScene.add(vKey);
    const vRim = new THREE.DirectionalLight(0x8fa6c8, 0.75);
    vRim.position.set(0.9, -0.3, -1);
    this.viewScene.add(vRim);

    this.post = new Post(this.renderer);

    this.state = 'loading';
    this.loading = new LoadingScreen(getSeed());
    // Resolves when the menu is up. The checks wait on `state` instead, but a
    // caller that wants the game built can await this.
    this.booted = this.boot().catch((err) => { this.loading.fail(err); throw err; });
  }

  /**
   * Everything that takes time, as named stages with a chance to paint between
   * each, so the loading screen can say what is happening and keep moving.
   *
   * It used to be the body of the constructor: one task, seventeen seconds
   * long under software rendering, during which the page could not draw a
   * single frame. The order is unchanged, and so is the seeded stream — every
   * stage that mints anything three gives a UUID either runs inside `reserve`
   * as it always did or is the city itself, and nothing that runs while boot
   * is waiting draws on `Math.random` (see loading.js). The layout check and
   * an identical hash over every city texture are what say so.
   *
   * Weights are each stage's share of boot in tenths of a second. The CPU
   * stages — painting, laying out, building the guns — are as measured on
   * seed 1. The three GPU stages are not, because software rendering inflates
   * them about a hundredfold (5.6 s for the warm-up frame alone), and a bar
   * weighted by that would sit at three quarters on a real machine and then
   * jump; theirs are an estimate of what a real GPU and driver spend.
   */
  async boot() {
    // kept, so a check can ask whether every one of them survived the bake
    const painted = this.paintedMaterials = {};
    let city = null;
    const plan = [
      ['Lighting the sky', 3, () => {
        // Everything from here to the city is look, not layout. `reserve`
        // rewinds the seeded stream afterwards so the UUIDs three mints per
        // material and texture cannot shift what gets built — see `rng.js`.
        reserve(() => {
          this.setupSky();
          this.setupEnvironment();
          // three builds the quad every Sprite shares the first time any
          // Sprite is constructed, and pays for its UUIDs out of the seeded
          // stream. That used to be the sun's glow, here, inside this
          // reserve. With the sun now drawn by the sky, the first Sprite was
          // a fire barrel's flame halfway through laying out the city, and
          // its one-off bill moved every prop after it: seed 1 laid out 308
          // boxes instead of 332. So build the shared quad here, where it has
          // always been built, and costs nothing.
          new THREE.Sprite();
        });
        this.setupLights();
        // The second cascade is a light the layout has never paid for: it is
        // new, it is minted before the city, and outside a reserve its UUID
        // would hand every seed a different city.
        reserve(() => this.setupShadowCascade());
      }],
      ...CITY_PAINT.map((step) => [step.label, step.weight, () => reserve(() => step.run(painted))]),
      ['Raising the city', 5, () => {
        city = buildCity(this.scene, painted);
        this.world = city.world;
        this.city = city.group;          // the merged, baked meshes checks read
        this.fireBarrels = city.fireBarrels;
        this.perches = city.perches;
        this.batches = city.batches;
        this.weedMeshes = city.group.children.filter((o) => o.isMesh && o.material.userData.name === 'weeds');
        this.streets = city.streets;     // where the carriageways are, as built
        // The shapes the props are cut from, kept so a check can measure
        // them: a facet wound the wrong way round does not error, it
        // vanishes, and the merged city is too late to tell which prop it
        // vanished from.
        this.propShapes = city.shapes;

        // Where hostiles can walk, and which way is toward you from anywhere
        // in the sector. Built once the city's boxes are final, and out of
        // typed arrays only, so it costs the seeded stream nothing — see
        // nav.js.
        this.nav = new NavGrid(this.world);
        // A marksman's other perch: a floor's window over the street. Read
        // off the floors as built, drawing nothing, so it costs no seed.
        this.windowPerches = this.findWindowPerches();
        this.loading.survey(this.world, this.perches, INSERTION);
      }],
      ['Loading the debris', 1, () => {
        this.effects = reserve(() => new Effects(this.scene));
        this.effects.groundAt = (x, z, y) => this.world.groundHeight(x, z, SUPPORT_RADIUS, y);
        this.player = new Player(this.camera, this.world);
      }],
      ['Arming you', 18, () => {
        this.weapons = reserve(() => new WeaponSystem(this.viewScene, this));
        this.input = new Input(this.canvas);
        this.hud = new HUD();
        this.grenades = new GrenadeSystem(this.scene, this);
        this.objectives = new ObjectiveSystem(this.scene, this);
      }],
      ['Kitting out the hostiles', 4, () => {
        reserve(() => {
          this.setupPickupPrototypes();
          this.setupDust();
          // Every archetype's meshes and materials, built now rather than
          // when the first of one spawns: it is a texture pass either way,
          // and doing it here puts it in the loading screen instead of in a
          // firefight.
          primeEnemyKits();
          // and the batches that draw them, one per archetype and part
          this.hostiles = new HostileBatches(this.scene);
        });
        this.dress(this.hostiles.root);
        this.settle();
      }],
      ['Measuring this machine', 3, () => this.chooseStartingTier()],
      ...this.precompileStages(),
    ];

    const total = plan.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [label, weight, run] of plan) {
      this.loading.stage(label, weight, total);
      await yieldToPaint();
      run();
    }

    this.loading.finish();
    this.state = 'menu';
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** The run-independent state, settings and UI, once the world exists. */
  settle() {
    this.nades = 3;
    this.maxNades = 5;
    this.kit = freshKit();
    this.scrip = 0;
    this.scoreSeen = 0;
    this.fuseLength = FUSE;
    this.cookStart = -1;

    this.enemies = [];
    this.enemyTypes = ENEMY_TYPES;   // so a check can walk every archetype
    this.pool = {};
    this.pickups = [];

    this.time = 0;
    this.score = 0;
    this.wave = 0;
    this.kills = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.pendingSpawns = 0;
    this.spawnQueue = [];
    this.nextWaveAt = 0;
    this.objectivesSecured = 0;
    this.objectivesLost = 0;
    this.objectiveCue = null;
    this.runStart = 0;
    this.waveHpScale = 1;      // set per wave, but never left undefined

    // an embedded page cannot always get pointer lock; the HUD offers a way out
    this.embedded = window.self !== window.top;
    this.settings = this.loadSettings();
    this.renderScale = 1;      // resolution `auto` has given back, 1 = the tier's own
    this.records = this.loadRecords();
    this.collectMaterials();
    this.bindUI();
    addEventListener('resize', () => this.resize());
    this.resize();

    this.clock = new THREE.Clock();
    const seedEl = document.getElementById('seed');
    if (seedEl) seedEl.textContent = 'SECTOR SEED ' + getSeed();
  }

  /**
   * Build every shader a run will need while the loading screen is still up.
   *
   * `renderer.compile` only compiles what is visible, and almost nothing a
   * fight draws is visible at boot: no hostile exists yet, and the pooled
   * tracers, casings, sprites and debris all stay hidden until used. Each was
   * compiled on the first frame it appeared instead — five programs the
   * first time hostiles came into view and three on the first shot, measured
   * on seed 1, which is a stall at exactly the moment of first contact. So
   * for one compile every hidden thing is shown, one body of every archetype
   * stands in the scene, and then all of it is put back. Lights are left as
   * they are: how many there are is part of every lit program's key, so
   * showing a hidden one would compile programs nothing ever uses. The same
   * is true of the target, which is the other half of the key, and the half
   * that made the first version of this compile all eight a second time.
   * Every texture those materials hold is uploaded while it is at it, and
   * then all of it is drawn once. Three stages of boot, so the loading screen
   * can move between them; nothing draws in between, so what is shown stays
   * shown until the last of them puts it back.
   */
  precompileStages() {
    let bodies, drops, shown, unculled;
    return [
      ['Compiling shaders', 8, () => {
        bodies = sampleBodies();
        this.camera.getWorldDirection(V1);
        bodies.position.copy(this.camera.position).addScaledVector(V1, 6).setY(0);
        this.dress(bodies);
        this.scene.add(bodies);
        for (const b of bodies.children) this.hostiles.track(b);
        // and one of every drop, which nothing else puts in the scene before
        // the first hostile dies
        drops = reserve(() => {
          const group = new THREE.Group();
          Object.values(this.pickupProto).forEach((proto, i) => {
            const d = proto.clone();
            d.position.set(i - 1, 0.5, 0);
            group.add(d);
          });
          return group;
        });
        drops.position.copy(bodies.position).addScaledVector(V1, -3);
        this.dress(drops);
        this.scene.add(drops);
        shown = [];
        unculled = [];
        // a rig's meshes are hidden for good — the batches draw them — and
        // compiling them would only build programs nothing uses
        const rig = (o) => o.isMesh && !o.isInstancedMesh && o.userData.batch;
        for (const scene of [this.scene, this.viewScene]) {
          scene.traverse((o) => { if (!o.visible && !o.isLight && !rig(o)) { shown.push(o); o.visible = true; } });
        }
        for (const o of [...shown, ...bodies.children, ...drops.children]) {
          o.traverse((c) => { if (c.frustumCulled) { c.frustumCulled = false; unculled.push(c); } });
        }
        // against the target the scene is really drawn into, or every program
        // is keyed for the canvas and built a second time on first use
        this.renderer.setRenderTarget(this.post.sceneTarget());
        this.renderer.compile(this.scene, this.camera);
        this.renderer.compile(this.viewScene, this.viewCamera);
        this.renderer.setRenderTarget(null);
      }],
      ['Uploading textures', 2, () => {
        // A texture goes to the GPU on the first frame that draws it, which
        // for a hostile's 1024-pixel kit maps was the frame it first came
        // into view.
        const textures = new Set();
        for (const scene of [this.scene, this.viewScene]) {
          scene.traverse((o) => {
            for (const m of [].concat(o.material || [])) {
              for (const k of TEXTURE_SLOTS) if (m[k]?.isTexture) textures.add(m[k]);
            }
          });
        }
        for (const t of textures) this.renderer.initTexture(t);
      }],
      ['Warming up', 4, () => {
        // And one real frame of all of it, behind the loading screen: a
        // compiled program is not always a finished one, and the work some
        // drivers leave for its first draw is better spent here than at first
        // contact.
        this.render();
        for (const o of shown) o.visible = false;
        for (const o of unculled) o.frustumCulled = true;
        for (const b of bodies.children) this.hostiles.untrack(b);
        this.scene.remove(bodies);
        this.scene.remove(drops);
      }],
    ];
  }

  /** Restart the random stream — used by tests to pin a run exactly. */
  reseed(seed = this.seed) {
    this.seed = initRandom(seed);
    return this.seed;
  }

  // ------------------------------------------------------------------ setup
  /**
   * The sky is computed, not painted (see atmosphere.js), and the sun is a
   * disc in it at the light's own direction — so the shadows always point
   * away from the thing casting them, and its glare is the bloom's doing
   * rather than a 230-unit sprite's.
   */
  setupSky() {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(420, 48, 24), skyMaterial());
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.sky = sky;
    this.sunDir = SUN_DIR.clone();
  }

  /**
   * Light the city with the sky it stands under.
   *
   * The dome is rendered into a PMREM so it can be used as an image-based
   * light: every PBR surface then reflects the sky actually drawn above it —
   * warm on the faces turned to the sun, blue from overhead, grey from the
   * side away from it — instead of answering a hemisphere light with one flat
   * tint. It is the same function the dome draws, so the two cannot drift.
   */
  setupEnvironment() {
    this.envMap = environmentFrom(this.renderer, this.sky.material);

    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 1;
    // the view model is lit in its own scene, but a gun that does not catch
    // the same sky as the street reads as a sticker over it
    this.viewScene.environment = this.envMap;
    this.viewScene.environmentIntensity = 0.75;
  }

  setupLights() {
    // low ambient, strong key: faces should separate by which way they point.
    // The sky itself now carries most of the ambient (see setupEnvironment),
    // so this is a fraction of what it was or the shadows wash out.
    // The sky itself carries the ambient now (see setupEnvironment), so what
    // is left of the hemisphere is the warm ground bounce the dome cannot
    // supply — it has nothing below the horizon worth reflecting.
    this.hemi = new THREE.HemisphereLight(0xa9b4c2, 0x7d6650, HEMI);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(SUN_COLOR, 3.0);
    sun.position.copy(SUN_DIR).multiplyScalar(SUN_DISTANCE);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 58;      // wide enough that nearby blocks cast onto the street
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // cool bounce from the opposite side so shadowed faces stay readable —
    // lighter than it was, because the sky light now comes from that side too
    const fill = new THREE.DirectionalLight(0x7f95b4, 0.28);
    fill.position.set(40, 25, 50);
    this.scene.add(fill);

    // a dim upward kick, standing in for light coming back off the pavement
    const bounce = new THREE.DirectionalLight(0x8c8072, 0.18);
    bounce.position.set(10, -20, 10);
    this.scene.add(bounce);
  }

  /**
   * The tight shadow map: a light at the sun's angle with no intensity of its
   * own, whose map the sun reads near the player (see shadows.js). Added
   * after the sun, because the cascade lookup relies on the sun being the
   * first shadow-casting directional light and this the second.
   */
  setupShadowCascade() {
    const near = new THREE.DirectionalLight(0xffffff, 0);
    near.castShadow = true;
    near.shadow.camera.near = 1;
    near.shadow.camera.far = 220;
    // a texel a quarter the size of the wide map's needs a quarter the bias
    near.shadow.bias = -0.0003;
    near.shadow.normalBias = 0.012;
    this.scene.add(near);
    this.scene.add(near.target);
    this.sunNear = near;
  }

  setupDust() {
    const count = 700;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = randRange(-30, 30);
      pos[i * 3 + 1] = randRange(0.2, 16);
      pos[i * 3 + 2] = randRange(-30, 30);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd9c4a4, size: 0.055, transparent: true, opacity: 0.5,
      depthWrite: false, sizeAttenuation: true, map: TEX.particleSprite('#e8dcc8'),
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  /**
   * What a hostile leaves behind, built once and cloned per drop — see
   * `drops.js`, which keeps the parts a clone mints exactly what they were.
   */
  setupPickupPrototypes() {
    const { proto, crossMat, haloMats } = buildDropPrototypes();
    this.crossMat = crossMat;
    this.haloMats = haloMats;
    this.pickupProto = proto;
  }

  loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ashfall.settings') || '{}'); } catch { saved = {}; }
    return { sens: 100, fov: 78, volume: 70, muted: false, invertY: false, quality: 'auto', showPerf: false, ...saved };
  }

  /** Every unique material, so a quality change can flag them all at once. */
  collectMaterials() {
    const seen = new Set();
    for (const root of [this.scene, this.viewScene]) {
      root.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) seen.add(m);
      });
    }
    this.materials = [...seen];
    // remember the normal maps so switching quality can put them back
    this.normalMapped = this.materials.filter((m) => m.normalMap).map((m) => ({ m, map: m.normalMap }));
  }

  /**
   * Graphics tiers. Shadow mapping is far and away the most expensive thing
   * in the scene, so it is the first thing to go.
   */
  applyQuality(tier = this.settings.quality) {
    const level = tier === 'auto' ? (this.autoTier || 'high') : tier;
    const cfg = {
      // Resolution is most of the bill: every pass added since the graphics
      // pass — occlusion, bloom, two soft cascades, the window tracing — is
      // paid per pixel, and 4x MSAA multiplies the scene pass again. On a 2x
      // screen 1.75 drew 3.06x the pixels of 1.0; 1.25 draws half what 1.75
      // did and, under 4x MSAA, still reads clean.
      high: { shadows: true, soft: true, shadowSize: 2048, span: 55, nearSize: 2048, nearSpan: 13, normals: true, pixel: 1.25, dust: true, post: true, bloom: true, samples: 4, ao: true, fires: 3, flashes: true, plain: false, weeds: true },
      medium: { shadows: true, soft: false, shadowSize: 1024, span: 40, nearSize: 1024, nearSpan: 11, normals: true, pixel: 1.0, dust: true, post: true, bloom: true, samples: 2, ao: true, fires: 2, flashes: true, plain: false, weeds: true },
      // Low is for the integrated GPU in an old laptop, and it was not low
      // enough: measured as 14 fps on an Intel HD. Every lit pixel still ran
      // the PBR model against the sky's environment and twelve point lights.
      // Lambert, no point lights and no canvas samples take the same frame
      // from 970 ms to 173 under software rendering.
      low: { shadows: false, soft: false, shadowSize: 512, span: 40, nearSize: 0, nearSpan: 11, normals: false, pixel: 1, dust: false, post: false, bloom: false, samples: 0, ao: false, fires: 0, flashes: false, plain: true, weeds: false },
    }[level];

    // the low tier draws straight to the canvas, as it always did: a machine
    // that cannot afford shadows cannot afford a bloom either
    this.post.configure({ enabled: cfg.post, bloom: cfg.bloom, samples: cfg.samples, ao: cfg.ao });

    this.renderer.shadowMap.enabled = cfg.shadows;
    this.renderer.shadowMap.type = cfg.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    // an explicit tier is drawn at its own resolution; only `auto` scales it
    if (tier !== 'auto') this.renderScale = 1;
    this.tierPixel = cfg.pixel;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cfg.pixel) * this.renderScale);

    sizeShadow(this.sun, cfg.span, cfg.shadowSize);
    this.shadowSpan = cfg.span;
    // the cascade switches off with the shadows or on a tier without one;
    // with a single shadowed light the ordinary lookup compiles instead
    this.sunNear.castShadow = cfg.shadows && cfg.nearSize > 0;
    if (this.sunNear.castShadow) sizeShadow(this.sunNear, cfg.nearSpan, cfg.nearSize);
    this.nearSpan = cfg.nearSpan;

    for (const { m, map } of this.normalMapped) m.normalMap = cfg.normals ? map : null;
    for (const m of this.materials) m.needsUpdate = true;   // shadow state is compiled in
    this.dust.visible = cfg.dust;

    // the point-light count is compiled into every lit program, so it is set
    // here, with the tier, and held constant until the next tier change
    this.fireLights = cfg.fires;
    this.placeFireLights(true);
    this.effects.muzzleLight.visible = this.effects.blastLight.visible = cfg.flashes;
    this.plainMaterials = cfg.plain;
    this.dress(this.scene);
    // The weeds and the cloud's finer octaves are the two things the realism
    // pass after the low tier's own added to every pixel; measured on low,
    // 32 ms and 22 ms of a 210 ms software frame. Low keeps the cloud's
    // shapes and drops the weeds.
    for (const m of this.weedMeshes || []) m.visible = cfg.weeds;
    this.sky.material.uniforms.cloudLow.value = cfg.plain ? 1 : 0;
    // a Lambert twin cannot see the sky's environment, which is most of the
    // light a shaded wall gets; the hemisphere stands in for it
    this.hemi.intensity = cfg.plain ? HEMI_PLAIN : HEMI;

    this.activeTier = level;
    this.resize();
  }

  /**
   * On 'auto', keep watching the frame rate for as long as you play, and give
   * some of the picture back when it falls short.
   *
   * It used to watch the first three seconds of a run and then stop for good
   * — three seconds of an empty street before wave one, the cheapest the game
   * ever is to draw. A dozen hostiles is a third more draw calls on top of
   * that (421 against 555, measured on seed 1), so a machine that held its
   * frame rate on the empty street could fall well short of it in the fight
   * and never be asked again.
   *
   * Two levers, in order. Resolution first: it moves no shader, so it can be
   * pulled mid-fight without a stall, and fill is what the expensive passes —
   * occlusion, bloom, the window tracing, soft shadows over two cascades —
   * scale with. The tier while nothing is alive, because a tier change
   * recompiles every lit material and that is a stall you would feel in a
   * fight — or in a fight once resolution is spent, because a whole wave
   * short of the frame rate is worse than one stall. Never back up: a
   * picture that see-saws between two settings is worse than either. An explicit choice is never overridden.
   *
   * Wall clock, not game time: game time drops whatever a frame takes past
   * a fifth of a second, so a very slow machine would otherwise look faster
   * than it is. And only over unbroken play: a gap —
   * a pause, a hidden tab, a hitch — starts the window again rather than
   * reading as one very long frame.
   */
  autoCalibrate() {
    if (this.settings.quality !== 'auto') return;
    const now = performance.now() / 1000;
    if (!this.autoStart || now - this.autoLast > (this.cpuDrawn ? NO_GPU.gap : 0.25)) {
      this.autoStart = this.autoLast = now;
      this.autoFrames = 0;
      return;
    }
    this.autoLast = now;
    this.autoFrames++;
    const elapsed = now - this.autoStart;
    if (elapsed < AUTO_WINDOW) return;

    const fps = this.autoFrames / elapsed;
    this.autoStart = now;
    this.autoFrames = 0;
    if (fps >= AUTO_FPS) return;

    const order = ['high', 'medium', 'low'];
    const at = order.indexOf(this.activeTier || 'high');
    if (this.aliveCount === 0 && at < order.length - 1) {
      this.autoTier = order[at + 1];
      this.applyQuality();
      this.hud.toast('GRAPHICS: ' + this.autoTier.toUpperCase() + ` (${Math.round(fps)} FPS)`);
    } else if (this.renderScale > (this.cpuDrawn ? NO_GPU.min : AUTO_MIN_SCALE) + 1e-3) {
      this.renderScale = Math.max(this.cpuDrawn ? NO_GPU.min : AUTO_MIN_SCALE, this.renderScale - 0.15);
      this.applyPixelRatio();
      this.hud.toast(`GRAPHICS: RESOLUTION ${Math.round(this.renderScale * 100)}% (${Math.round(fps)} FPS)`);
    } else if (at < order.length - 1) {
      // Out of resolution to give and still short, in a fight. Waiting for
      // the wave to end used to mean the rest of it at this frame rate; one
      // stall while the shaders rebuild is the smaller cost.
      this.autoTier = order[at + 1];
      this.applyQuality();
      this.hud.toast('GRAPHICS: ' + this.autoTier.toUpperCase() + ` (${Math.round(fps)} FPS)`);
    }
  }

  /**
   * On 'auto', start at the tier this machine can hold, rather than at the
   * top and walking down.
   *
   * `autoCalibrate` only ever steps down, three seconds at a time, and a
   * whole tier only between waves — so a machine that cannot hold the high
   * tier used to spend the opening of every run, first wave included, at
   * its worst. This times a few real frames of the city at each tier, best
   * first, and starts at the first one with room left for a fight (a dozen
   * hostiles is about a third more draw calls than an empty street). It
   * runs before the shader stages, so the programs built there are the
   * ones this tier draws with and nothing compiles at first contact.
   *
   * A browser drawing without a graphics card is not measured at all: its
   * own GPU name says so, and it starts on low at part of its resolution
   * (`NO_GPU`). It used to be read as a machine too slow to measure and left
   * on high, where a frame is seconds, and `autoCalibrate` read each of
   * those frames as a pause and never stepped down either — reported from a
   * work machine with acceleration off as very slow where it had run well.
   * A tier whose frames take a quarter of a second fails like any other, so
   * a machine slow in a way its name does not admit reaches low the same
   * way. The suite draws in software too, and keeps the high tier every
   * check was written against (`suite`, set by the harness).
   */
  chooseStartingTier() {
    if (this.settings.quality !== 'auto') return;
    this.cpuDrawn = false;
    if (this.suite) {
      this.autoTier = 'high';
      this.startingTier = { tier: 'high', measured: false };
      this.applyQuality();
      return;
    }
    if (this.perf.software) {
      this.cpuDrawn = true;
      this.autoTier = 'low';
      this.renderScale = NO_GPU.scale;
      this.startingTier = { tier: 'low', measured: false, cpu: true };
      this.applyQuality();
      return;
    }
    const gl = this.renderer.getContext(), px = new Uint8Array(4);
    // one pixel read back is the only honest wait for the GPU here
    const frame = () => {
      const t0 = performance.now();
      this.render();
      this.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return performance.now() - t0;
    };
    let chosen = null;
    for (const tier of ['high', 'medium', 'low']) {
      this.autoTier = tier;
      this.applyQuality();
      frame();                                  // compiles and first draws
      // Two slow frames in a row are enough to know a machine cannot be
      // measured (one could be a late upload on a real GPU). Waiting for
      // three more as well cost every boot under software rendering several
      // seconds, and that is what took the suite past CI's time limit.
      if (frame() >= NO_GPU.slow && frame() >= NO_GPU.slow) {
        if (tier !== 'low') continue;
        this.cpuDrawn = true;
        this.renderScale = NO_GPU.scale;
        chosen = tier;
        break;
      }
      const times = [frame(), frame(), frame()].sort((a, b) => a - b);
      const median = times[1];
      if (median <= START_BUDGET_MS || tier === 'low') { chosen = tier; break; }
    }
    this.autoTier = chosen;
    this.startingTier = { tier: chosen, measured: !this.cpuDrawn, cpu: this.cpuDrawn };
    this.applyQuality();
  }

  /** The tier's pixel ratio, capped by the screen's, scaled by `auto`. */
  applyPixelRatio() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.tierPixel) * this.renderScale);
    this.resize();
  }

  saveSettings() {
    try { localStorage.setItem('ashfall.settings', JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  loadRecords() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ashfall.records') || '{}'); } catch { saved = {}; }
    return { bestScore: 0, bestWave: 0, ...saved };
  }

  saveRecords() {
    try { localStorage.setItem('ashfall.records', JSON.stringify(this.records)); } catch { /* private mode */ }
  }

  showRecords() {
    const el = document.getElementById('records');
    if (!el) return;
    el.classList.toggle('hidden', !this.records.bestWave);
    el.innerHTML = `BEST &mdash; WAVE <b>${this.records.bestWave}</b> &middot; ` +
      `SCORE <b>${this.records.bestScore.toLocaleString()}</b>`;
  }

  applySettings() {
    const st = this.settings;
    this.input.sensitivity = st.sens / 100;
    this.input.invertY = st.invertY;
    this.baseFov = st.fov;
    audio.setVolume(st.volume / 100);
    audio.setMuted(st.muted);
    for (const [id, val] of [['sens', st.sens], ['fov', st.fov], ['volume', st.volume]]) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }
    const q = document.getElementById('quality');
    if (q) q.value = st.quality;
    if (this.materials) this.applyQuality();
    const inv = document.getElementById('invert');
    if (inv) inv.checked = st.invertY;
    const mute = document.getElementById('mute');
    if (mute) mute.checked = st.muted;
    const perf = document.getElementById('show-perf');
    if (perf) perf.checked = st.showPerf;
    this.perf.show(st.showPerf);
  }

  bindUI() {
    const start = () => this.startRun();
    // DEPLOY from the menu reads the briefing first; REDEPLOY goes straight in
    document.getElementById('start-btn').onclick = () => this.brief();
    document.getElementById('retry-btn').onclick = start;
    document.getElementById('brief-btn').onclick = start;
    addEventListener('keydown', (e) => {
      if (this.state === 'briefing' && (e.code === 'Enter' || e.code === 'Space') && !e.repeat) { e.preventDefault(); start(); }
    });
    document.getElementById('resume-btn').onclick = () => this.resume();
    document.getElementById('quit-btn').onclick = () => this.toMenu();

    const bind = (id, key, read) => {
      const el = document.getElementById(id);
      el.oninput = () => { this.settings[key] = read(el); this.applySettings(); this.saveSettings(); };
    };
    bind('sens', 'sens', (el) => +el.value);
    bind('fov', 'fov', (el) => +el.value);
    bind('volume', 'volume', (el) => +el.value);
    bind('invert', 'invertY', (el) => el.checked);
    bind('mute', 'muted', (el) => el.checked);
    bind('quality', 'quality', (el) => el.value);
    this.applySettings();

    // The key left of 1 shows the frame-rate readout, in play or paused.
    // Not through `applySettings`: that re-applies the tier, which flags
    // every material for a recompile, and a readout for measuring stalls
    // must not cause one.
    const showPerf = (on) => {
      this.settings.showPerf = on;
      document.getElementById('show-perf').checked = on;
      this.perf.show(on);
      this.saveSettings();
    };
    document.getElementById('show-perf').oninput = (e) => showPerf(e.target.checked);
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' && !e.repeat) showPerf(!this.settings.showPerf);
    });
    // no graphics card behind the canvas: say so where it will be read,
    // because nothing in the game can make up for it
    const note = document.getElementById('gpu-note');
    if (note && this.perf.software) {
      note.textContent = 'Your browser is drawing without the graphics card, so the game has dropped to its lowest settings — turn on hardware acceleration for the full picture.';
      note.classList.remove('hidden');
    }
    this.showRecords();

    // any click inside the play area is another chance to capture the mouse
    this.canvas.addEventListener('mousedown', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });
    document.getElementById('capture-hint').addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'A') return;          // let the link through
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    this.input.onLockChange = (locked) => {
      // without capture there is nothing to lose, so do not auto-pause
      if (!locked && this.state === 'playing' && !this.input.fallback) this.pause();
    };

    this.input.onFallback = () => {
      if (this.state !== 'playing') return;
      this.hud.toast(this.embedded
        ? 'EMBED BLOCKS MOUSE CAPTURE — STEER WITH THE CURSOR'
        : 'MOUSE CAPTURE UNAVAILABLE — STEER WITH THE CURSOR');
    };

    this.armoury = new ArmouryScreen(this);
    this.input.onKey = (code) => {
      if (this.state !== 'playing') return;
      if (code === 'KeyR') this.weapons.startReload(this.time);
      if (code === 'Digit1') this.weapons.select(0, this.time);
      if (code === 'Digit2') this.weapons.select(1, this.time);
      if (code === 'Digit3') this.weapons.select(2, this.time);
      if (code === 'Digit4') this.weapons.select(3, this.time);
      if (code === 'KeyQ') this.weapons.cycle(1, this.time);
      if (code === 'KeyB') this.openArmoury();
      if (code === 'KeyF' || code === 'KeyV') this.weapons.startMelee(this.time);
      if (code === 'KeyG' && this.cookStart < 0 && this.nades > 0 && !this.player.dead) {
        this.cookStart = this.time;          // pin is out; the fuse is running
        audio.pinPull();
      }
      if (code === 'KeyM') {
        this.settings.muted = !this.settings.muted;
        this.applySettings();
        this.saveSettings();
        this.hud.toast(this.settings.muted ? 'AUDIO MUTED' : 'AUDIO ON');
      }
    };

    this.input.onKeyUp = (code) => {
      if (code === 'KeyG' && this.cookStart >= 0) this.throwGrenade();
    };
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    // post targets are sized in drawing-buffer pixels, which the pixel ratio
    // moves as well as the window does
    this.renderer.getDrawingBufferSize(SIZE);
    this.post.setSize(SIZE.x, SIZE.y);
  }

  // ------------------------------------------------------------ run control
  /** The briefing card: who you are, what Carrow is, what the job is. */
  brief() {
    if (this.state !== 'menu') return this.startRun();
    audio.init();
    audio.resume();
    document.getElementById('brief-text').innerHTML = BRIEFING.map((p) => `<p>${p}</p>`).join('');
    document.getElementById('brief-acts').innerHTML = ACTS.map((a, i) => {
      const to = i + 1 < ACTS.length ? ACTS[i + 1].from - 1 : FINALE;
      return `<li><b>${a.title} &middot; ${a.name}</b>WAVES ${a.from}&ndash;${to}</li>`;
    }).join('');
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('briefing').classList.remove('hidden');
    this.state = 'briefing';
  }

  startRun() {
    audio.init();
    audio.resume();

    for (const e of this.enemies) { e.group.visible = false; this._recycle(e); }
    this.enemies.length = 0;
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups.length = 0;
    this.effects.reset();
    this.grenades.reset();
    this.objectives.reset();
    this.kit = freshKit();          // what the armoury has fitted this run
    this.scrip = 0;                 // what there is to spend there
    this.scoreSeen = 0;
    this.maxNades = 5;
    this.nades = 3;
    this.cookStart = -1;
    this.nextAmbience = 10;

    this.player.reset(INSERTION.x, INSERTION.z);
    this.player.onStep = () => audio.step(this.player.crouching);
    this.player.onMantle = () => { audio.mantle(); this.player.addShake(0.08); };
    this.player.onFallDamage = (amount) => {
      this.player.addShake(0.4);
      this.damagePlayer(amount, null);
    };
    this.weapons.reset();
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.wave = 0;
    this.pendingSpawns = 0;
    this.spawnQueue.length = 0;
    this.waveClearedAt = 0;
    this.waveHpScale = 1;
    this.autoStart = 0;
    this.autoFrames = 0;
    this.bossPending = false;
    this.boss = null;
    this.objectivesSecured = 0;
    this.objectivesLost = 0;
    this.objectiveCue = null;
    this.nextHostileThrow = 0;
    this.playerRoom = null;
    this.playerExposed = false;
    this.pushCalled = -1;
    this.runStart = this.time;

    // The operation: which act it has reached, what has been done for it,
    // and whether the convoy is out — after which the run is endless.
    this.op = { act: 0, complete: false, relay: 0, rescue: 0, hunt: 0, sabotage: 0, cache: 0, hold: 0, extraction: 0 };
    this.lure = null;
    this.hud.clearRadio();
    this.hud.onRadio = () => audio.radio();

    document.getElementById('menu').classList.add('hidden');
    document.getElementById('briefing').classList.add('hidden');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.hud.show(true);
    audio.startAmbience();
    this.state = 'playing';
    this.input.requestLock();
    this.nextWaveAt = this.time + 3;
    this.hud.banner('OPERATION ASHFALL', 'CARROW &middot; SECTOR 7');
    this.say(RADIO.deploy);
  }

  /** Whether the armoury can be opened now: between waves, the sector clear. */
  get armouryOpen() {
    return this.state === 'playing' && !this.player.dead && this.wave > 0
      && !!this.waveClearedAt && this.aliveCount === 0;
  }

  /**
   * Open the armoury. It stops the clock — the intermission waits — and lets
   * go of the mouse, which would otherwise pause the game behind it.
   */
  openArmoury() {
    if (!this.armouryOpen) return false;
    this.state = 'armoury';
    this.armoury.show(true);
    this.input.keys.clear();
    this.input.fire = false;
    this.input.exitLock();
    return true;
  }

  closeArmoury() {
    if (this.state !== 'armoury') return;
    this.armoury.show(false);
    this.state = 'playing';
    this.input.requestLock();
  }

  onPurchase() {
    audio.pickup();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    document.getElementById('pause').classList.remove('hidden');
  }

  resume() {
    if (this.state !== 'paused') return;
    document.getElementById('pause').classList.add('hidden');
    this.state = 'playing';
    this.input.requestLock();
  }

  toMenu() {
    this.state = 'menu';
    audio.stopAmbience();
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('briefing').classList.add('hidden');
    document.getElementById('menu').classList.remove('hidden');
    this.hud.show(false);
    this.input.exitLock();
  }

  gameOver() {
    this.state = 'dead';
    audio.death();
    audio.stopAmbience();
    this.input.exitLock();

    const beatScore = this.score > this.records.bestScore;
    const beatWave = this.wave > this.records.bestWave;
    this.records.bestScore = Math.max(this.records.bestScore, this.score);
    this.records.bestWave = Math.max(this.records.bestWave, this.wave);
    this.saveRecords();
    this.showRecords();
    const acc = this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    const mins = Math.floor((this.time - this.runStart) / 60);
    const secs = Math.floor((this.time - this.runStart) % 60).toString().padStart(2, '0');
    setTimeout(() => {
      const op = this.op || {};
      const act = actFor(Math.max(1, this.wave));
      const tally = [['RELAYS', op.relay], ['HOLDOUTS OUT', op.rescue], ['LIEUTENANTS', op.hunt], ['DUMPS', op.sabotage]]
        .map(([k, v]) => `${k} <b>${v || 0}</b>`).join(' &middot; ');
      document.getElementById('debrief').innerHTML =
        `<div>OPERATION ASHFALL &mdash; ${op.complete ? 'COMPLETE &middot; HELD TO WAVE ' + this.wave : act.title + ' &middot; ' + act.name}</div>` +
        `<div class="tally">${tally}</div>` +
        `<div class="quote">&ldquo;${pickLine(RADIO.dead, this.wave)}&rdquo;</div>`;
      document.getElementById('stats').innerHTML =
        `<div>WAVE REACHED <b>${this.wave}</b></div>` +
        `<div>SCORE <b>${this.score.toLocaleString()}</b></div>` +
        `<div>KILLS <b>${this.kills}</b> &middot; HEADSHOTS <b>${this.headshots}</b></div>` +
        `<div>ACCURACY <b>${acc}%</b> &middot; SURVIVED <b>${mins}:${secs}</b></div>` +
        `<div>OBJECTIVES <b>${this.objectivesSecured}</b>` +
        (this.objectivesLost ? ` &middot; LOST <b>${this.objectivesLost}</b>` : '') + '</div>' +
        (beatScore || beatWave ? '<div class="record">NEW PERSONAL BEST</div>' : '');
      document.getElementById('gameover').classList.remove('hidden');
      this.hud.show(false);
    }, 1600);
  }

  // ----------------------------------------------------------------- waves
  get aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (e.alive && !e.type.friendly) n++;
    return n;
  }

  startWave() {
    this.wave++;
    const w = this.wave;
    const total = Math.min(5 + Math.round(w * 1.9), 28);
    const queue = [];
    for (let i = 0; i < total; i++) {
      let type = 'scavenger';
      const r = Math.random();
      if (w >= 5 && r < 0.09 + w * 0.008) type = 'brute';
      else if (w >= 4 && r < 0.22) type = 'marksman';
      else if (w >= 3 && r < 0.42) type = 'shotgunner';
      else if (w >= 2 && r < 0.66) type = 'raider';
      queue.push(type);
    }
    this.bossPending = w % 5 === 0;      // a warlord closes out every fifth wave
    this.spawnQueue = queue;
    this.pendingSpawns = queue.length;
    this.waveHpScale = 1 + (w - 1) * 0.09;
    this.nextSpawnAt = this.time;

    const kind = objectiveForWave(w, this.op?.complete);
    if (kind) this.cueObjective(kind, 6);

    const unlocked = this.weapons.unlockForWave(w);
    audio.wave();
    // the act it is, on the wave that opens one, and the handler's call
    const act = actFor(w);
    const count = this.bossPending ? `${total} HOSTILES &middot; WARLORD` : `${total} HOSTILES`;
    this.hud.banner('WAVE ' + w, act.opens && !act.endless ? `${act.title} &middot; ${act.name} &middot; ${count}` : count);
    if (this.op) this.op.act = act.act;
    if (act.opens && !act.endless) this.say(RADIO.act[act.act]);
    if (w > FINALE) this.say(RADIO.waveEndless, w);
    else if (RADIO.wave[w]) this.say(RADIO.wave[w]);
    if (unlocked.length) setTimeout(() => this.hud.toast('WEAPON RECOVERED: ' + unlocked.join(', ')), 1200);
  }

  /**
   * Objectives are cued a few seconds behind whatever triggered them, so the
   * call comes in after the wave banner has cleared rather than under it.
   *
   * Only one runs at a time. A cue that arrives while one is still up waits
   * for it rather than being dropped — objectives outlive the wave that
   * called them, and dropping meant a whole wave could quietly pass without
   * one — but it gives up after a while rather than arriving three waves late.
   */
  cueObjective(kind, delay) {
    this.objectiveCue = { kind, at: this.time + delay, until: this.time + delay + 60 };
  }

  updateWaves(dt) {
    const cue = this.objectiveCue;
    if (cue && this.time >= cue.at) {
      if (this.time > cue.until) this.objectiveCue = null;
      else if (!this.objectives.active) {
        this.objectiveCue = null;
        this.objectives.start(cue.kind);
      }
    }

    if (this.spawnQueue.length === 0 && this.pendingSpawns === 0 && !this.bossPending) {
      if (this.wave === 0) {
        if (this.time >= this.nextWaveAt) this.startWave();
      } else if (this.aliveCount === 0) {
        if (!this.waveClearedAt) {
          this.waveClearedAt = this.time;
          const bonus = 250 * this.wave;
          this.score += bonus;
          this.hud.banner('SECTOR CLEAR', `+${bonus} &middot; B FOR THE ARMOURY`);
          this.say(RADIO.clear, this.wave);
          this.weapons.addAmmo(0.3, true);
          this.hud.toast('AMMO RESUPPLY');
        } else if (this.time - this.waveClearedAt > 7) {
          this.waveClearedAt = 0;
          this.startWave();
        }
      }
      return;
    }

    // trickle hostiles in so the map never pops 30 bodies at once
    const maxAlive = Math.min(8 + this.wave * 2, 18);
    if (this.spawnQueue.length && this.time >= this.nextSpawnAt && this.aliveCount < maxAlive) {
      const type = this.spawnQueue.shift();
      this.spawnEnemy(type);
      this.pendingSpawns = this.spawnQueue.length;
      this.nextSpawnAt = this.time + randRange(0.25, 0.9);
    }

    if (this.bossPending && this.spawnQueue.length === 0 && this.aliveCount <= 4) {
      this.bossPending = false;
      this.spawnEnemy('brute', true);
      audio.wave();
      this.hud.banner('WARLORD', 'ELITE HOSTILE INBOUND');
      this.say(RADIO.warlord);
    }
  }

  _recycle(e) {
    (this.pool[e.typeKey] ||= []).push(e);
  }

  /**
   * Find open ground for a hostile: a clear spot at arm's length from the
   * player, preferring somewhere they cannot currently see.
   */
  findSpawnPoint(minD = 26, maxD = 62) {
    const p = this.player.position;
    const lim = this.world.bounds - 3;
    let fallback = null;
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = randRange(minD, maxD);
      const x = p.x + Math.cos(a) * d;
      const z = p.z + Math.sin(a) * d;
      if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
      if (this.world.occupied(x, z, 1.2, 0.6)) continue;   // no spawning inside geometry
      fallback = fallback || { x, z };
      if (!this.world.lineOfSight(x, 1.5, z, p.x, p.y, p.z)) return { x, z };
      if (i > 40) return { x, z };
    }
    return fallback || { x: p.x + randRange(-20, 20), z: p.z + randRange(-20, 20) };
  }

  /**
   * The room the player is in — on its floor, up its stairwell or on its
   * roof — or null.
   */
  roomAt(x, feet, z) {
    if (this.playerStair && this.playerStair.stair.room) return this.playerStair.stair.room;
    for (const r of this.world.rooms) {
      if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ && feet < r.ceiling - 1) return r;
    }
    return null;
  }

  /**
   * A place outside the building the player is in, covering one of its
   * doorways: 8 or 11 m out along the door's normal and up to 3 m to the
   * side, on open ground at street level, with a sight line from a
   * standing head into the doorway. At most two hostiles hold posts on a
   * building at once — the rest come in after the player, which is what
   * flushes them out toward the posts. A hostile keeps its post until the
   * player leaves the building or reloads (`Enemy.update`).
   */
  coverPost(e) {
    const room = this.playerRoom;
    if (!room) return null;
    // Up its stairwell or on its roof, the doors that matter are the stair's:
    // a post in the shop covering the door they will come down through. A
    // post on the stair is kept when they come back down into the shop,
    // which is the point of it; a post on a street door is not kept while
    // they are up, because it watches nothing they can come out of.
    const up = this.playerStair && this.playerStair.stair.room === room ? this.playerStair.stair : null;
    if (e.post && e.post.room === room && (!up || e.post.stair)) return e.post;
    const x = e.pos.x, z = e.pos.z, at = this.player.position;
    // one already in with them, or nearly, keeps on coming — unless they are
    // up the stair, where in the shop is where the post is
    if (!up && ((x > room.minX && x < room.maxX && z > room.minZ && z < room.maxZ) || Math.hypot(x - at.x, z - at.z) < 10)) return null;
    const posts = up ? (up.posts || (up.posts = this._stairPostsFor(up, room))) : (room.posts || (room.posts = this._postsFor(room)));
    const taken = new Set();
    for (const o of this.enemies) if (o !== e && o.alive && o.post && o.post.room === room) taken.add(o.post);
    if (taken.size >= 2) return null;
    // Only a post it can walk straight to: a post across the block is
    // reached by the route field, which leads to the player and so in at
    // the door. A stair post is the exception — up a stair, the field leads
    // to the stair's foot, and the post is beside it.
    let best = null, bd = up ? 60 : 30;
    for (const p of posts) {
      if (taken.has(p)) continue;
      const d = Math.hypot(p.x - e.pos.x, p.z - e.pos.z);
      if (d < bd && (up || this.nav.clearLine(e.pos.x, e.pos.z, p.x, p.z))) { bd = d; best = p; }
    }
    return best;
  }

  /**
   * Places on a shop's floor covering the door of its stairwell: 2.5 to 7 m
   * from it, anywhere in front of it — in a 10 m shop the door opens toward
   * a wall less than 3 m off, so straight out from it is out of the room —
   * clear of the shaft and the furniture, with a standing sight line into
   * the door.
   */
  _stairPostsFor(stair, room) {
    const w = this.world, out = [];
    const a = stair.path[0], b = stair.path[1];
    const nl = Math.hypot(a.x - b.x, a.z - b.z), nx = (a.x - b.x) / nl, nz = (a.z - b.z) / nl;
    // the door is in the shaft's wall, a third of the way from the lobby out
    const dx = b.x + (a.x - b.x) * 0.32, dz = b.z + (a.z - b.z) * 0.32;
    const q = stair.shaft;
    for (const reach of [2.5, 4, 5.5, 7]) {
      for (let k = 0; k < 16; k++) {
        const t = (k / 16) * Math.PI * 2, ox = Math.cos(t), oz = Math.sin(t);
        if (ox * nx + oz * nz < 0.15) continue;                 // in front of the door
        const x = dx + ox * reach, z = dz + oz * reach;
        if (x < room.minX + 0.8 || x > room.maxX - 0.8 || z < room.minZ + 0.8 || z > room.maxZ - 0.8) continue;
        if (x > q.minX - 0.4 && x < q.maxX + 0.4 && z > q.minZ - 0.4 && z < q.maxZ + 0.4) continue;
        const floor = w.groundHeight(x, z, SUPPORT_RADIUS, room.floor + 0.5);
        if (Math.abs(floor - room.floor) > 0.05 || w.blocked(x, z, 0.6, floor + 0.9) || this.nav.solidAt(x, z)) continue;
        if (!w.lineOfSight(x, floor + 1.5, z, b.x, room.floor + 1.2, b.z)) continue;
        const post = { x, z, wx: dx, wz: dz };
        Object.defineProperty(post, 'room', { value: room, enumerable: false });
        Object.defineProperty(post, 'stair', { value: stair, enumerable: false });
        out.push(post);
      }
    }
    return out;
  }

  _postsFor(room) {
    const w = this.world, out = [];
    for (const d of room.doors) {
      const ix = d.x - d.nx * 1.0, iz = d.z - d.nz * 1.0;
      for (const along of [8, 11]) {
        for (const side of [0, -3, 3]) {
          const x = d.x + d.nx * along - d.nz * side, z = d.z + d.nz * along + d.nx * side;
          if (Math.abs(x) > w.bounds - 2 || Math.abs(z) > w.bounds - 2) continue;
          const floor = w.groundHeight(x, z, SUPPORT_RADIUS, 0.6);
          if (floor > 0.5 || w.blocked(x, z, 0.7, floor + 0.9) || w.occupied(x, z, 0.6, floor + 0.6)) continue;
          if (this.nav.solidAt(x, z)) continue;
          if (!w.lineOfSight(x, floor + 1.5, z, ix, room.floor + 1.2, iz)) continue;
          const post = { door: d, x, z, wx: d.x, wz: d.z };
          Object.defineProperty(post, 'room', { value: room, enumerable: false });
          out.push(post);
        }
      }
    }
    return out;
  }

  /** The first hostile to push on a reload calls it, once per reload. */
  onPush(e) {
    if (this.pushCalled === this.exposures) return;
    this.pushCalled = this.exposures;
    audio.enemyAlert({ x: e.pos.x, y: e.pos.y + 1.5, z: e.pos.z });
  }

  /** A hostile's frag is out: it is heard from where it was thrown. */
  onHostileThrow(e) {
    audio.enemyAlert({ x: e.pos.x, y: e.pos.y + 1.5, z: e.pos.z });
  }

  /** Pull a hostile that has wedged itself in geometry and drop it back in. */
  relocateEnemy(enemy) {
    // perch-users go back to high ground rather than the street
    const spot = (enemy.type.perch && this.findPerch(true)) || { ...this.findSpawnPoint(22, 45), y: 0 };
    const { x, z } = spot;
    enemy.pos.set(x, spot.y || 0, z);
    enemy.vel.set(0, 0, 0);
    enemy.mantle = null;
    enemy.stair = null;
    enemy.onFloor = null;
    enemy.post = null;
    enemy.group.position.copy(enemy.pos);
    // the watchdog now has to judge the next window from where it landed, not
    // from where it was pulled out of
    enemy.markWatchdog(this.player);
  }

  /**
   * A high, unoccupied vantage point far enough from the player to matter.
   *
   * `overlooking` asks for one with a line to the player. That is what a
   * relocation wants — it is moving a marksman precisely because the roof it
   * is on shows it nothing — but not what a spawn wants, where the same
   * preference means every sniper of every wave opens with a clear shot.
   * Measured over seven four-minute runs, spending it at spawn as well put
   * the damage the sector deals up by about half again on its own.
   */
  findPerch(overlooking = false) {
    const all = this.windowPerches?.length ? [...this.perches, ...this.windowPerches] : this.perches;
    if (!all.length) return null;
    const p = this.player.position;
    const candidates = all.filter((q) => {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 16 || d > 95) return false;      // within its detection range
      return !this.enemies.some((e) => e.alive && Math.hypot(e.pos.x - q.x, e.pos.z - q.z) < 3);
    });
    if (!candidates.length) return null;
    // Moving a marksman off a roof it can see nothing from, onto another roof
    // it can see nothing from, is most of a coin flip — and a wave whose last
    // hostile is a blind sniper then waits out the watchdog once per perch
    // until it gets lucky.
    const withView = overlooking
      ? candidates.filter((q) => this.world.lineOfSight(q.x, q.y + 1.5, q.z, p.x, p.y, p.z))
      : [];
    const from = withView.length ? withView : candidates;
    return from[(Math.random() * from.length) | 0];
  }

  /**
   * One window a building, on any of its floors, for a marksman to stand
   * back from: the one that sees most of the street — sample points out to
   * 50 m along and either side of the way it faces. A window onto a
   * junction sees down two streets, so it wins without being told to.
   * Each stands a metre in from the glass (`WINDOW_PERCH.back`), on floor
   * with nothing in the way and headroom for a body, and is a perch like
   * any other: the hostile on it holds it.
   */
  findWindowPerches() {
    const w = this.world, out = [];
    const byStair = new Map();
    for (const f of w.floors) {
      if (!f.stair) continue;
      let a = byStair.get(f.stair);
      if (!a) byStair.set(f.stair, a = []);
      a.push(f);
    }
    const { back, eye, rays, least } = WINDOW_PERCH;
    for (const floors of byStair.values()) {
      let best = null;
      for (const f of floors) {
        for (const win of f.windows) {
          const x = win.x - win.nx * back, z = win.z - win.nz * back;
          const floor = w.groundHeight(x, z, SUPPORT_RADIUS, f.floor + 0.5);
          if (Math.abs(floor - f.floor) > 0.05 || w.blocked(x, z, 0.5, floor + 0.9)) continue;
          if (w.ceilingAbove(x, z, 0.5, floor + 0.9) < floor + 2.2) continue;
          const ey = floor + eye;
          let seen = 0;
          for (const a of rays.turn) {
            const c = Math.cos(a), s = Math.sin(a);
            const dx = win.nx * c - win.nz * s, dz = win.nz * c + win.nx * s;
            for (const d of rays.out) {
              const tx = win.x + dx * d, tz = win.z + dz * d;
              if (Math.abs(tx) > w.bounds - 1 || Math.abs(tz) > w.bounds - 1) continue;
              const ty = w.groundHeight(tx, tz, SUPPORT_RADIUS, 0.6) + 1.0;
              if (w.lineOfSight(x, ey, z, tx, ty, tz)) seen++;
            }
          }
          // the higher floor of two that see the same
          if (seen >= least && (!best || seen > best.seen || (seen === best.seen && floor > best.y))) {
            best = { x, y: floor, z, seen, wx: win.x, wz: win.z };
          }
        }
      }
      if (best) out.push(best);
    }
    return out;
  }

  spawnEnemy(typeKey, elite = false) {
    let x, z, y = 0;
    const perch = ENEMY_TYPES[typeKey].perch && !elite ? this.findPerch() : null;
    if (perch) {
      ({ x, z } = perch);
      y = perch.y;
    } else {
      ({ x, z } = this.findSpawnPoint());
    }

    const pooled = this.pool[typeKey];
    const e = (pooled && pooled.length) ? pooled.pop() : new Enemy(typeKey, this.scene, this);
    this.dress(e.group);
    e.spawn(x, z, this.waveHpScale * (elite ? 2.6 : 1), y);
    if (elite) {
      e.applyElite(true);
      this.boss = e;
    }
    this.enemies.push(e);
    return e;
  }

  // ----------------------------------------------------------- objectives
  /** A line from the handler, picked by `n` so the same run says the same thing. */
  say(lines, n = 0, d = 0) {
    if (lines && lines.length) this.hud.radio(radioLine(lines, n, d));
  }

  /** An objective has gone live: the handler calls it, with how far. */
  onObjectiveStart(obj) {
    const lines = RADIO.objective[obj.kind];
    // a beacon put up in place of something the city had nowhere for says so
    // and a holdout up a building says which way in
    if (lines) {
      const say = obj.instead && lines.instead ? lines.instead : obj.upstairs && lines.upstairs ? lines.upstairs : lines.start;
      this.say(say, this.objectivesSecured + this.wave, obj.dist);
    }
  }

  /** It has moved on a stage: a charge armed, a holdout cut loose. */
  onObjectiveStage(obj) {
    const lines = RADIO.objective[obj.kind];
    if (lines?.stage) this.say(lines.stage, 0, obj.dist);
  }

  /**
   * What finishing one pays. The scale is deliberately above a wave clear
   * bonus: crossing the sector under fire should beat holding the plaza.
   */
  onObjectiveSecured(obj) {
    const w = Math.max(1, this.wave);
    const payout = OBJECTIVE_PAY[obj.kind] * w;
    this.score += payout;
    this.objectivesSecured++;
    if (this.op) this.op[obj.kind] = (this.op[obj.kind] || 0) + 1;
    audio.objectiveDone();
    this.say(RADIO.objective[obj.kind]?.done, this.objectivesSecured);

    if (obj.kind === 'relay') {
      this.weapons.addAmmo(0.3, true);
      this.player.heal(25);
      this.hud.banner('RELAY RESTORED', `+${payout}`);
      return;
    }
    if (obj.kind === 'sabotage') {
      this.weapons.addAmmo(0.4, true);
      this.nades = Math.min(this.maxNades, this.nades + 1);
      this.hud.banner('DUMP DESTROYED', `+${payout}`);
      return;
    }
    if (obj.kind === 'hunt') {
      this.weapons.addAmmo(0.4, true);
      this.nades = Math.min(this.maxNades, this.nades + 2);
      this.hud.banner('LIEUTENANT DOWN', `+${payout} &middot; HIS KIT IS YOURS`);
      return;
    }
    if (obj.kind === 'rescue') {
      this.weapons.addAmmo(0.35, true);
      this.player.heal(50);
      this.hud.banner('HOLDOUT OUT', `+${payout}`);
      return;
    }
    if (obj.kind === 'convoy') {
      // the operation is over; the run is not
      this.weapons.addAmmo(0.6, true);
      this.nades = this.maxNades;
      this.player.heal(this.player.maxHealth);
      if (this.op && !this.op.complete) {
        this.op.complete = true;
        this.hud.banner('OPERATION COMPLETE', `+${payout} &middot; HOLD AS LONG AS YOU CAN`);
        this.say(RADIO.complete);
      } else {
        this.hud.banner('CONVOY OUT', `+${payout}`);
      }
      return;
    }

    if (obj.kind === 'cache') {
      this.weapons.addAmmo(0.5, true);
      const frags = Math.min(2, this.maxNades - this.nades);
      this.nades += frags;
      this.hud.banner('CACHE SECURED', `+${payout} &middot; RESUPPLIED`);
      this.hud.toast(frags ? `AMMO + FRAG &times;${frags}` : 'AMMO RESUPPLY');
    } else if (obj.kind === 'hold') {
      this.weapons.addAmmo(0.35, true);
      this.player.heal(35);
      this.hud.banner('BEACON HELD', `+${payout}`);
    } else {
      this.weapons.addAmmo(0.6, true);
      this.nades = this.maxNades;
      this.player.heal(this.player.maxHealth);
      this.hud.banner('EVAC COMPLETE', `+${payout} &middot; FULL REARM`);
    }
  }

  onObjectiveLost(obj) {
    this.objectivesLost++;
    audio.objectiveFail();
    this.hud.toast((obj.label || obj.def.label) + ' LOST');
    this.say(RADIO.objective[obj.kind]?.lost, this.objectivesLost);
  }

  // --------------------------------------------------------------- combat
  applyRecoil(v, h) { this.player.applyRecoil(v, h); }

  /**
   * Gunfire carries: anything close enough to hear the shot comes looking,
   * and anything in the ring past that hears it faintly and turns its head.
   */
  alertNearby(radius) {
    const p = this.player.position;
    for (const e of this.enemies) {
      if (!e.alive || e.alerted) continue;
      const d2 = (e.pos.x - p.x) ** 2 + (e.pos.z - p.z) ** 2;
      if (d2 < radius * radius) e.alert();
      else if (d2 < 4 * radius * radius) e.hear(p.x, p.z, this.time);
    }
  }

  /** One bullet. `dir` is already spread-jittered. */
  hitscan(dir, def) {
    this.shotsFired += def.pellets > 1 ? 1 / def.pellets : 1;

    RAY.set(this.camera.position, dir);
    RAY.far = def.range;

    const enemyMeshes = [];
    // a holdout is not a target: the round goes past them
    for (const e of this.enemies) if (e.alive && !e.type.friendly) enemyMeshes.push(...e.hitMeshes);

    const hitsE = RAY.intersectObjects(enemyMeshes, false);
    const hitsW = RAY.intersectObjects(this.world.solids, false);
    const hitE = hitsE[0];
    const hitW = hitsW[0];

    const muzzle = this.weapons.muzzleWorld(V1).clone();
    let end = V2.copy(this.camera.position).addScaledVector(dir, def.range).clone();

    if (hitE && (!hitW || hitE.distance < hitW.distance)) {
      const enemy = hitE.object.userData.enemy;
      const zone = hitE.object.userData.zone;
      end = hitE.point.clone();

      let dmg = def.damage * EFFECT.rifling[this.kit.rifling];
      if (zone === 'head') dmg *= def.headMult;
      if (def.falloff) {
        dmg *= THREE.MathUtils.clamp(1 - (hitE.distance - 8) / def.falloff, 0.3, 1);
      }
      const result = enemy.damage(dmg, zone, dir, hitE.point);
      this.shotsHit += def.pellets > 1 ? 1 / def.pellets : 1;
      this.registerHit(enemy, result, def.name.split(' ')[0], zone === 'head');
    } else if (hitW) {
      end = hitW.point.clone();
      const n = hitW.face ? hitW.face.normal.clone().transformDirection(hitW.object.matrixWorld) : dir.clone().negate();
      this.effects.impact(end, n);
      audio.impact(end);
    } else {
      this.effects.impact(end, dir.clone().negate(), 'soft');
    }

    // start the streak down-range: a tracer drawn from the lens itself
    // reads as a blob smeared over the middle of the screen
    const tStart = muzzle.addScaledVector(dir, 1.4);
    if (tStart.distanceTo(end) > 0.6) this.effects.tracer(tStart, end, def.tracer);
  }

  /** Release a cooked grenade. A fuse run down to zero goes off in hand. */
  throwGrenade() {
    if (this.cookStart < 0) return;
    const cooked = this.time - this.cookStart;
    this.cookStart = -1;
    if (this.nades <= 0) return;
    this.nades--;

    const remaining = FUSE - cooked;
    if (remaining <= 0) {
      // held too long: it detonates where you stand
      this.grenades.dropAtFeet(V1.copy(this.player.position).setY(0.4));
      return;
    }
    this.camera.getWorldDirection(V1);
    this.grenades.throw_(this.camera.position, V1, remaining, this.player.velocity);
  }

  /** Buttstroke: everything in a short cone in front of the player. */
  meleeStrike() {
    this.camera.getWorldDirection(V1);
    let struck = false;
    for (const e of this.enemies) {
      if (!e.alive || e.type.friendly) continue;
      V2.copy(e.pos).setY(e.pos.y + 1.2).sub(this.player.position);
      if (Math.abs(V2.y) > 1.6) continue;                    // out of reach vertically
      V2.y = 0;
      const dist = V2.length();
      if (dist > MELEE_RANGE + e.radius) continue;
      if (V2.normalize().dot(V1) < 0.55) continue;          // outside the swing arc

      const result = e.damage(MELEE_DAMAGE, 'body', V1, V2.copy(e.pos).setY(e.pos.y + 1.2));
      // shove them back so a bash actually buys space
      e.pos.addScaledVector(V1, 1.1);
      struck = true;
      this.registerHit(e, result, 'BASH', false);
    }
    if (struck) {
      audio.meleeHit();
      this.player.addShake(0.16);
    }
  }

  /** Shared bookkeeping for anything that damages a hostile. */
  registerHit(enemy, result, weaponLabel, headshot) {
    if (result === 'kill') {
      this.kills++;
      if (headshot) this.headshots++;
      this.score += Math.round(enemy.scoreValue * (headshot ? 1.5 : 1));
      this.hud.hitmark(true);
      this.hud.kill(enemy.displayName, weaponLabel, headshot);
      if (enemy.elite) {
        this.hud.banner('WARLORD DOWN', `+${enemy.scoreValue}`);
        this.player.addShake(0.2);
        this.cueObjective('extraction', 4);   // the window opens once it drops
      }
      audio.kill();
      this.maybeDrop(enemy.pos);
    } else if (result === 'hit') {
      this.hud.hitmark(false);
      audio.hitmark();
    }
  }

  /**
   * Frag detonation: damage falls off with distance and needs line of sight.
   * A hostile's frag hurts the player and nobody it was thrown alongside —
   * and credits the player with nothing, which a frag that killed hostiles
   * through `registerHit` would.
   */
  explode(pos, owner = 'player') {
    this.effects.explosion(pos);
    audio.explosion(1, pos);

    // Blast is traced from a little above the casing: a grenade resting
    // against a sandbag still throws fragments over it. Cover behind which a
    // target is fully hidden cuts the damage rather than cancelling it.
    const originY = pos.y + 0.75;

    // A blast does not care whose side anyone is on: a holdout caught in one
    // is hurt by it, and nobody is credited.
    for (const e of [...this.enemies]) {
      if (!e.alive) continue;
      const friendly = !!e.type.friendly;
      if (owner === 'hostile' && !friendly) continue;
      const dist = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z, (e.pos.y + 1) - pos.y);   // aim at the chest
      if (dist > BLAST_RADIUS) continue;

      const exposed = this.world.lineOfSight(pos.x, originY, pos.z, e.pos.x, e.pos.y + 1.15, e.pos.z);
      const falloff = Math.pow(THREE.MathUtils.clamp(1 - dist / BLAST_RADIUS, 0, 1), 1.6);
      V1.set(e.pos.x - pos.x, 0, e.pos.z - pos.z).normalize();
      const result = e.damage(BLAST_DAMAGE * falloff * (exposed ? 1 : 0.4),
        'body', V1, V2.copy(e.pos).setY(e.pos.y + 1.2));
      e.pos.addScaledVector(V1, falloff * 1.4);
      if (!friendly) this.registerHit(e, result, owner === 'charge' ? 'CHARGE' : 'FRAG', false);
    }

    // the player is not exempt from their own grenade
    const pd = this.player.position.distanceTo(pos);
    if (pd < BLAST_RADIUS) {
      const exposed = this.world.lineOfSight(pos.x, originY, pos.z,
        this.player.position.x, this.player.position.y, this.player.position.z);
      const falloff = Math.pow(THREE.MathUtils.clamp(1 - pd / BLAST_RADIUS, 0, 1), 1.6);
      this.player.addShake(0.35 + falloff * 0.65);
      this.damagePlayer(BLAST_DAMAGE * 0.55 * falloff * (exposed ? 1 : 0.4), pos);
    } else if (pd < BLAST_RADIUS * 2.5) {
      this.player.addShake(0.25 * (1 - pd / (BLAST_RADIUS * 2.5)));
    }
  }

  maybeDrop(pos) {
    const r = Math.random();
    let kind = null;
    if (r < 0.26) kind = 'ammo';
    else if (r < 0.36) kind = 'health';
    else if (r < 0.46 && this.nades < this.maxNades) kind = 'frag';
    else if (this.player.health < 45 && r < 0.66) kind = 'health';
    if (!kind) return;

    // It floats over the floor under where the hostile fell: the pavement or
    // a ruin's courtyard, not the street beneath them, or the floor of the
    // building it was killed on. Never a roof, though — a marksman's drop has
    // always landed at street level under its perch, and that is half of
    // what makes killing one pay.
    const up = this.world.stairAt(pos.x, pos.y, pos.z);
    const floor = this.world.groundHeight(pos.x, pos.z, SUPPORT_RADIUS, up && up.floor ? up.floor.y + 0.5 : 0.5);
    // A clone shares the geometry and the materials; only the nodes are new,
    // and each spends draws of the stream on UUIDs. So it is minted in a
    // `reserve` and pays what a drop of this kind always cost, and a drop can
    // change shape without moving every spawn after it.
    const mesh = reserve(() => this.pickupProto[kind].clone());
    spend(DROP_COST[kind]);
    this.dress(mesh);
    mesh.position.set(pos.x, floor + 0.45, pos.z);
    this.scene.add(mesh);
    this.pickups.push({ kind, mesh, active: true, born: this.time, floor });
  }

  updatePickups(dt) {
    // the halos breathe together, which is what makes one catch the eye
    if (this.haloMats) for (const m of this.haloMats) m.opacity = 0.27 + 0.1 * Math.sin(this.time * 3.1);
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.mesh.rotation.y += dt * 1.6;
      const bob = Math.sin((this.time + p.born) * 2.4) * 0.07;
      p.mesh.position.y = p.floor + 0.42 + bob;
      // the halo stays on the floor while the drop bobs over it
      for (const c of p.mesh.children) if (c.userData.halo) c.position.y = 0.012 - 0.42 - bob;

      const dx = p.mesh.position.x - this.player.position.x;
      const dz = p.mesh.position.z - this.player.position.z;
      // and on the same floor: a drop on a floor of a building is not taken
      // from the street under it
      if (dx * dx + dz * dz < 2.0 && Math.abs(p.floor - this.player.feetY) < 2.0) {
        let taken = false;
        if (p.kind === 'ammo') {
          taken = this.weapons.addAmmo(0.30, true);
          if (taken) this.hud.toast('AMMO +');
        } else if (p.kind === 'frag') {
          if (this.nades < this.maxNades) {
            this.nades++;
            this.hud.toast('FRAG +1');
            taken = true;
          }
        } else {
          if (this.player.health < this.player.maxHealth) {
            this.player.heal(40);
            this.hud.toast('MEDKIT +40');
            taken = true;
          }
        }
        if (taken) {
          audio.pickup();
          this.scene.remove(p.mesh);
          this.pickups.splice(i, 1);
          continue;
        }
      }
      if (this.time - p.born > 45) {
        this.scene.remove(p.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  /**
   * A hostile's boot coming down, heard where it came down.
   *
   * A flanker used to be silent until it fired. Its steps are placed at its
   * feet through the same panner as its shots, at a loudness that falls
   * with distance and stops at `FOOTFALL_RANGE`, so a hostile working round
   * behind you is heard behind you. A wave is a crowd, and a crowd's feet
   * are a texture rather than a count: at most `FOOTFALL_VOICES` in any
   * quarter second, nearest first by arrival. Nothing here draws on the
   * seeded stream — the variation between steps is off a counter.
   */
  onFootfall(e) {
    const p = this.player.position;
    const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
    if (d > FOOTFALL_RANGE) return;
    const quarter = Math.floor(this.time * 4);
    if (quarter !== this.footfallQuarter) { this.footfallQuarter = quarter; this.footfallVoices = 0; }
    if (this.footfallVoices >= FOOTFALL_VOICES) return;
    this.footfallVoices++;
    const armour = e.type.kit && e.type.kit.armour;
    audio.footfall(e.pos, Math.min(1, 3.5 / Math.max(1, d)),
      armour === 'heavy' || armour === 'plated', e.pos.y > DECK_HEIGHT, (this.footfallN = (this.footfallN || 0) + 1));
  }

  damagePlayer(amount, fromPos) {
    if (this.state !== 'playing' || this.player.dead) return;
    amount *= EFFECT.armour[this.kit.armour];
    const died = this.player.damage(amount, this.time);
    audio.hurt();

    let angle = null;
    if (fromPos) {
      const dx = fromPos.x - this.player.position.x;
      const dz = fromPos.z - this.player.position.z;
      const yaw = this.player.yaw;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      angle = Math.atan2(rx, -rz);
    }
    this.hud.damage(angle, Math.min(0.6, amount / 40));
    this.player.addShake(Math.min(0.4, amount / 55));
    // a hit shoves the view around
    this.player.applyRecoil(randRange(-0.02, 0.03), randRange(-0.02, 0.02));
    if (died) this.gameOver();
  }

  // ------------------------------------------------------------------ loop
  frame() {
    const began = performance.now();
    // Real time, not slow motion. The step used to be clamped to 50 ms, so
    // under 20 fps the whole game slowed down with the frame rate — walking,
    // falling, hostiles, clocks — and a slow machine felt sluggish twice
    // over. A long frame is now split into steps no longer than that. Past a
    // fifth of a second it is a hitch or a hidden tab rather than a frame
    // rate, and the rest is dropped as it always was.
    const elapsed = Math.min(this.clock.getDelta(), MAX_FRAME);
    const steps = Math.max(1, Math.ceil(elapsed / MAX_STEP - 1e-6));
    const dt = elapsed / steps;

    // Paused, or in the armoury, the clock stops: it used to run on behind
    // the pause screen, so an objective's deadline or the intermission
    // before the next wave ran out while nobody was playing.
    const frozen = this.state === 'paused' || this.state === 'armoury';
    for (let i = 0; i < steps; i++) {
      if (!frozen) this.time += dt;
      if (this.state === 'playing') this.step(dt);
      else if (this.state === 'dead') {
        this.player.update(dt, this.time, this.input);
        for (const e of this.enemies) e.update(dt, this.time, this.player, this.world);
        this.effects.update(dt);
      }
      // the mouse moved once, however many steps the frame took
      this.input.endFrame();
    }
    const stepped = performance.now();
    if (this.state === 'playing') this.autoCalibrate();
    // the ears go where the eyes went this frame
    this.camera.getWorldDirection(V1);
    audio.listen(this.camera.position.x, this.camera.position.y, this.camera.position.z, V1);

    this.hud.tick(elapsed);
    this.flickerFires(elapsed);
    const wind = this.paintedMaterials?.weedMat?.userData.windTime;
    if (wind) wind.value = this.time;
    this.perf.beforeRender();
    this.render();
    const ended = performance.now();
    this.perf.frame(began, stepped, ended);
    this.perf.draw(this, ended);
  }

  step(dt) {
    const input = this.input;

    this.player.update(dt, this.time, input);
    this.weapons.update(dt, this.time, input, this.player);

    if (input.wheel) this.weapons.cycle(input.wheel > 0 ? 1 : -1, this.time);

    // firing
    const w = this.weapons.current;
    if (input.fire && !this.player.dead && !this.player.mantle) {   // both hands on the ledge
      const moving = Math.hypot(this.player.velocity.x, this.player.velocity.z) > 2.5;
      if (this.weapons.fire(this.time, this.camera, moving)) {
        if (!w.def.auto) input.fire = false;
      } else if (w.mag === 0 && !this.weapons.reloading) {
        // an empty mag reloads; an empty gun reaches for one that still works,
        // rather than clicking dry while a loaded rifle sits in the loadout
        if (w.reserve > 0) this.weapons.startReload(this.time);
        else if (this.weapons.switchToArmed(this.time)) this.hud.toast('SWITCHING — DRY');
      }
    }
    // Route field first, so every hostile reads one built from where the
    // player is standing now. It only rebuilds when they cross a cell. Up a
    // stairwell, that is the foot of it: the field is a map of the street,
    // and the street ends at the stair's door (`Enemy._stairWalk`).
    const at = this.player.position;
    this.playerStair = this.world.stairAt(at.x, this.player.feetY, at.z);
    const from = this.playerStair ? this.playerStair.stair.path[0] : at;
    this.nav.update(from.x, from.z);
    // Which building the player has gone into, for the hostiles that cover
    // its doors and throw through them; and whether their gun is out of the
    // fight, which is what the rest push on.
    this.playerRoom = this.roomAt(at.x, this.player.feetY, at.z);
    const ws = this.weapons;
    // every point scored is a point of scrip to spend at the armoury
    if (this.score > this.scoreSeen) { this.scrip += this.score - this.scoreSeen; this.scoreSeen = this.score; }
    const was = this.playerExposed;
    this.playerExposed = !this.player.dead && (ws.reloading || ws.switching > 0);
    if (this.playerExposed && !was) this.exposures = (this.exposures || 0) + 1;
    // a hostile frag landing near enough to matter is called out once
    const frag = this.grenades.hostileLive();
    if (frag && !frag.warned && frag.vel.lengthSq() < 4 && frag.pos.distanceTo(at) < 9) {
      frag.warned = true;
      this.hud.toast('GRENADE');
    }

    // enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, this.time, this.player, this.world);
      if (!e.alive && !e.group.visible) {
        this.enemies.splice(i, 1);
        this._recycle(e);
      }
    }

    // a fuse that runs out while the pin is still in your hand goes off there
    if (this.cookStart >= 0 && this.time - this.cookStart >= FUSE) this.throwGrenade();

    this.grenades.update(dt, this.world);
    this.objectives.update(dt);
    this.updateWaves(dt);
    this.updatePickups(dt);
    this.updateAmbience(dt);
    this.effects.update(dt);
    this.hud.update(this);

    // FOV blends when aiming and when sprinting
    const ads = this.weapons.adsT;
    const sprintBoost = this.player.sprinting ? 4 : 0;
    const wantFov = this.baseFov * THREE.MathUtils.lerp(1, this.weapons.def.adsFovMul * EFFECT.opticsZoom[this.kit.optics], ads) + sprintBoost;
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, wantFov, 12, dt);
      this.camera.updateProjectionMatrix();
    }

    // keep the wide shadow box on the player, and the tight one on the
    // street in front of them: that is where its texels are looked at
    const pp = this.player.position;
    placeShadow(this.sun, SHADOW_AT.set(pp.x, 0, pp.z), this.shadowSpan, this.sun.shadow.mapSize.x);
    if (this.sunNear.castShadow) {
      SHADOW_AHEAD.set(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
      SHADOW_AT.set(pp.x, 0, pp.z).addScaledVector(SHADOW_AHEAD, this.nearSpan * 0.55);
      placeShadow(this.sunNear, SHADOW_AT, this.nearSpan, this.sunNear.shadow.mapSize.x);
    }

    this.sky.position.copy(this.camera.position);
    this.dust.position.set(
      Math.round(this.player.position.x / 30) * 30, 0, Math.round(this.player.position.z / 30) * 30);
  }

  /** Occasional distant firefight, so the sector never feels empty. */
  updateAmbience(dt) {
    this.nextAmbience = (this.nextAmbience ?? 8) - dt;
    if (this.nextAmbience <= 0) {
      this.nextAmbience = randRange(11, 26);
      audio.distantFire();
    }
  }

  /**
   * Light only the fires nearest the player.
   *
   * Every fire barrel carried a point light, and every lit pixel in the city
   * evaluated all of them — ten on seed 1, plus the muzzle flash and the
   * blast, twelve in all — whether it was two metres from a fire or two
   * hundred. A fire's light reaches 14 m. So each tier keeps a fixed number
   * lit (`fires`), handed to whichever barrels are nearest. Fixed matters:
   * the count of visible lights is part of every lit program's key, and
   * changing it would recompile the city mid-run. Which ones are visible is
   * not, so the handover is free.
   */
  placeFireLights(force = false) {
    const fires = this.fireBarrels;
    if (!fires || !fires.length) return;
    const now = this.time;
    if (!force && now - (this.firesPlacedAt ?? -1) < 0.25) return;
    this.firesPlacedAt = now;
    const p = this.player.position;
    const near = [...fires].sort((a, b) =>
      Math.hypot(a.light.position.x - p.x, a.light.position.z - p.z)
      - Math.hypot(b.light.position.x - p.x, b.light.position.z - p.z));
    near.forEach((b, i) => { b.light.visible = i < this.fireLights; });
  }

  /**
   * Put every lit material under `root` into the dress the tier wants: its
   * own, or on the low tier a Lambert twin wearing the same map, colour,
   * vertex shading and fog. PBR against the sky's environment was half the
   * low tier's frame on its own. The twins are built once, inside `reserve`,
   * because each is a material and a material mints a UUID out of the
   * seeded stream; and they share the original's colour objects, so a
   * hostile's band or flash still changes both. Called with the tier, and
   * on anything that joins the scene afterwards (a hostile, a pickup, the
   * bodies shown to the shader compile).
   */
  dress(root) {
    const plain = this.plainMaterials;
    if (!plain && !this.twins) return;
    this.twins = this.twins || new Map();
    reserve(() => root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const m = o.material;
      if (plain && m.isMeshStandardMaterial) o.material = this.twinOf(m);
      else if (!plain && m.userData.pbr) o.material = m.userData.pbr;
    }));
  }

  twinOf(m) {
    let t = this.twins.get(m);
    if (t) return t;
    t = new THREE.MeshLambertMaterial();
    for (const k of TWIN_PROPS) if (m[k] !== undefined) t[k] = m[k];
    t.name = m.name;
    t.userData = { ...m.userData, pbr: m };
    this.twins.set(m, t);
    return t;
  }

  flickerFires(dt) {
    this.placeFireLights();
    for (const b of this.fireBarrels) {
      b.phase += dt * 9;
      // deliberately not random: cosmetic per-frame noise would consume the
      // seeded stream and make an otherwise identical run diverge
      const f = 0.7 + Math.sin(b.phase) * 0.15 + Math.sin(b.phase * 2.7) * 0.12
        + Math.sin(b.phase * 6.1 + 1.7) * 0.06;
      b.light.intensity = b.base * f;
      b.flame.material.opacity = 0.65 + f * 0.3;
      b.flame.scale.set(1.0 + f * 0.25, 1.4 + f * 0.4, 1);
    }
  }

  render() {
    if (this.post.enabled) {
      this.post.render(this.scene, this.camera, this.viewScene, this.viewCamera, this.time);
      return;
    }
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.viewScene, this.viewCamera);
  }
}

// Escape pauses; the browser also drops pointer lock, which pauses anyway.
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && window.__game) {
    const g = window.__game;
    if (g.state === 'paused') g.resume();
  }
});

window.__game = new Game();
