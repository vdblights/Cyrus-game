/**
 * Collision + occlusion world.
 *
 * Everything solid is registered as a box. Entities are treated as vertical
 * cylinders and pushed out along the shallowest axis, which is cheap and
 * stable for a city made of rectangles.
 *
 * A box may be turned about Y. It still carries `minX..maxZ` — the enclosing
 * AABB — so every loop can reject cheaply and anything that only wants a
 * bound can read one; the footprint itself lives in `cx/cz/hx/hz` plus the
 * `cos/sin` of its turn, and the tests below work in the box's own frame,
 * where it is axis-aligned like all the others. For a box that is not turned
 * that transform is the identity, so there is one code path, not two.
 */

/**
 * How much floor has to be under you to hold you up. This is deliberately
 * *not* the body radius: supporting an entity anywhere its whole 0.42 m
 * cylinder overlapped a surface meant you stood half a metre out past a roof
 * edge on nothing, any gap narrower than two radii was invisibly bridged so
 * you ran between crates that are plainly separate, and a kerb lifted you
 * before you reached it. A foot is small. Keep it big enough to span the
 * construction seams between abutting boxes (a stacked container is jittered
 * up to 0.4 m, leaving joints of 0.05-0.15 m) and no bigger.
 */
export const SUPPORT_RADIUS = 0.12;

export class World {
  constructor() {
    /** @type {{minX:number,maxX:number,minZ:number,maxZ:number,top:number,
     *           cx:number,cz:number,hx:number,hz:number,cos:number,sin:number}[]} */
    this.boxes = [];
    /** Meshes used for bullet/line-of-sight raycasts. */
    this.solids = [];
    this.bounds = 100;
  }

  addBox(minX, minZ, maxX, maxZ, top) {
    this.boxes.push({
      minX, maxX, minZ, maxZ, top,
      cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
      hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2,
      cos: 1, sin: 0,
    });
  }

  /**
   * Register a box turned `rot` about Y, the way three turns a mesh.
   *
   * The alternative is what the props used to do — register the enclosing
   * AABB and live with it — and it is worse than it sounds: a 2.5 x 6 m
   * container at 30 degrees claims 5.2 x 5.8 m, so you stop dead at a corner
   * a metre and a half from anything you can see, and two props that are
   * clearly a stride apart have colliders that touch.
   */
  addRotatedBox(cx, cz, halfW, halfD, rot, top) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const ex = Math.abs(halfW * cos) + Math.abs(halfD * sin);
    const ez = Math.abs(halfW * sin) + Math.abs(halfD * cos);
    this.boxes.push({
      minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, top,
      cx, cz, hx: halfW, hz: halfD, cos, sin,
    });
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
      if (pos.x <= b.minX - radius || pos.x >= b.maxX + radius
          || pos.z <= b.minZ - radius || pos.z >= b.maxZ + radius) continue;

      // into the box's frame, where it is axis-aligned
      const rx = pos.x - b.cx, rz = pos.z - b.cz;
      const lx = b.cos * rx - b.sin * rz;
      const lz = b.sin * rx + b.cos * rz;
      const nearX = lx < -b.hx ? -b.hx : lx > b.hx ? b.hx : lx;
      const nearZ = lz < -b.hz ? -b.hz : lz > b.hz ? b.hz : lz;
      const dx = lx - nearX, dz = lz - nearZ;
      const distSq = dx * dx + dz * dz;
      if (distSq >= radius * radius) continue;

