import * as THREE from 'three';
import { audio } from './audio.js';
import { randRange } from './world.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const V5 = new THREE.Vector3();

/**
 * Hostile archetypes. `preferred` is the range the AI tries to hold; melee
 * types simply close to contact.
 */
export const ENEMY_TYPES = {
  scavenger: {
    name: 'SCAVENGER', hp: 65, speed: 4.6, scale: 0.95, melee: true,
    damage: 14, rate: 1.0, preferred: 1.6, accuracy: 1, color: 0x8a9c62, accent: 0xb07a42,
    score: 100, detect: 55, marker: 0xd8452f,
  },
  raider: {
    name: 'RAIDER', hp: 110, speed: 3.0, scale: 1.0, melee: false,
    damage: 6, rate: 0.16, burst: 3, burstPause: 2.4, preferred: 13, accuracy: 0.085,
    color: 0x66788a, accent: 0x3f4750, score: 150, detect: 65, sound: 'rifle', marker: 0xe8a33a,
  },
  shotgunner: {
    name: 'BREAKER', hp: 170, speed: 3.6, scale: 1.08, melee: false,
    damage: 5, pellets: 6, rate: 1.15, preferred: 6, accuracy: 0.14, falloff: 16,
    color: 0x9a7550, accent: 0x53412f, score: 200, detect: 50, sound: 'shotgun', marker: 0x3fa9d8,
  },
  marksman: {
    name: 'MARKSMAN', hp: 90, speed: 2.4, scale: 1.0, melee: false,
    damage: 26, rate: 2.9, preferred: 26, accuracy: 0.022, detect: 95,
    color: 0x5c6f5a, accent: 0x2f3a30, score: 250, sound: 'rifle', marker: 0x7ce04a,
    laser: true, perch: true,
  },
  brute: {
    name: 'JUGGERNAUT', hp: 420, speed: 2.4, scale: 1.35, melee: false,
    damage: 7, rate: 0.13, burst: 6, burstPause: 2.8, preferred: 9, accuracy: 0.105,
    color: 0x7d5a5a, accent: 0x3a3533, score: 400, detect: 70, sound: 'smg', marker: 0xb03be0,
  },
};

/** Blocky humanoid built from boxes; parts are tagged for hit zones. */
function buildBody(type) {
  const g = new THREE.Group();
  const cloth = new THREE.MeshLambertMaterial({ color: type.color });
  const gear = new THREE.MeshLambertMaterial({ color: type.accent });
  const skin = new THREE.MeshLambertMaterial({ color: 0x8c7159 });
  const metal = new THREE.MeshLambertMaterial({ color: 0x26292d });

  const parts = {};
  const add = (mesh, zone, key) => {
    mesh.castShadow = true;
    mesh.userData.zone = zone;
    g.add(mesh);
    if (key) parts[key] = mesh;
    return mesh;
  };

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.30), cloth);
  torso.position.y = 1.18;
  add(torso, 'body', 'torso');

  const rig = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.36, 0.36), gear);
  rig.position.y = 1.22;
  add(rig, 'body');

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.27, 0.25), skin);
  head.position.y = 1.66;
  add(head, 'head', 'head');

  // gas mask / helmet
  const mask = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.14, 0.09), gear);
  mask.position.set(0, 1.62, -0.13);
  add(mask, 'head');
  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.12, 0.29), gear);
  helm.position.set(0, 1.79, 0);
  add(helm, 'head');
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.09, 0.38),
    new THREE.MeshBasicMaterial({ color: type.marker || 0xd8452f }));
  band.position.y = 1.36;
  g.add(band);
  parts.band = band;

  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.02),
    new THREE.MeshBasicMaterial({ color: 0xff4a2a }));
  eye.position.set(0.07, 1.63, -0.175);
  g.add(eye);
  parts.eye = eye;

  const armGeo = new THREE.BoxGeometry(0.15, 0.52, 0.16);
  armGeo.translate(0, -0.26, 0);
  const armL = new THREE.Mesh(armGeo, cloth); armL.position.set(-0.34, 1.45, 0);
  const armR = new THREE.Mesh(armGeo, cloth); armR.position.set(0.34, 1.45, 0);
  add(armL, 'limb', 'armL'); add(armR, 'limb', 'armR');

  const legGeo = new THREE.BoxGeometry(0.19, 0.85, 0.20);
  legGeo.translate(0, -0.42, 0);
  const legL = new THREE.Mesh(legGeo, gear); legL.position.set(-0.14, 0.86, 0);
  const legR = new THREE.Mesh(legGeo, gear); legR.position.set(0.14, 0.86, 0);
  add(legL, 'limb', 'legL'); add(legR, 'limb', 'legR');

  // weapon in the right hand
  const weapon = new THREE.Group();
  if (type.melee) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.75), metal);
    bar.position.z = -0.3;
    weapon.add(bar);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.05), metal);
    hook.position.set(0, -0.08, -0.63);
    weapon.add(hook);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.5), metal);
    body.position.z = -0.18;
    weapon.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.55;
    weapon.add(barrel);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.07), metal);
    mag.position.set(0, -0.14, -0.16);
    weapon.add(mag);
  }
  if (type.laser) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    beam.geometry.translate(0, 0.5, 0);
    beam.geometry.rotateX(Math.PI / 2);
    beam.visible = false;
    beam.frustumCulled = false;
    g.add(beam);
    parts.beam = beam;
  }

  weapon.position.set(0.30, 1.28, -0.12);
  g.add(weapon);
  parts.weapon = weapon;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.75);
  weapon.add(muzzle);
  parts.muzzle = muzzle;

  g.scale.setScalar(type.scale);
  return { group: g, parts };
}

