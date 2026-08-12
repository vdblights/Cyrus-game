/**
 * Collision + occlusion world.
 *
 * Everything solid is registered as an axis-aligned box. Entities are
 * treated as vertical cylinders and pushed out along the shallowest axis,
 * which is cheap and stable for a city made of rectangles.
 */
export class World {
  constructor() {
    /** @type {{minX:number,maxX:number,minZ:number,maxZ:number,top:number}[]} */
    this.boxes = [];
    /** Meshes used for bullet/line-of-sight raycasts. */
    this.solids = [];
    this.bounds = 100;
  }

  addBox(minX, minZ, maxX, maxZ, top) {
    this.boxes.push({ minX, maxX, minZ, maxZ, top });
  }

  /** Register a box-shaped mesh as both a collider and a raycast target. */
  addSolid(mesh, halfW, halfD, top) {
    this.solids.push(mesh);
    const p = mesh.position;
    this.addBox(p.x - halfW, p.z - halfD, p.x + halfW, p.z + halfD, top);
  }

  /**
   * Push a cylinder (centre `pos`, `radius`) out of every box it overlaps.
   * `feet` is the entity's floor height; boxes shorter than `step` are
   * ignored so debris does not become an invisible wall.
   */
  resolve(pos, radius, feet = 0, step = 0.35) {
    for (const b of this.boxes) {
      if (b.top <= feet + step) continue;
      const closestX = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const closestZ = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - closestX;
      const dz = pos.z - closestZ;
      const distSq = dx * dx + dz * dz;
      if (distSq >= radius * radius) continue;

      if (distSq > 1e-6) {
        const d = Math.sqrt(distSq);
        const push = radius - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        // centre is inside the box: eject along the nearest face
        const toLeft = pos.x - b.minX, toRight = b.maxX - pos.x;
        const toBack = pos.z - b.minZ, toFront = b.maxZ - pos.z;
        const m = Math.min(toLeft, toRight, toBack, toFront);
        if (m === toLeft) pos.x = b.minX - radius;
        else if (m === toRight) pos.x = b.maxX + radius;
        else if (m === toBack) pos.z = b.minZ - radius;
        else pos.z = b.maxZ + radius;
      }
    }
  }

  /** True when a point is inside (or within `pad` of) any solid box. */
  occupied(x, z, pad = 0, minTop = 1.2) {
    for (const b of this.boxes) {
      if (b.top < minTop) continue;
      if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad) return true;
    }
    return false;
  }

  /**
   * Cheap 2D line-of-sight test against the box list (slab method), used by
   * enemies before they take a shot.
   */
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;

    for (const box of this.boxes) {
      let t0 = 0, t1 = 1;
      let tA = (box.minX - ax) * invX, tB = (box.maxX - ax) * invX;
      if (tA > tB) [tA, tB] = [tB, tA];
      t0 = Math.max(t0, tA); t1 = Math.min(t1, tB);
      if (t0 > t1) continue;

      tA = (box.minZ - az) * invZ; tB = (box.maxZ - az) * invZ;
      if (tA > tB) [tA, tB] = [tB, tA];
      t0 = Math.max(t0, tA); t1 = Math.min(t1, tB);
      if (t0 > t1) continue;

      // vertical check at the entry point: shots can pass over low cover
      const yAt = ay + (by - ay) * t0;
      if (yAt < box.top) return false;
    }
    return true;
  }

  /**
   * Bounce a sphere (a thrown grenade) off the ground and off every box it
   * hits, resolving along the shallowest of the three axes and reflecting
   * that velocity component.
   *
   * @returns {0|1|2} 0 = free, 1 = bounced off something, 2 = resting on a
   *          surface (the caller applies rolling drag)
   */
  bounceSphere(pos, vel, radius, restitution = 0.36, friction = 0.72) {
    let contact = 0;

    if (pos.y - radius <= 0) {
      pos.y = radius;
      if (vel.y < 0) {
        if (vel.y < -1.4) {
          // a real bounce: reverse and scrub some speed off the surface
          vel.y = -vel.y * restitution;
          vel.x *= friction;
          vel.z *= friction;
          contact = 1;
        } else {
          vel.y = 0;             // settled — it rolls from here
          contact = Math.max(contact, 2);
        }
      }
    }

    for (const b of this.boxes) {
      if (pos.y - radius > b.top) continue;
      const closestX = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const closestZ = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - closestX, dz = pos.z - closestZ;
      if (dx * dx + dz * dz >= radius * radius) continue;

      // three candidate escapes: out the sides, or up onto the top face
      const outX = dx >= 0 ? b.maxX + radius - pos.x : b.minX - radius - pos.x;
      const outZ = dz >= 0 ? b.maxZ + radius - pos.z : b.minZ - radius - pos.z;
      const outY = b.top + radius - pos.y;
      const aX = Math.abs(outX), aZ = Math.abs(outZ), aY = Math.abs(outY);

      if (aY <= aX && aY <= aZ) {
        pos.y += outY;
        if (vel.y < 0) {
          if (vel.y < -1.4) {
            vel.y = -vel.y * restitution;
            vel.x *= friction;
            vel.z *= friction;
            contact = 1;
          } else {
            vel.y = 0;
            contact = Math.max(contact, 2);
          }
        }
      } else if (aX <= aZ) {
        pos.x += outX;
        vel.x = -vel.x * restitution;
        vel.z *= friction;
        contact = 1;
      } else {
        pos.z += outZ;
        vel.z = -vel.z * restitution;
        vel.x *= friction;
        contact = 1;
      }
    }
    return contact;
  }

  /** Keep an entity inside the play area. */
  clampToBounds(pos, radius = 0.5) {
    const lim = this.bounds - radius;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }
}

export function randRange(a, b) { return a + Math.random() * (b - a); }
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
