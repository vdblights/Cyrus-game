# ASHFALL — working notes

A browser FPS: wave survival in a procedurally generated ruined city. No build
step to run it, no asset files, no network calls at runtime. Three.js is
vendored in `vendor/`; everything else is hand-written.

Read `README.md` first for what the game *is*. This file is for changing it.

## Commands

```bash
npm start                      # serve at http://localhost:8000 (no deps needed)
npm test                       # 30 headless checks (needs npm install first)
npm run build                  # one-file dist/ashfall.html, no external refs
node tests/probe.js --list     # canned probes
node tests/probe.js "g.perches.length"   # ask the running game anything
```

`npm install` + `npx playwright install chromium` are only needed for tests and
builds, never to play.

## Working agreement

- **A feature branch ends in a pull request.** When the work on
  `claude/abandoned-city-fps-game-j2xn80` is finished and pushed, open the PR
  against `main` — do not leave the branch sitting pushed and wait to be
  asked. Every PR in this repo's history came off that branch, which is
  restarted from `main` after each merge rather than stacked on finished
  history.
- **Do not record pull request status in this file.** Which PR is open, and
  what is merged, belongs to `git log origin/main..HEAD` and the repo's PR
  list. A status line here is wrong the moment anyone merges, and it was the
  only thing needing correction in four sessions running. Write down what was
  *learned* and what it *measured*; leave the bookkeeping to git.
- **This file is the only memory that survives.** Sessions run in a container
  that is reclaimed when they end, so anything worth keeping — a preference, a
  measurement, a trap someone already fell into — belongs in here or in
  `README.md`, committed. Nothing written to a home directory outlives the
  session.

## Architecture

| File | Owns |
| --- | --- |
| `src/main.js` | `Game`: loop, scene, lighting, waves, hit resolution, blasts |
| `src/world.js` | Box collision (square or turned), ground height, line of sight, sphere bounce |
| `src/city.js` | Procedural generation; returns `{ world, fireBarrels, perches }` |
| `src/player.js` | `Input` and `Player`: look, movement, footing, health |
| `src/weapons.js` | Weapon defs, view models, firing, recoil, melee |
| `src/enemies.js` | Archetypes, AI, procedural bodies, laser telegraph |
| `src/objectives.js` | Site placement, channel state machine, marker, waypoint |
| `src/grenades.js` | Fuse, flight, bounce, detonation |
| `src/effects.js` | Pooled tracers, impacts, blood, casings, explosions |
| `src/textures.js` | Every texture, painted to canvas at boot |
| `src/shapes.js` | Chamfers, lofted profiles, geometry merging — the shapes that are not boxes |
| `src/post.js` | Bloom, tone mapping, grade, vignette, grain |
| `src/audio.js` | Every sound, synthesised via Web Audio |
| `src/hud.js` | DOM readouts, killfeed, radar, capture banner |
| `src/nav.js` | Walkable grid over `world.boxes`, and a route field to the player |
| `src/rng.js` | Seeded `Math.random` for the page's lifetime, and `reserve`/`spend` |

The whole game hangs off `window.__game`, which is how tests and probes drive it.

## Invariants worth not breaking

These each cost real debugging time. Changing them needs a reason.

- **One box list drives everything.** Collision, ground height, line of sight
  and grenade bounce all read `world.boxes`. Register a solid once and every
  system sees it. Anything decorative (rubble, lips, sky) stays out of it.
- **A box may be turned, and the turn is part of the collider.** Every box
  carries `cx/cz/hx/hz` and the `cos/sin` of a Y rotation alongside
  `minX..maxZ`. The min/max is the enclosing AABB, kept as a cheap reject and
  for the readers that only want a bound — `occupied`, where every caller is
  placing something and wants clearance rather than contact, and the nav bake,
  where claiming slightly too much is the safe direction. `resolve`,
  `groundHeight` and `bounceSphere` transform into the box's own frame, where
  every box is axis-aligned and the transform is the identity for the ones
  that already are, so there is one code path and not two. `lineOfSight` is
  the exception in form only: it uses the AABB slabs as a reject and confirms
  against the footprint, because it is the AABB's *corners* that stick out
  past a turned prop. Registering the enclosing AABB and living with it is
  what the turned props used to do, and it is worse than it sounds. A 2.5 x
  6 m container at 30 degrees claimed 5.2 x 5.8 m of street; a barricade — a
  2.2 x 0.7 m slab — registered a 2.2 m square whatever its angle, three
  times its own footprint, so three quarters of a metre of nothing stopped
  you either side of every barrier. Measured on seed 1 over 99 turned props
  and 16 headings each, the empty air between a prop and where you come to
  rest went from 2.98 m at worst and 0.40 m on average to 0.43 m and 0.089 m.
  What is left is a cylinder meeting a corner at the corner, which is honest.
  `addRotatedBox` is how a turned prop registers; `addBox` still covers
  everything square, which is the whole city apart from four props.
- **Footing asks how much floor is under the feet, not how wide the body is.**
  The `radius` argument to `groundHeight` is a question, not a constant. The
  footing checks in `Player.update` and `Enemy.update` pass `SUPPORT_RADIUS`
  (0.12 m); a clearance test — "is there room for a whole body here?" — passes
  the body radius (0.42 m). Passing the body radius to both, which is what
  they used to do, supports an entity anywhere its cylinder so much as clips a
  surface: you stood 0.42 m out past every roof edge on nothing, every gap
  narrower than two radii was invisibly bridged so you ran between crates that
  are plainly separate, and a kerb lifted you before you had reached it. Seed
  1 measures 0.12 m of overhang across 82 clear edges against 0.42 m, and no
  walkable gap wider than a quarter metre against 17. The floor under the
  constant is the construction seams between abutting boxes — a stacked
  container is jittered up to 0.4 m, leaving joints of 0.05-0.15 m — which it
  has to span or you fall down them. `mantleTarget` asks the same way for the
  deck it promises, or a climb finishes onto ground the footing check will not
  then find and drops you straight off it.
