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
    reload: async ({ freeze: f = freeze } = {}) => {
      await page.goto(url, { waitUntil: 'load' });
      await waitForBoot(page, { freeze: f, seed });
    },
    close: async () => { await browser.close(); server.close(); },
  };
}
