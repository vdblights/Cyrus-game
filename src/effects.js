import * as THREE from 'three';
import * as TEX from './textures.js';

const V = new THREE.Vector3();

/**
 * Pooled visual effects: tracers, impact puffs, sparks, blood, bullet holes
 * and ejected casings. Everything is recycled so combat never allocates.
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    // ---- tracers -------------------------------------------------------
    this.tracers = [];
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const tracerGeo = new THREE.CylinderGeometry(0.013, 0.013, 1, 5, 1, true);
    tracerGeo.translate(0, 0.5, 0);
    tracerGeo.rotateX(Math.PI / 2);   // now points down -Z from origin
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // ---- sprite bursts (smoke / sparks / blood) -------------------------
    this.sprites = [];
    this.spriteMaps = {
      smoke: TEX.particleSprite('#cfc6b8'),
      spark: TEX.particleSprite('#ffcf7a'),
      blood: TEX.particleSprite('#c01f16'),
      flash: TEX.particleSprite('#ffe6a8'),
    };
    for (let i = 0; i < 120; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.spriteMaps.smoke, transparent: true, depthWrite: false, opacity: 0,
      }));
      s.visible = false;
      scene.add(s);
      this.sprites.push({ spr: s, life: 0, max: 1, vel: new THREE.Vector3(), grow: 1, fade: 1 });
    }

    // ---- bullet holes --------------------------------------------------
    this.decals = [];
    this.decalIdx = 0;
    const holeMat = new THREE.MeshBasicMaterial({
      color: 0x0b0b0c, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    const holeGeo = new THREE.CircleGeometry(0.06, 7);
    for (let i = 0; i < 60; i++) {
      const d = new THREE.Mesh(holeGeo, holeMat);
      d.visible = false;
      scene.add(d);
      this.decals.push(d);
    }

    // ---- casings -------------------------------------------------------
    this.casings = [];
    const brass = new THREE.MeshLambertMaterial({ color: 0xc9a227 });
    const caseGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.05, 5);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(caseGeo, brass);
      m.visible = false;
      scene.add(m);
      this.casings.push({ mesh: m, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }

    // ---- muzzle light --------------------------------------------------
    this.muzzleLight = new THREE.PointLight(0xffcf8a, 0, 16, 2);
    scene.add(this.muzzleLight);
    this.muzzleLife = 0;
  }

  tracer(from, to, width = 1) {
    const t = this.tracers.find((x) => x.life <= 0) || this.tracers[0];
    const dist = from.distanceTo(to);
    t.mesh.position.copy(from);
    t.mesh.lookAt(to);
    t.mesh.scale.set(width, width, dist);
    t.mesh.material.opacity = 0.85;
    t.mesh.visible = true;
    t.life = 0.055;
  }

  _sprite(map, pos, size, life, vel, grow, opacity, additive = false) {
    const s = this.sprites.find((x) => x.life <= 0);
    if (!s) return;
    s.spr.material.map = map;
    s.spr.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    s.spr.material.opacity = opacity;
    s.spr.material.needsUpdate = true;
    s.spr.position.copy(pos);
    s.spr.scale.set(size, size, 1);
    s.spr.visible = true;
    s.life = s.max = life;
    s.grow = grow;
    s.fade = opacity;
    if (vel) s.vel.copy(vel); else s.vel.set(0, 0, 0);
  }

  impact(point, normal, surface = 'hard') {
    // puff of pulverised concrete
    for (let i = 0; i < 3; i++) {
      V.copy(normal).multiplyScalar(0.6).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.9, Math.random() * 0.7, (Math.random() - 0.5) * 0.9));
      this._sprite(this.spriteMaps.smoke, point, 0.18 + Math.random() * 0.25, 0.55 + Math.random() * 0.3, V, 2.6, 0.42);
    }
    for (let i = 0; i < 2; i++) {
      V.copy(normal).multiplyScalar(2.2).add(new THREE.Vector3(
        (Math.random() - 0.5) * 2.5, Math.random() * 1.6, (Math.random() - 0.5) * 2.5));
      this._sprite(this.spriteMaps.spark, point, 0.09, 0.16, V, 0.4, 0.95, true);
    }
    if (surface === 'hard') {
      const d = this.decals[this.decalIdx = (this.decalIdx + 1) % this.decals.length];
      d.position.copy(point).addScaledVector(normal, 0.012);
      V.copy(point).add(normal);
      d.lookAt(V);
      d.scale.setScalar(0.7 + Math.random() * 0.8);
      d.visible = true;
    }
  }

  blood(point, dir) {
    for (let i = 0; i < 5; i++) {
      V.copy(dir).multiplyScalar(1.4).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.6, Math.random() * 1.1 - 0.2, (Math.random() - 0.5) * 1.6));
      this._sprite(this.spriteMaps.blood, point, 0.14 + Math.random() * 0.2, 0.35 + Math.random() * 0.25, V, 1.7, 0.85);
    }
  }

  gib(point) {
    for (let i = 0; i < 14; i++) {
      V.set((Math.random() - 0.5) * 3.4, Math.random() * 2.6, (Math.random() - 0.5) * 3.4);
      this._sprite(this.spriteMaps.blood, point, 0.2 + Math.random() * 0.3, 0.6 + Math.random() * 0.4, V, 1.5, 0.8);
    }
  }

  muzzle(worldPos, strength = 1) {
    this.muzzleLight.position.copy(worldPos);
    this.muzzleLight.intensity = 9 * strength;
    this.muzzleLife = 0.06;
    this._sprite(this.spriteMaps.flash, worldPos, 0.5 * strength, 0.05, null, 1.4, 0.9, true);
  }

  ejectCasing(worldPos, rightDir) {
    const c = this.casings.find((x) => x.life <= 0);
    if (!c) return;
    c.mesh.position.copy(worldPos);
    c.mesh.visible = true;
    c.vel.copy(rightDir).normalize().multiplyScalar(2.2 + Math.random())
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.8 + Math.random(), (Math.random() - 0.5) * 0.6));
    c.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    c.life = 1.6;
  }

  update(dt) {
    this.time += dt;

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, (t.life / 0.055) * 0.85);
      if (t.life <= 0) t.mesh.visible = false;
    }

    for (const s of this.sprites) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = Math.max(0, s.life / s.max);
      s.spr.position.addScaledVector(s.vel, dt);
      s.vel.y -= 3.5 * dt;
      s.vel.multiplyScalar(1 - 2.5 * dt);
      const sc = s.spr.scale.x + (s.grow - 1) * dt;
      s.spr.scale.set(sc, sc, 1);
      s.spr.material.opacity = s.fade * k;
      if (s.life <= 0) s.spr.visible = false;
    }

    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 14 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.mesh.position.y < 0.03) {
        c.mesh.position.y = 0.03;
        c.vel.set(c.vel.x * 0.4, Math.abs(c.vel.y) * 0.25, c.vel.z * 0.4);
        c.spin.multiplyScalar(0.4);
      }
      if (c.life <= 0) c.mesh.visible = false;
    }

    if (this.muzzleLife > 0) {
      this.muzzleLife -= dt;
      this.muzzleLight.intensity *= Math.max(0, 1 - dt * 22);
      if (this.muzzleLife <= 0) this.muzzleLight.intensity = 0;
    }
  }

  reset() {
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const s of this.sprites) { s.life = 0; s.spr.visible = false; }
    for (const c of this.casings) { c.life = 0; c.mesh.visible = false; }
    for (const d of this.decals) d.visible = false;
    this.muzzleLight.intensity = 0;
  }
}