- **Line of sight must stay symmetric.** It is a three-slab segment test. An
  earlier version only checked height at the entry point, which let a hostile
  see a target that could not see it back.
- **`Math.random` is seeded and the stream order matters.** Do not spend it on
  cosmetics, per-frame or per-surface — an earlier fire flicker did, and
  identical runs diverged. Deterministic noise instead (`flickerFires`), or a
  hash of the position (`tintAt`, `wallUV`).
- **So does three's, and it spends four numbers per object.** Every material,
  texture, geometry and `Object3D` gets a UUID at construction, and
  `generateUUID` draws four `Math.random()` calls to build it. One material
  more or fewer before the city is laid out used to shift every later draw, so
  a seed only laid out the same city within one version of the code, and every
  graphics change was a layout change by accident.
  `rng.js` now exports `reserve(fn)`, which runs `fn` and rewinds the stream
  to where it started; the shared materials in `buildCity`, and the sky,
  environment, dust, pickups, effects and view model in `main.js`, are all
  built inside it. **Shared look — a material, a texture, a view model —
  belongs in a `reserve`.** It works: adding three more rust materials and the
  nine textures behind them, late in the texture pass, left seed 1 with the
  same 332 boxes, 405 solids and 12 perches it had before them. What each
  builder mints *per object* still spends the stream and has to, because those
  objects are the city. None of this undoes the moves already made: the texture
  pass shifted every seed one last time, because the setup that no longer
  spends the stream used to. A seed in a note older than that pass does not
  point at the city it did.
- **Decoration draws from its own generator, so it is free.** The note above
  used to end by saying a purely decorative mesh added inside a builder would
  move every seed regardless, "short of giving generation its own generator".
  `decor()` in `city.js` is that generator, and it turns out to be the whole
  answer: it points `Math.random` at a private mulberry32 for the duration of
  the call and rewinds the global stream underneath, so both the UUIDs the
  decoration mints and the choices it makes cost the layout nothing. The
  relief pass — plinths, pilasters, string courses, roof furniture, awnings,
  downpipes, fire escapes, overhead cables, about 1,300 boxes and 19k
  triangles — left seeds 1, 7 and 20260101 with exactly the boxes, solids and
  perches they had before it.
  Two rules keep it true. **Anything registered in `world.boxes` or
  `world.solids` is not decoration** and must not be built inside `decor`:
  its placement *is* the city, and the city is what a seed is for. And
  because decoration is in neither list, it is something you walk through and
  something bullets ignore — so it has to live where you can do neither, on a
  wall, on a roof, or above head height. That is why the fire escape's lowest
  platform is at 4.6 m and why there are no bollards. The road markings are
  the fourth place and the one that is easy to miss: flat on a surface you
  already walk over and bullets already pass through to. A marking 2 cm off
  the ground is walked over because the ground under it is what the footing
  reads, and shot through because the impact lands on the ground plane 2 cm
  below the paint, which is nowhere the eye can find. Anything *flush* with
  an existing surface is safe decoration; anything standing off one is not.
  What `decor` cannot help with is a prop whose collider *is* the city — a
  wreck, a barrier, a container. That is what `spend` is for; see "what a
  prop costs the seeded stream" further down.
- **The route field is a hint, never an authority.** `nav.js` builds a 1.5 m
  grid off `world.boxes` and a Dijkstra cost field from the player, rebuilt
  only when they cross a cell. Nothing in it moves a hostile or decides what
  is solid — `World.resolve` still does that — and `heading()` answers "no
  idea" for anywhere it does not cover, which includes every rooftop, because
  a perch stands in a blocked cell by construction. Every caller must have a
  fallback, and the fallback is the old behaviour: steer at the player.
  Two things about the bake are load-bearing. It marks cells a solid
  physically overlaps *and* cells whose centre is within a shoulder of it,
  and neither pass can replace the other: without the first, a wall thinner
  than a cell slips between two centres and routes run through it; with the
  second written as "every cell the widened solid touches", a cell loses its
  whole 1.5 m for being clipped at one corner and the streets close up. On
  seed 1 that is 9,328 walkable cells and 99.9% coverage against 7,622 and
  97.2% — measured, and guarded by a check at 0.995.
  And it builds no three objects at all, not even a Vector3, because every
  `Object3D` spends four numbers of the seeded stream on a UUID. Typed arrays
  only. That is why the file imports nothing.
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
  of them. The ground is the sharpest case: the one you see is subdivided to
  about 2.5 m so it can carry baked shading, and the one you shoot is the same
  plane at two triangles, because three has no BVH and a raycast walks every
  triangle inside the bounding sphere — the ground's covers the sector.
- **The bake is also where shading is baked.** `shadeGeometry` runs over each
  mesh once it is in world space, writing a `color` attribute that
  `mergeIntoOne` carries: a per-building tint, plus ambient darkening — floors
  read a blurred occupancy grid built from `world.boxes`, walls fade toward
  their own footing. Every city material therefore has `vertexColors: true`,
  and any geometry merged into one of them needs the attribute or it comes out
  white. It is the cheapest thing in `city.js` and close to the most valuable:
  shadow maps give you the sun, not the light a wall keeps out of the gutter.
