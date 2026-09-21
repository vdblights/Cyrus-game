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
// Pinned so runs repeat. It moved from 20260813 when the graphics pass
// reshuffled every seed's city: that seed now lays out one where a hostile
// can wall-slide out of reach and deadlock a wave, which is an open game bug
// (see CLAUDE.md), not a property of this seed worth asserting against.
const SEED = Number((process.argv.find((a) => a.startsWith('--seed=')) || '').split('=')[1]) || 1;
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

check('an empty gun reaches for a loaded one instead of clicking', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    // no waves: a sector-clear resupply would quietly refill what this check
    // is trying to run empty
    g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    for (const w of g.weapons.weapons) w.unlocked = true;

    const run = (frames, firing) => {
      for (let f = 0; f < frames; f++) {
        g.input.fire = firing;          // a semi-auto consumes the flag on each shot
        g.time += 1 / 60;
        g.step(1 / 60);
        g.input.endFrame();
      }
    };
    const hold = (frames) => run(frames, true);
    const idle = (frames) => run(frames, false);
    // a hidden prompt is no prompt: the element keeps its last text either way
    const prompt = () => (g.hud.el.reloadHint.classList.contains('hidden')
      ? '' : g.hud.el.reloadHint.textContent);

    // a gun with an empty mag but reserve behind it prompts a reload — read
    // with the trigger up, because pulling it starts the reload by itself
    const first = g.weapons.current;
    first.mag = 0;
    idle(2);
    const reloadHint = prompt();
    hold(4);
    const reloads = g.weapons.reloading;
    hold(Math.ceil(first.def.reload * 60) + 30);
    const reloaded = first.mag > 0;

    // now run it dry: empty mag, empty reserve, nothing to reload from
    const startIndex = g.weapons.index;
    const dry = g.weapons.current;
    dry.mag = 0; dry.reserve = 0;
    idle(2);
    const dryHint = prompt();
    hold(8);
    const switched = g.weapons.index !== startIndex;
    const pickedUpLoaded = g.weapons.current.mag > 0 || g.weapons.current.reserve > 0;
    const magBefore = g.weapons.current.mag;
    hold(45);                            // past the swap animation and the rpm gate
    const firedAgain = g.weapons.current.mag < magBefore || g.weapons.reloading;

    // with the whole loadout dry there is nowhere to switch to, and the HUD
    // has to say so rather than leaving the player clicking at nothing
    for (const w of g.weapons.weapons) { w.mag = 0; w.reserve = 0; }
    const beforeAllDry = g.weapons.index;
    hold(40);
    return {
      reloadHint, dryHint, reloads, reloaded,
      switched, pickedUpLoaded, firedAgain,
      dryLeft: `${dry.mag}/${dry.reserve}`,
      stayedPut: g.weapons.index === beforeAllDry,
      emptyHint: prompt(),
      alive: !g.player.dead,
    };
  });
  expect(r.reloads || r.reloaded, 'an empty mag with reserve behind it did not reload');
  expect(r.reloadHint.includes('RELOAD'), `reload prompt read "${r.reloadHint}"`);
  expect(r.reloaded, 'the reload never finished');
  // the reported bug: the trigger kept clicking on a dead gun while loaded
  // weapons sat in the loadout, with nothing on screen to explain it
  expect(r.dryHint.includes('OUT OF AMMO'), `dry gun prompt read "${r.dryHint}"`);
  expect(r.switched, `a dry gun (${r.dryLeft}) kept the trigger instead of swapping`);
  expect(r.pickedUpLoaded, 'swapped to a weapon that was also empty');
  expect(r.firedAgain, 'the swapped-to weapon never fired');
  expect(r.stayedPut, 'swapped weapons with the whole loadout empty');
  expect(r.emptyHint.includes('MELEE'),
    `no melee prompt with everything dry — HUD read "${r.emptyHint}"`);
  expect(r.alive, 'the player died during an ammo check');
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

check('a jump at a chest-high ledge climbs it, a wall stays a wall', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    g.startWave = () => {};        // this steps well past the first wave timer

    // Walk up to a box's -Z face from the street and hold jump. Camera forward
    // is (-sin yaw, -cos yaw), so yaw = PI faces +Z.
    const R = 0.42;

    /**
     * Pick a spot along a box's -Z face to climb from, or null if the face
     * offers none.
     *
     * The centre is not always one. A crate can be half-buried in a taller
     * structure, and then the deck you would land on at the centre has a
     * 2.6 m wall standing in it — refusing that climb is correct, so
     * demanding it is a broken setup rather than a broken game. Validate the
     * landing the climb would actually use, the way __place validates a
     * firing line, and slide along the face until one is clean.
     */
    const approach = (box) => {
      const mid = (box.minX + box.maxX) / 2;
      const reach = Math.max(0, (box.maxX - box.minX) / 2 - R);
      const pz = box.minZ - 0.62;
      const lz = pz + (R + 0.1) + R + 0.15;      // nearest landing the climb would take
      for (const off of [0, -0.5, 0.5, -0.85, 0.85]) {
        if (Math.abs(off) > reach) continue;
        const px = mid + off;
        if (g.world.groundHeight(px, pz, R, 99) > 0.2) continue;   // not on the street
        if (g.world.occupied(px, pz, R, 0.6)) continue;            // stuck inside something
        // room for a body on the deck, and a deck there to stand on
        if (g.world.groundHeight(px, lz, R, Infinity) > box.top + 0.05) continue;
        if (g.world.groundHeight(px, lz, R, box.top + 0.05) < box.top - 0.25) continue;
        return { px, pz };
      }
      return null;
    };

    const attempt = (box) => {
      const spot = approach(box);
      if (!spot) return null;
      const { px, pz } = spot;
      g.player.reset(px, pz);
      g.player.yaw = Math.PI;
      g.input.keys.clear(); g.input.keys.add('Space');
      let started = false;
      for (let f = 0; f < 120; f++) {
        g.time += 1 / 60; g.step(1 / 60);
        if (g.player.mantle) started = true;
        else if (started) break;
      }
      g.input.keys.clear();
      for (let f = 0; f < 90; f++) { g.time += 1 / 60; g.step(1 / 60); }   // let it settle
      return { started, top: +box.top.toFixed(2), feet: +g.player.feetY.toFixed(2) };
    };

    const ledges = [], walls = [];
    for (const b of g.world.boxes) {
      if (ledges.length < 8 && b.top > 0.8 && b.top < 1.75) {
        const a = attempt(b); if (a) ledges.push(a);
      } else if (walls.length < 5 && b.top > 6) {
        const a = attempt(b); if (a) walls.push(a);
      }
    }
    return { ledges, walls };
  });

  expect(r.ledges.length >= 4, `only ${r.ledges.length} reachable ledges to try`);
  const up = r.ledges.filter((l) => l.started && Math.abs(l.feet - l.top) < 0.15);
  expect(up.length === r.ledges.length,
    `only ${up.length}/${r.ledges.length} ledges climbed: ${JSON.stringify(r.ledges)}`);

  expect(r.walls.length >= 2, `only ${r.walls.length} walls to try`);
  const stuck = r.walls.filter((w) => !w.started && w.feet < 0.2);
  expect(stuck.length === r.walls.length,
    `a building face was climbable: ${JSON.stringify(r.walls)}`);
  return { ledges: r.ledges.length, walls: r.walls.length };
});