export class Enemy {
  constructor(typeKey, scene, game) {
    this.typeKey = typeKey;
    this.type = ENEMY_TYPES[typeKey];
    this.game = game;
    const built = buildBody(this.type);
    this.group = built.group;
    this.parts = built.parts;
    this.hitMeshes = [];
    this.group.traverse((o) => {
      if (o.isMesh && o.userData.zone) { o.userData.enemy = this; this.hitMeshes.push(o); }
    });
    scene.add(this.group);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = 0.45 * this.type.scale;
    this.reset();
  }

  reset() {
    this.hp = this.type.hp;
    this.maxHp = this.type.hp;
    this.alive = true;
    this.state = 'idle';
    this.alerted = false;
    this.nextFire = 0;
    this.burstLeft = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = randRange(1, 3);
    this.walkPhase = Math.random() * 6.28;
    this.deathT = 0;
    this.hurtFlash = 0;
    this.swingT = 0;
    this.group.visible = true;
    this.group.rotation.set(0, 0, 0);
    this.group.scale.setScalar(this.type.scale);
    this.avoidDir = 0;
    this.avoidTimer = 0;
    this.stuckTimer = 0;
    this.lastDistCheck = Infinity;
    this.pos.y = 0;
    if (this.parts.beam) this.parts.beam.visible = false;
    this.applyElite(false);
  }

  /** What the killfeed calls this hostile. */
  get displayName() { return this.elite ? 'WARLORD' : this.type.name; }

  /** Points awarded for putting it down. */
  get scoreValue() { return this.type.score * (this.elite ? 3 : 1); }

  /**
   * Elite variant: a scaled-up, tougher, higher-value version used for the
   * boss that closes out every fifth wave.
   */
  applyElite(on) {
    this.elite = on;
    const s = this.type.scale * (on ? 1.45 : 1);
    this.group.scale.setScalar(s);
    this.radius = 0.45 * s;
    if (this.parts.band) this.parts.band.material.color.setHex(on ? 0xffd23f : (this.type.marker || 0xd8452f));
  }

  spawn(x, z, waveScale = 1, y = 0) {
    this.reset();
    this.hp = this.maxHp = Math.round(this.type.hp * waveScale);
    this.pos.set(x, y, z);
    this.group.position.copy(this.pos);
  }

