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
    this.fallback = false;      // pointer lock refused: steer without capture
    this.pointerInside = false;
    this.steer = new THREE.Vector2();   // -1..1 offset from screen centre
    this.sensitivity = 1;
    this.invertY = false;
    this.onKey = null;
    this.onKeyUp = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (this.onKey) this.onKey(e.code, e);
      if (['Space', 'Tab', 'ControlLeft', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.onKeyUp) this.onKeyUp(e.code, e);
    });
    addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.aim = false; });

    canvas.addEventListener('mouseenter', () => { this.pointerInside = true; });
    canvas.addEventListener('mouseleave', () => {
      // stop turning rather than freezing mid-swing when the cursor leaves
      this.pointerInside = false;
      this.steer.set(0, 0);
      this.fire = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fallback) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.lookDelta.x += e.movementX * 0.0022 * this.sensitivity;
        this.lookDelta.y += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
        return;
      }
      if (!this.fallback) return;
      // Without capture, movement deltas die at the window edge — the cursor
      // simply stops. Steer by where the cursor sits instead: offset from the
      // centre becomes a turn rate, which keeps working at the very edge and
      // survives the pointer leaving entirely.
      const r = canvas.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      const dead = 0.12;
      const shape = (v) => {
        const a = Math.abs(v);
        if (a < dead) return 0;
        // ease in past the dead zone so small movements stay controllable
        const t = (a - dead) / (1 - dead);
        return Math.sign(v) * t * t;
      };
      this.steer.set(shape(nx), shape(ny) * (this.invertY ? -1 : 1));
      this.pointerInside = nx > -1 && nx < 1 && ny > -1 && ny < 1;
    });
    addEventListener('wheel', (e) => {
      if (this.locked || this.fallback) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) {
        // real capture beats steering: drop back out of the fallback
        this.fallback = false;
        this.steer.set(0, 0);
      } else {
        this.fire = false; this.aim = false; this.keys.clear();
      }
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  /**
   * Ask for pointer lock, and fall back to unlocked mouse-look if it is
   * refused — embedded frames and some browsers deny it, and the game still
   * has to be playable there.
   */
  requestLock() {
    if (!this.canvas.requestPointerLock) { this.enableFallback(); return; }
    // always worth another try: a denial can be temporary (Chrome rate-limits
    // re-locking after Esc), and succeeding later should restore real capture
    try {
      const res = this.canvas.requestPointerLock();
      if (res && typeof res.catch === 'function') res.catch(() => this.enableFallback());
    } catch {
      this.enableFallback();
    }
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => { if (!this.locked) this.enableFallback(); }, 700);
  }

  enableFallback() {
    if (this.fallback) return;
    this.fallback = true;
    if (this.onFallback) this.onFallback();
  }
  exitLock() { document.exitPointerLock?.(); }
  down(code) { return this.keys.has(code); }
  endFrame() { this.lookDelta.set(0, 0); this.wheel = 0; }
}

const TARGET = new THREE.Vector3();
const EYE_STAND = 1.68;
const EYE_CROUCH = 1.05;
const GRAVITY = 22;
const STEP_HEIGHT = 0.55;      // how high you can walk up without jumping
const FALL_SAFE = 13;          // impact speed you can absorb unhurt (~4 m drop)
const MANTLE_HEIGHT = 1.8;     // highest ledge you can haul yourself onto
const MANTLE_TIME = 0.45;      // seconds the pull-up takes

