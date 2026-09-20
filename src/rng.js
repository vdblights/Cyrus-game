/**
 * Seeded randomness.
 *
 * The whole game — city layout, prop placement, spawn points, weapon spread,
 * AI decisions — runs off `Math.random()`. Rather than thread a generator
 * through every call site, this replaces the global with a seeded mulberry32
 * for the lifetime of the page. That is a deliberate, contained trade: it
 * makes a run reproducible from a single number, so a layout can be shared
 * and a failing test can be replayed exactly.
 *
 * Pass ?seed=12345 in the URL to pin one.
 */
let currentSeed = 0;
let global = null;

/**
 * A mulberry32 that will hand its position back. This is the hottest function
 * in the game — spread, AI and effects all call it every frame — so it keeps
 * its state in a closure and allocates nothing per draw.
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.mark = () => a;
  next.rewind = (to) => { a = to; };
  return next;
}

export function initRandom(explicit) {
  const fromUrl = Number(new URLSearchParams(location.search).get('seed'));
  currentSeed = (explicit ?? (Number.isFinite(fromUrl) && fromUrl ? fromUrl : (Math.random() * 0xffffffff) >>> 0)) >>> 0;

  global = makeRandom(currentSeed);
  Math.random = global;
  return currentSeed;
}

/**
 * Run `fn` and then rewind the global stream to where it started.
 *
 * Three draws four `Math.random()` calls per `Object3D`, material, texture and
 * geometry to build its UUID, so minting one material more or fewer before the
 * city is laid out used to shift every later draw and hand the same seed a
 * different city. That made every graphics change a layout change. Building
 * the look inside this — materials, textures, view models — costs the stream
 * nothing, so a seed keeps its city across work that only changes how it looks.
 */
export function reserve(fn) {
  if (!global) return fn();          // nothing seeded yet, nothing to protect
  const saved = global.mark();
  try {
    return fn();
  } finally {
    global.rewind(saved);
  }
}

export function getSeed() { return currentSeed; }