  /**
   * Wake this hostile up — from sight, proximity, gunfire or being shot.
   * `readyIn` holds their fire briefly so the player is never insta-shot by
   * something that just noticed them.
   */
  alert(time = 0, readyIn = randRange(0.55, 1.3)) {
    if (this.alerted || !this.alive) return;
    this.alerted = true;
    this.nextFire = Math.max(this.nextFire, time + readyIn);
    if (Math.random() < 0.3) audio.enemyAlert();
  }

  /** @returns {'kill'|'hit'|null} */
  damage(amount, zone, fromDir, point) {
    if (!this.alive) return null;
    let dmg = amount;
    if (zone === 'head') dmg *= 1;      // multiplier already applied by shooter
    else if (zone === 'limb') dmg *= 0.75;
    this.hp -= dmg;
    this.hurtFlash = 0.12;
    this.alert(this.game.time, 0.35);
    this.game.effects.blood(point, fromDir);
    if (this.hp <= 0) {
      this.die(fromDir);
      return 'kill';
    }
    audio.flesh();
    return 'hit';
  }

  die(fromDir) {
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.vel.set(0, 0, 0);
    this.fallDir = Math.atan2(fromDir ? fromDir.x : 0, fromDir ? fromDir.z : 1);
    this.game.effects.gib(V1.copy(this.pos).setY(this.pos.y + 1.2));
    audio.flesh();
  }

  update(dt, time, player, world) {
    if (!this.alive) {
      this.deathT += dt;
      // topple over in the direction of the killing shot
      const t = Math.min(1, this.deathT / 0.55);
      const fall = Math.sin(t * Math.PI * 0.5) * (Math.PI / 2);
      this.group.rotation.x = Math.cos(this.fallDir) * fall;
      this.group.rotation.z = -Math.sin(this.fallDir) * fall;
      this.group.position.y = this.pos.y - 0.1 * t;
      if (this.deathT > 6) {
        const k = Math.max(0, 1 - (this.deathT - 6) / 1.5);
        this.group.scale.setScalar(this.type.scale * k);
        if (k <= 0.01) this.group.visible = false;
      }
      return;
    }

    if (this.hurtFlash > 0) this.hurtFlash -= dt;

    const toPlayer = V1.copy(player.position).sub(this.pos);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    toPlayer.normalize();
    const heightGap = player.position.y - (this.pos.y + 1.5);

    const eyeY = this.pos.y + 1.5 * this.type.scale;
    const sees = dist < this.type.detect &&
      world.lineOfSight(this.pos.x, eyeY, this.pos.z, player.position.x, player.position.y, player.position.z);

    // spotted the target, or got close enough to hear them
    if (!this.alerted && ((sees && dist < this.type.detect) || dist < 16)) this.alert(time);

    let moveDir = V2.set(0, 0, 0);
    if (!this.alerted) {
      // still hunting: drift toward the player at a walk
      moveDir.copy(toPlayer);
    } else {
      const t = this.type;
      // a marksman who has found high ground stays on it
      const holdPerch = t.perch && this.pos.y > 1.5 && sees;
      const wantCloser = !holdPerch && dist > t.preferred * (t.melee ? 1 : 1.15);
      const wantBack = !t.melee && !holdPerch && dist < t.preferred * 0.6;

      if (wantCloser) moveDir.copy(toPlayer);
      else if (wantBack) moveDir.copy(toPlayer).negate();

      // strafe when holding position and able to see the target
      if (!wantCloser && sees) {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafe *= -1; this.strafeTimer = randRange(1.2, 3); }
        moveDir.x += -toPlayer.z * this.strafe * 0.9;
        moveDir.z += toPlayer.x * this.strafe * 0.9;
      }
      // no line of sight: push toward the player to break the wall
      if (!sees) moveDir.copy(toPlayer);
    }

