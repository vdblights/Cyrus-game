import * as THREE from 'three';
import { makeRandom } from './rng.js';

/**
 * Procedural canvas textures. The game ships no binary assets, so every
 * surface in the city is painted here at boot and cached by key.
 *
 * Two things are worth knowing before changing anything in here.
 *
 * **Every tile declares the world size it covers.** A texture only reads
 * correctly at one density, and the geometry has to be told which. `TILE`
 * below is the contract: `city.js` scales its UVs so one copy of the image
 * spans that many metres, so the numbers here and the numbers there cannot
 * drift apart. The ground used to stretch a single 512px asphalt tile over
 * 54 m — nine pixels to the metre — and read as brown mud.
 *
 * **Painting draws on its own generator, not the global one.** Each builder
 * runs with `Math.random` swapped for a stream seeded off the texture's cache
 * key, so a texture looks the same in every city, two variants of one style
 * are reliably different from each other, and no amount of painting shifts
 * the seeded stream the city is laid out from.
 */

const cache = new Map();

/**
 * World size, in metres, that one copy of each tile covers. Texel density
 * follows: a 512px tile over 8 m is 64 px/m, which is about the point where
 * a surface stops reading as a photograph of itself from walking distance.
 */
export const TILE = {
  asphalt: 8,
  concrete: 4,
  facade: 10,      // 3 floors and 4 window bays, so a floor is 3.33 m
  rust: 2.5,
  metal: 2,
  glass: 4,
  // A wheel is one tile carrying two surfaces — see `tire`. 1.2 m puts a
  // 0.42 m wheel's tread in the bottom quarter and its hub in the middle.
  rubber: 1.2,
  // Cloth, webbing and plate on a hostile. A torso is half a metre across, so
  // the weave has to be small or a jacket reads as a tarpaulin.
  kit: 0.9,
  // A dropped case is looked at from a metre away: one tile covers it, so the
  // stencil lands on the lid once rather than repeating across it.
  crate: 0.5,
  // Road paint is shape, not pattern: the geometry of a dash *is* the dash,
  // and this tile only carries how worn it is. 2 m across a 512 tile puts
  // 256 px/m on a line 0.14 m wide, so the wear reads at walking distance.
  paint: 2,
  // The gun is the one surface always within arm's reach, so its tiles are
  // small: 0.3 m across a 512 tile is 1,700 px/m, against 64 for the road.
  gunPoly: 0.3,
  gunMetal: 0.36,
  // The hands holding it, at the same distance: a glove's weave at 0.25 m a
  // tile, and the sleeve behind it at the kit's own scale.
  glove: 0.25,
  // Street ironwork and the paving at a crossing, each one tile across the
  // thing: a 0.74 m cover drawn in the middle of a 0.8 m tile, a gully grate,
  // and blister paving whose 7 cm studs need the small tile to be studs.
  cover: 0.8,
  grate: 0.6,
  tactile: 0.8,
  // A fire escape's bar grating, and the balusters of its railings: a 3 cm
  // bar pitch wants 512 px/m, and a baluster every 12.5 cm a quarter of that.
  grating: 0.5,
  railing: 1.0,
  // What a hostile drops, each tile laid out for the one part it covers: an
  // ammunition can's long side carries its stencil once, a medical case its
  // moulding, a grenade's body the yellow band round its shoulder.
  ammoCan: 0.5,
  medCase: 0.5,
  frag: 0.25,
};

/** Windows per facade tile. `city.js` snaps wall UVs to these. */
export const FACADE_BAYS = 4;
export const FACADE_FLOORS = 3;

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** FNV-1a, so a cache key gives a texture its own repeatable grain. */
function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const rr = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;

function noise(ctx, size, amount, alpha) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
    if (alpha !== undefined) d[i + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Small flecks — rust spots, chipped paint. Each is a cluster of uneven,
 * offset blobs rather than one ellipse: a single filled ellipse is a coin,
 * and a sheet of them reads as a pattern, not as corrosion.
 */
function splotches(ctx, size, count, color, rMin, rMax) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = rMin + Math.random() * (rMax - rMin);
    const parts = 3 + (Math.random() * 4 | 0);
    for (let k = 0; k < parts; k++) {
      const a = Math.random() * Math.PI * 2, off = r * Math.random() * 0.8;
      const pr = r * (0.25 + Math.random() * 0.5);
      ctx.globalAlpha = 0.45 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * off, y + Math.sin(a) * off, pr, pr * (0.4 + Math.random() * 0.8),
        Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Draw soft, large shapes cheaply.
 *
 * A canvas `filter` blur is applied per draw call over the whole clip, so
 * ninety blurred blobs on a 1024px tile is ninety full-canvas convolutions —
 * it took five seconds a facade and most of a minute to boot. Painting the
 * same blobs into a small layer and letting the upscale do the smoothing is
 * the same picture for a fraction of a millisecond, because low-frequency
 * detail has no business being drawn at full resolution in the first place.
 */
function softLayer(ctx, size, draw, detail = 96) {
  const layer = canvas(detail);
  const lctx = layer.getContext('2d');
  lctx.scale(detail / size, detail / size);
  draw(lctx);
  ctx.drawImage(layer, 0, 0, size, size);
}

/**
 * Fractal value noise that wraps every `period` lattice cells at its first
 * octave, so a field built from it tiles. Returns f(u, v) over u, v in 0..1
 * (anything outside wraps), normalised to 0..1. The lattices are drawn from
 * `Math.random`, which inside a builder is the texture's own generator
 * (`paint`), so it costs the layout nothing.
 *
 * Written flat, because it runs a few hundred thousand times per stain layer
 * and the painter's budget is the boot time.
 */
function wrapFbm(period, octaves) {
  const lat = [], per = [], amp = [];
  let norm = 0;
  for (let k = 0; k < octaves; k++) {
    const p = period << k, v = new Float32Array(p * p);
    for (let i = 0; i < v.length; i++) v[i] = Math.random();
    lat.push(v); per.push(p); amp.push(0.5 ** k); norm += 0.5 ** k;
  }
  return (u, v) => {
    u -= Math.floor(u); v -= Math.floor(v);
    let t = 0;
    for (let k = 0; k < octaves; k++) {
      const p = per[k], L = lat[k];
      const x = u * p, y = v * p;
      const x0 = x | 0, y0 = y | 0;
      let fx = x - x0, fy = y - y0;
      fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);      // quintic: no lattice creases
      fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      const x1 = x0 + 1 === p ? 0 : x0 + 1, r0 = y0 * p, r1 = (y0 + 1 === p ? 0 : y0 + 1) * p;
      const a = L[r0 + x0], b = L[r0 + x1], c = L[r1 + x0], d = L[r1 + x1];
      t += ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * amp[k];
    }
    return t / norm;
  };
}

/**
 * Weathering that wraps at the tile edge: stains, washes, blooms.
 *
 * Tiling is given away by the eye finding the same *large* shape twice, so
 * every surface carries something at a scale bigger than its grain. This used
 * to be `count` filled ellipses, which upscaled soft but stayed discs — and a
 * field of soft discs is polka dots, on every barrier, every container and
 * the whole plaza. Real grime is fractal: ragged at the edge, uneven inside,
 * and present at every size at once. So this thresholds a domain-warped
 * fractal noise field instead, keeping the arguments it always took: `count`
 * and the radii set how much of the tile is stained (what the discs used to
 * cover) and how big the patches run, and `color` is the stain.
 */
export function mottle(ctx, size, count, color, rMin, rMax) {
  const m = /rgba?\(([^,]+),([^,]+),([^,]+)(?:,([^)]+))?\)/.exec(color);
  const rgb = [+m[1], +m[2], +m[3]], alpha = m[4] === undefined ? 1 : +m[4];
  const r = (rMin + rMax) / 2;
  const cover = Math.min(0.62, Math.max(0.12, (count * Math.PI * r * r) / (size * size)));
  const period = Math.max(2, Math.min(24, Math.round(size / (r * 2.6))));
  const shape = wrapFbm(period, 4);
  const warp = wrapFbm(Math.max(2, period >> 1), 2);
  const warp2 = wrapFbm(Math.max(2, period >> 1), 2);
  const body = wrapFbm(period * 2, 2);
  // a fifth of the tile's resolution is enough for something this soft, and
  // the painter's budget is the boot time
  const detail = Math.max(64, Math.min(160, Math.round(size / 5)));
  const layer = canvas(detail), lctx = layer.getContext('2d');
  const img = lctx.createImageData(detail, detail), d = img.data;
  const field = new Float32Array(detail * detail);
  const w = 0.55 / period;                          // warp reach, in tile units
  for (let y = 0; y < detail; y++) {
    for (let x = 0; x < detail; x++) {
      const u = x / detail, v = y / detail;
      field[y * detail + x] = shape(u + (warp(u, v) - 0.5) * w * 2, v + (warp2(u, v) - 0.5) * w * 2);
    }
  }
  // threshold at the quantile that stains `cover` of the tile
  const sorted = Float32Array.from(field).sort();
  const t = sorted[Math.floor((1 - cover) * (sorted.length - 1))];
  const soft = 0.035;
  for (let i = 0; i < field.length; i++) {
    const e = Math.min(1, Math.max(0, (field[i] - t + soft) / (soft * 2)));
    const edge = e * e * (3 - 2 * e);
    const x = i % detail, y = (i / detail) | 0;
    const inside = 0.55 + 0.45 * body(x / detail, y / detail);
    d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2];
    d[i * 4 + 3] = Math.round(255 * alpha * edge * inside);
  }
  lctx.putImageData(img, 0, 0);
  ctx.drawImage(layer, 0, 0, size, size);
}

