/**
 * Headless test suite for ASHFALL.
 *
 * The game is driven through `window.__game`: each check steps the game loop
 * directly with a fixed timestep rather than waiting on frames, so a three
 * minute run takes a few seconds and does not depend on render speed. Software
 * WebGL in CI renders at a couple of frames a second — far too slow to test
 * gameplay through the animation loop.
 *
 *   node tests/run.js            all checks
 *   node tests/run.js --shots    also write screenshots to tests/shots/
 *   node tests/run.js --headed   watch it run
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openGame } from './harness.js';

const PORT = 8177;
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '').split('=')[1]) || 20260813;
const SHOTS = process.argv.includes('--shots');
const HEADED = process.argv.includes('--headed');
const SHOT_DIR = fileURLToPath(new URL('./shots/', import.meta.url));

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/* ------------------------------------------------------------------ checks */

check('boots without errors and builds a city', async (page) => {
  const boot = await page.evaluate(() => {
    const g = window.__game;
    return {
      state: g.state,
      boxes: g.world.boxes.length,
      solids: g.world.solids.length,
      perches: g.perches.length,
      weapons: g.weapons.weapons.length,
    };
  });
  expect(boot.state === 'menu', `state is ${boot.state}`);
  expect(boot.boxes > 100, `only ${boot.boxes} collision boxes`);
  expect(boot.solids > 100, `only ${boot.solids} raycast solids`);
  expect(boot.perches >= 4, `only ${boot.perches} perches generated`);
  expect(boot.weapons === 4, `${boot.weapons} weapons`);
  return boot;
});

check('bullets damage hostiles, headshots hurt more', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false; g.waveHpScale = 1;

    const shootAt = (zone) => {
      const { target: spot, px, pz } = window.__place(12);
      g.player.reset(px, pz);
      const e = g.spawnEnemy('raider');
      e.pos.set(spot.x, 0, spot.z);
      e.group.position.copy(e.pos);
      e.nextFire = 1e9;
      e.alerted = false;
      g.step(1 / 60);
      const V = g.player.position.constructor;
      const part = zone === 'head' ? e.parts.head : e.parts.torso;
      const aim = part.getWorldPosition(new V());
      const dir = aim.sub(g.camera.position).normalize();
      const before = e.hp;
      g.hitscan(dir, { ...g.weapons.def, spread: 0, adsSpread: 0 });
      return before - e.hp;
    };
    return { body: Math.round(shootAt('body')), head: Math.round(shootAt('head')) };
  });
  expect(r.body > 0, 'a body shot did no damage');
  expect(r.head > r.body, `headshot (${r.head}) not better than body (${r.body})`);
  return r;
});

check('melee kills what is in reach and misses what is not', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false; g.waveHpScale = 1;

    const spot = g.findSpawnPoint(26, 32);
    g.player.reset(spot.x, spot.z + 4);
    g.player.yaw = 0;                             // faces -Z
    g.step(1 / 60);

    const near = g.spawnEnemy('scavenger');
    near.pos.set(spot.x, 0, spot.z + 2.4);
    near.group.position.copy(near.pos);
    near.nextFire = 1e9;

    const far = g.spawnEnemy('scavenger');
    far.pos.set(spot.x, 0, spot.z - 6);
    far.group.position.copy(far.pos);
    far.nextFire = 1e9;

    const started = g.weapons.startMelee(g.time);
    for (let f = 0; f < 40; f++) { g.time += 1 / 60; g.step(1 / 60); }
    return {
      started, nearAlive: near.alive, farHp: Math.round(far.hp),
      blockedByCooldown: g.weapons.startMelee(g.time) === false,
    };
  });
  expect(r.started, 'the swing never started');
  expect(!r.nearAlive, 'the adjacent hostile survived a bash');
  expect(r.farHp === 65, `a hostile 10 m away took damage (hp ${r.farHp})`);
  expect(r.blockedByCooldown, 'melee has no cooldown');
  return r;
});

