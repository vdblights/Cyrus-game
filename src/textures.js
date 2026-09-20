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
  // The gun is the one surface always within arm's reach, so its tiles are
  // small: 0.3 m across a 512 tile is 1,700 px/m, against 64 for the road.
  gunPoly: 0.3,
  gunMetal: 0.36,
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

function splotches(ctx, size, count, color, rMin, rMax) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = rMin + Math.random() * (rMax - rMin);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + Math.random()), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
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
 * Low-frequency blotching that wraps at the tile edge.
 *
 * Tiling is given away by the eye finding the same *large* shape twice, not
 * the same grain, so every surface gets a soft mottle drawn nine times — once
 * in place and once for each neighbour — and clipped to the tile.
 */
function mottle(ctx, size, count, color, rMin, rMax) {
  softLayer(ctx, size, (lctx) => {
    lctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const x = Math.random() * size, y = Math.random() * size;
      const r = rr(rMin, rMax), ry = r * rr(0.55, 1.4), rot = Math.random() * Math.PI;
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          if ((ox || oy) && Math.hypot(x + ox - size / 2, y + oy - size / 2) > size * 1.2 + r) continue;
          lctx.beginPath();
          lctx.ellipse(x + ox, y + oy, r, ry, rot, 0, Math.PI * 2);
          lctx.fill();
        }
      }
    }
  });
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
 * down a street. Road paint belongs on the roads, as its own geometry.
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

    // potholes: a dark pit with a lighter rim of broken edge
    for (let i = 0; i < 5; i++) {
      const x = rr(0, s), y = rr(0, s), r = rr(6, 20);
      ctx.fillStyle = 'rgba(120,115,106,0.28)';
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.35, r * 1.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(14,14,16,0.75)';
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.8, rr(0, 3), 0, Math.PI * 2); ctx.fill();
    }

    // oil and ash, dark and soft-edged
    softLayer(ctx, s, (l) => {
      for (let i = 0; i < 8; i++) {
        l.fillStyle = `rgba(16,14,14,${rr(0.10, 0.28)})`;
        l.beginPath();
        l.ellipse(rr(0, s), rr(0, s), rr(8, 34), rr(6, 26), rr(0, 3), 0, Math.PI * 2);
        l.fill();
      }
    }, 128);

    // wind-drifted dust, which is what keeps the street from reading as new
    mottle(ctx, s, 8, 'rgba(176,150,112,0.13)', 50, 140);

    noise(ctx, s, 22);
    return c;
  });
}