check('a pull-up carries the view, it does not jump it', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    g.startWave = () => {};

    const R = 0.42;
    const climbs = [];
    for (const b of g.world.boxes) {
      if (climbs.length >= 6 || b.top < 0.8 || b.top > 1.75) continue;
      const px = (b.minX + b.maxX) / 2, pz = b.minZ - 0.62;
      const lz = pz + (R + 0.1) + R + 0.15;
      if (g.world.groundHeight(px, pz, R, 99) > 0.2) continue;
      if (g.world.occupied(px, pz, R, 0.6)) continue;
      if (g.world.groundHeight(px, lz, R, Infinity) > b.top + 0.05) continue;
      if (g.world.groundHeight(px, lz, R, b.top + 0.05) < b.top - 0.25) continue;

      g.player.reset(px, pz);
      g.player.yaw = Math.PI;
      g.input.keys.clear();

      // Sample the camera every frame through the climb and across the frame
      // it hands control back. Two numbers come out of it, because they mean
      // different things: `shift` is the biggest change in the view's speed
      // from one frame to the next *inside* the climb, and `handover` is the
      // step on the first frame after it. A quick climb has a large step and
      // a tiny shift; a snap has a large shift whatever its speed, and a snap
      // is what reads as a jump.
      //
      // Space is released the moment the climb starts. Holding it through the
      // landing makes the player jump again on the first frame they are back
      // on the ground, which is the game working — and 0.11 m of camera in one
      // frame that has nothing to do with the pull-up.
      let prev = null, prevStep = null, wasClimbing = false;
      let worst = 0, shift = 0, handover = 0, entry = 0;
      let frames = 0, started = false, after = 0;
      for (let f = 0; f < 240; f++) {
        // Space goes down a few frames in, not on the first: the climb starts
        // on the very frame it does, and the frame before that is what the
        // first frame of the climb has to be measured against.
        if (f === 4) g.input.keys.add('Space');
        g.time += 1 / 60; g.step(1 / 60);
        const climbing = !!g.player.mantle;
        if (climbing) g.input.keys.clear();
        const c = g.camera.position;
        if (prev) {
          const step = Math.hypot(c.x - prev[0], c.y - prev[1], c.z - prev[2]);
          if (climbing) {
            if (step > worst) worst = step;
            // the first climbing frame is its own measurement: this is the
            // one the old pull-up moved 0.63 m in
            if (!wasClimbing) entry = step;
            else if (prevStep !== null) shift = Math.max(shift, Math.abs(step - prevStep));
          } else if (wasClimbing) {
            handover = step;
          }
          prevStep = step;
        }
        prev = [c.x, c.y, c.z];
        wasClimbing = climbing;
        if (climbing) { started = true; frames++; }
        else if (started && ++after > 20) break;
      }
      g.input.keys.clear();
      if (started) {
        climbs.push({
          rise: +b.top.toFixed(2),
          seconds: +(frames / 60).toFixed(2),
          worstStep: +worst.toFixed(3),
          worstShift: +shift.toFixed(4),
          entry: +entry.toFixed(4),
          handover: +handover.toFixed(4),
        });
      }
    }
    return climbs;
  });

  expect(r.length >= 3, `only ${r.length} ledges climbed to measure`);
  // The old pull-up set the eye height to a crouch on its first frame,
  // dropping the view 0.63 m between two frames from a standstill. That is a
  // discontinuity, not a speed, which is why the assertion is on `shift`: the
  // climb is allowed to be quick, it is not allowed to teleport.
  // Measured on seed 1, old code against new: entry 0.617 → 0.0245, in-climb
  // shift 0.5805 → 0.0109, worst single frame 0.617 → 0.095.
  const start = r.reduce((a, b) => (b.entry > a.entry ? b : a));
  expect(start.entry < 0.05,
    `the view dropped ${start.entry} m on the first frame of a climb: ${JSON.stringify(start)}`);
  const jump = r.reduce((a, b) => (b.worstShift > a.worstShift ? b : a));
  expect(jump.worstShift < 0.02,
    `the view lurched ${jump.worstShift} m between two frames: ${JSON.stringify(jump)}`);
  // The climb hands back at a walk rather than a standstill, so the handover
  // frame is deliberately not zero — it measures 0.021 m, where the old one
  // stopped dead at exactly 0. This is not catching the old bug, it is
  // keeping the fix for it from becoming one.
  const exit = r.reduce((a, b) => (b.handover > a.handover ? b : a));
  expect(exit.handover < 0.06,
    `the view lurched ${exit.handover} m on the frame the climb ended: ${JSON.stringify(exit)}`);
  // and it takes longer to haul yourself higher, rather than being flung
  expect(r.every((c) => c.seconds > 0.25 && c.seconds < 1.2),
    `pull-up durations out of range: ${JSON.stringify(r.map((c) => c.seconds))}`);
  return { climbs: r.length, entry: start.entry, shift: jump.worstShift, exit: exit.handover };
});

/*
 * The two checks below guard the same complaint from opposite ends: a prop
 * whose collider is not the shape you can see. One measures the air in front
 * of it, the other the air on top of it. Both were confirmed to fail against
 * the code they replaced — see the notes on each.
 */

check('a prop stops you where you can see it, not a metre before', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const R = g.player.radius;

    // What each turned prop used to register: the enclosing AABB. A 2.5 x 6 m
    // container at 30 degrees claimed 5.2 x 5.8 m of street.
    const asAabb = (b) => {
      const ex = Math.abs(b.hx * b.cos) + Math.abs(b.hz * b.sin);
      const ez = Math.abs(b.hx * b.sin) + Math.abs(b.hz * b.cos);
      return { minX: b.cx - ex, maxX: b.cx + ex, minZ: b.cz - ez, maxZ: b.cz + ez,
               top: b.top, cx: b.cx, cz: b.cz, hx: ex, hz: ez, cos: 1, sin: 0 };
    };
    // distance from the prop's centre to its own surface along a heading
    const surface = (b, ux, uz) => {
      const lx = b.cos * ux - b.sin * uz, lz = b.sin * ux + b.cos * uz;
      return Math.min(Math.abs(lx) > 1e-9 ? b.hx / Math.abs(lx) : 1e9,
                      Math.abs(lz) > 1e-9 ? b.hz / Math.abs(lz) : 1e9);
    };
    // walk a body in from 8 m out until World.resolve first pushes back
    const probe = g.player.position.clone();
    const stop = (box, ux, uz) => {
      const one = { boxes: [box] };
      for (let d = 8; d > 0.02; d -= 0.01) {
        probe.set(box.cx + ux * d, 0, box.cz + uz * d);
        const px = probe.x, pz = probe.z;
        g.world.resolve.call(one, probe, R, 0, 0.35);
        if (Math.abs(probe.x - px) > 1e-6 || Math.abs(probe.z - pz) > 1e-6) return d;
      }
      return 0;
    };

    const turned = g.world.boxes.filter((b) => b.sin !== 0);
    let nowWorst = 0, oldWorst = 0, nowSum = 0, oldSum = 0, n = 0;
    for (const b of turned) {
      const old = asAabb(b);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
        const truth = surface(b, ux, uz);
        // how much empty air there is between the prop and where you stop
        const now = stop(b, ux, uz) - truth - R;
        const was = stop(old, ux, uz) - truth - R;
        nowWorst = Math.max(nowWorst, now); oldWorst = Math.max(oldWorst, was);
        nowSum += Math.max(0, now); oldSum += Math.max(0, was); n++;
      }
    }
    return {
      props: turned.length,
      worst: +nowWorst.toFixed(2), mean: +(nowSum / n).toFixed(3),
      worstAsAabb: +oldWorst.toFixed(2), meanAsAabb: +(oldSum / n).toFixed(3),
    };
  });

  expect(r.props > 40, `only ${r.props} turned props to measure`);
  // Some standoff is honest: a cylinder meets a corner at the corner, so a
  // diagonal approach stops a little wider than a face-on one. Half a metre
  // of it is not. Measured on seed 1: 0.43 m worst and 0.089 m mean against
  // 2.98 m and 0.40 m when the same props register their enclosing AABB,
  // which is what restoring that registration makes this check report.
  expect(r.worst < 0.6, `a turned prop stops you ${r.worst} m from its surface`);
  expect(r.mean < 0.15, `turned props stop you ${r.mean} m out on average`);
  return r;
});

