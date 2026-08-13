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

export function initRandom(explicit) {
  const fromUrl = Number(new URLSearchParams(location.search).get('seed'));
  currentSeed = (explicit ?? (Number.isFinite(fromUrl) && fromUrl ? fromUrl : (Math.random() * 0xffffffff) >>> 0)) >>> 0;

  let a = currentSeed;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return currentSeed;
}

export function getSeed() { return currentSeed; }