- **A texture declares the world size it covers, and the geometry obeys.**
  `TILE` in `textures.js` is the contract — 8 m of asphalt, 4 m of concrete,
  10 m of facade, 0.3 m of gun polymer — and `boxGeo` unwraps every face planar at that scale from
  its own position and normal, which is why it survives subdivision. `cylGeo`
  does the same for the round props, which had been outside the contract
  entirely: three's own cylinder unwrap runs 0..1 around the barrel whatever
  its size, so a 0.4 m drum and a 7 m pole wore the same tile at completely
  different scales, and the fountain ring stretched one tile over twenty
  metres of circumference. Get it wrong and nothing errors, it just looks bad
  in a way that is hard to name: the ground used to stretch one 512px tile
  over 54 m, nine pixels to the metre, and a facade crammed four floors into
  four metres so buildings read as noise. A check measures texels per metre
  off the merged city now and fails if any material drifts from what it
  declares. Wall UVs are snapped on
  top of that to the window bay and the storey (`wallUV`), so a corner never
  cuts a window in half and floor lines meet the ground and the roof square.
- **A canvas `filter` blur costs a full-canvas convolution per draw call.**
  Not per shape — per call, over the whole clip. Ninety soft rust blooms on a
  1024px tile is ninety convolutions of a megapixel; it took five seconds a
  facade and made boot 77 s under software rendering. `softLayer` paints
  low-frequency shapes into a 96px canvas and lets the upscale smooth them,
  which is the same picture for about a thousandth of the cost. Nothing in
  `textures.js` should set `ctx.filter` again.
- **Anything that is not a box comes out of `shapes.js`, and its winding is
  computed, not written.** `chamferGeo` builds a box with its edges broken: 20
  extra triangles that put a moving highlight along each edge, which is most
  of what "boxy" means when one sun lights a cube. `loftGeo` describes a shape
  by its cross-sections instead of by a width and a depth, which is the other
  half of it — a jersey barrier is a kinked profile, a car's greenhouse is a
  raked one, and both read as furniture the moment the sides stop being
  vertical. `loftGeoZ` lays the same loft down so the sections run along the
  length of the thing, which is how a bonnet is described. All three unwrap
  planar at a declared `TILE`, so the texel-density check covers them, and all
  three derive each facet's winding by testing the cross product against the
  intended normal. Hand-writing that order gets every facet with an odd number
  of negative axes backwards, and an inverted facet does not error, it
  vanishes — so it reads as a notch bitten out of the part. It has been
  shipped twice, on the view model and on the road markings. `nothing is built
  inside out` measures the whole merged city, every prop shape and every
  hostile; restoring a hand-written order reports 21,198 of 142,754 city
  facets inside out.
- **What a prop costs the seeded stream is a bill it pays, not a side effect
  of how it is built.** Three spends four draws on a UUID for every object
  (see the `generateUUID` invariant above), so the *number of meshes* a wreck
  happens to be assembled from is part of where the next wreck parks. That
  made every change to how something looks a change to the layout, and is why
  a seed only ever described the same city within one version of the code.
  `decor` solved it for anything purely decorative; a wreck is not decorative,
  because its collider is the city. The answer is the other half of `reserve`:
  build the shape inside it, where the stream is rewound, and then pay a fixed
  `spend(n)` for what the prop used to cost. The stream then sees a constant
  whatever the prop is made of. `wreckedCar` pays 4 for its group, 24 for
  three panels and 32 for four wheels, *in that order and interleaved with its
  own rolls exactly as they used to be*, because the value a roll receives
  depends on how many draws came before it; `barricade`, `container`,
  `containerStack` and `fireBarrel` pay 8 apiece. Those numbers are
  archaeology and are meant to stay that way — the point is that nobody has to
  think about them again. Measured across seeds 1, 7, 99991, 20260101 and
  20260813, rebuilding the wrecks, barriers, containers and drums left every
  box, perch and barrel exactly where it was, and `a seed still lays out the
  city it did` is the check that keeps it so.
- **Kit that is not a hit zone is armour you shoot through.** A hostile's
  plate, pauldrons, hood and pouches are merged into the meshes that already
  carry a `zone` — the torso, the rig, the head — rather than hung beside them
  as extra meshes. A mesh with no zone is not in `hitMeshes`, so it is not
  raycast: kit hung on loose would be a silhouette bullets pass through, and
  would also put another dozen meshes per hostile into the per-pellet
  intersect list. The same merge is why a hostile is now 12 meshes rather than
  15 while carrying six times the triangles.
- **A part's own position is where that part is.** The kit geometry is built
  *about* each part's origin (`AT` in `enemies.js`) and the mesh is placed
  there, not baked to world height with the mesh left at zero. Every check
  that shoots a hit zone reads `parts.head.getWorldPosition()`, which is the
  testing note about hardcoded aim heights from the other side: baking the
  offsets in put every part at the feet, and turned the headshot check into a
  leg shot that quietly still passed the "did damage" half.
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
  inside the ledge you were climbing. Owning the view means owning every
  discontinuity in it: the climb starts from the eye height and the momentum
  the player actually had and hands both back where it left them. The first
  version set the eye height straight to `EYE_CROUCH`, which dropped the view
  0.63 m between one frame and the next, and zeroed the velocity on
  completion, which stopped you dead on the ledge. A check measures the view's
  movement at each of the three seams — the frame the climb starts, the curve
  in between, and the frame it hands back — because a climb is allowed to be
  quick and is not allowed to teleport.
- **An objective cue waits, it is not dropped.** Only one objective runs at a
  time, and their clocks outlive the wave that called them. Refusing a cue
  while one was up meant whole waves passed with no objective at all; cues now
  queue and expire on their own deadline (`cueObjective`).
