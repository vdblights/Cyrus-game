import * as THREE from 'three';
import { buildCity } from './city.js';
import { Player, Input } from './player.js';
import { WeaponSystem, MELEE_RANGE, MELEE_DAMAGE } from './weapons.js';
import { GrenadeSystem, FUSE, BLAST_RADIUS, BLAST_DAMAGE } from './grenades.js';
import { Effects } from './effects.js';
import { Enemy, ENEMY_TYPES } from './enemies.js';
import { ObjectiveSystem, objectiveForWave } from './objectives.js';
import { HUD } from './hud.js';
import { audio } from './audio.js';
import * as TEX from './textures.js';
import { randRange } from './world.js';
import { initRandom, getSeed } from './rng.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const RAY = new THREE.Raycaster();

class Game {
  constructor() {
    // seed first: everything below this line draws on Math.random()
    this.seed = initRandom();
    this.canvas = document.getElementById('scene');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;

    // ---- world scene ----------------------------------------------------
    this.scene = new THREE.Scene();
    // fog tinted to the sky's horizon, so distance drains colour toward it
    this.scene.fog = new THREE.FogExp2(0x8a6748, 0.0100);
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

    this.setupSky();
    this.setupLights();

    const city = buildCity(this.scene);
    this.world = city.world;
    this.fireBarrels = city.fireBarrels;
    this.perches = city.perches;

    this.effects = new Effects(this.scene);
    this.player = new Player(this.camera, this.world);
    this.weapons = new WeaponSystem(this.viewScene, this);
    this.input = new Input(this.canvas);
    this.hud = new HUD();

    this.grenades = new GrenadeSystem(this.scene, this);
    this.objectives = new ObjectiveSystem(this.scene, this);
    this.nades = 3;
    this.maxNades = 5;
    this.fuseLength = FUSE;
    this.cookStart = -1;

    this.enemies = [];
    this.pool = {};
    this.pickups = [];
    this.setupPickupPrototypes();
    this.setupDust();

    this.state = 'menu';
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
    this.records = this.loadRecords();
    this.collectMaterials();
    this.bindUI();
    addEventListener('resize', () => this.resize());
    this.resize();

    this.clock = new THREE.Clock();
    this.renderer.compile(this.scene, this.camera);
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('start-btn').classList.remove('hidden');
    const seedEl = document.getElementById('seed');
    if (seedEl) seedEl.textContent = 'SECTOR SEED ' + getSeed();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Restart the random stream — used by tests to pin a run exactly. */
  reseed(seed = this.seed) {
    this.seed = initRandom(seed);
    return this.seed;
  }

  // ------------------------------------------------------------------ setup
  setupSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 32, 20),
      new THREE.MeshBasicMaterial({ map: TEX.skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
    );
    this.scene.add(sky);
    this.sky = sky;

    // The sun is placed at the light's own direction rather than painted into
    // the sky, so the shadows always point away from the thing casting them.
    this.sunDir = new THREE.Vector3(-60, 40, -30).normalize();
    const sunGroup = new THREE.Group();

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.sunSprite(), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.5, fog: false,
    }));
    glow.scale.set(230, 230, 1);
    sunGroup.add(glow);

    const disc = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.sunSprite('#fffaf0', '#ffcf8a'), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.9, fog: false,
    }));
    disc.scale.set(52, 52, 1);
    sunGroup.add(disc);

    sunGroup.position.copy(this.sunDir).multiplyScalar(380);
    this.scene.add(sunGroup);
    this.sunSprite = sunGroup;
  }

  setupLights() {
    // low ambient, strong key: faces should separate by which way they point
    this.scene.add(new THREE.HemisphereLight(0x9db4d6, 0x6e6152, 1.25));

    const sun = new THREE.DirectionalLight(0xffc890, 3.0);
    sun.position.set(-60, 40, -30);
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

    // cool bounce from the opposite side so shadowed faces stay readable
    const fill = new THREE.DirectionalLight(0x5f82b8, 0.85);
    fill.position.set(40, 25, 50);
    this.scene.add(fill);

    // a dim upward kick, standing in for light coming back off the pavement
    const bounce = new THREE.DirectionalLight(0x8c8072, 0.18);
    bounce.position.set(10, -20, 10);
    this.scene.add(bounce);
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

  setupPickupPrototypes() {
    this.pickupGeo = {
      ammo: new THREE.BoxGeometry(0.42, 0.26, 0.28),
      health: new THREE.BoxGeometry(0.34, 0.3, 0.26),
      frag: new THREE.IcosahedronGeometry(0.17, 1),
    };
    this.pickupMat = {
      ammo: new THREE.MeshLambertMaterial({ color: 0x8a7a2e, emissive: 0x3a3208 }),
      health: new THREE.MeshLambertMaterial({ color: 0xd8d8d0, emissive: 0x0f2a10 }),
      frag: new THREE.MeshLambertMaterial({ color: 0x4a5a38, emissive: 0x141c0c }),
    };
    this.crossMat = new THREE.MeshBasicMaterial({ color: 0x2ecc40 });
  }

  loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ashfall.settings') || '{}'); } catch { saved = {}; }
    return { sens: 100, fov: 78, volume: 70, muted: false, invertY: false, quality: 'auto', ...saved };
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
      high: { shadows: true, soft: true, shadowSize: 2048, span: 50, normals: true, pixel: 1.75, dust: true },
      medium: { shadows: true, soft: false, shadowSize: 1024, span: 40, normals: true, pixel: 1.4, dust: true },
      low: { shadows: false, soft: false, shadowSize: 512, span: 40, normals: false, pixel: 1, dust: false },
    }[level];

    this.renderer.shadowMap.enabled = cfg.shadows;
    this.renderer.shadowMap.type = cfg.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cfg.pixel));

    if (this.sun.shadow.mapSize.x !== cfg.shadowSize) {
      this.sun.shadow.mapSize.set(cfg.shadowSize, cfg.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;          // three rebuilds it at the new size
    }
    const c = this.sun.shadow.camera;
    c.left = -cfg.span; c.right = cfg.span; c.top = cfg.span; c.bottom = -cfg.span;
    c.updateProjectionMatrix();

    for (const { m, map } of this.normalMapped) m.normalMap = cfg.normals ? map : null;
    for (const m of this.materials) m.needsUpdate = true;   // shadow state is compiled in
    this.dust.visible = cfg.dust;

    this.activeTier = level;
    this.resize();
  }

  /**
   * On 'auto', watch the first seconds of play and step down if the machine
   * is struggling. An explicit choice is never overridden.
   */
  autoCalibrate() {
    if (this.settings.quality !== 'auto' || this.autoDone) return;
    // wall clock, not game time: the loop's dt is clamped, so a machine at
    // 15 fps would otherwise look like 30 and never step down
    const now = performance.now() / 1000;
    if (!this.autoStart) { this.autoStart = now; this.autoFrames = 0; return; }
    this.autoFrames++;
    const elapsed = now - this.autoStart;
    if (elapsed < 3) return;

    const fps = this.autoFrames / elapsed;
    const order = ['high', 'medium', 'low'];
    const at = order.indexOf(this.activeTier || 'high');
    if (fps < 40 && at < order.length - 1) {
      this.autoTier = order[at + 1];
      this.applyQuality();
      this.hud.toast('GRAPHICS: ' + this.autoTier.toUpperCase() + ` (${Math.round(fps)} FPS)`);
      this.autoStart = 0;
    } else {
      this.autoDone = true;
    }
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
  }

  bindUI() {
    const start = () => this.startRun();
    document.getElementById('start-btn').onclick = start;
    document.getElementById('retry-btn').onclick = start;
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

    this.input.onKey = (code) => {
      if (this.state !== 'playing') return;
      if (code === 'KeyR') this.weapons.startReload(this.time);
      if (code === 'Digit1') this.weapons.select(0, this.time);
      if (code === 'Digit2') this.weapons.select(1, this.time);
      if (code === 'Digit3') this.weapons.select(2, this.time);
      if (code === 'Digit4') this.weapons.select(3, this.time);
      if (code === 'KeyQ') this.weapons.cycle(1, this.time);
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
  }

  // ------------------------------------------------------------ run control
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
    this.nades = 3;
    this.cookStart = -1;
    this.nextAmbience = 10;

    this.player.reset(-17, 24);            // the plaza near the middle of the map
    this.player.onStep = () => audio.step(this.player.crouching);
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
    this.runStart = this.time;

    document.getElementById('menu').classList.add('hidden');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.hud.show(true);
    audio.startAmbience();
    this.state = 'playing';
    this.input.requestLock();
    this.nextWaveAt = this.time + 3;
    this.hud.banner('SECTOR 7', 'HOSTILES INBOUND');
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
    for (const e of this.enemies) if (e.alive) n++;
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

    const kind = objectiveForWave(w);
    if (kind) this.cueObjective(kind, 6);

    const unlocked = this.weapons.unlockForWave(w);
    audio.wave();
    this.hud.banner('WAVE ' + w, this.bossPending ? `${total} HOSTILES &middot; WARLORD` : `${total} HOSTILES`);
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
          this.hud.banner('SECTOR CLEAR', `+${bonus} &middot; REARMING`);
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

  /** Pull a hostile that has wedged itself in geometry and drop it back in. */
  relocateEnemy(enemy) {
    // perch-users go back to high ground rather than the street
    const spot = (enemy.type.perch && this.findPerch()) || { ...this.findSpawnPoint(22, 45), y: 0 };
    const { x, z } = spot;
    enemy.pos.set(x, spot.y || 0, z);
    enemy.lastDistCheck = Infinity;
    enemy.vel.set(0, 0, 0);
    enemy.group.position.copy(enemy.pos);
  }

  /** A high, unoccupied vantage point far enough from the player to matter. */
  findPerch() {
    if (!this.perches.length) return null;
    const p = this.player.position;
    const candidates = this.perches.filter((q) => {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 16 || d > 95) return false;      // within its detection range
      return !this.enemies.some((e) => e.alive && Math.hypot(e.pos.x - q.x, e.pos.z - q.z) < 3);
    });
    if (!candidates.length) return null;
    return candidates[(Math.random() * candidates.length) | 0];
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
    e.spawn(x, z, this.waveHpScale * (elite ? 2.6 : 1), y);
    if (elite) {
      e.applyElite(true);
      this.boss = e;
    }
    this.enemies.push(e);
    return e;
  }

  // ----------------------------------------------------------- objectives
  /**
   * What finishing one pays. The scale is deliberately above a wave clear
   * bonus: crossing the sector under fire should beat holding the plaza.
   */
  onObjectiveSecured(obj) {
    const w = Math.max(1, this.wave);
    const payout = { cache: 300, hold: 500, extraction: 750 }[obj.kind] * w;
    this.score += payout;
    this.objectivesSecured++;
    audio.objectiveDone();

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
    this.hud.toast(obj.def.label + ' LOST');
  }

  // --------------------------------------------------------------- combat
  applyRecoil(v, h) { this.player.applyRecoil(v, h); }

  /** Gunfire carries: anything close enough to hear the shot comes looking. */
  alertNearby(radius) {
    for (const e of this.enemies) {
      if (!e.alive || e.alerted) continue;
      const dx = e.pos.x - this.player.position.x, dz = e.pos.z - this.player.position.z;
      if (dx * dx + dz * dz < radius * radius) e.alert();
    }
  }

  /** One bullet. `dir` is already spread-jittered. */
  hitscan(dir, def) {
    this.shotsFired += def.pellets > 1 ? 1 / def.pellets : 1;

    RAY.set(this.camera.position, dir);
    RAY.far = def.range;

    const enemyMeshes = [];
    for (const e of this.enemies) if (e.alive) enemyMeshes.push(...e.hitMeshes);

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

      let dmg = def.damage;
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
      audio.impact();
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
      if (!e.alive) continue;
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

  /** Frag detonation: damage falls off with distance and needs line of sight. */
  explode(pos) {
    this.effects.explosion(pos);
    audio.explosion();

    // Blast is traced from a little above the casing: a grenade resting
    // against a sandbag still throws fragments over it. Cover behind which a
    // target is fully hidden cuts the damage rather than cancelling it.
    const originY = pos.y + 0.75;

    for (const e of [...this.enemies]) {
      if (!e.alive) continue;
      const dist = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z, (e.pos.y + 1) - pos.y);   // aim at the chest
      if (dist > BLAST_RADIUS) continue;

      const exposed = this.world.lineOfSight(pos.x, originY, pos.z, e.pos.x, e.pos.y + 1.15, e.pos.z);
      const falloff = Math.pow(THREE.MathUtils.clamp(1 - dist / BLAST_RADIUS, 0, 1), 1.6);
      V1.set(e.pos.x - pos.x, 0, e.pos.z - pos.z).normalize();
      const result = e.damage(BLAST_DAMAGE * falloff * (exposed ? 1 : 0.4),
        'body', V1, V2.copy(e.pos).setY(e.pos.y + 1.2));
      e.pos.addScaledVector(V1, falloff * 1.4);
      this.registerHit(e, result, 'FRAG', false);
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

    const mesh = new THREE.Mesh(this.pickupGeo[kind], this.pickupMat[kind]);
    if (kind === 'frag') mesh.scale.set(1, 1.2, 1);
    mesh.position.set(pos.x, 0.45, pos.z);
    mesh.castShadow = true;
    if (kind === 'health') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.01), this.crossMat);
      bar.position.z = 0.14;
      mesh.add(bar);
      const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.01), this.crossMat);
      bar2.position.z = 0.14;
      mesh.add(bar2);
    }
    this.scene.add(mesh);
    this.pickups.push({ kind, mesh, active: true, born: this.time });
  }

  updatePickups(dt) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.mesh.rotation.y += dt * 1.6;
      p.mesh.position.y = 0.42 + Math.sin((this.time + p.born) * 2.4) * 0.07;

      const dx = p.mesh.position.x - this.player.position.x;
      const dz = p.mesh.position.z - this.player.position.z;
      if (dx * dx + dz * dz < 2.0) {
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

  damagePlayer(amount, fromPos) {
    if (this.state !== 'playing' || this.player.dead) return;
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
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;

    if (this.state === 'playing') this.step(dt);
    else if (this.state === 'dead') {
      this.player.update(dt, this.time, this.input);
      for (const e of this.enemies) e.update(dt, this.time, this.player, this.world);
      this.effects.update(dt);
    }

    this.hud.tick(dt);
    this.flickerFires(dt);
    this.render();
    this.input.endFrame();
  }

  step(dt) {
    const input = this.input;

    this.player.update(dt, this.time, input);
    this.weapons.update(dt, this.time, input, this.player);

    if (input.wheel) this.weapons.cycle(input.wheel > 0 ? 1 : -1, this.time);

    // firing
    const w = this.weapons.current;
    if (input.fire && !this.player.dead) {
      const moving = Math.hypot(this.player.velocity.x, this.player.velocity.z) > 2.5;
      if (this.weapons.fire(this.time, this.camera, moving)) {
        if (!w.def.auto) input.fire = false;
      } else if (w.mag === 0 && !this.weapons.reloading && w.reserve > 0) {
        this.weapons.startReload(this.time);
      }
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
    this.autoCalibrate();
    this.effects.update(dt);
    this.hud.update(this);

    // FOV blends when aiming and when sprinting
    const ads = this.weapons.adsT;
    const sprintBoost = this.player.sprinting ? 4 : 0;
    const wantFov = this.baseFov * THREE.MathUtils.lerp(1, this.weapons.def.adsFovMul, ads) + sprintBoost;
    if (Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, wantFov, 12, dt);
      this.camera.updateProjectionMatrix();
    }

    // keep the sun's shadow box on the player
    this.sun.position.set(this.player.position.x - 60, 40, this.player.position.z - 30);
    this.sun.target.position.set(this.player.position.x, 0, this.player.position.z);
    this.sun.target.updateMatrixWorld();

    this.sky.position.copy(this.camera.position);
    this.sunSprite.position.copy(this.camera.position).addScaledVector(this.sunDir, 380);
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

  flickerFires(dt) {
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
