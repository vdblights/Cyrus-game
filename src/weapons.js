import * as THREE from 'three';
import { audio } from './audio.js';

const POLY = new THREE.MeshLambertMaterial({ color: 0x35393f });
const METAL = new THREE.MeshLambertMaterial({ color: 0x5b6169 });
const DARK = new THREE.MeshLambertMaterial({ color: 0x212428 });
const ACCENT = new THREE.MeshLambertMaterial({ color: 0x6b727a });
const GLOW = new THREE.MeshBasicMaterial({ color: 0xff3b2f });

function box(w, h, d, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

function tube(r1, r2, len, mat, x = 0, y = 0, z = 0, rx = Math.PI / 2) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 10), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  return m;
}

/**
 * Red-dot sight, shared by the long guns. The housing is a hollow frame —
 * the player aims *through* it, so the four bars are modelled separately
 * instead of as one solid block.
 */
const SIGHT_Y = 0.098;   // height of the sight line above the model origin

function optic(g, z) {
  g.add(box(0.045, 0.012, 0.10, DARK, 0, 0.062, z));                  // rail
  const t = 0.009, ap = 0.052, d = 0.07;                              // bar, aperture, depth
  g.add(box(ap + t * 2, t, d, POLY, 0, SIGHT_Y + ap / 2 + t / 2, z));  // top
  g.add(box(ap + t * 2, t, d, POLY, 0, SIGHT_Y - ap / 2 - t / 2, z));  // bottom
  g.add(box(t, ap, d, POLY, -ap / 2 - t / 2, SIGHT_Y, z));             // left
  g.add(box(t, ap, d, POLY, ap / 2 + t / 2, SIGHT_Y, z));              // right

  const lens = box(ap, ap, 0.003, new THREE.MeshBasicMaterial({
    color: 0x3d7f8f, transparent: true, opacity: 0.18, depthWrite: false,
  }), 0, SIGHT_Y, z - d / 2 + 0.01);
  g.add(lens);
  g.add(box(0.006, 0.006, 0.004, GLOW, 0, SIGHT_Y, z - d / 2 + 0.004)); // dot
}

/* ------------------------------------------------------------------ models */

function buildPistol() {
  const g = new THREE.Group();
  g.add(box(0.045, 0.075, 0.24, METAL, 0, 0.02, -0.06));        // slide
  g.add(box(0.042, 0.05, 0.20, POLY, 0, -0.04, -0.04));         // frame
  g.add(box(0.05, 0.115, 0.075, POLY, 0, -0.115, 0.045, 0.22)); // grip
  g.add(box(0.024, 0.03, 0.03, DARK, 0, -0.055, 0.005));        // trigger guard front
  g.add(tube(0.012, 0.012, 0.05, DARK, 0, 0.02, -0.19));        // muzzle
  g.add(box(0.007, 0.016, 0.008, DARK, 0, 0.070, -0.16));       // front post
  g.add(box(0.010, 0.016, 0.012, DARK, -0.017, 0.070, 0.04));   // rear notch, left
  g.add(box(0.010, 0.016, 0.012, DARK, 0.017, 0.070, 0.04));    // rear notch, right
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -0.215); g.add(muzzle);
  return { model: g, muzzle };
}

function buildSMG() {
  const g = new THREE.Group();
  g.add(box(0.055, 0.10, 0.34, POLY, 0, 0.01, -0.08));          // receiver
  g.add(tube(0.016, 0.016, 0.10, METAL, 0, 0.03, -0.28));       // barrel shroud
  g.add(box(0.04, 0.14, 0.055, DARK, 0, -0.10, 0.0, -0.30));    // magazine
  g.add(box(0.05, 0.10, 0.06, POLY, 0, -0.10, 0.10, 0.18));     // pistol grip
  g.add(box(0.035, 0.075, 0.05, POLY, 0, -0.075, -0.19, -0.15));// vertical foregrip
  g.add(box(0.04, 0.05, 0.13, ACCENT, 0, 0.0, 0.19));           // folding stock
  g.add(box(0.055, 0.02, 0.05, DARK, 0, 0.062, 0.06));
  optic(g, 0.02);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.03, -0.34); g.add(muzzle);
  return { model: g, muzzle };
}