/** Speckle: the chips of aggregate that stop a flat fill reading as plastic. */
function grit(ctx, size, count, light, dark, rMax = 1.9) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = 0.5 + Math.random() * rMax;
    ctx.fillStyle = Math.random() < 0.5
      ? `rgba(${light},${0.04 + Math.random() * 0.16})`
      : `rgba(${dark},${0.08 + Math.random() * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

/** A wandering crack, thinning as it runs, wrapping through the tile edge. */
function crack(ctx, size, x, y, len, width, color) {
  ctx.strokeStyle = color;
  let a = Math.random() * Math.PI * 2;
  const steps = 5 + (Math.random() * 5 | 0);
  for (let i = 0; i < steps; i++) {
    const nx = x + Math.cos(a) * (len / steps), ny = y + Math.sin(a) * (len / steps);
    ctx.lineWidth = width * (1 - i / steps * 0.7);
    ctx.beginPath();
    ctx.moveTo(((x % size) + size) % size, ((y % size) + size) % size);
    ctx.lineTo(((nx % size) + size) % size, ((ny % size) + size) % size);
    ctx.stroke();
    x = nx; y = ny;
    a += rr(-0.9, 0.9);
  }
}

/** Dark runoff bleeding downward from `y`, the single most useful grime. */
function runoff(ctx, x, y, w, len, color, alpha) {
  const g = ctx.createLinearGradient(0, y, 0, y + len);
  g.addColorStop(0, `rgba(${color},${alpha})`);
  g.addColorStop(0.35, `rgba(${color},${alpha * 0.55})`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, len);
}

/**
 * Paint a builder's canvas on a generator of its own.
 *
 * The global `Math.random` is seeded and its draw order decides the city
 * layout (see `rng.js`), so painting must not spend it. Swapping it here also
 * means a texture's grain depends only on its key: `facade(2, 1)` is the same
 * wall in every city, and reliably a different wall from `facade(2, 0)`.
 */
function paint(key, builder) {
  const saved = Math.random;
  Math.random = makeRandom(hashKey(key));
  try {
    return builder();
  } finally {
    Math.random = saved;
  }
}

function make(key, builder, repeat = [1, 1], colorSpace = THREE.SRGBColorSpace) {
  if (cache.has(key)) return cache.get(key);
  const tex = new THREE.CanvasTexture(paint(key, builder));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 8;
  tex.colorSpace = colorSpace;      // normal maps carry vectors, not colour
  cache.set(key, tex);
  return tex;
}

/* ------------------------------------------------------------------ ground */

/**
 * Cracked asphalt. One tile is 8 m of road, so the aggregate is at the size
 * it would really be and the cracks run a believable distance.
 *
 * No lane markings: they are painted here only once, so at any tiling they
 * come out as a grid of stripes across the whole sector rather than a line
 * down a street. Road paint belongs on the roads, as its own geometry —
 * `roadMarkings` in `city.js`, wearing `roadPaint` below.
 */
export function asphalt(variant = 0) {
  return make('asphalt' + variant, () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#46464b';
    ctx.fillRect(0, 0, s, s);

    // laying seams and the patches of a road repaired for decades
    mottle(ctx, s, 14, 'rgba(33,32,36,0.40)', 40, 130);
    mottle(ctx, s, 10, 'rgba(96,92,85,0.18)', 30, 110);
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.translate(rr(0, s), rr(0, s));
      ctx.rotate(Math.random() * Math.PI);
      ctx.fillStyle = `rgba(30,29,33,${rr(0.35, 0.6)})`;
      ctx.fillRect(-rr(30, 90), -rr(20, 55), rr(60, 180), rr(40, 110));
      ctx.restore();
    }

    grit(ctx, s, 5200, '164,160,150', '20,19,22', 2.3);

    // cracks, and the wider fissures that run with the crown of the road
    for (let i = 0; i < 22; i++) {
      crack(ctx, s, rr(0, s), rr(0, s), rr(60, 180), rr(0.7, 2.1), 'rgba(22,22,25,0.85)');
    }
    for (let i = 0; i < 6; i++) {
      crack(ctx, s, rr(0, s), rr(0, s), rr(180, 420), rr(2, 3.6), 'rgba(18,18,21,0.7)');
    }

    // Potholes: a dark pit inside a lighter rim of broken edge. Both are
    // ragged polygons, not ellipses — a filled oval repeated every 8 m of road
    // read as a row of identical black discs, which no road has ever had.
    // The rim is the same outline pushed out, so the broken edge follows the
    // pit's own shape.
    const ragged = (x, y, r, squash, turn, grow) => {
      const n = 11 + ((r * 7) | 0) % 6;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rad = r * grow * (0.62 + 0.38 * Math.sin(a * 3 + turn) * 0.5 + rr(0.15, 0.55));
        const px = Math.cos(a) * rad, py = Math.sin(a) * rad * squash;
        const c = Math.cos(turn), sn = Math.sin(turn);
        const qx = x + px * c - py * sn, qy = y + px * sn + py * c;
        if (k === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.fill();
    };
    for (let i = 0; i < 5; i++) {
      const x = rr(0, s), y = rr(0, s), r = rr(6, 20), squash = rr(0.55, 0.95), turn = rr(0, 6.28);
      ctx.fillStyle = 'rgba(120,115,106,0.28)';
      ragged(x, y, r, squash, turn, 1.35);
      ctx.fillStyle = 'rgba(14,14,16,0.72)';
      ragged(x, y, r, squash, turn, 0.95);
      // gravel kicked out of it
      ctx.fillStyle = 'rgba(30,29,32,0.6)';
      for (let k = 0; k < 9; k++) {
        ctx.fillRect(x + rr(-r * 1.8, r * 1.8), y + rr(-r * 1.4, r * 1.4), rr(1, 2.6), rr(1, 2.6));
      }
    }

    // oil and ash, dark and soft-edged
    mottle(ctx, s, 8, 'rgba(16,14,14,0.24)', 8, 34);

    // wind-drifted dust, which is what keeps the street from reading as new
    mottle(ctx, s, 8, 'rgba(176,150,112,0.13)', 50, 140);

    noise(ctx, s, 22);
    return c;
  });
}

/** Pitted sidewalk / plaza concrete, slabbed at roughly 1.3 m. */
/**
 * A heap of rubble seen close: broken concrete in lumps, a few brick ends,
 * and dark gaps between them where the light does not get in.
 *
 * Painted back to front — a layer of small pieces, then larger ones over
 * them, each an irregular polygon with a shadow under its lower edge and a
 * lit upper edge — so it reads as a pile rather than a pattern. Every piece
 * near a tile edge is drawn again across it, so the tile wraps. 4 m a tile,
 * the concrete's, so a piece is 4 to 30 cm.
 */
export function debris() {
  return make('debris', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#3b3733';             // the gaps
    ctx.fillRect(0, 0, s, s);
    const greys = ['#6f6c67', '#67645f', '#77746d', '#5f5c57', '#7d7a72', '#6b6660'];
    const bricks = ['#7a4a38', '#6b3f30', '#86553f'];
    const piece = (x, y, r) => {
      const n = 4 + Math.floor(rr(0, 4)), a0 = rr(0, Math.PI * 2), pts = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2 + rr(-0.35, 0.35), d = r * rr(0.55, 1.15);
        pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d * rr(0.6, 1)]);
      }
      const fill = chance(0.12) ? bricks[Math.floor(rr(0, bricks.length))] : greys[Math.floor(rr(0, greys.length))];
      for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
        if (x + ox + r * 1.2 < 0 || x + ox - r * 1.2 > s || y + oy + r * 1.2 < 0 || y + oy - r * 1.2 > s) continue;
        const path = () => {
          ctx.beginPath();
          pts.forEach(([px, py], i) => (i ? ctx.lineTo(px + ox, py + oy) : ctx.moveTo(px + ox, py + oy)));
          ctx.closePath();
        };
        // the shadow it casts on what is under it, then the piece, then its
        // lit top edge
        ctx.save(); ctx.translate(r * 0.12, r * 0.18); path();
        ctx.fillStyle = 'rgba(20,16,12,0.34)'; ctx.fill(); ctx.restore();
        path(); ctx.fillStyle = fill; ctx.fill();
        ctx.save(); ctx.clip();
        const g = ctx.createLinearGradient(0, y + oy - r, 0, y + oy + r);
        g.addColorStop(0, 'rgba(255,250,240,0.09)');
        g.addColorStop(0.45, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.18)');
        ctx.fillStyle = g; ctx.fillRect(x + ox - r * 1.3, y + oy - r * 1.3, r * 2.6, r * 2.6);
        ctx.restore();
      }
    };
    for (let k = 0; k < 900; k++) piece(rr(0, s), rr(0, s), rr(3, 9));
    for (let k = 0; k < 260; k++) piece(rr(0, s), rr(0, s), rr(8, 20));
    for (let k = 0; k < 40; k++) piece(rr(0, s), rr(0, s), rr(18, 34));
    mottle(ctx, s, 14, 'rgba(40,32,24,0.22)', 10, 40);
    grit(ctx, s, 3000, '220,214,204', '0,0,0', 1.2);
    noise(ctx, s, 18);
    return c;
  });
}

export function concrete(tint = '#6d6b6d', variant = 0) {
  return make('concrete' + tint + '_' + variant, () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    const slab = s / 3;            // 4 m tile, so slabs land near 1.33 m
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, s, s);

    // every slab poured on a different day and weathered on its own
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(gx * slab, gy * slab, slab, slab);
        ctx.clip();
        ctx.fillStyle = `rgba(${chance(0.5) ? '255,255,255' : '0,0,0'},${rr(0.02, 0.07)})`;
        ctx.fillRect(gx * slab, gy * slab, slab, slab);
        if (chance(0.3)) {          // a slab patched with fresher mix
          ctx.fillStyle = `rgba(150,148,142,${rr(0.06, 0.14)})`;
          ctx.beginPath();
          ctx.ellipse(gx * slab + rr(20, slab - 20), gy * slab + rr(20, slab - 20),
            rr(18, 48), rr(16, 40), rr(0, 3), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    mottle(ctx, s, 16, 'rgba(0,0,0,0.13)', 20, 70);
    mottle(ctx, s, 10, 'rgba(255,255,255,0.05)', 18, 60);
    grit(ctx, s, 2600, '236,234,228', '0,0,0', 1.5);

    // spalled edges: concrete fails at its corners first
    for (let i = 0; i < 26; i++) {
      const onX = chance(0.5);
      const line = slab * (1 + (chance(0.5) ? 0 : 1));
      const along = rr(0, s);
      ctx.fillStyle = `rgba(0,0,0,${rr(0.10, 0.26)})`;
      ctx.beginPath();
      ctx.ellipse(onX ? line : along, onX ? along : line, rr(3, 11), rr(2, 7), rr(0, 3), 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < 9; i++) crack(ctx, s, rr(0, s), rr(0, s), rr(40, 130), rr(0.5, 1.4), 'rgba(0,0,0,0.38)');

    // the joints themselves: a dark line with a lit lip on one side
    ctx.strokeStyle = 'rgba(0,0,0,0.40)';
    ctx.lineWidth = 2.5;
    for (let i = slab; i < s; i += slab) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1.5;
    for (let i = slab; i < s; i += slab) {
      ctx.beginPath(); ctx.moveTo(i + 2, 0); ctx.lineTo(i + 2, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i + 2); ctx.lineTo(s, i + 2); ctx.stroke();
    }

    // drifted ash gathering along the joints
    mottle(ctx, s, 7, 'rgba(150,128,96,0.10)', 30, 90);
    noise(ctx, s, 18);
    return c;
  });
}

/* ------------------------------------------------------------------ facade */

/**
 * Where a window sits inside its bay and storey, as fractions: width of the
 * bay, height of the storey, and how far down from the top of the storey the
 * opening starts. The painter lays windows out by these and the facade shader
 * cuts the openings by them, so there is one definition of where a window is.
 */
export const WINDOW = { w: 0.58, h: 0.5, top: 0.30 };
export const WINDOW_GLASS = 0, WINDOW_BROKEN = 1, WINDOW_BOARDED = 2;
const WINDOW_STATES = new Map();

/**
 * What is in each of a facade's twelve windows, storey by storey from the
 * top and bay by bay from the left, as the painter rolled them.
 */
export function facadeWindows(style = 0, variant = 0) {
  facade(style, variant);
  return WINDOW_STATES.get('facade' + style + '_' + variant);
}

const FACADE_STYLES = [
  { name: 'panel', base: '#5e584e', trim: '#6a6459' },
  { name: 'brick', base: '#6b4f42', trim: '#7d6a58' },
  { name: 'office', base: '#4e535a', trim: '#5c636b' },
  { name: 'render', base: '#7a6a58', trim: '#8a7a66' },
  { name: 'stone', base: '#5c5d60', trim: '#6b6c70' },
];

/** Shift a hex colour by a small amount per channel, for variant drift. */
function jitter(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v + rr(-amount, amount)))));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/**
 * Building facade: four window bays and three floors over a 10 m tile, so a
 * window is about 1.5 m across and a floor 3.3 m — the sizes that make a box
 * read as a building rather than as a box with a pattern on it.
 *
 * `style` picks the wall material, `variant` re-rolls the whole face: colour,
 * window states, which bays are blown out, how the damage runs. Every style
 * gets several, because one texture per style meant every building of a kind
 * was the same building, and that is what the eye picks up first.
 */
/**
 * A style's wall with no windows and no floor lines: the brick, the render,
 * the stone or the panels a building is built of, where its openings are
 * real (`upperFloors` in `city.js`) and a painted one would be a second
 * window beside each hole.
 */
export function infill(style = 0) {
  return facade(style, 0, true);
}

export function facade(style = 0, variant = 0, plain = false) {
  return make((plain ? 'infill' : 'facade') + style + '_' + variant, () => {
    const s = 1024, c = canvas(s), ctx = c.getContext('2d');
    const def = FACADE_STYLES[style % FACADE_STYLES.length];
    const floor = s / FACADE_FLOORS;
    const bay = s / FACADE_BAYS;
    const base = jitter(def.base, 14);

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    wallMaterial(ctx, s, def.name, def);

    // large-scale weathering, before anything structural sits on top of it
    mottle(ctx, s, 18, 'rgba(0,0,0,0.13)', 40, 150);
    mottle(ctx, s, 10, 'rgba(96,64,32,0.14)', 30, 120);   // rust wash
    mottle(ctx, s, 8, 'rgba(210,190,160,0.07)', 40, 140);

    // floor line: a spandrel band with a lit top edge and a shadowed underside
    for (let r = 0; r < (plain ? 0 : FACADE_FLOORS); r++) {
      const y = r * floor;
      ctx.fillStyle = jitter(def.trim, 10);
      ctx.fillRect(0, y, s, floor * 0.14);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, y, s, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.fillRect(0, y + floor * 0.14, s, 7);
    }

    const winW = bay * WINDOW.w, winH = floor * WINDOW.h;
    const states = [];
    for (let r = 0; r < (plain ? 0 : FACADE_FLOORS); r++) {
      for (let b = 0; b < FACADE_BAYS; b++) {
        const x = b * bay + (bay - winW) / 2;
        const y = r * floor + floor * WINDOW.top;
        states.push(window_(ctx, x, y, winW, winH, variant));
      }
    }
    if (!plain) WINDOW_STATES.set('facade' + style + '_' + variant, states);

    // damage that crosses the whole face: shell scars and bullet swarms
    for (let i = 0; i < 2 + (variant % 2); i++) blast(ctx, s, rr(0, s), rr(0, s));
    for (let i = 0; i < 34; i++) {
      const x = rr(0, s), y = rr(0, s), r = rr(1.6, 4.5);
      ctx.fillStyle = `rgba(190,186,176,${rr(0.10, 0.3)})`;
      ctx.beginPath(); ctx.arc(x, y, r * 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(20,18,18,${rr(0.3, 0.6)})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // vertical streaking over everything, which is what ties a dirty wall
    // together — grime runs past the windows, not around them
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * s;
      const g = ctx.createLinearGradient(x, 0, x, s);
      g.addColorStop(0, 'rgba(18,14,10,0)');
      g.addColorStop(Math.random(), `rgba(18,14,10,${rr(0.04, 0.13)})`);
      g.addColorStop(1, 'rgba(18,14,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1 + Math.random() * 6, s);
    }

    noise(ctx, s, 10);
    return c;
  });

  /** The wall itself: what the building is built out of, under the grime. */
  function wallMaterial(ctx, s, name, def) {
    if (name === 'brick') {
      const course = s / 46;                     // ~22 cm courses
      for (let y = 0; y < s; y += course) {
        const row = Math.round(y / course);
        ctx.fillStyle = `rgba(0,0,0,${rr(0.10, 0.18)})`;
        ctx.fillRect(0, y, s, 2.5);
        const off = row % 2 ? course * 1.1 : 0;
        for (let x = off; x < s; x += course * 2.2) {
          ctx.fillStyle = `rgba(0,0,0,${rr(0.08, 0.16)})`;
          ctx.fillRect(x, y, 2.5, course);
          // every brick fired a slightly different colour
          ctx.fillStyle = `rgba(${chance(0.5) ? '120,70,50' : '40,26,22'},${rr(0.03, 0.12)})`;
          ctx.fillRect(x + 2.5, y + 2.5, course * 2.2 - 2.5, course - 2.5);
        }
      }
    } else if (name === 'panel') {
      // precast panels, one per bay, with a recessed joint between
      const p = s / FACADE_BAYS;
      for (let x = 0; x < s; x += p) {
        ctx.fillStyle = `rgba(${chance(0.5) ? '255,255,255' : '0,0,0'},${rr(0.015, 0.05)})`;
        ctx.fillRect(x, 0, p, s);
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(x - 2, 0, 4, s);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 2, 0, 2, s);
      }
    } else if (name === 'stone') {
      const course = s / 14;
      for (let y = 0; y < s; y += course) {
        const row = Math.round(y / course);
        for (let x = (row % 2 ? course * 0.5 : 0); x < s; x += course * 1.6) {
          ctx.fillStyle = `rgba(${chance(0.5) ? '255,255,255' : '0,0,0'},${rr(0.02, 0.06)})`;
          ctx.fillRect(x, y, course * 1.6 - 3, course - 3);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(0, y, s, 3);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (let y = 0; y < s; y += course) {
        const row = Math.round(y / course);
        for (let x = (row % 2 ? course * 0.5 : 0); x < s; x += course * 1.6) ctx.fillRect(x - 3, y, 3, course);
      }
    } else if (name === 'office') {
      // ribbon bands of darker spandrel, the curtain-wall look
      const p = s / FACADE_BAYS;
      for (let x = 0; x < s; x += p) {
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.fillRect(x - 3, 0, 6, s);
        ctx.fillStyle = 'rgba(160,180,200,0.05)';
        ctx.fillRect(x + 3, 0, 3, s);
      }
    } else {
      // render: patchy stucco, with the coat failing to bare grey beneath
      mottle(ctx, s, 22, 'rgba(120,116,108,0.16)', 25, 90);
      mottle(ctx, s, 9, 'rgba(108,104,98,0.30)', 20, 70);
      ctx.fillStyle = jitter(def.trim, 8);
      for (let i = 0; i < 400; i++) {
        ctx.globalAlpha = rr(0.02, 0.08);
        ctx.fillRect(rr(0, s), rr(0, s), rr(2, 9), rr(2, 9));
      }
      ctx.globalAlpha = 1;
    }
  }

  /**
   * One opening: reveal, sill, lintel and whatever is left in the frame.
   * Returns what is in it — `WINDOW_GLASS`, `WINDOW_BROKEN` or
   * `WINDOW_BOARDED` — which the facade shader needs to know what to draw
   * behind the wall plane (`windows.js`).
   */
  function window_(ctx, x, y, w, h, variant) {
    // the reveal — the wall is thick, so the opening sits back inside it
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x - 5, y - 8, w + 10, 4);          // lintel, catching the sky

    const roll = Math.random();
    const broken = roll < (0.50 + variant * 0.06);
    const boarded = !broken && roll < 0.76;

    if (broken) {
      ctx.fillStyle = '#07070a';
      ctx.fillRect(x, y, w, h);
      // the room behind, barely: a back wall and a sliver of floor
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(${chance(0.5) ? '64,58,50' : '40,38,40'},${rr(0.12, 0.3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      // shards still in the frame
      ctx.fillStyle = 'rgba(158,172,180,0.38)';
      for (let k = 0; k < 4; k++) {
        const top = chance(0.6);
        ctx.beginPath();
        ctx.moveTo(x + rr(0, w), top ? y : y + h);
        ctx.lineTo(x + rr(0, w), top ? y + h * rr(0.15, 0.5) : y + h * rr(0.5, 0.85));
        ctx.lineTo(x + rr(0, w), top ? y : y + h);
        ctx.closePath();
        ctx.fill();
      }
      if (chance(0.4)) {            // fire licked out of this one
        const g2 = ctx.createLinearGradient(0, y, 0, y - h * 1.1);
        g2.addColorStop(0, 'rgba(10,8,6,0.68)');
        g2.addColorStop(1, 'rgba(10,8,6,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(x - w * 0.25, y - h * 1.1, w * 1.5, h * 1.1);
      }
    } else if (boarded) {
      ctx.fillStyle = '#2f281f';
      ctx.fillRect(x, y, w, h);
      for (let k = 0; k < 5; k++) {
        const by = y + 2 + k * (h / 5);
        ctx.save();
        ctx.translate(x + w / 2, by + h / 10);
        ctx.rotate(rr(-0.12, 0.12));
        const grain = rr(0, 1);
        ctx.fillStyle = `rgb(${66 + grain * 26 | 0},${52 + grain * 21 | 0},${36 + grain * 15 | 0})`;
        ctx.fillRect(-w / 2 - 4, -h / 14, w + 8, h / 7);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-w / 2 - 4, h / 14 - 2, w + 8, 2);
        ctx.restore();
      }
    } else {
      // glass: the sky sliding down it, and a lifetime of dirt on the inside
      const g = ctx.createLinearGradient(x, y, x + w * 0.5, y + h);
      g.addColorStop(0, 'rgba(164,184,204,0.58)');
      g.addColorStop(0.42, 'rgba(74,92,112,0.42)');
      g.addColorStop(1, 'rgba(24,30,40,0.6)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(30,26,22,0.22)';
      for (let k = 0; k < 5; k++) ctx.fillRect(x + rr(0, w), y, rr(1, 4), h);
      if (chance(0.35)) {           // a blind, half down
        ctx.fillStyle = 'rgba(190,182,166,0.5)';
        ctx.fillRect(x, y, w, h * rr(0.25, 0.7));
      }
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(x + w * 0.49, y, 3, h);          // mullion
      ctx.fillRect(x, y + h * 0.46, w, 3);
    }

    // frame: lit on top, dark inside
    ctx.strokeStyle = 'rgba(226,220,208,0.15)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, w, h);

    // sill, and the stain that has run off it since the sill was new
    ctx.fillStyle = 'rgba(255,255,255,0.11)';
    ctx.fillRect(x - 6, y + h, w + 12, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(x - 6, y + h + 5, w + 12, 4);
    if (chance(0.72)) runoff(ctx, x + rr(-4, 4), y + h + 9, w + rr(-10, 8), rr(30, 110), '22,17,12', rr(0.18, 0.4));
    if (chance(0.25)) runoff(ctx, x + rr(0, w), y + h + 9, rr(3, 10), rr(40, 130), '96,52,22', rr(0.16, 0.34));
    return broken ? WINDOW_BROKEN : boarded ? WINDOW_BOARDED : WINDOW_GLASS;
  }

  /** A shell hit: a crater of exposed structure, ringed with soot. */
  function blast(ctx, s, x, y) {
    const r = rr(24, 70);
    softLayer(ctx, s, (l) => {
      l.fillStyle = 'rgba(14,12,11,0.4)';
      l.beginPath(); l.arc(x, y, r * 1.6, 0, Math.PI * 2); l.fill();
    }, 128);
    ctx.fillStyle = 'rgba(28,25,22,0.8)';
    ctx.beginPath();
    for (let a = 0; a < 14; a++) {
      const ang = (a / 14) * Math.PI * 2, rad = r * rr(0.6, 1.1);
      ctx[a ? 'lineTo' : 'moveTo'](x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
    }
    ctx.closePath(); ctx.fill();
    // reinforcing bar left standing in the hole
    ctx.strokeStyle = 'rgba(120,92,62,0.55)';
    ctx.lineWidth = 2.5;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(x - r, y + rr(-r * 0.7, r * 0.7));
      ctx.lineTo(x + r, y + rr(-r * 0.7, r * 0.7));
      ctx.stroke();
    }
    for (let k = 0; k < 6; k++) crack(ctx, s, x, y, rr(40, 120), rr(1, 2.6), 'rgba(0,0,0,0.5)');
  }
}

/**
 * Variants per facade style. Each one is a full 1024px map plus a derived
 * normal and roughness, so this is the knob that trades texture memory for
 * how long it takes to notice the same building twice. Two across the five
 * styles is about 80 MB; the per-building tint and UV offset in `city.js` do
 * the rest of the work.
 */
export const FACADE_VARIANTS = 2;

/* ------------------------------------------------------------------- props */

/** Rusted corrugated sheet for shutters, container walls, barricades. */
export function rustMetal(variant = 0, sheet = false) {
  return make((sheet ? 'rustsheet' : 'rust') + variant, () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#6b4a33';
    ctx.fillRect(0, 0, s, s);

    // what is left of the paint, in the colour containers actually come in
    const paints = ['#3f5a4a', '#6d3b30', '#43506b', '#7a6a3c'];
    ctx.fillStyle = paints[variant % paints.length];
    ctx.fillRect(0, 0, s, s);
    // rust eating through the coat, in two oxides
    mottle(ctx, s, 40, 'rgba(138,80,40,0.62)', 6, 42);
    mottle(ctx, s, 34, 'rgba(92,54,30,0.55)', 6, 36);
    splotches(ctx, s, 60, 'rgba(168,112,58,0.30)', 3, 18);
    splotches(ctx, s, 40, 'rgba(38,26,18,0.45)', 3, 16);

    // A sheet worn by something whose folds are geometry — a container's
    // sides, a drum, a roller shutter — carries the paint failing and the
    // oxide running down it, and no painted folds or ribs: the light on a
    // real rib does that, and painted folds over it read as a second set at
    // another pitch.
    if (sheet) {
      for (let k = 0; k < 26; k++) {
        runoff(ctx, rr(0, s), rr(-20, s * 0.7), rr(3, 9), rr(40, 160), '84,44,20', rr(0.15, 0.4));
      }
      mottle(ctx, s, 12, 'rgba(0,0,0,0.18)', 10, 34);
      noise(ctx, s, 20);
      return c;
    }

    // corrugation: a lit face and a shaded face per fold, 12 cm apart
    const fold = s / 20;
    for (let x = 0; x < s; x += fold) {
      const g = ctx.createLinearGradient(x, 0, x + fold, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.34)');
      g.addColorStop(0.35, 'rgba(0,0,0,0)');
      g.addColorStop(0.65, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.30)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, fold, s);
    }

    // horizontal ribs, rivets, and the streaks running off both
    for (const y of [s * 0.08, s * 0.5, s * 0.92]) {
      ctx.fillStyle = 'rgba(0,0,0,0.26)';
      ctx.fillRect(0, y, s, 7);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, y - 3, s, 3);
      for (let x = fold / 2; x < s; x += fold * 2) {
        ctx.fillStyle = 'rgba(30,20,14,0.5)';
        ctx.beginPath(); ctx.arc(x, y + 3.5, 3.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(190,150,110,0.22)';
        ctx.beginPath(); ctx.arc(x - 0.8, y + 2.4, 2.1, 0, Math.PI * 2); ctx.fill();
        if (chance(0.5)) runoff(ctx, x - 2, y + 7, 4, rr(20, 70), '84,44,20', rr(0.2, 0.45));
      }
    }

    // dents and grime, which is what stops a flat sheet reading as a flat
    // sheet — shading, not spots
    mottle(ctx, s, 12, 'rgba(0,0,0,0.18)', 10, 34);

    noise(ctx, s, 20);
    return c;
  });
}

/**
 * Painted steel: poles, plant, rooftop units, car bodies.
 *
 * Deliberately near-white. It carries the scratches, the rust blooms and the
 * grime, and the material it is hung on carries the colour, so one texture
 * paints a streetlight grey and a wreck maroon instead of needing one each.
 */
export function paintedMetal() {
  return make('painted', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#a8adb3';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 14, 'rgba(0,0,0,0.16)', 12, 50);
    mottle(ctx, s, 8, 'rgba(140,96,54,0.28)', 8, 34);     // rust blooms
    // scratches down to bright metal
    for (let i = 0; i < 90; i++) {
      ctx.strokeStyle = `rgba(${chance(0.6) ? '188,194,200' : '28,26,26'},${rr(0.06, 0.24)})`;
      ctx.lineWidth = rr(0.4, 1.4);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(6, 40);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    grit(ctx, s, 700, '210,214,218', '18,18,20', 1.1);
    noise(ctx, s, 14);
    return c;
  });
}

/**
 * A car left out for a decade: faded paint, primer where it has flaked, and
 * rust eating through both.
 *
 * Half the wrecks used to wear `rustMetal`, which is a container's
 * corrugated sheet — a fold every 12 cm and a rivet line — so every rusted
 * car in the sector was ribbed like a shed. A car's panel is smooth; what a
 * decade does to it is take the paint off in patches, with a ring of grey
 * primer between the paint and the bare oxide. The paint colour is in the
 * texture rather than on the material, because the rust is not that colour.
 */
export function carRust(variant = 0) {
  return make('carrust' + variant, () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    const paints = ['#405560', '#62342b', '#7c735e', '#474c35'];
    ctx.fillStyle = paints[variant % paints.length];
    ctx.fillRect(0, 0, s, s);
    // sun-faded unevenly, chalky where it has oxidised
    mottle(ctx, s, 16, 'rgba(190,184,170,0.10)', 18, 70);
    mottle(ctx, s, 12, 'rgba(0,0,0,0.12)', 14, 56);
    // primer showing round the rust, then the rust inside it
    mottle(ctx, s, 22, 'rgba(104,102,98,0.50)', 10, 46);
    mottle(ctx, s, 20, 'rgba(104,54,24,0.82)', 8, 40);
    mottle(ctx, s, 14, 'rgba(62,32,16,0.70)', 6, 26);
    splotches(ctx, s, 70, 'rgba(150,86,40,0.45)', 2, 9);
    splotches(ctx, s, 50, 'rgba(40,22,14,0.5)', 1.5, 6);
    // streaks running down from every patch
    for (let i = 0; i < 40; i++) runoff(ctx, rr(0, s), rr(0, s), rr(2, 7), rr(18, 80), '96,52,24', rr(0.08, 0.24));
    for (let i = 0; i < 80; i++) {
      ctx.strokeStyle = `rgba(${chance(0.5) ? '196,190,182' : '30,22,18'},${rr(0.06, 0.22)})`;
      ctx.lineWidth = rr(0.5, 1.4);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(8, 50);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
    }
    grit(ctx, s, 1600, '200,192,180', '20,16,14', 1.3);
    noise(ctx, s, 12);
    return c;
  });
}

/**
 * A cast-iron manhole cover, drawn in the middle of its tile so a disc
 * unwrapped about the tile's centre lands on it: a worn frame ring, the
 * cover's own rim, and a field of raised studs that the traffic has polished
 * on top and the rain has rusted between.
 */
export function manhole() {
  return make('manhole', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    const R = (0.37 / TILE.cover) * s, r = (0.33 / TILE.cover) * s, m = s / 2;
    ctx.fillStyle = '#1c1b1a';
    ctx.fillRect(0, 0, s, s);
    // the frame: a ring of bright, scuffed steel
    ctx.fillStyle = '#5b5852';
    ctx.beginPath(); ctx.arc(m, m, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#121212';
    ctx.beginPath(); ctx.arc(m, m, r + 2.5, 0, Math.PI * 2); ctx.fill();    // the gap
    ctx.fillStyle = '#34322f';
    ctx.beginPath(); ctx.arc(m, m, r, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(m, m, r - 6, 0, Math.PI * 2); ctx.clip();
    // studs on a square grid, each lit on the top edge and shadowed below
    for (let y = m - r; y < m + r; y += 11) {
      for (let x = m - r; x < m + r; x += 11) {
        ctx.fillStyle = 'rgba(8,8,8,0.6)'; ctx.fillRect(x + 1, y + 2, 7, 7);
        ctx.fillStyle = 'rgba(122,118,110,0.85)'; ctx.fillRect(x, y, 7, 7);
        ctx.fillStyle = 'rgba(176,170,160,0.5)'; ctx.fillRect(x, y, 7, 2);
      }
    }
    // a band across the middle where the maker's name was cast
    ctx.fillStyle = '#2c2a27';
    ctx.fillRect(m - r, m - 13, r * 2, 26);
    ctx.fillStyle = 'rgba(140,134,124,0.7)';
    for (let k = -4; k <= 4; k++) ctx.fillRect(m + k * 12 - 4, m - 6, 8, 12);
    ctx.restore();
    // the cover's rim, and two lifting keyholes in it
    ctx.strokeStyle = 'rgba(150,144,134,0.6)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(m, m, r - 3, 0, Math.PI * 2); ctx.stroke();
    for (const sx of [-1, 1]) { ctx.fillStyle = '#080808'; ctx.fillRect(m + sx * (r - 18) - 4, m - 2, 8, 4); }
    mottle(ctx, s, 10, 'rgba(110,62,30,0.45)', 8, 30);        // rust in the low ground
    grit(ctx, s, 700, '170,166,158', '10,10,10', 1.2);
    noise(ctx, s, 10);
    return c;
  });
}

/** A gully grate at the kerb: a frame and the bars across it, black beneath. */
export function grate() {
  return make('grate', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#060606';
    ctx.fillRect(0, 0, s, s);
    // bright where the traffic has polished it: a grate is read by its bars
    ctx.fillStyle = '#6f6b63';
    ctx.fillRect(0, 0, s, 8); ctx.fillRect(0, s - 8, s, 8);
    ctx.fillRect(0, 0, 8, s); ctx.fillRect(s - 8, 0, 8, s);
    for (let x = 13; x < s - 9; x += 10) {
      ctx.fillStyle = '#7d786e'; ctx.fillRect(x, 8, 5, s - 16);
      ctx.fillStyle = 'rgba(206,200,188,0.55)'; ctx.fillRect(x, 8, 2, s - 16);
    }
    ctx.fillStyle = '#6f6b63'; ctx.fillRect(0, s / 2 - 3, s, 6);   // the cross-rib
    mottle(ctx, s, 8, 'rgba(110,60,28,0.5)', 6, 20);
    grit(ctx, s, 260, '160,156,148', '8,8,8', 1);
    noise(ctx, s, 10);
    return c;
  });
}

/**
 * Mipmaps for a cut-out texture that keep as much of it standing as the full
 * size does.
 *
 * Averaging a thin bar into its neighbours drops its alpha below the cut-off
 * a level or two down, so a grating that is a quarter iron at full size is
 * none at all a few metres off — an alpha-tested fire escape vanished from
 * the street, which is the one distance it used to look right from. Each
 * level here is the one above it halved, with its alpha then rescaled so the
 * fraction of texels over the cut-off matches the full-size image's
 * (Castaño's coverage-preserving mipmaps).
 */
function keepCoverage(tex, cutoff = 0.5) {
  const levels = [tex.image];
  const coverage = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > cutoff * 255) n++;
    return n / (d.length / 4);
  };
  const want = coverage(tex.image);
  let prev = tex.image;
  while (prev.width > 1 || prev.height > 1) {
    const w = Math.max(1, prev.width >> 1), h = Math.max(1, prev.height >> 1);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(prev, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    // the alpha that `want` of the texels stand above, scaled up to the cut-off
    const alphas = [];
    for (let i = 3; i < d.length; i += 4) alphas.push(d[i]);
    alphas.sort((p, q) => q - p);
    const at = alphas[Math.min(alphas.length - 1, Math.floor(want * alphas.length))] || 1;
    const k = (cutoff * 255) / Math.max(1, at);
    for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * k);
    ctx.putImageData(img, 0, 0);
    levels.push(c);
    prev = c;
  }
  tex.mipmaps = levels;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/**
 * Fire escape grating: bearing bars on a 3 cm pitch with a rod across them
 * every 12.5 cm, iron where there is iron and nothing between — you look
 * through a landing at the one above. Weathering is painted only onto what
 * is already there (`source-atop`), so it never fills a gap.
 */
export function grating() {
  const tex = make('grating', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) {
      ctx.fillStyle = '#4a4744'; ctx.fillRect(x, 0, 5, s);
      ctx.fillStyle = 'rgba(150,144,134,0.55)'; ctx.fillRect(x, 0, 1, s);
    }
    for (let y = 30; y < s; y += 64) {
      ctx.fillStyle = '#3e3b38'; ctx.fillRect(0, y, s, 3);
      ctx.fillStyle = 'rgba(140,134,124,0.45)'; ctx.fillRect(0, y, s, 1);
    }
    ctx.globalCompositeOperation = 'source-atop';
    mottle(ctx, s, 9, 'rgba(118,62,28,0.55)', 8, 34);
    grit(ctx, s, 500, '170,164,154', '12,12,12', 1.4);
    ctx.globalCompositeOperation = 'source-over';
    noise(ctx, s, 12);
    return c;
  });
  return tex.mipmaps?.length ? tex : keepCoverage(tex);
}

/** Fire escape railing infill: a square baluster every 12.5 cm, rust running down them. */
export function railing() {
  const tex = make('railing', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    for (let x = 6; x < s; x += 32) {
      ctx.fillStyle = '#403d3a'; ctx.fillRect(x, 0, 6, s);
      ctx.fillStyle = 'rgba(150,144,134,0.5)'; ctx.fillRect(x, 0, 1, s);
    }
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      ctx.fillStyle = `rgba(122,64,28,${0.2 + Math.random() * 0.35})`;
      ctx.fillRect(x, y, 6, 10 + Math.random() * 60);
    }
    grit(ctx, s, 300, '170,164,154', '12,12,12', 1.2);
    ctx.globalCompositeOperation = 'source-over';
    noise(ctx, s, 10);
    return c;
  });
  return tex.mipmaps?.length ? tex : keepCoverage(tex);
}

/**
 * Blister paving at a crossing: buff concrete flags covered in 7 cm studs,
 * so a cane finds the kerb — and a player reads the crossing from the
 * pavement before reaching the road.
 */
export function tactile() {
  return make('tactile', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#9a8a62';
    ctx.fillRect(0, 0, s, s);
    const step = s / 12;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const cx = (x + 0.5) * step, cy = (y + 0.5) * step;
        ctx.fillStyle = 'rgba(40,34,22,0.45)';
        ctx.beginPath(); ctx.arc(cx + 1, cy + 1.2, step * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#b3a273';
        ctx.beginPath(); ctx.arc(cx, cy, step * 0.28, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(222,210,170,0.5)';
        ctx.beginPath(); ctx.arc(cx - 1, cy - 1, step * 0.12, 0, Math.PI * 2); ctx.fill();
      }
    }
    // the joints between flags, and a decade of dirt in them
    ctx.fillStyle = 'rgba(30,26,18,0.5)';
    ctx.fillRect(0, s / 2 - 1, s, 2); ctx.fillRect(s / 2 - 1, 0, 2, s);
    mottle(ctx, s, 8, 'rgba(40,36,28,0.30)', 6, 24);
    grit(ctx, s, 300, '210,200,170', '30,26,20', 1);
    noise(ctx, s, 12);
    return c;
  });
}

/**
 * A wheel: tread and hub on one tile.
 *
 * A wheel's tread and its face unwrap to different places — which is the
 * whole trick here. The tread runs around the circumference and across the
 * width, so a 0.22 m tyre on a 1.2 m tile only ever shows `v` from 0 to 0.25:
 * the bottom quarter. The face is unwrapped flat across its own diameter
 * about the middle of the tile, so a 0.335 m tyre shows a disc of radius
 * 0.28 centred on (0.5, 0.5): the rim inside 0.19 of it, the sidewall out to
 * there. The wheel is turned on a lathe now, rim and tyre in one profile, and
 * the circles here are drawn to the radii it is turned to.
 *
 * Those two regions barely touch, so one texture paints both and a wheel is
 * one mesh instead of a tyre plus a rim. The tread lives in the bottom
 * quarter and has to tile across `u`, because the barrel repeats twice round;
 * the hub is drawn in the middle and never appears on the barrel at all.
 */
export function tire() {
  return make('tire', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    const TREAD = s * 0.75;            // where the barrel's quarter starts

    ctx.fillStyle = '#191a1d';
    ctx.fillRect(0, 0, s, s);

    // sidewall: shallow concentric moulding, so the cap is not a black disc
    for (let r = s * 0.275; r > s * 0.195; r -= s * 0.016) {
      ctx.strokeStyle = `rgba(${chance(0.5) ? '58,58,62' : '10,10,12'},0.5)`;
      ctx.lineWidth = rr(0.6, 1.8);
      ctx.beginPath(); ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2); ctx.stroke();
    }
    // raised lettering round the sidewall, at the size it would really be
    for (let k = 0; k < 26; k++) {
      const a = (k / 26) * Math.PI * 2, r = s * 0.24;
      ctx.fillStyle = 'rgba(96,96,100,0.35)';
      ctx.beginPath();
      ctx.ellipse(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 2.6, 1.3, a, 0, Math.PI * 2);
      ctx.fill();
    }

    // the rim: a dished steel disc with a bolt circle and a centre cap
    const hub = ctx.createRadialGradient(s / 2 - 8, s / 2 - 8, 2, s / 2, s / 2, s * 0.19);
    hub.addColorStop(0, '#8d9096');
    hub.addColorStop(0.7, '#5d6066');
    hub.addColorStop(1, '#3a3c40');
    ctx.fillStyle = hub;
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.19, 0, Math.PI * 2); ctx.fill();
    for (let k = 0; k < 5; k++) {        // lightening holes, then the studs
      const a = (k / 5) * Math.PI * 2 + 0.3;
      ctx.fillStyle = 'rgba(14,14,16,0.85)';
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * s * 0.12, s / 2 + Math.sin(a) * s * 0.12, s * 0.032, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const x = s / 2 + Math.cos(a) * s * 0.07, y = s / 2 + Math.sin(a) * s * 0.07;
      ctx.fillStyle = 'rgba(28,28,30,0.8)';
      ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(168,172,178,0.5)';
      ctx.beginPath(); ctx.arc(x - 1, y - 1, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#46484c';
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.045, 0, Math.PI * 2); ctx.fill();
    // rust creeping out of the rim, because nothing here has moved in years
    splotches(ctx, s, 26, 'rgba(126,74,38,0.30)', 2, 9);

    // tread: blocks in two rows, cut by a circumferential groove. The period
    // divides the tile, or the pattern steps at the seam where it repeats.
    ctx.fillStyle = '#101113';
    ctx.fillRect(0, TREAD, s, s - TREAD);
    const pitch = s / 16;
    for (let i = 0; i < 16; i++) {
      for (const [y0, h, lean] of [[TREAD + 2, (s - TREAD) / 2 - 3, 3], [TREAD + (s - TREAD) / 2 + 1, (s - TREAD) / 2 - 3, -3]]) {
        ctx.fillStyle = `rgba(${52 + (i % 3) * 5},${52 + (i % 3) * 5},${56 + (i % 3) * 5},1)`;
        ctx.beginPath();
        ctx.moveTo(i * pitch + 1, y0);
        ctx.lineTo(i * pitch + pitch - 2 + lean, y0);
        ctx.lineTo(i * pitch + pitch - 2, y0 + h);
        ctx.lineTo(i * pitch + 1 - lean, y0 + h);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(8,8,10,0.9)';
    ctx.fillRect(0, TREAD + (s - TREAD) / 2 - 2, s, 3);
    grit(ctx, s, 400, '150,150,154', '6,6,8', 1.2);
    noise(ctx, s, 12);
    return c;
  });
}

/**
 * What is left of a panel after the fire.
 *
 * Not simply black: a burnt shell is soot over bare, heat-blued steel, and
 * the interesting part is where the soot has flaked off. Blistered paint
 * reads as mottle, the bare patches carry a little colour, and the ash that
 * washed down the sides is the only light value in it.
 */
export function charred() {
  return make('charred', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#17161a';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 18, 'rgba(6,5,6,0.55)', 10, 46);
    mottle(ctx, s, 10, 'rgba(84,66,58,0.35)', 8, 30);     // heat-scoured steel
    mottle(ctx, s, 6, 'rgba(58,72,86,0.22)', 6, 22);      // blued by the heat
    // blistering: small bright rings where the paint lifted and burst
    for (let i = 0; i < 140; i++) {
      const x = rr(0, s), y = rr(0, s), r = rr(1.2, 4.5);
      ctx.strokeStyle = `rgba(122,104,88,${rr(0.10, 0.30)})`;
      ctx.lineWidth = rr(0.5, 1.2);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(8,7,8,${rr(0.2, 0.5)})`;
      ctx.beginPath(); ctx.arc(x, y, r * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 26; i++) runoff(ctx, rr(0, s), rr(0, s * 0.6), rr(2, 9), rr(20, 90), '148,142,132', rr(0.05, 0.16));
    grit(ctx, s, 900, '170,164,156', '4,4,5', 1.4);
    noise(ctx, s, 16);
    return c;
  });
}

