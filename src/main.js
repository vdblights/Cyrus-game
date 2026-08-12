import * as THREE from 'three';
import { buildCity } from './city.js';
import { Player, Input } from './player.js';
import { WeaponSystem } from './weapons.js';
import { Effects } from './effects.js';
import { Enemy } from './enemies.js';
import { HUD } from './hud.js';
import { audio } from './audio.js';
import * as TEX from './textures.js';
import { randRange } from './world.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const RAY = new THREE.Raycaster();

class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;

    // ---- world scene ----------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x7d6552, 0.0095);
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

    this.effects = new Effects(this.scene);
    this.player = new Player(this.camera, this.world);
    this.weapons = new WeaponSystem(this.viewScene, this);
    this.input = new Input(this.canvas);
    this.hud = new HUD();

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
    this.runStart = 0;

    this.bindUI();
    addEventListener('resize', () => this.resize());
    this.resize();

    this.clock = new THREE.Clock();
    this.renderer.compile(this.scene, this.camera);
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('start-btn').classList.remove('hidden');
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ setup
  setupSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 24, 16),
      new THREE.MeshBasicMaterial({ map: TEX.skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
    );
    this.scene.add(sky);
    this.sky = sky;

    // low haze layer that sells the dust in the air
    const haze = new THREE.Mesh(
      new THREE.SphereGeometry(200, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0x8a6b4e, transparent: true, opacity: 0.16, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    this.scene.add(haze);
  }

  setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xb6c3d2, 0x7a6349, 1.35));

    const sun = new THREE.DirectionalLight(0xffc184, 2.7);
    sun.position.set(-60, 48, -30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 45;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
    sun.shadow.bias = -0.0007;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // cool bounce from the opposite side so shadowed faces stay readable
    const fill = new THREE.DirectionalLight(0x6d90c0, 0.9);
    fill.position.set(40, 25, 50);
    this.scene.add(fill);
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
    };
    this.pickupMat = {
      ammo: new THREE.MeshLambertMaterial({ color: 0x8a7a2e, emissive: 0x3a3208 }),
      health: new THREE.MeshLambertMaterial({ color: 0xd8d8d0, emissive: 0x0f2a10 }),
    };
    this.crossMat = new THREE.MeshBasicMaterial({ color: 0x2ecc40 });
  }

  bindUI() {
    const start = () => this.startRun();
    document.getElementById('start-btn').onclick = start;
    document.getElementById('retry-btn').onclick = start;
    document.getElementById('resume-btn').onclick = () => this.resume();
    document.getElementById('quit-btn').onclick = () => this.toMenu();

    const sens = document.getElementById('sens');
    sens.oninput = () => { this.input.sensitivity = sens.value / 100; };
    const fov = document.getElementById('fov');
    fov.oninput = () => { this.baseFov = +fov.value; };

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
    };

    this.input.onKey = (code) => {
      if (this.state !== 'playing') return;
      if (code === 'KeyR') this.weapons.startReload(this.time);
      if (code === 'Digit1') this.weapons.select(0, this.time);
      if (code === 'Digit2') this.weapons.select(1, this.time);
      if (code === 'Digit3') this.weapons.select(2, this.time);
      if (code === 'Digit4') this.weapons.select(3, this.time);
      if (code === 'KeyQ') this.weapons.cycle(1, this.time);
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

    this.player.reset(-17, 24);            // the plaza near the middle of the map
    this.player.onStep = () => audio.step(this.player.crouching);
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
    this.runStart = this.time;

    document.getElementById('menu').classList.add('hidden');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.hud.show(true);
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
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('gameover').classList.add('hidden');
    document.getElementById('menu').classList.remove('hidden');
    this.hud.show(false);
    this.input.exitLock();
  }

  gameOver() {
    this.state = 'dead';
    audio.death();
    this.input.exitLock();
    const acc = this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    const mins = Math.floor((this.time - this.runStart) / 60);
    const secs = Math.floor((this.time - this.runStart) % 60).toString().padStart(2, '0');
    setTimeout(() => {
      document.getElementById('stats').innerHTML =
        `<div>WAVE REACHED <b>${this.wave}</b></div>` +
        `<div>SCORE <b>${this.score.toLocaleString()}</b></div>` +
        `<div>KILLS <b>${this.kills}</b> &middot; HEADSHOTS <b>${this.headshots}</b></div>` +
        `<div>ACCURACY <b>${acc}%</b> &middot; SURVIVED <b>${mins}:${secs}</b></div>`;
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
      if (w >= 5 && r < 0.10 + w * 0.01) type = 'brute';
      else if (w >= 3 && r < 0.34) type = 'shotgunner';
      else if (w >= 2 && r < 0.62) type = 'raider';
      else if (r < 0.3 && w >= 2) type = 'raider';
      queue.push(type);
    }
    this.spawnQueue = queue;
    this.pendingSpawns = queue.length;
    this.waveHpScale = 1 + (w - 1) * 0.09;
    this.nextSpawnAt = this.time;

    const unlocked = this.weapons.unlockForWave(w);
    audio.wave();
    this.hud.banner('WAVE ' + w, `${total} HOSTILES`);
    if (unlocked.length) setTimeout(() => this.hud.toast('WEAPON RECOVERED: ' + unlocked.join(', ')), 1200);
  }

  updateWaves(dt) {
    if (this.spawnQueue.length === 0 && this.pendingSpawns === 0) {
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
      if (this.world.occupied(x, z, 1.2, 0.6)) continue;
      fallback = fallback || { x, z };
      if (!this.world.lineOfSight(x, 1.5, z, p.x, p.y, p.z)) return { x, z };
      if (i > 40) return { x, z };
    }
    return fallback || { x: p.x + randRange(-20, 20), z: p.z + randRange(-20, 20) };
  }

  /** Pull a hostile that has wedged itself in geometry and drop it back in. */
  relocateEnemy(enemy) {
    const { x, z } = this.findSpawnPoint(22, 45);
    enemy.pos.set(x, 0, z);
    enemy.lastDistCheck = Infinity;
    enemy.vel.set(0, 0, 0);
    enemy.group.position.copy(enemy.pos);
  }

  spawnEnemy(typeKey) {
    const { x, z } = this.findSpawnPoint();

    const pooled = this.pool[typeKey];
    let e;
    if (pooled && pooled.length) {
      e = pooled.pop();
      e.spawn(x, z, this.waveHpScale);
    } else {
      e = new Enemy(typeKey, this.scene, this);
      e.spawn(x, z, this.waveHpScale);
    }
    this.enemies.push(e);
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

      if (result === 'kill') {
        this.kills++;
        const head = zone === 'head';
        if (head) this.headshots++;
        const gained = enemy.type.score * (head ? 1.5 : 1);
        this.score += Math.round(gained);
        this.hud.hitmark(true);
        this.hud.kill(enemy.type.name, def.name.split(' ')[0], head);
        audio.kill();
        this.maybeDrop(enemy.pos);
      } else if (result === 'hit') {
        this.hud.hitmark(false);
        audio.hitmark();
      }
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

  maybeDrop(pos) {
    const r = Math.random();
    let kind = null;
    if (r < 0.28) kind = 'ammo';
    else if (r < 0.40) kind = 'health';
    else if (this.player.health < 45 && r < 0.62) kind = 'health';
    if (!kind) return;

    const mesh = new THREE.Mesh(this.pickupGeo[kind], this.pickupMat[kind]);
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

    this.updateWaves(dt);
    this.updatePickups(dt);
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
    this.sun.position.set(this.player.position.x - 60, 48, this.player.position.z - 30);
    this.sun.target.position.set(this.player.position.x, 0, this.player.position.z);
    this.sun.target.updateMatrixWorld();

    this.sky.position.copy(this.camera.position);
    this.dust.position.set(
      Math.round(this.player.position.x / 30) * 30, 0, Math.round(this.player.position.z / 30) * 30);
  }

  flickerFires(dt) {
    for (const b of this.fireBarrels) {
      b.phase += dt * 9;
      const f = 0.7 + Math.sin(b.phase) * 0.15 + Math.sin(b.phase * 2.7) * 0.12 + Math.random() * 0.12;
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