function buildRifle() {
  const g = new THREE.Group();
  g.add(box(0.055, 0.105, 0.32, POLY, 0, 0.015, -0.02));        // upper/lower receiver
  g.add(box(0.06, 0.07, 0.26, DARK, 0, 0.02, -0.28));           // handguard
  for (let i = 0; i < 4; i++) g.add(box(0.062, 0.008, 0.012, ACCENT, 0, 0.055, -0.20 - i * 0.05));
  g.add(tube(0.013, 0.013, 0.20, METAL, 0, 0.025, -0.46));      // barrel
  g.add(tube(0.021, 0.024, 0.06, DARK, 0, 0.025, -0.57));       // flash hider
  g.add(box(0.042, 0.16, 0.06, DARK, 0, -0.11, 0.02, -0.12));   // STANAG mag
  g.add(box(0.05, 0.10, 0.06, POLY, 0, -0.10, 0.12, 0.22));     // grip
  g.add(box(0.05, 0.085, 0.20, POLY, 0, 0.0, 0.24));            // buffer stock
  g.add(box(0.03, 0.045, 0.09, ACCENT, 0, -0.015, 0.19));       // buffer tube
  g.add(box(0.035, 0.06, 0.02, POLY, 0, -0.06, -0.16, -0.5));   // angled grip
  optic(g, 0.06);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.025, -0.60); g.add(muzzle);
  return { model: g, muzzle };
}

function buildShotgun() {
  const g = new THREE.Group();
  g.add(box(0.06, 0.10, 0.30, POLY, 0, 0.01, -0.02));           // receiver
  g.add(tube(0.021, 0.021, 0.46, METAL, 0, 0.035, -0.40));      // barrel
  g.add(tube(0.019, 0.019, 0.36, DARK, 0, -0.015, -0.35));      // magazine tube
  g.add(box(0.055, 0.06, 0.16, POLY, 0, -0.005, -0.26));        // pump / forend
  g.add(box(0.052, 0.10, 0.06, POLY, 0, -0.095, 0.11, 0.20));   // grip
  g.add(box(0.055, 0.11, 0.22, POLY, 0, -0.03, 0.24, -0.12));   // stock
  g.add(box(0.010, 0.022, 0.012, DARK, 0, 0.072, -0.56));       // bead sight
  g.add(box(0.012, 0.018, 0.014, DARK, -0.018, 0.072, 0.10));   // ghost ring, left
  g.add(box(0.012, 0.018, 0.014, DARK, 0.018, 0.072, 0.10));    // ghost ring, right
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.035, -0.63); g.add(muzzle);
  return { model: g, muzzle };
}

/* ---------------------------------------------------------------- weapons */

export const WEAPON_DEFS = [
  {
    id: 'pistol', name: 'M9 SIDEARM', sound: 'pistol', build: buildPistol,
    auto: false, damage: 30, headMult: 2.6, rpm: 430, mag: 15, startReserve: 90, maxReserve: 150,
    pellets: 1, spread: 0.016, adsSpread: 0.004, recoil: { v: 0.021, h: 0.006 }, kick: 0.035,
    reload: 1.35, adsTime: 0.16, adsFovMul: 0.88, range: 120, tracer: 0.9, unlock: 1,
    hip: new THREE.Vector3(0.17, -0.14, -0.42), ads: new THREE.Vector3(0, -0.066, -0.34),
  },
  {
    id: 'smg', name: 'MP5K SMG', sound: 'smg', build: buildSMG,
    auto: true, damage: 19, headMult: 2.0, rpm: 880, mag: 30, startReserve: 180, maxReserve: 300,
    pellets: 1, spread: 0.030, adsSpread: 0.011, recoil: { v: 0.013, h: 0.008 }, kick: 0.026,
    reload: 1.9, adsTime: 0.20, adsFovMul: 0.85, range: 90, tracer: 0.9, unlock: 1,
    hip: new THREE.Vector3(0.19, -0.15, -0.54), ads: new THREE.Vector3(0, -0.099, -0.46),
  },
  {
    id: 'rifle', name: 'M4A1 CARBINE', sound: 'rifle', build: buildRifle,
    auto: true, damage: 29, headMult: 2.4, rpm: 720, mag: 30, startReserve: 150, maxReserve: 270,
    pellets: 1, spread: 0.024, adsSpread: 0.0055, recoil: { v: 0.017, h: 0.007 }, kick: 0.032,
    reload: 2.2, adsTime: 0.24, adsFovMul: 0.78, range: 200, tracer: 1.1, unlock: 2,
    hip: new THREE.Vector3(0.20, -0.16, -0.62), ads: new THREE.Vector3(0, -0.099, -0.52),
  },
  {
    id: 'shotgun', name: 'M1014 BREACHER', sound: 'shotgun', build: buildShotgun,
    auto: false, damage: 15, headMult: 1.6, rpm: 130, mag: 7, startReserve: 40, maxReserve: 80,
    pellets: 9, spread: 0.075, adsSpread: 0.048, recoil: { v: 0.055, h: 0.016 }, kick: 0.11,
    reload: 2.6, adsTime: 0.22, adsFovMul: 0.9, range: 40, tracer: 0.8, unlock: 3, falloff: 22,
    hip: new THREE.Vector3(0.20, -0.155, -0.64), ads: new THREE.Vector3(0, -0.069, -0.56),
  },
];

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const Q1 = new THREE.Quaternion();

