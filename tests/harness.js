/**
 * Shared plumbing for driving the game from Node: find a browser, serve the
 * repo, boot the page, and hand back a page with the game frozen and seeded.
 *
 * Used by both the test suite and the probe tool.
 */
import { chromium } from 'playwright';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.js';

/**
 * Playwright pins a browser build per release, which will not match a shared
 * browser directory, so fall back to whatever is actually installed.
 */
async function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return null;
  const dirs = (await readdir(root).catch(() => []))
    .filter((d) => d.startsWith('chromium-') || d === 'chromium')
    .sort()
    .reverse();
  const relatives = [
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
  ];
  for (const dir of dirs) {
    for (const rel of relatives) {
      const full = join(root, dir, rel);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export async function launchBrowser({ headed = false } = {}) {
  const opts = {
    headless: !headed,
    // software WebGL, so this runs on a machine with no GPU
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  };
  if (process.env.ASHFALL_CHROME) {
    return chromium.launch({ ...opts, executablePath: process.env.ASHFALL_CHROME });
  }
  try {
    return await chromium.launch(opts);
  } catch (err) {
    const found = await findChromium();
    if (found) return chromium.launch({ ...opts, executablePath: found });
    throw new Error(
      `${err.message}\n\nInstall a browser with "npx playwright install chromium", ` +
      'or point ASHFALL_CHROME at an existing Chromium binary.');
  }
}

/**
 * Wait for the menu, then (by default) stop the render loop and restart the
 * random stream. Without the freeze the loop keeps stepping the game on real
 * frame timing while a script steps it manually, and nothing repeats.
 */
export async function waitForBoot(page, { freeze = true, seed } = {}) {
  await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
  if (freeze) {
    await page.evaluate((s) => {
      window.__game.renderer.setAnimationLoop(null);
      if (s) window.__game.reseed(s);
    }, seed);
  }
}

/** Helpers injected into every page: placement that is verified clear, etc. */
export async function installHelpers(page) {
  await page.addInitScript(() => {
    /**
     * A hostile and the player in each other's sight. In a dense city a random
     * pair often has a wall between them, so pick a spot and a heading that
     * are verified clear rather than assuming.
     */
    window.__place = (range) => {
      const g = window.__game;
      for (let attempt = 0; attempt < 12; attempt++) {
        const spot = g.findSpawnPoint(26, 34);
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const px = spot.x + Math.cos(ang) * range;
          const pz = spot.z + Math.sin(ang) * range;
          if (Math.abs(px) > g.world.bounds - 3 || Math.abs(pz) > g.world.bounds - 3) continue;
          if (g.world.occupied(px, pz, 0.8, 0.6)) continue;
          // clear at chest and at head height, and on level ground at both ends
          if (g.world.groundHeight(spot.x, spot.z, 0.5, 99) > 0.05) continue;
          if (!g.world.lineOfSight(px, 1.68, pz, spot.x, 1.2, spot.z)) continue;
          if (!g.world.lineOfSight(px, 1.68, pz, spot.x, 1.75, spot.z)) continue;
          return { target: spot, px, pz };
        }
      }
      throw new Error('no clear firing line found on this seed');
    };

    /** Advance the simulation by `seconds` of game time at a fixed step. */
    window.__step = (seconds) => {
      const g = window.__game;
      for (let f = 0; f < Math.round(seconds * 60); f++) {
        g.time += 1 / 60;
        g.step(1 / 60);
      }
    };

    /** Everything you usually want to know about a hostile, at a glance. */
    window.__enemies = () => {
      const g = window.__game;
      const p = g.player.position;
      return g.enemies.map((e) => ({
        type: e.typeKey,
        alive: e.alive,
        elite: !!e.elite,
        hp: Math.round(e.hp),
        pos: [+e.pos.x.toFixed(1), +e.pos.y.toFixed(1), +e.pos.z.toFixed(1)],
        dist: +Math.hypot(e.pos.x - p.x, e.pos.z - p.z).toFixed(1),
        speed: +Math.hypot(e.vel.x, e.vel.z).toFixed(2),
        alerted: e.alerted,
        stuckFor: +e.stuckTimer.toFixed(1),
        // asymmetry here would be a bug: these two should always agree
        seesPlayer: g.world.lineOfSight(e.pos.x, e.pos.y + 1.5, e.pos.z, p.x, p.y, p.z),
        playerSees: g.world.lineOfSight(p.x, p.y, p.z, e.pos.x, e.pos.y + 1.3, e.pos.z),
      }));
    };

    /**
     * Play the game badly but honestly for `seconds`, and report what
     * happened.
     *
     * This bot has its own history, which is why it lives here rather than
     * inside one check: an earlier version backed away from anything it could
     * not see, and since the player walks faster than every archetype the
     * retreat never ended — it outran the wave it was measuring and graded
     * itself instead of the game. It now backs off only from a threat inside
     * 12 m and keeps closing while it flanks. Changing that is changing every
     * check that reads it, so measure what it spends its frames doing before
     * concluding anything about the game from a failure here.
     */
    window.__botRun = (seconds = 240) => {
      const g = window.__game;
      g.startRun();
      g.input.locked = true;
      for (const w of g.weapons.weapons) w.unlocked = true;

      const dt = 1 / 60;
      const frames = Math.round(seconds * 60);
      let unstick = 0, cookRelease = 0, blind = 0;
      const waveAt = [];
      let lastProgress = 0, longestStall = 0;
      let contactAt = 0, noContact = 0;

      for (let f = 0; f < frames; f++) {
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
            // flanking means moving sideways *and* closing; backing off is the
            // answer to something inside your guard, not to an empty street
            if (blind > 300 && nd < 12) g.input.keys.add('KeyS');
            else g.input.keys.add('KeyW');
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

      return {
        wave: g.wave, kills: g.kills, score: g.score, waveAt,
        stallSeconds: +((frames - longestStall) / 60).toFixed(1),
        noContact: +noContact.toFixed(1),
        objectives: g.objectivesSecured + g.objectivesLost,
      };
    };

    /** Height of the ground along a line — reads a stair run as a ramp. */
    window.__profile = (x, z, axis = 'z', from = -16, to = 16) => {
      const g = window.__game;
      const out = [];
      for (let d = from; d <= to; d++) {
        const sx = axis === 'x' ? x + d : x;
        const sz = axis === 'x' ? z : z + d;
        out.push([d, +g.world.groundHeight(sx, sz, 0.42, 99).toFixed(2)]);
      }
      return out;
    };
  });
}

/**
 * Boot the game and return the page plus a close function.
 * @param {{seed?:number, port?:number, headed?:boolean, freeze?:boolean,
 *          viewport?:{width:number,height:number}}} opts
 */
export async function openGame(opts = {}) {
  const { seed = 20260813, port = 8177, headed = false, freeze = true } = opts;
  const viewport = opts.viewport || { width: 1100, height: 620 };

  const server = await serve(port);
  const browser = await launchBrowser({ headed });
  const page = await browser.newPage({ viewport });

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await installHelpers(page);
  const url = `http://localhost:${port}/index.html?seed=${seed}`;
  await page.goto(url, { waitUntil: 'load' });
  await waitForBoot(page, { freeze, seed });

  return {
    page, browser, errors, url,
    // The city comes from the URL, so a check that needs a particular layout
    // — one that trips a bug the pinned seed happens not to — reboots on its
    // own seed rather than asserting against whatever the suite is pinned to.
    reload: async ({ freeze: f = freeze, seed: s = seed } = {}) => {
      await page.goto(`http://localhost:${port}/index.html?seed=${s}`, { waitUntil: 'load' });
      await waitForBoot(page, { freeze: f, seed: s });
    },
    close: async () => { await browser.close(); server.close(); },
  };
}