/**
 * Worn cloth: what a hostile is dressed in.
 *
 * Deliberately pale, for the reason `paintedMetal` is: the archetype's own
 * colour lives on the material, so one weave clothes a scavenger in olive
 * drab and a raider in slate without painting a tile for each. What it does
 * carry is the weave, the seams, the patches sewn over the tears and the
 * dirt that has been ground in since — at 0.9 m a tile, so a half-metre
 * torso wears half of it and the weave stays cloth-sized.
 */
export function fatigues() {
  return make('fatigues', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    // Pale on purpose. `map` multiplies `color`, so a mid-grey tile under an
    // olive drab coat gives a coat at a third of the value it was written as,
    // and a hostile at dusk comes out a silhouette — the same mistake the
    // view model made once and is written up in the weapon pass.
    ctx.fillStyle = '#d6d1c4';
    ctx.fillRect(0, 0, s, s);

    // weave: a thread each way, which is what stops it reading as paper
    for (let x = 0; x < s; x += 3) {
      ctx.fillStyle = `rgba(0,0,0,${rr(0.04, 0.11)})`;
      ctx.fillRect(x, 0, 1.4, s);
    }
    for (let y = 0; y < s; y += 3) {
      ctx.fillStyle = `rgba(255,255,255,${rr(0.03, 0.09)})`;
      ctx.fillRect(0, y, s, 1.4);
    }

    mottle(ctx, s, 16, 'rgba(58,50,38,0.22)', 12, 52);      // ground-in dirt
    mottle(ctx, s, 9, 'rgba(226,222,212,0.14)', 10, 34);    // sun-bleached

    // patches sewn over the tears, each with its own stitching
    for (let i = 0; i < 7; i++) {
      const w = rr(22, 54), h = rr(18, 44), x = rr(0, s - w), y = rr(0, s - h);
      ctx.fillStyle = `rgba(${chance(0.5) ? '140,132,116' : '96,92,80'},0.55)`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(40,36,30,0.45)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.1;
      ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
      ctx.setLineDash([]);
    }

    // seams, and the fray running off them
    for (let i = 0; i < 5; i++) {
      const vertical = chance(0.5);
      const at = rr(0, s);
      ctx.fillStyle = 'rgba(52,46,38,0.35)';
      if (vertical) ctx.fillRect(at, 0, 2.5, s); else ctx.fillRect(0, at, s, 2.5);
      ctx.strokeStyle = 'rgba(232,226,214,0.22)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (vertical) { ctx.moveTo(at + 4, 0); ctx.lineTo(at + 4, s); }
      else { ctx.moveTo(0, at + 4); ctx.lineTo(s, at + 4); }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (let i = 0; i < 10; i++) runoff(ctx, rr(0, s), rr(0, s * 0.7), rr(3, 12), rr(20, 80), '48,40,30', rr(0.06, 0.18));
    grit(ctx, s, 600, '236,232,224', '30,26,20', 1.2);
    noise(ctx, s, 16);
    return c;
  });
}

