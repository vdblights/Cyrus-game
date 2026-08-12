import * as THREE from 'three';
import { audio } from './audio.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();

export const FUSE = 2.7;              // seconds from pin pull to detonation
export const BLAST_RADIUS = 7.0;
export const BLAST_DAMAGE = 165;      // at the centre, falling off to ~15%

/**
 * Thrown frags. Grenades are pooled meshes that arc under gravity, bounce off
 * the city, and detonate on a fuse that starts when the pin is pulled — so
 * cooking one before the throw is both possible and dangerous.
 */
export class GrenadeSystem {
  constructor(scene, game, count = 8) {
    this.game = game;
    this.scene = scene;
    this.live = [];

    const body = new THREE.MeshLambertMaterial({ color: 0x39452f });
    const lever = new THREE.MeshLambertMaterial({ color: 0x6d6a5c });

    this.pool = [];
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), body);
      shell.scale.set(1, 1.25, 1);
      shell.castShadow = true;
      g.add(shell);
      const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.075, 0.03), lever);
      spoon.position.set(0.07, 0.03, 0);
      g.add(spoon);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02),
        new THREE.MeshBasicMaterial({ color: 0xff3020 }));
      led.position.set(0, 0.1, 0);
      g.add(led);
      g.visible = false;
      scene.add(g);
      this.pool.push({
        group: g, led,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
        fuse: 0, active: false, trail: 0,
      });
    }
  }

  /**
   * @param {THREE.Vector3} origin eye position
   * @param {THREE.Vector3} dir    view direction
   * @param {number} fuse          time left before it goes off
   * @param {THREE.Vector3} inherit player velocity, added to the throw
   */
  throw_(origin, dir, fuse, inherit) {
    const g = this.pool.find((x) => !x.active);
    if (!g) return null;
    g.pos.copy(origin).addScaledVector(dir, 0.5);
    g.pos.y -= 0.1;
    g.vel.copy(dir).multiplyScalar(17).addScaledVector(V1.set(0, 1, 0), 2.4);
    if (inherit) g.vel.add(V2.copy(inherit).multiplyScalar(0.5));
    g.spin.set(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7);
    g.fuse = fuse;
    g.active = true;
    g.trail = 0;
    g.group.visible = true;
    g.group.position.copy(g.pos);
    return g;
  }

  /** Drop one at the player's feet — what a cook-off in the hand looks like. */
  dropAtFeet(pos) {
    const g = this.pool.find((x) => !x.active);
    if (!g) return null;
    g.pos.copy(pos);
    g.vel.set(0, 0, 0);
    g.fuse = 0.001;
    g.active = true;
    g.group.visible = true;
    g.group.position.copy(g.pos);
    return g;
  }

  update(dt, world) {
    for (const g of this.pool) {
      if (!g.active) continue;

      g.vel.y -= 19 * dt;
      g.pos.addScaledVector(g.vel, dt);
      const contact = world.bounceSphere(g.pos, g.vel, 0.09);
      if (contact === 1) {
        if (g.vel.lengthSq() > 1.6) audio.grenadeBounce();
        g.spin.multiplyScalar(0.6);
      } else if (contact === 2) {
        // rolling: bleed off speed over time rather than all at once
        const drag = Math.max(0, 1 - 2.6 * dt);
        g.vel.x *= drag;
        g.vel.z *= drag;
        g.spin.multiplyScalar(drag);
      }
      world.clampToBounds(g.pos, 0.1);

      g.group.position.copy(g.pos);
      g.group.rotation.x += g.spin.x * dt;
      g.group.rotation.y += g.spin.y * dt;
      g.group.rotation.z += g.spin.z * dt;

      // smoke trail while it is still moving
      g.trail -= dt;
      if (g.trail <= 0 && g.vel.lengthSq() > 2) {
        g.trail = 0.05;
        this.game.effects.trailPuff(g.pos);
      }

      // the fuse LED blinks faster the closer it gets
      const blink = Math.max(0.06, g.fuse * 0.2);
      g.led.visible = (performance.now() / 1000 % blink) < blink * 0.5;

      g.fuse -= dt;
      if (g.fuse <= 0) this.detonate(g);
    }
  }

  detonate(g) {
    g.active = false;
    g.group.visible = false;
    this.game.explode(g.pos);
  }

  reset() {
    for (const g of this.pool) { g.active = false; g.group.visible = false; }
  }
}