/** Pitted sidewalk / plaza concrete, slabbed at roughly 1.3 m. */
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
export function facade(style = 0, variant = 0) {
  return make('facade' + style + '_' + variant, () => {
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
    for (let r = 0; r < FACADE_FLOORS; r++) {
      const y = r * floor;
      ctx.fillStyle = jitter(def.trim, 10);
      ctx.fillRect(0, y, s, floor * 0.14);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(0, y, s, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.fillRect(0, y + floor * 0.14, s, 7);
    }

    const winW = bay * 0.58, winH = floor * 0.5;
    for (let r = 0; r < FACADE_FLOORS; r++) {
      for (let b = 0; b < FACADE_BAYS; b++) {
        const x = b * bay + (bay - winW) / 2;
        const y = r * floor + floor * 0.30;
        window_(ctx, x, y, winW, winH, variant);
      }
    }

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
      softLayer(ctx, s, (l) => {
        for (let i = 0; i < 9; i++) {
          l.fillStyle = `rgba(108,104,98,${rr(0.15, 0.35)})`;
          l.beginPath();
          l.ellipse(rr(0, s), rr(0, s), rr(20, 70), rr(16, 55), rr(0, 3), 0, Math.PI * 2);
          l.fill();
        }
      }, 128);
      ctx.fillStyle = jitter(def.trim, 8);
      for (let i = 0; i < 400; i++) {
        ctx.globalAlpha = rr(0.02, 0.08);
        ctx.fillRect(rr(0, s), rr(0, s), rr(2, 9), rr(2, 9));
      }
      ctx.globalAlpha = 1;
    }
  }

  /** One opening: reveal, sill, lintel and whatever is left in the frame. */
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
export function rustMetal(variant = 0) {
  return make('rust' + variant, () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#6b4a33';
    ctx.fillRect(0, 0, s, s);

    // what is left of the paint, in the colour containers actually come in
    const paints = ['#3f5a4a', '#6d3b30', '#43506b', '#7a6a3c'];
    ctx.fillStyle = paints[variant % paints.length];
    ctx.fillRect(0, 0, s, s);
    softLayer(ctx, s, (l) => {
      for (let i = 0; i < 90; i++) {      // rust eating through the coat
        l.fillStyle = `rgba(${chance(0.5) ? '138,80,40' : '92,54,30'},${rr(0.25, 0.7)})`;
        l.beginPath();
        l.ellipse(rr(0, s), rr(0, s), rr(6, 42), rr(5, 34), rr(0, 3), 0, Math.PI * 2);
        l.fill();
      }
    }, 160);
    splotches(ctx, s, 60, 'rgba(168,112,58,0.30)', 3, 18);
    splotches(ctx, s, 40, 'rgba(38,26,18,0.45)', 3, 16);

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

    // dents, which is what stops a flat sheet reading as a flat sheet
    softLayer(ctx, s, (l) => {
      for (let i = 0; i < 12; i++) {
        l.fillStyle = `rgba(0,0,0,${rr(0.10, 0.24)})`;
        l.beginPath();
        l.ellipse(rr(0, s), rr(0, s), rr(10, 34), rr(8, 26), rr(0, 3), 0, Math.PI * 2);
        l.fill();
      }
    }, 128);

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

/**
 * Dusk sky. The vertical band does the work: deep blue overhead falling
 * through violet to a smoggy orange at the horizon, with a dust layer sitting
 * on the skyline. The sun itself is a sprite placed at the light's actual
 * direction, not painted here, so the two can never drift apart.
 */
export function skyTexture() {
  return make('sky', () => {
    const s = 1024, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0.00, '#0d1120');   // zenith
    g.addColorStop(0.30, '#232a42');
    g.addColorStop(0.50, '#4a3f55');
    g.addColorStop(0.64, '#8a5c4c');
    g.addColorStop(0.76, '#c2764a');
    g.addColorStop(0.88, '#d08c4c');
    g.addColorStop(0.96, '#96633a');
    g.addColorStop(1.00, '#5d4630');   // below the horizon line, not glowing
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // torn cloud, soft and low contrast — hard bands read as painted stripes
    softLayer(ctx, s, (l) => {
      for (let i = 0; i < 46; i++) {
        const y = s * (0.32 + Math.pow(Math.random(), 0.7) * 0.44);
        const h = 6 + Math.random() * 22;
        const w = s * (0.2 + Math.random() * 0.55);
        const x = Math.random() * s;
        const light = y / s;
        l.fillStyle = Math.random() < 0.4
          ? `rgba(255, ${170 + light * 60 | 0}, ${130 + light * 40 | 0}, ${0.03 + Math.random() * 0.06})`
          : `rgba(${34 + light * 40 | 0}, ${28 + light * 26 | 0}, ${44 + light * 16 | 0}, ${0.05 + Math.random() * 0.10})`;
        l.beginPath();
        l.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
        l.fill();
      }
    }, 256);

    // dust haze thickening onto the skyline
    const haze = ctx.createLinearGradient(0, s * 0.68, 0, s);
    haze.addColorStop(0, 'rgba(214, 150, 96, 0)');
    haze.addColorStop(1, 'rgba(214, 150, 96, 0.38)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, s * 0.68, s, s * 0.32);
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

/** Sun glow: a smooth falloff, unlike the hard-cored particle sprite. */
export function sunSprite(inner = '#fff3d6', outer = '#ff9a3c') {
  return make('sun' + inner + outer, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.00, inner);
    g.addColorStop(0.12, inner);
    g.addColorStop(0.30, outer);
    g.addColorStop(0.55, 'rgba(255,140,60,0.22)');
    g.addColorStop(0.78, 'rgba(255,120,50,0.06)');
    g.addColorStop(1.00, 'rgba(255,120,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
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
