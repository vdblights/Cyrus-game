/**
 * Ask the running game a question.
 *
 * Boots the game headless, seeded and frozen, evaluates an expression inside
 * it, and prints the result as JSON. This exists because the alternative —
 * writing a fresh Playwright script every time something looks wrong — is
 * slow enough that you start guessing instead of measuring.
 *
 *   node tests/probe.js "g.perches.length"
 *   node tests/probe.js --seed=777 "__step(20); return __enemies()"
 *   node tests/probe.js --file=scratch/my-probe.js
 *   node tests/probe.js --list
 *
 * In scope: `g` (the game), `__step(seconds)`, `__enemies()`, `__profile()`,
 * `__place(range)`. A body containing `return` is used as a function body;
 * anything else is evaluated as an expression.
 */
import { readFile } from 'node:fs/promises';
import { openGame } from './harness.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const SEED = Number(flag('seed')) || 20260813;
const FILE = flag('file');
const HEADED = args.includes('--headed');

/** Canned probes for the questions that come up again and again. */
const PRESETS = {
  world: 'return { seed: g.seed, boxes: g.world.boxes.length, solids: g.world.solids.length, ' +
         'perches: g.perches.length, barrels: g.fireBarrels.length }',
  enemies: 'g.startRun(); __step(20); return __enemies()',
  waves: 'g.startRun(); __step(60); return { wave: g.wave, alive: g.aliveCount, ' +
         'queued: g.spawnQueue.length, kills: g.kills, score: g.score, hp: Math.round(g.player.health) }',
  perches: 'return g.perches.map((p) => ({ at: [+p.x.toFixed(0), +p.z.toFixed(0)], top: +p.y.toFixed(2), ' +
           'profileZ: __profile(p.x, p.z, "z"), profileX: __profile(p.x, p.z, "x") }))',
  objectives: `g.startRun(); g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    const out = [];
    for (const kind of ['cache', 'hold', 'extraction']) {
      const o = g.objectives.start(kind);
      if (!o) { out.push({ kind, placed: false }); continue; }
      out.push({
        kind, at: [+o.x.toFixed(0), +o.z.toFixed(0)], dist: +o.dist.toFixed(1),
        limit: o.def.limit, channel: o.def.channel, radius: o.def.radius,
        ground: +g.world.groundHeight(o.x, o.z, 1.4, 99).toFixed(2),
        boxed: g.world.occupied(o.x, o.z, o.def.radius * 0.8, 0.6),
        marker: g.objectives.screenMarker(g.camera, 1100, 620),
      });
      g.objectives.finish(false);
    }
    return out;`,
  mantle: `g.startRun(); g.startWave = () => {};
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    const out = [];
    for (const b of g.world.boxes) {
      if (out.length >= 8 || b.top < 0.6 || b.top > 3) continue;
      const px = (b.minX + b.maxX) / 2, pz = b.minZ - 0.62;
      if (g.world.groundHeight(px, pz, 0.42, 99) > 0.2) continue;
      g.player.reset(px, pz);
      g.player.yaw = Math.PI;                    // face +Z, into the box
      const grab = g.world.mantleTarget(px, pz, 0.42, 0, 0, 1, 0.6, 1.8);
      g.input.keys.clear(); g.input.keys.add('Space');
      let started = false;
      for (let f = 0; f < 120; f++) { g.time += 1/60; g.step(1/60); if (g.player.mantle) started = true; else if (started) break; }
      g.input.keys.clear();
      for (let f = 0; f < 90; f++) { g.time += 1/60; g.step(1/60); }
      out.push({ top: +b.top.toFixed(2), grab: grab && +grab.top.toFixed(2), started, feet: +g.player.feetY.toFixed(2) });
    }
    return out;`,
  shot: `g.startRun(); g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    const { target, px, pz } = __place(12);
    g.player.reset(px, pz);
    const e = g.spawnEnemy('raider');
    e.pos.set(target.x, 0, target.z); e.group.position.copy(e.pos); e.nextFire = 1e9;
    g.step(1 / 60);
    const V = g.player.position.constructor;
    const out = [];
    for (const zone of ['torso', 'head']) {
      const aim = e.parts[zone].getWorldPosition(new V());
      const dir = aim.clone().sub(g.camera.position).normalize();
      const before = e.hp;
      g.hitscan(dir, { ...g.weapons.def, spread: 0, adsSpread: 0 });
      out.push({ zone, dealt: Math.round(before - e.hp), aimedAt: [+aim.x.toFixed(1), +aim.y.toFixed(2), +aim.z.toFixed(1)] });
    }
    return out;`,
};

if (args.includes('--list')) {
  console.log('presets:', Object.keys(PRESETS).join(', '));
  process.exit(0);
}

const positional = args.filter((a) => !a.startsWith('--'))[0];
let body = FILE ? await readFile(FILE, 'utf8') : (PRESETS[positional] || positional);

if (!body) {
  console.error('nothing to evaluate. Try: node tests/probe.js --list');
  process.exit(1);
}
if (!/\breturn\b/.test(body)) body = `return (${body})`;

const game = await openGame({ seed: SEED, headed: HEADED });
try {
  const result = await game.page.evaluate((src) => {
    const g = window.__game;
    // eslint-disable-next-line no-new-func
    const fn = new Function('g', '__step', '__enemies', '__profile', '__place', src);
    const value = fn(g, window.__step, window.__enemies, window.__profile, window.__place);
    // strip anything that will not survive structured cloning
    return JSON.parse(JSON.stringify(value ?? null, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
  }, body);
  console.log(JSON.stringify(result, null, 1));
} catch (err) {
  console.error('probe failed:', err.message);
  process.exitCode = 1;
}

if (game.errors.length) console.error('page errors:', [...new Set(game.errors)].join(' | '));
await game.close();
