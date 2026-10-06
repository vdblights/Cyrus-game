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

/** Room a body needs over its feet to stand: a mantle onto less is refused. */
export const HEADROOM = 1.9;

/**
 * The boxes a query has to look at: from the index once the city is sealed
 * (`World.seal`), or all of them — which is also what a check gets when it
 * calls a reader on a box list of its own.
 */
function near(world, x0, z0, x1, z1) {
  if (!world._cells || world._sealed !== world.boxes.length) return world.boxes;
  return world._near(x0, z0, x1, z1);
}

export class World {
  constructor() {
    /** @type {{minX:number,maxX:number,minZ:number,maxZ:number,top:number,
     *           cx:number,cz:number,hx:number,hz:number,cos:number,sin:number}[]} */
    this.boxes = [];
    /** Meshes used for bullet/line-of-sight raycasts. */
    this.solids = [];
    /**
     * The open ground floors, for anything that wants to find one: footprint,
     * floor and ceiling heights, and each doorway's middle and outward normal.
     * Nothing collides with this; the walls and the ceiling are in `boxes`.
     */
    this.rooms = [];
    /**
     * The stairwells that climb from a ground floor to a roof: the shaft and
     * roof footprints, the deck height, how much headroom a flight leaves
     * under the one above it, and the walk through it as a list of points,
     * from the floor outside its door to the roof outside the bulkhead's.
     */
    this.stairs = [];
    this.bounds = 100;
  }

  addBox(minX, minZ, maxX, maxZ, top, base = 0) {
    this.boxes.push({
      minX, maxX, minZ, maxZ, top, base,
      cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
      hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2,
      cos: 1, sin: 0,
    });
  }

  /**
   * Register a box that stands off the ground: the floors of a building over
   * a ground floor you can walk into. Its underside is `base`, and to every
   * reader it is a ceiling and nothing else. It stops a body whose head
   * reaches it (`resolve`, `ceilingAbove`), a sight line or a grenade that
   * meets it, and it is never somewhere to stand: `groundHeight` skips it, so
   * nothing can be lifted onto a roof it was walking under, and a mantle is
   * not refused for a wall that is really the floor above. Every box used to
   * run from the street to its top, and most readers still assume it — so a
   * base is only ever above head height, and `blocked` and the nav bake let a
   * body through under one.
   */
  addCeiling(minX, minZ, maxX, maxZ, top, base) {
    this.addBox(minX, minZ, maxX, maxZ, top, base);
  }

  /**
   * Register a box off the ground that is also somewhere to stand: a stair
   * tread over the flight below it, a landing, a roof reached by a stair.
   * To everything but footing it is a ceiling like any other; `groundHeight`
   * stands a body on it only when the body is at or above its underside, so
   * the flight over your head never lifts you onto it and the roof over a
   * shop never holds up a casing dropped inside the shop.
   */
  addDeck(minX, minZ, maxX, maxZ, top, base) {
    this.addBox(minX, minZ, maxX, maxZ, top, base);
    this.boxes[this.boxes.length - 1].deck = true;
  }