export class WeaponSystem {
  /**
   * @param {THREE.Scene} viewScene separate scene drawn over the world so the
   *        gun never clips into geometry
   */
  constructor(viewScene, game) {
    this.game = game;
    this.root = new THREE.Group();
    viewScene.add(this.root);

    this.weapons = WEAPON_DEFS.map((def) => {
      const { model, muzzle } = def.build();
      model.visible = false;
      model.traverse((o) => { o.frustumCulled = false; });
      this.root.add(model);
      return {
        def, model, muzzle,
        mag: def.mag, reserve: def.startReserve, unlocked: def.unlock <= 1,
      };
    });

    this.index = 0;
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextShot = 0;
    this.adsT = 0;
    this.ads = false;
    this.switching = 0;
    this.bobT = 0;

    this.kickPos = new THREE.Vector3();
    this.kickRot = new THREE.Vector3();
    this.sway = new THREE.Vector2();

    this.current.model.visible = true;
  }

  get current() { return this.weapons[this.index]; }
  get def() { return this.weapons[this.index].def; }

  reset() {
    for (const w of this.weapons) {
      w.mag = w.def.mag;
      w.reserve = w.def.startReserve;
      w.unlocked = w.def.unlock <= 1;
      w.model.visible = false;
    }
    this.index = 0;
    this.reloading = false;
    this.ads = false;
    this.adsT = 0;
    this.nextShot = 0;
    this.current.model.visible = true;
  }

  unlockForWave(wave) {
    const newly = [];
    for (const w of this.weapons) {
      if (!w.unlocked && w.def.unlock <= wave) { w.unlocked = true; newly.push(w.def.name); }
    }
    return newly;
  }

  select(i, time) {
    if (i === this.index || i < 0 || i >= this.weapons.length) return;
    if (!this.weapons[i].unlocked) return;
    this.current.model.visible = false;
    this.index = i;
    this.current.model.visible = true;
    this.reloading = false;
    this.switching = 0.32;
    this.nextShot = Math.max(this.nextShot, time + 0.3);
    audio.swap();
  }