- **The stuck watchdog is a last resort, never a nudge.** It relocates a
  hostile 20-45 m away, usually out of view, so every false trigger is an
  enemy vanishing mid-charge in front of the player. Three guards keep it
  honest: progress is judged by *three* measures, any of which can condemn;
  the failure has to persist across several windows, because walking around a
  city block takes longer than one; and it never fires while the player can
  see the hostile. The three measures each lie on their own. The hostile's own
  travel over one window misses anything that orbits a wall and looks busy.
  The distance it closed misses a hostile chasing a player who simply walks
  faster than it, which is all of them. And both of those are read over four
  seconds, which is too short to tell a slide along a wall from a lap around a
  block — a detour looks identical for its first few seconds, and only where
  it *ends up* separates them. So the third is net displacement over a ten
  second horizon (`trail`): cover ground for ten seconds and finish within
  five metres of where you started and you are not going anywhere. Whatever
  moves a hostile outside its own walking must clear that history with
  `markWatchdog` — measuring the next window, or the next horizon, from where
  it was pulled out of is what turned one teleport into a chain.
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

A fifth, for anything that changes how something *looks*: the suite cannot
assert on pixels, so a look change is not verified until it has been
rendered and looked at. Two framings are worth keeping. In-game, drive the
real view and screenshot it — that is the only thing that shows how dark the
scene actually makes a surface. To judge a model on its own, hide the world
(`g.scene.visible = false`), park the view model in front of the view camera
and stub `weapons.update` so sway does not put it back. Both caught real
faults in the weapon pass within one render each: a gun turned to a
silhouette by a colour multiplying its map, and facets missing because their
winding was inside out. Neither would have shown up in any assertion that
was plausible to write first.

The props pass added a third framing to that fifth trap, for a prop rather
than a view model: hide the merged city (`g.city.visible = false`), put the
shape on a clear patch of ground in front of the player and light it harder
than dusk does. Four things went wrong before a single frame of it was
trustworthy, and all four are worth knowing. The solids are off the scene
graph with frozen matrices, so `getWorldPosition` on one recomputes
`matrixWorld` from its local matrix and hands back the origin — read
`matrixWorld.elements` instead. A line of sight into a prop's own middle is
blocked by the prop, so sight the air above it. Hostiles spread along the
view direction stack up in depth and look like one hostile — spread them
across it. And they charge: stub `e.update` or the lineup is gone by the time
the shutter opens.

A sixth, which is really a tool rather than a trap: the bot that plays the
scripted run lives in `tests/harness.js` as `window.__botRun(seconds)`, not
inside a check, because more than one check now reads it and two divergent
copies of a bot with this much history is worse than one. `game.reload({ seed })`
reboots on a different city mid-suite, which is what a check needs when the
bug it guards is a property of a layout the pinned seed does not have.

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

**Where things stand.** This section describes what is on `main`, and there is
deliberately no line here naming the open pull request. That line was the one
thing in this file that needed correcting in four sessions running, because it
is wrong the moment anyone merges, and a memory that is reliably wrong in one
place teaches you to distrust it everywhere. `git log origin/main..HEAD` and
the repo's pull request list answer it exactly and cannot go stale.

What holds regardless: `npm test` is the contract, every check in it was
confirmed to fail against what it guards before being kept, and the list at
the end of this section is what to do next rather than what was left undone.

The props pass came out of play, and out of one sentence: the cars and the
world obstacles are still too boxy, and the hostiles and their drops need
better skins. All four were true, and all four had the same cause — a prism
wearing a tiled photograph is the flattest thing this renderer can draw, and
every one of these was a prism.

What is different now. A wreck is a profile rather than a crate: a rocker
inset under the doors, a body side tapered in plan at both ends so the nose is
narrower than the doors, a bonnet that falls away and narrows to the nose, a
boot lid, arches standing proud of the tub, a greenhouse raked at both ends,
bumpers, a grille and lamps that catch the sky, and four wheels wearing tread
and a dished steel rim. Two silhouettes — a saloon and a pickup with an open
bed — chosen by a hash of where the thing is parked, so it costs no stream. A
burnt-out shell is the same panels in charred steel with no glass, sitting
0.2 m lower on its rims. A jersey barrier is a jersey barrier: wide splayed
foot, kink at knee height, narrow top, which is the whole reason the shape
exists. A container has corner castings, a sill and top rail, and door leaves
with locking bars. A drum has its rolling hoops. A hostile is wearing
something — a plate carrier with pouches, heavy plate with pauldrons, scrap
strapped on one side, a hood and a long coat, a respirator and a filter — and
every archetype wears its own, because a wave is read at forty metres against
a dusk skyline where the archetype's colour is barely a colour. A drop is a
stencilled case with a lid, banding and latches, or a grenade with a spoon and
a pin ring, instead of two boxes and an icosahedron.

Five textures came with it: tread-and-rim, charred steel, worn cloth, webbing
and a stencilled case. Two things about them are worth keeping. A wheel is one
mesh because `cylGeo` unwraps a barrel and its end caps to different places —
the tread lives in the bottom quarter of the tile, where a 0.3 m wide wheel's
barrel lands, and the hub in the middle, where the caps do, and they barely
touch. And the kit maps are deliberately pale, because `map` multiplies
`color`: the first attempt kept a mid-grey weave under an olive drab coat and
every hostile came out a silhouette at dusk. That is the same mistake the
weapon pass made once and wrote up, made again one file over.

**None of it moved a single city, and that is the part worth reading.** Three
spends four draws of the seeded stream on every object's UUID, so rebuilding a
wreck out of fourteen shapes instead of seven boxes would have moved every
prop placed after it — which is why every look change in this repo's history
has also been a layout change. `spend` in `rng.js` is the fix and the
invariant above has the rule. Measured on seeds 1, 7, 99991, 20260101 and
20260813, before and after: identical box, solid, perch and barrel counts, and
an identical fingerprint over every collider's position, extent and turn.
`a seed still lays out the city it did` pins three of those seeds and was
confirmed to fail — dropping one `spend` call reports seed 1 laying out 339
boxes instead of 332.