/**
 * Strapping, buckles and plate: what is worn over the cloth.
 *
 * Webbing is a grid of horizontal straps stitched to a backing, which tiles
 * about as well as anything in this file — and it is what makes a hostile
 * read as kitted rather than as a person-shaped set of boxes. Kept mid-grey
 * so the archetype's accent colour still decides what it is made of.
 */
export function webbing() {
  return make('webbing', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#bcb6aa';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 12, 'rgba(34,30,26,0.22)', 12, 46);

    // rows of strapping, stitched down at a regular pitch
    const rows = 6, pitch = s / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * pitch + pitch * 0.18, h = pitch * 0.52;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(226,222,212,0.22)');
      g.addColorStop(0.5, 'rgba(70,66,58,0.10)');
      g.addColorStop(1, 'rgba(18,16,14,0.40)');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, s, h);
      ctx.fillStyle = 'rgba(16,14,12,0.45)';
      ctx.fillRect(0, y + h, s, 1.6);
      for (let x = pitch * 0.35; x < s; x += pitch) {      // the stitch bars
        ctx.fillStyle = 'rgba(30,26,22,0.55)';
        ctx.fillRect(x, y, 2.4, h);
      }
    }

    // buckles and press studs, bright enough to catch the sky
    for (let i = 0; i < 14; i++) {
      const x = rr(0, s), y = rr(0, s), w = rr(6, 13);
      ctx.fillStyle = 'rgba(196,200,206,0.55)';
      ctx.fillRect(x, y, w, w * 0.55);
      ctx.fillStyle = 'rgba(24,22,20,0.7)';
      ctx.fillRect(x + 2, y + 1.5, w - 4, w * 0.55 - 3);
    }
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(210,214,218,${rr(0.15, 0.45)})`;
      ctx.beginPath(); ctx.arc(rr(0, s), rr(0, s), rr(1, 2.4), 0, Math.PI * 2); ctx.fill();
    }

    splotches(ctx, s, 30, 'rgba(112,64,32,0.28)', 2, 10);    // rust off the metal
    grit(ctx, s, 500, '226,222,214', '22,20,18', 1.2);
    noise(ctx, s, 14);
    return c;
  });
}

/**
 * A stencilled supply case, for what a hostile leaves behind.
 *
 * A pickup is looked at from a metre away and from directly above, which is
 * further inside the player's attention than anything else this file paints.
 * Pale again, so one tile serves an ammunition case in olive and a medical
 * one in white — the stencil, the banding and the scuffed corners are the
 * same on both.
 */
export function crate() {
  return make('crate', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#d2cdc0';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 14, 'rgba(50,46,38,0.18)', 10, 40);

    // steel banding round the case, with rivets along it
    for (const x of [s * 0.18, s * 0.82]) {
      ctx.fillStyle = 'rgba(78,76,72,0.55)';
      ctx.fillRect(x - 7, 0, 14, s);
      ctx.fillStyle = 'rgba(232,230,224,0.18)';
      ctx.fillRect(x - 7, 0, 3, s);
      for (let y = 10; y < s; y += 26) {
        ctx.fillStyle = 'rgba(40,38,34,0.6)';
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(224,222,216,0.35)';
        ctx.beginPath(); ctx.arc(x - 0.8, y - 0.8, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // stencilling: blocks and bars rather than letters, which at this size is
    // what lettering looks like anyway, and needs no font to be installed
    ctx.fillStyle = 'rgba(38,36,32,0.62)';
    for (let k = 0; k < 7; k++) ctx.fillRect(s * 0.30 + k * 9, s * 0.30, 5.5, 18);
    for (let k = 0; k < 5; k++) ctx.fillRect(s * 0.30 + k * 9, s * 0.56, 5.5, 13);
    ctx.strokeStyle = 'rgba(38,36,32,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(s * 0.26, s * 0.24, s * 0.44, s * 0.52);

    // corners take the knocks, so that is where the paint is gone
    for (const [x, y] of [[0, 0], [s, 0], [0, s], [s, s]]) {
      const g = ctx.createRadialGradient(x, y, 2, x, y, s * 0.22);
      g.addColorStop(0, 'rgba(96,88,74,0.5)');
      g.addColorStop(1, 'rgba(96,88,74,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, s * 0.22, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(${chance(0.5) ? '70,64,54' : '236,232,224'},${rr(0.08, 0.26)})`;
      ctx.lineWidth = rr(0.4, 1.3);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(5, 26);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    splotches(ctx, s, 22, 'rgba(120,70,36,0.26)', 2, 8);
    grit(ctx, s, 500, '236,232,224', '28,24,20', 1.2);
    noise(ctx, s, 14);
    return c;
  });
}

