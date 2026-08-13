# ASHFALL — working notes

A browser FPS: wave survival in a procedurally generated ruined city. No build
step to run it, no asset files, no network calls at runtime. Three.js is
vendored in `vendor/`; everything else is hand-written.

Read `README.md` first for what the game *is*. This file is for changing it.

## Commands

```bash
npm start                      # serve at http://localhost:8000 (no deps needed)
npm test                       # 12 headless checks (needs npm install first)
npm run build                  # one-file dist/ashfall.html, no external refs
node tests/probe.js --list     # canned probes
node tests/probe.js "g.perches.length"   # ask the running game anything
```

`npm install` + `npx playwright install chromium` are only needed for tests and
builds, never to play.

## Architecture

| File | Owns |
| --- | --- |
| `src/main.js` | `Game`: loop, scene, lighting, waves, hit resolution, blasts |
| `src/world.js` | AABB collision, ground height, line of sight, sphere bounce |
| `src/city.js` | Procedural generation; returns `{ world, fireBarrels, perches }` |
| `src/player.js` | `Input` and `Player`: look, movement, footing, health |
| `src/weapons.js` | Weapon defs, view models, firing, recoil, melee |
| `src/enemies.js` | Archetypes, AI, procedural bodies, laser telegraph |
| `src/grenades.js` | Fuse, flight, bounce, detonation |
| `src/effects.js` | Pooled tracers, impacts, blood, casings, explosions |
| `src/textures.js` | Every texture, painted to canvas at boot |
| `src/audio.js` | Every sound, synthesised via Web Audio |
| `src/hud.js` | DOM readouts, killfeed, radar, capture banner |
| `src/rng.js` | Seeded `Math.random` for the page's lifetime |

The whole game hangs off `window.__game`, which is how tests and probes drive it.

## Invariants worth not breaking

These each cost real debugging time. Changing them needs a reason.

- **One box list drives everything.** Collision, ground height, line of sight
  and grenade bounce all read `world.boxes`. Register a solid once and every
  system sees it. Anything decorative (rubble, lips, sky) stays out of it.
- **Line of sight must stay symmetric.** It is a three-slab segment test. An
  earlier version only checked height at the entry point, which let a hostile
  see a target that could not see it back.
- **`Math.random` is seeded and the stream order matters.** Do not spend it on
  per-frame cosmetics — an earlier fire flicker did, and identical runs
  diverged. Deterministic noise instead (see `flickerFires`).
- **Hit detection raycasts before the renderer runs**, so `Enemy.update` calls
  `group.updateMatrixWorld(true)` itself. Anything else raycast against needs
  its transform current too — the aiming laser had to refresh it before using
  `lookAt`, which takes a *world*-space target.
- **`pos.y` is an entity's feet height.** Every visual offset builds on it
  (bob, death topple, blood spawn). Setting a world Y directly reintroduces
  floating hostiles.
- **Game time, not wall clock.** Gameplay compares against `game.time`. Health
  regen once used `performance.now()` and silently never fired. The exception
  is FPS calibration, which deliberately uses wall clock because `dt` is
  clamped.
- **The view model renders in its own scene** over a cleared depth buffer, so
  the weapon never clips into geometry. It has its own camera and lights.
- **Perch-holders never leave a perch.** Marksmen do not drift while unalerted,
  do not strafe on a perch, and get a longer stuck-watchdog leash. All three
  routes had to be closed before they stopped falling off roofs.

## Testing approach

Checks step the loop manually at a fixed timestep rather than waiting on
frames. Three things make results repeatable, and all three were bugs first:

1. The render loop is stopped during checks (`setAnimationLoop(null)`),
   otherwise it steps the game on real frame timing underneath the test.
2. Every check reloads the page, so none inherit another's state.
3. The seed is pinned and re-applied after boot.

`--seed=N` replays an exact city. When something looks wrong, reach for
`tests/probe.js` before reasoning about it — every real bug here was found by
looking at state, and guessing first cost hours.

Test setups have historically been buggier than the game. Common traps:
hardcoded aim heights (use the actual part's world position), unvalidated
firing lines (use `__place(range)`), and setups that kill the player, which
flips `game.state` to `'dead'` and makes all later damage a silent no-op.

## Performance

Shadow mapping dominates — roughly 8x the rest of the scene combined. Quality
tiers (`applyQuality`) drop it first; `auto` measures wall-clock FPS over the
first seconds of a run and steps down once under 40. World pass is ~1000 draw
calls, one mesh per box; merging static geometry per material is the biggest
available win and is not done yet.

All frame-rate figures in this repo's history come from software rendering,
which exaggerates shadow cost. Relative ordering holds; absolutes do not.

## State

`main` has everything through the graphics pass (PR #1, merged). Suggested
next work, in the order I would do it:

1. **Objectives** — the map is 200m of city and the optimal play is still
   standing in the plaza. Caches to reach, a position to hold, an extraction.
   Wave-manager work; everything it needs already exists.
2. **Vault and mantle** — you can climb stairs but not onto a 1.5m car roof.
   `groundHeight()` already provides what a mantle check needs.
3. **Positional audio** — sounds are mono, so you cannot hear which side fire
   is coming from. `PannerNode` in the already-centralised audio module.
4. **Merge static city geometry** — cuts draw calls by an order of magnitude.
5. **CI** — `npm test` exists but nothing runs it on push.