check('frags arc, detonate, and fall off with distance', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false; g.waveHpScale = 1;

    // throw one and watch it fly
    const { target: spot, px, pz } = window.__place(14);
    g.player.reset(px, pz);
    g.player.yaw = Math.atan2(-(spot.x - px), -(spot.z - pz));
    g.player.pitch = 0.1;
    g.step(1 / 60);
    const nadesBefore = g.nades;
    g.cookStart = g.time;
    g.throwGrenade();
    const start = g.grenades.pool.find((x) => x.active).pos.clone();
    let travelled = 0, exploded = false;
    for (let f = 0; f < 60 * 5; f++) {
      g.time += 1 / 60; g.step(1 / 60);
      const live = g.grenades.pool.find((x) => x.active);
      if (live) travelled = Math.hypot(live.pos.x - start.x, live.pos.z - start.z);
      else exploded = true;
    }

    // measure the damage curve on open ground
    const c = g.findSpawnPoint(30, 40);
    g.player.reset(c.x + 40, c.z);
    const marks = [0.5, 2, 4, 8].map((d) => {
      const e = g.spawnEnemy('raider');
      e.pos.set(c.x + d, 0, c.z);
      e.group.position.copy(e.pos);
      e.nextFire = 1e9;
      return { d, e, before: e.hp };
    });
    g.explode(new (g.player.position.constructor)(c.x, 0.1, c.z));
    const curve = marks.map((m) => ({ d: m.d, dealt: Math.round(m.before - m.e.hp) }));

    return { nadesBefore, nadesAfter: g.nades, travelled: +travelled.toFixed(1), exploded, curve };
  });
  expect(r.nadesAfter === r.nadesBefore - 1, 'throwing did not consume a frag');
  expect(r.travelled > 6, `grenade only travelled ${r.travelled} m`);
  expect(r.exploded, 'the fuse never ran out');
  const [near, mid, out, far] = r.curve.map((c) => c.dealt);
  expect(near > mid && mid > out && out > far, `damage curve not monotonic: ${JSON.stringify(r.curve)}`);
  expect(far === 0, `a hostile 8 m away still took ${far}`);
  return r;
});

check('a cooked frag detonates in hand', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    g.cookStart = g.time;                          // pin out, never released
    for (let f = 0; f < 60 * 6; f++) { g.time += 1 / 60; g.step(1 / 60); }
    return { hp: Math.round(g.player.health), nades: g.nades, cooking: g.cookStart >= 0 };
  });
  expect(r.hp < 100, 'holding a live grenade cost nothing');
  expect(!r.cooking, 'the cook state was never cleared');
  return r;
});

check('stairs carry the player onto a perch', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;

    const report = [];
    for (const perch of g.perches.slice(0, 8)) {
      // a stair run reads as a low step a few metres out along one axis
      let approach = null;
      for (const [ax, az] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        for (let d = 5; d < 16; d++) {
          const h = g.world.groundHeight(perch.x + ax * d, perch.z + az * d, 0.42, 99);
          if (h > 0.2 && h < 0.55) { approach = { ax, az, d }; break; }
        }
        if (approach) break;
      }
      if (!approach) continue;

      const start = approach.d + 4;
      g.player.reset(perch.x + approach.ax * start, perch.z + approach.az * start);
      g.player.yaw = Math.atan2(-(perch.x - g.player.position.x), -(perch.z - g.player.position.z));
      g.input.keys.clear(); g.input.keys.add('KeyW');
      let maxY = 0;
      for (let f = 0; f < 60 * 10; f++) {
        g.time += 1 / 60; g.step(1 / 60);
        maxY = Math.max(maxY, g.player.feetY);
      }
      g.input.keys.clear();
      report.push({ top: +perch.y.toFixed(2), reached: +maxY.toFixed(2), ok: maxY >= perch.y - 0.7 });
    }
    return { tested: report.length, climbed: report.filter((x) => x.ok).length, report };
  });
  expect(r.tested >= 3, `only ${r.tested} perches had a findable stair run`);
  expect(r.climbed / r.tested >= 0.7,
    `only ${r.climbed}/${r.tested} perches were walkable: ${JSON.stringify(r.report)}`);
  return { tested: r.tested, climbed: r.climbed };
});

