import * as THREE from 'three';
import { World, randRange, pick } from './world.js';
import * as TEX from './textures.js';
import { TILE, FACADE_BAYS, FACADE_FLOORS, FACADE_VARIANTS } from './textures.js';
import { reserve, spend, makeRandom, UUID_COST } from './rng.js';
import { chamferGeo, loftGeo, mergeIntoOne, sideGeo, latheGeo, bend } from './shapes.js';
import { cutWindows } from './windows.js';

const BLOCK = 34;      // centre-to-centre distance between city lots
const GRID = 6;        // lots per axis
const LOT = 22;        // buildable footprint inside a lot (street = BLOCK - LOT)
const HALF = (GRID - 1) / 2;

const lotCenter = (i) => (i - HALF) * BLOCK;

/**
 * The carriageway, derived rather than declared.
 *
 * A sidewalk apron is `LOT + 6` square on each lot centre, and lot centres
 * are `BLOCK` apart, so what is left between two aprons is the road: 6 m
 * wide, centred half a block off each lot. Every number the markings use
 * comes off these three, so widening a lot moves the paint with it.
 */
const ROAD_HALF = (BLOCK - (LOT + 6)) / 2;
/** Centre of each street, on either axis — the lines between the lots. */
const STREETS = Array.from({ length: GRID - 1 }, (_, i) => lotCenter(i) + BLOCK / 2);
/** Where a street stops: the last sidewalk, short of the perimeter wall. */
const STREET_END = (GRID * BLOCK) / 2 - ROAD_HALF;

/**
 * The sector's plan, which needs no seed: where the lots and their aprons sit
 * and where the walls are. The loading screen draws its street grid off this
 * before a single building exists.
 */
export const SECTOR = { block: BLOCK, grid: GRID, apron: LOT + 6, edge: (GRID * BLOCK) / 2 };

/** Window and floor pitch in metres — what a wall's UVs are snapped to. */
const BAY = TILE.facade / FACADE_BAYS;
const STOREY = TILE.facade / FACADE_FLOORS;

/**
 * Box geometry with planar UVs at a declared world scale.
 *
 * Every face is unwrapped from its own position and normal rather than from
 * the vertex order three happens to emit, so the same code works whatever the
 * box is subdivided into, and one copy of the texture always covers `tile`
 * metres. Options:
 *
 *   snapU/snapV  round the span to a whole number of these, in metres, and
 *                stretch to fit. A wall then never cuts a window in half at
 *                the corner, and its floors line up with the ground and roof.
 *   offsetU      slide the tile along, in tiles. Two identical walls given
 *                different offsets stop reading as the same wall.
 *   bands        horizontal subdivisions, so `bakeStatic` has vertices to
 *                hang the ground-contact shading on.
 */
function boxGeo(w, h, d, tile = TILE.concrete, opts = {}) {
  const { snapU = 0, snapV = 0, offsetU = 0, offsetV = 0, bands = 1, cells = 1 } = opts;
  const g = new THREE.BoxGeometry(w, h, d, cells, bands, cells);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;

  // span of the tile across a face, snapped to whole features where asked
  const span = (len, snap) => {
    if (!snap) return len / tile;
    return Math.max(1, Math.round(len / snap)) * (snap / tile);
  };
  const su = { x: span(d, snapU), y: span(w, snapU), z: span(w, snapU) };
  const sv = { x: span(h, snapV), y: span(d, snapU), z: span(h, snapV) };

  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let axis, u, v;
    if (ny > nx && ny > nz) { axis = 'y'; u = pos.getX(i) / w; v = pos.getZ(i) / d; }
    else if (nx > nz) { axis = 'x'; u = pos.getZ(i) / d; v = pos.getY(i) / h; }
    else { axis = 'z'; u = pos.getX(i) / w; v = pos.getY(i) / h; }
    uv.setXY(i, (u + 0.5) * su[axis] + offsetU, (v + 0.5) * sv[axis] + offsetV);
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Cylinder with UVs at a declared world scale, the way `boxGeo` does it.
 *
 * Three's own unwrap runs 0..1 around the barrel and 0..1 up it, so a 0.4 m
 * drum and a 7 m pole wear the same tile stretched to completely different
 * scales, and neither matches the boxes standing next to them.
 */
function cylGeo(rTop, rBot, h, tile = TILE.metal, seg = 8, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const nor = g.attributes.normal, uv = g.attributes.uv;
  const r = (rTop + rBot) / 2;
  const around = (2 * Math.PI * r) / tile;
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.9) {
      // an end cap: unwrap it across its own diameter
      const s = (2 * r) / tile;
      uv.setXY(i, (uv.getX(i) - 0.5) * s + 0.5, (uv.getY(i) - 0.5) * s + 0.5);
    } else {
      uv.setXY(i, uv.getX(i) * around, uv.getY(i) * (h / tile));
    }
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * A generator that decoration draws from, so it can draw at all.
 *
 * `rng.js` explains why: three spends four `Math.random()` calls on a UUID for
 * every object, so a mesh added anywhere inside generation shifts the seeded
 * stream and hands the same seed a different city. `reserve` already covers
 * shared materials and textures by rewinding the stream afterwards, but the
 * note there concluded that a decorative mesh built *inside a builder* could
 * never be free "short of giving generation its own generator".
 *
 * This is that generator, and it turns out to be the whole answer. Decoration
 * runs with `Math.random` pointed at a stream of its own and the global one
 * rewound underneath it, so both the UUIDs it mints and the choices it makes
 * cost the layout nothing. In practice every choice in here is drawn from
 * `hash2` instead, so what a block wears depends only on where it stands; the
 * private stream is what catches the UUIDs, and anything that slips.
 *
 * The rule to keep: anything registered in `world.boxes` or `world.solids` —
 * anything the player can walk into, shoot or stand on — is not decoration
 * and does not belong in here, because its placement is the city and the city
 * is what the seed is for. The corollary is that decoration is invisible to
 * collision and to `hitscan`, so it has to sit where neither matters: flat
 * against a wall, on a roof, or above head height.
 */
const decorRandom = makeRandom(0x9e3779b9);
function decor(fn) {
  return reserve(() => {
    const real = Math.random;
    Math.random = decorRandom;
    try { return fn(); } finally { Math.random = real; }
  });
}

/* ------------------------------------------------------------- shading bake */

/** Deterministic value in 0..1 from a position, so tints cost no stream. */
function hash2(x, z, salt = 0) {
  let h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791), 2654435761);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/**
 * A per-building colour drift, baked into vertex colours at merge time.
 *
 * Five facade textures over a hundred and fifty buildings means the eye finds
 * the same wall again and again. A tint costs nothing once the geometry is
 * merged — the attribute rides along in `mergeIntoOne` — and a few percent of
 * brightness and warmth is enough to stop two neighbours reading as one
 * prefab. It is keyed off position rather than drawn from `Math.random`,
 * because the seeded stream belongs to the layout, not to the paint.
 */
function tintAt(x, z, salt = 0, spread = 0.15) {
  const b = 1 + (hash2(Math.round(x * 4), Math.round(z * 4), salt) - 0.5) * spread * 2;
  const warm = (hash2(Math.round(x * 4), Math.round(z * 4), salt + 77) - 0.5) * 0.14;
  return [
    Math.max(0, b * (1 + warm)),
    Math.max(0, b),
    Math.max(0, b * (1 - warm * 1.1)),
  ];
}

/**
 * Coarse occlusion field over the sector, sampled by `bakeStatic`.
 *
 * A city of right angles is mostly missing the darkening where surfaces meet:
 * shadow maps give you the sun's shadow, not the ambient light a wall keeps
 * out of the gutter beside it. Every registered box deposits into a grid,
 * which is blurred a few times; horizontal surfaces near the ground then read
 * it back and darken. It is the cheapest thing in this file and close to the
 * most valuable.
 */
function occlusionField(world, extent, cell = 1.6) {
  const n = Math.ceil((extent * 2) / cell);
  const idx = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + extent) / cell)));
  let occ = new Float32Array(n * n);

  for (const b of world.boxes) {
    if (b.top < 0.8) continue;
    const weight = Math.min(1, b.top / 3.2);
    const x0 = idx(b.minX), x1 = idx(b.maxX), z0 = idx(b.minZ), z1 = idx(b.maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * n + x;
        if (occ[i] < weight) occ[i] = weight;
      }
    }
  }

  // separable box blur; three passes spread the darkening about 5 m
  const tmp = new Float32Array(n * n);
  for (let pass = 0; pass < 3; pass++) {
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const l = occ[z * n + Math.max(0, x - 1)], r = occ[z * n + Math.min(n - 1, x + 1)];
        tmp[z * n + x] = (l + occ[z * n + x] * 2 + r) / 4;
      }
    }
    for (let z = 0; z < n; z++) {
      const up = Math.max(0, z - 1) * n, dn = Math.min(n - 1, z + 1) * n;
      for (let x = 0; x < n; x++) {
        occ[z * n + x] = (tmp[up + x] + tmp[z * n + x] * 2 + tmp[dn + x]) / 4;
      }
    }
  }

  return (x, z) => occ[idx(z) * n + idx(x)];
}

/**
 * Make every floor slab something you stand on and something a bullet stops at.
 *
 * The sidewalks, the plaza, a rubble lot's slab and a ruin's courtyard were
 * drawn and registered nowhere, so the footing read the street under them:
 * the player walked 28 cm inside every kerb and 45 cm inside a ruin's floor,
 * every hostile on a pavement stood with its boots buried in it, and a shot
 * at the pavement landed on the street plane below the paint, where nothing
 * could see the impact. A whole lot is apron — the road between two lots is
 * 6 m of a 34 m block — so that was most of the ground in the sector.
 *
 * Registered *after* everything else is placed, and nothing placed earlier
 * would have noticed them anyway: every generation-time reader of the box
 * list — `areaClear`, `occupied`, the occlusion field, the nav bake — skips
 * anything this low, because each of them is asking about obstacles and a
 * floor is not one. Appending them is what makes that a guarantee rather than
 * an argument: every other collider in a seed is exactly where it was.
 *
 * The raycast copy is a plain box rather than the slab itself, for the reason
 * the ground has two: the drawn slab is subdivided for the bake, and three
 * walks every triangle of a mesh once a ray is inside its bounding sphere,
 * which for a 28 m slab is most rays fired near it. Built inside `reserve`,
 * so the UUIDs they mint cost the seeded stream nothing.
 */
function registerFloors(world, slabs) {
  reserve(() => {
    for (const slab of slabs) {
      const { width, height, depth } = slab.geometry.parameters;
      const p = slab.position;
      world.addFloor(p.x - width / 2, p.z - depth / 2, p.x + width / 2, p.z + depth / 2, p.y + height / 2);

      const hit = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), slab.material);
      hit.position.copy(p);
      hit.updateMatrixWorld(true);
      hit.matrixAutoUpdate = false;
      world.solids.push(hit);
    }
  });
}

/**
 * Give every heap of rubble and every fallen slab a collider shaped like it.
 *
 * They were drawn and registered nowhere — or, for the leaning slabs, in the
 * raycast list and not the box list — so a mound a metre and a half high was
 * something you walked straight through, and the piles stopped no bullets
 * either. Reported from play as objects you can clip right through.
 *
 * A box with the heap's height and footprint would make every mound a flat
 * topped pillar you stood on in mid-air over its slopes. So each one is cut
 * into tiers a third of a metre deep, and each tier is the rectangle that
 * best fits the heap's own cross-section from the middle of that tier to its
 * top (which, for a mound, is just the middle): a mound
 * comes out a stepped cone you scramble up, a fallen slab a ramp of steps.
 * The rectangle is the smallest of sixteen turns round the section's hull,
 * shrunk to the hull's own area, so a round section claims no more ground
 * than it covers and a flat one claims all of it.
 *
 * Registered after the floors and after everything else is placed, the same
 * way and for the same reason: nothing placed earlier saw them, so every
 * other collider in a seed is where it was, and only the boxes appended here
 * are new. The piles join the raycast list too; the slabs were already in it.
 */
function registerHeaps(world, heaps) {
  const TIER = 0.33;
  for (const m of heaps) {
    m.updateMatrixWorld(true);
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const p = geo.attributes.position;
    const v = new THREE.Vector3();
    const pts = [];
    for (let i = 0; i < p.count; i++) pts.push(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).toArray());
    const cx = m.position.x, cz = m.position.z;
    const base = world.groundHeight(cx, cz, 0.12, 0.5);
    const top = Math.max(...pts.map((q) => q[1]));
    if (top - base < 0.15) continue;
    const tiers = Math.min(6, Math.max(1, Math.round((top - base) / TIER)));
    for (let t = 1; t <= tiers; t++) {
      // Where the surface crosses the middle of this tier, and again just
      // under its top. A mound narrows as it rises, so the upper cut adds
      // nothing to it; a fallen slab leans, and its upper cut is where the
      // overhang is — the middle alone left 0.6 m of it at head height with
      // nothing under it.
      const cut = [];
      for (const at of [t - 0.5, t - 0.05]) {
        const level = base + (at / tiers) * (top - base);
        for (let k = 0; k + 2 < pts.length; k += 3) {
          for (let e = 0; e < 3; e++) {
            const a = pts[k + e], b = pts[k + (e + 1) % 3];
            if ((a[1] - level) * (b[1] - level) > 0 || a[1] === b[1]) continue;
            const f = (level - a[1]) / (b[1] - a[1]);
            cut.push([a[0] + f * (b[0] - a[0]), a[2] + f * (b[2] - a[2])]);
          }
        }
      }
      if (cut.length < 3) continue;
      const hull = convexHull(cut);
      let area = 0;
      for (let i = 0; i < hull.length; i++) {
        const [x0, z0] = hull[i], [x1, z1] = hull[(i + 1) % hull.length];
        area += x0 * z1 - x1 * z0;
      }
      area = Math.abs(area) / 2;
      // the tightest of sixteen turns
      let best = null;
      for (let j = 0; j < 16; j++) {
        const rot = (j / 16) * (Math.PI / 2), c = Math.cos(rot), s = Math.sin(rot);
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const [x, z] of hull) {
          const u = c * x + s * z, w = -s * x + c * z;
          a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, w); b1 = Math.max(b1, w);
        }
        const rect = (a1 - a0) * (b1 - b0);
        if (!best || rect < best.rect) best = { rect, rot, c, s, a0, a1, b0, b1 };
      }
      const shrink = Math.sqrt(Math.min(1, area / Math.max(best.rect, 1e-6)));
      const hu = ((best.a1 - best.a0) / 2) * shrink, hw = ((best.b1 - best.b0) / 2) * shrink;
      if (hu < 0.08 || hw < 0.08) continue;
      const mu = (best.a0 + best.a1) / 2, mw = (best.b0 + best.b1) / 2;
      // back from the turned frame; `addRotatedBox` turns by -rot in its own convention
      const wx = best.c * mu - best.s * mw, wz = best.s * mu + best.c * mw;
      world.addRotatedBox(wx, wz, hu, hw, -best.rot, base + (t / tiers) * (top - base));
      world.boxes[world.boxes.length - 1].heap = true;     // so the layout check can see past them
    }
    if (!world.solids.includes(m)) world.solids.push(m);
  }
}

/** How far a running jump carries off a deck's edge, and how high a mantle reaches above it. */
const JUMP_CARRY = 3, JUMP_REACH = 2.6;

/**
 * Take down every fire escape with a part within jumping reach of a perch's
 * deck. Each piece of one carries `userData.escape`, so it goes whole.
 */
function clearEscapesNear(group, world, perches) {
  const decks = [];
  for (const p of perches) {
    const b = world.boxes.find((k) => Math.abs(k.top - p.y) < 0.02 &&
      p.x > k.minX && p.x < k.maxX && p.z > k.minZ && p.z < k.maxZ);
    if (b) decks.push(b);
  }
  const pieces = new Map();
  group.traverse((o) => {
    if (o.userData.escape === undefined) return;
    if (!pieces.has(o.userData.escape)) pieces.set(o.userData.escape, []);
    pieces.get(o.userData.escape).push(o);
  });
  const box = new THREE.Box3();
  for (const parts of pieces.values()) {
    const near = parts.some((o) => {
      box.setFromObject(o);
      return decks.some((d) => box.max.y > d.top - 0.3 && box.min.y < d.top + JUMP_REACH &&
        box.max.x > d.minX - JUMP_CARRY && box.min.x < d.maxX + JUMP_CARRY &&
        box.max.z > d.minZ - JUMP_CARRY && box.min.z < d.maxZ + JUMP_CARRY);
    });
    if (near) for (const o of parts) o.removeFromParent();
  }
}

/** What a prop does not need to be clear of: a kerb, a floor, a step. */
const STEP_UP = 0.55;

/**
 * Where `settle` tries a prop, nearest first: every half-metre offset out to
 * `reach`, in a fixed order, so a seed settles its props the same way twice.
 */
const OFFSETS = new Map();
function settleOffsets(reach) {
  if (!OFFSETS.has(reach)) {
    const out = [];
    const n = Math.floor(reach / 0.5);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const d = Math.hypot(i, j) * 0.5;
        if (d <= reach) out.push([i * 0.5, j * 0.5, d, Math.atan2(j, i)]);
      }
    }
    out.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
    OFFSETS.set(reach, out.map(([x, z]) => [x, z]));
  }
  return OFFSETS.get(reach);
}

/** A box's footprint corners in the world, moved by (dx, dz) and grown by `grow`. */
function footCorners(b, dx, dz, grow = 0) {
  const hx = b.hx + grow, hz = b.hz + grow, out = [];
  for (const [u, v] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const lx = u * hx, lz = v * hz;
    // the inverse of the box's own frame: lx = c·rx − s·rz, lz = s·rx + c·rz
    out.push([b.cx + dx + b.cos * lx + b.sin * lz, b.cz + dz - b.sin * lx + b.cos * lz]);
  }
  return out;
}

