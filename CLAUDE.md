# ASHFALL — working notes

A browser FPS: wave survival in a procedurally generated ruined city. No build
step to run it, no asset files, no network calls at runtime. Three.js is
vendored in `vendor/`; everything else is hand-written.

Read `README.md` first for what the game *is*. This file is for changing it.

## Commands

```bash
npm start                      # serve at http://localhost:8000 (no deps needed)
npm test                       # 19 headless checks (needs npm install first)
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
| `src/objectives.js` | Site placement, channel state machine, marker, waypoint |
| `src/grenades.js` | Fuse, flight, bounce, detonation |
| `src/effects.js` | Pooled tracers, impacts, blood, casings, explosions |
| `src/textures.js` | Every texture, painted to canvas at boot |
| `src/post.js` | Bloom, tone mapping, grade, vignette, grain |
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
- **So does three's, and it spends four numbers per object.** Every material,
  texture, geometry and `Object3D` gets a UUID at construction, and
  `generateUUID` draws four `Math.random()` calls to build it. Creating one
  material more or fewer before the city is laid out shifts the whole stream,
  so a given seed lays out the same city only within one version of the code:
  the graphics pass that merged the car materials and added roughness maps
  moved every seed's city. Runs stay repeatable, `--seed=N` still replays an
  exact city, and nothing about generation changed — but a seed written down
  in an old note does not point at the city it used to. Worth fixing properly
  one day by giving generation its own generator instead of the global one.
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
- **The city you see and the city you shoot are different objects.** Once
  generation finishes, `bakeStatic` merges every static mesh by material and
  puts those in the scene; the meshes they were built from leave the scene
  but stay in `world.solids`, off the graph with their matrices frozen, and
  those are what `hitscan` traces against. Tracing the merged copy instead
  would test every triangle in the sector per pellet, and would change what a
  bullet can hit — the solid set is deliberately not everything you can see
  (a parapet is decoration; the wall under it is not). Anything added to the
  city after the bake has to be registered in both or it is invisible to one
  of them.
- **Tone mapping belongs to exactly one stage.** With post on, the scene pass
  stays linear and `post.js` applies the ACES curve; with post off the
  renderer does it. Both at once looks chalky and washed. `Post.configure`
  owns that switch — do not set `renderer.toneMapping` anywhere else.
- **Perch-holders never leave a perch.** Marksmen do not drift while unalerted,
  do not strafe on a perch, and get a longer stuck-watchdog leash. All three
  routes had to be closed before they stopped falling off roofs.
- **A mantle owns the player for its duration.** `Player.update` returns early
  while `player.mantle` is set — no gravity, no collision, no walking, no
  firing — so a pull-up cannot be interrupted halfway and leave you standing
  inside the ledge you were climbing.
- **An objective cue waits, it is not dropped.** Only one objective runs at a
  time, and their clocks outlive the wave that called them. Refusing a cue
  while one was up meant whole waves passed with no objective at all; cues now
  queue and expire on their own deadline (`cueObjective`).
- **The stuck watchdog is a last resort, never a nudge.** It relocates a
  hostile 20-45 m away, usually out of view, so every false trigger is an
  enemy vanishing mid-charge in front of the player. Three guards keep it
  honest: progress is judged by *both* the hostile's own travel and the
  distance it closed on a target that was not itself running (closing distance
  alone condemns anything chasing a player who walks faster than it — which is
  all of them); the failure has to persist across several windows, because
  walking around a city block takes longer than one; and it never fires while
  the player can see the hostile. Whatever moves a hostile outside its own
  walking must re-snapshot with `markWatchdog` — measuring the next window
  from where it was pulled out of is what turned one teleport into a chain.
- **A gun with nothing behind it is not a weapon.** An empty mag reloads; an
  empty mag over an empty reserve swaps to something loaded (`switchToArmed`).
  Holding the trigger on a dead gun gives a dry click every 0.28 s and nothing
  else, and the reload prompt hides itself in exactly that case, so it reads
  as the gun having jammed. A bot that emptied its pistol spent 167 seconds of
  a 4-minute run clicking at hostiles with a full rifle in its loadout.

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

Two more, both from the objective checks. Clearing `spawnQueue` after
`startRun()` only holds for the three seconds until wave 1 begins — anything
stepping longer than that needs `g.startWave = () => {}`. And score deltas
measured across a long step pick up the wave-clear bonus, so wrap
`onObjectiveSecured` to measure a payout rather than differencing `g.score`.

A third, from the ledge check, and the reason it only showed on one seed:
the centre of a box's face is not always a place you can climb from. A crate
can overlap something much taller, and then the deck you would land on has a
wall standing in it — refusing that climb is right, so a setup that demands
it is testing the wrong spot. Validate the landing before demanding the
climb, the same discipline `__place` applies to a firing line. A check that
only ever tries one approach per obstacle is asserting something the game
never promised.

A fourth, and the most expensive to date, because it first read as a game
regression: a bot that flees what it is measuring grades itself, not the
game. The scripted run's bot backed away whenever it had no line of sight,
and the player walks faster than every archetype, so it could never be caught
and the wave never arrived. A teleport bug had been hiding that for as long
as it existed. When a check that drives the player starts failing, measure
what the bot spent its frames doing before concluding anything about the
game — and once a setup is changed, confirm the check still passes on the
code from *both* sides of whatever it was accusing.

## Performance

Shadow mapping dominates — roughly 8x the rest of the scene combined. Quality
tiers (`applyQuality`) drop it first; `auto` measures wall-clock FPS over the
first seconds of a run and steps down once under 40.

Draw calls used to be the other half of the bill. Measured mid-run on seed
20260813, the world pass was 567 calls for 9,978 triangles — about 18
triangles a call — and the shadow pass added 519 more, so a frame that drew
17k triangles cost 1,086 calls. `bakeStatic` (see the invariant above) merges
the city by material and takes that to 39 calls for 34k triangles: more
triangles, because a merged mesh spanning the city cannot be frustum-culled,
and at this scale triangles are free while calls are not.

What that buys is headroom, and the graphics pass spent it: PBR materials, a
sky environment map and a bloom-plus-grade post chain all landed on top of
the saving. If more is needed later, the next things to reach for are baked
vertex AO and per-building tint (both nearly free now that the geometry is
merged — the attribute rides along), and splitting the merge per city block
so culling comes back.

All frame-rate figures in this repo's history come from software rendering,
which exaggerates shadow cost. Relative ordering holds; absolutes do not.

## State

`main` has everything through the graphics pass (PR #1, merged). Objectives
landed after it (PR #3): caches, beacons and evac windows, cued by the wave
manager, with a light column, a screen waypoint and a radar bearing to find
them by. Mantling came next: `Space` against a waist-to-chest ledge pulls you
onto it (`World.mantleTarget` + the `Player.mantle` state machine), so car
roofs, planters and low walls are now cover you can take rather than obstacles
you bounce off. Reach is 1.8 m above the feet, so holding `Space` through a
jump reaches about 2.6 m; a building face is never a ledge because the test
rejects anything with no deck to stand on past the edge.

Two bugs came back from play and are fixed on top of that (PR #5, merged),
both found by measuring rather than reading (`tests/probe.js`, then a check in
the suite — each new check was confirmed to fail against the old code before
being kept). Hostiles appeared to teleport: the stuck watchdog was firing on
healthy hostiles roughly every nine seconds of ordinary play, twice a minute
in full view of the player, and chaining because it re-measured from the
position it had just moved them off. And the gun appeared to jam: once a
weapon's reserve hit zero the trigger only clicked, with no reload prompt, no
swap and no explanation — a scripted run spent 167 of 240 seconds like that,
reaching wave 2 instead of wave 4. Both invariants are written up above.

The same PR fixed the ledge check, which failed on seed 20260101 by always
approaching the dead centre of a box's face; on that seed the centre of one
crate has a 2.6 m wall standing in the deck you would land on, so refusing to
climb was right. `World.mantleTarget` is unchanged.

CI runs the suite and the one-file build on every push to `main` and every PR
(`.github/workflows/ci.yml`), and attaches the built `ashfall.html` to the run.
Chromium is cached on the resolved Playwright version, so a run is a couple of
minutes rather than the download. If the browser install ever starts failing,
the harness falls back to `PLAYWRIGHT_BROWSERS_PATH` and `ASHFALL_CHROME`.

PR #4 carried all three of those — the CI workflow, mantling and the Vercel
config — and is merged, as is PR #5 above it; `main` has both. That also
settled the open question about the workflow, which had never run outside this
container: it has passed on every pull request and every push to `main` since,
about five minutes a run. PR #6 merged after them, carrying the corrected
scripted-run bot and its notes, so everything described in this file is on
`main` and nothing is open. All three merged from
`claude/abandoned-city-fps-game-j2xn80`, so that branch keeps being restarted
from `main` rather than stacked on finished history.

After PR #5 the scripted-run check began failing on seed 1, and the first
reading of that was wrong: it looked like PR #5 had slowed wave pacing,
because the false relocations it removed had been quietly doing a second job
— a relocated hostile lands 22-45 m from the player, nearer than the 26-62 m a
fresh spawn walks in from, roughly every nine seconds. Measuring properly
showed the opposite. With a bot that simply advances, seed 1 reaches wave 4
with 38 kills after PR #5 against wave 3 with 26 before it, and the median
time from spawn to engagement went from 10.8 s to 9.0 s. Pacing improved.

What had actually broken was the check's bot. On no line of sight for five
seconds it held `KeyS` and walked backwards — at 5.2 m/s, away from
archetypes that top out at 4.6, so the retreat never ended and it outran the
wave it was measuring: 56% of a four-minute run spent backing off, 72%
strafing blind, 10% firing. The old teleport bug had been papering over that
by re-inserting hostiles at 22-45 m. The bot now backs off only from a threat
inside 12 m and keeps closing while it flanks, which is what its own comment
always claimed it did. Seeds 1 and 20260813 pass on the code from *both*
sides of PR #5 with the corrected bot, which is the check that it measures
the game rather than the change.

One seed-dependent failure was open before the graphics pass: on seed
20251111, `stairs carry the player onto a perch` reported only 3 of 5 perches
walkable. That seed no longer generates that city (see the `generateUUID`
invariant), so it is unreproduced rather than fixed, and there is nothing
left to reproduce it with. If it comes back it will come back somewhere else.

**A wave can deadlock on a hostile that cannot path to you, and this is
open.** A hostile steers straight at the player and has no pathfinding; with
a building between them it slides along the wall face indefinitely. The stuck
watchdog is supposed to be the backstop and does not fire, because a hostile
sliding along a wall keeps *changing* its distance to the player — any window
where it closes 1.5 m resets `noProgress`, so the several-window requirement
is never met. The wave never clears and the run is over.

Measured over six seeds, on the code from *both* sides of the graphics pass:

| seed | before | after |
| --- | --- | --- |
| 1 | pass | pass |
| 7 | pass | **fail** — wave 2, 156 s no contact |
| 4242 | **fail** — wave 1, 224 s | pass |
| 31337 | pass | pass |
| 99991 | pass | **fail** — wave 3, 144 s |
| 20260101 | pass | pass |

So it is roughly one city in four either way, it predates this work, and the
graphics pass only moved *which* cities have it, by moving every seed's city.
The suite's pinned seed moved with them: 20260813 now generates a deadlock
city, which is why the default seed in `tests/run.js` is 1. That is the same
kind of pin it always was — a seed whose city happens not to trip the bug —
but it is worth being clear that the suite is one allocation away from
re-rolling into a red build, and that the real fix is the watchdog, not the
pin. The reproducer while it lasts is `node tests/run.js --seed=20260813`.

The fix, when someone takes it: judge progress over a longer horizon than one
window. Net displacement from where a hostile was ten seconds ago separates
sliding along a wall (small) from a genuine chase around a block (large),
where per-window closing distance cannot. It has to keep all three existing
guards, because a false relocation is a hostile vanishing in front of the
player.

The graphics pass on top of all that is three changes that only make sense
together, each one paying for the next:

1. **The city is merged by material** once generation finishes (`bakeStatic`),
   which is where the frame budget came from — see Performance above.
2. **Surfaces are PBR and the sky lights them.** The dusk gradient already
   painted for the dome is run through a `PMREMGenerator` and hung on
   `scene.environment`, so every surface reflects the sky actually above it.
   That only works on Standard materials, so the city and the view model
   moved off Phong and Lambert, with roughness (and, for rust, metalness)
   packed out of each texture's own luminance by `TEX.surfaceFrom` — the same
   trick `normalFrom` already played. The hemisphere light dropped from 1.25
   to 0.55 and the cool fill from 0.85 to 0.65 to make room, or the shade
   washes out.
3. **A post chain** (`src/post.js`): float target, bloom, ACES, grade,
   vignette, grain. Hand-written, because `EffectComposer` is in three's
   examples and this repo vendors only the core. MSAA moved onto the render
   target, since the canvas's own does nothing once the scene is drawn into
   one. Low tier skips all of it and hands tone mapping back to the renderer.

Three things about that are worth knowing before changing it. The tone-mapping
switch and the two city representations are invariants, written up above. And
the cities themselves moved: creating fewer materials and more textures
shifted the seeded stream, for the reason in the `generateUUID` invariant. So
the seed-specific notes below describe cities that no longer exist at those
seeds — including the open stair failure, which is why it is now recorded as
unreproduced rather than open.

Deployment is static and must stay that way. `vercel.json` overrides the build
and install commands to no-ops and serves the repo root; `.vercelignore` keeps
`tests/`, `dist/` and `.github/` out of the upload. Autodetect breaks two ways:
`npm install` pulls Playwright, which fetches a browser on postinstall, and
`npm run build` writes `dist/ashfall.html` — never an `index.html` — so there
is nothing to serve at `/`. That diagnosis was inferred from how the repo is
built, not read off a failing Vercel log. The published file set was verified
by staging exactly what `.vercelignore` leaves (22 files) and booting it from a
bare static server: no console errors, no failed requests. Pointer lock needs a
secure origin, which Vercel provides.

Suggested next work, in the order I would do it:

1. **Tune the objective economy.** The payouts (300/500/750 per wave) and the
   clocks (55/80/65 s) are first guesses. Whether crossing the sector actually
   beats holding the plaza is a play question, not a code one.
2. **Break the texture repetition.** This is the biggest remaining *visual*
   gap, and it is not a resolution problem — at 512² over a 4 m tile the
   texel density is fine. It is that there are five facade textures, every
   building of a style gets the identical one, and `TEX.facade(style, seed)`
   takes a seed that is only ever called with `0`. Three things, cheapest
   first: use that seed for two or three variants per style; bake a
   per-building tint into vertex colours at merge time (free now that the
   geometry is merged — the attribute rides along in `mergeIntoOne`); bake
   vertex AO the same way, darkening ground contacts and inside corners,
   which is what a city of right angles is really missing.
3. **Positional audio** — sounds are mono, so you cannot hear which side fire
   is coming from. `PannerNode` in the already-centralised audio module.
4. **Let hostiles mantle too.** `World.mantleTarget` is entity-agnostic, but
   only the player calls it, so a car roof is still a place they cannot follow
   you to.
5. **Convert the hostiles to PBR.** The city and the view model are Standard
   materials reading the sky environment; enemies are still Lambert and mint
   four materials each, so they neither catch the sky nor batch.

One piece of housekeeping that cannot be done from here: the merged branch
`claude/project-memory` still exists on the remote. Deleting it returns 403
through the agent proxy, and the GitHub tools available here have no
delete-branch call, so it needs a hand on a normal client. Do not spend time
retrying it.