check('long falls hurt, short drops do not', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const drop = (h) => {
      g.startRun();
      g.input.locked = true;
      g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
      g.player.reset(0, 0);
      g.player.feetY = h;
      g.player.velocity.y = 0;
      for (let f = 0; f < 60 * 6; f++) { g.time += 1 / 60; g.step(1 / 60); }
      return Math.round(g.player.health);
    };
    return { short: drop(3), long: drop(24) };
  });
  expect(r.short === 100, `a 3 m drop cost ${100 - r.short} health`);
  expect(r.long < 60, `a 24 m fall only cost ${100 - r.long} health`);
  return r;
});

check('marksmen take a perch and telegraph with a laser', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false; g.waveHpScale = 1;

    // marksmen should claim high ground and stay on it
    const squad = [];
    for (let i = 0; i < 5; i++) squad.push(g.spawnEnemy('marksman'));
    // hold their fire: this phase is about whether they stay on the perch,
    // and a squad of snipers will otherwise kill the player and end the run
    for (const e of squad) e.nextFire = 1e9;
    const perchedAtSpawn = squad.filter((e) => e.pos.y > 1.5).length;
    for (let f = 0; f < 60 * 6; f++) { g.time += 1 / 60; g.step(1 / 60); }
    const stillPerched = squad.filter((e) => e.pos.y > 1.5).length;
    for (const e of squad) e.alive = false;
    g.player.reset(g.player.position.x, g.player.position.z);
    g.state = 'playing';

    // put another on open ground with clear sight, and watch the beam
    const V = g.player.position.constructor;
    const { target: spot, px, pz } = window.__place(22);
    g.player.reset(px, pz);
    const m = g.spawnEnemy('marksman');
    m.pos.set(spot.x, 0, spot.z);
    m.group.position.copy(m.pos);
    m.alerted = true;
    // per-instance copy with no spread, so "does a shot land" does not ride on
    // the accuracy roll — the spread itself is not what this check is about
    // pinned and perfectly accurate: this check is about the telegraph and
    // the shot connecting, not about wandering or the spread roll
    m.type = { ...m.type, accuracy: 0, speed: 0 };

    let sawBeam = false, worstAim = 0;
    for (let f = 0; f < 60 * 12; f++) {
      g.time += 1 / 60; g.step(1 / 60);
      const beam = m.parts.beam;
      if (!beam.visible) continue;
      sawBeam = true;
      const origin = beam.getWorldPosition(new V());
      const toTip = beam.localToWorld(new V(0, 0, 1)).sub(origin).normalize();
      const toPlayer = g.player.position.clone().sub(origin).normalize();
      worstAim = Math.max(worstAim, Math.acos(Math.min(1, toTip.dot(toPlayer))));
    }
    return {
      perchedAtSpawn, stillPerched, sawBeam, worstAim: +worstAim.toFixed(3),
      playerHp: Math.round(g.player.health),
    };
  });
  expect(r.perchedAtSpawn >= 3, `only ${r.perchedAtSpawn}/5 marksmen took high ground`);
  expect(r.stillPerched === r.perchedAtSpawn,
    `${r.perchedAtSpawn - r.stillPerched} marksmen wandered off their perch`);
  expect(r.sawBeam, 'the aiming laser never showed');
  expect(r.worstAim < 0.05, `laser pointed ${r.worstAim} rad off target`);
  expect(r.playerHp < 100, 'the marksman never landed a shot');
  return r;
});