/**
 * Olive drab on pressed steel, with the lot stencilled on the long side.
 *
 * The can's long sides are unwrapped with the tile centred on them (`main.js`
 * shifts them half a tile), so the stencil sits in the middle of the tile and
 * nothing else of the can reaches it: the ends and the lid land on the
 * tile's edges, where there is only paint. Lettering is drawn with whatever
 * sans-serif the browser has, squeezed and then worn through, because a
 * stencil a player reads from a metre away is the point of the thing.
 */
export function ammoCan() {
  return make('ammocan', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#4a5030';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 14, 'rgba(24,26,14,0.30)', 20, 80);
    mottle(ctx, s, 8, 'rgba(120,124,86,0.16)', 16, 60);

    // the stencil, in the middle of the tile where only the long side reaches
    ctx.save();
    ctx.fillStyle = 'rgba(214,190,92,0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const line = (text, y, px) => {
      ctx.save();
      ctx.translate(s / 2, y);
      ctx.scale(0.82, 1);
      ctx.font = `bold ${px}px "Arial Narrow", Arial, Helvetica, sans-serif`;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    line('840 CARTRIDGES', s * 0.665, 34);
    line('5.56 MM BALL M855', s * 0.735, 27);
    line('10 RD CLIPS  BANDOLEER', s * 0.79, 22);
    line('LOT ASH-25-117', s * 0.84, 22);
    ctx.restore();
    // a stencil is sprayed through a plate: the bridges leave gaps in it
    ctx.fillStyle = '#4a5030';
    for (let x = s * 0.2; x < s * 0.8; x += rr(9, 17)) ctx.fillRect(x, s * 0.62, rr(1, 1.8), s * 0.24);

    // where hands and the ground have had the paint off, down to grey steel
    // and the rust under it
    for (let i = 0; i < 90; i++) {
      ctx.strokeStyle = `rgba(${chance(0.6) ? '150,148,136' : '22,22,14'},${rr(0.12, 0.4)})`;
      ctx.lineWidth = rr(0.5, 1.6);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(4, 30);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
    }
    splotches(ctx, s, 40, 'rgba(128,124,110,0.55)', 1.5, 6);
    splotches(ctx, s, 26, 'rgba(110,60,28,0.40)', 1.5, 7);
    grit(ctx, s, 900, '170,170,150', '18,18,10', 1.2);
    noise(ctx, s, 12);
    return c;
  });
}