/** Whether two turned footprints come within `gap` of each other (separating axes). */
function footOverlap(a, dx, dz, b, gap) {
  const ca = footCorners(a, dx, dz), cb = footCorners(b, 0, 0);
  for (const [ax, az] of [[a.cos, -a.sin], [a.sin, a.cos], [b.cos, -b.sin], [b.sin, b.cos]]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of ca) { const p = x * ax + z * az; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
    for (const [x, z] of cb) { const p = x * ax + z * az; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
    if (a1 + gap <= b0 || b1 + gap <= a0) return false;
  }
  return true;
}

/** Andrew's monotone chain, for a heap's cross-section. */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * UV options for a wall wearing a facade: floors and window bays snapped to
 * the wall's own extent so nothing is cut at a corner, the tile slid along by
 * a whole bay or floor so two buildings do not show the same window in the
 * same place, and enough horizontal bands for the bake to shade the footing.
 */
function wallUV(x, z, h) {
  const key = [Math.round(x), Math.round(z)];
  return {
    snapU: BAY,
    snapV: STOREY,
    offsetU: Math.floor(hash2(key[0], key[1], 3) * FACADE_BAYS) / FACADE_BAYS,
    offsetV: Math.floor(hash2(key[0], key[1], 4) * FACADE_FLOORS) / FACADE_FLOORS,
    bands: Math.max(1, Math.min(14, Math.round(h / 2.2))),
  };
}

/** Smooth value noise over the ground plane, for breaking up a tiled floor. */
function smoothNoise(x, z, scale) {
  const fx = x / scale, fz = z / scale;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(fx - x0), v = s(fz - z0);
  const a = hash2(x0, z0, 11), b = hash2(x0 + 1, z0, 11);
  const c = hash2(x0, z0 + 1, 11), d = hash2(x0 + 1, z0 + 1, 11);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Write vertex colours into a world-space geometry: tint everywhere, plus
 * ambient darkening where a surface meets the ground or stands close to it.
 *
 * `mottle` adds low-frequency drift per vertex instead of per mesh, which is
 * what a floor the size of the whole sector needs — one 8 m tile repeated
 * forty times reads as wallpaper until something varies at a scale the tile
 * does not have.
 */
function shadeGeometry(geo, tint, occlusion, mottle = 0) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const up = nor ? nor.getY(i) : 0;
    let ao = 1;
    if (up > 0.6 && y < 2.2) {
      // a floor: darken by what stands around it
      ao = 1 - 0.5 * Math.min(1, occlusion(x, z) * 1.25);
    } else if (Math.abs(up) < 0.6) {
      // a wall: darken toward its own footing, where light does not reach.
      // Gentler than the floor term, and over a shorter run: a wall already
      // spends half the day in shadow, and doubling that is just black.
      ao = 0.66 + 0.34 * Math.min(1, Math.max(0, y) / 2.2);
    }
    let r = tint[0], g = tint[1], b = tint[2];
    if (mottle) {
      const drift = 1 + ((smoothNoise(x, z, 11) - 0.5) * 1.2
                       + (smoothNoise(x, z, 37) - 0.5) * 0.8) * mottle;
      const warm = (smoothNoise(x + 500, z - 500, 23) - 0.5) * mottle * 0.7;
      r *= drift * (1 + warm); g *= drift; b *= drift * (1 - warm);
    }
    col[i * 3] = Math.max(0, r * ao);
    col[i * 3 + 1] = Math.max(0, g * ao);
    col[i * 3 + 2] = Math.max(0, b * ao);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/* ------------------------------------------------------------- prop shapes */

/**
 * The panels a wreck is cut from, minted once and shared by every car.
 *
 * A car is drawn the way a car designer draws one: by its side view. The
 * body is one outline extruded across the car's width with its shoulders
 * rolled over — wheel arches bitten out of it, a nose that drops to the
 * bumper, a boot that falls away behind — and then pinched in plan toward
 * both ends and tucked in at the sills, because a car seen from above is a
 * lozenge, not a rectangle. The greenhouse is a second outline in glass,
 * narrower and leaning in as it rises, and the pillars and roof are painted
 * metal laid over it, so the windows read as windows in a frame rather than
 * as a dark box sitting on a light one. Wheels are turned on a lathe: a tyre
 * with a sidewall and a tread, and a dished rim inside it.
 *
 * The lofted wreck this replaced stood 1.82 m tall over a collider 1.5 m
 * high, so standing on a roof put your boots 30 cm inside it. Front is +Z,
 * and the numbers are the collider: 1.9 m across, 4.4 m long, 1.5 m high.
 * Nothing here may reach past that, because the collider is what you feel.
 */
const WHEEL = { r: 0.335, z: 1.36, x: 0.79, arch: 0.40, cy: 0.335 };

function carShapes(pickup) {
  const M = TILE.metal, G = TILE.glass;

  // a wheel arch, from its rear foot over the top to its front foot
  const arch = (cz, foot = 0.25) => {
    const s = Math.asin((WHEEL.cy - foot) / WHEEL.arch), pts = [];
    for (let k = 0; k <= 9; k++) {
      const t = Math.PI + s - ((Math.PI + 2 * s) * k) / 9;
      pts.push([cz + WHEEL.arch * Math.cos(t), WHEEL.cy + WHEEL.arch * Math.sin(t)]);
    }
    return pts;
  };
  const smooth = (e) => { const t = Math.min(1, Math.max(0, e)); return t * t * (3 - 2 * t); };
  // in plan, both ends draw in; in section, the sills tuck under
  const plan = (v) => {
    v.x *= 1 - 0.10 * smooth((Math.abs(v.z) - 1.5) / 0.7) - 0.05 * smooth((0.42 - v.y) / 0.16);
  };
  // the greenhouse leans in as it rises — the tumblehome
  const lean = (v) => { v.x *= 1 - 0.15 * smooth((v.y - 1.0) / 0.48); };
  // two bevel steps and two-step fillets: a wreck is seen from a few metres
  // at closest, and there are fifty of them in the sector
  const cut = { segs: 2, curve: 2 };
  const paint = (outline, width, opts, shape = plan) => bend(sideGeo(outline, width, { tile: M, ...cut, ...opts }), shape);

  const bottom = [
    [-2.10, 0.28, 0.04], [-1.82, 0.25], ...arch(-WHEEL.z), [-0.90, 0.24], [0.90, 0.24], ...arch(WHEEL.z), [1.84, 0.25],
    [2.10, 0.30, 0.05], [2.17, 0.42, 0.03], [2.185, 0.58, 0.02], [2.15, 0.70, 0.03], [2.09, 0.80, 0.04], [1.98, 0.88, 0.05],
    [1.50, 0.95, 0.20], [0.86, 0.99],
  ];
  const tail = [[-2.10, 0.96, 0.05], [-2.17, 0.84, 0.04], [-2.185, 0.62, 0.02], [-2.15, 0.40, 0.04]];

  const panels = [];
  const glass = [];
  let cab, roofLine, frame, windows;
  if (pickup) {
    // the body stops at the bed floor behind the cab; the bed is walls
    panels.push(paint([...bottom, [-0.46, 1.00], [-0.46, 0.80], [-2.14, 0.80], [-2.185, 0.74, 0.03], ...tail.slice(2)], 1.9, { bevel: 0.10 }));
    for (const sx of [-1, 1]) {
      panels.push(paint([[-0.50, 0.78], [-2.18, 0.78], [-2.18, 1.10, 0.02], [-0.50, 1.10, 0.02]], 0.07,
        { bevel: 0.02 }, (v) => { v.x += sx * 0.912; plan(v); }));
    }
    panels.push(paint([[-2.12, 0.80], [-2.185, 0.80], [-2.185, 1.08, 0.02], [-2.12, 1.08, 0.02]], 1.80, { bevel: 0.02 }));
    panels.push(paint([[-0.46, 0.80], [-0.53, 0.80], [-0.53, 1.10, 0.02], [-0.46, 1.10, 0.02]], 1.80, { bevel: 0.02 }));
    cab = [[0.94, 0.95], [0.88, 0.99, 0.02], [0.06, 1.43, 0.08], [-0.10, 1.475, 0.06], [-0.36, 1.47, 0.04], [-0.42, 1.40, 0.02], [-0.44, 0.95]];
    roofLine = [[0.06, 1.445], [-0.10, 1.488, 0.06], [-0.36, 1.483, 0.03], [-0.43, 1.44], [-0.41, 1.40], [-0.30, 1.445, 0.04], [-0.08, 1.45, 0.04], [0.04, 1.41]];
    frame = [[0.90, 0.96], [0.85, 0.995, 0.02], [0.07, 1.42, 0.06], [-0.10, 1.462, 0.05], [-0.35, 1.457, 0.03], [-0.40, 1.39, 0.02], [-0.42, 0.96]];
    windows = [[[0.70, 1.04, 0.02], [0.10, 1.38, 0.03], [-0.30, 1.42, 0.03], [-0.30, 1.04, 0.02]]];
  } else {
    panels.push(paint([...bottom, [-1.30, 1.02], [-1.40, 1.02], [-1.90, 1.01, 0.15], ...tail], 1.9, { bevel: 0.10 }));
    cab = [[0.94, 0.95], [0.88, 0.99, 0.02], [0.02, 1.43, 0.08], [-0.30, 1.475, 0.25], [-0.80, 1.465, 0.12], [-1.00, 1.40, 0.06], [-1.36, 1.03, 0.02], [-1.40, 0.95]];
    roofLine = [[0.02, 1.445], [-0.30, 1.488, 0.25], [-0.80, 1.478, 0.12], [-0.97, 1.43, 0.03], [-0.95, 1.395], [-0.80, 1.44, 0.1], [-0.30, 1.45, 0.2], [0.0, 1.41]];
    frame = [[0.90, 0.96], [0.85, 0.995, 0.02], [0.03, 1.42, 0.06], [-0.30, 1.462, 0.2], [-0.79, 1.452, 0.1], [-0.98, 1.39, 0.04], [-1.33, 1.03, 0.02], [-1.36, 0.96]];
    windows = [
      [[0.70, 1.04, 0.02], [0.06, 1.38, 0.03], [-0.40, 1.42, 0.03], [-0.40, 1.04, 0.02]],
      [[-0.48, 1.04, 0.02], [-0.48, 1.42, 0.03], [-0.86, 1.40, 0.04], [-1.20, 1.06, 0.02]],
    ];
  }
  glass.push(bend(sideGeo(cab, 1.60, { tile: G, bevel: 0.04, ...cut }), lean));
  panels.push(paint(roofLine, 1.62, { bevel: 0.03 }, lean));
  for (const sx of [-1, 1]) {
    panels.push(paint(frame, 0.022, { holes: windows, bevel: 0.006, segs: 1 }, (v) => { v.x += sx * 0.796; lean(v); }));
    // door mirror on a stalk at the foot of the pillar
    panels.push(chamferGeo(0.13, 0.09, 0.06, 0.02, M, [sx * 0.87, 1.07, 0.70]));
  }

  // lamps: lenses proud of the nose and the tail
  for (const sx of [-1, 1]) {
    glass.push(bend(sideGeo([[2.11, 0.69], [2.165, 0.70, 0.01], [2.105, 0.80, 0.01], [2.05, 0.79]], 0.30, { tile: G, bevel: 0.02, ...cut, segs: 1 }),
      (v) => { v.x += sx * 0.62; plan(v); }));
    glass.push(bend(sideGeo([[-2.12, 0.82], [-2.19, 0.82], [-2.165, 0.93], [-2.10, 0.95]], 0.30, { tile: G, bevel: 0.02, ...cut, segs: 1 }),
      (v) => { v.x += sx * 0.60; plan(v); }));
  }

  // bumpers swept back at the corners, a grille, door handles
  const sweep = (dir) => (v) => { v.z -= dir * 0.10 * (v.x / 0.92) ** 2; };
  const trim = [
    bend(sideGeo([[2.06, 0.34, 0.03], [2.20, 0.36, 0.04], [2.20, 0.56, 0.04], [2.06, 0.58, 0.03]], 1.84, { tile: M, bevel: 0.05, ...cut }), sweep(1)),
    bend(sideGeo([[-2.06, 0.34, 0.03], [-2.20, 0.36, 0.04], [-2.20, 0.56, 0.04], [-2.06, 0.58, 0.03]], 1.84, { tile: M, bevel: 0.05, ...cut }), sweep(-1)),
    sideGeo([[2.12, 0.60], [2.188, 0.60, 0.01], [2.168, 0.70, 0.01], [2.10, 0.70]], 0.78, { tile: M, bevel: 0.015, ...cut, segs: 1 }),
  ];
  for (const sx of [-1, 1]) {
    for (const z of pickup ? [0.22] : [0.22, -0.62]) trim.push(chamferGeo(0.012, 0.026, 0.13, 0.005, M, [sx * 0.942, 0.93, z]));
  }

  // Wheels. One lathe: inner face, tyre round to the tread and back, a lip,
  // and the dish of the rim. The tread and the face are unwrapped to the two
  // regions of the tyre tile — see `TEX.tire`.
  const R = TILE.rubber;
  const wheelUV = (x, y, z, fx, fy, fz, th) => {
    if (Math.abs(fz) > 0.55 * Math.hypot(fx, fy, fz)) return [0.5 + x / R, 0.5 + y / R];
    return [(th * Math.hypot(x, y)) / R, 0.03 + (z + 0.11) / R];
  };
  const wheel = latheGeo([
    [0, -0.06], [0.22, -0.06], [0.235, -0.105], [0.305, -0.106], [0.335, -0.066], [0.335, 0.066],
    [0.305, 0.106], [0.235, 0.100], [0.222, 0.085], [0.17, 0.052], [0.06, 0.050], [0, 0.060],
  ], 12, R, { uv: wheelUV, crease: 44 });
  const wheels = [];
  for (const sx of [-1, 1]) {
    for (const wz of [-WHEEL.z, WHEEL.z]) {
      wheels.push(wheel.clone().rotateY(sx * Math.PI / 2).translate(sx * WHEEL.x, WHEEL.cy, wz));
    }
  }
  // the dark of the wheel well, so the arch is a hole and not a window
  for (const wz of [-WHEEL.z, WHEEL.z]) {
    wheels.push(cylGeo(WHEEL.arch - 0.008, WHEEL.arch - 0.008, 1.30, R, 10, true).rotateZ(Math.PI / 2).translate(0, WHEEL.cy, wz));
  }

  return {
    panels: mergeIntoOne(panels),
    cabin: mergeIntoOne(glass),
    trim: mergeIntoOne(trim),
    wheels: mergeIntoOne(wheels),
  };
}

/**
 * A jersey barrier, which is a profile and not a slab.
 *
 * The shape is the whole point of the thing: a wide foot, a kink at knee
 * height and a narrow top, so a vehicle rides up it instead of stopping dead.
 * As a box it was a grey wall that happened to be waist high, and the kink is
 * four numbers. The foot stays 0.7 m across because that is the footprint the
 * collider registers.
 */
function jerseyBarrier() {
  return loftGeo([
    { y: 0, hx: 1.10, hz: 0.35 },
    { y: 0.16, hx: 1.10, hz: 0.33 },
    { y: 0.36, hx: 1.10, hz: 0.19 },
    { y: 0.98, hx: 1.10, hz: 0.13 },
    { y: 1.05, hx: 1.07, hz: 0.11 },
  ], TILE.concrete);
}

/**
 * A shipping container: a box, plus the six details that stop it being one.
 *
 * Corner castings, a sill rail top and bottom, and a pair of doors at one end
 * with the locking bars still on them. All one material, so it merges into
 * one geometry and costs exactly what the box cost.
 */
function shippingContainer() {
  const R = TILE.rust;
  const w = 2.5, h = 2.6, d = 6.0;
  const parts = [
    chamferGeo(w - 0.1, h - 0.24, d - 0.1, 0.05, R, [0, h / 2, 0]),
    chamferGeo(w, 0.2, d, 0.05, R, [0, h - 0.1, 0]),                  // top rail
    chamferGeo(w, 0.2, d, 0.05, R, [0, 0.1, 0]),                      // sill
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sy of [0, 1]) {
        parts.push(chamferGeo(0.26, 0.26, 0.26, 0.05, R,
          [sx * (w / 2 - 0.13), sy ? h - 0.13 : 0.13, sz * (d / 2 - 0.13)]));
      }
    }
  }
  // doors on the -Z end: two leaves, four locking bars
  parts.push(chamferGeo(w - 0.16, h - 0.44, 0.08, 0.03, R, [0, h / 2, -d / 2 - 0.02]));
  for (const bx of [-0.78, -0.26, 0.26, 0.78]) {
    parts.push(chamferGeo(0.07, h - 0.6, 0.07, 0.02, R, [bx, h / 2, -d / 2 - 0.07]));
  }
  return mergeIntoOne(parts);
}

/**
 * An oil drum with its rolling hoops, which is what a drum is for.
 *
 * Two raised bands around a cylinder: cheap, and the only thing that stops a
 * lit barrel reading as a tube. Ten sides, as before — it is on fire, and
 * nobody is going to count them.
 */
function oilDrum() {
  const R = TILE.rust;
  return mergeIntoOne([
    cylGeo(0.42, 0.42, 1.05, R, 10).translate(0, 0.52, 0),
    cylGeo(0.45, 0.45, 0.09, R, 10).translate(0, 0.35, 0),
    cylGeo(0.45, 0.45, 0.09, R, 10).translate(0, 0.70, 0),
    cylGeo(0.44, 0.44, 0.07, R, 10).translate(0, 1.01, 0),            // chime
  ]);
}

/**
 * Collapse the finished city into one mesh per material.
 *
 * The city is ~1500 boxes that never move, and drawing them one at a time
 * cost 567 calls for under 10k triangles — about 18 triangles a call, which
 * is all driver and no pixels. The shadow pass paid the same bill again.
 *
 * Rendering and raycasting want different shapes, so they get different
 * ones. The merged meshes go into the scene; the meshes they were built
 * from leave it but stay alive in `world.solids`, off the scene graph with
 * their transforms frozen, because that is what bullets are traced against.
 * Tracing one merged city mesh instead would mean testing every triangle in
 * the sector for every pellet, and would quietly change what a shot can hit:
 * the solid set is deliberately not everything you can see.
 *
 * It is also where per-surface shading is baked in, because this is the only
 * point at which every mesh is in world space together — see `shadeGeometry`.
 */