check('warlord waves spawn an elite with a health bar', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.waveHpScale = 1;
    const plain = g.spawnEnemy('brute');
    const boss = g.spawnEnemy('brute', true);
    for (let f = 0; f < 60; f++) { g.time += 1 / 60; g.step(1 / 60); }
    return {
      plainHp: plain.hp, bossHp: boss.hp, elite: boss.elite,
      scale: +boss.group.scale.x.toFixed(2),
      name: boss.displayName, score: boss.scoreValue,
      tracked: g.boss === boss,
      barVisible: !document.getElementById('boss-bar').classList.contains('hidden'),
    };
  });
  expect(r.elite && r.tracked, 'the elite was not registered as the boss');
  expect(r.bossHp > r.plainHp * 2, `elite hp ${r.bossHp} vs plain ${r.plainHp}`);
  expect(r.scale > 1.3, `elite is not visibly larger (scale ${r.scale})`);
  expect(r.name === 'WARLORD' && Number.isFinite(r.score), `bad display fields: ${r.name}/${r.score}`);
  expect(r.barVisible, 'the boss health bar stayed hidden');
  return r;
});

check('a scripted run reaches wave 3 without stalling', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    for (const w of g.weapons.weapons) w.unlocked = true;

    const dt = 1 / 60;
    let unstick = 0, cookRelease = 0, blind = 0;
    const waveAt = [];
    let lastProgress = 0, longestStall = 0;
    let contactAt = 0, noContact = 0;

    for (let f = 0; f < 60 * 240; f++) {
      g.time += dt;
      g.input.keys.clear();

      let nearest = null, nd = 1e9;
      for (const e of g.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.pos.x - g.player.position.x, e.pos.z - g.player.position.z);
        if (d < nd) { nd = d; nearest = e; }
      }
      if (nearest) {
        const dx = nearest.pos.x - g.player.position.x, dz = nearest.pos.z - g.player.position.z;
        g.player.yaw = Math.atan2(-dx, -dz);
        g.player.pitch = Math.atan2((nearest.pos.y + 1.3) - g.player.position.y, Math.hypot(dx, dz));
        const canSee = g.world.lineOfSight(
          g.player.position.x, g.player.position.y, g.player.position.z,
          nearest.pos.x, nearest.pos.y + 1.3, nearest.pos.z);
        g.input.fire = nd < 45 && canSee;
        blind = canSee ? 0 : blind + 1;
        // a person pinned behind cover flanks or backs off; walking into the
        // wall forever is a limitation of the bot, not of the game
        if (blind > 90) {
          g.input.keys.add(f % 200 < 100 ? 'KeyA' : 'KeyD');
          if (blind > 300) g.input.keys.add('KeyS');
        } else if (nd > 10 || !canSee) {
          g.input.keys.add('KeyW');
        }
        if (Math.hypot(g.player.velocity.x, g.player.velocity.z) < 0.5) unstick = 40;
        if (unstick > 0) { unstick--; g.input.keys.add(f % 240 < 120 ? 'KeyA' : 'KeyD'); }
        if (nd < 3) g.weapons.startMelee(g.time);
        if (g.cookStart < 0 && g.nades > 0 && nd > 8 && nd < 22) { g.cookStart = g.time; cookRelease = f + 40; }
      } else {
        g.input.keys.add('KeyW');
        g.input.fire = false;
      }
      if (cookRelease && f >= cookRelease) { g.throwGrenade(); cookRelease = 0; }
      if (g.weapons.current.mag === 0) g.weapons.startReload(g.time);

      g.player.health = 100; g.player.dead = false;   // immortal: we test the loop, not the bot
      g.step(dt);
      g.input.endFrame();

      if (!Number.isFinite(g.score)) return { scoreBroke: true, at: f / 60 };

      if (g.kills > lastProgress) { lastProgress = g.kills; longestStall = Math.max(longestStall, f); }
      if (waveAt.length < g.wave) waveAt.push(+(f / 60).toFixed(1));

      // the property that matters: while hostiles are alive, some of them
      // keep reaching the player. A bot that cannot shoot is not a stall.
      if (g.aliveCount === 0) contactAt = f;
      else {
        for (const e of g.enemies) {
          if (!e.alive) continue;
          const close = Math.hypot(e.pos.x - g.player.position.x, e.pos.z - g.player.position.z) < 14;
          // holding overwatch with a clear shot counts as engaging
          const shooting = e.alerted && g.world.lineOfSight(
            e.pos.x, e.pos.y + 1.5, e.pos.z,
            g.player.position.x, g.player.position.y, g.player.position.z);
          if (close || shooting) { contactAt = f; break; }
        }
      }
      noContact = Math.max(noContact, (f - contactAt) / 60);
    }

    const stallSeconds = (60 * 240 - longestStall) / 60;
    return {
      wave: g.wave, kills: g.kills, score: g.score, waveAt,
      stallSeconds: +stallSeconds.toFixed(1), noContact: +noContact.toFixed(1),
    };
  });
  expect(!r.scoreBroke, `score stopped being a number at t=${r.at}s`);
  expect(r.wave >= 3, `only reached wave ${r.wave} in four minutes`);
  expect(r.kills > 20, `only ${r.kills} kills`);
  expect(Number.isFinite(r.score) && r.score > 0, `bad score ${r.score}`);
  // Healthy runs still show gaps: a cleared wave, the intermission, then the
  // next group walking in from 30-60 m out. A real stall never recovers.
  expect(r.noContact < 90,
    `hostiles failed to reach the player for ${r.noContact}s — a wave stalled`);
  return r;
});