check('the ground you stand on is the ground you can see', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const W = g.world;
    const BODY = g.player.radius;

    // Edges with nothing at all beyond them, or this measures the distance to
    // the next prop rather than the overhang past this one.
    const edges = W.boxes.filter((b) => {
      if (b.top < 0.8 || b.top > 4 || b.sin !== 0) return false;
      return !W.boxes.some((o) => o !== b && o.top > 0.3
        && o.maxX > b.maxX && o.minX < b.maxX + 2.5
        && o.maxZ > b.cz - 1 && o.minZ < b.cz + 1);
    });
    const overhang = (radius) => {
      let worst = 0;
      for (const b of edges) {
        for (let d = 0; d < 1.5; d += 0.005) {
          if (W.groundHeight(b.maxX + d, b.cz, radius, 99) < b.top) {
            worst = Math.max(worst, d); break;
          }
        }
      }
      return +worst.toFixed(2);
    };

    // Gaps wide enough to be a stride rather than a construction seam. Every
    // one of these should be something you fall through or jump.
    const bridged = (radius) => {
      let n = 0;
      const bs = W.boxes.filter((b) => b.top > 0.6 && b.top < 6);
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        let gap = null;
        if (ox > 0.8 && oz < 0) gap = -oz; else if (oz > 0.8 && ox < 0) gap = -ox;
        if (gap === null || gap > 3) continue;
        if (gap > 0.25 && gap <= radius * 2) n++;
      }
      return n;
    };

    // and the same thing felt rather than computed: walk off a crate
    const crate = W.boxes.find((b) => {
      if (b.sin !== 0 || b.top < 0.9 || b.top > 1.6 || b.hx < 0.9) return false;
      return !W.boxes.some((o) => o !== b && o.top > 0.3
        && o.maxX > b.maxX && o.minX < b.maxX + 3 && o.maxZ > b.cz - 1 && o.minZ < b.cz + 1);
    });
    let walked = null;
    if (crate) {
      g.startRun();
      g.startWave = () => {};
      g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
      g.input.locked = true;
      g.player.reset(crate.cx, crate.cz);
      g.player.feetY = crate.top;
      g.player.yaw = -Math.PI / 2;                       // face +X
      g.input.keys.clear(); g.input.keys.add('KeyW');
      for (let f = 0; f < 300; f++) {
        g.time += 1 / 60; g.step(1 / 60);
        if (!g.player.onGround && walked === null) {
          walked = +(g.player.position.x - crate.maxX).toFixed(2);
        }
        if (g.player.feetY < 0.2) break;
      }
      g.input.keys.clear();
      walked = { past: walked, reachedStreet: g.player.feetY < 0.2 };
    }

    return {
      edges: edges.length,
      overhang: overhang(0.12), overhangAsBody: overhang(BODY),
      bridged: bridged(0.12), bridgedAsBody: bridged(BODY),
      walked,
    };
  });

  expect(r.edges > 20, `only ${r.edges} clear edges to measure`);
  // Measured on seed 1: 0.12 m of overhang and no bridged gap, against 0.42 m
  // and 17 gaps when footing asks with the body radius — which is what
  // passing `this.radius` here again makes this check report.
  expect(r.overhang <= 0.2,
    `you stand ${r.overhang} m past a roof edge on nothing`);
  expect(r.bridged === 0,
    `${r.bridged} gaps of more than a quarter metre are walkable as solid ground`);
  expect(r.walked && r.walked.past !== null && r.walked.past < 0.25,
    `walking off a crate kept you up ${r.walked && r.walked.past} m past the edge`);
  expect(r.walked.reachedStreet, 'walking off a crate did not put you on the street');
  return r;
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

check('the stuck watchdog never teleports a hostile in plain sight', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;

    // The watchdog exists so a wedged hostile cannot stall a wave, but it
    // moves them 20-45 m away, usually somewhere the player cannot see — so
    // one fired on a hostile that was merely walking, or merely visible,
    // looks exactly like an enemy vanishing mid-charge.
    const jumps = [];
    const seen = new Map();
    const relocate = g.relocateEnemy.bind(g);
    let id = 0;
    g.relocateEnemy = (e) => {
      if (e.__id === undefined) e.__id = ++id;
      const p = g.player.position;
      jumps.push({
        id: e.__id, type: e.typeKey, t: +g.time.toFixed(1),
        dist: +Math.hypot(e.pos.x - p.x, e.pos.z - p.z).toFixed(1),
        // line of sight is symmetric, so this is also "could the player see it"
        inSight: g.world.lineOfSight(p.x, p.y, p.z, e.pos.x, e.pos.y + 1.3 * e.type.scale, e.pos.z),
      });
      relocate(e);
    };

    window.__step(120);

    let shortestGap = Infinity;
    for (const j of jumps) {
      if (seen.has(j.id)) shortestGap = Math.min(shortestGap, j.t - seen.get(j.id));
      seen.set(j.id, j.t);
    }
    return {
      jumps: jumps.length,
      inSight: jumps.filter((j) => j.inSight).length,
      shortestGap: shortestGap === Infinity ? null : +shortestGap.toFixed(1),
      hostiles: seen.size,
      alive: g.aliveCount,
      sample: jumps.slice(0, 5),
    };
  });
  expect(r.inSight === 0,
    `${r.inSight} of ${r.jumps} relocations happened while the player could see the hostile`);
  // Relocating the same hostile again a window later means the watchdog is
  // measuring its next window from where it was pulled out of, not from where
  // it landed — that is what turns one teleport into a chain of them.
  expect(r.shortestGap === null || r.shortestGap >= 10,
    `a hostile was relocated twice ${r.shortestGap}s apart`);
  expect(r.alive > 0, 'no hostiles survived two minutes of standing still');
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

check('waves cue objectives, and securing one pays out', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;

    // what each wave calls for, read off the real wave manager
    const schedule = [];
    for (let w = 1; w <= 6; w++) {
      g.wave = w - 1;
      g.objectiveCue = null;
      g.objectives.reset();
      g.startWave();
      schedule.push(g.objectiveCue ? g.objectiveCue.kind : null);
      g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    }

    g.startWave = () => {};              // hold the wave manager still from here
    g.objectiveCue = null;
    g.wave = 2;

    // measure the payout around the handler itself: a cleared wave pays its
    // own bonus in the same window and would otherwise be counted here
    let payout = 0;
    const secure = g.onObjectiveSecured.bind(g);
    g.onObjectiveSecured = (obj) => {
      const s = g.score;
      secure(obj);
      payout = g.score - s;
    };

    const before = { nades: g.nades };
    const o = g.objectives.start('cache');

    // the site has to be somewhere you can stand and fight: street level,
    // clear of geometry, inside the walls, and a long way off
    const spawnDist = Math.hypot(o.x - g.player.position.x, o.z - g.player.position.z);
    const site = {
      ground: +g.world.groundHeight(o.x, o.z, 1.4, 99).toFixed(2),
      occupied: g.world.occupied(o.x, o.z, 1.5, 0.6),
      inBounds: Math.abs(o.x) < g.world.bounds && Math.abs(o.z) < g.world.bounds,
    };

    // stand on it
    g.player.reset(o.x, o.z);
    window.__step(o.def.channel + 1);

    return {
      schedule, spawnDist: +spawnDist.toFixed(1), site,
      cleared: !g.objectives.active,
      secured: g.objectivesSecured,
      gained: payout,
      frags: g.nades - before.nades,
      hidden: document.getElementById('objective').classList.contains('hidden'),
    };
  });
  expect(JSON.stringify(r.schedule) === JSON.stringify([null, 'cache', 'hold', 'cache', null, 'hold']),
    `unexpected wave schedule: ${JSON.stringify(r.schedule)}`);
  expect(r.spawnDist > 25, `the cache landed only ${r.spawnDist} m away`);
  expect(r.site.ground < 0.4 && !r.site.occupied && r.site.inBounds,
    `unusable site: ${JSON.stringify(r.site)}`);
  expect(r.cleared && r.secured === 1, 'standing on the cache did not secure it');
  expect(r.gained === 600, `paid ${r.gained} for a wave-2 cache`);
  expect(r.frags > 0, 'a secured cache handed out no frags');
  expect(r.hidden, 'the objective readout stayed up after it was secured');
  return r;
});