/**
 * Moulded polymer, the shell of a medical case: near white so the material
 * colour says what it is, a fine stipple from the mould, and the grime a case
 * picks up being carried through a city like this one.
 */
export function medCase() {
  return make('medcase', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#d8d6d0';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 12, 'rgba(70,64,54,0.20)', 14, 60);
    // the stipple of the mould, fine and even
    grit(ctx, s, 2600, '240,240,236', '120,116,108', 0.9);
    for (let i = 0; i < 70; i++) {
      ctx.strokeStyle = `rgba(${chance(0.7) ? '90,84,74' : '246,246,242'},${rr(0.10, 0.32)})`;
      ctx.lineWidth = rr(0.4, 1.2);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(4, 24);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
    }
    splotches(ctx, s, 16, 'rgba(84,70,52,0.30)', 2, 9);
    noise(ctx, s, 9);
    return c;
  });
}

/**
 * The first-aid sign — a white cross on green — as a decal for the case.
 * Its UVs cover it once, so it is not a tile; it carries the green the old
 * flat cross did, because green is how a player finds health at dusk.
 */
export function firstAidLabel() {
  return make('firstaid', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#e4e2da';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#2b9a48';
    ctx.beginPath();
    ctx.roundRect(5, 5, s - 10, s - 10, 12);
    ctx.fill();
    ctx.fillStyle = '#eeeee8';
    const a = s * 0.2, b = s * 0.4;
    ctx.fillRect((s - a) / 2, (s - 2 * b) / 2 + 2, a, 2 * b - 4);
    ctx.fillRect((s - 2 * b) / 2 + 2, (s - a) / 2, 2 * b - 4, a);
    // scuffed: the label is the first thing on a case to wear
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(${chance(0.5) ? '210,208,200' : '40,60,40'},${rr(0.12, 0.35)})`;
      ctx.lineWidth = rr(0.5, 1.4);
      const x = rr(0, s), y = rr(0, s), an = rr(0, Math.PI * 2), len = rr(3, 16);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(an) * len, y + Math.sin(an) * len); ctx.stroke();
    }
    noise(ctx, s, 10);
    return c;
  });
}

/**
 * A fragmentation grenade's body: olive paint over a smooth steel sphere,
 * with the yellow band round the shoulder that marks it high explosive.
 * The band is painted where the lathe's unwrap puts the shoulder (`main.js`
 * draws the profile so it lands there); the unwrap runs round the body by
 * arc length, so the band is the one thing on this tile that must tile
 * across, and does.
 */
export function fragBody() {
  return make('fragbody', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#4c5532';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 10, 'rgba(24,28,14,0.30)', 14, 50);
    // the band, between 0.62 and 0.68 of the way up the profile
    ctx.fillStyle = 'rgba(206,176,64,0.95)';
    ctx.fillRect(0, s * (1 - 0.68), s, s * 0.06);
    for (let i = 0; i < 70; i++) {
      ctx.strokeStyle = `rgba(${chance(0.6) ? '150,150,138' : '20,22,12'},${rr(0.12, 0.38)})`;
      ctx.lineWidth = rr(0.4, 1.2);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(3, 18);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
    }
    splotches(ctx, s, 18, 'rgba(140,138,124,0.5)', 1.2, 4);
    grit(ctx, s, 600, '170,170,150', '18,20,10', 1.0);
    noise(ctx, s, 10);
    return c;
  });
}

/**
 * Worn thermoplastic road paint.
 *
 * The shape of a marking is geometry, not pixels — `city.js` lays a quad the
 * size of the dash — so this tile paints only what a decade of tyres does to
 * a line: chalked-off edges, scuffs down to the aggregate, the odd stretch
 * rubbed away entirely. Bare patches use the asphalt's own base colour so a
 * hole in the paint reads as road showing through rather than as a grey mark.
 *
 * Deliberately not white. The base is a warm 73% grey, because the post
 * chain blooms everything brighter than white and a line at full value turns
 * into a glowing stripe under a low sun — and because a freshly laid road is
 * the one thing this sector is not.
 */
export function roadPaint() {
  return make('roadpaint', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    const BARE = '70,70,76';                 // the asphalt underneath

    ctx.fillStyle = '#bab5a6';
    ctx.fillRect(0, 0, s, s);

    // dirt held in the texture of the paint, and the yellowing of old resin
    mottle(ctx, s, 12, 'rgba(120,112,92,0.22)', 30, 120);
    mottle(ctx, s, 8, 'rgba(196,186,150,0.20)', 25, 90);

    // tyre scuffs: the wear that actually kills a line, running across it
    for (let i = 0; i < 34; i++) {
      ctx.save();
      ctx.translate(rr(0, s), rr(0, s));
      ctx.rotate(rr(-0.4, 0.4) + Math.PI / 2);
      ctx.fillStyle = `rgba(${BARE},${rr(0.10, 0.30)})`;
      ctx.fillRect(-rr(20, 90), -rr(1, 5), rr(40, 180), rr(2, 10));
      ctx.restore();
    }

    // stretches rubbed off entirely, soft-edged because wear has no border
    mottle(ctx, s, 10, `rgba(${BARE},0.72)`, 14, 62);

    // chips and the cracks the road's own movement opens through the film
    splotches(ctx, s, 120, `rgba(${BARE},0.5)`, 1, 5);
    for (let i = 0; i < 16; i++) {
      crack(ctx, s, rr(0, s), rr(0, s), rr(40, 150), rr(0.6, 1.8), `rgba(${BARE},0.8)`);
    }

    grit(ctx, s, 1800, '232,228,214', '46,45,48', 1.6);
    noise(ctx, s, 16);
    return c;
  });
}

/**
 * Polymer: a frame, a handguard, a stock.
 *
 * Injection-moulded furniture is not smooth — it is stippled so it grips a
 * wet hand, and that stipple is the whole reason a plastic gun part reads as
 * plastic rather than as a grey box. At 0.3 m a tile, a 1.5 mm pebble is
 * about two pixels across, which is the smallest thing worth painting here.
 */
export function gunPolymer() {
  return make('gunpoly', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#3f434a';
    ctx.fillRect(0, 0, s, s);

    // broad tone variation, so the surface is not one flat value
    mottle(ctx, s, 10, 'rgba(18,19,22,0.30)', 30, 110);
    mottle(ctx, s, 7, 'rgba(78,82,90,0.16)', 24, 80);

    // the stipple itself: a jittered grid of pebbles, each one lit from the
    // top-left, which is what gives the normal map something to lift
    const step = 5;
    for (let y = 0; y < s; y += step) {
      for (let x = 0; x < s; x += step) {
        const px = x + rr(-1.2, 1.2), py = y + rr(-1.2, 1.2);
        const r = rr(1.1, 2.0);
        ctx.fillStyle = `rgba(86,91,99,${rr(0.30, 0.55)})`;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(14,15,17,${rr(0.20, 0.40)})`;
        ctx.beginPath(); ctx.arc(px + r * 0.5, py + r * 0.5, r * 0.62, 0, Math.PI * 2); ctx.fill();
      }
    }

    // mould seams, where the two halves of the tool met
    for (let i = 0; i < 3; i++) {
      const y = rr(0, s);
      ctx.strokeStyle = `rgba(150,156,164,${rr(0.10, 0.20)})`;
      ctx.lineWidth = rr(0.6, 1.2);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
      ctx.strokeStyle = 'rgba(10,11,13,0.22)';
      ctx.beginPath(); ctx.moveTo(0, y + 1.4); ctx.lineTo(s, y + 1.4); ctx.stroke();
    }

    // scuffs: polymer goes shiny where it is handled, not bright
    for (let i = 0; i < 120; i++) {
      ctx.strokeStyle = `rgba(122,128,137,${rr(0.05, 0.16)})`;
      ctx.lineWidth = rr(0.5, 2.2);
      const x = rr(0, s), y = rr(0, s), a = rr(0, Math.PI * 2), len = rr(8, 46);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    noise(ctx, s, 9);
    return c;
  });
}