function bakeStatic(group, world) {
  group.updateMatrixWorld(true);

  const meshes = [];
  group.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });

  // the merge is also the one moment every surface is in world space at once,
  // which is what the tint and the ambient darkening need
  const occlusion = occlusionField(world, (GRID * BLOCK) / 2 + 62);

  // Keyed on the material itself, never its UUID. Under `reserve` a UUID is
  // not unique: every reserve that starts from the same place in the seeded
  // stream mints the same ones, so two materials built in two of them can
  // share one — and did, the moment the city's materials were painted in
  // steps, which merged 16 of the city's 27 materials into other ones.
  //
  // And per material *per patch of the city*, not per material across the
  // sector. One mesh spanning the sector can never be culled, so the near
  // shadow cascade — 26 m across — drew every triangle in the city into its
  // map, and so did the camera behind your back. A patch is `BATCH_LOTS`
  // lots square; anything wider than a patch (the ground, a cable run) goes
  // in a batch of its own that is always drawn, as everything used to be.
  const buckets = new Map();
  const perMaterial = new Map();
  for (const m of meshes) {
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    shadeGeometry(geo, m.userData.tint || [1, 1, 1], occlusion, m.userData.mottle || 0);
    const key = `${materialIndex(perMaterial, m.material)}:${patchOf(geo)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { material: m.material, geos: [], cast: false, receive: false });
    b.geos.push(geo);
    b.cast = b.cast || m.castShadow;
    b.receive = b.receive || m.receiveShadow;
  }

  // nothing updates a detached mesh's matrix, so freeze it at what it was
  for (const m of meshes) {
    m.matrixAutoUpdate = false;
    m.removeFromParent();
  }
  // the groups the wrecked cars were assembled in are empty now
  for (const child of [...group.children]) {
    if (child.isGroup && child.children.length === 0) group.remove(child);
  }

  // Every batch is a geometry and a mesh, eight draws of the seeded stream,
  // and the stream after this is the one that picks spawns. So the batches
  // are built in a `reserve` and the bill is what one batch per material
  // used to cost: splitting the city into patches moves no hostile.
  reserve(() => {
    for (const b of buckets.values()) {
      const mesh = new THREE.Mesh(mergeIntoOne(b.geos), b.material);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      for (const g of b.geos) g.dispose();
    }
  });
  spend(perMaterial.size * 2 * UUID_COST);
  return buckets.size;
}

/**
 * Weeds, where weeds grow: along the kerb on both sides of it, against the
 * foot of every building, and in the cracks of the pavement, the plaza and
 * the rubble — a city nobody has swept in years. This is the strongest single
 * cue that the place is abandoned rather than merely empty, and it was the
 * one the city did not have.
 *
 * Decoration by the rules in the invariant: in neither `world.boxes` nor
 * `world.solids`, so you walk through it and shoot through it, which is what
 * grass is; placed by `decor`'s own generator, so no seed moves; and only
 * ever where it can stand — on a floor or the street, clear of anything
 * taller than a kerb. A tuft is two crossed cards, each built twice with
 * opposite winding and its own normal (tilted up, so a blade is lit like the
 * ground it grows from), rather than one card drawn double-sided: three
 * flips a double-sided face's normal on its back, which turned the back of
 * every card into the dark side of a downward-facing surface. One mesh per
 * lot, so the bake files each into its patch and they cull with the city.
 */
function overgrowth(group, world, mat) {
  const byLot = new Map();
  const add = (x, z, scale) => {
    // standing room: on a floor or the street, not inside anything taller
    if (Math.abs(x) > world.bounds - 1 || Math.abs(z) > world.bounds - 1) return;
    if (world.occupied(x, z, 0.12, 0.6)) return;
    const y = world.groundHeight(x, z, 0.05, 0.6);
    const key = `${Math.round(x / BLOCK)},${Math.round(z / BLOCK)}`;
    let geos = byLot.get(key);
    if (!geos) byLot.set(key, geos = []);
    geos.push(tuft(x, y, z, scale));
  };

  const apron = (LOT + 6) / 2;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      // the kerb line, both sides of it, in clumps with gaps between
      for (const [ax, az, along] of [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']]) {
        for (let t = -apron; t < apron; t += randRange(0.8, 2.4)) {
          if (Math.random() < 0.3) continue;
          const side = Math.random() < 0.6 ? -1 : 1;          // pavement side, mostly
          const off = apron + side * randRange(0.08, 0.45);
          const x = cx + (along === 'x' ? t : ax * off);
          const z = cz + (along === 'z' ? t : az * off);
          for (let k = Math.random() < 0.5 ? 3 : 2; k > 0; k--) {
            add(x + randRange(-0.35, 0.35), z + randRange(-0.35, 0.35), randRange(0.75, 1.3));
          }
        }
      }
      // cracks across the lot: a scatter, denser where nothing is built
      for (let k = 0; k < 24; k++) {
        add(cx + randRange(-apron, apron), cz + randRange(-apron, apron), randRange(0.55, 1.1));
      }
    }
  }

  // against the foot of every building and wall, where the sweepings gather
  for (const b of world.boxes) {
    if (b.floor || b.top < 2.5 || b.sin) continue;
    const pad = 0.22;
    const edges = [
      [b.minX - pad, b.minZ - pad, b.maxX + pad, b.minZ - pad],
      [b.minX - pad, b.maxZ + pad, b.maxX + pad, b.maxZ + pad],
      [b.minX - pad, b.minZ - pad, b.minX - pad, b.maxZ + pad],
      [b.maxX + pad, b.minZ - pad, b.maxX + pad, b.maxZ + pad],
    ];
    for (const [x0, z0, x1, z1] of edges) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (let t = randRange(0, 1.5); t < len; t += randRange(0.6, 2.0)) {
        if (Math.random() < 0.3) continue;
        const f = t / len;
        // tallest against the wall, where the wind leaves the dust
        add(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, randRange(0.95, 1.6));
      }
    }
  }

  for (const [key, geos] of byLot) {
    const [li, lj] = key.split(',').map(Number);
    const mesh = new THREE.Mesh(mergeIntoOne(geos), mat);
    mesh.receiveShadow = true;           // a card's shadow is a smear; skip casting
    mesh.userData.tint = tintAt(li * BLOCK, lj * BLOCK, 31, 0.22);
    group.add(mesh);
  }
}

/**
 * What a street has set into it besides paint: manhole covers in the lanes,
 * gully grates in the gutter against each kerb, and blister paving on the
 * pavement at both ends of every zebra crossing.
 *
 * All of it is decoration by the flush rule — it lies a centimetre over a
 * surface you already walk on and shoot at, and registers nothing — which
 * holds only if every corner finds the same ground the centre does. So this
 * runs after the floors are registered, asks `groundHeight` at every corner,
 * and lays nothing that would hang over a kerb. The crossings it pads are
 * found by the same roll `roadMarkings` paints them by.
 */
function streetIron(group, world, coverMat, grateMat, tactileMat) {
  const r = (a, b, salt) => hash2(Math.round(a), Math.round(b), salt);
  const ground = (x, z) => world.groundHeight(x, z, 0.01, 0.5);
  const LIFT = 0.012;
  const kit = () => ({ pos: [], uv: [] });
  const covers = kit(), grates = kit(), pads = kit();

  // one corner of a flat quad, in the street's frame (u across, v along)
  const toWorld = (axisX, u, v) => (axisX ? [v, u] : [u, v]);
  /** A flat rectangle `w` across by `d` along, if all four corners agree on the ground. */
  const flat = (into, axisX, u, v, w, d, tile, spin = 0) => {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => toWorld(axisX, u + su * w / 2, v + sv * d / 2));
    const hs = corners.map(([x, z]) => ground(x, z));
    if (Math.max(...hs) - Math.min(...hs) > 0.004) return false;
    const y = hs[0] + LIFT;
    const [cx, cz] = toWorld(axisX, u, v);
    const c = Math.cos(spin), s = Math.sin(spin);
    const at = ([x, z]) => {
      into.pos.push(x, y, z);
      const lx = x - cx, lz = z - cz;
      into.uv.push(0.5 + (lx * c - lz * s) / tile, 0.5 + (lx * s + lz * c) / tile);
    };
    // wound to face the sky whichever way the street's frame maps
    const [a, b, c2, e] = corners;
    const up = ((b[0] - a[0]) * (c2[1] - a[1]) - (b[1] - a[1]) * (c2[0] - a[0])) < 0;
    for (const k of up ? [a, b, c2, a, c2, e] : [a, c2, b, a, e, c2]) at(k);
    return true;
  };
  /** A cover: a fan of `n` facets, its texture turned by `spin`. */
  const disc = (x, z, R, spin) => {
    const n = 20;
    const rim = [];
    for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2; rim.push([x + Math.cos(a) * R, z + Math.sin(a) * R]); }
    const hs = rim.map(([px, pz]) => ground(px, pz)).concat(ground(x, z));
    if (Math.max(...hs) - Math.min(...hs) > 0.004) return;
    const y = hs[hs.length - 1] + LIFT;
    const c = Math.cos(spin), s = Math.sin(spin);
    const at = (px, pz) => {
      covers.pos.push(px, y, pz);
      const lx = px - x, lz = pz - z;
      covers.uv.push(0.5 + (lx * c - lz * s) / TILE.cover, 0.5 + (lx * s + lz * c) / TILE.cover);
    };
    for (let k = 0; k < n; k++) { at(x, z); at(...rim[k + 1]); at(...rim[k]); }   // (centre, next, this) faces up
  };

  for (const axisX of [true, false]) {
    for (const across of STREETS) {
      const nodes = [-STREET_END, ...STREETS, STREET_END];
      for (let k = 0; k + 1 < nodes.length; k++) {
        const lo = nodes[k] + (k > 0 ? ROAD_HALF : 0), hi = nodes[k + 1] - (k + 2 < nodes.length ? ROAD_HALF : 0);
        // the crossings `roadMarkings` laid on this span, by the same roll
        const crossings = [];
        for (const [node, dir, junction] of [[nodes[k], 1, k > 0], [nodes[k + 1], -1, k + 2 < nodes.length]]) {
          if (!junction || r(node, across, axisX ? 91 : 92) > 0.45) continue;
          const clear = node + dir * (ROAD_HALF + 0.3);
          crossings.push({ v: clear + dir * 1.1, dir });
        }
        const clearOf = (v, pad) => crossings.every((c) => Math.abs(v - c.v) > 1.1 + pad);

        // covers in the lanes, none, one or two to a span
        const count = Math.floor(r(lo + hi, across, 101) * 2.6);
        for (let i = 0; i < count; i++) {
          const v = lo + 4 + (hi - lo - 8) * r(lo + i * 13, across, 102 + i);
          const lane = r(v, across, 104) < 0.5 ? -1 : 1;
          const u = across + lane * (ROAD_HALF / 2 + (r(v, across, 105) - 0.5) * 0.5);
          if (!clearOf(v, 0.8)) continue;
          const [x, z] = toWorld(axisX, u, v);
          disc(x, z, 0.37, r(x, z, 106) * Math.PI * 2);
        }

        // a gully grate at each kerb every fifteen metres or so
        for (const side of [-1, 1]) {
          for (let v = lo + 5 + r(lo, across + side, 107) * 6; v < hi - 3; v += 13 + r(v, across, 108) * 6) {
            if (!clearOf(v, 0.6)) continue;
            flat(grates, axisX, across + side * (ROAD_HALF - 0.135), v, 0.24, 0.6, TILE.grate);
          }
        }

        // blister paving on the pavement, the width of the crossing, at both ends
        for (const c of crossings) {
          for (const side of [-1, 1]) flat(pads, axisX, across + side * (ROAD_HALF + 0.62), c.v, 1.1, 2.2, TILE.tactile);
        }
      }
    }
  }

  for (const [buf, mat] of [[covers, coverMat], [grates, grateMat], [pads, tactileMat]]) {
    if (!buf.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(buf.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData.tint = [1, 1, 1];
    mesh.userData.mottle = 0.1;
    group.add(mesh);
  }
}

/**
 * Standing water: in the gutters, where a road's camber sends it, and in the
 * odd dip in the carriageway and the plaza. Each is a ragged outline lying on
 * the surface, never across a kerb — every vertex of it has to find the same
 * ground the centre does — with a larger damp ring under it. Decoration by
 * the flush rule: a centre and a ring a centimetre up, walked over and shot
 * through like the paint.
 */
function puddles(group, world, waterMat, dampMat) {
  const water = [], damp = [];
  const lay = (x, z, r, squash, turn) => {
    if (Math.abs(x) > world.bounds - 2 || Math.abs(z) > world.bounds - 2) return false;
    // clear of anything standing; the floors are what it lies on, and the
    // level test below is what keeps it off a kerb
    if (world.occupied(x, z, r * 1.4, 0.6)) return false;
    const y = world.groundHeight(x, z, 0.05, 0.6);
    const outline = (grow) => {
      const n = 14, pts = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rad = r * grow * (0.7 + 0.3 * Math.sin(a * 2 + turn * 3) + randRange(-0.12, 0.12));
        const px = Math.cos(a) * rad, pz = Math.sin(a) * rad * squash;
        pts.push([x + px * Math.cos(turn) - pz * Math.sin(turn), z + px * Math.sin(turn) + pz * Math.cos(turn)]);
      }
      return pts;
    };
    const ring = outline(1.35), pool = outline(1);
    // the whole of it on one level surface, or not at all
    for (const [px, pz] of ring) {
      if (Math.abs(world.groundHeight(px, pz, 0.02, 0.6) - y) > 0.01) return false;
    }
    damp.push(fan(x, y + 0.008, z, ring));
    water.push(fan(x, y + 0.012, z, pool));
    return true;
  };

  const apron = (LOT + 6) / 2;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      // gutters: just off the kerb, long and thin along it
      for (const [ax, az, along] of [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']]) {
        for (let k = 0; k < 2; k++) {
          if (Math.random() < 0.35) continue;
          // far enough off the kerb that the damp ring stays on the road
          const r = randRange(0.9, 2.2), squash = randRange(0.3, 0.5);
          const t = randRange(-apron + 2, apron - 2), off = apron + r * squash * 1.5 + 0.12;
          lay(cx + (along === 'x' ? t : ax * off), cz + (along === 'z' ? t : az * off),
            r, squash, along === 'x' ? 0 : Math.PI / 2);
        }
      }
      // a dip somewhere on the lot or the road beside it
      for (let k = 0; k < 3; k++) {
        lay(cx + randRange(-apron - 3, apron + 3), cz + randRange(-apron - 3, apron + 3),
          randRange(0.7, 1.8), randRange(0.5, 0.95), randRange(0, Math.PI));
      }
    }
  }
  for (const [list, mat, name] of [[water, waterMat, 'water'], [damp, dampMat, 'damp']]) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(mergeIntoOne(list), mat);
    mesh.receiveShadow = true;
    mesh.userData.puddles = name;
    group.add(mesh);
  }
}

/** A flat fan facing up, from a centre and a closed outline. */
function fan(x, y, z, pts) {
  const pos = [x, y, z], nor = [0, 1, 0], uv = [0.5, 0.5], idx = [];
  for (const [px, pz] of pts) { pos.push(px, y, pz); nor.push(0, 1, 0); uv.push(0.5, 0.5); }
  for (let k = 0; k < pts.length; k++) {
    // centre, next, this: wound to face the sky (a fan in angle order viewed
    // from above faces the ground the other way round)
    idx.push(0, 1 + ((k + 1) % pts.length), 1 + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * What drifts against a kerb and a wall in a city nobody sweeps: sheets of
 * paper, card and plastic, and chips of brick and concrete off the buildings
 * above. Paper lies flat on the ground, flush; the chips are under a tenth of
 * a metre tall and half sunk, small enough that walking through one is
 * nothing anyone notices, and cut from the city's own concrete at its
 * declared tile so the density check holds them to it like everything else.
 */
function debris(group, world, litterMat, chipMats) {
  const byLot = new Map();
  const bucket = (x, z, mat) => {
    const key = `${Math.round(x / BLOCK)},${Math.round(z / BLOCK)},${mat.id}`;
    let b = byLot.get(key);
    if (!b) byLot.set(key, b = { mat, x, z, geos: [] });
    return b.geos;
  };
  const clear = (x, z) => Math.abs(x) < world.bounds - 1 && Math.abs(z) < world.bounds - 1
    && !world.occupied(x, z, 0.1, 0.4);

  const sheet = (x, z) => {
    if (!clear(x, z)) return;
    const y = world.groundHeight(x, z, 0.05, 0.6) + 0.006;
    const q = (Math.random() * 4) | 0, u0 = (q % 2) * 0.5, v0 = q < 2 ? 0.5 : 0;
    const w = randRange(0.18, 0.38), d = w * randRange(0.6, 1.0), a = Math.random() * Math.PI * 2;
    const c = Math.cos(a), sn = Math.sin(a);
    const corner = (cx, cz) => [x + cx * c - cz * sn, y, z + cx * sn + cz * c];
    const pts = [corner(-w / 2, -d / 2), corner(w / 2, -d / 2), corner(w / 2, d / 2), corner(-w / 2, d / 2)];
    // flat on one level, or a corner hangs in the air over the kerb
    for (const [px, , pz] of pts) {
      if (Math.abs(world.groundHeight(px, pz, 0.02, 0.6) + 0.006 - y) > 0.01) return;
      if (world.occupied(px, pz, 0.02, 0.4)) return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(
      [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5], 2));
    // corners run anticlockwise seen from below with this rotation, so the
    // sky-facing order is 0-2-1 / 0-3-2
    g.setIndex([0, 2, 1, 0, 3, 2]);
    bucket(x, z, litterMat).push(g);
  };
  const chip = (x, z) => {
    if (!clear(x, z)) return;
    const y = world.groundHeight(x, z, 0.05, 0.6);
    const w = randRange(0.06, 0.22), h = randRange(0.04, 0.1), d = randRange(0.05, 0.18);
    const mat = chipMats[Math.random() < 0.6 ? 1 : 0];
    // a plain box: at a tenth of a metre a chamfer is 32 more triangles a
    // chip nobody can see, and the chips land in the concrete batches that
    // the shadow cascades draw again
    const g = boxGeo(w, h, d, TILE.concrete);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(randRange(-0.3, 0.3), Math.random() * Math.PI, randRange(-0.3, 0.3))));
    g.translate(x, y + h * 0.2, z);
    bucket(x, z, mat).push(g);
  };

  const apron = (LOT + 6) / 2;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      // drifted along the kerb, both sides of it
      for (const [ax, az, along] of [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']]) {
        for (let t = -apron; t < apron; t += randRange(1.5, 4.5)) {
          const off = apron + randRange(-0.6, 0.7);
          const x = cx + (along === 'x' ? t : ax * off), z = cz + (along === 'z' ? t : az * off);
          if (Math.random() < 0.45) sheet(x, z);
          for (let k = (Math.random() * 3) | 0; k > 0; k--) chip(x + randRange(-0.5, 0.5), z + randRange(-0.5, 0.5));
        }
      }
      for (let k = 0; k < 6; k++) sheet(cx + randRange(-apron, apron), cz + randRange(-apron, apron));
    }
  }
  // fallen off the buildings: chips along the foot of every wall
  for (const b of world.boxes) {
    if (b.floor || b.top < 2.5 || b.sin) continue;
    const per = 2 * ((b.maxX - b.minX) + (b.maxZ - b.minZ));
    for (let k = Math.round(per / 5); k > 0; k--) {
      const side = (Math.random() * 4) | 0, f = Math.random(), out = randRange(0.15, 0.9);
      const x = side < 2 ? b.minX + (b.maxX - b.minX) * f : (side === 2 ? b.minX - out : b.maxX + out);
      const z = side >= 2 ? b.minZ + (b.maxZ - b.minZ) * f : (side === 0 ? b.minZ - out : b.maxZ + out);
      chip(x, z);
    }
  }

  for (const b of byLot.values()) {
    const mesh = new THREE.Mesh(mergeIntoOne(b.geos), b.mat);
    mesh.receiveShadow = true;
    mesh.userData.debris = true;
    mesh.userData.tint = tintAt(b.x, b.z, 33, 0.18);
    group.add(mesh);
  }
}

/** One tuft: two crossed cards, each built front and back. */
function tuft(x, y, z, scale) {
  const w = randRange(0.4, 0.8) * scale, h = randRange(0.25, 0.6) * scale;
  const rot = Math.random() * Math.PI;
  const pos = [], nor = [], uv = [], idx = [];
  for (const a of [rot, rot + Math.PI / 2]) {
    const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2;
    const nx = -Math.sin(a), nz = Math.cos(a);           // the card's own normal
    for (const face of [1, -1]) {
      const base = pos.length / 3;
      // normal mostly up: a blade is lit like the ground it grows from
      const n = new THREE.Vector3(nx * face * 0.45, 1, nz * face * 0.45).normalize();
      for (const [px, py, pz, u, v] of [
        [x - dx, y, z - dz, 0, 0], [x + dx, y, z + dz, 1, 0],
        [x + dx, y + h, z + dz, 1, 1], [x - dx, y + h, z - dz, 0, 1]]) {
        pos.push(px, py, pz); nor.push(n.x, n.y, n.z); uv.push(u, v);
      }
      // wound so the facet faces the side this copy is lit from
      const ux = 2 * dx, uz = 2 * dz;                        // bottom edge
      const cx = -uz * h, cz = ux * h;                       // (bottom edge) x (up), sign of the face it makes
      const facesNormal = (cx * nx + cz * nz) * face > 0;
      if (facesNormal) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Lots per side of one batch patch (see `bakeStatic`). */
const BATCH_LOTS = 2;
const PATCH = BATCH_LOTS * BLOCK;
const PATCHES = Math.ceil(GRID / BATCH_LOTS);
const PATCH_ORIGIN = -(PATCHES * PATCH) / 2;

/** Which patch a world-space geometry belongs to, or 'all' if it spans more. */
function patchOf(geo) {
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox;
  if (max.x - min.x > PATCH || max.z - min.z > PATCH) return 'all';
  const cell = (v) => Math.min(PATCHES - 1, Math.max(0, Math.floor((v - PATCH_ORIGIN) / PATCH)));
  return `${cell((min.x + max.x) / 2)},${cell((min.z + max.z) / 2)}`;
}

/** A stable small number per material, keyed on the object (never its UUID). */
function materialIndex(seen, material) {
  if (!seen.has(material)) seen.set(material, seen.size);
  return seen.get(material);
}

/**
 * The city's materials, as steps.
 *
 * Painting them is most of boot — seven of the seventeen seconds, measured on
 * seed 1 under software rendering, and real CPU work on any machine — and it
 * used to be one block inside `buildCity`, so the page could not draw a
 * single frame until all of it was done. As steps, the loading screen can
 * say what is happening and move between them.
 *
 * Standard rather than Phong: every one of these surfaces stands under the
 * image-based sky light hung on `scene.environment`, and only a PBR material
 * reads it. Roughness comes off each texture's own luminance, so soot and
 * grime answer the sky flatly while glass and bare metal catch it.
 *
 * Each step is run inside its own `reserve`, which rewinds the seeded stream
 * afterwards: three spends four `Math.random()` calls per material, texture
 * and geometry on UUIDs, so without it every change to the look handed each
 * seed a different city (see `rng.js`). That splitting the old single
 * `reserve` into several is safe rests on one fact: nothing here draws on
 * the seeded stream for anything but UUIDs. Every texture is painted on a
 * generator of its own (`paint` in textures.js), so each step seeing the
 * stream from the same place changes no pixel — measured as an identical
 * hash over all 66 city textures on seed 1.
 */
// `weight` is each step's share of boot in tenths of a second, measured on
// seed 1 (see `Game.boot`).
export const CITY_PAINT = [
  // Several variants per style, not one. Every building of a style used to
  // wear the identical wall, and a repeated 10 m tile is far less obvious
  // than a repeated building.
  ...[0, 1, 2, 3, 4].map((style) => ({
    label: `Weathering facades ${style + 1}/5`,
    weight: [15, 10, 8, 8, 7][style],
    run(m) {
      m.facades ||= [];
      for (let v = 0; v < FACADE_VARIANTS; v++) {
        const key = 'facade' + style + '_' + v;
        const map = TEX.facade(style, v);
        m.facades.push(cutWindows(new THREE.MeshStandardMaterial({
          map, normalMap: TEX.normalFrom(map, 1.1, key, 1, true),
          normalScale: new THREE.Vector2(0.55, 0.55),
          roughnessMap: TEX.surfaceFrom(map, { dark: 1, lite: 0.34, half: true }, key),
          roughness: 1, metalness: 0.05, envMapIntensity: 0.7, vertexColors: true,
        }), TEX.facadeWindows(style, v)));
      }
    },
  })),
  {
    label: 'Pouring concrete',
    weight: 6,
    run(m) {
      const concreteTex = TEX.concrete('#6a6c72');   // cooler stock; the warm key tints it
      m.concreteMat = new THREE.MeshStandardMaterial({
        map: concreteTex, normalMap: TEX.normalFrom(concreteTex, 1.1, 'conc', 1),
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughnessMap: TEX.surfaceFrom(concreteTex, { dark: 1, lite: 0.72 }, 'conc'),
        roughness: 1, metalness: 0.02, envMapIntensity: 0.6, vertexColors: true,
      });
      const darkTex = TEX.concrete('#53565c', 1);
      m.darkConcrete = new THREE.MeshStandardMaterial({
        map: darkTex, normalMap: TEX.normalFrom(darkTex, 1.1, 'dark', 1),
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughnessMap: TEX.surfaceFrom(darkTex, { dark: 1, lite: 0.72 }, 'dark'),
        roughness: 1, metalness: 0.02, envMapIntensity: 0.6, vertexColors: true,
      });
    },
  },
  {
    label: 'Rusting the containers',
    weight: 8,
    // Containers, shutters and drums are the most repeated props in the city,
    // and one rust texture made every one of them the same green box. Each
    // variant is a different paint failing to the same oxide underneath.
    // Rust is oxide over what is still metal, so the bright pixels hold some
    // of that back: one packed map feeds both roughness and metalness.
    run(m) {
      m.rusts = [0, 1, 2, 3].map((v) => {
        const tex = TEX.rustMetal(v);
        const surface = TEX.surfaceFrom(tex, { dark: 1, lite: 0.5, metalDark: 0.1, metalLite: 0.75 }, 'rust' + v);
        return new THREE.MeshStandardMaterial({
          map: tex, normalMap: TEX.normalFrom(tex, 1.6, 'rust' + v, 1),
          normalScale: new THREE.Vector2(1, 1),
          roughnessMap: surface, metalnessMap: surface,
          roughness: 1, metalness: 1, envMapIntensity: 0.8, vertexColors: true,
        });
      });
    },
  },
  {
    label: 'Painting the metal, dirtying the glass',
    weight: 2,
    run(m) {
      const metalTex = TEX.paintedMetal();
      const metalSurface = TEX.surfaceFrom(metalTex, { dark: 0.9, lite: 0.38, metalDark: 0.35, metalLite: 0.85 }, 'painted');
      // the map is a light grey carrying scratches and rust, so what colour a
      // thing is painted stays on the material — one texture, many paints
      m.metalMat = new THREE.MeshStandardMaterial({
        color: 0x74797f,
        map: metalTex, normalMap: TEX.normalFrom(metalTex, 1.1, 'painted', 1),
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughnessMap: metalSurface, metalnessMap: metalSurface,
        roughness: 1, metalness: 1, envMapIntensity: 1, vertexColors: true,
      });
      // dark glass catches the sky hard, which is what sells it as glass; the
      // map is the dirt on it, without which it is a mirror in a ruined city
      const glassTex = TEX.dirtyGlass();
      m.glassMat = new THREE.MeshStandardMaterial({
        map: glassTex, normalMap: TEX.normalFrom(glassTex, 0.8, 'glass', 1),
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: TEX.surfaceFrom(glassTex, { dark: 0.08, lite: 0.7 }, 'glass'),
        roughness: 1, metalness: 0.88, envMapIntensity: 1.35, vertexColors: true,
      });
    },
  },
  {
    label: 'Cracking the asphalt',
    weight: 6,
    run(m) {
      const asphaltTex = TEX.asphalt();
      m.asphaltMat = new THREE.MeshStandardMaterial({
        map: asphaltTex, normalMap: TEX.normalFrom(asphaltTex, 0.9, 'asph', 1),
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap: TEX.surfaceFrom(asphaltTex, { dark: 0.98, lite: 0.55 }, 'asph'),
        roughness: 1, metalness: 0.05, envMapIntensity: 0.5, vertexColors: true,
      });
      // Lane paint. It lies 2 cm off a ground plane that stretches 324 m, and
      // a depth buffer with a 0.06 m near plane cannot separate those past
      // about 140 m, so the offset is backed up by a polygon offset rather
      // than by lifting the paint high enough to hover when you crouch next
      // to it.
      const paintTex = TEX.roadPaint();
      m.paintMat = new THREE.MeshStandardMaterial({
        map: paintTex, normalMap: TEX.normalFrom(paintTex, 0.6, 'paint', 1),
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: TEX.surfaceFrom(paintTex, { dark: 0.98, lite: 0.62 }, 'paint'),
        roughness: 1, metalness: 0.02, envMapIntensity: 0.5, vertexColors: true,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
    },
  },
  {
    label: 'Burning out the cars',
    weight: 4,
    run(m) {
      // Wrecked cars used to mint a material per car — 140-odd one-off
      // materials that no batching can ever merge. One palette, shared.
      const metalTex = TEX.paintedMetal();
      m.carBodyMats = [0x74797f, 0xa25b51, 0x5e735f, 0x8b8b80, 0x4c5157].map((color) =>
        new THREE.MeshStandardMaterial({
          color, roughness: 0.68, metalness: 0.55, envMapIntensity: 0.8,
          map: metalTex, normalMap: TEX.normalFrom(metalTex, 1.1, 'painted', 1),
          normalScale: new THREE.Vector2(0.4, 0.4), vertexColors: true,
        }));
      // A rusted wreck wears its own paint and its own rust: a smooth panel
      // gone to primer and oxide, not the container's corrugated sheet that
      // half of them used to wear (see `TEX.carRust`).
      m.carRustMats = [0, 1, 2, 3].map((v) => {
        const tex = TEX.carRust(v);
        const surface = TEX.surfaceFrom(tex, { dark: 0.95, lite: 0.5, metalDark: 0.15, metalLite: 0.55 }, 'carrust' + v);
        return new THREE.MeshStandardMaterial({
          color: 0xffffff, map: tex, normalMap: TEX.normalFrom(tex, 1.2, 'carrust' + v, 1),
          normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: surface, metalnessMap: surface,
          roughness: 1, metalness: 1, envMapIntensity: 0.7, vertexColors: true,
        });
      });
      // A burnt-out shell wears the same panels as a painted one, so it is
      // unwrapped at the same tile — what changed is the surface, not the car.
      const charTex = TEX.charred();
      const charSurface = TEX.surfaceFrom(charTex, { dark: 1, lite: 0.45, metalDark: 0.05, metalLite: 0.6 }, 'char');
      m.burntMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: charTex, normalMap: TEX.normalFrom(charTex, 1.4, 'char', 1),
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: charSurface, metalnessMap: charSurface,
        roughness: 1, metalness: 1, envMapIntensity: 0.55, vertexColors: true,
      });
      // One tile carries the tread and the wheel behind it — see `TEX.tire`.
      // Rubber is the flattest thing in the city and the rim behind it is the
      // brightest, and the difference between them is what makes a wheel read
      // as a wheel: one packed map, keyed off the tile's own luminance.
      const tireTex = TEX.tire();
      const tireSurface = TEX.surfaceFrom(tireTex, { dark: 1, lite: 0.35, metalDark: 0, metalLite: 0.9 }, 'tire');
      m.tireMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: tireTex, normalMap: TEX.normalFrom(tireTex, 1.5, 'tire', 1),
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughnessMap: tireSurface, metalnessMap: tireSurface,
        roughness: 1, metalness: 1, envMapIntensity: 0.7, vertexColors: true,
      });
    },
  },
  {
    label: 'Letting the weeds in',
    weight: 1,
    // Alpha-tested rather than blended: a blended card has to be sorted, and
    // two thousand of them merged into a handful of batches cannot be. No
    // normal map — a blade is too thin to have a relief worth lighting.
    run(m) {
      m.weedMat = new THREE.MeshStandardMaterial({
        map: TEX.weeds(0), alphaTest: 0.5,
        roughness: 0.9, metalness: 0, envMapIntensity: 0.6, vertexColors: true,
      });
      // A breeze. A still frame of weeds reads as a photograph pasted on the
      // street; a little sway reads as air. The tip moves, the root does not
      // (the card's own v is how far up the blade a vertex is), and the phase
      // runs across the city with position, so a gust is seen to travel down
      // a street rather than every tuft nodding in step. Driven by game time,
      // `windTime`, which the loop advances: a paused game is a still one.
      m.weedMat.userData.windTime = { value: 0 };
      m.weedMat.onBeforeCompile = (shader) => {
        shader.uniforms.windTime = m.weedMat.userData.windTime;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float windTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float bend = uv.y * uv.y;
            float gust = 0.6 + 0.4 * sin(windTime * 0.45 + position.x * 0.05 + position.z * 0.03);
            transformed.x += sin(windTime * 1.9 + position.x * 0.8 + position.z * 0.55) * 0.045 * bend * gust;
            transformed.z += cos(windTime * 1.5 + position.x * 0.5 - position.z * 0.7) * 0.03 * bend * gust;`);
      };
    },
  },
  {
    label: 'Leaving the rain and the litter',
    weight: 1,
    // Standing water is the one mirror in the city. Near-black and almost
    // perfectly smooth, so what it shows is the sky above it through the
    // environment map, the cloud included, and the sun's own glint; the damp
    // ring round it is the asphalt darkened and given a sheen. Both sit on
    // the road like its paint does, a centimetre up and pulled forward.
    run(m) {
      m.waterMat = new THREE.MeshStandardMaterial({
        color: 0x14161a, roughness: 0.06, metalness: 0, envMapIntensity: 1.25,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      // The sky in a puddle is the environment map and stays mirror-sharp.
      // The sun in it is the directional light's highlight, and at this
      // smoothness a correct one is thousands of times brighter than the
      // street: the bloom spread it into a white egg the size of the puddle,
      // at 0.04 and still at 0.1. So the sun's direct highlight on water is
      // turned down to a glint, and only on water.
      m.waterMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n  reflectedLight.directSpecular *= 0.015;');
      };
      // Damp ground is darker ground. With any real sheen the ring caught the
      // bright sky at a grazing angle and came out paler than the asphalt it
      // was meant to darken, so it reflects almost nothing.
      m.dampMat = new THREE.MeshStandardMaterial({
        color: 0x0a0b0d, roughness: 0.75, metalness: 0, envMapIntensity: 0.12,
        transparent: true, opacity: 0.5, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      m.dampMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
          '#include <lights_fragment_end>\n  reflectedLight.directSpecular *= 0.1;');
      };
      m.litterMat = new THREE.MeshStandardMaterial({
        map: TEX.litter(), alphaTest: 0.5,
        roughness: 0.92, metalness: 0, envMapIntensity: 0.5, vertexColors: true,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
    },
  },
  {
    label: 'Lifting the drains',
    weight: 1,
    run(m) {
      // Ironwork and paving laid flush on what is already there, pulled
      // forward by the same polygon offset as the paint so it never fights
      // the road or the flags under it.
      const flush = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, vertexColors: true };
      const iron = (tex, key) => {
        const surface = TEX.surfaceFrom(tex, { dark: 1, lite: 0.32, metalDark: 0.2, metalLite: 0.85 }, key);
        return new THREE.MeshStandardMaterial({
          color: 0xffffff, map: tex, normalMap: TEX.normalFrom(tex, 1.6, key, 1),
          normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: surface, metalnessMap: surface,
          roughness: 1, metalness: 1, envMapIntensity: 0.7, ...flush,
        });
      };
      m.coverMat = iron(TEX.manhole(), 'manhole');
      m.grateMat = iron(TEX.grate(), 'grate');
      const tac = TEX.tactile();
      m.tactileMat = new THREE.MeshStandardMaterial({
        map: tac, normalMap: TEX.normalFrom(tac, 1.8, 'tactile', 1), normalScale: new THREE.Vector2(1, 1),
        roughnessMap: TEX.surfaceFrom(tac, { dark: 1, lite: 0.72 }, 'tactile'),
        roughness: 1, metalness: 0, envMapIntensity: 0.5, ...flush,
      });
      // yellow road paint: the white paint's maps, a yellow coat
      m.yellowMat = m.paintMat.clone();
      m.yellowMat.color.set(0xd6a93a);
    },
  },
  {
    label: 'Hanging the fire escapes',
    weight: 1,
    run(m) {
      // the frame, rails, stringers and brackets: the painted metal's maps
      // under the black a fire escape is painted, gone to rust underneath
      m.ironMat = m.metalMat.clone();
      m.ironMat.color.set(0x34322f);
      // grating and baluster infill, cut out of their own textures
      const cut = (tex, key) => {
        const surface = TEX.surfaceFrom(tex, { dark: 1, lite: 0.4, metalDark: 0.3, metalLite: 0.8 }, key);
        return new THREE.MeshStandardMaterial({
          map: tex, alphaTest: 0.5, normalMap: TEX.normalFrom(tex, 1.4, key, 1),
          normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: surface, metalnessMap: surface,
          roughness: 1, metalness: 1, envMapIntensity: 0.8, vertexColors: true,
        });
      };
      m.gratingMat = cut(TEX.grating(), 'grating');
      m.railMat = cut(TEX.railing(), 'railing');
    },
  },
];

/** Every step of `CITY_PAINT` at once, for a caller with nothing to show. */
function paintCity() {
  const m = {};
  for (const step of CITY_PAINT) reserve(() => step.run(m));
  return m;
}

/**
 * Record the world size each material's tile covers, so the contract in
 * `TILE` is something a check can read back off the finished city rather
 * than something the two files have to be trusted to agree on.
 */
function labelMaterials(m) {
  const label = (mat, name, tile) => { mat.userData.name = name; mat.userData.tile = tile; };
  m.facades.forEach((mat, i) => label(mat, 'facade' + i, TILE.facade));
  m.carBodyMats.forEach((mat, i) => label(mat, 'car' + i, TILE.metal));
  m.carRustMats.forEach((mat, i) => label(mat, 'carrust' + i, TILE.metal));
  label(m.concreteMat, 'concrete', TILE.concrete);
  label(m.darkConcrete, 'dark', TILE.concrete);
  m.rusts.forEach((mat, i) => label(mat, 'rust' + i, TILE.rust));
  label(m.metalMat, 'metal', TILE.metal);
  label(m.glassMat, 'glass', TILE.glass);
  label(m.asphaltMat, 'asphalt', TILE.asphalt);
  label(m.paintMat, 'paint', TILE.paint);
  label(m.yellowMat, 'paint-yellow', TILE.paint);
  label(m.coverMat, 'cover', TILE.cover);
  label(m.grateMat, 'grate', TILE.grate);
  label(m.tactileMat, 'tactile', TILE.tactile);
  label(m.ironMat, 'iron', TILE.metal);
  label(m.gratingMat, 'grating', TILE.grating);
  label(m.railMat, 'railing', TILE.railing);
  label(m.burntMat, 'burnt', TILE.metal);
  label(m.tireMat, 'tire', TILE.rubber);
  // cards and water, not surfaces: no tile, so the density check skips them
  m.weedMat.userData.name = 'weeds';
  m.waterMat.userData.name = 'water';
  m.dampMat.userData.name = 'damp';
  m.litterMat.userData.name = 'litter';
}

/**
 * Lay out the city. `painted` is what `CITY_PAINT` produced, when the caller
 * has painted it step by step behind a loading screen; without it the
 * materials are painted here, in one go.
 */
export function buildCity(scene, painted = null) {
  const world = new World();
  world.bounds = (GRID * BLOCK) / 2 - 2;
  decorRandom.rewind(0x9e3779b9);     // one city per page, but start it level anyway

  const group = new THREE.Group();
  scene.add(group);

  const mats = painted || paintCity();
  labelMaterials(mats);
  const { facades, concreteMat, darkConcrete, rusts, metalMat, glassMat,
    asphaltMat, paintMat, yellowMat, coverMat, grateMat, tactileMat, ironMat, gratingMat, railMat, carBodyMats, carRustMats, burntMat, tireMat, weedMat,
    waterMat, dampMat, litterMat } = mats;

  /** Which paint this bit of scrap wears — by position, so it costs no stream. */
  const rustFor = (x, z) =>
    rusts[Math.floor(hash2(Math.round(x), Math.round(z), 21) * rusts.length)];

  /**
   * Every shape the street furniture is cut from, minted once.
   *
   * Inside `reserve`, like the materials and for the same reason: three
   * spends four draws of the seeded stream on each geometry's UUID, so
   * building these here would otherwise move every city. What each *prop*
   * then costs the stream is a fixed bill it pays with `spend` — see the note
   * in `rng.js`. Between the two, a wreck can be rebuilt out of a hundred and
   * eighty triangles of profile instead of five boxes and stay parked in the
   * same street, which is the only reason this pass was affordable at all.
   */
  const shapes = reserve(() => ({
    cars: { saloon: carShapes(false), pickup: carShapes(true) },
    barrier: jerseyBarrier(),
    container: shippingContainer(),
    drum: oilDrum(),
  }));

  // ---------------------------------------------------------------- ground
  const groundSize = GRID * BLOCK + 120;
  // Subdivided, and not for the silhouette: flat ground has four vertices and
  // nowhere to put the ambient darkening the bake computes. At ~2.5 m a cell
  // it also breaks up the tiling, because the per-cell tint lands at a
  // different scale from the 8 m texture.
  const groundCells = Math.round(groundSize / 2.6);
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, groundCells, groundCells);
  const guv = groundGeo.attributes.uv;
  for (let i = 0; i < guv.count; i++) {
    guv.setXY(i, guv.getX(i) * (groundSize / TILE.asphalt), guv.getY(i) * (groundSize / TILE.asphalt));
  }
  guv.needsUpdate = true;
  const ground = new THREE.Mesh(groundGeo, asphaltMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.tint = [1, 1, 1];
  ground.userData.mottle = 0.22;
  group.add(ground);

  // The ground bullets are traced against is the same plane at two triangles.
  // three has no BVH — a raycast walks every triangle inside the bounding
  // sphere, and the ground's covers the sector, so tracing the subdivided one
  // would test thirty thousand triangles per pellet and nine per shotgun
  // blast. It never joins the scene, so nothing will update its matrix later.
  const groundHit = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), asphaltMat);
  groundHit.rotation.x = -Math.PI / 2;
  groundHit.updateMatrixWorld(true);
  groundHit.matrixAutoUpdate = false;
  world.solids.push(groundHit);   // so bullets that miss still kick up dust

  // Every slab drawn as something to stand on — the sidewalks, the plaza, a
  // rubble lot's broken floor, a ruin's courtyard — recorded as it is laid
  // and registered once the rest of the city is (see `registerFloors`).
  const floors = [];
  // every heap of rubble and fallen slab, given a collider once the city is placed
  const heaps = [];
  // how many props `settle` has stood up, so each one's colliders carry an id
  let settled = 0;

  // sidewalks: a raised concrete apron around every lot
  const walkMat = concreteMat;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const walk = new THREE.Mesh(
        boxGeo(LOT + 6, 0.28, LOT + 6, TILE.concrete, { cells: 11 }), walkMat);
      walk.position.set(lotCenter(i), 0.14, lotCenter(j));
      walk.receiveShadow = true;
      walk.userData.tint = tintAt(lotCenter(i), lotCenter(j), 5, 0.07);
      group.add(walk);
      floors.push(walk);
    }
  }

  // Lane paint down every street. Decoration, and therefore free — see the
  // note on `decor` — but it is laid off the same grid the lots are, so it
  // lands on the roads and nowhere else.
  roadMarkings(group, paintMat, yellowMat);

  // ------------------------------------------------------------- buildings
  const fireBarrels = [];

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const isCentre = i === 2 && j === 3;      // player insertion plaza
      if (isCentre) {
        buildPlaza(group, world, cx, cz, darkConcrete, metalMat);
        continue;
      }

      const roll = Math.random();
      if (roll < 0.16) {
        buildRubbleLot(group, world, cx, cz, darkConcrete);
      } else if (roll < 0.28) {
        buildLowRuin(group, world, cx, cz, facades, darkConcrete);
      } else {
        buildTower(group, world, cx, cz, facades, concreteMat, metalMat, glassMat);
      }
    }
  }

  // ----------------------------------------------------------- street junk
  const lamps = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const half = LOT / 2 + 3;

      // Each prop is rolled exactly as it always was and then settled: moved
      // as little as it takes to stand clear and level, and lifted onto the
      // floor it stands on — or dropped, when nowhere near will have it.

      // streetlight on a lot corner
      if (Math.random() < 0.55) {
        const lamp = settle(group, world, 1.5, () => streetlight(group, world, cx + half + 1.5, cz + half + 1.5, metalMat));
        if (lamp) lamps.push({ x: lamp.made.x + lamp.dx, y: lamp.made.y + lamp.y, z: lamp.made.z + lamp.dz });
      }
      // wrecked vehicles along the street running +Z of this lot
      if (Math.random() < 0.8) {
        settle(group, world, 3, () => {
          const along = randRange(-LOT / 2, LOT / 2);
          wreckedCar(group, world, cx + along, cz + half + randRange(2, 5), Math.random() < 0.5 ? 0 : Math.PI, metalMat, glassMat);
        });
      }
      if (Math.random() < 0.6) {
        settle(group, world, 3, () => {
          const along = randRange(-LOT / 2, LOT / 2);
          wreckedCar(group, world, cx + half + randRange(2, 5), cz + along, Math.PI / 2 + randRange(-0.35, 0.35), metalMat, glassMat);
        });
      }
      // barricades and containers block some intersections
      if (Math.random() < 0.30) {
        settle(group, world, 3, () => barricade(group, world, cx + half + randRange(-3, 3), cz + half + randRange(-3, 3), Math.random() * Math.PI, darkConcrete), true);
      }
      if (Math.random() < 0.16) {
        settle(group, world, 3, () => container(group, world, cx + half + randRange(-2, 2), cz + half + randRange(-2, 2), Math.random() < 0.5 ? 0 : Math.PI / 2));
      }
      if (Math.random() < 0.35) {
        const b = settle(group, world, 3, () => fireBarrel(group, world, cx + half + randRange(-4, 4), cz + half + randRange(-4, 4)));
        if (b) fireBarrels.push(b.made);
      }
      rubblePile(group, cx + randRange(-half, half), cz + half + randRange(1, 5), darkConcrete);
    }
  }

  // Overhead cables, strung between streetlights that already exist — which
  // is why this runs after the pass that places them rather than inside it.
  // Each lamp reaches to its nearest neighbour up-street and across, so the
  // sky gets lines over it without turning into a net.
  decor(() => {
    for (const a of lamps) {
      for (const axis of ['x', 'z']) {
        let best = null, bestD = 1e9;
        for (const b of lamps) {
          if (b === a || b[axis] <= a[axis]) continue;
          const other = axis === 'x' ? 'z' : 'x';
          if (Math.abs(b[other] - a[other]) > 2.5) continue;     // along a street
          // lot corners are one BLOCK apart, so the reach has to clear that
          const d = b[axis] - a[axis];
          if (d < 8 || d > BLOCK + 3 || d >= bestD) continue;
          best = b; bestD = d;
        }
        if (best && hash2(Math.round(a.x), Math.round(a.z), axis === 'x' ? 70 : 71) < 0.8) {
          cable(group, a, best, metalMat);
        }
      }
    }
  });

  // ---------------------------------------------------- perimeter blockade
  const edge = (GRID * BLOCK) / 2;
  for (const [ax, az, rot] of [[0, -edge, 0], [0, edge, 0], [-edge, 0, Math.PI / 2], [edge, 0, Math.PI / 2]]) {
    const len = GRID * BLOCK + 20;
    const wall = new THREE.Mesh(
      boxGeo(rot === 0 ? len : 4, 9, rot === 0 ? 4 : len, TILE.concrete, { bands: 6 }), darkConcrete);
    wall.position.set(ax, 4.5, az);
    wall.castShadow = wall.receiveShadow = true;
    wall.userData.tint = tintAt(ax, az, 9, 0.06);
    group.add(wall);
    world.solids.push(wall);
    const hw = rot === 0 ? len / 2 : 2, hd = rot === 0 ? 2 : len / 2;
    world.addBox(ax - hw, az - hd, ax + hw, az + hd, 9);
    // piled debris against the inside face so the wall reads as a collapse
    for (let k = 0; k < 14; k++) {
      const t = randRange(-0.45, 0.45) * len;
      const px = rot === 0 ? ax + t : ax - Math.sign(ax) * randRange(3, 6);
      const pz = rot === 0 ? az - Math.sign(az) * randRange(3, 6) : az + t;
      rubblePile(group, px, pz, darkConcrete, 1.6);
    }
  }

  // ------------------------------------------------- climbable structures
  // Vertical ground: raised slabs and stacked containers, each reachable by
  // a stair run of half-metre steps so they can be walked up without jumping.
  const perches = [];
  const sites = [];                             // each perch's deck and stair run
  const edgeLimit = (GRID * BLOCK) / 2 - 8;    // keep clear of the perimeter
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const half = LOT / 2 + 3;
      const wantTerrace = Math.random() < 0.6;

      // A structure is only worth building if both the platform footprint and
      // the whole stair run land on clear ground — a buried staircase is an
      // unclimbable one.
      for (let attempt = 0; attempt < 16; attempt++) {
        const px = cx + randRange(-half - 5, half + 5);
        const pz = cz + randRange(-half - 5, half + 5);
        if (Math.abs(px) > edgeLimit || Math.abs(pz) > edgeLimit) continue;

        if (wantTerrace) {
          const h = randRange(3.2, 5.4);
          const sw = randRange(5, 8.5), sd = randRange(5, 8.5);
          const fromSouth = Math.random() < 0.5;
          const runLen = h * 1.9 + 1;
          const zLo = fromSouth ? pz - sd / 2 : pz - sd / 2 - runLen;
          const zHi = fromSouth ? pz + sd / 2 + runLen : pz + sd / 2;
          if (!areaClear(world, px - sw / 2 - 1, zLo - 1, px + sw / 2 + 1, zHi + 1)) continue;
          sites.push([px - sw / 2 - 1, zLo - 1, px + sw / 2 + 1, zHi + 1]);
          terrace(group, world, px, pz, sw, sd, h, fromSouth, darkConcrete, perches);
        } else {
          const rot = Math.random() < 0.5 ? 0 : Math.PI / 2;
          const halfW = rot === 0 ? 1.6 : 3.4, halfD = rot === 0 ? 3.4 : 1.6;
          if (!areaClear(world, px - halfW - 8, pz - halfD - 8, px + halfW + 8, pz + halfD + 8)) continue;
          // the deck and its stair run, which climbs off its +x side or its +z
          const run = 2.6 * 2 * 1.9 + 1;
          sites.push([px - halfW - 1, pz - halfD - 1,
            px + halfW + 1 + (rot === 0 ? run : 0), pz + halfD + 1 + (rot === 0 ? 0 : run)]);
          containerStack(group, world, px, pz, rot, perches);
        }
        break;
      }
    }
  }

  // Rubble is not in the box list while the perches go down — it is
  // registered last — so a perch went down in a rubble lot as readily as
  // anywhere, with a fallen slab lying across its stairs. The perch stays
  // where it was placed and the rubble on its deck and its run is cleared
  // away, the way whoever built it would have. The heaps were already built,
  // so taking them out costs the stream nothing.
  for (let k = heaps.length - 1; k >= 0; k--) {
    const m = heaps[k];
    m.updateMatrixWorld(true);
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
    if (!sites.some(([x0, z0, x1, z1]) => b.max.x > x0 && b.min.x < x1 && b.max.z > z0 && b.min.z < z1)) continue;
    m.removeFromParent();
    heaps.splice(k, 1);
    const i = world.solids.indexOf(m);
    if (i >= 0) world.solids.splice(i, 1);
  }

  // The same for a fire escape, which is decoration — built on the facade
  // before any perch existed, and in neither collision list, because nothing
  // standing on the street can reach its lowest platform. A terrace can:
  // seed 1 put one 1.15 m above a deck and 1.4 m off it, a jump you landed
  // and fell straight through. Any fire escape with a part in reach of a
  // deck — a running jump's carry off its edge, and from just under it to a
  // mantle above it — is taken down, whole.
  clearEscapesNear(group, world, perches);

  registerFloors(world, floors);
  registerHeaps(world, heaps);

  // Last, so it sees every collider and every floor it might grow against —
  // and inside `decor`, so where it grows costs the layout nothing.
  decor(() => {
    overgrowth(group, world, weedMat);
    puddles(group, world, waterMat, dampMat);
    debris(group, world, litterMat, [concreteMat, darkConcrete]);
    streetIron(group, world, coverMat, grateMat, tactileMat);
  });

  const batches = bakeStatic(group, world);

  // The street grid, published rather than re-derived. `roadMarkings` lays
  // paint off these three numbers and the check that the paint is on the road
  // reads the same three, so there is one definition of where a street is.
  const streets = { centres: STREETS, half: ROAD_HALF, end: STREET_END };

  return { world, group, fireBarrels, perches, batches, streets, shapes };

  /** True when no registered box taller than `maxTop` overlaps the rectangle. */
  function areaClear(w, minX, minZ, maxX, maxZ, maxTop = 0.4) {
    for (const b of w.boxes) {
      if (b.top <= maxTop) continue;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      return false;
    }
    return true;
  }


  // ------------------------------------------------------------- builders
  function buildTower(g, w, cx, cz, facadeMats, conc, metal, glass) {
    // split the lot into 1, 2 or 4 buildings
    const splits = pick([1, 1, 2, 2, 4]);
    const cells = splits === 1 ? [[0, 0, LOT, LOT]]
      : splits === 2
        ? (Math.random() < 0.5
          ? [[-LOT / 4, 0, LOT / 2 - 1, LOT], [LOT / 4, 0, LOT / 2 - 1, LOT]]
          : [[0, -LOT / 4, LOT, LOT / 2 - 1], [0, LOT / 4, LOT, LOT / 2 - 1]])
        : [[-LOT / 4, -LOT / 4, LOT / 2 - 1, LOT / 2 - 1], [LOT / 4, -LOT / 4, LOT / 2 - 1, LOT / 2 - 1],
           [-LOT / 4, LOT / 4, LOT / 2 - 1, LOT / 2 - 1], [LOT / 4, LOT / 4, LOT / 2 - 1, LOT / 2 - 1]];

    for (const [ox, oz, bw, bd] of cells) {
      const h = randRange(7, 12) + Math.random() * randRange(0, 26);
      const mat = pick(facadeMats);
      const x = cx + ox, z = cz + oz;
      const tint = tintAt(x, z, 1);
      const body = new THREE.Mesh(boxGeo(bw, h, bd, TILE.facade, wallUV(x, z, h)), mat);
      body.position.set(x, h / 2, z);
      body.castShadow = body.receiveShadow = true;
      body.userData.tint = tint;
      g.add(body);
      w.addSolid(body, bw / 2, bd / 2, h);

      // parapet
      const cap = new THREE.Mesh(boxGeo(bw + 0.6, 0.8, bd + 0.6, TILE.concrete), conc);
      cap.position.set(x, h + 0.4, z);
      cap.castShadow = true;
      cap.userData.tint = tint;
      g.add(cap);

      // tall blocks step back near the top, which is most of what gives a
      // skyline its silhouette
      if (h > 20 && Math.random() < 0.65) {
        const setH = randRange(4, 10);
        const inset = randRange(1.5, 3);
        const tower = new THREE.Mesh(
          boxGeo(bw - inset * 2, setH, bd - inset * 2, TILE.facade, wallUV(x + 7, z + 7, setH)), mat);
        tower.position.set(x + randRange(-inset, inset) * 0.4, h + setH / 2 + 0.8,
          z + randRange(-inset, inset) * 0.4);
        tower.castShadow = tower.receiveShadow = true;
        tower.userData.tint = tint;
        g.add(tower);
        w.solids.push(tower);
        const capTop = new THREE.Mesh(
          boxGeo(bw - inset * 2 + 0.5, 0.6, bd - inset * 2 + 0.5, TILE.concrete), conc);
        capTop.position.set(tower.position.x, h + setH + 1.1, tower.position.z);
        capTop.userData.tint = tint;
        g.add(capTop);
      }

      // a ledge at the base grounds the block against the pavement
      const skirt = new THREE.Mesh(boxGeo(bw + 0.5, 0.45, bd + 0.5, TILE.concrete), conc);
      skirt.position.set(x, 3.0, z);
      skirt.castShadow = true;
      skirt.userData.tint = tint;
      g.add(skirt);

      // rooftop clutter
      if (h > 14) {
        for (let k = 0; k < 2 + (Math.random() * 3 | 0); k++) {
          const uw = randRange(1.2, 2.8), uh = randRange(0.8, 2.2);
          const unit = new THREE.Mesh(boxGeo(uw, uh, uw, TILE.metal), metal);
          unit.position.set(x + randRange(-bw / 3, bw / 3), h + uh / 2 + 0.6, z + randRange(-bd / 3, bd / 3));
          unit.castShadow = true;
          g.add(unit);
        }
        if (Math.random() < 0.5) {
          const mast = new THREE.Mesh(cylGeo(0.09, 0.09, randRange(4, 9), TILE.metal, 5), metal);
          mast.position.set(x + randRange(-bw / 3, bw / 3), h + 4 + 0.6, z + randRange(-bd / 3, bd / 3));
          g.add(mast);
        }
      }

      // ground-floor storefront: dark glass band + a shutter
      const band = new THREE.Mesh(boxGeo(bw + 0.1, 2.6, bd + 0.1, TILE.glass), glass);
      band.position.set(x, 1.6, z);
      g.add(band);
      const shut = new THREE.Mesh(boxGeo(bw * 0.4, 2.4, 0.2, TILE.rust), rustFor(x, z));
      shut.position.set(x + randRange(-bw / 4, bw / 4), 1.4, z + bd / 2 + 0.12);
      shut.userData.tint = tintAt(x, z, 2, 0.1);
      g.add(shut);

      // relief, roofline and street level — none of it costs the layout a
      // draw, so the same seed lays out the same city with or without it
      basePlinth(g, x, z, bw, bd, conc, tint);
      facadeRelief(g, x, z, bw, bd, h, conc, tint);
      roofFurniture(g, x, z, bw, bd, h, conc, metal);
      streetFurniture(g, x, z, bw, bd, h, metal, cx, cz);
      fireEscape(g, x, z, bw, bd, h, metal, cx, cz);
    }
  }

  function buildLowRuin(g, w, cx, cz, facadeMats, conc) {
    // a shell of walls with the roof gone
    const h = randRange(3.5, 6.5);
    const t = 0.7;
    const mat = pick(facadeMats);
    const half = LOT / 2 - 1;
    const walls = [
      [0, -half, LOT - 2, t], [0, half, LOT - 2, t],
      [-half, 0, t, LOT - 2], [half, 0, t, LOT - 2],
    ];
    for (const [ox, oz, bw, bd] of walls) {
      if (Math.random() < 0.25) continue;              // blown-out wall
      const seg = Math.random() < 0.4 ? 0.55 : 1;      // partial collapse
      const wgt = bw > bd ? bw * seg : bw, dgt = bd > bw ? bd * seg : bd;
      const hh = h * randRange(0.6, 1);
      const px = cx + ox + (bw > bd ? randRange(-2, 2) : 0);
      const pz = cz + oz + (bd > bw ? randRange(-2, 2) : 0);
      const m = new THREE.Mesh(boxGeo(wgt, hh, dgt, TILE.facade, wallUV(px, pz, hh)), mat);
      m.position.set(px, hh / 2, pz);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(cx, cz, 1);
      g.add(m);
      w.addSolid(m, wgt / 2, dgt / 2, hh);
    }
    // floor slab + interior rubble
    const slab = new THREE.Mesh(boxGeo(LOT - 2, 0.3, LOT - 2, TILE.concrete, { cells: 9 }), conc);
    slab.position.set(cx, 0.3, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);
    floors.push(slab);
    for (let k = 0; k < 5; k++) rubblePile(g, cx + randRange(-8, 8), cz + randRange(-8, 8), conc);
    if (Math.random() < 0.5) settle(g, w, 4, () => container(g, w, cx + randRange(-6, 6), cz + randRange(-6, 6), Math.random() * Math.PI));
  }

  function buildRubbleLot(g, w, cx, cz, conc) {
    const slab = new THREE.Mesh(boxGeo(LOT, 0.2, LOT, TILE.concrete, { cells: 9 }), conc);
    slab.position.set(cx, 0.25, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);
    floors.push(slab);
    for (let k = 0; k < 14; k++) {
      rubblePile(g, cx + randRange(-9, 9), cz + randRange(-9, 9), conc, randRange(0.7, 1.9));
    }
    // leaning slabs of collapsed floor
    for (let k = 0; k < 3; k++) {
      const sw = randRange(3, 7), sh = randRange(2.5, 5);
      const m = new THREE.Mesh(boxGeo(sw, 0.4, sh, TILE.concrete), conc);
      m.position.set(cx + randRange(-7, 7), randRange(0.8, 2), cz + randRange(-7, 7));
      m.rotation.set(randRange(-0.9, 0.9), Math.random() * Math.PI, randRange(-0.9, 0.9));
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(m.position.x, m.position.z, 7, 0.12);
      g.add(m);
      w.solids.push(m);
      heaps.push(m);
    }
    if (Math.random() < 0.6) settle(g, w, 4, () => container(g, w, cx + randRange(-7, 7), cz + randRange(-7, 7), Math.random() * Math.PI));
  }

  function buildPlaza(g, w, cx, cz, conc, metal) {
    const slab = new THREE.Mesh(boxGeo(LOT + 4, 0.3, LOT + 4, TILE.concrete, { cells: 11 }), conc);
    slab.position.set(cx, 0.15, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);
    floors.push(slab);

    // dry fountain in the middle: cover to fight from
    // It is a basin: a battered rim a quarter metre wide round a dry floor at
    // plaza level, and a plinth in the middle. It used to be an open tube
    // with a 6.8 m square deck at the rim's height for a collider, so you
    // stood on air over the basin and on air past the rim at every corner of
    // the square, and walked through the plinth from the deck.
    spend(2 * UUID_COST);                         // what the open tube cost
    const ring = reserve(() => new THREE.Mesh(latheGeo(
      [[3.4, 0], [3.2, 1.0], [2.95, 1.0], [2.95, 0.25]], 24, TILE.concrete).rotateX(-Math.PI / 2), conc));   // a lathe turns about Z
    ring.position.set(cx, 0, cz);
    ring.castShadow = ring.receiveShadow = true;
    g.add(ring);
    w.solids.push(ring);
    // the rim, as sixteen staves round the circle: the corner of each stands
    // 6 cm past the curve at worst, so a body is stopped where the rim is
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, r = 3.17;
      const half = r * Math.tan(Math.PI / 16) + 0.03;
      w.addRotatedBox(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.23, half, -a, 1);   // thin across the radius
    }

    const plinth = new THREE.Mesh(boxGeo(1.4, 2.2, 1.4, TILE.concrete), conc);
    plinth.position.set(cx, 1.1, cz);
    plinth.castShadow = true;
    g.add(plinth);
    w.addSolid(plinth, 0.7, 0.7, 2.2);

    // sandbagged firing positions around the plaza
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      settle(g, w, 2, () => barricade(g, w, cx + Math.cos(a) * 8, cz + Math.sin(a) * 8, a, conc), true);
    }
    for (let k = 0; k < 3; k++) {
      settle(g, w, 6, () => container(g, w, cx + randRange(-9, 9), cz + randRange(-9, 9), Math.random() * Math.PI));
    }
  }

  /**
   * Stair run of half-metre steps — low enough that the step-up in the
   * movement code carries you and the hostiles up without jumping.
   *
   * `(x, z)` is the deck edge the run climbs to and `rot` the direction it
   * climbs in, and both ends are derived from that: the last tread abuts the
   * edge and tops out exactly at `height`. The run used to be laid from its
   * foot by a run length worked out separately from the step count, so it
   * stopped up to 0.85 m short of a terrace and 1.6 m short of a container
   * stack, and you walked off the top step into the street.
   */
  function stairs(g, w, x, z, rot, height, width = 3) {
    const run = 0.85;
    const count = Math.max(1, Math.round(height / 0.46));
    const rise = height / count;            // 0.37-0.49 m for every perch height
    const dirX = Math.sin(rot), dirZ = Math.cos(rot);
    const x0 = x - dirX * run * (count - 0.5), z0 = z - dirZ * run * (count - 0.5);
    for (let k = 0; k < count; k++) {
      const top = rise * (k + 1);
      const sx = x0 + dirX * (run * k);
      const sz = z0 + dirZ * (run * k);
      // each tread is a solid block from the ground up to its own height
      const m = new THREE.Mesh(boxGeo(
        Math.abs(dirX) > 0.5 ? run : width, top,
        Math.abs(dirX) > 0.5 ? width : run, TILE.concrete), darkConcrete);
      m.position.set(sx, top / 2, sz);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(x, z, 8, 0.06);
      g.add(m);
      w.solids.push(m);
      const hw = (Math.abs(dirX) > 0.5 ? run : width) / 2;
      const hd = (Math.abs(dirX) > 0.5 ? width : run) / 2;
      w.addBox(sx - hw, sz - hd, sx + hw, sz + hd, top);
    }
  }

  /** Raised slab of collapsed floor: cover, a firing position, a perch. */
  function terrace(g, w, x, z, sw, sd, h, fromSouth, conc, perchList) {
    const slab = new THREE.Mesh(boxGeo(sw, h, sd, TILE.concrete, { bands: 3, cells: 3 }), conc);
    slab.position.set(x, h / 2, z);
    slab.castShadow = slab.receiveShadow = true;
    slab.userData.tint = tintAt(x, z, 8, 0.06);
    g.add(slab);
    w.solids.push(slab);
    w.addBox(x - sw / 2, z - sd / 2, x + sw / 2, z + sd / 2, h);

    // stairs climbing to it from the side the caller checked was clear
    const STAIR_W = 3;
    const rot = fromSouth ? Math.PI : 0;
    stairs(g, w, x, fromSouth ? z + sd / 2 : z - sd / 2, rot, h, STAIR_W);

    // Knee-high lip so the top reads as a platform, not a plinth. A lip is a
    // collider as well as a solid — it used to stop bullets and not boots, so
    // you walked through a wall you could see. The one across the head of the
    // stairs is built either side of the opening, or registering it would put
    // a step taller than the step-up between the top tread and the deck.
    const segment = (cx, cz, lw, ld) => {
      const lip = new THREE.Mesh(boxGeo(lw, 0.5, ld, TILE.concrete), conc);
      lip.position.set(cx, h + 0.25, cz);
      lip.castShadow = true;
      g.add(lip);
      w.solids.push(lip);
      w.addBox(cx - lw / 2, cz - ld / 2, cx + lw / 2, cz + ld / 2, h + 0.5);
      return lip;
    };
    for (const [ox, oz, lw, ld, side] of [
      [0, -sd / 2 + 0.3, sw, 0.5, -1], [0, sd / 2 - 0.3, sw, 0.5, 1],
      [-sw / 2 + 0.3, 0, 0.5, sd, 0], [sw / 2 - 0.3, 0, 0.5, sd, 0],
    ]) {
      if (Math.random() < 0.35) continue;                 // gaps to shoot through
      if (side !== (fromSouth ? 1 : -1)) {
        segment(x + ox, z + oz, lw, ld);
        continue;
      }
      // the stair head: two pieces, paying what the one lip cost the stream
      spend(2 * UUID_COST);
      reserve(() => {
        const piece = (sw - STAIR_W) / 2;
        segment(x - sw / 2 + piece / 2, z + oz, piece, ld);
        segment(x + sw / 2 - piece / 2, z + oz, piece, ld);
      });
    }
    if (Math.random() < 0.4) {
      // A crate you can climb onto, so it is a collider — it used to be drawn
      // and nothing else, and you fell through it. It is kept a body's width
      // off the perch point across the slab, because that is where a marksman
      // is put down.
      const rx = randRange(-sw / 4, sw / 4), rz = randRange(-sd / 4, sd / 4);
      const clear = 0.6 + 0.42 + 0.05;                   // crate half + body radius
      const room = Math.max(0, sw / 2 - 0.55 - 0.6 - clear);   // inside the lip
      const cx = x + Math.sign(rx || 1) * (clear + (Math.abs(rx) / (sw / 4)) * room);
      const cz = z + rz;
      const crate = new THREE.Mesh(boxGeo(1.2, 1.2, 1.2, TILE.rust), rustFor(x, z));
      crate.position.set(cx, h + 0.6, cz);
      crate.castShadow = true;
      crate.userData.tint = tintAt(cx, cz, 2, 0.12);
      g.add(crate);
      w.solids.push(crate);
      w.addBox(cx - 0.6, cz - 0.6, cx + 0.6, cz + 0.6, h + 1.2);
    }
    perchList.push({ x, y: h, z });
    return { x, y: h, z };
  }

  /** Two containers stacked, with crate steps up the side. */
  function containerStack(g, w, x, z, rot, perchList) {
    const cw = 2.5, ch = 2.6, cd = 6.0;
    for (let k = 0; k < 2; k++) {
      spend(2 * UUID_COST);                       // what the box used to cost
      const m = reserve(() => new THREE.Mesh(shapes.container, rustFor(x, z + k * 3)));
      // The top one used to be slid up to 0.4 m off the one below, over a
      // collider that stayed put — a deck you stood on air beside and fell
      // through the edge of. The roll is still drawn, because the stream
      // after it is the rest of the city; it just no longer moves anything.
      if (k) randRange(-0.4, 0.4);
      m.position.set(x, k * ch, z);
      m.rotation.y = rot;
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(x, z, 2 + k, 0.14);
      g.add(m);
      w.solids.push(m);
    }
    w.addRotatedBox(x, z, cw / 2, cd / 2, rot, ch * 2);

    // crate steps climbing the long side up to the top of the stack
    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const halfW = (cw / 2) * cos + (cd / 2) * sin;
    const halfD = (cw / 2) * sin + (cd / 2) * cos;
    if (rot === 0) {
      stairs(g, w, x + halfW, z, Math.PI / 2 * 3, ch * 2, 2.4);
    } else {
      stairs(g, w, x, z + halfD, Math.PI, ch * 2, 2.4);
    }

    perchList.push({ x, y: ch * 2, z });
  }

  function streetlight(g, w, x, z, metal) {
    const pole = new THREE.Mesh(cylGeo(0.13, 0.17, 7, TILE.metal, 6), metal);
    pole.position.set(x, 3.5, z);
    pole.castShadow = true;
    g.add(pole);
    const arm = new THREE.Mesh(boxGeo(1.8, 0.16, 0.16, TILE.metal), metal);
    arm.position.set(x + 0.9, 6.9, z);
    g.add(arm);
    const head = new THREE.Mesh(boxGeo(0.9, 0.22, 0.4, TILE.metal), metal);
    head.position.set(x + 1.7, 6.78, z);
    g.add(head);
    w.addBox(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 7);
    return { x, y: 6.4, z };
  }

  /* ------------------------------------------------------------- decoration
   *
   * Everything below runs inside `decor` and costs the layout nothing — see
   * the note on `decorRandom`. None of it registers a box or a solid: it is
   * what a block *looks* like, not what it is.
   */

  /**
   * Which way a projection should hang: away from the middle of the lot, so
   * an awning or a fire escape reaches over the street rather than into the
   * building sharing the lot with this one. A lot holding a single building
   * has no inward side, so that case falls back to the hash.
   */
  function outward(offset, roll) {
    if (Math.abs(offset) < 0.5) return roll < 0.5 ? -1 : 1;
    return offset >= 0 ? 1 : -1;
  }

  /**
   * Pilasters and a string course.
   *
   * A building here is a rectangular prism wearing a tiled photograph of a
   * wall, and under one low sun that is two lit faces, two dark ones and no
   * line anywhere between them — which is most of what reads as "boxy" from
   * the street. Ribs standing a hand's width proud of the face on the window
   * bay lines give the sun something to catch and cast, at four boxes a face.
   */
  function facadeRelief(gr, x, z, bw, bd, h, conc, tint) {
    decor(() => {
      const key = [Math.round(x), Math.round(z)];
      if (hash2(key[0], key[1], 31) > 0.78) return;        // not every block
      const foot = 3.5, head = 1.4;                        // clear of skirt and cap
      const runH = h - foot - head;
      if (runH < 3.5) return;
      const proud = 0.24, ribW = 0.5;

      const rib = (px, pz, rw, rd) => {
        const m = new THREE.Mesh(boxGeo(rw, runH, rd, TILE.concrete), conc);
        m.position.set(px, foot + runH / 2, pz);
        m.castShadow = m.receiveShadow = true;
        m.userData.tint = tint;
        gr.add(m);
      };
      // on the bay lines, so the ribs land between windows rather than across
      // them — the same snap `wallUV` gives the texture
      const onBays = (span, place) => {
        const bays = Math.max(1, Math.round(span / BAY));
        const every = bays > 5 ? 2 : 1;
        for (let k = every; k < bays; k += every) place(-span / 2 + (span / bays) * k);
      };
      onBays(bw, (ox) => {
        rib(x + ox, z - bd / 2 - proud / 2 + 0.04, ribW, proud);
        rib(x + ox, z + bd / 2 + proud / 2 - 0.04, ribW, proud);
      });
      onBays(bd, (oz) => {
        rib(x - bw / 2 - proud / 2 + 0.04, z + oz, proud, ribW);
        rib(x + bw / 2 + proud / 2 - 0.04, z + oz, proud, ribW);
      });

      const band = new THREE.Mesh(boxGeo(bw + proud * 2, 0.42, bd + proud * 2, TILE.concrete), conc);
      band.position.set(x, h - head + 0.2, z);
      band.castShadow = true;
      band.userData.tint = tint;
      gr.add(band);
    });
  }

  /** A base course, so a tower meets the pavement on something. */
  function basePlinth(gr, x, z, bw, bd, conc, tint) {
    decor(() => {
      const hgt = 0.7 + hash2(Math.round(x), Math.round(z), 32) * 0.5;
      const m = new THREE.Mesh(boxGeo(bw + 0.55, hgt, bd + 0.55, TILE.concrete), conc);
      m.position.set(x, hgt / 2, z);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tint;
      gr.add(m);
    });
  }

  /**
   * What stands on a roof: a stair bulkhead, a water tank on legs, vent
   * stacks, and a length of parapet still up where the rest came down. A
   * skyline of flat-topped rectangles is the one part of the city you see
   * from everywhere, and it was the one part with nothing on it.
   */
  function roofFurniture(gr, x, z, bw, bd, h, conc, metal) {
    decor(() => {
      const r = (s) => hash2(Math.round(x), Math.round(z), s);
      const deck = h + 0.8;

      if (r(33) < 0.75) {
        const bwd = 2.0 + r(34) * 1.5, bhh = 1.9 + r(35) * 1.0;
        const m = new THREE.Mesh(boxGeo(bwd, bhh, bwd * 0.82, TILE.concrete), conc);
        m.position.set(x + (r(36) - 0.5) * bw * 0.45, deck + bhh / 2, z + (r(37) - 0.5) * bd * 0.45);
        m.castShadow = m.receiveShadow = true;
        m.userData.tint = tintAt(x, z, 8, 0.08);
        gr.add(m);
      }

      if (h > 11 && r(38) < 0.6) {
        const tr = 1.0 + r(39) * 0.5, th = 1.8 + r(40) * 0.9, legH = 1.1;
        const tx = x + (r(41) - 0.5) * bw * 0.4, tz = z + (r(42) - 0.5) * bd * 0.4;
        const tank = new THREE.Mesh(cylGeo(tr, tr, th, TILE.rust, 10), rustFor(tx, tz));
        tank.position.set(tx, deck + legH + th / 2, tz);
        tank.castShadow = true;
        tank.userData.tint = tintAt(tx, tz, 2, 0.14);
        gr.add(tank);
        for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const leg = new THREE.Mesh(boxGeo(0.16, legH, 0.16, TILE.metal), metal);
          leg.position.set(tx + lx * tr * 0.62, deck + legH / 2, tz + lz * tr * 0.62);
          leg.castShadow = true;
          gr.add(leg);
        }
      }

      const stacks = 1 + Math.floor(r(43) * 3);
      for (let k = 0; k < stacks; k++) {
        const sh = 0.9 + r(44 + k) * 1.6;
        const pipe = new THREE.Mesh(cylGeo(0.13, 0.13, sh, TILE.metal, 6), metal);
        pipe.position.set(x + (r(47 + k) - 0.5) * bw * 0.7, deck + sh / 2, z + (r(50 + k) - 0.5) * bd * 0.7);
        pipe.castShadow = true;
        gr.add(pipe);
      }

      // a run of parapet still standing above the cap, on one edge
      if (r(53) < 0.55) {
        const along = r(54) < 0.5;
        const len = (along ? bw : bd) * (0.35 + r(55) * 0.4);
        const ph = 0.7 + r(56) * 0.8;
        const m = new THREE.Mesh(
          boxGeo(along ? len : 0.45, ph, along ? 0.45 : len, TILE.concrete), conc);
        m.position.set(
          x + (along ? (r(57) - 0.5) * (bw - len) : (r(57) < 0.5 ? -1 : 1) * (bw / 2 + 0.05)),
          deck + ph / 2,
          z + (along ? (r(58) < 0.5 ? -1 : 1) * (bd / 2 + 0.05) : (r(58) - 0.5) * (bd - len)));
        m.castShadow = m.receiveShadow = true;
        m.userData.tint = tintAt(x, z, 8, 0.08);
        gr.add(m);
      }
    });
  }

  /**
   * A canopy over the shopfront and a downpipe on a corner. Both live in the
   * bottom eight metres, which is the only part of a building you ever stand
   * close to — and the only part a silhouette change cannot reach.
   */
  function streetFurniture(gr, x, z, bw, bd, h, metal, cx, cz) {
    decor(() => {
      const r = (s) => hash2(Math.round(x), Math.round(z), s);

      if (r(60) < 0.65) {
        // out over the street, not into the building sharing this lot
        const faceZ = outward(z - cz, r(61));
        const reachOut = 1.2 + r(62) * 0.6;
        const cw = bw * (0.45 + r(63) * 0.4);
        const y = 3.05;
        const slab = new THREE.Mesh(boxGeo(cw, 0.18, reachOut, TILE.metal), metal);
        slab.position.set(x + (r(64) - 0.5) * (bw - cw), y, z + faceZ * (bd / 2 + reachOut / 2));
        slab.castShadow = true;
        gr.add(slab);
        for (const side of [-1, 1]) {
          const stay = new THREE.Mesh(boxGeo(0.09, 1.0, 0.09, TILE.metal), metal);
          stay.position.set(slab.position.x + side * cw * 0.42, y + 0.5,
            z + faceZ * (bd / 2 + 0.12));
          gr.add(stay);
        }
      }

      // a downpipe: one unbroken vertical line on a building that otherwise
      // has none between the pavement and the roof
      if (r(65) < 0.8 && h > 6) {
        const sx = r(66) < 0.5 ? -1 : 1, sz = r(67) < 0.5 ? -1 : 1;
        const len = h - 0.6;
        const pipe = new THREE.Mesh(cylGeo(0.1, 0.1, len, TILE.metal, 6), metal);
        pipe.position.set(x + sx * (bw / 2 + 0.14), 0.4 + len / 2, z + sz * (bd / 2 - 0.35));
        pipe.castShadow = true;
        gr.add(pipe);
        const shoe = new THREE.Mesh(boxGeo(0.26, 0.5, 0.26, TILE.metal), metal);
        shoe.position.set(pipe.position.x, 0.4, pipe.position.z);
        gr.add(shoe);
      }
    });
  }

  /**
   * A fire escape down one street face.
   *
   * The strongest thing available against a flat wall: a stack of landings
   * and stairs hanging a metre off it, casting a ladder of shadow down the
   * whole elevation. Its lowest landing sits above head height, which is not
   * an aesthetic choice — decoration is registered in neither `world.boxes`
   * nor `world.solids`, so anything low enough to walk into would be
   * something you walk *through*, and anything at chest height would be
   * something bullets ignore.
   *
   * It used to be a slab, a bar and a tilted plank, which read from the far
   * side of a street and fell apart up close. It is built the way one is:
   * landings of open bar grating in an angle-iron frame, carried on bearers
   * and diagonal braces back to the wall; railings of posts, a top rail, a
   * toe rail and baluster infill; a stair between each pair of landings on
   * two stringers with a tread at every step, coming up through a hatch in
   * the landing above, every flight climbing the same way; and a drop ladder
   * hung off the lowest landing. It stands 0.3 m off the face, so it clears
   * the pilasters (0.24 m proud) it used to run straight through. The
   * grating and the infill are cut out of their own textures (see
   * `keepCoverage` in `textures.js`), so you see through a landing to the
   * one above.
   */
  function fireEscape(gr, x, z, bw, bd, h, metal, cx, cz) {
    decor(() => {
      const r = (s) => hash2(Math.round(x), Math.round(z), s);
      if (r(80) > 0.45 || h < 11) return;

      const onX = r(81) < 0.5;                   // which elevation it hangs on
      const side = outward(onX ? x - cx : z - cz, r(82));
      const faceOff = (onX ? bw : bd) / 2;
      const levels = Math.min(5, Math.floor((h - 5.5) / STOREY));
      if (levels < 2) return;

      const W = 2.8;            // along the wall
      const D = 1.15;           // the landing's depth
      const GAP = 0.3;          // off the face, clear of a pilaster
      const LANE = 0.58;        // the stair's width, on the outer side of the deck
      const OUT = GAP + D;      // the landing's outer edge, from the face
      const tag = `${x},${z}`;  // one fire escape, for taking down whole
      const along0 = (r(83) - 0.5) * ((onX ? bd : bw) - W - 1);

      // Everything is laid in the face's frame — `a` along the wall, `o` out
      // from its face, `y` up — and mapped to the world at the last moment.
      const put = (geo, mat, a, o, y, shadow = true) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(
          onX ? x + side * (faceOff + o) : x + along0 + a,
          y,
          onX ? z + along0 + a : z + side * (faceOff + o));
        m.castShadow = shadow;
        m.userData.escape = tag;
        gr.add(m);
        return m;
      };
      const box = (la, ly, lo, tile = TILE.metal) => boxGeo(onX ? lo : la, ly, onX ? la : lo, tile);
      // turn a piece built along `a` so it climbs toward +a, or one built
      // along `o` so it climbs away from the wall
      const climbAlong = (m, t) => { if (onX) m.rotation.x = -t; else m.rotation.z = t; return m; };
      const climbOut = (m, t) => { if (onX) m.rotation.z = side * t; else m.rotation.x = -side * t; return m; };

      const L = W - 0.3, H = STOREY;            // a flight's run and rise
      const aFoot = -L / 2, aHead = L / 2;     // where a flight starts and lands
      const hatch = L * (2.0 / H);             // the stretch of it under head height
      const laneIn = OUT - LANE, laneMid = OUT - LANE / 2;

      for (let k = 0; k < levels; k++) {
        const y = 4.6 + k * STOREY;

        // ---- the deck: grating, with a hatch where the flight below comes up
        const deck = (a0, a1, o0, o1) => put(box(a1 - a0, 0.03, o1 - o0, TILE.grating), gratingMat,
          (a0 + a1) / 2, (o0 + o1) / 2, y - 0.015, false);
        deck(-W / 2, W / 2, GAP, laneIn);
        if (k === 0) deck(-W / 2, W / 2, laneIn, OUT);
        else {
          deck(-W / 2, aHead - hatch, laneIn, OUT);
          deck(aHead, W / 2, laneIn, OUT);
        }
        // its frame of angle iron
        for (const o of [GAP + 0.025, OUT - 0.025]) put(box(W, 0.06, 0.05), ironMat, 0, o, y - 0.03);
        for (const a of [-W / 2 + 0.025, W / 2 - 0.025]) put(box(0.05, 0.06, D), ironMat, a, GAP + D / 2, y - 0.03);
        // carried on a bearer at each end back to the wall, braced from below
        for (const a of [-W / 2 + 0.05, W / 2 - 0.05]) {
          put(box(0.06, 0.08, OUT), ironMat, a, OUT / 2, y - 0.1);
          const rise = 0.85, run = OUT - 0.12;
          climbOut(put(box(0.05, 0.05, Math.hypot(rise, run)), ironMat, a, 0.06 + run / 2, y - 0.14 - rise / 2), Math.atan2(rise, run));
        }

        // ---- railings: outer side and both ends, the wall side left open
        for (const [a, o] of [[-W / 2, OUT], [0, OUT], [W / 2, OUT], [-W / 2, GAP + 0.04], [W / 2, GAP + 0.04]]) {
          put(box(0.045, 1.0, 0.045), ironMat, a, o, y + 0.5);
        }
        for (const ry of [y + 0.98, y + 0.1]) {
          put(box(W, 0.04, 0.04), ironMat, 0, OUT, ry);
          for (const a of [-W / 2, W / 2]) put(box(0.04, 0.04, D), ironMat, a, GAP + D / 2, ry);
        }
        put(box(W, 0.86, 0.012, TILE.railing), railMat, 0, OUT, y + 0.54, false);
        for (const a of [-W / 2, W / 2]) put(box(0.012, 0.86, D, TILE.railing), railMat, a, GAP + D / 2, y + 0.54, false);

        // ---- the flight up to the next landing, in the outer lane
        if (k < levels - 1) {
          const slope = Math.atan2(H, L), len = Math.hypot(L, H);
          const steps = Math.round(H / 0.21);
          for (let i = 1; i < steps; i++) {
            put(box(L / steps + 0.02, 0.03, LANE - 0.07, TILE.grating), gratingMat,
              aFoot + (i / steps) * L, laneMid, y + (i / steps) * H - 0.015, false);
          }
          for (const o of [laneIn + 0.015, OUT - 0.015]) {
            climbAlong(put(box(len + 0.1, 0.2, 0.025), ironMat, 0, o, y + H / 2 - 0.1), slope);
            // and a handrail on posts above each stringer
            climbAlong(put(box(len, 0.04, 0.04), ironMat, 0, o, y + H / 2 + 0.85), slope);
            for (const f of [0.2, 0.8]) {
              put(box(0.035, 0.9, 0.035), ironMat, aFoot + f * L, o, y + f * H + 0.4);
            }
          }
        }
      }

      // ---- a drop ladder hung off the lowest landing, outside its rail;
      // its foot stays above a head on a car roof
      const ya = 4.6, aL = aHead - 0.25, oL = OUT + 0.08;
      for (const da of [-0.22, 0.22]) put(box(0.035, 2.2, 0.05), ironMat, aL + da, oL, ya - 0.1);
      for (let yy = ya - 1.05; yy < ya + 0.95; yy += 0.28) put(box(0.44, 0.03, 0.03), ironMat, aL, oL, yy, false);
    });
  }

  /**
   * Lane paint, laid along the streets the grid already knows the position of.
   *
   * This is the one thing the texture pass deliberately left undone, and the
   * reason is worth keeping: paint cannot live in the asphalt tile. That tile
   * repeats every 8 m across a 324 m ground plane, so a centre line painted
   * into it comes out as a grid of stripes over the entire sector — across
   * the sidewalks, across the lots, everywhere except down a street. The one
   * thing a marking needs is the one thing a tiled texture cannot have, which
   * is a position. So the shape of every marking is geometry here, and
   * `TEX.roadPaint` carries only how worn it is.
   *
   * It is decoration in the strict sense of the rule above `decor`: it
   * registers no box and no solid, which is safe because it lies flat on a
   * road you already walk over and bullets already pass through to.
   *
   * Everything is described in the street's own frame — `u` across the
   * carriageway, `v` along it — and mapped onto whichever axis the street
   * runs on at the last moment, so one description serves both grids.
   */
  function roadMarkings(gr, mat, yellowMat) {
    decor(() => {
      const Y = 0.02;
      const white = { pos: [], nor: [], uv: [] }, yellow = { pos: [], nor: [], uv: [] };
      let into = white;                 // which paint the next quad is laid in
      const r = (a, b, salt) => hash2(Math.round(a), Math.round(b), salt);

      // Mapping (u, v) onto (z, x) for one axis and onto (x, z) for the other
      // swaps the handedness of the frame, so the same corner order comes out
      // front-facing on the east-west streets and inside out on the
      // north-south ones — and an inverted facet does not error, it vanishes.
      // Same lesson as the chamfer winding in `weapons.js`; the fix is to say
      // which order each case wants rather than to write one and hope.
      const TRI = [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]];
      const FLIPPED = [TRI[2], TRI[1], TRI[0], TRI[5], TRI[4], TRI[3]];

      /** One flat quad: `w` across the street, `d` along it, raked by `turn`. */
      const quad = (axisX, u, v, w, d, turn = 0) => {
        const c = Math.cos(turn), s = Math.sin(turn);
        for (const [su, sv] of (axisX ? TRI : FLIPPED)) {
          const lu = su * w / 2, lv = sv * d / 2;
          const pu = u + lu * c - lv * s;
          const pv = v + lu * s + lv * c;
          const px = axisX ? pv : pu, pz = axisX ? pu : pv;
          into.pos.push(px, Y, pz);
          into.nor.push(0, 1, 0);
          // planar off the world, so no two dashes wear the same square metre
          into.uv.push(px / TILE.paint, pz / TILE.paint);
        }
      };

      /**
       * What a junction approach wears: a crossing over the full carriageway,
       * the stop bar for the lane that gives way at it, and an arrow in that
       * lane. `dir` is which side of the node the approach lies on, so both
       * sides of every junction are served and none is served twice.
       *
       * Returns the `v` past which ordinary lane paint may resume, and pushes
       * the crossing's footprint into `zones` so the edge lines break at it.
       */
      const approach = (axisX, across, node, dir, zones) => {
        const clear = node + dir * (ROAD_HALF + 0.3);     // edge of the junction
        // one roll per junction per street, so a crossing is a property of the
        // junction and both approaches to it are marked or neither is
        if (r(node, across, axisX ? 91 : 92) > 0.45) return clear;

        const depth = 2.2, stripe = 0.46;
        const usable = ROAD_HALF * 2 - 0.3;
        const count = Math.max(4, Math.round(usable / (stripe * 2)));
        const pitch = usable / count;
        for (let i = 0; i < count; i++) {
          const off = (i - (count - 1) / 2) * pitch;
          if (r(node + off * 7, across + dir, 95) < 0.14) continue;   // gone
          quad(axisX, across + off, clear + dir * depth / 2, stripe, depth);
        }
        zones.push([
          Math.min(clear, clear + dir * depth) - 0.2,
          Math.max(clear, clear + dir * depth) + 0.2,
        ]);

        // Traffic reaching this junction from this side travels toward the
        // node, so it is in the lane on the `-dir` side of the centre line.
        const lane = -dir;
        const bar = clear + dir * (depth + 0.55);
        quad(axisX, across + lane * (ROAD_HALF / 2), bar, ROAD_HALF - 0.25, 0.4);

        if (r(node, across + lane, 96) < 0.65) {
          arrow(axisX, across + lane * (ROAD_HALF / 2), bar + dir * 3.0, -dir);
        }
        return bar + dir * 0.9;
      };

      /** A straight-ahead arrow: a shaft and two raked barbs meeting at a tip. */
      const arrow = (axisX, u, v, fwd) => {
        const rake = 0.62, barb = 0.9, wide = 0.17;
        const tip = v + fwd * 0.95;
        quad(axisX, u, tip - fwd * 0.9, wide, 1.7);
        for (const side of [-1, 1]) {
          quad(axisX,
            u + side * (barb / 2) * Math.sin(rake),
            tip - fwd * (barb / 2) * Math.cos(rake),
            wide, barb, side * rake);
        }
      };

      for (const axisX of [true, false]) {
        for (const across of STREETS) {
          // a minority of streets are marked as no-overtaking instead
          const solid = r(across, axisX ? 1 : 2, 90) < 0.3;
          const nodes = [-STREET_END, ...STREETS, STREET_END];

          for (let k = 0; k + 1 < nodes.length; k++) {
            const loJunction = k > 0, hiJunction = k + 2 < nodes.length;
            const spanLo = nodes[k] + (loJunction ? ROAD_HALF : 0);
            const spanHi = nodes[k + 1] - (hiJunction ? ROAD_HALF : 0);
            const zones = [];
            const paintLo = loJunction ? approach(axisX, across, nodes[k], 1, zones) : spanLo;
            const paintHi = hiJunction ? approach(axisX, across, nodes[k + 1], -1, zones) : spanHi;

            // centre line, between whatever the two ends left free
            const run = paintHi - paintLo;
            if (run > 2) {
              const dash = solid ? 3.4 : 2.0;
              const pitch = solid ? 3.5 : 4.6;
              const n = Math.max(1, Math.floor(run / pitch));
              const start = paintLo + (run - (n * pitch - (pitch - dash))) / 2;
              for (let i = 0; i < n; i++) {
                const v = start + i * pitch + dash / 2;
                if (r(v, across, 93) < 0.12) continue;             // worn away
                quad(axisX, across, v, 0.14, dash);
              }
            }

            // What runs along each kerb: an edge line, most often; on some
            // spans a run of parking bays marked off from the kerb, and on
            // others double yellow lines. All of it broken at the crossings.
            const clearOf = (v, pad) => !zones.some(([lo, hi]) => v > lo - pad && v < hi + pad);
            for (const side of [-1, 1]) {
              const kerbside = r(spanLo + spanHi, across + side, axisX ? 98 : 99);
              if (kerbside < 0.2) {
                // bays: a tick out from the kerb every 5.6 m
                for (let v = spanLo + 2.5; v < spanHi - 2.0; v += 5.6) {
                  if (!clearOf(v, 1.2) || r(v, across + side, 100) < 0.12) continue;
                  quad(axisX, across + side * (ROAD_HALF - 1.0), v, 1.9, 0.11);
                }
                continue;
              }
              const lines = kerbside < 0.42
                ? [ROAD_HALF - 0.38, ROAD_HALF - 0.56]    // double yellow, clear of the gutter
                : [ROAD_HALF - 0.35];                      // edge line
              into = lines.length > 1 ? yellow : white;
              for (const off of lines) {
                const u = across + side * off;
                const n = Math.max(1, Math.round((spanHi - spanLo) / 3.2));
                const step = (spanHi - spanLo) / n;
                for (let i = 0; i < n; i++) {
                  const v = spanLo + step * (i + 0.5);
                  if (!clearOf(v, step / 2)) continue;
                  if (r(v, u, 94) < 0.18) continue;                // worn through
                  quad(axisX, u, v, lines.length > 1 ? 0.09 : 0.1, step * 0.94);
                }
              }
              into = white;
            }
          }
        }
      }

      // Yellow boxes on a few junctions: a border round the square where the
      // two carriageways cross, and the criss-cross hatching inside it. Each
      // stripe is the chord of the square at its distance from the centre,
      // so the hatching meets the border all the way round.
      into = yellow;
      const H = ROAD_HALF - 0.25;
      for (const x0 of STREETS) {
        for (const z0 of STREETS) {
          if (r(x0, z0, 97) > 0.22) continue;
          for (const s of [-1, 1]) {
            quad(true, z0 + s * H, x0, 0.15, 2 * H + 0.15);
            quad(true, z0, x0 + s * H, 2 * H + 0.15, 0.15);
          }
          for (const turn of [Math.PI / 4, -Math.PI / 4]) {
            const c = Math.cos(turn), sn = Math.sin(turn);
            for (let o = -(H * Math.SQRT2 - 0.35); o <= H * Math.SQRT2 - 0.35; o += 0.85) {
              const len = 2 * (H * Math.SQRT2 - Math.abs(o)) - 0.3;
              if (len < 0.4 || r(x0 + o * 5, z0 + turn, 102) < 0.1) continue;
              quad(true, z0 + o * c, x0 + o * sn, 0.12, len, turn);
            }
          }
        }
      }
      into = white;

      for (const [buf, material] of [[white, mat], [yellow, yellowMat]]) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;      // or the paint glows in a building's shade
        mesh.userData.tint = [1, 1, 1];
        mesh.userData.mottle = 0.14;
        gr.add(mesh);
      }
    });
  }

  /**
   * A cable slung between two streetlights.
   *
   * Nothing in this city curves. A sagging wire across a street is six thin
   * boxes and it is the only line in the skyline that is not vertical or
   * horizontal, which is worth more than its triangle count suggests.
   */
  function cable(gr, a, b, metal) {
    const UP = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3(), q = new THREE.Vector3(), dir = new THREE.Vector3();
    const segs = 6;
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const sag = 0.7 + span * 0.045;
    const at = (t, out) => out.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * sag,
      a.z + (b.z - a.z) * t);

    for (let k = 0; k < segs; k++) {
      at(k / segs, p); at((k + 1) / segs, q);
      const len = p.distanceTo(q);
      const m = new THREE.Mesh(boxGeo(0.075, len, 0.075, TILE.metal), metal);
      m.position.copy(p).lerp(q, 0.5);
      m.quaternion.setFromUnitVectors(UP, dir.copy(q).sub(p).normalize());
      gr.add(m);
    }
  }

  /**
   * A wrecked car.
   *
   * The shape of it is in `carShapes`; what is here is the bookkeeping that
   * let the shape change. Every mesh is an `Object3D` and costs four draws of
   * the seeded stream, so the seven boxes this used to be built from were
   * part of where the *next* prop stands — rebuilding it out of profiles
   * would have moved every city. So the parts are minted inside `reserve` and
   * the old bill is paid here on purpose: a group, then the paint roll, then
   * three panels, then the burn roll, then four wheels, in that order,
   * because the values each roll receives depend on how many draws came
   * before it. `a seed still lays out the city it did` is what notices if
   * this ever stops adding up.
   */
  function wreckedCar(g, w, x, z, rot, metal, glass) {
    spend(UUID_COST);                                     // the group
    // the branch still draws exactly one number either way, so the seeded
    // stream — and every city it lays out — is unchanged by the palette
    const bodyMat = Math.random() < 0.5
      ? carRustMats[Math.floor(hash2(Math.round(x), Math.round(z), 21) * carRustMats.length)]
      : pick(carBodyMats);
    spend(3 * 2 * UUID_COST);                             // three panels
    const burnt = Math.random() < 0.4;
    if (!burnt) spend(4 * 2 * UUID_COST);                 // four wheels
    const yaw = rot + randRange(-0.12, 0.12);
    const roll = burnt ? 0 : randRange(-0.03, 0.03);

    const bw = 1.9, bl = 4.4;
    const paint = tintAt(x, z, 4, 0.16);
    // which silhouette, from where it is parked, so it costs no stream
    const set = shapes.cars[hash2(Math.round(x), Math.round(z), 31) < 0.42 ? 'pickup' : 'saloon'];

    const built = reserve(() => {
      const car = new THREE.Group();
      const add = (geo, mat, tint) => {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = m.receiveShadow = true;
        if (tint) m.userData.tint = tint;
        car.add(m);
        return m;
      };

      // A burnt-out shell keeps its pillars and loses its glass, so the
      // greenhouse is the same shape in charred steel. It used to be hidden
      // instead — and left in `world.solids`, where bullets went on stopping
      // in the air above the wreck.
      const body = add(set.panels, burnt ? burntMat : bodyMat, burnt ? null : paint);
      const cabin = add(set.cabin, burnt ? burntMat : glass);
      add(set.trim, burnt ? burntMat : metal);
      add(set.wheels, tireMat);

      return { car, body, cabin };
    });

    // A burnt shell sits on its rims; the roof stays at the collider's height,
    // so it does not drop the body — it used to, by 0.2 m, which put the roof
    // of a burnt car at 1.62 m over a 1.5 m collider.
    built.car.position.set(x, 0, z);
    built.car.rotation.y = yaw;
    built.car.rotation.z = roll;
    g.add(built.car);

    w.addRotatedBox(x, z, bw / 2, bl / 2, yaw, 1.5);
    w.solids.push(built.body, built.cabin);
  }

  function barricade(g, w, x, z, rot, conc) {
    const n = 2 + (Math.random() * 2 | 0);
    for (let k = 0; k < n; k++) {
      spend(2 * UUID_COST);                       // what a slab used to cost
      const off = (k - (n - 1) / 2) * 2.3;
      const px = x + Math.cos(rot) * off, pz = z + Math.sin(rot) * off;
      const ry = rot + Math.PI / 2 + randRange(-0.08, 0.08);
      const m = reserve(() => new THREE.Mesh(shapes.barrier, conc));
      m.position.set(px, 0, pz);                  // the profile stands on the ground
      m.rotation.y = ry;
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(px, pz, 7, 0.1);
      g.add(m);
      w.solids.push(m);
      // 2.2 x 0.7 m of slab, turned. It used to register a 2.2 m square
      // whatever its angle — three times the footprint, so three quarters of
      // a metre of nothing stopped you either side of every barrier.
      w.addRotatedBox(px, pz, 1.1, 0.35, ry, 1.05);
    }
  }

  /**
   * Build a free-standing prop, then find it somewhere to stand.
   *
   * Every prop used to go down exactly where its rolls put it, on the
   * street's own level, with nothing asked of where that was: a container
   * through the plaza's fountain on every pinned seed, cars and barriers in
   * one another, every prop rolled past the last lot half inside the
   * perimeter wall (the kerb there is a metre from it, so that street does
   * not exist), and anything on a pavement, the plaza or a lot's slab sunk
   * into it by the slab's height.
   *
   * So the prop is built where it was rolled — its rolls and its `spend`
   * exactly as they always were — and then the colliders it registered are
   * read back as its footprint, and the nearest offset is found, on a half
   * metre grid out to `reach`, where that footprint is inside the sector,
   * clear of every collider already standing, and level: one floor height
   * under every corner, so nothing straddles a kerb. Everything it built is
   * moved there and lifted onto that floor. If there is nowhere, it is taken
   * back out — after its rolls were spent, so the stream never knows.
   *
   * A prop made of separate pieces — a barricade's row of slabs, one mesh
   * and one collider each — passes `parts`, and each piece is asked for its
   * own level and lifted onto its own floor, so a row can step off a kerb.
   *
   * @returns {{ made: *, dx: number, dz: number, y: number } | null}
   */
  function settle(g, w, reach, build, parts = false) {
    const c0 = g.children.length, b0 = w.boxes.length, s0 = w.solids.length;
    const made = build();
    const mine = w.boxes.slice(b0);
    const spot = findSpot(w, b0, mine, reach, parts);
    if (!spot) {
      for (const o of g.children.slice(c0)) g.remove(o);
      w.boxes.length = b0;
      w.solids.length = s0;
      return null;
    }
    const { dx, dz, y, ys } = spot;
    const id = ++settled;
    g.children.slice(c0).forEach((o, i) => {
      o.position.x += dx; o.position.y += parts ? ys[i] : y; o.position.z += dz;
      o.traverse((c) => { c.userData.prop = id; });
    });
    mine.forEach((b, i) => {
      b.cx += dx; b.minX += dx; b.maxX += dx;
      b.cz += dz; b.minZ += dz; b.maxZ += dz;
      b.top += parts ? ys[i] : y;
      b.prop = id;                                   // which prop, for a check that asks
    });
    return { made, dx, dz, y };
  }

  /** The top of the highest slab drawn under (x, z), or the street's 0. */
  function floorAt(x, z) {
    let y = 0;
    for (const f of floors) {
      const { width, height, depth } = f.geometry.parameters, p = f.position;
      if (Math.abs(x - p.x) <= width / 2 && Math.abs(z - p.z) <= depth / 2) y = Math.max(y, p.y + height / 2);
    }
    return y;
  }

  function findSpot(w, b0, mine, reach, parts) {
    const lim = w.bounds - 0.3, GAP = 0.2;
    for (const [dx, dz] of settleOffsets(reach)) {
      let y = null, ok = true;
      const ys = [];
      for (const m of mine) {
        if (parts) y = null;
        if (Math.abs(m.minX + dx) > lim || Math.abs(m.maxX + dx) > lim
          || Math.abs(m.minZ + dz) > lim || Math.abs(m.maxZ + dz) > lim) { ok = false; break; }
        // level: the same floor under the middle and every corner, with a
        // hand's breadth to spare, so nothing is left teetering on a kerb
        const cs = footCorners(m, dx, dz, 0.05);
        for (const [x, z] of [[m.cx + dx, m.cz + dz], ...cs]) {
          const f = floorAt(x, z);
          if (y === null) y = f;
          else if (Math.abs(f - y) > 0.01) { ok = false; break; }
        }
        if (!ok) break;
        ys.push(y ?? 0);
        // clear of everything standing, by a hand's width
        for (let k = 0; k < b0 && ok; k++) {
          const b = w.boxes[k];
          if (b.top <= STEP_UP || b.floor) continue;
          if (m.maxX + dx < b.minX - GAP || m.minX + dx > b.maxX + GAP
            || m.maxZ + dz < b.minZ - GAP || m.minZ + dz > b.maxZ + GAP) continue;
          if (footOverlap(m, dx, dz, b, GAP)) ok = false;
        }
        if (!ok) break;
      }
      if (ok) return { dx, dz, y: y ?? 0, ys };
    }
    return null;
  }

  function container(g, w, x, z, rot) {
    const cw = 2.5, ch = 2.6, cd = 6.0;
    spend(2 * UUID_COST);                         // what the box used to cost
    const m = reserve(() => new THREE.Mesh(shapes.container, rustFor(x, z)));
    m.position.set(x, 0, z);
    m.rotation.y = rot;
    m.castShadow = m.receiveShadow = true;
    m.userData.tint = tintAt(x, z, 2, 0.16);
    g.add(m);
    w.addRotatedBox(x, z, cw / 2, cd / 2, rot, ch);
    w.solids.push(m);
  }

  function fireBarrel(g, w, x, z) {
    spend(2 * UUID_COST);                         // what the drum used to cost
    const drum = reserve(() => new THREE.Mesh(shapes.drum, rustFor(x, z)));
    drum.userData.tint = tintAt(x, z, 2, 0.16);
    drum.position.set(x, 0, z);
    drum.castShadow = true;
    g.add(drum);
    w.addBox(x - 0.45, z - 0.45, x + 0.45, z + 0.45, 1.05);

    const light = new THREE.PointLight(0xff7a26, 2.4, 14, 2);
    light.position.set(x, 1.5, z);
    g.add(light);

    const flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.particleSprite('#ffb04a'), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.9,
    }));
    flame.scale.set(1.1, 1.6, 1);
    flame.position.set(x, 1.35, z);
    g.add(flame);

    return { light, flame, base: 2.4, phase: Math.random() * 10 };
  }

  function rubblePile(g, x, z, conc, scale = 1) {
    const geo = new THREE.IcosahedronGeometry(randRange(0.5, 1.1) * scale, 0);
    const m = new THREE.Mesh(geo, conc);
    m.userData.tint = tintAt(x, z, 10, 0.2);
    m.position.set(x, randRange(0.05, 0.3) * scale, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.y = randRange(0.35, 0.7);
    m.receiveShadow = m.castShadow = true;
    g.add(m);
    heaps.push(m);
  }
}