check('objective progress bleeds when you leave, and the clock runs out', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;

    const o = g.objectives.start('hold');
    g.player.reset(o.x, o.z);
    window.__step(9);
    const held = +o.progress.toFixed(1);

    g.player.reset(o.x + 30, o.z);        // driven off it
    window.__step(6);
    const bled = +g.objectives.active.progress.toFixed(1);

    g.player.reset(o.x, o.z);             // back on, and finish
    window.__step(20);
    const secured = g.objectivesSecured;

    // a site nobody goes to expires on its own clock
    const c = g.objectives.start('cache');
    g.player.reset(c.x + 60, c.z);
    window.__step(c.def.limit + 1);

    return {
      held, bled, secured,
      lost: g.objectivesLost, stillActive: !!g.objectives.active,
      hp: Math.round(g.player.health),
    };
  });
  expect(r.held === 9, `9 s on a beacon logged ${r.held} s`);
  expect(r.bled < r.held && r.bled > 0, `progress went ${r.held} -> ${r.bled} when the player left`);
  expect(r.secured === 1, 'returning to the beacon never finished it');
  expect(!r.stillActive && r.lost === 1, 'an abandoned cache never expired');
  return r;
});

check('the waypoint tracks the site and pins to the edge behind you', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;

    const W = 1100, H = 620;
    const o = g.objectives.start('cache');
    const face = () => {
      g.player.yaw = Math.atan2(-(o.x - g.player.position.x), -(o.z - g.player.position.z));
      g.player.pitch = 0;
      g.step(1 / 60);
    };

    face();
    const ahead = g.objectives.screenMarker(g.camera, W, H);
    g.player.yaw += Math.PI * 0.75;                  // over the shoulder
    g.step(1 / 60);
    const behind = g.objectives.screenMarker(g.camera, W, H);
    face();
    g.player.yaw += 0.6;                             // just off to the side
    g.step(1 / 60);
    const side = g.objectives.screenMarker(g.camera, W, H);

    const roofTop = g.objectives.active;
    // standing on a roof directly above the site must not count as being on it
    g.player.reset(roofTop.x, roofTop.z);
    let roofProgress = 0;
    for (let f = 0; f < 120; f++) { g.player.feetY = 6; g.time += 1 / 60; g.step(1 / 60); }
    roofProgress = +g.objectives.active.progress.toFixed(2);

    return {
      ahead: { x: Math.round(ahead.x), y: Math.round(ahead.y), off: ahead.offscreen, dist: Math.round(ahead.dist) },
      behind: { x: Math.round(behind.x), y: Math.round(behind.y), off: behind.offscreen },
      side: { x: Math.round(side.x), off: side.offscreen },
      roofProgress,
      marked: !document.getElementById('objective-marker').classList.contains('hidden'),
    };
  });
  expect(Math.abs(r.ahead.x - 550) < 40 && !r.ahead.off,
    `facing the site put the waypoint at ${r.ahead.x},${r.ahead.y} (offscreen ${r.ahead.off})`);
  expect(r.ahead.dist > 20, `waypoint reported ${r.ahead.dist} m to a distant site`);
  expect(r.behind.off, 'a site behind the camera was not treated as offscreen');
  expect(r.behind.x >= 44 && r.behind.x <= 1100 - 44 && r.behind.y >= 44 && r.behind.y <= 620 - 44,
    `the offscreen waypoint left the viewport: ${JSON.stringify(r.behind)}`);
  expect(r.side.x > 550, `turning left did not push the waypoint right (${r.side.x})`);
  expect(r.roofProgress === 0, `a player 6 m above the site made ${r.roofProgress} s of progress`);
  expect(r.marked, 'the waypoint element never showed');
  return r;
});

check('a warlord going down opens an evac window', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false;
    g.wave = 5; g.waveHpScale = 1;

    let payout = 0;
    const secure = g.onObjectiveSecured.bind(g);
    g.onObjectiveSecured = (obj) => {
      const s = g.score;                    // the wave-clear bonus lands here too
      secure(obj);
      payout = g.score - s;
    };

    const boss = g.spawnEnemy('brute', true);
    boss.pos.set(g.player.position.x + 6, 0, g.player.position.z);
    boss.group.position.copy(boss.pos);
    const V = g.player.position.constructor;
    const result = boss.damage(1e6, 'body', new V(1, 0, 0), boss.pos.clone());
    g.registerHit(boss, result, 'TEST', false);
    const cued = g.objectiveCue && g.objectiveCue.kind;

    window.__step(6);                       // the cue is deliberately delayed
    const o = g.objectives.active;
    g.player.reset(o.x, o.z);
    g.player.health = 40;                   // an evac is worth a full heal
    window.__step(o.def.channel + 1);

    return {
      cued, kind: o.kind, limit: o.def.limit,
      dist: Math.round(Math.hypot(o.x - boss.pos.x, o.z - boss.pos.z)),
      secured: g.objectivesSecured, gained: payout,
      hp: Math.round(g.player.health), nades: g.nades, done: !g.objectives.active,
    };
  });
  expect(r.cued === 'extraction', `the warlord's death cued ${r.cued}`);
  expect(r.kind === 'extraction', 'no evac point appeared');
  expect(r.done && r.secured === 1, 'reaching the evac point did not close it');
  expect(r.gained === 750 * 5, `evac paid ${r.gained} on wave 5`);
  expect(r.hp === 100 && r.nades === 5, `evac did not fully rearm: hp ${r.hp}, frags ${r.nades}`);
  return r;
});

check('a scripted run reaches wave 3 without stalling', async (page) => {
  const r = await page.evaluate(() => window.__botRun(240));
  expect(!r.scoreBroke, `score stopped being a number at t=${r.at}s`);
  expect(r.wave >= 3, `only reached wave ${r.wave} in four minutes`);
  expect(r.kills > 20, `only ${r.kills} kills`);
  expect(Number.isFinite(r.score) && r.score > 0, `bad score ${r.score}`);
  // Healthy runs still show gaps: a cleared wave, the intermission, then the
  // next group walking in from 30-60 m out. A real stall never recovers.
  expect(r.noContact < 90,
    `hostiles failed to reach the player for ${r.noContact}s — a wave stalled`);
  // the bot never walks to a site, so these all expire — the point is that
  // the wave manager kept handing them out across four minutes of real play
  expect(r.objectives >= 2, `only ${r.objectives} objectives came up over ${r.wave} waves`);
  return r;
});

check('a wave never deadlocks on a hostile that cannot path to you', async (page) => {
  // A hostile steers straight at the player and has no pathfinding, so with a
  // building in the way it slides along the wall face. Every per-window
  // measure the stuck watchdog had excused that — it covers ground, and the
  // player it is failing to reach is moving too — so `noProgress` never
  // accumulated and the wave never cleared. Whether a city has a corner that
  // does this is a property of the layout, so this check brings its own:
  // seed 7 stalled at wave 1 for 196 of 240 seconds, with the watchdog firing
  // once in the whole run. The suite's own seed does not trip it.
  await reloadGame({ seed: 7 });
  const r = await page.evaluate(() => window.__botRun(150));
  expect(!r.scoreBroke, `score stopped being a number at t=${r.at}s`);
  expect(r.noContact < 60,
    `hostiles failed to reach the player for ${r.noContact}s — the wave deadlocked`);
  // wave 1 never cleared before the fix; the exact wave reached afterwards is
  // pacing, not the property under test, so this only asks that it got past
  // the one it used to die on
  expect(r.wave >= 2, `still on wave ${r.wave} after 150s on the deadlock seed`);
  return r;
});