    // ---- obstacle avoidance --------------------------------------------
    // Probe the desired heading; if it is blocked, fan outwards (keeping a
    // consistent side, so hostiles commit to going around rather than
    // jittering) and take the first clear direction.
    if (moveDir.lengthSq() > 1e-4) {
      moveDir.normalize();
      const probe = 1.8 + this.radius;
      const clear = (x, z) => !world.occupied(this.pos.x + x * probe, this.pos.z + z * probe, this.radius, this.pos.y + 0.9);
      const rot = (a, out) => {
        const cos = Math.cos(a), sin = Math.sin(a);
        return out.set(moveDir.x * cos - moveDir.z * sin, 0, moveDir.x * sin + moveDir.z * cos);
      };

      if (!clear(moveDir.x, moveDir.z)) {
        this.avoidTimer -= dt;
        if (this.avoidTimer <= 0) {
          this.avoidDir = Math.random() < 0.5 ? 1 : -1;
          this.avoidTimer = 1.4;
        }
        let found = false;
        for (const a of [0.5, 1.0, 1.5, 2.0, 2.5]) {
          for (const side of [this.avoidDir, -this.avoidDir]) {
            const cand = rot(a * side, V4);
            if (clear(cand.x, cand.z)) { moveDir.copy(cand); found = true; break; }
          }
          if (found) break;
        }
        if (!found) moveDir.set(-moveDir.x, 0, -moveDir.z);   // boxed in: back out
      }
    }

    // ---- stuck watchdog --------------------------------------------------
    // Geometry can still trap a hostile in a corner. If an alerted one has
    // not made progress for a while, pull it out and re-insert it elsewhere
    // so a wave can never stall forever.
    this.stuckTimer += dt;
    if (this.stuckTimer > 4) {
      // Judge progress by closing distance, not by movement: a hostile can
      // orbit a wall forever and look busy. One holding its preferred range
      // on purpose is exempt, so nobody gets yanked mid-firefight.
      const closed = this.lastDistCheck - dist;
      const holdingRange = sees && dist <= this.type.preferred * 1.4;
      if (dist > 4 && closed < 1.5 && !holdingRange) this.game.relocateEnemy(this);
      this.lastDistCheck = dist;
      this.stuckTimer = 0;
    }

    const speed = this.type.speed * (this.alerted ? 1 : 0.45);
    this.vel.lerp(V3.copy(moveDir).multiplyScalar(speed), Math.min(1, dt * 6));
    this.pos.addScaledVector(this.vel, dt);
    world.resolve(this.pos, this.radius, this.pos.y, 0.55);
    world.clampToBounds(this.pos, this.radius);

    // follow the surface underfoot: stairs and platforms carry hostiles too,
    // and stepping off a ledge drops them rather than leaving them floating
    const support = world.groundHeight(this.pos.x, this.pos.z, this.radius, this.pos.y + 0.55);
    if (support > this.pos.y) this.pos.y = Math.min(support, this.pos.y + dt * 6);
    else if (support < this.pos.y) this.pos.y = Math.max(support, this.pos.y - dt * 14);

    // separation so crowds do not stack into one body
    for (const other of this.game.enemies) {
      if (other === this || !other.alive) continue;
      const dx = this.pos.x - other.pos.x, dz = this.pos.z - other.pos.z;
      const dsq = dx * dx + dz * dz;
      const minD = this.radius + other.radius;
      if (dsq < minD * minD && dsq > 1e-5) {
        const d = Math.sqrt(dsq);
        const push = (minD - d) * 0.5;
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    }

    this.group.position.copy(this.pos);

    // face the player once alerted, otherwise face travel direction
    const faceTarget = this.alerted ? toPlayer : (this.vel.lengthSq() > 0.05 ? V3.copy(this.vel).normalize() : null);
    if (faceTarget) {
      const want = Math.atan2(faceTarget.x, faceTarget.z);
      let diff = want - this.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.group.rotation.y += diff * Math.min(1, dt * 7);
    }

    this._updateLaser(player, sees, time);
    this._animate(dt, dist);
    // hit detection raycasts against these meshes before the renderer runs,
    // so their world matrices have to be current now, not next frame
    this.group.updateMatrixWorld(true);

    // ---- shooting / melee ---------------------------------------------
    if (!this.alerted || !sees) return;
    const t = this.type;
    if (time < this.nextFire) return;

    if (t.melee) {
      if (dist < t.preferred + 0.9 && Math.abs(heightGap) < 1.8) {
        this.nextFire = time + t.rate + 0.6;
        this.swingT = 0.25;
        this.game.damagePlayer(t.damage, this.pos);
      }
      return;
    }

    if (dist > t.detect) return;
    // burst discipline
    if (t.burst) {
      if (this.burstLeft <= 0) this.burstLeft = t.burst;
      this.burstLeft--;
      this.nextFire = time + (this.burstLeft > 0 ? t.rate : t.burstPause * randRange(0.7, 1.3));
    } else {
      this.nextFire = time + t.rate * randRange(0.85, 1.3);
    }
    this._shoot(player, world);
  }

