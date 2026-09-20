/**
 * Navigation grid over the city, and a flow field across it to the player.
 *
 * A hostile steers at the player and has no idea a building is in the way, so
 * with one between them it walks into the wall and slides along the face. The
 * stuck watchdog is the backstop for that and always will be, but a backstop
 * is a relocation, and a relocation is a hostile vanishing. This is the part
 * that stops them needing one: a coarse grid of what can be walked on, and a
 * cost field over it rebuilt from wherever the player is standing, so "toward
 * the player" can mean *round the block* rather than *into the wall*.
 *
 * Three things about it are deliberate.
 *
 * It reads `world.boxes`, the same list collision, ground height, line of
 * sight and grenade bounce read, so a solid registered once is a solid here
 * too and there is no second description of the city to keep in step.
 *
 * It builds no three objects — no geometry, no material, not even a Vector3
 * at module scope. Every `Object3D` three constructs draws four numbers out
 * of `Math.random` for its UUID, and the stream is seeded, so anything minted
 * between the seed and the city moves the city (see CLAUDE.md). A grid built
 * out of typed arrays costs the layout nothing, which is why this file
 * imports nothing at all.
 *
 * And it is only ever a *hint*. Nothing here moves a hostile or decides what
 * is solid; `World.resolve` still does that. The field answers one question —
 * which way is downhill toward the player from here — and answers it with
 * "no idea" for anywhere it does not cover, which includes every rooftop,
 * because a perch stands inside a blocked cell by construction.
 */

/** Metres per cell. A street is 12 m wide (BLOCK - LOT), so this leaves eight. */
const CELL = 1.5;

/**
 * Anything shorter than this is a step up, not a wall: hostiles ride whatever
 * `World.groundHeight` hands them, so a kerb is not an obstacle.
 */
const STEP = 0.55;

/**
 * How far a route keeps off a solid. The widest hostile is an elite
 * juggernaut at 0.61 m, and a route flush against a wall turns back into a
 * slide the moment anything nudges it, so waypoints stay a shoulder clear.
 */
const CLEAR = 0.9;

/** Integer step costs — 14/10 is the usual cheap stand-in for root two. */
const ORTHO = 10;
const DIAG = 14;

/** Neighbours as [dx, dz, cost], orthogonals first so ties read square. */
const STEPS = [
  [1, 0, ORTHO], [-1, 0, ORTHO], [0, 1, ORTHO], [0, -1, ORTHO],
  [1, 1, DIAG], [1, -1, DIAG], [-1, 1, DIAG], [-1, -1, DIAG],
];

export class NavGrid {
  /** @param {import('./world.js').World} world */
  constructor(world, cell = CELL) {
    this.world = world;
    this.cell = cell;
    // a margin past the play area, because hostiles spawn out toward the edge
    const half = world.bounds + cell * 3;
    this.origin = -half;
    this.size = Math.ceil((half * 2) / cell);

    const n = this.size * this.size;
    this.blocked = new Uint8Array(n);
    this.dist = new Int32Array(n);
    this.dist.fill(-1);
    this.fromI = -1;
    this.fromJ = -1;
    this.rebuilds = 0;

    // One bucket per distance the search can still be holding. Every edge
    // costs at most DIAG, so a bucket being emptied at distance d can only
    // receive entries for d + ORTHO .. d + DIAG and never for itself — which
    // is what makes a ring of DIAG + 1 buckets safe, and lets the whole
    // search reuse them instead of minting an array per distance.
    this.wheel = [];
    for (let i = 0; i <= DIAG; i++) this.wheel.push([]);

    this.bake();
  }