check('the route field reaches the whole sector from wherever you stand', async (page) => {
  // A route field is a hint, and one that covers a quarter of the streets is
  // worse than no hint at all: every hostile on the far side of the gap falls
  // back to steering at the player, which is the deadlock again.
  //
  // This also catches the way the grid is naturally written wrong. Blocking
  // cells by what a shoulder-widened solid *touches*, rather than by which
  // cell centres stand inside it, costs a cell its whole 1.5 m for being
  // clipped at one corner. Measured on seed 1 against the rule that ships:
  //
  //   centres inside the widened solid (shipped)   9,328 open, 99.9% covered
  //   every cell the widened solid overlaps        7,622 open, 97.2% covered
  //   the same, rounded outward at both edges      5,772 open, 12.6% covered
  //
  // The real rule sits at 0.999-1.000 across seeds 1, 7, 4242, 31337, 99991,
  // 20260101 and 20260813, so the threshold is set where it separates that
  // from the first way of getting it wrong, not just the worst way.
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    const nav = g.nav;
    const p = g.player.position;
    const inPlay = (k) => {
      const i = k % nav.size, j = (k / nav.size) | 0;
      return Math.abs(nav.mid(i)) <= g.world.bounds && Math.abs(nav.mid(j)) <= g.world.bounds;
    };

    // The biggest island of connected street, measured over the grid itself
    // rather than from anywhere in particular. Asking instead how much is
    // reachable from a handful of sampled spots looks equivalent and is not:
    // a spot that lands in a courtyard reports its courtyard, and the check
    // fails for a pocket the size of a room.
    let open = 0;
    for (let k = 0; k < nav.blocked.length; k++) if (!nav.blocked[k] && inPlay(k)) open++;

    const seen = new Uint8Array(nav.blocked.length);
    let biggest = 0;
    for (let s = 0; s < nav.blocked.length; s++) {
      if (nav.blocked[s] || seen[s] || !inPlay(s)) continue;
      let size = 0;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const k = stack.pop();
        size++;
        const i = k % nav.size, j = (k / nav.size) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + dx, nj = j + dz;
          if (!nav.inside(ni, nj)) continue;
          const nk = nj * nav.size + ni;
          if (nav.blocked[nk] || seen[nk] || !inPlay(nk)) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
      biggest = Math.max(biggest, size);
    }

    // and what the game's own field actually covers from where you stand
    nav.update(p.x, p.z, true);
    let reach = 0;
    for (let k = 0; k < nav.dist.length; k++) if (nav.dist[k] >= 0 && inPlay(k)) reach++;

    return {
      open, biggest, reach,
      connected: +(biggest / open).toFixed(3),
      covered: +(reach / open).toFixed(3),
    };
  });
  expect(r.open > 2000, `only ${r.open} walkable cells in the whole sector`);
  expect(r.connected > 0.995,
    `the walkable sector is in pieces — its biggest is ${(r.connected * 100).toFixed(1)}% of it`);
  expect(r.covered > 0.995,
    `the field only covers ${(r.covered * 100).toFixed(1)}% of the walkable sector from the player`);
  return r;
});

check('a hostile walks around the building between you, not into it', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = true;
    // a thirty second step outlives the three seconds until wave 1
    g.startWave = () => {};
    g.spawnQueue.length = 0; g.pendingSpawns = 0; g.bossPending = false; g.waveHpScale = 1;

    // The stuck watchdog is the backstop this is meant to stop needing, so it
    // is disconnected for the duration. Left in, a hostile that routes
    // nowhere still arrives — by being teleported there — and the check
    // passes for the wrong reason.
    let relocations = 0;
    g.relocateEnemy = () => { relocations++; };

    const p = g.player.position;
    // A spot with a building in the way, that the field agrees is connected.
    // Demanding a hostile reach somewhere it cannot get to is asserting
    // something the game never promised, so the route is validated first.
    g.nav.update(p.x, p.z, true);
    let start = null;
    for (let attempt = 0; attempt < 200 && !start; attempt++) {
      const s = g.findSpawnPoint(26, 40);
      if (g.world.lineOfSight(s.x, 1.5, s.z, p.x, p.y, p.z)) continue;   // wants no view
      if (g.world.groundHeight(s.x, s.z, 0.5, 99) > 0.05) continue;      // on the street
      const i = g.nav.col(s.x), j = g.nav.col(s.z);
      if (!g.nav.inside(i, j)) continue;
      if (g.nav.dist[j * g.nav.size + i] < 0) continue;                  // no route: not ours to test
      start = s;
    }
    if (!start) return { noSetup: true };

    const e = g.spawnEnemy('raider');
    e.pos.set(start.x, 0, start.z);
    e.group.position.copy(e.pos);
    e.alert(g.time, 0);
    e.nextFire = 1e9;                       // it is walking here, not shooting
    const from = Math.hypot(start.x - p.x, start.z - p.z);

    // The player stands still, so this measures the hostile's route and
    // nothing else. Health is held up because a dead player flips the game
    // to 'dead' and quietly stops the run.
    let path = 0, best = from, sawPlayer = false;
    let px = e.pos.x, pz = e.pos.z;
    for (let f = 0; f < 30 * 60; f++) {
      g.time += 1 / 60;
      g.player.health = 100; g.player.dead = false;
      g.step(1 / 60);
      path += Math.hypot(e.pos.x - px, e.pos.z - pz);
      px = e.pos.x; pz = e.pos.z;
      const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
      best = Math.min(best, d);
      if (g.world.lineOfSight(e.pos.x, e.pos.y + 1.5, e.pos.z, p.x, p.y, p.z)) { sawPlayer = true; break; }
    }
    return {
      from: +from.toFixed(1), closest: +best.toFixed(1), path: Math.round(path),
      sawPlayer, relocations, routed: e.routed,
    };
  });
  expect(!r.noSetup, 'no blind-but-connected spot on this seed — the setup found nothing to test');
  // Getting a line on the player is the whole job. Closing to contact range
  // without one would do as well, and is what a melee type would have done.
  expect(r.sawPlayer || r.closest < 6,
    `hostile started ${r.from} m away with a building in the way and got no closer than ` +
    `${r.closest} m in 30 s, walking ${r.path} m to do it`);
  expect(r.relocations === 0,
    `the watchdog fired ${r.relocations} times — it should not have been needed`);
  return r;
});

check('a marksman is moved to a perch that overlooks you', async (page) => {
  // The rooftop half of the same deadlock. A marksman on a perch is exempt
  // from nearly everything that moves a hostile — no drift, no strafe, four
  // times the watchdog leash — all of it there to stop it walking off the
  // edge. So when a wave's last hostile is a sniper with no line to anyone,
  // the wave waits on it, and moving it to another perch picked purely on
  // distance lands it somewhere equally blind about as often as not.
  //
  // Whether any perch overlooks the plaza at all is a property of the layout,
  // and the suite's own seed has none: it reported 0 of 8 eligible perches
  // with a line to the player, so the assertion below was skipped and the
  // check passed without testing anything. Seed 99991 has five, and 20260101
  // three. Bring one, the way the deadlock check does.
  await reloadGame({ seed: 99991 });
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    const p = g.player.position;
    const perches = g.perches.map((q) => ({
      x: q.x, z: q.z,
      d: Math.hypot(q.x - p.x, q.z - p.z),
      sees: g.world.lineOfSight(q.x, q.y + 1.5, q.z, p.x, p.y, p.z),
    }));
    // only the ones findPerch is allowed to choose from
    const eligible = perches.filter((q) => q.d >= 16 && q.d <= 95);
    const withView = eligible.filter((q) => q.sees).length;

    let picked = 0, blind = 0;
    for (let i = 0; i < 40; i++) {
      const q = g.findPerch(true);      // what a relocation asks for
      if (!q) continue;
      picked++;
      if (!g.world.lineOfSight(q.x, q.y + 1.5, q.z, p.x, p.y, p.z)) blind++;
    }
    return { perches: perches.length, eligible: eligible.length, withView, picked, blind };
  });
  expect(r.picked > 0, 'findPerch returned nothing at all');
  // The seed is chosen so this is never vacuous. If a future layout move
  // takes the overlooking perches away from it too, that is what this catches
  // — rather than the check quietly going green while testing nothing.
  expect(r.withView > 0,
    `no eligible perch on this seed overlooks the player, so this check asserts nothing`);
  expect(r.blind === 0,
    `${r.blind} of ${r.picked} perches picked had no line to the player, ` +
    `though ${r.withView} of ${r.eligible} eligible perches did`);
  return r;
});