What it cost, on seed 1: merged triangles 100,378 → 142,754 in the same 27
draw batches, textures 72 → 78, and boot to the menu 18.5 s → 17.7 s, which is
to say indistinguishable (both inflated about twofold by software rendering).
A hostile went from 15 meshes and 179 triangles to 12 meshes and 1,170,
because the kit is merged into the parts that already carry a hit zone rather
than hung beside them — fewer draw calls per hostile, six times the shape, and
no new meshes in the per-pellet intersect list. Materials and geometry are now
cached per archetype and built at boot inside `reserve`, where they used to be
minted per spawn: a wave of sixteen was sixty-odd one-off materials that no
batching could merge.

One real bug fell out of it. A burnt-out wreck used to hide its cabin and
leave it in `world.solids`, so bullets stopped in the air above every burnt
car in the sector. The cabin is charred steel now and visible, so the solid
and the silhouette agree again.

Three checks came with the pass, each confirmed to fail against what it
guards: `a seed still lays out the city it did` (above), `nothing is built
inside out` — 0 of 142,754 city facets, 0 of 2,552 prop facets and 0 of 5,850
hostile facets, against 21,198 city facets when the winding is written by hand
instead of derived — and `every archetype is kitted, textured, and keeps its
hit zones`, which fails both ways: give two archetypes the same kit and it
names them, and drop a `zone` off the rig and it reports 7 meshes that can be
shot instead of 8.

The suite also caught a regression in itself, which is the fourth entry in the
testing traps and worth the reminder: baking each part's height into its
geometry left every mesh at the group origin, so `parts.head.getWorldPosition()`
returned the hostile's feet and the headshot check became a leg shot — which
still did damage, so only the "head hurts more" half failed. The kit is built
about each part's origin now (`AT` in `enemies.js`).

Road markings landed, which was item 2 of the old list and the one thing the
texture pass deliberately left undone. Lane paint cannot live in the asphalt
tile: that tile repeats every 8 m over a 324 m ground plane, so a centre line
painted into it lands on 100% of the ground, and only 10.5% of the ground is
carriageway — 89.5% of the paint would be on a sidewalk, a lot or a plaza.
The check computes both numbers, so the result line carries its own reason
for existing.

What is there: a centre line down every street, dashed or — on 2 of the 10
streets, by a hash of the street's own position — effectively solid; edge
lines inside both kerbs; a zebra crossing on 32 of the 100 junction
approaches, a stop bar behind each one over the lane that gives way, and a
straight-ahead arrow in that lane. Roughly one marking in six is skipped
outright by a hash of where it would have gone (12% of centre dashes, 14% of
crossing stripes, 18% of edge-line chunks), and the texture under the rest
carries only the wear, so the shape is geometry and the pixels are nothing
but a decade of tyres. Seed 1 lays 2,764 triangles of paint over
552 m²: merged triangles 97,634 → 100,398, draw batches 26 → 27, textures
71 → 74 (the map plus the normal and roughness derived off it), and boot
indistinguishable from noise — a median of 25.5 s against 26.1 s over three
boots each, both inflated about twofold by the suite running alongside.

Four things about it are worth keeping.

The geometry is derived, not declared. `ROAD_HALF`, `STREETS` and
`STREET_END` in `city.js` come off `BLOCK`, `LOT` and `GRID`, which is where
the streets already came from — a sidewalk apron is `LOT + 6` on a lot centre
and lot centres are `BLOCK` apart, so the 6 m between two aprons is the road.
`buildCity` returns them as `streets`, `main.js` hangs them on the game, and
the check reads the same three numbers the generator laid paint off. Change a
lot size and the paint moves with it.

**The street's own frame maps onto the two axes with opposite handedness, and
that flips the winding.** Every marking is described as `u` across the
carriageway and `v` along it, and mapped to world at the last moment: for an
east-west street `(u, v)` becomes `(z, x)` and for a north-south one `(x, z)`.
Those two swaps have opposite orientation, so one corner order comes out
facing the sky on one axis and facing the ground on the other — and a facet
wound the wrong way round does not error, it vanishes. Exactly the lesson the
chamfered view model learned; the fix is the same, which is to say which order
each case wants rather than write one and hope.

Paint is decoration, so it costs the layout nothing and it is in neither
`world.boxes` nor `world.solids` — which is only safe because it lies flush
on a surface you already walk over and already shoot through. That is a
fourth home for decoration alongside a wall, a roof and above head height,
and it is written into the invariant. Measured with the whole pass switched
off and back on, seeds 1, 7 and 20260101 lay out 332/405/12, 296/354/10 and
332/410/12 boxes, solids and perches either way.

The one number that had to be chosen rather than derived is the 2 cm the
paint sits above the ground. Lower and it z-fights; higher and it hovers when
you crouch beside it. A 0.06 m near plane over 600 m cannot separate 2 cm
past about 140 m, so the material carries a polygon offset as well, and a
street was rendered end to end — 198 m of it — and looked at to confirm it.
Five framings were rendered in all, because the suite cannot assert on
pixels: down a street, an approach to a junction at eye level and from low
overhead, straight down onto a junction, and crouched beside a line.
`lane paint lies on the road and faces the sky` guards the placement, the
winding and the count together: 0 triangles past a kerb, 0 wound inside out,
all 10 streets reached. It was confirmed to fail both ways, breaking the
reader rather than the data each time. Using one corner order for both axes
reports 1,396 of 2,764 facets inside out. Laying the paint on `lotCenter(i)`
while the published street grid stays correct reports it running 16.7 m past
the kerb and reaching 0 of 10 streets.