const smooth = (t) => t * t * (3 - 2 * t);

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
    this.mantle = null;
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
    const turn = 2.2 * dt;
    if (input.down('ArrowLeft')) this.yaw += turn;
    if (input.down('ArrowRight')) this.yaw -= turn;
    if (input.down('ArrowUp')) this.pitch += turn * 0.7;
    if (input.down('ArrowDown')) this.pitch -= turn * 0.7;

    // uncaptured mouse: cursor offset from centre drives a turn rate
    if (input.fallback && input.pointerInside) {
      const rate = 3.1 * dt * input.sensitivity;
      this.yaw -= input.steer.x * rate;
      this.pitch -= input.steer.y * rate * 0.75;
    }

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

    // A pull-up already in flight runs to completion before anything else.
    if (this.mantle) {
      this._advanceMantle(dt);
      this._applyCamera(dt, 0);
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

    // ---- mantle ----------------------------------------------------------
    // Jump into a waist-to-chest ledge and you climb it instead of bouncing
    // off it. Direction of travel if you are moving, where you are looking if
    // you are standing still — so a car roof is one keypress either way.
    if (input.down('Space')
        && this.tryMantle(moving ? wx : -sin, moving ? wz : -cos)) {
      this._advanceMantle(dt);
      this._applyCamera(dt, 0);
      return;
    }

    // ---- jump / gravity -------------------------------------------------
    if (input.down('Space') && this.onGround) {
      this.velocity.y = 7.4;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;
    this.feetY += this.velocity.y * dt;

    // Move horizontally first. Anything no taller than a step above the feet
    // is walkable, so it does not block — the support check below lifts you.
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.world.resolve(this.position, this.radius, this.feetY, STEP_HEIGHT);
    this.world.clampToBounds(this.position, this.radius);

    // ---- footing ---------------------------------------------------------
    const ceiling = this.feetY + (this.onGround ? STEP_HEIGHT : 0.02);
    const support = this.world.groundHeight(this.position.x, this.position.z, this.radius, ceiling);
    if (this.feetY <= support + 1e-4) {
      if (this.velocity.y < -FALL_SAFE && this.onFallDamage) {
        this.onFallDamage(Math.round((-this.velocity.y - FALL_SAFE) * 6));
      }
      this.feetY = support;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      // walked off an edge
      this.onGround = false;
    }

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

    this._applyCamera(dt, roll);
  }

  _applyCamera(dt, roll) {
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

  /**
   * Advance a pull-up. It owns the player's position for its duration — no
   * gravity, no collision, no walking — so it cannot be interrupted halfway
   * and leave you inside the ledge you were climbing.
   */
  _advanceMantle(dt) {
    const m = this.mantle;
    m.t = Math.min(1, m.t + dt / MANTLE_TIME);
    // hands go up first, feet swing over after: rising leads the reach
    const rise = smooth(Math.min(1, m.t / 0.55));
    const reach = smooth(Math.max(0, (m.t - 0.28) / 0.72));
    this.feetY = m.fromY + (m.top - m.fromY) * rise;
    this.position.x = m.fromX + (m.x - m.fromX) * reach;
    this.position.z = m.fromZ + (m.z - m.fromZ) * reach;
    // ducked through the climb, standing again as you top out
    this.eyeHeight = EYE_CROUCH + (EYE_STAND - EYE_CROUCH) * smooth(Math.max(0, (m.t - 0.5) / 0.5));
    if (m.t >= 1) {
      this.mantle = null;
      this.onGround = true;
      this.velocity.set(0, 0, 0);
    }
    this.position.y = this.feetY + this.eyeHeight;
  }

  /**
   * Start a pull-up if there is a ledge to grab in the given direction.
   * @returns {boolean} whether one started
   */
  tryMantle(dirX, dirZ) {
    if (this.mantle || this.dead || this.crouching || this.stamina < 0.12) return false;
    const ledge = this.world.mantleTarget(
      this.position.x, this.position.z, this.radius, this.feetY,
      dirX, dirZ, STEP_HEIGHT + 0.05, MANTLE_HEIGHT);
    if (!ledge) return false;

    this.mantle = {
      t: 0,
      fromX: this.position.x, fromZ: this.position.z, fromY: this.feetY,
      x: ledge.x, z: ledge.z, top: ledge.top,
    };
    this.stamina = Math.max(0, this.stamina - 0.12);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    if (this.onMantle) this.onMantle();
    return true;
  }
}