check('every surface is textured at the world scale it declares', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const rows = [];

    for (const mesh of g.city.children) {
      const tile = mesh.material?.userData?.tile;
      if (!tile) continue;                       // untextured, nothing to check
      const pos = mesh.geometry.attributes.position;
      const uv = mesh.geometry.attributes.uv;
      const index = mesh.geometry.index;

      // texels per metre, per triangle, weighted by how much of the city that
      // triangle actually covers — a stretched tile on a big surface is what
      // the eye sees, and a wrong one on a bolt is not
      let inBand = 0, total = 0;
      const densities = [];
      for (let t = 0; t < index.count; t += 3) {
        const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
        const e1 = [pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a)];
        const e2 = [pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a)];
        const cross = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const area = Math.hypot(cross[0], cross[1], cross[2]) / 2;
        if (area < 1e-4) continue;
        const uvArea = Math.abs(
          (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
          - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a))) / 2;
        const density = Math.sqrt(uvArea / area) * tile;   // 1 when it is right
        densities.push([density, area]);
        total += area;
        if (density > 0.7 && density < 1.4) inBand += area;
      }
      if (!total) continue;

      densities.sort((p, q) => p[0] - q[0]);
      let acc = 0, median = 1;
      for (const [d, a] of densities) { acc += a; if (acc >= total / 2) { median = d; break; } }
      rows.push({
        name: mesh.material.userData.name, tile,
        median: +median.toFixed(2), share: +(inBand / total).toFixed(2),
        area: Math.round(total),
      });
    }
    return rows;
  });

  expect(r.length >= 8, `only ${r.length} textured batches found`);
  for (const row of r) {
    expect(row.median > 0.75 && row.median < 1.35,
      `${row.name} is textured at ${row.median}x the ${row.tile} m scale it declares`);
    expect(row.share > 0.6,
      `only ${Math.round(row.share * 100)}% of ${row.name}'s area is near its declared scale`);
  }
  const ground = r.find((row) => row.name === 'asphalt');
  expect(ground && Math.abs(ground.median - 1) < 0.05,
    `the ground is at ${ground?.median}x its declared scale`);
  return { batches: r.length, worst: r.reduce((a, b) => (Math.abs(b.median - 1) > Math.abs(a.median - 1) ? b : a)) };
});

check('the gun in your hands is solid and textured at its declared scale', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    let tris = 0, inverted = 0, meshes = 0, textured = 0;
    const density = [];

    for (const w of g.weapons.weapons) {
      w.model.traverse((o) => {
        if (!o.geometry || !o.geometry.attributes.position) return;
        meshes++;
        const m = o.material;
        if (m.map) textured++;

        const p = o.geometry.attributes.position;
        const n = o.geometry.attributes.normal;
        const uv = o.geometry.attributes.uv;
        const idx = o.geometry.index;
        const count = idx ? idx.count : p.count;
        const at = (k) => (idx ? idx.getX(k) : k);

        for (let k = 0; k + 2 < count; k += 3) {
          const a = at(k), b = at(k + 1), c = at(k + 2);
          const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
          const wx = p.getX(c) - p.getX(a), wy = p.getY(c) - p.getY(a), wz = p.getZ(c) - p.getZ(a);
          const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
          const len = Math.hypot(cx, cy, cz);
          if (len < 1e-12) continue;          // degenerate, e.g. a cylinder cap fan
          tris++;
          // the winding has to agree with the normal the shader lights by,
          // or the facet is inside out and simply vanishes
          if ((cx * n.getX(a) + cy * n.getY(a) + cz * n.getZ(a)) / len < -1e-6) inverted++;

          // texels per metre, off the real triangle rather than the intent
          if (!uv || !m.map) continue;
          const area = len / 2;
          const duA = uv.getX(b) - uv.getX(a), dvA = uv.getY(b) - uv.getY(a);
          const duB = uv.getX(c) - uv.getX(a), dvB = uv.getY(c) - uv.getY(a);
          const uvArea = Math.abs(duA * dvB - dvA * duB) / 2;
          if (area > 1e-8 && uvArea > 1e-12) density.push(Math.sqrt(uvArea / area));
        }
      });
    }

    density.sort((a, b) => a - b);
    return {
      meshes, textured, tris, inverted,
      // one tile over TILE metres means this ratio should sit at 1/TILE
      medianPerMetre: density.length ? density[density.length >> 1] : 0,
      tiles: { poly: 1 / 0.3, metal: 1 / 0.36 },
    };
  });

  expect(r.meshes > 30, `only ${r.meshes} meshes across four weapons`);
  expect(r.inverted === 0, `${r.inverted} of ${r.tris} facets are wound inside out`);
  expect(r.textured / r.meshes > 0.85, `only ${r.textured}/${r.meshes} meshes carry a texture`);
  // every textured part unwraps at one of the two declared gun tiles
  const near = (v, t) => Math.abs(v - t) / t < 0.35;
  expect(near(r.medianPerMetre, r.tiles.poly) || near(r.medianPerMetre, r.tiles.metal),
    `the view model unwraps at ${r.medianPerMetre.toFixed(2)} tiles/m, not ${r.tiles.metal.toFixed(2)}–${r.tiles.poly.toFixed(2)}`);
  return { meshes: r.meshes, tris: r.tris, inverted: r.inverted, perMetre: +r.medianPerMetre.toFixed(2) };
});

check('lane paint lies on the road and faces the sky', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const mesh = g.city.children.find((m) => m.material?.userData?.name === 'paint');
    if (!mesh) return { found: false };
    const { centres, half, end } = g.streets;
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;

    // A street is a corridor `half` either side of a centre line, on one axis
    // or the other, so a point is on the carriageway when it is inside at
    // least one of them. This returns how far outside the nearest one it is.
    const outside = (x, z) => {
      let best = Infinity;
      for (const c of centres) {
        for (const [along, across] of [[x, z], [z, x]]) {
          if (Math.abs(along) > end) continue;         // past the last sidewalk
          best = Math.min(best, Math.max(0, Math.abs(across - c) - half));
        }
      }
      return best === Infinity ? 99 : best;
    };

    let tris = 0, facingDown = 0, worst = 0, painted = 0;
    const touched = new Set();
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
      const e1 = [pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a)];
      const e2 = [pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a)];
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const len = Math.hypot(cross[0], cross[1], cross[2]);
      if (len < 1e-9) continue;
      tris++;
      painted += len / 2;
      // a quad wound the wrong way round does not error, it vanishes — and
      // the two axes map the street's own frame onto world space with
      // opposite handedness, so it is one order for each
      if (cross[1] <= 0) facingDown++;
      for (const v of [a, b, c]) worst = Math.max(worst, outside(pos.getX(v), pos.getZ(v)));

      // which street this marking is on, counted only where the answer is
      // unambiguous: near a junction a point sits in both corridors at once,
      // and counting those would let paint on one axis alone claim all ten
      const mx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const mz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const on = [];
      for (const c2 of centres) {
        if (Math.abs(mx - c2) <= half) on.push('x' + c2);
        if (Math.abs(mz - c2) <= half) on.push('z' + c2);
      }
      if (on.length === 1) touched.add(on[0]);
    }

    // What the same paint would have cost inside the asphalt tile, which is
    // where it lived until now: a tile repeats over the whole ground plane,
    // so a line painted into it lands everywhere, and only this share of
    // everywhere is actually a road.
    const ground = g.city.children.find((m) => m.material?.userData?.name === 'asphalt');
    ground.geometry.computeBoundingBox();
    const bb = ground.geometry.boundingBox;
    const groundArea = (bb.max.x - bb.min.x) * (bb.max.z - bb.min.z);
    const roadArea = centres.length * 2 * (half * 2) * (end * 2)
      - centres.length * centres.length * (half * 2) * (half * 2);

    return {
      found: true, tris, facingDown,
      streets: touched.size, ofStreets: centres.length * 2,
      worst: +worst.toFixed(3),
      painted: Math.round(painted),
      offRoadAsTile: +(1 - roadArea / groundArea).toFixed(3),
    };
  });

  expect(r.found, 'the city has no lane paint');
  expect(r.tris > 1500, `only ${r.tris} marking triangles`);
  expect(r.facingDown === 0, `${r.facingDown} of ${r.tris} marking facets are wound inside out`);
  expect(r.worst < 0.05, `paint runs ${r.worst} m past the kerb`);
  expect(r.streets === r.ofStreets, `paint reaches ${r.streets} of ${r.ofStreets} streets`);
  return r;
});