The best-score line on the menu ran through the bottom of the DEPLOY button,
by 8 px, for anyone who had ever finished a run — so the only people who saw
it were the ones with a record to read. A `button` is `inline-block`, so it
sits in a line box and the strut's descender adds space under it that is not
part of the button; `.records` had a `-14px` top margin hand-tuned to cancel
that, and over-cancelled. The button is `display: block` with `margin: 6px
auto` now, so its bottom edge is where it looks, and the records line asks for
an ordinary `10px` above it. `the best-score line sits clear of the deploy
button` measures the gap both ways in one check — 10 px clear against 8 px
overlapping with the old pair of rules re-applied inline — and was confirmed
to fail on the old stylesheet. Nothing else moved: pause and game over were
rendered before and after and differ by 3 px of centring. **Anything the menu
stacks vertically wants a block box and a positive margin**; a negative margin
against a line box's leading is measuring the font, not the layout.

PR #11 merged the collision pass. It came from play: mantling and standing on
things felt wrong, reported as running into objects too early and then running
between objects that are plainly separate once on top of them. Both halves were real, both were
collision rather than the mantle state machine, and the two compound — an
oversized collider closes the gap between two props at the same time as it
stops you early at each of them.

The first half is that a turned prop registered the *AABB around* its
footprint rather than the footprint. The second is that footing asked
`groundHeight` with the body radius, so any surface within 0.42 m of you held
you up. Both are written up as invariants above, with the numbers. Two checks
guard them — `a prop stops you where you can see it, not a metre before` and
`the ground you stand on is the ground you can see` — and each computes the
old value alongside the new one, so the result line carries its own
before-and-after (`worstAsAabb` 2.98 m against `worst` 0.43 m;
`overhangAsBody` 0.42 m and `bridgedAsBody` 17 against 0.12 m and 0).

Both were confirmed to fail against the old behaviour, and the first one is
worth a note: reverting the *registration* makes it fail with "only 0 turned
props to measure", because its subjects are boxes that carry a turn and those
only exist after the fix. That is a real failure but a weak one. Reverting
the *consumer* instead — store the footprint, collide against the AABB — is
the honest revert, and it fails on the assertion itself at 2.98 m. Prefer
breaking the reader over breaking the data when confirming a check bites.

The layout is untouched by all of it: seed 1 still lays out 332 boxes, 405
solids and 12 perches. Nothing here adds an `Object3D` or spends the seeded
stream, and `addRotatedBox` pushes exactly one box where `addBox` pushed one.

The rest of this section is a record of what was built and what it cost to
learn, newest first. Read the invariants and the testing traps above it first
— those are the parts that bite.

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
scripted-run bot and its notes. Every one of them merged from
`claude/abandoned-city-fps-game-j2xn80`, so that branch keeps being restarted
from `main` rather than stacked on finished history.

PR #7 merged the graphics pass described below — the bake, the PBR-and-sky
lighting, the post chain — together with the `generateUUID` and tone-mapping
invariants, the deadlock write-up, and the default test seed moving to 1.

PR #8 merged the texture pass and the weapon pass after it: the `TILE`
contract and snapped wall UVs, ten facade textures, the four rust variants,
baked tint and occlusion, `softLayer`, `reserve` in `rng.js`, the
two-triangle collision ground, the chamfered and textured view models, and
the three checks that guard all of it.

PR #9 merged three things that came out of play rather than out of a plan:
the wave deadlock (written up below), the pull-up feeling jumpy, and the city
still reading as boxes.

The pull-up was two discontinuities and a fixed duration. It set the eye
height straight to `EYE_CROUCH` on its first frame — a 0.63 m drop of the
view between two frames, from a standing start — dipped by the full crouch
depth, and zeroed the velocity at the top so every climb ended in a standstill
and a quarter-second of re-acceleration. It also took 0.45 s whatever the
height, so a 1.8 m wall moved the camera three times as fast as a 0.6 m kerb.
It now starts from the eye height and the direction of travel it actually
had, dips 0.26 m instead of 0.63, runs on smootherstep (zero acceleration at
both ends, not just zero velocity), takes 0.32 s plus 0.22 s a metre, clears
the lip and then settles onto the deck if the two differ, and leaves you
walking at 2.6 m/s in the direction you climbed. The camera also dips and
leans a little through it, which is what makes it read as a haul rather than
a lift. Measured on seed 1: the first frame of a climb moves the view 0.0245 m
against 0.617 m before, and the biggest change in the view's speed between two
frames inside a climb is 0.0109 m against 0.5805 m. `a pull-up carries the
view, it does not jump it` guards all three seams — the frame it starts, the
curve in between, and the frame it hands back — and was confirmed to fail on
the old code.

The city read as boxes because it was boxes: a prism wearing a tiled
photograph of a wall, with a flat top and nothing between the pavement and
the roof. It now has a base course, pilasters on the window-bay lines, a
string course under the cap, roof furniture (stair bulkheads, water tanks on
legs, vent stacks, a run of parapet still standing), shopfront canopies,
downpipes, fire escapes on the taller blocks, and cables slung between the
streetlights — the only lines in the sector that are neither vertical nor
horizontal. `cylGeo` also brings the round props into the `TILE` contract,
which the pole, the drum and the fountain ring had never been in.

All of it is decoration and none of it costs the layout anything, which is
the interesting part and is written up as an invariant above: seeds 1, 7 and
20260101 lay out exactly the cities they did before. Merged triangles go from
78,898 to 97,614 in the same 26 draw batches, with the same 71 textures, and
boot to the menu is unchanged at 12.0 s against 12.1 s.

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