  /**
   * Register a slab laid over the street — a pavement, a courtyard floor. To
   * every query it is an ordinary box; the flag is for a reader that has to
   * tell the ground apart from what stands on it, because a 28 cm kerb and
   * the first tread of a stair are otherwise the same low step.
   */
  addFloor(minX, minZ, maxX, maxZ, top) {
    this.addBox(minX, minZ, maxX, maxZ, top);
    this.boxes[this.boxes.length - 1].floor = true;
  }
  // A floor may also carry `surface(lx, lz, r)`: its height at a point in its
  // own frame, the highest within `r`. `top` is then its highest anywhere, so
  // every reader that only wants a bound still has one; `groundHeight` and
  // `bounceSphere` ask the surface. A kerb dropped at a crossing is one.

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
      minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, top, base: 0,
      cx, cz, hx: halfW, hz: halfD, cos, sin,
    });
  }

  /**
   * Index the boxes on a coarse grid, once the city is built.
   *
   * Every query used to walk the whole box list, which was fine at 770
   * boxes and stopped being fine when the open ground floors brought 500
   * more: the game step doubled in a fight. Past this point a query looks
   * only at the boxes in the cells its rectangle touches, and gets them back
   * in list order, so collision resolves in exactly the order it did — and
   * the answers are the same, because the cells hold every box that could
   * overlap. Generation never sees it: the city mutates the list as it
   * builds (a prop that finds no room is taken back out), so the index is
   * only trusted while the list is the length it was sealed at, and
   * anything else falls back to walking all of it.
   */
  seal(cell = 6) {
    const lim = this.bounds + 40;
    const n = Math.ceil((lim * 2) / cell);
    this._cell = cell;
    this._origin = -lim;
    this._n = n;
    this._cells = Array.from({ length: n * n }, () => []);
    this.boxes.forEach((b, i) => {
      const [i0, i1, j0, j1] = this._span(b.minX, b.minZ, b.maxX, b.maxZ);
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) this._cells[j * n + k].push(i);
    });
    this._stamp = new Uint32Array(this.boxes.length);
    this._query = 0;
    this._idx = [];
    this._hits = [];
    this._sealed = this.boxes.length;
  }

  _span(x0, z0, x1, z1) {
    const c = this._cell, o = this._origin, top = this._n - 1;
    const at = (v) => Math.max(0, Math.min(top, Math.floor((v - o) / c)));
    return [at(x0), at(x1), at(z0), at(z1)];
  }

  /** Every box that could touch a rectangle, in list order. */
  _near(x0, z0, x1, z1) {
    const [i0, i1, j0, j1] = this._span(x0, z0, x1, z1);
    const stamp = this._stamp, idx = this._idx, q = ++this._query;
    idx.length = 0;
    for (let j = j0; j <= j1; j++) {
      for (let k = i0; k <= i1; k++) {
        for (const i of this._cells[j * this._n + k]) {
          if (stamp[i] === q) continue;
          stamp[i] = q;
          idx.push(i);
        }
      }
    }
    idx.sort((a, b) => a - b);
    const hits = this._hits;
    hits.length = idx.length;
    for (let i = 0; i < idx.length; i++) hits[i] = this.boxes[idx[i]];
    return hits;
  }

  /**
   * Which stairwell a body is up, and how far along its walk: on its roof
   * (the last point of the walk), in its shaft above the floor (the nearest
   * point, with height counted three times over, because the flights are
   * stacked a lap apart and the nearest point across is the wrong lap), or
   * neither — null, which is everywhere else, the shop under it included.
   *
   * @returns {{stair: object, idx: number}|null}
   */
  stairAt(x, y, z) {
    for (const s of this.stairs) {
      const r = s.roof;
      if (x < r.minX - 0.4 || x > r.maxX + 0.4 || z < r.minZ - 0.4 || z > r.maxZ + 0.4) continue;
      if (y > s.deck - 0.6) return { stair: s, idx: s.path.length - 1 };
      const q = s.shaft;
      if (y < s.floor + 0.3 || x < q.minX || x > q.maxX || z < q.minZ || z > q.maxZ) continue;
      let idx = 1, best = Infinity;
      for (let i = 1; i < s.path.length - 1; i++) {
        const p = s.path[i];
        const d = Math.hypot(p.x - x, p.z - z) + Math.abs(p.y - y) * 3;
        if (d < best) { best = d; idx = i; }
      }
      return { stair: s, idx };
    }
    return null;
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
   * ignored so debris does not become an invisible wall, and a ceiling above
   * the head (`height` over the feet) is walked under.
   */
  resolve(pos, radius, feet = 0, step = 0.35, height = 1.9) {
    for (const b of near(this, pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius)) {
      if (b.top <= feet + step || b.base >= feet + height) continue;
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
  groundHeight(x, z, radius, ceiling, under = ceiling) {
    let best = 0;
    const rSq = radius * radius;
    for (const b of near(this, x - radius, z - radius, x + radius, z + radius)) {
      if (b.top <= best || (b.top > ceiling && !b.surface)) continue;
      // A box off the ground is a ceiling, never a floor — unless it is a
      // deck (a stair tread, a landing, a roof you reach by them), and then
      // only from at or above its underside: `under` is how high the asker
      // is, so a body under a flight is not stood on the one over its head.
      if (b.base && (!b.deck || b.base > under)) continue;
      if (x <= b.minX - radius || x >= b.maxX + radius
          || z <= b.minZ - radius || z >= b.maxZ + radius) continue;
      const rx = x - b.cx, rz = z - b.cz;
      const lx = b.cos * rx - b.sin * rz;
      const lz = b.sin * rx + b.cos * rz;
      const dx = Math.max(0, Math.abs(lx) - b.hx);
      const dz = Math.max(0, Math.abs(lz) - b.hz);
      if (dx * dx + dz * dz >= rSq) continue;
      if (!b.surface) { best = b.top; continue; }
      // a floor whose top is not level — a pavement with its kerb dropped —
      // answers for itself, with the highest of it within reach
      const top = b.surface(lx, lz, radius);
      if (top <= ceiling && top > best) best = top;
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
  mantleTarget(x, z, radius, feet, dirX, dirZ, minRise, maxRise, reach = 0.95) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return null;
    const nx = dirX / len, nz = dirZ / len;
    const grip = radius * 0.55;          // the hands, not the whole body

    // `reach` is how far past the body to look for the lip: an arm's length
    // to grab one now, further to ask whether there is one to walk up to
    for (let d = radius + 0.1; d <= radius + reach; d += 0.18) {
      const gx = x + nx * d, gz = z + nz * d;
      const top = this.groundHeight(gx, gz, grip, feet + maxRise);
      if (top < feet + minRise) continue;
      // anything taller here means we are staring at a wall, not gripping a
      // lip — but a deck overhead, the roof over a shop counter, is not one
      const reachable = feet + maxRise + 0.5;
      if (this.groundHeight(gx, gz, grip, Infinity, reachable) > top + 0.05) continue;

      // room for a body past the edge, at the same height, and under whatever
      // ceiling there is over it
      const lx = x + nx * (d + radius + 0.15), lz = z + nz * (d + radius + 0.15);
      if (this.groundHeight(lx, lz, radius, Infinity, reachable) > top + 0.05) continue;
      if (this.ceilingAbove(lx, lz, radius, top) < top + HEADROOM) continue;
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
   * The underside of the lowest ceiling over (x, z) above `feet`, within
   * `radius` of it — Infinity under open sky. A jump stops against it.
   */
  ceilingAbove(x, z, radius, feet) {
    let low = Infinity;
    const rSq = radius * radius;
    for (const b of near(this, x - radius, z - radius, x + radius, z + radius)) {
      if (!b.base || b.base <= feet || b.base >= low) continue;
      if (x <= b.minX - radius || x >= b.maxX + radius
          || z <= b.minZ - radius || z >= b.maxZ + radius) continue;
      const rx = x - b.cx, rz = z - b.cz;
      const lx = b.cos * rx - b.sin * rz, lz = b.sin * rx + b.cos * rz;
      const dx = Math.max(0, Math.abs(lx) - b.hx), dz = Math.max(0, Math.abs(lz) - b.hz);
      if (dx * dx + dz * dz < rSq) low = b.base;
    }
    return low;
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
    for (const b of near(this, x - pad, z - pad, x + pad, z + pad)) {
      if (b.top < minTop) continue;
      if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad) return true;
    }
    return false;
  }

  /**
   * True when a body of radius `pad` at a point would touch any solid as
   * tall as `minTop` — the footprint, not the AABB round it.
   *
   * `occupied` is for placing things, where a turned prop claiming its
   * corners' worth of extra street is the safe direction. Steering is the
   * other case: avoidance probed with it, so a hostile two metres from a
   * container at a slant read the empty corner of its AABB as the way being
   * blocked, turned aside, found the way open again, and stood dithering a
   * metre from anything.
   */
  blocked(x, z, pad = 0, minTop = 1.2) {
    for (const b of near(this, x - pad, z - pad, x + pad, z + pad)) {
      if (b.top < minTop || b.base > minTop + HEADROOM - 0.7) continue;     // under a ceiling is open
      if (x <= b.minX - pad || x >= b.maxX + pad || z <= b.minZ - pad || z >= b.maxZ + pad) continue;
      const rx = x - b.cx, rz = z - b.cz;
      const lx = b.cos * rx - b.sin * rz, lz = b.sin * rx + b.cos * rz;
      const dx = Math.max(0, Math.abs(lx) - b.hx), dz = Math.max(0, Math.abs(lz) - b.hz);
      if (dx * dx + dz * dz < pad * pad) return true;
    }
    return false;
  }

  /**
   * Segment-vs-box test over the whole box list (three-slab method). Boxes
   * run from their `base` (the ground, for all but a ceiling) to `top`, so a
   * sight line clears low cover by passing over it and an open ground floor
   * by passing under the building over it.
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

    for (const box of near(this, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz))) {
      let t0 = 0, t1 = 1;

      let tA = (box.minX - ax) * invX, tB = (box.maxX - ax) * invX;
      if (tA > tB) { const t = tA; tA = tB; tB = t; }
      if (tA > t0) t0 = tA;
      if (tB < t1) t1 = tB;
      if (t0 > t1) continue;

      tA = ((box.base || 0) - ay) * invY; tB = (box.top - ay) * invY;
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

    tA = ((b.base || 0) - ay) * invY; tB = (b.top - ay) * invY;
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

    for (const b of near(this, pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius)) {
      if (pos.y - radius > b.top || pos.y + radius < b.base) continue;
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
      const top = b.surface ? b.surface(nearX, nearZ, 0) : b.top;
      if (pos.y - radius > top) continue;

      // candidate escapes: out the sides, up onto the top face, or — for a
      // ceiling — back down off its underside
      const outX = dx >= 0 ? b.hx + radius - lx : -b.hx - radius - lx;
      const outZ = dz >= 0 ? b.hz + radius - lz : -b.hz - radius - lz;
      const outY = top + radius - pos.y;
      const outDown = b.base ? b.base - radius - pos.y : -Infinity;
      const aX = Math.abs(outX), aZ = Math.abs(outZ), aY = Math.abs(outY), aD = Math.abs(outDown);

      if (aD < aX && aD < aZ && aD < aY) {
        pos.y += outDown;
        if (vel.y > 0) {
          vel.y = -vel.y * restitution;
          vel.x *= friction;
          vel.z *= friction;
        }
        contact = 1;
      } else if (aY <= aX && aY <= aZ) {
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