  _shoot(player, world) {
    const t = this.type;
    const muzzle = V3;
    this.parts.muzzle.getWorldPosition(muzzle);
    const dist = muzzle.distanceTo(player.position);
    const toPlayer = V4.copy(player.position).sub(muzzle).normalize();

    const shots = t.pellets || 1;
    let hits = 0;
    for (let i = 0; i < shots; i++) {
      const dir = V5.copy(toPlayer);
      dir.x += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.y += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.z += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.normalize();

      // hit test against the player's capsule, approximated by angle
      const hitAngle = Math.atan2(0.4, Math.max(1.5, dist));
      if (toPlayer.dot(dir) > Math.cos(hitAngle)) hits++;

      this.game.effects.tracer(muzzle, V1.copy(muzzle).addScaledVector(dir, Math.min(dist + 2, 70)), 0.8);
    }

    this.game.effects.muzzle(muzzle, t.pellets ? 1.4 : 0.9);
    audio.shot(t.sound || 'rifle', THREE.MathUtils.clamp(14 / Math.max(3, dist), 0.16, 1));

    if (hits > 0) {
      let dmg = t.damage * hits;
      if (t.falloff) dmg *= THREE.MathUtils.clamp(1 - (dist - t.preferred) / t.falloff, 0.25, 1);
      this.game.damagePlayer(dmg, this.pos);
    }
  }

  /** Sweep the aiming laser onto the target while the shot is lining up. */
  _updateLaser(player, sees, time) {
    const beam = this.parts.beam;
    if (!beam) return;
    const aiming = this.alerted && sees && this.nextFire - time < 1.1;
    beam.visible = aiming;
    if (!aiming) return;

    this.parts.muzzle.getWorldPosition(V3);
    // position is parent-local, but lookAt takes a world-space target, and
    // the length has to be divided out of the parent's scale
    beam.position.copy(beam.parent.worldToLocal(V4.copy(V3)));
    beam.lookAt(player.position);
    const scale = this.group.scale.x || 1;
    beam.scale.set(1 / scale, 1 / scale, V3.distanceTo(player.position) / scale);
    // pulses harder as the shot approaches
    beam.material.opacity = 0.25 + 0.5 * (1 - Math.max(0, (this.nextFire - time) / 1.1));
  }

  _animate(dt, dist) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (2 + speed * 2.6);
    const amp = Math.min(speed / 4, 1);
    const s = Math.sin(this.walkPhase) * 0.8 * amp;
    const c = Math.cos(this.walkPhase) * 0.55 * amp;
    if (this.parts.legL) this.parts.legL.rotation.x = s;
    if (this.parts.legR) this.parts.legR.rotation.x = -s;
    if (this.parts.armL) this.parts.armL.rotation.x = -s * 0.6;

    // right arm holds the weapon level once alerted
    const aim = this.alerted ? -0.15 : 0.2;
    if (this.parts.armR) this.parts.armR.rotation.x = aim + (this.swingT > 0 ? -1.6 : 0);
    if (this.swingT > 0) this.swingT -= dt;

    this.group.position.y = this.pos.y + Math.abs(Math.sin(this.walkPhase)) * 0.05 * amp;

    // eye flares when hurt
    if (this.parts.eye) {
      this.parts.eye.material.color.setHex(this.hurtFlash > 0 ? 0xffffff : 0xff4a2a);
    }
    if (this.parts.torso) {
      this.parts.torso.material.emissive?.setScalar?.(0);
    }
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