**A wave could deadlock on a hostile that cannot path to you. This is
fixed.** A hostile steers straight at the player and has no pathfinding; with
a building between them it slides along the wall face indefinitely. The stuck
watchdog was supposed to be the backstop and never fired: measured on seed 7,
the last hostile of wave 1 covered 34.5 m of path every ten seconds for 0.5 m
of net displacement, and its `noProgress` sat at zero for the whole run.
Nothing a single four-second window measures separates that from a detour,
because a detour looks the same for its first few seconds. What separates
them is where the hostile ends up, so the watchdog now also judges net
displacement over a ten-second horizon — cover ground and land within five
metres of where you started and you are going nowhere. The invariant above
has the detail; all three existing guards are kept.

Measured over seven seeds with the scripted bot, four minutes each, as the
longest stretch with no hostile reaching or shooting at the player:

| seed | before | after |
| --- | --- | --- |
| 1 | 16.3 s, wave 5 | 8.0 s, wave 4 |
| 7 | **196 s, wave 1, 6 kills** | 9.0 s, wave 4, 27 kills |
| 4242 | 5.5 s, wave 4 | 27.5 s, wave 4 |
| 31337 | **113.8 s, wave 3** | 16.7 s, wave 4 |
| 99991 | 13.4 s, wave 5 | 14.6 s, wave 5 |
| 20260101 | **219 s, wave 1, 6 kills** | 18.3 s, wave 4 |
| 20260813 | 11.7 s, wave 4 | 5.7 s, wave 4 |

Three cities in seven were deadlocked and none is now; the worst gap left is
27.5 s, against a check threshold of 90 s. Note that 20260813 no longer
deadlocks either — the texture pass moved every seed again after the note
that named it as the reproducer, which is the same lesson as before: a seed
in a note older than the last layout move does not point at the city it did.

The cost is more relocations, which is the thing PR #5 spent its time
removing, so it was measured too: seed 1 goes from 12 to 16 over four minutes
(one per 15 s across 8-16 hostiles), and 0 of them happened in view of the
player on any seed. The two deadlocked seeds went from 1 and 0 relocations in
four minutes — the watchdog doing nothing at all — to 15 and 8.

`a wave never deadlocks on a hostile that cannot path to you` guards it, and
it reboots onto seed 7 to do so, because whether a city has a corner that
traps a hostile is a property of the layout and the pinned seed does not have
one. If a future layout move takes the bug away from seed 7 as well, that
check stops testing anything — it will still pass, which is the failure mode
to watch for. The honest fix underneath is pathfinding, which landed in
PR #10 — see below; the watchdog stays as the backstop it was written as.

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

The texture pass on top of all that started as item 3 on the list below and
went further, because measuring the repetition turned up something worse than
repetition underneath it.

1. **Every tile declares the world size it covers** (`TILE` in `textures.js`),
   and `boxGeo` unwraps each face planar at that scale. This was the real
   problem, and it was never resolution: the ground stretched one 512px
   asphalt tile over 54 m — nine pixels to the metre, which is why the street
   read as brown mud, and why the lane markings painted into that tile came
   out as a stripe every 54 m with no relation to where the streets are. The
   facade tile was wrong the other way: four floors and four window bays
   crammed into four metres, so a window was a metre wide and a building read
   as noise from any distance. A facade tile is 10 m now — four bays, three
   floors, so a window is about 1.5 m and a storey 3.3 m — and wall UVs are
   snapped to the bay and the storey (`wallUV`) so a corner never cuts a
   window and the floor lines meet the ground and the roof square. The lane
   markings are gone rather than rescaled; they belong on the streets as
   geometry, which is item 3 below now.
2. **Ten facade textures where there were five**, at 1024² with their normal
   and roughness derived at half that. Five styles — precast panel, brick,
   curtain wall, render, stone — two variants each, with sills, lintels,
   spandrel bands, bullet pocks and the odd shell crater with reinforcing bar
   still standing in it. Four rust variants replaced the one that made every
   container the same green box. Each texture is painted on a generator seeded
   from its own cache key, so a variant is reliably unlike its sibling and
   identical between cities, and painting costs the seeded stream nothing.
   `FACADE_VARIANTS` is the knob to turn down if texture memory ever matters:
   about 80 MB across the five styles at two.
3. **Vertex colours carry a per-building tint and baked ambient occlusion**,
   written by `shadeGeometry` during the merge — see the invariant. Both were
   nearly free, because the merge already existed.
4. **Painted metal and dirty glass**, which had no texture at all. The metal
   map is near-white and carries only scratches, rust and grime, so the
   material's colour still says what the thing was painted: one texture covers
   a grey streetlight and a maroon wreck.
5. **`softLayer`**, which is why any of this fits in the boot budget — see the
   invariant. Boot went from 9.2 s to 5.7 s *despite* ten times the texture
   work, because the old sky had been paying the same tax unnoticed.

Measured on seed 1 under software rendering: boot 9.2 s → 5.7 s to a
constructed game, merged draw batches 18 → 26, textures 38 → 65, suite 21/21.
Two checks came with it and both were confirmed to fail when what they guard
is removed: restoring the old ground scale makes `every surface is textured at
the world scale it declares` report the asphalt at 0.15x, and stubbing the
occlusion field makes `the bake darkens the ground the city stands on` report
0.991 against 0.991.

The ground is now two objects rather than one, which is the sharpest case of
an existing invariant: the rendered one is subdivided to ~2.5 m so it can
carry the baked shading, and the one in `world.solids` is the same plane at
two triangles, because three has no BVH and the ground's bounding sphere
covers the sector.