      let px = 0, pz = 0;                      // the push, still in that frame
      if (distSq > 1e-6) {
        const d = Math.sqrt(distSq);
        const push = radius - d;
        px = (dx / d) * push;
        pz = (dz / d) * push;
      } else {
        // centre is inside the footprint: eject through the nearest face
        const toMinX = lx + b.hx, toMaxX = b.hx - lx;
        const toMinZ = lz + b.hz, toMaxZ = b.hz - lz;
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX) px = -(toMinX + radius);
        else if (m === toMaxX) px = toMaxX + radius;
        else if (m === toMinZ) pz = -(toMinZ + radius);
        else pz = toMaxZ + radius;
      }
      pos.x += b.cos * px + b.sin * pz;
      pos.z += -b.sin * px + b.cos * pz;
    }
  }

  /**
   * Height of the highest surface an entity standing at (x, z) could be
   * supported by, ignoring anything above `ceiling` (their feet plus a step).
   * Street level is 0.
   *
   * `radius` is how far from (x, z) a surface still counts, and what it means
   * depends on the question being asked: footing passes `SUPPORT_RADIUS`,
   * because that is how much floor holds a body up, while a clearance test
   * ("is anything in the way of a whole body here?") passes the body radius.
   */
  groundHeight(x, z, radius, ceiling) {
    let best = 0;
    const rSq = radius * radius;
    for (const b of this.boxes) {
      if (b.top > ceiling || b.top <= best) continue;
      if (x <= b.minX - radius || x >= b.maxX + radius
          || z <= b.minZ - radius || z >= b.maxZ + radius) continue;
      const rx = x - b.cx, rz = z - b.cz;
      const lx = b.cos * rx - b.sin * rz;
      const lz = b.sin * rx + b.cos * rz;
      const dx = Math.max(0, Math.abs(lx) - b.hx);
      const dz = Math.max(0, Math.abs(lz) - b.hz);
      if (dx * dx + dz * dz < rSq) best = b.top;
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
   * `top` is the lip you grip; `land` is what you end up standing on past it,
   * which is allowed to sit a little lower. A climb that aims straight at
   * `land` cuts the corner off through the lip, and one that stops at `top`
   * hands back in mid-air — so the caller gets both and clears one before
   * settling onto the other.
   *
   * @returns {{top:number,land:number,x:number,z:number}|null} the landing spot
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
      // What you will actually be standing on, asked the way footing asks it.
      // Measuring the deck with the body radius promised ground that the
      // footing check would not then find, so a climb onto a narrow ledge
      // finished and dropped you straight off it.
      const land = this.groundHeight(lx, lz, SUPPORT_RADIUS, top + 0.05);
      if (land < top - 0.25) continue;

      return { top, land, x: lx, z: lz };
    }
    return null;
  }

  /**
   * True when a point is inside (or within `pad` of) any solid box.
   *
   * Reads the enclosing AABB rather than the footprint, so a turned box
   * claims a little more than it occupies. That is the safe direction here:
   * every caller is placing something (an objective, a spawn) and wants to
   * be clear of the prop, not flush against it.
   */
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

      // For a turned box all of the above was a bound, not an answer — it is
      // the corners of the AABB that stick out past the prop. Confirm against
      // the footprint before calling the line blocked, or a container at an
      // angle gives cover from a metre to the side of itself.
      if (box.sin !== 0 && !this._blockedByFootprint(box, ax, ay, az, dx, dy, dz)) continue;

      return false;
    }
    return true;
  }

  /** The same three-slab test, run in a turned box's own frame. */
  _blockedByFootprint(b, ax, ay, az, dx, dy, dz) {
    const rx = ax - b.cx, rz = az - b.cz;
    const ox = b.cos * rx - b.sin * rz;
    const oz = b.sin * rx + b.cos * rz;
    const ldx = b.cos * dx - b.sin * dz;
    const ldz = b.sin * dx + b.cos * dz;
    const invX = ldx !== 0 ? 1 / ldx : Infinity;
    const invY = dy !== 0 ? 1 / dy : Infinity;
    const invZ = ldz !== 0 ? 1 / ldz : Infinity;
    let t0 = 0, t1 = 1;

    let tA = (-b.hx - ox) * invX, tB = (b.hx - ox) * invX;
    if (tA > tB) { const t = tA; tA = tB; tB = t; }
    if (tA > t0) t0 = tA;
    if (tB < t1) t1 = tB;
    if (t0 > t1) return false;

    tA = (0 - ay) * invY; tB = (b.top - ay) * invY;
    if (tA > tB) { const t = tA; tA = tB; tB = t; }
    if (tA > t0) t0 = tA;
    if (tB < t1) t1 = tB;
    if (t0 > t1) return false;

    tA = (-b.hz - oz) * invZ; tB = (b.hz - oz) * invZ;
    if (tA > tB) { const t = tA; tA = tB; tB = t; }
    if (tA > t0) t0 = tA;
    if (tB < t1) t1 = tB;
    return t0 <= t1;
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
      if (pos.x <= b.minX - radius || pos.x >= b.maxX + radius
          || pos.z <= b.minZ - radius || pos.z >= b.maxZ + radius) continue;

      // in the box's frame: the face it leaves through is one of its own,
      // not one of the world's
      const rx = pos.x - b.cx, rz = pos.z - b.cz;
      const lx = b.cos * rx - b.sin * rz;
      const lz = b.sin * rx + b.cos * rz;
      const nearX = lx < -b.hx ? -b.hx : lx > b.hx ? b.hx : lx;
      const nearZ = lz < -b.hz ? -b.hz : lz > b.hz ? b.hz : lz;
      const dx = lx - nearX, dz = lz - nearZ;
      if (dx * dx + dz * dz >= radius * radius) continue;

      // three candidate escapes: out the sides, or up onto the top face
      const outX = dx >= 0 ? b.hx + radius - lx : -b.hx - radius - lx;
      const outZ = dz >= 0 ? b.hz + radius - lz : -b.hz - radius - lz;
      const outY = b.top + radius - pos.y;
      const aX = Math.abs(outX), aZ = Math.abs(outZ), aY = Math.abs(outY);

      if (aY <= aX && aY <= aZ) {
        pos.y += outY;
        if (vel.y < 0) {
          if (vel.y < -1.4) {
            vel.y = -vel.y * restitution;
            // an even scrub of the horizontal speed, so no frame needed
            vel.x *= friction;
            vel.z *= friction;
            contact = 1;
          } else {
            vel.y = 0;
            contact = Math.max(contact, 2);
          }
        }
      } else {
        // reflect the component normal to that face, scrub the one along it
        const vlx = b.cos * vel.x - b.sin * vel.z;
        const vlz = b.sin * vel.x + b.cos * vel.z;
        let nx, nz;
        if (aX <= aZ) {
          pos.x += b.cos * outX; pos.z += -b.sin * outX;
          nx = -vlx * restitution; nz = vlz * friction;
        } else {
          pos.x += b.sin * outZ; pos.z += b.cos * outZ;
          nx = vlx * friction; nz = -vlz * restitution;
        }
        vel.x = b.cos * nx + b.sin * nz;
        vel.z = -b.sin * nx + b.cos * nz;
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