/**
 * Parkerised steel: a slide, a barrel, a receiver.
 *
 * Phosphate finish is dark and almost matte, and what makes it read as steel
 * is the machining underneath it — fine parallel tool marks — plus the places
 * the finish has worn back to bright metal. The wear is what the roughness
 * map keys off: `surfaceFrom` turns those bright pixels into the only part of
 * the gun that catches the sky properly.
 */
export function gunMetal() {
  return make('gunmetal', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#5e656e';
    ctx.fillRect(0, 0, s, s);

    mottle(ctx, s, 12, 'rgba(20,22,26,0.34)', 26, 96);
    mottle(ctx, s, 6, 'rgba(96,104,114,0.14)', 20, 70);

    // machining marks, all running one way like a ground flat
    for (let i = 0; i < 900; i++) {
      const y = rr(0, s);
      ctx.strokeStyle = `rgba(${chance(0.5) ? '132,140,150' : '22,24,28'},${rr(0.04, 0.13)})`;
      ctx.lineWidth = rr(0.35, 1.0);
      const x = rr(0, s), len = rr(30, 190);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + rr(-1.5, 1.5));
      ctx.stroke();
    }

    // pitting, and the odd deeper gouge
    grit(ctx, s, 900, '158,166,176', '16,17,20', 1.3);
    for (let i = 0; i < 26; i++) {
      const x = rr(0, s), y = rr(0, s);
      ctx.fillStyle = `rgba(14,15,18,${rr(0.20, 0.45)})`;
      ctx.beginPath(); ctx.arc(x, y, rr(1, 3.4), 0, Math.PI * 2); ctx.fill();
    }

    // holster wear: broad patches rubbed back to white steel
    mottle(ctx, s, 9, 'rgba(176,184,194,0.22)', 10, 40);
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(196,204,214,${rr(0.10, 0.30)})`;
      ctx.lineWidth = rr(0.4, 1.3);
      const x = rr(0, s), y = rr(0, s), a = rr(-0.25, 0.25), len = rr(10, 60);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    noise(ctx, s, 11);
    return c;
  });
}

/** Dirty glazing: storefront bands and what is left of car glass. */
export function dirtyGlass() {
  return make('glass', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#1e2a36';
    ctx.fillRect(0, 0, s, s);
    mottle(ctx, s, 16, 'rgba(130,152,172,0.14)', 14, 60);
    mottle(ctx, s, 10, 'rgba(10,10,12,0.35)', 10, 44);
    // dust washed down in streaks by rain that stopped coming
    for (let i = 0; i < 70; i++) {
      const x = rr(0, s);
      const g = ctx.createLinearGradient(x, 0, x, s);
      g.addColorStop(0, 'rgba(180,170,150,0)');
      g.addColorStop(rr(0.2, 0.8), `rgba(180,170,150,${rr(0.03, 0.10)})`);
      g.addColorStop(1, 'rgba(180,170,150,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, rr(1, 5), s);
    }
    // impact stars, with cracks radiating out of them
    for (let i = 0; i < 5; i++) {
      const x = rr(0, s), y = rr(0, s);
      ctx.strokeStyle = 'rgba(214,226,232,0.34)';
      for (let k = 0; k < 9; k++) {
        ctx.lineWidth = rr(0.4, 1.3);
        const a = (k / 9) * Math.PI * 2 + rr(-0.2, 0.2), len = rr(6, 30);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(226,236,240,0.4)';
      ctx.beginPath(); ctx.arc(x, y, rr(1.5, 3.5), 0, Math.PI * 2); ctx.fill();
    }
    noise(ctx, s, 8);
    return c;
  });
}

/** Dust / smoke sprite used by muzzle flashes, impacts and blood. */
/**
 * A tuft of weeds, on a transparent card: what grows in the cracks of a city
 * nobody has swept for years. Late-summer stock — olive, straw and a few
 * darker blades — because a bright lawn green reads as a park, and seed
 * heads on the tallest stems, which is the part that says *weed*. Blades are
 * filled, tapering curves rather than stroked lines, so the alpha edge is a
 * blade's own edge when the card is alpha-tested.
 */
/**
 * Litter: four sheets on one card, each a quarter of it — newsprint, a flap
 * of cardboard, a crumpled white sheet and a faded plastic bag. Torn edges
 * are the card's own alpha, so a sheet is the shape of something dropped
 * rather than a rectangle. The city is a long way from its last street
 * sweeper, and what blows into a gutter is most of what says so.
 */
export function litter() {
  const tex = make('litter', () => {
    const s = 256, h = s / 2, c = canvas(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const torn = (x0, y0, inset) => {
      // a ragged quadrilateral filling most of a quarter
      ctx.beginPath();
      const pts = [];
      for (const [cx, cy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        pts.push([x0 + inset + cx * (h - 2 * inset) + rr(-8, 8), y0 + inset + cy * (h - 2 * inset) + rr(-8, 8)]);
      }
      for (let k = 0; k < 4; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % 4];
        if (k === 0) ctx.moveTo(ax, ay);
        for (let t = 1; t <= 6; t++) {
          const f = t / 6;
          ctx.lineTo(ax + (bx - ax) * f + rr(-2.5, 2.5), ay + (by - ay) * f + rr(-2.5, 2.5));
        }
      }
      ctx.closePath();
    };
    // newsprint: grey-cream with columns of print
    torn(0, 0, 10); ctx.fillStyle = '#b9b2a0'; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = 'rgba(40,38,36,0.55)';
    for (let col = 0; col < 3; col++) {
      for (let y = 22; y < h - 14; y += 4) {
        if (chance(0.12)) continue;
        ctx.fillRect(16 + col * 34, y, rr(18, 30), 1.6);
      }
    }
    ctx.fillRect(16, 12, 90, 6);                       // a headline
    ctx.restore();
    // cardboard: brown, with corrugation lines and a water stain
    torn(h, 0, 8); ctx.fillStyle = '#8a6a45'; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = 'rgba(60,44,28,0.35)'; ctx.lineWidth = 1;
    for (let y = 6; y < h; y += 5) { ctx.beginPath(); ctx.moveTo(h, y); ctx.lineTo(s, y + 3); ctx.stroke(); }
    ctx.fillStyle = 'rgba(50,36,22,0.35)';
    mottle(ctx, s, 3, 'rgba(50,36,22,0.35)', 10, 30);
    ctx.restore();
    // crumpled white sheet: creases as light and dark streaks
    torn(0, h, 14); ctx.fillStyle = '#d8d4cb'; ctx.fill();
    ctx.save(); ctx.clip();
    for (let k = 0; k < 14; k++) {
      ctx.strokeStyle = chance(0.5) ? 'rgba(255,255,255,0.4)' : 'rgba(90,86,80,0.35)';
      ctx.lineWidth = rr(1, 2.5);
      ctx.beginPath();
      ctx.moveTo(rr(0, h), h + rr(0, h)); ctx.lineTo(rr(0, h), h + rr(0, h)); ctx.stroke();
    }
    ctx.restore();
    // a faded plastic bag
    torn(h, h, 12); ctx.fillStyle = '#6f8494'; ctx.fill();
    ctx.save(); ctx.clip();
    for (let k = 0; k < 10; k++) {
      ctx.strokeStyle = 'rgba(220,230,235,0.3)'; ctx.lineWidth = rr(1, 3);
      ctx.beginPath(); ctx.moveTo(h + rr(0, h), h + rr(0, h)); ctx.lineTo(h + rr(0, h), h + rr(0, h)); ctx.stroke();
    }
    ctx.restore();
    return c;
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function weeds(variant = 0) {
  const tex = make('weeds' + variant, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const stock = [[96, 108, 54], [132, 120, 70], [72, 86, 40], [150, 136, 86], [58, 70, 34]];
    const blades = 46 + (variant * 9) % 20;
    for (let i = 0; i < blades; i++) {
      const [r, g, b] = stock[(Math.random() * stock.length) | 0];
      const k = rr(0.75, 1.15);
      ctx.fillStyle = `rgb(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0})`;
      // rooted near the middle of the card, fanning out as they rise
      const x0 = s / 2 + rr(-0.16, 0.16) * s;
      const h = rr(0.35, 0.97) * s;
      const lean = rr(-0.45, 0.45) * h;
      const w = rr(2.2, 5.5);
      const tipX = x0 + lean, tipY = s - h;
      const cx = x0 + lean * 0.25, cy = s - h * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0 - w, s);
      ctx.quadraticCurveTo(cx - w * 0.6, cy, tipX, tipY);
      ctx.quadraticCurveTo(cx + w * 0.6, cy, x0 + w, s);
      ctx.closePath();
      ctx.fill();
      if (h > s * 0.75 && chance(0.35)) {      // a seed head on a tall stem
        ctx.fillStyle = `rgb(${(150 * k) | 0},${(132 * k) | 0},${(88 * k) | 0})`;
        for (let j = 0; j < 7; j++) {
          ctx.beginPath();
          ctx.ellipse(tipX + rr(-3, 3), tipY + j * 3.2, rr(1.6, 2.6), rr(2.5, 4), lean * 0.002, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    return c;
  });
  // a card, not a tile: clamp, or the top of each blade bleeds onto the root
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function particleSprite(color = '#ffffff') {
  return make('spr' + color, () => {
    const s = 64, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, color);
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
}

/* ------------------------------------------------------- derived channels */

/**
 * A texture's pixels as a size x size luminance field, 0..1.
 *
 * `half` reads it at half resolution. A derived normal or roughness map does
 * not need the detail the colour map does, and at 1024px a facade's three
 * channels would otherwise cost 16 MB of video memory each.
 */
function luminanceOf(sourceTexture, half = false) {
  const src = sourceTexture.image;
  const size = half ? src.width / 2 : src.width;
  const read = document.createElement('canvas');
  read.width = read.height = size;
  const rctx = read.getContext('2d');
  rctx.drawImage(src, 0, 0, size, size);
  const px = rctx.getImageData(0, 0, size, size).data;

  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    lum[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
  }
  return { lum, size };
}

/** Wrapping 3x3 box blur, in place over a luminance field. */
function blurLum(lum, size, passes) {
  const tmp = new Float32Array(lum.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const up = ((y - 1 + size) % size) * size, mid = y * size, dn = ((y + 1) % size) * size;
      for (let x = 0; x < size; x++) {
        const l = (x - 1 + size) % size, r = (x + 1) % size;
        tmp[mid + x] = (lum[up + l] + lum[up + x] + lum[up + r]
                      + lum[mid + l] + lum[mid + x] + lum[mid + r]
                      + lum[dn + l] + lum[dn + x] + lum[dn + r]) / 9;
      }
    }
    lum.set(tmp);
  }
}

/**
 * Derive a normal map from a texture's own luminance (Sobel on brightness,
 * treating dark as recessed). Painted windows and mortar lines then catch
 * light like relief instead of reading as a flat decal.
 *
 * The per-pixel grain every texture ends with is real detail in the colour
 * map and pure noise in a normal map — it makes a wall sparkle when the
 * camera moves. `blur` low-passes the luminance first, so the relief follows
 * the sills and courses and not the speckle.
 */
export function normalFrom(sourceTexture, strength = 1.6, key = '', blur = 1, half = false) {
  return make('normal' + key + strength + '_' + blur + (half ? 'h' : ''), () => {
    const { lum, size } = luminanceOf(sourceTexture, half);
    if (blur) blurLum(lum, size, blur);
    const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];

    const out = document.createElement('canvas');
    out.width = out.height = size;
    const octx = out.getContext('2d');
    const img = octx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
                 - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
        const dy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
                 - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
        let nx = dx * strength, ny = dy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }, [sourceTexture.repeat.x, sourceTexture.repeat.y], THREE.NoColorSpace);
}

/**
 * Pack a roughness/metalness map out of the same luminance.
 *
 * Three reads roughness from the green channel and metalness from the blue,
 * so one canvas drives both. Dark pixels are the grime, soot and cracks, and
 * come out rough; bright ones are glass, bare metal and polished stone, and
 * come out smooth enough to catch the sky. Without this every surface in the
 * city answers the light with exactly the same sheen.
 *
 * @param {number} dark  roughness where the source is black
 * @param {number} lite  roughness where the source is white
 */
export function surfaceFrom(sourceTexture, { dark = 1, lite = 0.55, metalDark = 0, metalLite = 0, half = false } = {}, key = '') {
  return make('surface' + key + dark + '_' + lite + '_' + metalDark + '_' + metalLite + (half ? 'h' : ''), () => {
    const { lum, size } = luminanceOf(sourceTexture, half);
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const octx = out.getContext('2d');
    const img = octx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const l = lum[i];
      img.data[i * 4] = 0;
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, (dark + (lite - dark) * l) * 255));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, (metalDark + (metalLite - metalDark) * l) * 255));
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return out;
  }, [sourceTexture.repeat.x, sourceTexture.repeat.y], THREE.NoColorSpace);
}

/** Soft round blob for contact shadows under characters and props. */
export function blobShadow() {
  return make('blob', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
}