  // ------------------------------------------------------------ coordinates
  col(x) { return Math.floor((x - this.origin) / this.cell); }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.size && j < this.size; }
  /** Centre of cell i in world space. */
  mid(i) { return this.origin + (i + 0.5) * this.cell; }

  /** True when (x, z) is somewhere a hostile cannot stand. */
  solidAt(x, z) {
    const i = this.col(x), j = this.col(z);
    if (!this.inside(i, j)) return true;
    return this.blocked[j * this.size + i] === 1;
  }

  // ------------------------------------------------------------------ build
  /**
   * Mark out what cannot be walked on, in two passes per solid.
   *
   * First every cell the solid physically overlaps, so a wall thinner than a
   * cell can never slip between two cell centres and leave a route running
   * through it. Then every cell whose *centre* stands within a shoulder of
   * it, which is where the clearance comes from.
   *
   * Those two do different jobs and the second cannot replace the first.
   * Nor can the first replace the second: blocking every cell a widened
   * solid so much as touches was the obvious way to write this and it is
   * wrong — a cell loses its whole 1.5 m for being clipped at one corner, and
   * measured on seed 1 that closed the streets so thoroughly that 4% of the
   * open sector was still reachable from the player. This way, 100% is.
   *
   * Walked per solid rather than per cell: a solid touches a handful of
   * cells, and there are twenty thousand cells and about a thousand solids.
   */
  bake() {
    this.blocked.fill(0);
    const { blocked, size, cell, origin } = this;
    const fill = (i0, i1, j0, j1) => {
      for (let j = Math.max(0, j0); j <= Math.min(size - 1, j1); j++) {
        const row = j * size;
        for (let i = Math.max(0, i0); i <= Math.min(size - 1, i1); i++) blocked[row + i] = 1;
      }
    };
    for (const b of this.world.boxes) {
      if (b.top <= STEP) continue;
      // cells the solid overlaps: floor of each edge, since cell i covers
      // [origin + i*cell, origin + (i+1)*cell)
      fill(
        Math.floor((b.minX - origin) / cell), Math.floor((b.maxX - origin) / cell),
        Math.floor((b.minZ - origin) / cell), Math.floor((b.maxZ - origin) / cell));
      // cells whose centre — origin + (i + 0.5) * cell — lies within a
      // shoulder of it
      fill(
        Math.ceil((b.minX - CLEAR - origin) / cell - 0.5),
        Math.floor((b.maxX + CLEAR - origin) / cell - 0.5),
        Math.ceil((b.minZ - CLEAR - origin) / cell - 0.5),
        Math.floor((b.maxZ + CLEAR - origin) / cell - 0.5));
    }
  }

  // ------------------------------------------------------------------ field
  /**
   * Rebuild the cost field from the player's position, if they have moved to
   * a different cell since the last one. That is the whole throttle: at a
   * run it comes to a rebuild every half second or so, and standing still
   * costs nothing.
   *
   * @returns {boolean} whether the field was rebuilt this call
   */
  update(x, z, force = false) {
    const i = this.col(x), j = this.col(z);
    if (!force && i === this.fromI && j === this.fromJ) return false;
    this.fromI = i;
    this.fromJ = j;
    this.compute(i, j);
    return true;
  }

  /**
   * Dijkstra out from the player over open cells, as a dial queue — costs are
   * small integers, so a bucket per distance beats a heap and stays simple.
   *
   * The player is routinely standing in a blocked cell: `CLEAR` puts a
   * shoulder's width of every wall out of bounds and people stand against
   * walls. So the search is seeded from whatever open cells are nearest them
   * rather than from the one they occupy, and if there are none within a few
   * cells the field is left empty and every hostile falls back to steering.
   */
  compute(ci, cj) {
    const { dist, blocked, size } = this;
    dist.fill(-1);
    this.rebuilds++;

    const wheel = this.wheel;
    for (const bucket of wheel) bucket.length = 0;
    let pending = 0;

    // nearest open cells to the player, widening until something is found
    for (let r = 0; r <= 4 && !pending; r++) {
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
          if (!this.inside(i, j)) continue;
          const k = j * size + i;
          if (blocked[k] || dist[k] >= 0) continue;
          dist[k] = 0;
          wheel[0].push(k);
          pending++;
        }
      }
    }
    if (!pending) return;                    // walled in: no field this frame

    for (let d = 0; pending > 0; d++) {
      const bucket = wheel[d % wheel.length];
      if (!bucket.length) continue;
      pending -= bucket.length;
      for (let q = 0; q < bucket.length; q++) {
        const k = bucket[q];
        if (dist[k] !== d) continue;         // already settled cheaper
        const i = k % size, j = (k / size) | 0;
        for (let s = 0; s < STEPS.length; s++) {
          const dx = STEPS[s][0], dz = STEPS[s][1];
          const ni = i + dx, nj = j + dz;
          if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
          const nk = nj * size + ni;
          if (blocked[nk]) continue;
          // no cutting a corner diagonally between two walls meeting at one
          if (dx && dz && (blocked[j * size + ni] || blocked[nj * size + i])) continue;
          const nd = d + STEPS[s][2];
          if (dist[nk] >= 0 && dist[nk] <= nd) continue;
          dist[nk] = nd;
          wheel[nd % wheel.length].push(nk);
          pending++;
        }
      }
      bucket.length = 0;
    }
  }

  // ----------------------------------------------------------------- steering
  /** True when every cell along a straight line between two points is open. */
  clearLine(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (this.cell * 0.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.solidAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  /**
   * Which way to walk from (x, z) to get closer to the player.
   *
   * Descends the field a few cells, then takes the furthest of those it can
   * reach in a straight line. Without that last part a hostile follows the
   * grid literally and walks the staircase of a diagonal; with it, the grid
   * decides which way round the building and the walk itself stays straight.
   *
   * @returns {boolean} false when this spot has no route — off the grid, on a
   *          roof, or cut off from the player entirely — and the caller
   *          should fall back to steering at them
   */
  heading(x, z, out) {
    const i = this.col(x), j = this.col(z);
    if (!this.inside(i, j)) return false;
    const { dist, blocked, size } = this;
    let here = dist[j * size + i];
    if (here <= 0) return false;      // blocked, unreachable, or already there

    // walk downhill a few cells
    const path = [];
    let ci = i, cj = j, cd = here;
    for (let s = 0; s < 5; s++) {
      let bi = -1, bj = -1, bd = cd;
      for (const [dx, dz] of STEPS) {
        const ni = ci + dx, nj = cj + dz;
        if (!this.inside(ni, nj)) continue;
        const nk = nj * size + ni;
        if (blocked[nk]) continue;
        if (dx && dz && (blocked[cj * size + ni] || blocked[nj * size + ci])) continue;
        const nd = dist[nk];
        if (nd < 0 || nd >= bd) continue;
        bd = nd; bi = ni; bj = nj;
      }
      if (bi < 0) break;
      path.push([bi, bj]);
      ci = bi; cj = bj; cd = bd;
      if (cd === 0) break;
    }
    if (!path.length) return false;

    // furthest waypoint on a clear straight line, nearest one as the floor
    for (let p = path.length - 1; p >= 0; p--) {
      const wx = this.mid(path[p][0]), wz = this.mid(path[p][1]);
      if (p > 0 && !this.clearLine(x, z, wx, wz)) continue;
      const dx = wx - x, dz = wz - z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      out.set(dx / len, 0, dz / len);
      return true;
    }
    return false;
  }

  /** Debug/probe summary: how much of the sector a hostile can walk. */
  stats() {
    let open = 0, reachable = 0;
    for (let k = 0; k < this.blocked.length; k++) {
      if (!this.blocked[k]) open++;
      if (this.dist[k] >= 0) reachable++;
    }
    return {
      size: this.size, cell: this.cell, cells: this.blocked.length,
      open, reachable, rebuilds: this.rebuilds,
    };
  }
}