  cycle(dir, time) {
    const n = this.weapons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.index + dir * k + n * 2) % n;
      if (this.weapons[i].unlocked) { this.select(i, time); return; }
    }
  }

  addAmmo(fraction = 0.35, all = false) {
    let gained = false;
    for (const w of this.weapons) {
      if (!w.unlocked) continue;
      if (!all && w !== this.current) continue;
      const add = Math.ceil(w.def.maxReserve * fraction);
      const before = w.reserve;
      w.reserve = Math.min(w.def.maxReserve, w.reserve + add);
      if (w.reserve > before) gained = true;
    }
    return gained;
  }

  startReload(time) {
    const w = this.current;
    if (this.reloading || w.mag >= w.def.mag || w.reserve <= 0) return;
    this.reloading = true;
    this.reloadStart = time;
    this.reloadEnd = time + w.def.reload;
    audio.reload('out');
    setTimeout(() => audio.reload('in'), w.def.reload * 450);
    setTimeout(() => audio.reload(w.def.id === 'shotgun' ? 'shell' : 'bolt'), w.def.reload * 800);
  }

  finishReload() {
    const w = this.current;
    const need = w.def.mag - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take;
    w.reserve -= take;
    this.reloading = false;
  }

  canFire(time) {
    return !this.reloading && time >= this.nextShot && this.switching <= 0;
  }

  /** Fire one round/volley. Returns true if a shot went out. */
  fire(time, camera, moving) {
    const w = this.current, d = w.def;
    if (!this.canFire(time)) return false;
    if (w.mag <= 0) {
      this.nextShot = time + 0.28;
      audio.dryFire();
      return false;
    }

    w.mag--;
    this.nextShot = time + 60 / d.rpm;

    const spreadBase = this.adsT > 0.6 ? d.adsSpread : d.spread;
    const spread = spreadBase * (moving ? 1.5 : 1) * (this.game.player.crouching ? 0.7 : 1);

    camera.getWorldDirection(V1);
    V2.set(0, 1, 0).cross(V1).normalize();   // camera right (negated), fine for jitter
    const up = new THREE.Vector3().crossVectors(V1, V2).normalize();

    for (let p = 0; p < d.pellets; p++) {
      const dir = V1.clone();
      const sx = (Math.random() + Math.random() - 1) * spread;
      const sy = (Math.random() + Math.random() - 1) * spread;
      dir.addScaledVector(V2, sx).addScaledVector(up, sy).normalize();
      this.game.hitscan(dir, d);
    }

    // recoil: vertical kick with a little horizontal wander
    const mult = this.adsT > 0.6 ? 0.7 : 1;
    this.game.applyRecoil(d.recoil.v * mult, (Math.random() - 0.5) * 2 * d.recoil.h * mult);
    this.kickPos.z += d.kick;
    this.kickPos.y += d.kick * 0.25;
    this.kickRot.x -= d.kick * 2.4;
    this.kickRot.z += (Math.random() - 0.5) * d.kick;

    audio.shot(d.sound);
    this.game.alertNearby(d.id === 'shotgun' ? 48 : 40);
    this.muzzleWorld(V1);
    this.game.effects.muzzle(V1, d.id === 'shotgun' ? 1.6 : 1);
    this.game.effects.ejectCasing(V1, V2.clone().negate());
    this.flash(d);
    return true;
  }

  /** Approximate world-space muzzle position for lights, tracers and casings. */
  muzzleWorld(out) {
    const cam = this.game.camera;
    cam.getWorldDirection(out);
    const right = V2.set(0, 1, 0).cross(out).normalize().multiplyScalar(-0.16 * (1 - this.adsT));
    out.multiplyScalar(0.75).add(right);
    out.y -= 0.12 * (1 - this.adsT);
    out.add(cam.position);
    return out;
  }

  flash(def) {
    if (!this._flashSprite) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.game.effects.spriteMaps.flash,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      spr.visible = false;
      this.root.add(spr);
      this._flashSprite = spr;
      this._flashLife = 0;
    }
    const w = this.current;
    w.muzzle.getWorldPosition(this._flashSprite.position);
    this.root.worldToLocal(this._flashSprite.position);
    const s = def.id === 'shotgun' ? 0.34 : def.id === 'pistol' ? 0.2 : 0.26;
    this._flashSprite.scale.set(s, s, 1);
    this._flashSprite.material.rotation = Math.random() * 6.28;
    this._flashSprite.visible = true;
    this._flashLife = 0.045;
  }

  update(dt, time, input, player) {
    const d = this.def;

    // ADS blend
    this.ads = input.aim && !this.reloading && this.switching <= 0;
    const rate = dt / Math.max(0.01, d.adsTime);
    this.adsT = THREE.MathUtils.clamp(this.adsT + (this.ads ? rate : -rate * 1.4), 0, 1);

    if (this.switching > 0) this.switching -= dt;
    if (this.reloading && time >= this.reloadEnd) this.finishReload();

    if (this._flashLife > 0) {
      this._flashLife -= dt;
      if (this._flashLife <= 0) this._flashSprite.visible = false;
    }

    // ---- view model placement -----------------------------------------
    const model = this.current.model;
    const base = V1.copy(d.hip).lerp(d.ads, this.adsT);

    // walk bob
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    this.bobT += dt * (6 + speed * 1.1);
    const bobAmt = Math.min(speed / 6, 1) * (1 - this.adsT * 0.85) * (player.onGround ? 1 : 0.2);
    base.x += Math.cos(this.bobT) * 0.014 * bobAmt;
    base.y += Math.abs(Math.sin(this.bobT)) * 0.016 * bobAmt;

    // mouse sway
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-input.lookDelta.x * 0.6, -0.05, 0.05), 8, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(-input.lookDelta.y * 0.6, -0.05, 0.05), 8, dt);
    base.x += this.sway.x * (1 - this.adsT * 0.7);
    base.y += this.sway.y * (1 - this.adsT * 0.7);

    // recoil spring
    this.kickPos.multiplyScalar(Math.max(0, 1 - 16 * dt));
    this.kickRot.multiplyScalar(Math.max(0, 1 - 14 * dt));
    base.add(this.kickPos);

    // sprint / reload / switch poses
    let rx = this.kickRot.x, ry = this.kickRot.y, rz = this.kickRot.z;
    if (this.reloading) {
      const t = THREE.MathUtils.clamp((time - this.reloadStart) / d.reload, 0, 1);
      const arc = Math.sin(t * Math.PI);
      base.y -= 0.14 * arc;
      base.z += 0.06 * arc;
      rx += 0.5 * arc;
      rz += 0.45 * arc;
    }
    if (this.switching > 0) {
      const t = this.switching / 0.32;
      base.y -= 0.24 * t;
      rx += 0.7 * t;
    }
    if (player.sprinting && speed > 3 && !this.ads) {
      base.y -= 0.045;
      base.x += 0.02;
      rx += 0.22;
      ry += 0.42;
      rz += 0.18;
    }

    model.position.lerp(base, Math.min(1, dt * 18));
    Q1.setFromEuler(new THREE.Euler(rx, ry, rz));
    model.quaternion.slerp(Q1, Math.min(1, dt * 18));
  }
}