check('settings and records survive a reload', async (page) => {
  await page.evaluate(() => {
    const g = window.__game;
    g.settings.sens = 175; g.settings.volume = 40; g.settings.invertY = true;
    g.applySettings(); g.saveSettings();
    g.score = 4321; g.wave = 6;
    g.gameOver();
  });
  await reloadGame();                        // same URL, so the seed carries
  const r = await page.evaluate(() => {
    const g = window.__game;
    return {
      seed: g.seed,
      sens: g.settings.sens, volume: g.settings.volume, invertY: g.input.invertY,
      records: g.records, shown: document.getElementById('records').textContent.trim(),
    };
  });
  expect(r.sens === 175 && r.volume === 40 && r.invertY, `settings did not persist: ${JSON.stringify(r)}`);
  expect(r.records.bestScore === 4321 && r.records.bestWave === 6, `records did not persist: ${JSON.stringify(r.records)}`);
  expect(r.shown.includes('4,321'), `menu does not show the record: "${r.shown}"`);
  return r;
});

/* ------------------------------------------------------------------ runner */

let reloadGame;
class Failure extends Error {}
function expect(cond, message) {
  if (!cond) throw new Failure(message);
}

async function screenshots(page) {
  await mkdir(SHOT_DIR, { recursive: true });
  await page.evaluate(() => { window.__game.startRun(); window.__game.input.locked = true; });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: SHOT_DIR + 'plaza.png' });
  console.log('  wrote tests/shots/plaza.png');
}

console.log(`seed ${SEED}\n`);
const game = await openGame({ seed: SEED, port: PORT, headed: HEADED });
const { page, errors: pageErrors } = game;
// checks that need a mid-check reload go through the harness, so the seed,
// the freeze and the injected helpers all survive it
reloadGame = game.reload;

let failed = 0;

for (const { name, fn } of checks) {
  // Every check gets a freshly booted game on the same seed. Sharing one
  // instance made results depend on what the previous check left behind.
  await game.reload();
  const before = pageErrors.length;
  try {
    const detail = await fn(page);
    const errs = pageErrors.slice(before);
    if (errs.length) throw new Failure(`page errors: ${[...new Set(errs)].join(' | ')}`);
    console.log(`  ok   ${name}${detail ? '  ' + JSON.stringify(detail).slice(0, 120) : ''}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
    if (!(err instanceof Failure)) console.log(err.stack?.split('\n').slice(1, 4).join('\n'));
  }
}

if (SHOTS) {
  console.log('\nscreenshots:');
  await game.reload({ freeze: false });
  await screenshots(page);
}

await game.close();

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