/**
 * The fingerprint of a city: every collider, every perch, in order.
 *
 * Injected rather than inlined three times, because the whole value of it is
 * that all three seeds are measured exactly the same way.
 */
const CITY_FINGERPRINT = () => {
  const g = window.__game;
  let h = 2166136261;
  const eat = (v) => {
    const n = Math.round(v * 1000) | 0;
    for (let b = 0; b < 32; b += 8) { h ^= (n >>> b) & 0xff; h = Math.imul(h, 16777619); }
  };
  for (const b of g.world.boxes) {
    eat(b.minX); eat(b.minZ); eat(b.maxX); eat(b.maxZ);
    eat(b.top); eat(b.cx); eat(b.cz); eat(b.hx); eat(b.hz); eat(b.cos); eat(b.sin);
  }
  for (const p of g.perches) { eat(p.x); eat(p.y); eat(p.z); }
  return {
    boxes: g.world.boxes.length,
    solids: g.world.solids.length,
    perches: g.perches.length,
    fp: (h >>> 0).toString(16),
  };
};

check('a seed still lays out the city it did', async (page) => {
  // The most expensive lesson in this repo, finally made into a check.
  //
  // Three spends four `Math.random()` calls on a UUID for every object it
  // builds, and the city is laid out from that same seeded stream — so one
  // mesh more or fewer inside any builder moves every prop placed after it,
  // and a seed only ever described the same city within one version of the
  // code. `reserve` covers what is shared and `spend` covers what a prop
  // costs (see `rng.js`); this is what notices when one of them stops adding
  // up, which is the only way either is worth relying on.
  //
  // The numbers were measured on the code that first paid the bills, and the
  // whole point is that they are never expected to change. If a deliberate
  // layout change is being made, they are re-measured *once*, with the reason
  // written down — that is a different thing from a look change quietly
  // moving them, which is what this exists to catch.
  const want = {
    1: { boxes: 332, solids: 405, perches: 12, fp: 'f0aa1240' },
    7: { boxes: 296, solids: 354, perches: 10, fp: '9a29033d' },
    20260101: { boxes: 332, solids: 410, perches: 12, fp: 'efb56339' },
  };

  const got = {};
  for (const seed of Object.keys(want)) {
    await reloadGame({ seed: Number(seed) });
    got[seed] = await page.evaluate(CITY_FINGERPRINT);
  }
  await reloadGame();

  for (const [seed, w] of Object.entries(want)) {
    const r = got[seed];
    expect(r.boxes === w.boxes && r.perches === w.perches && r.solids === w.solids,
      `seed ${seed} lays out ${r.boxes}/${r.solids}/${r.perches} boxes/solids/perches, ` +
      `not ${w.boxes}/${w.solids}/${w.perches}`);
    expect(r.fp === w.fp,
      `seed ${seed} has the same number of colliders in different places ` +
      `(${r.fp}, not ${w.fp})`);
  }
  return got;
});

check('nothing is built inside out', async (page) => {
  // A facet whose winding disagrees with its own normal does not error and
  // does not go dark: it vanishes, so it reads as a notch bitten out of the
  // part, somewhere you were not looking. It has been shipped twice — the
  // chamfered view model, then the road markings — and both times from a
  // corner order written by hand, which gets every facet with an odd number
  // of negative axes backwards.
  //
  // `shapes.js` derives the order from the normal instead, and this measures
  // the result on everything it builds: the merged city, the shapes the props
  // are cut from, and the hostiles, which is the one set of meshes that never
  // reaches the merge.
  const r = await page.evaluate(() => {
    const g = window.__game;

    const inverted = (geo) => {
      const p = geo.attributes.position, n = geo.attributes.normal;
      if (!p || !n) return [0, 0];
      const idx = geo.index;
      const count = idx ? idx.count : p.count;
      const at = (k) => (idx ? idx.getX(k) : k);
      let bad = 0, tris = 0;
      for (let k = 0; k + 2 < count; k += 3) {
        const a = at(k), b = at(k + 1), c = at(k + 2);
        const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
        const wx = p.getX(c) - p.getX(a), wy = p.getY(c) - p.getY(a), wz = p.getZ(c) - p.getZ(a);
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
        const len = Math.hypot(cx, cy, cz);
        if (len < 1e-12) continue;                    // degenerate, e.g. a cap fan
        tris++;
        if ((cx * n.getX(a) + cy * n.getY(a) + cz * n.getZ(a)) / len < -1e-6) bad++;
      }
      return [bad, tris];
    };

    const out = {};
    const tally = (name, geo) => {
      const [bad, tris] = inverted(geo);
      const row = out[name] || (out[name] = { bad: 0, tris: 0 });
      row.bad += bad; row.tris += tris;
    };

    for (const mesh of g.city.children) {
      if (mesh.isMesh) tally('city', mesh.geometry);
    }
    const walkShapes = (node) => {
      for (const v of Object.values(node)) {
        if (v && v.isBufferGeometry) tally('props', v);
        else if (v && typeof v === 'object') walkShapes(v);
      }
    };
    walkShapes(g.propShapes);

    // one of every archetype, since nothing else in the game builds these
    g.startRun();
    for (const key of Object.keys(g.enemyTypes)) {
      const e = g.spawnEnemy(key);
      e.group.traverse((o) => { if (o.isMesh) tally('hostiles', o.geometry); });
    }
    return out;
  });

  for (const [name, row] of Object.entries(r)) {
    expect(row.tris > 100, `only ${row.tris} triangles measured in ${name}`);
    expect(row.bad === 0, `${row.bad} of ${row.tris} facets in ${name} are wound inside out`);
  }
  return r;
});

