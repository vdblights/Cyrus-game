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

  /**
   * Height of the highest surface an entity standing at (x, z) could be
   * supported by, ignoring anything above `ceiling` (their feet plus a step).
   * Street level is 0.
   */
  groundHeight(x, z, radius, ceiling) {
    let best = 0;
    for (const b of this.boxes) {
      if (b.top > ceiling || b.top <= best) continue;
      const closestX = Math.max(b.minX, Math.min(x, b.maxX));
      const closestZ = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - closestX, dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) best = b.top;
    }
    return best;
  }

  /**
   * Find a ledge in front of an entity that it could pull itself onto.
   *
   * Reads the same box list as everything else: a ledge is any surface
   * between `minRise` and `maxRise` above the feet with nothing taller at the
   * same spot (that would be a wall face, not a lip) and enough deck past the
   * edge to stand on.
   *
   * @returns {{top:number,x:number,z:number}|null} the landing spot
   */
  mantleTarget(x, z, radius, feet, dirX, dirZ, minRise, maxRise) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return null;
    const nx = dirX / len, nz = dirZ / len;
    const grip = radius * 0.55;          // the hands, not the whole body

    for (let d = radius + 0.1; d <= radius + 0.95; d += 0.18) {
      const gx = x + nx * d, gz = z + nz * d;
      const top = this.groundHeight(gx, gz, grip, feet + maxRise);
      if (top < feet + minRise) continue;
      // anything taller here means we are staring at a wall, not gripping a lip
      if (this.groundHeight(gx, gz, grip, Infinity) > top + 0.05) continue;

      // room for a body past the edge, at the same height
      const lx = x + nx * (d + radius + 0.15), lz = z + nz * (d + radius + 0.15);
      if (this.groundHeight(lx, lz, radius, Infinity) > top + 0.05) continue;
      if (this.groundHeight(lx, lz, radius, top + 0.05) < top - 0.25) continue;

      return { top, x: lx, z: lz };
    }
    return null;
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
   * Segment-vs-box test over the whole box list (three-slab method). Boxes
   * run from the ground to `top`, so a sight line clears low cover by
   * passing over it.
   *
   * This is deliberately symmetric: swapping the endpoints gives the same
   * answer, so a hostile can never see a target that cannot see it back.
   */
  lineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (dx * dx + dy * dy + dz * dz < 1e-8) return true;
    const invX = dx !== 0 ? 1 / dx : Infinity;
    const invY = dy !== 0 ? 1 / dy : Infinity;
    const invZ = dz !== 0 ? 1 / dz : Infinity;

    for (const box of this.boxes) {
      let t0 = 0, t1 = 1;

      let tA = (box.minX - ax) * invX, tB = (box.maxX - ax) * invX;
      if (tA > tB) { const t = tA; tA = tB; tB = t; }
      if (tA > t0) t0 = tA;
      if (tB < t1) t1 = tB;
      if (t0 > t1) continue;

      tA = (0 - ay) * invY; tB = (box.top - ay) * invY;
      if (tA > tB) { const t = tA; tA = tB; tB = t; }
      if (tA > t0) t0 = tA;
      if (tB < t1) t1 = tB;
      if (t0 > t1) continue;

      tA = (box.minZ - az) * invZ; tB = (box.maxZ - az) * invZ;
      if (tA > tB) { const t = tA; tA = tB; tB = t; }
      if (tA > t0) t0 = tA;
      if (tB < t1) t1 = tB;
      if (t0 > t1) continue;

      return false;
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