The cities moved one last time with all this, and so did the incidental
numbers below. On seed 1, one perch in six now has an unwalkable stair run,
which the check tolerates at its 0.7 threshold. That is the seed-dependent
failure already recorded further down, not a regression: the diff touches no
`addBox`, `addSolid` or `solids.push` call and no `randRange` in any builder.

The weapon pass after it is the same two ideas applied to the one surface
always within arm's reach. The view models were untextured flat colour on
`BoxGeometry`, which is why they read as boxy: a cube lit by one sun is two
faces and two values with no line between them, and nothing at 0.2 m from the
camera survives having no surface at all. They now carry a stippled polymer
and a parkerised steel, both at their own `TILE` (0.3 m and 0.36 m, against
8 m for the road), with normal and roughness derived off each texture's own
luminance the way every city material already does — so the rubbed-back wear
painted into the steel is the part that catches the sky, and the phosphate
does not. Every part is a chamfered box rather than a box.

Two things went wrong on the way and are worth not repeating. Setting a
material colour *and* a map multiplies them, and the first attempt kept the
old dark colours under the new dark textures, which made the gun a
silhouette; the textures carry the value now and the colours only tint.
And the chamfer's winding was written by hand, which got every facet with an
odd number of negative axes backwards — invisible rather than erroneous, so
it read as notches bitten out of the parts. It is computed per facet now, and
`the gun in your hands is solid and textured at its declared scale` counts
inverted facets across all four models. That check was confirmed to fail with
the hand-written winding restored.

The gun still reads dark in play, and that is the dusk scene rather than the
materials — `viewScene` has its own ambient, key and rim in `main.js`, plus
`environmentIntensity`. If it ever needs to read brighter in hand, those are
the lever. Raising the texture base values instead is the wrong end of it,
and was already tried once: it made the polymer look like clay.

PR #10 merged the pathfinding below: `src/nav.js`, the committed avoidance and
the perch fix.

Hostiles can now find their way round a building, which was item 1 of the old
list and the honest fix under the deadlock backstop. Three parts.

`src/nav.js` is a 1.5 m grid over `world.boxes` and a Dijkstra field from the
player, rebuilt only when they cross a cell — about twice a second at a run,
nothing at all standing still. A hostile that cannot see the player descends
the field instead of steering at them, takes the furthest waypoint it can
reach in a straight line so it walks lines rather than the staircase of a
diagonal, and falls back to the old steering wherever the field declines to
answer. It is a hint, never an authority: the invariant above has the rules,
and they matter more than the algorithm does.

The avoidance fan underneath it used to re-roll which way round an obstacle
every 1.4 s at random, so a hostile walked one way, reversed and walked back —
34 m of path for half a metre of progress, measured on seed 7. It now picks
the side with more room, settles a tie at random so two hostiles meeting one
corner do not file round it, and keeps that side for six seconds or until the
way ahead opens.

And the rooftop half, which is the same deadlock somewhere the grid cannot
help: a perch stands in a blocked cell by construction, so a marksman is never
routed. A blind one is `parked` after 15 s without a sight line, which only
drops its watchdog leash back to the ordinary one — it never walks a marksman
off a roof — and a relocation now prefers a perch with a line to the player,
because moving a blind sniper to another blind roof is a coin flip, and a wave
whose last hostile is one waits out the watchdog once per perch until it gets
lucky. Spawns deliberately do *not* get that preference: spending it there as
well put the damage the sector deals up by about half again.

Three checks came with it, each confirmed to fail against what it guards:
`the route field reaches the whole sector from wherever you stand`, `a hostile
walks around the building between you, not into it` — which disconnects the
watchdog first, because otherwise a hostile that routes nowhere still arrives,
by being teleported there — and `a marksman is moved to a perch that overlooks
you`.

Two things found while checking that the checks were real, both worth keeping.
The perch check first passed on every seed while asserting nothing: whether
any perch overlooks the plaza is a property of the layout, the pinned seed has
none, and the assertion sat behind an `if (withView > 0)`. It reboots onto
seed 99991 now, which has five, and fails outright if a future layout move
takes them away — which is exactly the failure mode the deadlock check's note
warns about, caught in the act. And the route-field check's threshold was set
at 0.95 against a claim that the naive bake left "4% of the sector reachable",
which did not reproduce: the milder way of getting it wrong leaves 97.2%, and
sailed through. The real rule measures 0.999-1.000 across seven seeds, so the
threshold is 0.995 now and the three measurements are written into the check.

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
2. **Positional audio** — sounds are mono, so you cannot hear which side fire
   is coming from. `PannerNode` in the already-centralised audio module.
3. **Let hostiles mantle too.** `World.mantleTarget` is entity-agnostic, but
   only the player calls it, so a car roof is still a place they cannot follow
   you to.
4. **Animate what the kit made possible.** The hostiles now have arms, a
   weapon and a rig as separate parts wearing separate materials, and they
   still walk on a sine wave. A shoulder that swings with the gun, a reload
   that is visible from across the street, a stagger on a hit that is not just
   a colour flash — all of it is reachable from where the parts already are.
5. **More on the ground now that paint is there.** The markings pass put a
   geometry layer on the road and left the pavement alone: manhole covers,
   kerb drops at the crossings, hatched keep-clear boxes and painted parking
   bays all fall out of the same `roadMarkings` machinery and the same street
   grid. Drop them in the same merged mesh and they cost one more batch of
   nothing.

One piece of housekeeping that cannot be done from here: the merged branch
`claude/project-memory` still exists on the remote. Deleting it returns 403
through the agent proxy, and the GitHub tools available here have no
delete-branch call, so it needs a hand on a normal client. Do not spend time
retrying it.