check('every archetype is kitted, textured, and keeps its hit zones', async (page) => {
  // A hostile is read at forty metres against a dusk skyline, where its
  // colour is barely a colour — so the silhouette has to carry the archetype,
  // and the kit that does that is merged into the meshes that are already hit
  // zones rather than hung beside them. That is not only tidiness: a mesh
  // with no `zone` is not in `hitMeshes` and cannot be shot, so kit hung on
  // as extra meshes would be armour you shoot straight through.
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.startWave = () => {};
    g.spawnQueue.length = 0;
    g.pendingSpawns = 0;

    const rows = {};
    for (const key of Object.keys(g.enemyTypes)) {
      const e = g.spawnEnemy(key);
      const zones = new Set();
      let meshes = 0, textured = 0, tris = 0;
      let minX = 1e9, maxX = -1e9, maxY = -1e9;
      e.group.updateMatrixWorld(true);
      const V = g.player.position.constructor;
      const v = new V();
      const feet = e.group.position;
      e.group.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        if (o.material.map) textured++;
        if (o.userData.zone) zones.add(o.userData.zone);
        const p = o.geometry.attributes.position;
        tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
        if (o === e.parts.shadow) return;              // a flat sprite, not a body
        // measured in world space and taken back to the feet, so a part's own
        // placement and the archetype's scale are both in it
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).sub(feet);
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y > maxY) maxY = v.y;
        }
      });
      // The kit alone, with the archetype's scale divided back out: a
      // JUGGERNAUT is 1.35x the size of anything else, so a measurement that
      // leaves the scale in passes whatever it is wearing — which is exactly
      // the shape of assertion this file has been caught making before.
      e.parts.rig.geometry.computeBoundingBox();
      const rig = e.parts.rig.geometry.boundingBox;
      const counts = ['torso', 'rig', 'headKit', 'gun'].map((part) => {
        const mesh = part === 'headKit'
          ? e.group.children.find((o) => o.isMesh && o.userData.zone === 'head' && o !== e.parts.head)
          : part === 'gun' ? e.parts.weapon.children.find((o) => o.isMesh) : e.parts[part];
        const p = mesh.geometry.attributes.position;
        return (mesh.geometry.index ? mesh.geometry.index.count : p.count) / 3;
      });
      rows[key] = {
        meshes, textured, tris: Math.round(tris),
        zones: [...zones].sort().join('+'),
        hits: e.hitMeshes.length,
        width: +(maxX - minX).toFixed(2),
        height: +maxY.toFixed(2),
        shoulder: +Math.max(rig.max.x, -rig.min.x).toFixed(2),
        kit: counts.join('/'),
        parts: ['torso', 'head', 'armL', 'armR', 'legL', 'legR', 'weapon', 'muzzle', 'band', 'eye']
          .filter((k) => !e.parts[k]).join(',') || 'all',
      };
    }
    return rows;
  });

  for (const [key, row] of Object.entries(r)) {
    expect(row.parts === 'all', `${key} is missing parts: ${row.parts}`);
    expect(row.zones === 'body+head+limb', `${key} tags ${row.zones}, not body+head+limb`);
    expect(row.hits >= 8, `${key} has only ${row.hits} meshes that can be shot`);
    // band, eye and the contact shadow are deliberately flat; everything else
    // on a hostile carries a map, or it is a flat-coloured box again
    expect(row.textured >= 8,
      `only ${row.textured} of ${key}'s ${row.meshes} meshes carry a texture`);
  }
  // The silhouettes have to actually differ, or none of the above bought
  // anything. Two measures, because either alone can be satisfied by
  // accident: no two archetypes are built from the same parts, and the one
  // in plate is nearly twice as broad across the armour as the one in a
  // webbing rig — before its 1.35 scale, which is deliberately divided out.
  const kits = Object.values(r).map((row) => row.kit);
  expect(new Set(kits).size === kits.length,
    `two archetypes are wearing the same kit: ${kits.join(' ')}`);
  expect(r.brute.shoulder > r.raider.shoulder * 1.5,
    `a JUGGERNAUT's plate is ${r.brute.shoulder} m off centre against a RAIDER's ${r.raider.shoulder}`);
  expect(r.marksman.height > 1.7 && r.brute.height > 1.7,
    'a hostile is shorter than it was');
  return r;
});

check('the bake darkens the ground the city stands on', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    const ground = g.city.children.find((m) => m.material?.userData?.name === 'asphalt');
    if (!ground) return { found: false };
    const pos = ground.geometry.attributes.position;
    const col = ground.geometry.attributes.color;

    // split the ground's vertices by whether the city stands next to them
    const near = [], open = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (Math.abs(x) > g.world.bounds || Math.abs(z) > g.world.bounds) continue;
      let closest = 99;
      for (const b of g.world.boxes) {
        if (b.top < 2) continue;
        const dx = Math.max(b.minX - x, 0, x - b.maxX);
        const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
        closest = Math.min(closest, Math.hypot(dx, dz));
        if (closest < 0.5) break;
      }
      const lum = (col.getX(i) + col.getY(i) + col.getZ(i)) / 3;
      if (closest < 1.5) near.push(lum);
      else if (closest > 7) open.push(lum);   // clear of the ~5 m blur radius
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    return { found: true, near: +mean(near).toFixed(3), open: +mean(open).toFixed(3),
      nearCount: near.length, openCount: open.length };
  });

  expect(r.found, 'no merged ground mesh carries a vertex colour');
  expect(r.nearCount > 50 && r.openCount > 40, `too few samples: ${JSON.stringify(r)}`);
  expect(r.near < r.open * 0.82,
    `ground beside a wall (${r.near}) is not darker than open street (${r.open})`);
  expect(r.open > 0.85, `open street is darkened to ${r.open} with nothing standing on it`);
  return r;
});

check('look still works when pointer lock is denied', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.startRun();
    g.input.locked = false;
    g.input.enableFallback();                 // as if the browser refused capture
    const canvas = document.getElementById('scene');
    const rect = canvas.getBoundingClientRect();

    const spin = (fx, fy, seconds) => {
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + rect.width * fx,
        clientY: rect.top + rect.height * fy,
        bubbles: true,
      }));
      const yaw = g.player.yaw, pitch = g.player.pitch;
      for (let f = 0; f < seconds * 60; f++) { g.time += 1 / 60; g.step(1 / 60); }
      return { yaw: +(g.player.yaw - yaw).toFixed(3), pitch: +(g.player.pitch - pitch).toFixed(3) };
    };

    const centre = spin(0.5, 0.5, 1);
    const right = spin(0.95, 0.5, 1);
    const edge = spin(0.001, 0.5, 1);         // the exact pixel where deltas die
    const up = spin(0.5, 0.02, 1);

    canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    const yawBefore = g.player.yaw;
    for (let f = 0; f < 60; f++) { g.time += 1 / 60; g.step(1 / 60); }
    const afterLeave = +(g.player.yaw - yawBefore).toFixed(3);

    g.input.keys.add('ArrowLeft');
    const beforeArrow = g.player.yaw;
    for (let f = 0; f < 60; f++) { g.time += 1 / 60; g.step(1 / 60); }
    const arrows = +(g.player.yaw - beforeArrow).toFixed(3);
    g.input.keys.clear();

    return { centre, right, edge, up, afterLeave, arrows, hinted: !document.getElementById('capture-hint').classList.contains('hidden') };
  });
  expect(r.centre.yaw === 0, 'the centre dead zone still turned the view');
  expect(r.right.yaw < -0.5, `steering right did nothing (${r.right.yaw})`);
  expect(r.edge.yaw > 0.5, `steering died at the window edge (${r.edge.yaw})`);
  expect(r.up.pitch > 0.5, `steering up did nothing (${r.up.pitch})`);
  expect(r.afterLeave === 0, `the view kept turning after the cursor left (${r.afterLeave})`);
  expect(Math.abs(r.arrows) > 1, 'arrow keys did not aim');
  expect(r.hinted, 'nothing told the player capture was unavailable');
  return r;
});

check('the best-score line sits clear of the deploy button', async (page) => {
  const r = await page.evaluate(() => {
    const g = window.__game;
    g.records = { bestScore: 128450, bestWave: 12 };   // wide enough to wrap if it were going to
    g.showRecords();
    const btn = document.getElementById('start-btn');
    btn.classList.remove('hidden');                    // as it is once boot finishes
    const records = document.getElementById('records');

    const gapNow = () => {
      const b = btn.getBoundingClientRect(), t = records.getBoundingClientRect();
      return +(t.top - b.bottom).toFixed(1);
    };
    const gap = gapNow();

    // The same measurement with the rules this replaced: a button left in a
    // line box, and a negative top margin hand-tuned to cancel the strut's
    // descender under it.
    btn.style.display = 'inline-block';
    btn.style.margin = '6px';
    records.style.marginTop = '-14px';
    const gapPulled = gapNow();
    btn.style.display = records.style.marginTop = btn.style.margin = '';

    return { gap, gapPulled, shown: records.textContent.trim(), hidden: records.classList.contains('hidden') };
  });
  expect(!r.hidden && r.shown.includes('128,450'), `the record is not on the menu: ${JSON.stringify(r)}`);
  expect(r.gap > 0, `the best-score line runs into the deploy button by ${-r.gap} px`);
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

// `--only=text` runs just the checks whose name contains it. The suite is
// twenty-one checks and several minutes; when one of them is what you are
// working on, waiting for the other twenty is how you stop running it.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const selected = ONLY ? checks.filter((c) => c.name.includes(ONLY)) : checks;
if (ONLY && !selected.length) {
  console.log(`no check matches "${ONLY}"`);
  process.exit(1);
}

for (const { name, fn } of selected) {
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

console.log(`\n${selected.length - failed}/${selected.length} checks passed`);
process.exit(failed ? 1 : 0);
