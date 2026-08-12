import * as THREE from 'three';

/** Keyboard + mouse state, including pointer-lock look deltas. */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.fire = false;
    this.aim = false;
    this.lookDelta = new THREE.Vector2();
    this.wheel = 0;
    this.locked = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.onKey = null;
    this.onKeyUp = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (this.onKey) this.onKey(e.code, e);
      if (['Space', 'Tab', 'ControlLeft'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.onKeyUp) this.onKeyUp(e.code, e);
    });
    addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.aim = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookDelta.x += e.movementX * 0.0022 * this.sensitivity;
      this.lookDelta.y += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
    });
    addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.fire = false; this.aim = false; this.keys.clear(); }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  requestLock() { this.canvas.requestPointerLock?.(); }
  exitLock() { document.exitPointerLock?.(); }
  down(code) { return this.keys.has(code); }
  endFrame() { this.lookDelta.set(0, 0); this.wheel = 0; }
}

const TARGET = new THREE.Vector3();
const EYE_STAND = 1.68;
const EYE_CROUCH = 1.05;
const GRAVITY = 22;

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.position = new THREE.Vector3(0, EYE_STAND, 0);   // eye position
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.radius = 0.42;
    this.reset(0, 0);
  }

  reset(x, z) {
    this.position.set(x, EYE_STAND, z);
    this.velocity.set(0, 0, 0);
    this.feetY = 0;
    this.eyeHeight = EYE_STAND;
    this.onGround = true;
    this.crouching = false;
    this.sprinting = false;
    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 1;
    this.lastDamageTime = -99;
    this.bobPhase = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.dead = false;
    this.stepTimer = 0;
    this.shake = 0;
  }

  applyRecoil(v, h) {
    this.recoilPitch += v;
    this.recoilYaw += h;
  }

  /** Camera trauma, 0..1 — squared on use so small knocks stay subtle. */
  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** @param {number} time game clock, so regeneration measures the same units */
  damage(amount, time) {
    if (this.dead) return false;
    this.health -= amount;
    this.lastDamageTime = time;
    if (this.health <= 0) { this.health = 0; this.dead = true; return true; }
    return false;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  update(dt, time, input) {
    // ---- look ----------------------------------------------------------
    this.yaw -= input.lookDelta.x;
    this.pitch -= input.lookDelta.y;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    // recoil decays back toward the original point of aim
    this.recoilPitch = THREE.MathUtils.damp(this.recoilPitch, 0, 6, dt);
    this.recoilYaw = THREE.MathUtils.damp(this.recoilYaw, 0, 6, dt);

    if (this.dead) {
      this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, 0.35, 4, dt);
      this.position.y = this.feetY + this.eyeHeight;
      this.camera.position.copy(this.position);
      this.camera.rotation.set(this.pitch * 0.4, this.yaw, 0.55, 'YXZ');
      return;
    }

    // ---- intent --------------------------------------------------------
    let ix = 0, iz = 0;
    if (input.down('KeyW')) iz -= 1;
    if (input.down('KeyS')) iz += 1;
    if (input.down('KeyA')) ix -= 1;
    if (input.down('KeyD')) ix += 1;
    const moving = ix !== 0 || iz !== 0;

    this.crouching = input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyC');
    // firing or aiming drops you out of a sprint
    const wantSprint = (input.down('ShiftLeft') || input.down('ShiftRight'))
      && iz < 0 && !this.crouching && !input.aim && !input.fire;
    this.sprinting = wantSprint && this.stamina > 0.02;

    if (this.sprinting && moving) this.stamina = Math.max(0, this.stamina - dt * 0.28);
    else this.stamina = Math.min(1, this.stamina + dt * (moving ? 0.16 : 0.32));

    let speed = 5.2;
    if (this.sprinting) speed = 8.2;
    if (this.crouching) speed = 2.6;
    if (input.aim && !this.sprinting) speed *= 0.55;
    if (!this.onGround) speed *= 0.92;

    // ---- horizontal movement -------------------------------------------
    // camera forward is (-sin yaw, -cos yaw); right is (cos yaw, -sin yaw)
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = 0, wz = 0;
    if (moving) {
      const len = Math.hypot(ix, iz);
      const nx = ix / len, nz = iz / len;
      wx = sin * nz + cos * nx;
      wz = cos * nz - sin * nx;
    }
    const target = TARGET.set(wx * speed, 0, wz * speed);
    const accel = this.onGround ? 14 : 3.5;
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, target.x, accel, dt);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, target.z, accel, dt);

    // ---- jump / gravity -------------------------------------------------
    if (input.down('Space') && this.onGround) {
      this.velocity.y = 7.4;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;
    this.feetY += this.velocity.y * dt;
    if (this.feetY <= 0) { this.feetY = 0; this.velocity.y = 0; this.onGround = true; }

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.world.resolve(this.position, this.radius, this.feetY, 0.45);
    this.world.clampToBounds(this.position, this.radius);

    // ---- view height, bob ----------------------------------------------
    const wantEye = this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, wantEye, 12, dt);

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bobPhase += dt * (hSpeed * 1.6 + 1);
    const bob = this.onGround ? Math.sin(this.bobPhase * 2) * 0.022 * Math.min(hSpeed / 6, 1) : 0;
    const roll = Math.sin(this.bobPhase) * 0.006 * Math.min(hSpeed / 6, 1);

    this.position.y = this.feetY + this.eyeHeight + bob;

    // footsteps
    if (this.onGround && hSpeed > 1.5) {
      this.stepTimer -= dt * hSpeed;
      if (this.stepTimer <= 0) {
        this.stepTimer = 4.2;
        if (this.onStep) this.onStep();
      }
    }

    // ---- health regeneration -------------------------------------------
    if (time - this.lastDamageTime > 5 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + dt * 9);
    }

    // ---- apply to camera -------------------------------------------------
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const trauma = this.shake * this.shake;
    const sx = trauma * (Math.random() - 0.5) * 0.09;
    const sy = trauma * (Math.random() - 0.5) * 0.09;
    const sr = trauma * (Math.random() - 0.5) * 0.07;

    this.camera.position.copy(this.position);
    this.camera.position.y += trauma * (Math.random() - 0.5) * 0.06;
    this.camera.rotation.set(
      this.pitch + this.recoilPitch + sy,
      this.yaw + this.recoilYaw + sx,
      roll + sr, 'YXZ');
  }
}
