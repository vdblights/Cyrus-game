# ASHFALL — working notes

A browser FPS: wave survival in a procedurally generated ruined city. No build
step to run it, no asset files, no network calls at runtime. Three.js is
vendored in `vendor/`; everything else is hand-written.

Read `README.md` first for what the game *is*. This file is for changing it.

## Commands

```bash
npm start                      # serve at http://localhost:8000 (no deps needed)
npm test                       # the headless suite (needs npm install first)
npm test -- --shard=2/4        # every fourth check from the second, as CI runs it
npm test -- --only=auto        # just the checks whose name contains "auto"
npm test -- --only="a|b"       # either, in suite order, in one browser
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
- **Do not write the number of checks down either.** It was restated in
  `CLAUDE.md` and `README.md`, and drifted twice: once when one file was
  updated and the other was not, and once when neither was, across two whole
  passes. `npm test` prints `N/N checks passed` on every run, which cannot be
  wrong. Same reasoning as the next item, smaller scale.
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
| `src/world.js` | Box collision (square, turned, a ceiling overhead or a deck over a ceiling), ground height, line of sight, sphere bounce, the grid that indexes them, which stairwell or floor a body is up |
| `src/city.js` | Procedural generation; returns `{ world, fireBarrels, perches }` |
| `src/player.js` | `Input` and `Player`: look, movement, footing, health |
| `src/weapons.js` | Weapon defs, view models, firing, recoil, melee |
| `src/enemies.js` | Archetypes, AI, procedural bodies, laser telegraph |
| `src/objectives.js` | Site placement, channel and stage state machine, marker, waypoint, and the cast an objective puts on the map (a lieutenant, a holdout) |
| `src/story.js` | Operation ASHFALL as data: the briefing, the acts, which objective each wave brings, and every line the handler says |
| `src/armoury.js` | What a run can buy between waves, what each tier does, and the screen it is bought on |
| `src/drops.js` | What a hostile drops: the ammunition can, medical case and grenade, and their halos |
| `src/grenades.js` | Fuse, flight, bounce, detonation |
| `src/effects.js` | Pooled tracers, impacts, blood, casings, explosions |
| `src/textures.js` | Every texture, painted to canvas at boot |
| `src/shapes.js` | Chamfers, lofts, side profiles, lathes, creased normals, merging — the shapes that are not boxes |
| `src/post.js` | Ambient occlusion, bloom, tone mapping, grade, vignette, grain |
| `src/atmosphere.js` | The sky, the sun and the fog — one model, so they agree |
| `src/shadows.js` | The sun's two shadow cascades, snapped to their texels |
| `src/windows.js` | Window openings traced in the facade shader: reveal, glass, room |
| `src/audio.js` | Every sound, synthesised via Web Audio |
| `src/hud.js` | DOM readouts, killfeed, radar, capture banner |
| `src/nav.js` | Walkable grid over `world.boxes`, and a route field to the player |
| `src/rng.js` | Seeded `Math.random` for the page's lifetime, and `reserve`/`spend` |
| `src/loading.js` | The loading screen: stages, progress, field notes, the sector survey |
| `src/perf.js` | The frame-rate readout (`` ` ``), and the name of the GPU the browser draws with |

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
  where claiming slightly too much is the safe direction. Steering is not one
  of those: avoidance probed with `occupied` until settled props put a
  slanted container on the plaza, and a scavenger two metres off it read the
  empty corner of its AABB as the way being blocked and dithered in place
  (`a hostile follows you onto a car roof`, 7 of 8). It asks `blocked`,
  which tests the footprint. `resolve`,
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
  constant is the construction seams between abutting boxes, joints of
  0.05-0.15 m, which it has to span or you fall down them. `mantleTarget` asks
  the same way for the deck it promises, or a climb finishes onto ground the
  footing check will not then find and drops you straight off it. The other
  side of it: anything the generator left a real gap in, the old radius had
  been quietly bridging, and this made it a hole — see the next invariant.
- **A perch is furnished with colliders, and its stairs end at its deck.**
  Two bugs from play, reported as climbing a staircase and then falling
  through the box beside it, and both were true. A terrace's crate was drawn
  and registered nowhere — not in `world.boxes`, not in `world.solids` — so
  you walked into it and fell through it from a jump, and its knee-high lip
  was a solid with no collider, so it stopped bullets and not boots. And
  every stair run was laid *from its foot* by a run length worked out apart
  from its step count, so it stopped up to 0.85 m short of a terrace and
  1.6 m short of a container stack, and the top tread was 0.14-0.23 m off
  the deck height by up to 0.23 m besides. Under the old body-radius footing a gap under
  0.84 m was bridged invisibly, so the terraces only broke when footing was
  fixed; the container stacks had always been a jump. `stairs()` now takes
  the deck edge and the climbing direction and derives both ends from them,
  and the rise is `height / count`, so the last tread is flush and level with
  the deck. The lip across the head of the stairs is built either side of
  the opening — registering a full one would put a step taller than
  `STEP_HEIGHT` between the top tread and the deck — paid for with the same
  `spend` the one lip cost. The crate is kept a body's width off the perch
  point, because that is where a marksman is put down, and the top container
  of a stack is no longer slid off its collider; both still draw the rolls
  they used to, so the stream is unchanged. Measured on seeds 1, 7, 99991,
  20260101 and 20260813: every perch, every barrel, and every collider more
  than 14 m from a perch is identical before and after. What is *near* a
  deck is the third half: wall decoration is laid before any perch exists,
  and a fire escape's lowest platform hung 1.15 m above a terrace and
  1.4 m off it on seed 1 — a jump you landed and fell through, because
  decoration is in neither collision list. `clearEscapesNear` takes down,
  whole, any fire escape with a part within a running jump (3 m,
  `JUMP_CARRY`) and a mantle (2.6 m, `JUMP_REACH`) of a deck, after the
  perches are placed; each piece carries `userData.escape` so it goes as
  one. It is decoration, so removing it costs the stream nothing and the
  layout check does not move. `what stands on a perch holds you up` reads
  that ring too, counting faces big enough to land a foot on (0.25 m²,
  because a streetlight's head is within reach of a deck on seed 99991);
  with the clearing taken out it reports the platform.
- **A floor is a collider, and it is registered last.** Every slab drawn as
  something to stand on — the 28 cm pavement apron on every lot, the plaza,
  a rubble lot's slab (0.35 m), a ruin's courtyard (0.45 m) — goes through
  `registerFloors` in `city.js`, which puts it in `world.boxes` via
  `addFloor` and a plain box copy of it in `world.solids`. They were drawn
  and registered nowhere: a lot is 28 m of apron in a 34 m block, so for
  most of the sector the player walked 28 cm inside the kerb, hostiles stood
  with their boots in it, and a shot at the pavement landed on the street
  plane underneath. Three things keep it cheap. Every floor is under
  `STEP_HEIGHT`, so `resolve` walks over it and footing lifts you onto it.
  Every reader that asks about *obstacles* — `occupied`, `areaClear`, the
  occlusion field, the nav bake — already skips anything that low, so a
  floor is invisible to placement. And registering them after everything
  else is placed makes that a guarantee rather than an argument: the old
  fingerprint, taken over every box but the floors, reproduces exactly on
  all three pinned seeds. The `floor` flag on those boxes is for a reader
  that must tell ground from what stands on it, because a kerb and the first
  tread of a stair are otherwise the same low step — the stairs check found
  a perch's pavement before its stairs and walked into its deck. What still
  assumes y=0 is wrong now: an effect that lands, a pickup, an objective
  ring and a test that says "on the street" all ask the floor instead.
- **A floor may slope, and then its box answers for its own height.** Where
  a zebra meets the pavement the kerb is dropped: a ramp from the apron's
  corner to 2.5 m along the kerb, down to a 3 cm lip across 1.4 m of the
  pavement, with a 1 m flare past it where the kerb climbs back along its
  length, and a dish where both streets at a corner are crossed (`DROP`,
  `apronDrops`, `apronSurface` in `city.js`). A ramp is not a box, and
  stepping it — a stack of thin floors — would have been a few hundred boxes
  more in every `groundHeight` loop. So an apron with a drop is still one
  floor box, carrying `surface(lx, lz, r)`: its height at a point in its own
  frame, the highest within `r`. `top` stays the slab's highest, so every
  reader that only wants a bound (`resolve`, `lineOfSight`, `occupied`, the
  nav bake) is unchanged and still right; `groundHeight` and `bounceSphere`
  ask the surface. Two things keep the three copies of it — what is drawn,
  what holds you up, what a bullet stops at — one surface rather than three
  that agree. Every piece of it is a plane, and every crease between two
  planes runs corner to corner across a cell of the grid `DROP_BREAKS` lays
  (the flare's cell, and the corner square's when both streets are
  crossed), so `drape` reproduces it exactly by choosing whichever diagonal
  agrees with the surface at the cell's middle. And the drawn apron, its
  raycast copy (the same grid without the bake's cells) and the paving on it
  are all built off that one function. The paving cannot be level on a ramp,
  so it is draped over the same grid plus its own edges, on both axes, which
  keeps the corner's crease on a cell diagonal; where both streets are
  crossed it turns the corner as an L rather than two pads overlapping, which
  is what two flat pads did before and z-fought. The apron is built inside
  `reserve` and pays `spend(UUID_COST)` for the box it used to be, so a drop
  costs the stream nothing; what moves is the props, because `settle` asks
  `floorAt` for one level under every corner and a ramp is not one. `a
  crossing drops its kerb, and the ramp you see is the ramp you walk` reads
  every sloped face of pavement in the merged city against the footing
  (304 faces on seed 1, all within 0.3 mm), walks up a drop (0.041 m in the
  worst frame, against the 0.278 m a kerb takes at once) and shoots the
  ramp. Broken at the reader, it reports a face at 0.113 m held at 0.28
  with `groundHeight` reading the slab flat, and a shot stopping at 0.28
  over a ramp at 0.155 with the raycast copy left a box. Its kerb scan
  first stepped `t += 0.1` along each edge, which lands a hair under the
  far corner and never closed the run that ends there — 32 drops counted of
  64. Step a scan by count.
- **A box may stand off the ground, and then it is a ceiling.** About one
  tower in three (`opensAt`, by position) has a ground floor you walk into
  (`groundFloor` in `city.js`): a shopfront of piers with doorways, windows
  over a sill and shutters on the street faces, blank walls onto the
  building next door, a slab ceiling, and inside columns, aisles of
  shelving, a counter and crates. Every box used to run from the street to
  its top, so the floors over the room are a box with a `base`
  (`addCeiling`, at `GROUND - SLAB`, 3.03 m) and every reader had to learn
  it. `resolve` walks a body under one when the base clears its `height`;
  `groundHeight` never stands anything on one, so nothing is lifted onto a
  roof it walked under and a mantle is not refused for a "wall" that is the
  floor above; `ceilingAbove` stops a jump (the player's crown, 1.85 m over
  the feet) and refuses a mantle onto a counter with no headroom
  (`HEADROOM`); `lineOfSight` runs its Y slab from `base`; `bounceSphere`
  has a fourth escape, down off the underside; `blocked` and the nav bake
  let a body through under it. `occupied` deliberately does not: everything
  that places a thing — a spawn, an objective, a weed — still treats a room
  as taken. Five things are load-bearing. **A doorway is 4 m and more**,
  because the route field keeps a shoulder clear of every wall, and the
  first counter stood behind a doorway and sealed seven rooms from the
  street (a 10 m shop with a partition had both bands of clearance meeting
  across it, so the partition went); the counter now stands at the end of
  the shopfront away from its doorways, crates only against blank walls,
  and the aisles off the column lines, which had closed the aisle between
  them into a pocket. **The open building still costs the stream what the
  closed one did**: the block, the glass band and the shutter are minted
  and their rolls drawn as before, the block's shape is swapped inside a
  reserve, and the room is built inside one — so the mark after boot is
  identical, and compared collider by collider on seeds 1, 7 and 20260101
  the only colliders gone are the 21, 16 and 25 blocks that opened and every
  new one lies inside one of their footprints. **The bake darkens what is
  under a ceiling** (`indoorField`) by how far it is from the building's
  faces, or a room is as bright as the pavement: under half the light at
  the back of a wide floor, most of it by the shopfront, and nothing on the
  faces themselves. **Hostiles collide at their archetype's height**, not an
  elite's, so a warlord can follow you in; an elite juggernaut's head goes
  through the slab, which is the price. And **the boxes are indexed once
  the city is built** (`World.seal`): 500 more colliders on seed 1 doubled
  the game step in a fight (0.45 → 0.85 ms median), and walking only the
  cells a query touches brings it to 0.2. The index hands boxes back in list
  order and is only trusted while the list is the length it was sealed at,
  so generation never sees it and a 25-second fight ends in exactly the
  same state either way. `world.rooms` lists each room and its doorways for
  anything that wants to find one. `a building opens onto the street: you
  walk in under its floors, and it hides you from above` walks into every
  room through a doorway, reads the route field over every open cell of its
  floor, jumps, sights it from over the roof and through the door, and
  throws a grenade at the ceiling; it fails with each of the five readers
  put back the way it was (21 of 21 rooms not entered; every room's floor
  blocked to the route field; a crown through the ceiling; 21 doorways
  blind; a grenade shoved out of the building).
- **A warlord stoops under a ceiling, asked across its whole body.**
  Hostiles collide at their archetype's height so an elite can follow you
  into a shop, but one is drawn 3.6 m tall under 2.75 m of headroom, and its
  head and shoulders came up through the floor above in all 21 rooms on
  seed 1. `_headroom` in `enemies.js` reads `ceilingAbove` every step and
  lowers the hips by as much as the crown needs (`STOOP`, at most half the
  body's height). The pose bends each thigh forward by `a` and its shin
  back by `2a`, which keeps the foot under the hip, and leans the upper
  body in. The eyes come down with it, so it sees what its body can. Two
  things are load-bearing. **Headroom is asked across the whole body's
  radius**, not a fraction of it: at 0.6 of it a warlord in a doorway,
  0.76 m out from the front wall, had its leaning head under the slab's
  edge and its query outside it. A look-ahead along its velocity was
  written for the same reason and taken out, because the full-width query
  already sees a slab 0.9 m before the feet reach it and the check passed
  without it. **A death starts from the stoop**, or a warlord killed
  stooped jumped up to full height to fall. `a warlord stoops under a shop
  ceiling, and stands tall in the street` stands one in every room, walks
  one in at a doorway and stands one in the street: 0.84 m through the
  ceiling in 21 of 21 rooms with the stoop off, 0.32 m in 2 with the query
  narrowed, and 3.57 m tall outside either way.
  **The stoop takes a juggernaut up a stairwell.** A flight's headroom is
  2.41-2.5 m and a juggernaut is 2.57 m of body, so none was ever sent up;
  the stair walk now asks whether it fits *stooped* (`fitsStair`: the crown
  at full stoop, 1.46 of its units, under `stair.clear`), and on a stair it
  collides at that height (`bodyHeight`), or a flight overhead is a wall
  and the shaft's door a lintel. Every elite fits but a warlord (2.86 m
  stooped). A lane is 1.25 m and an elite raider 1.31 m across, and a test
  of the width was written and taken out, because one walked four
  stairwells without it. **Headroom is asked from the hips**
  (`STOOP.hip`), not the feet: on a flight the tread two steps up has its
  underside 5 cm over the feet, so asked from the feet every hostile
  stooped all the way up every stair, which nothing caught for a whole
  pass because a scavenger stooping is only a pose. `a juggernaut stoops up
  a stairwell after you, and a warlord stays down` follows the player up
  all 13 of seed 1's stairwells with one (up in 17-26 s, down in 13-18 s,
  no relocations) and reads every point of its body against the flight
  over it: 0 of 13 up with the old gate or the old collision height, 0.265
  m through a flight with the stoop off, and a scavenger stooped 0.27 with
  the query back at the feet. A ranged hostile walking after a player on a
  roof may be handed a post at the stair door (see the buildings invariant),
  which is the posts working, so the check keeps it off them (`postAfter =
  Infinity`).
- **A room is furnished to three pieces, or as near as it fits.** A 10 m
  shop with a stairwell was an empty concrete box: the shaft and the floor
  in front of it (`shaft.blocks`) took the blank walls that shelving and
  crates go on. `furnishBare` in `city.js` runs after the rest of a room's
  furnishing and, while it holds fewer than three pieces of furniture,
  adds a table, a crate stack, a shelf unit and a lone crate against free
  blank walls. Columns are structure, not furniture, and do not count, or a
  big room with four columns and nothing else counted as furnished. Four
  things keep it honest. **Each piece stays clear of what moves through the
  room**: the stairwell's landing, a doorway's half-width and 1.2 m from
  every doorway (1.6 left the tightest rooms bare), and a metre from every
  other piece, so the route field still reaches every open cell. **Nothing
  goes under a window.** A shop window's sill is a 1.23 m ledge, and with a
  table or a crate stack just inside it, `a pull-up carries the view`
  climbed through a window, landed on the sill and settled onto the
  furniture, a second rise inside one climb that lurched the view 2.3-2.4
  cm in a frame against a 2 cm bar. Stacking crates against a window read
  as a barricade, and it was tried, but the climb is what it buys. **A
  table's top and legs are its solids and a box the size of it is its
  collider**, so a body meets the table and a round goes under it between
  the legs. The shelf unit is the same, boards, sides and a back panel. A
  hidden mesh as the solid would stop a round in the air between the
  boards, and the bake skips hidden meshes, so it would not even be drawn
  to explain it. **Every collider a piece registers carries its number
  in the room** (`b.piece`), so a check counts a crate stack as one piece
  and two shelves meeting in a corner as two; clustering touching boxes
  got both wrong. It is built inside the tower's reserve on hash salts
  nothing else uses, so it costs the stream nothing; the layout check was
  re-measured once for it, collider by collider. On seed 1, 13 of 21 rooms
  hold three or more and every room at least two; the rest are 10 m stair
  shops whose shaft and doorways leave one blank wall. `no shop is left
  bare` asks for two in every room: 7 rooms short with the furnisher off
  (the fewest 0) and 3 with columns counted as furniture. What it cost,
  measured with pieces on the windows too (165 solids, against 78 now):
  a pellet's raycast and the game step in a fight both within noise
  (0.56-0.63 ms against 0.58-0.83 a pellet, 0.4-0.5 ms against 0.4 a
  step, twice each). Furniture changes what the box list holds, and two
  checks that sample it moved: `a hostile follows you onto a car roof`
  sampled tables, where a scavenger rightly hooks you from the floor
  rather than climbing, so it samples decks under the open sky now; and
  the pull-up check found the window climb above.
- **A box off the ground may be a deck: a ceiling to everything but the
  feet over it.** Thirteen of seed 1's 21 open ground floors — every one
  under a roof no higher than 14 m (`STAIR.top`) with a corner whose walls
  have no doorway behind it — have a stairwell (`stairwell` in `city.js`):
  switchback flights of ten in two lanes either side of a spine, a landing
  across both lanes at each end, an even number of flights so the last one
  walks straight out of a bulkhead onto the roof, and the roof made a deck
  with a parapet on the cap's overhang. A flight over a flight is a box
  with a `base` that is also a floor, and so is the roof over a shop, so
  `addDeck` flags it and `groundHeight` stands a body on a deck only when
  the body is at or above its underside (`under`, which defaults to the
  asking ceiling). Four things are load-bearing. **`under` is not
  `ceiling`** for the one reader that asks with `Infinity`: `mantleTarget`'s
  wall test passes `feet + maxRise + 0.5`, or the roof over a shop is a
  wall in front of every crate in it (0 of 6 shops' crates climbable with
  it left at `Infinity`). **The parapet is waist-high onto a street and
  2.2 m — over a jump's reach — where another building of the lot stands a
  metre off** (`party` in `buildTower`): the roof next door is one jump
  away, its colliders are its block's top 0.8 m under the cap you see, and
  its roof furniture is decoration you walk through. **Everything on a
  stair roof that was decoration goes** — `roofFurniture` and `fireEscape`
  are skipped on it, the plant boxes are decks — and the block loses its
  top and bottom faces and the cap and slab are rebuilt round the hole,
  because none of them had an inside. **Hostiles walk the stair's own
  points** (`stair.path`, `Enemy._stairWalk`): the route field is one grid
  at street level, so while the player is up a stair (`World.stairAt`) it
  is built from the stair's foot, a hostile walks there, and from there
  follows the points one at a time — no avoidance, no climbing and no edge
  guard inside the shaft — turning round mid-flight when the player does
  and forgetting the stair at its foot. Each point reached resets the
  watchdog, because laps of a 3 x 6 m shaft look exactly like a hostile
  going nowhere. A ranged hostile with a clear shot at the roof from the
  street takes it rather than climbing, and one on the roof with a shot down
  holds it. A body that does not fit stooped under a flight (`stair.clear`,
  the lap less the slab, at most the 2.5 m doors) is never sent up, which
  is a warlord; see the stoop invariant for the juggernaut. The layout outside those buildings is untouched,
  proved collider by collider (see the layout check), after one fix:
  `areaClear` read the parapet's 30 cm overhang as an obstacle in the
  street and moved seed 20260101's perches, so it ignores boxes standing
  off the ground above 6 m. `a stairwell climbs to a roof you can stand on,
  and a hostile follows you up it` walks every stairwell on the seed, walks
  and jumps at every roof edge, shoots the roof and follows a scavenger up
  and back down; it fails with the deck rule taken out (13 of 13 stuck at
  the first slab), with `under` at `Infinity`, with the parapet gone (31 of
  40 edges walked off), with the cap not a raycast target, with the stair
  walk off (no scavenger up), and with the landing fix below reverted. A
  party wall cut to parapet height fails it only by there being no party
  walls to find, which is weak: the check knows one by its height.
- **A building with a stairwell is floors, one a lap, and the windows are
  real.** Every lap of a stairwell lands at a floor of its building
  (`upperFloors` in `city.js`) between the shop and the roof: on seed 1, 32
  floors in 13 buildings, 2.41-3.47 m of headroom. A floor is a deck slab
  round the shaft (the first one the shop's ceiling too), a dark finish
  over it, a ceiling that is the next floor's slab or the roof's, and walls
  of piers on the bay lines with a sill and a lintel between each pair —
  442 openings on seed 1, every one open to sight and to a round both ways,
  because a building you can stand in has to have holes you can see out
  of. The facade block goes: a facade texture's painted windows and the
  shader's invented rooms cannot line up with real openings, so these
  buildings are a concrete frame instead, which also says from the street
  that you can go in. A face onto the building next door is blind, and so is
  the stretch of wall the shaft stands against. Six things are
  load-bearing. **Every piece of wall is a ceiling box, never a deck**:
  nobody stands on a sill and nobody climbs out of a window. **A first
  landing at or under the shop's ceiling opens on nothing**
  (`F < under + 0.15`): one building on seed 1 put its first landing at
  2.99 m, under a 3.03 m ceiling, and the slab came out upside down with 4
  cm of headroom; the slab runs on to the next floor instead. **The
  shaft's lining has a door off every floor's landing** at lane A, and the
  lining under each door is a deck, its threshold. **The cap is a band and
  a roof slab** (`ROOF`, 0.3 m), not the 0.8 m slab it was, or the top floor
  had as little as 2.1 m. **Decoration that would cross a window is built
  and dropped** (`SINK`): the pilasters, the band and the downpipe still
  mint their objects, so every later decoration draws what it did. And
  **every reader that asks "on which floor" asks `World.stairAt`**, which
  answers a floor between the shaft check and the shop: the player's floor
  for the hostiles, a drop's floor for `maybeDrop` (a drop on a floor
  lands there and is only taken by someone on it, within 2 m of height —
  it used to be the street's), and the indoor bake and the litter read
  `world.floors` as they read `world.rooms`. **Hostiles follow onto a
  floor as a branch off the stair walk** (`_stairWalk`, `onFloor`,
  `floorStep`): at the landing a floor's door is off, out through the door
  ('out'), across the floor after the player with the avoidance on ('on'),
  and when the player leaves it, back to the door ('back') and onto the
  landing ('in'). The route field is a map of the street, so across a floor
  a hostile goes round the shaft by its corners when a straight walk
  crosses it (`_floorWay`), and out on the floor its avoidance treats the
  shaft as blocked though its door is open — or it took the doorway as the
  way round, walked back into the shaft and stood there. Two more were
  written and taken out because nothing needed them once those two were
  in: a recovery that walked a hostile found in the shaft back to its
  landing, and a fallback for when no corner helped. Each of the two kept
  bites: without the route, a juggernaut walking back off a floor from
  behind the shaft is stuck and relocated on 1 of 32 floors; without the
  shaft in the avoidance, a raider is. Probed over all 32 floors, a
  scavenger, a raider and a juggernaut each reached every one and came
  back down, unrelocated. `a building with a stairwell has floors` climbs
  every stair, walks onto every floor, looks and shoots out of every
  window and into every pier beside one, follows onto floors with three
  archetypes, walks a juggernaut back off every floor from behind its
  shaft, and drops a pickup on a floor; it fails with `stairAt` blind to
  floors and with no door in the lining (32 of 32 floors not walked onto),
  with every window blind, with the walls out of the raycast list (442 of
  442 piers let a round through), with the route or the avoidance rule
  taken out, with drops landing on the street (3.54 m off) and with
  pickups taken from below. It first started the juggernaut beside the
  player, where the way to the door was clear, and passed with the route
  taken out; it starts behind the shaft now, which is where one that has
  held its range ends up. What it cost, twelve hostiles on seed 1 under
  software rendering against `main`: high 2,130-2,160 → 2,180-2,290 ms a
  frame, triangles 859k → 1,009k, calls 467 → 459; low within noise; the
  game step in a fight unchanged (0.1 ms median) for twice the boxes
  (2,497 → 4,915). Two checks moved because a facade worn only by these
  buildings is now worn by nothing on seed 1: the bake records what it was
  handed (`bakedFrom`), and the material and window checks ask about what
  is worn.
- **A hostile uses a building by reading it, not by being scripted into
  it.** Three behaviours, all keyed off where the player is: `Game.roomAt`
  (the room under the player, or the room of the stair they are up — the
  stair carries a non-enumerable back-link, `stair.room`, because a cycle
  breaks anything that copies the world out to a check). **Posts**:
  `Game.coverPost` hands a ranged hostile a place 8 or 11 m out from a
  doorway with a standing sight line into it (`_postsFor`, cached on the
  room), at most two a building, never to one already inside or within
  10 m of the player, and only one it can walk to in a straight line —
  the first version handed a post across the block to a raider that routed
  to it by the field, which leads to the player, and walked in at the
  door. **Frags**: `Enemy._planThrow` flies the grenade from the hand
  through the real `bounceSphere` and drag for its whole fuse, at six
  angles toward the player and toward the inside of each doorway, and
  keeps the throw that comes to rest nearest them with a line from the
  blast — so a frag is only thrown when it will land in the room. The flat
  angles and 21 m/s are what get one under a lintel: a lob meets the wall
  over the doorway, and at the first 16 m/s cap a frag carried 13.5 m at
  best and two shops in four got none. One hostile frag in the air at a
  time (`GrenadeSystem.hostileLive`) and seven seconds between them; it
  carries `owner`, and `explode` hurts no hostile with a hostile's frag and
  credits no kill, which a frag through `registerHit` would. **The push**:
  `Game.playerExposed` is a reload or a weapon change; every hostile in 25 m
  drops its post for eight seconds and comes, 30% faster, until 1.2 s after
  it ends. None of it draws on `Math.random` — the grenade's spin is fixed —
  but it moves when hostiles fire and so every later runtime draw, which is
  the ninth testing trap's noise. `hostiles use the buildings` stages each
  of four shops from its door with the most posts (a shop on the sector's
  edge has doors onto the perimeter strip), from start points on a ring of
  open street round it — straight out from a door is the building across
  the road — and fails with the planner off (0 of 4 frags), with the
  doorways not aimed at (1 of 4), with posts off, with three posts allowed,
  with the push off, and with hostile frags hurting hostiles.
  **Up a stairwell the posts are the stair's** (`_stairPostsFor`): on the
  shop floor, 2.5-7 m in front of the stair's door, with a sight line into
  it, two a building as ever, and the third hostile climbs. It used to hand
  out the street doors' posts, which watch nothing a player on a roof can
  come out of, and to aim frags in at those doors too; neither happens
  while the player is up. Four things make it work. In a 10 m shop the
  stair door opens toward a wall under 3 m off, so the first search
  straight out from it found no post in 5 of 13 shops; the search is a ring
  in front of the door. A stair post is reached by the route field,
  because up a stair it leads to the stair's foot, which is beside the post
  — walked straight at, both stuck outside the shop. A hostile on any post
  faces the door it covers (`wx`, `wz`) while it cannot see the player, or
  it stands looking at a roof. And on its post the watchdog leaves it alone,
  like a lieutenant leaving: with the player out of sight it reads as
  wedged, and was moved 19 m off its post. A stair post is kept when the
  player comes back down into the shop, which is the ambush the post is
  for; a street-door post is not kept while the player is up. `on a roof,
  two hostiles cover the stair door and are waiting when you come down`
  fails with each of those five put back. Its player stands at the far end
  of the roof: at the bulkhead door the player sees down the shaft into the
  shop, and the watchdog never moves a hostile the player can see, so the
  watchdog break first *passed*. **A frag does not reach a roof over about
  10 m, and that is the arm, not the planner.** A frag falls at 19 m/s² and
  a hostile throws at 21 m/s at most; reaching a 12 m deck from the street
  takes 22-23. Measured from a ring of street spots 8-22 m out, every
  roof on seed 1 at 10 m or under had a throw that lands (38 of 249 tries
  at 8.4 m), and every roof over 11 m had at most two. Steeper angles and
  aiming past the player across the deck were both tried, and neither found
  more: the steep throws meet the wall still climbing, and a frag that lands
  past you rolls on away from you. Four storeys is out of a hand's reach.
- **The armoury reads in one place, and is paid in scrip.** `EFFECT` in
  `armoury.js` is what each tier does, and the systems read it where they
  do the thing — `Weapons.magSize` and the aimed spread in `fire`, damage in
  `Game.hitscan`, damage taken in `Game.damagePlayer`, the sight picture in
  `frame` — so a tier is one number in one place and a check measures the
  thing, not the kit. Scrip is topped up from the score in `step` and
  spending it never touches the score: spending score would have made every
  purchase a cut to the best-score line. It opens only between waves with
  the sector clear (`armouryOpen`), and the state it opens into is its own
  (`'armoury'`), which stops the clock and lets the mouse go without the
  pause that losing it otherwise triggers. Nothing in it draws on
  `Math.random` or mints a three object. `the armoury opens between waves`
  buys the first tier of four items and measures each where the game does
  it: a hit 40 → 34, a sidearm reloading to 19 rather than 15, aimed spread
  at 0.70x and damage at 1.12x; it fails with each of those readers left as
  it was, with a purchase that also costs score, with the screen opening
  mid-wave, and with the clock left running.
- **Paused is paused.** `frame` advanced game time in every state, so the
  clock ran on behind the pause screen and anything on a deadline — an
  objective, the intermission before the next wave — ran out while nobody
  was playing. It stops while paused or in the armoury now. Measured by the
  armoury check: 0.12 s over five frames, against 0.
- **A band round a building is a ring, not a slab.** The ledge at the
  foot of every tower (`skirt`, 2.8-3.2 m) and the string course under its
  cap were boxes the size of the footprint: inside a closed block nobody
  saw them, but across an open ground floor the skirt was the ceiling you
  saw, 25 cm under the slab you hit, and up a stairwell both were floors
  with nothing under them, which you walked through — reported from play
  as the building's floor cutting into the stairwell. `ringGeo` in
  `city.js` draws the four sides only; the skirt is swapped to one inside a
  reserve where the ground floor is open, so it costs the stream what it
  did, and the band is decoration either way. The stairwell check samples a
  grid across every shaft for flat faces that are neither on a collider nor
  inside one — sampled, not read off triangle centres, because a slab's
  triangles have their corners and their middles out at the building's
  corners, and the first audit, reading centres, found nothing. With either
  band put back as a slab, every stairwell on seed 1 reports it. A ring is
  as deep as what shows of it and 2-3 cm into the wall, no deeper. The
  first cut was 55 cm, the rim and most of the wall under it, and `what
  stands on a perch holds you up` read four of those strips beside seed 1's
  terraces as 55 cm shelves with nothing under their outer edge. The rim had
  always been there and always been unsupported, but as one slab its
  triangles' centres were inside the block, so the check never sampled it.
  At 27 cm the strip is narrower than a foot, which the check already
  skips, and the rim you see is the same.
- **Sprint stops when you run dry and stays stopped until a third is
  back** (`WIND_BACK`, `player.winded`). It used to cut out at an empty
  bar and come back a frame later with the key held, every frame: the gun
  swapped between its sprint and run poses sixty times a second, reported
  from play as the gun shaking in your hands after a jump or a kerb — which
  was only how long it took to run the bar down. `sprinting until you are
  winded does not shake the gun`: 285 flips in ten seconds with the old
  rule, 6 now.
- **A fall lands on whatever it crossed in the frame.** Airborne footing
  asked `groundHeight` with a ceiling 2 cm over where the fall *ended*, so a
  landing that crossed a surface by more than that in one step went
  through it. On the street that was a frame's dip under the kerb before
  the step-up caught it, and nobody saw it; on a roof it was a fall through
  the deck, out of the side of the building and into the street — 12 of 40
  jumps at a roof edge. The ceiling is the higher of the feet before and
  after the step now (`Player.update`).
- **Anything you can see at body height is something you can bump into.**
  Every heap of rubble (`rubblePile`) and every fallen slab in a rubble lot
  was drawn and registered nowhere — the slabs were in the raycast list and
  not the box list, the heaps in neither — so on seed 1 about 660 m² of the
  city stood between 0.3 and 2 m off the street with nothing under it:
  reported from play as rubble you clip right through. `registerHeaps` in
  `city.js` gives each one a stack of colliders cut to its own shape: tiers
  a third of a metre deep, each the tightest of sixteen turned rectangles
  round the heap's cross-section at that height, shrunk to the section's
  own area. The section is the hull of two cuts, at the tier's middle and
  just under its top: a mound narrows as it rises, so the upper cut adds
  nothing to it, and a fallen slab leans, so its upper cut is where the
  overhang is. A box the size of the heap would have been a pillar you stood
  on in mid-air over its slopes; tiers under `STEP_HEIGHT` make it a mound
  you scramble up. Heaps are registered after the floors, appended to
  everything else, and flagged `heap`, so the layout check still measures
  the old fingerprint over every other box — 476 boxes more on seed 1, and
  the game step did not move (0.2 ms median either way). `rubble stops you
  and stops a bullet, and you can climb it` audits the whole merged city
  for facets at body height further than a body's width from any collider
  as tall as they are, weeds excepted: 667 m² with `registerHeaps` taken
  out, 9.5 now, which is the low rim of the heaps at ankle height. Any new
  prop that stands off the ground has to pass that audit or be decoration
  by the rules above.
- **A prop stands clear, level and on its floor, or it is not put down.**
  Containers, wrecks, barriers, drums and lamps went down exactly where
  their rolls put them, at street level, with nothing asked of the spot: a
  container stood through the plaza's fountain on all three pinned seeds,
  props stood in one another, and every prop rolled past the last lot was
  half inside the perimeter wall — the kerb there is a metre from it, so
  the street those rolls were aiming at does not exist. Anything that
  landed on a pavement or a slab was sunk into it. `settle` in `city.js`
  builds a prop where it was rolled, reads back the colliders it registered
  as its footprint, and moves the whole thing to the nearest half-metre
  offset (out to a `reach` per kind) that is inside the sector, 20 cm clear
  of every collider standing, and on one floor level — every corner 5 cm
  past its edge, so nothing teeters on a kerb — then lifts it onto that
  floor. A barricade passes `parts`, so each slab finds its own level
  and a row can step off a kerb. If nowhere fits, everything the builder
  added is taken back out — after its rolls and its `spend` were paid, so
  the stream never sees the difference and every later roll gets the value
  it always did. On seed 1 that drops 18 props, and all but one were
  rolled into the perimeter wall. What it does change is the layout: props
  move, and perches are placed round them, so the layout check was
  re-measured once for it: compared collider by collider, every building
  and every floor is identical on all three pinned seeds. The perches
  moving exposed a hole that had always been there: a perch is placed
  before the rubble is registered, so `areaClear` cannot see it, and seed
  1's new layout put a container stack in a rubble lot with a fallen slab
  across its stairs (`stairs carry the player onto a perch`, 12 of 13).
  Rejecting perch sites near rubble cost seed 1 five of its thirteen
  perches, because there is a heap in every street; instead the rubble on
  a perch's deck and stair run is cleared before `registerHeaps`, which
  costs the stream nothing because the heaps were already built. The fountain went with it: it was an open tube
  with a solid 6.8 m square deck for a collider, so you stood on air over
  the basin and past the rim at every corner, and walked through the
  plinth from the deck. It is a lathed basin now, the rim sixteen staves
  round the circle, the plinth a collider. Note that `latheGeo` turns
  about Z; a lathe that should stand up needs `rotateX(-π/2)`, and the
  first render of the basin lay on its side. `every prop stands clear of
  the rest, inside the sector, and on its floor` reads all of it,
  including what is drawn: the lowest point of each prop's own meshes over
  its floor has to be the same for every copy of a shape. The route field skips heap boxes the way it skips a
  kerb: every tier rises less than a step, so a hostile climbs a heap
  rather than walking round it, and baking them as walls cut 1.9% of seed
  1's walkable sector off into pockets — `the route field reaches the whole
  sector` caught it at 98.1% connected. **That premise is only half true.**
  Each tier rises less than a step, but a body is stopped at its radius
  (0.43 m) by anything a step above its feet and lifted only by what is
  under its middle (0.12 m), so the tier under has to stand 0.31 m proud of
  the one above or the pair is one tall step. Measured on seed 1 over 358
  heap tiers, from the outline grown by that margin: a median effective rise
  of 0.62 m, 228 tiers over a step, 96 over 0.9 m — a fallen slab's tiers
  nest within centimetres. So the field routes bodies into heaps they cannot
  climb; a hostile is turned by its avoidance or moved by the watchdog, and
  a holdout, which has neither, stood against one until the clock ran out.
  Baking the steep tiers as walls is the obvious fix and was not taken here:
  it is most of the heaps, which is the 1.9% of pockets again.
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
  platform is at 4.6 m (its drop ladder's foot at 3.4, over a head on a car
  roof) and why there are no bollards. The road markings are
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
- **Nothing three builds lazily may be built for the first time in the
  middle of the city.** `reserve` makes an object free by rewinding the
  stream after it, but some objects build *shared* parts on first use: the
  first `Sprite` ever constructed builds the quad every Sprite shares, and
  pays for that geometry's UUIDs out of the seeded stream. For years that was
  the sun's glow, inside the sky's `reserve`. The lighting pass drew the sun
  in the sky shader instead, so the first Sprite became a fire barrel's flame
  halfway through laying out the street junk, and seed 1 laid out 308 boxes
  instead of 332. Nothing about generation had changed. It was found by
  logging `Math.random.mark()` around each step of `buildCity` on both sides
  of the change and walking forward to the first call that disagreed — which
  is the method worth reusing, because it ends the search in minutes. The
  first stage of boot builds a throwaway `Sprite` inside that same `reserve`. If
  a later change removes the last Sprite built before the city, or adds a
  first instance of some other lazily-shared three type inside it, the same
  thing happens again, and `a seed still lays out the city it did` is what
  will notice.
- **The post chain is constructed before the city and outside any
  `reserve`.** So `new Post()` must keep minting exactly the three materials
  it always has; one more there moves every seed. Everything added since —
  the occlusion materials, the depth texture, every render target — is built
  on first use inside `reserve`, and `_allocate` is wrapped in one, which also
  stops a resize or a tier change in the middle of a run from shifting the
  stream that is deciding spawn points.
- **Ambient occlusion reads the world's depth and is multiplied into the
  world before the gun is drawn.** Three things about it are load-bearing.
  It runs at half resolution, and a half-res pixel centre lands *exactly* on
  the edge between two full-res depth texels, so a nearest lookup at `vUv`
  picks one side by float rounding; where the centre and a neighbour picked
  the same texel the reconstructed normal collapsed, and flat ground came out
  ruled with evenly spaced dark lines. The pass addresses full-res texel
  centres explicitly. It is only offered on a multisampled target, because
  then the depth texture is a resolve copy rather than the attachment being
  drawn into — without MSAA it would be a feedback loop. And taps that fall
  off the edge of the frame are skipped, not clamped (a clamped tap reads a
  surface that is not there and darkens a band round the border), with a
  5 cm bias so the road paint, 2 cm proud and pulled forward again by its
  polygon offset, does not draw a halo. The view model is excluded by order
  rather than by mask: occlusion is applied, then depth is cleared, then the
  gun is drawn.
- **The sky, the sun, the environment and the fog are one function.**
  `ashAtmosphere(direction)` in `atmosphere.js` draws the dome, is rendered
  into the PMREM that lights every PBR surface, and colours the fog — which
  replaces three's fog chunks for every built-in material, thickening toward
  the ground and taking the sky's own horizon colour in whichever direction
  you look. So a far wall fades into exactly the sky behind it. To move the
  sun, change `SUN_DIR` and nothing else: the light, both shadow boxes, the
  disc, the glow and the fog all read it. The old sky was a painted sunset
  over a mid-afternoon sun, and that disagreement was most of why the city
  read as a set.
- **A window is traced in the facade shader, and the painter is what tells
  it where.** `WINDOW` in `textures.js` is the one definition of where an
  opening sits in its bay and storey: the painter lays windows out by it and
  `windows.js` cuts openings by it, and `wallUV` snapping walls to whole bays
  and storeys is what makes a wall's UVs a grid of window cells. Change the
  facade layout and both follow; snap a wall differently and the openings
  stop lining up with the paint. What is in each opening — glass, boards or a
  broken pane — is rolled while the texture is painted, so the painter
  records the twelve rolls (`facadeWindows`) and each facade material carries
  them as a uniform. The opening is gated to faces whose normal is
  horizontal, because the facade tile is unwrapped onto every face of a
  building and the tops of the roofless ruins wear it in plain view of the
  perches: without the gate each of those strips gets windows cut into it,
  a third of the frame looking down onto one. Nothing about it is geometry,
  which is the point and the limit: the shadow map, the occlusion pass and
  `hitscan` all still see a flat wall, so a bullet stops 22 cm short of the
  glass, the same as it did at a painted window. And the room behind a
  broken pane is invented, so it is wrong in exactly one place, a ruin's
  0.7 m shell wall, where the real space behind it is the open courtyard.
  The sun is read from `directionalLights[0]`, which is the sun for the same
  reason the cascade patch depends on it — see the next item.
- **The sun's shadow lookup reads two maps, and it depends on light order.**
  `shadows.js` rewrites three's directional-light loop so light 0 reads the
  tight map (shadow 1) where it covers and the wide one (shadow 0) beyond,
  blended over the tight map's outer tenth. Shadow-casting lights are sorted
  first and keep scene order among themselves, so this only holds while the
  sun is the first shadow-casting directional light added to the scene and
  the cascade the second. Nothing errors when that stops being true: the sun
  reads the wrong map. And a broken cascade looks exactly like a plaza
  standing in shade — which is what the first render of it was taken for.
  `the sun reads a sharp shadow map near you, and it agrees with the wide
  one` checks the order, the compiled shader, and that switching the cascade
  off moves shadow edges without moving how much of the frame is lit. Both
  boxes are snapped to whole texels in the light's frame, so an edge only
  moves when the thing casting it does.
- **Hit detection raycasts before the renderer runs**, so `Enemy.update` calls
  `group.updateMatrixWorld(true)` itself. Anything else raycast against needs
  its transform current too — the aiming laser had to refresh it before using
  `lookAt`, which takes a *world*-space target.
- **`pos.y` is an entity's feet height.** Every visual offset builds on it
  (bob, death topple, blood spawn). Setting a world Y directly reintroduces
  floating hostiles.
- **Game time, not wall clock.** Gameplay compares against `game.time`. Health
  regen once used `performance.now()` and silently never fired. The exception
  is FPS calibration, which deliberately uses wall clock because game time
  drops whatever a frame takes past 0.2 s. Below that, a long frame is split
  into steps of at most 50 ms (`MAX_STEP`, `MAX_FRAME`): the step used to be
  clamped to 50 ms, so under 20 fps everything — walking, falling, hostiles,
  every clock — ran in slow motion, and a slow machine felt sluggish twice
  over. The mouse moves once per frame however many steps it took
  (`input.endFrame` after each step), and `autoCalibrate` runs in `frame`,
  once per frame, not in `step` — so a check that drives the watcher by
  stepping has to call it itself. `a slow frame is still real time, and the
  mouse moves once` walks one wall-clock second at 60 and at 10 fps: 1.000 s
  of game time both ways, against 0.5 s with the clamp put back.
- **The view model renders in its own scene** over a cleared depth buffer, so
  the weapon never clips into geometry. It has its own camera and lights.
  The hands are children of the weapon's model, so every pose — recoil,
  reload, sprint, melee — carries them without being taught about them; an
  elbow is placed off the bottom of the frame for both hip and aimed, and a
  pose that swung the arms through the view camera would show the inside of
  a sleeve (which is why the sleeve is double-sided). Each model is merged
  by material at construction (`consolidate`), so anything that must stay an
  object of its own — the muzzle point, the lens, the unlit dot — is
  excluded there by kind. Every part records the tile it unwraps at in
  `userData.tile`, and the check judges each material against its own.
  **The hand's tile is what marks it as the hand**: `every grip rakes back`
  leaves out every mesh at the glove's tile (0.25) or the sleeve's (0.9),
  so anything worn on the hand — the knuckle guard and cuff strap (`PAD`),
  the watch and its dial (`DIAL`) — declares the glove's tile and has a
  material of its own. The first watch was built in the gun's dark steel,
  merged into the gun's own mesh, sat behind the pistol's backstrap, and
  the check read the grip as raking forward (−0.48).
- **A hand is swept, and every finger holds something.** `sweepGeo` in
  `shapes.js` sweeps an elliptical section along a path with
  parallel-transported frames, so the section never twists. Each end is a
  dome or an open ring, `bump(t, θ)` raises a knuckle or bunches a sleeve,
  the UVs follow the texture contract, and the winding is computed. `hand`
  in `weapons.js` builds everything from it, on the same grip frames as
  before, so no weapon's tuning moved:
  - fingers are wider than they are deep, taper to the tip, stand up at each
    joint with the glove's fold just past it, and differ in length and
    girth (`SIZES`);
  - a thumb swells into the mound at its root;
  - the back of the hand narrows to the wrist and arches over the knuckles,
    with a moulded guard across them;
  - the cuff carries a strap and tab, and the support hand a watch;
  - the sleeve tapers out toward the elbow and bunches against the cuff.
  Its folds had to be about a seventh of the sleeve's radius before a
  render showed them: at 3% the sleeve still lit as one smooth pipe.
  Each finger is recorded as it is built (`userData.digits`, with the hand
  it belongs to). `every finger closes on the grip it holds, or on the hand
  under it` measures the middle of each curl against the gun's surface or a
  finger of the *other* hand, never its own hand, because a floating hand's
  fingers still touch each other. The first version of that measure counted
  them and passed everything. It found the pistol's support little finger
  resting 17 mm off anything, refitted to 8 mm, and fails at 10.5 mm with
  the rifle's support hand slid 12 mm off its handguard.
- **The city you see and the city you shoot are different objects.** Once
  generation finishes, `bakeStatic` merges every static mesh by material and
  puts those in the scene; the meshes they were built from leave the scene
  but stay in `world.solids`, off the graph with their matrices frozen, and
  those are what `hitscan` traces against. Tracing the merged copy instead
  would test every triangle in the sector per pellet, and would change what a
  bullet can hit — the solid set is deliberately not everything you can see
  (a parapet is decoration; the wall under it is not). Anything added to the
  city after the bake has to be registered in both or it is invisible to one
  of them. The merge is per material *per patch* — `BATCH_LOTS` lots square,
  2 — so a cascade or the camera can cull what it cannot see, and anything
  wider than a patch, the ground first, is a batch of its own that always
  draws. The batches are built inside a `reserve` and pay `spend` for one
  geometry and one mesh per *material*, which is what the bake cost before
  it split, so the stream that picks spawns afterwards is unchanged —
  measured as the same mark after the bake, 27 batches or 148. The ground is the sharpest case: the one you see is subdivided to
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
- **Cloud is on the dome only, and weeds are decoration with a tier.**
  The clouds (`CLOUD_GLSL` in `atmosphere.js`) are a domain-warped value
  noise on a plane 1.2 km up, self-shadowed by one more lookup toward the
  sun, and they live in the dome's shader and nowhere else: the fog reads
  `ashAtmosphere` for every pixel in the city, and cloud in it would mottle
  the haze. The environment map is rendered from the dome, so the city's
  reflected light carries the cloud. The warp is worked out once and reused
  by the shadow lookup — the first version did it twice and was 20 noise
  lookups a sky pixel against 11. The weeds (`overgrowth` in `city.js`) are
  decoration by every rule in the decoration invariant — placed inside
  `decor` after the floors are registered, in neither collision list, and
  only where they can stand — and two things about the geometry are
  load-bearing. A tuft's two cards are each built twice with opposite
  winding and their own normal, tilted up, rather than drawn double-sided:
  three flips a double-sided face's normal on its back, which lights the
  back of a card as the underside of something. And they declare no `TILE`,
  so the texel-density check skips them, which is right for a card. One
  mesh per lot, so the bake files them into patches and they cull. On low
  they are hidden and the cloud drops an octave (`cloudLow`): measured on
  low, interleaved over three rounds, weeds were 32 ms and the cloud 22 ms of
  a 210 ms software frame, and low is the tier that has to stay cheap.
  Medium and high pay about 4% for both. `the sky has weather in it`
  (contrast 3.07 against 0.11 with the cloud returning the clear sky) and
  `weeds grow where they can stand, and stay off the low tier` (838 inside
  a collider with the clearance test out; shown on low with the tier
  ignored) guard them.
- **Water is a mirror for the sky and not for the sun; litter and puddles
  lie on one level or not at all.** A puddle (`puddles` in `city.js`) is a
  near-black fan at roughness 0.06, so it shows the environment map — the
  sky with its cloud — sharply. At that smoothness the sun's direct
  highlight is thousands of times brighter than the street, and the bloom
  made it a white egg the size of the puddle, at 0.04 and still at 0.1; the
  water material scales `directSpecular` down to a glint in its own shader
  (`onBeforeCompile`), and only there. The damp ring under it reflects
  almost nothing (0.12 environment, a tenth of the sun), because with any
  sheen it caught the bright sky at a grazing angle and came out paler than
  the asphalt it was meant to darken. Both are decoration by the flush rule,
  a centimetre up with the road paint's polygon offset — which is only true
  if every vertex finds the ground the centre does: the ring is tested
  point by point and a puddle that would cross a kerb is not laid. Litter
  (`debris`) is the same rule, and the first version only asked about each
  sheet's centre, so 172 corners hung over kerb lines; every corner is asked
  now. Concrete chips are plain boxes cut at `TILE.concrete` and merged into
  the concrete batches — a chamfered chip was 44 triangles, drawn three
  times because those batches cast shadows, and took a frame from 190k
  triangles to 424k. The weeds sway on game time (`windTime`, advanced in
  `frame`), with the tip moving as `v²` and the phase running across the
  city so a gust is seen to travel. A shop floor has its own pass
  (`shopLitter`), because `occupied` calls every room taken and `debris`
  never lays anything in one: paper banked along the walls and fanned in at
  each doorway, plaster chips, and glass under every window. It lies on the
  floor finish, 1.5 cm over the pavement (`FINISH`) — laid on the pavement
  it is under the finish and not drawn — and asks `blocked` at every
  corner, which is what a body walking in meets. The glass has its own
  material: the wrecks' glass, dark and metallic, read as scraps of black
  card laid flat, and a shard seen from above against dark concrete is pale
  and smooth. It runs last inside the same `decor`, so the street's
  ironwork keeps the draws it had. `puddles and litter lie on the ground
  they are drawn on` and `weeds move in the wind, and are still when time
  is` guard them; the first asks every room for paper, plaster and glass
  under its windows, and fails with the shop pass not run, with the corners
  not asked (141 vertices inside furniture) and with the litter laid under
  the finish.
- **What is set into the street asks the ground under every corner.**
  `streetIron` in `city.js` lays manhole covers in the lanes, gully grates
  in the gutters and blister paving on the dropped kerb at both ends of
  every zebra crossing, and `roadMarkings` lays yellow paint — double lines
  along some kerbs, boxes on some junctions — beside the white. All of it is
  decoration by the flush rule, and the flush rule only holds if every
  corner finds the surface the centre does: the ironwork runs after the
  floors are registered, asks `groundHeight` at each corner with a ceiling
  under every prop (0.5 m), and is not laid where the answers disagree. The
  paving lies on a ramp, so it cannot be level and is draped instead — see
  the next invariant. Every crossing, painted, paved or dropped, is
  `crossingAt`'s, one roll per junction per street. `what is set into the
  street lies flush on it, road or pavement` reads the merged city: paving
  at road height reports 360 corners on the wrong side of a kerb, and grates
  pushed onto the kerb with the corner test taken out stand 0.292 m off
  what is under them. "The pavement" in that check is a floor's footprint
  now, not a height over 0.2 m, because the paving comes down to 3 cm.
- **Weathering is a thresholded fractal, never a filled shape.** Every large
  stain goes through `mottle`, which used to fill ellipses into a low-res
  layer. Upscaled, they came out soft-edged and still round, and a surface
  of soft round stains is polka dots — the plaza, every barrier, the
  containers' "rust eating through" and their "dents". `mottle` now
  thresholds a domain-warped, tile-wrapping fractal (`wrapFbm`) at the
  quantile that stains as much of the tile as the discs used to, and shades
  the inside with a second field; it keeps its old arguments, so every call
  site is unchanged. A filled `ellipse` for anything larger than a fleck is
  the thing not to write again — the shell crater is the one place round is
  right. `weathering is ragged, not round` measures perimeter² / (4π·area)
  against a disc on the same canvas: the old discs 1.04x, the fractal
  1.6x. The field is a pixel loop, so it costs boot time where ellipses did
  not; the layer is a fifth of the tile's resolution (64-160 px) and the
  noise is written flat, which brought the cost from +2.9 s to +0.7 s of
  boot under software rendering, and that is CPU, so it is real.
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
- **A gun and a car are drawn by their side view, and the side view is the
  part.** `sideGeo` in `shapes.js` extrudes an outline in (z, y) across X
  with its edges rolled over; `latheGeo` turns a profile about an axis;
  both hand their output to `creaseNormals`, which averages a corner only
  across facets that turn by less than the crease angle, so a grip comes out
  round and the edge where it meets the frame stays an edge. Four things
  about them are load-bearing. The bevel is taken *inside* the outline
  (`bevelOffset = -bevel`), so the silhouette is exactly what was drawn and
  the caps sit at ±width/2 — three's default grows the part by the bevel,
  which would have pushed every wreck past its collider. A lathe profile is
  walked with the material on its left, from the muzzle end, so a bore faces
  in and a crown faces forward; three decides a lathe's winding from that
  direction, so `latheGeo` checks its facets against three's own normals and
  turns the lot round if most disagree, rather than trusting the order it
  was given. UVs are planar off each facet's normal at the declared `TILE`,
  or arc length round a lathe, so the texel-density checks cover all of it.
  And a wheel is one lathe with two surfaces off one tile: `uv` sends facets
  that face along the axle to the face painted in the middle of `TEX.tire`
  and the rest to the tread in its bottom quarter, and the tire painter's
  circles are drawn to the radii the lathe turns — change one and change the
  other. **Every grip rakes back**, built by `gripOutline` from the same
  centre and rake the hand is closed round, so the fingers fit what is
  drawn. They all used to rake forward: the old grips were boxes turned by a
  positive `rx`, which tips the bottom toward the muzzle, and the hands had
  been fitted to that, so nothing looked unheld and every side view looked
  wrong. `every grip rakes back toward the shooter` slices each gun where
  its facets cross two levels of the grip and reads the backstrap: −0.22
  with the old pistol. **A wreck fits its collider**: 1.9 x 4.4 m and 1.5 m
  to the roof, which is the deck you stand on when you climb it. The lofted
  wreck stood 1.82 m over a 1.5 m collider and its arches 0.98 m out from a
  0.95 m one, and a burnt shell was dropped 0.2 m into the road with no
  wheels; `a wreck fits the box you collide with, and stands on its wheels`
  fails on all of it.

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
- **A drop is cloned at the price it always cost, and a cloned mesh costs
  three UUIDs.** What a hostile leaves (`drops.js`) is cloned mid-fight,
  where the stream picks spawns, so its shape used to be part of where the
  next wave came from. `maybeDrop` clones inside `reserve` and pays
  `DROP_COST` — 28, 40 and 28 draws, measured on the old drops. They were
  first written down as 12, 16 and 12 by counting objects, and that was
  wrong: `Object3D.clone()` constructs a bare `Mesh` and copies into it,
  and a bare `Mesh` mints a default geometry and material before the copy
  replaces them, so every mesh in a clone costs three UUIDs and a group
  one. Measure a bill like this, never count it — `rewind` to the mark
  before and draw until you reach the mark after. And a drop has to be
  findable before it is anything else: drawn as the real things are, in
  olive and steel, the can and the grenade vanished into the street at
  eight metres, where the mustard box they replaced was the brightest thing
  in the frame. Each lies over an additive halo in its own colour, kept on
  the floor while the drop bobs over it. `a drop is made the way the thing
  is, and costs the spawn stream what it did` reads all of it: 40 draws for
  an ammunition drop with the price not paid, the halo 0.062 m off the
  floor when it bobs with the drop, and the can at 0.5x its tile unwrapped
  at twice it. The drops were never in the boot compile either, so the
  first to fall compiled the halo's program mid-fight; `nothing compiles at
  first contact` drops one of each now.
- **Kit that is not a hit zone is armour you shoot through.** A hostile's
  plate, pauldrons, hood and pouches are merged into the meshes that already
  carry a `zone` — the torso, the rig, the head — rather than hung beside them
  as extra meshes. A mesh with no zone is not in `hitMeshes`, so it is not
  raycast: kit hung on loose would be a silhouette bullets pass through, and
  would also put another dozen meshes per hostile into the per-pellet
  intersect list. The same merge is why a hostile is now 12 meshes rather than
  15 while carrying six times the triangles (13 in a coat; see the next item).
- **A hostile is swept, and what it wears is cut from its body.** Every
  hostile was chamfered boxes — a brick for a torso, a cube for a head, a box
  for a fist, blocks for boots — and a wave read as robots: 53-56% of each
  body's surface faced square down an axis, 15-19% now. The body's section
  is one table, `BODY` in `makeKit` (height, half-width, half-depth, how far
  forward its middle sits, from the hips to the shoulder line). The torso is
  swept through it and domed over the shoulders, `face` and `crown` say
  where its surface is, and anything worn over it is a `wrap`: the same
  section grown by `out`, standing proud across the arcs given and scaled
  under the cloth everywhere else, so its edges roll into the body instead
  of standing off it. A plate is only the span that shows (`sweepGeo`'s
  `arc`). Change a row and every plate, strap, pouch and the marker band
  move with it. Four things about it are load-bearing. **Vertex colours
  shade a piece against its material** — a glove is the sleeve's cloth at
  0.32, a boot the trouser's at 0.42 — so `cloth`, `gear` and `skin` are
  `vertexColors: true` and anything merged into a hostile part needs a
  `color` attribute (`tone`; `mergeIntoOne` fills white where one is
  missing), the same rule as the city's materials. **A flat sweep is
  creased** (`flat`): smoothed the way a limb is, the knife edge down a
  strap averaged its top face with its bottom one, and the facet at its end
  was lit as if it faced inward — 11 of them, which `nothing is built inside
  out` found. **A coat hangs from the hips**: its skirt is a part of its own
  (`skirt`, on the group, not on `upper`), because the waist turns 0.48 rad
  into a stance and a coat on it swung a thigh out through its front. It is
  batched like every other part, for the archetypes that have one, and it is
  a mesh no hostile used to have — and a new `Enemy` is built mid-run, out
  of the stream that picks the next spawn — so it is minted in a `reserve`,
  and a spawn still costs 100 draws (112 for the marksman). And **the eye is
  two lenses** in goggle cups at the middle of the face (`AT.eye` at x = 0),
  which is what the facing check reads. What it costs: 6.3-8.5k triangles a
  hostile with its gun, against about 2k; the first cut was 13-17k, and the
  rings and sides came down until no silhouette moved. Draw calls are
  unchanged but for three per coated archetype in view. `a hostile is a
  body in kit, not a stack of boxes, and costs a spawn what it did` fails
  three ways: on the old builders (53% square), with the skirt minted
  outside the reserve (104 draws), and with the skirt hung on the waist (2
  points of thigh through the coat — weak, because a near-round skirt hides
  most of the turn, but it bites).
- **A hostile is built facing -z, and the weapon decides where the hands
  go.** The turn used to point the body's +z at its target, so every
  hostile that ever fought you did it facing away — eye glowing from the
  back of its head, tracers leaving a muzzle behind it, walking backwards
  on patrol — and nothing errored, because the body is nearly symmetric
  front to back and `_shoot` aims from the muzzle's position, not its
  direction. Measured: face · toward-you -0.93, gun -0.95. The yaw is
  `atan2(-x, -z)` now, and the group's rotation order is `YXZ`, so a lean
  or a topple is about the body's own axes. The animation is written once,
  for the weapon: `_animate` poses the gun in the body's frame (shouldered
  and pitched at the target, carried low on patrol, raised and driven down
  for the hook), and both arms reach for its hand-holds (`kit.hold`) by
  two-bone IK (`reach`). A pose that moves the gun moves the hands; a pose
  that moved an arm directly would take the hand off the gun, and `a hostile
  faces you, and holds its weapon in both hands` measures exactly that in
  three poses. The arm reaches 0.58 m, and a hand-hold further from its
  shoulder than that is reached for with a straight arm and missed — which
  is how the first patrol carry failed it, 7 cm short.
- **A part's own position is where that part is.** The kit geometry is built
  *about* each part's origin (`AT` in `enemies.js`) and the mesh is placed
  there, not baked to world height with the mesh left at zero. Every check
  that shoots a hit zone reads `parts.head.getWorldPosition()`, which is the
  testing note about hardcoded aim heights from the other side: baking the
  offsets in put every part at the feet, and turned the headshot check into a
  leg shot that quietly still passed the "did damage" half.
- **A hostile is drawn by its archetype's batches, and shot through its
  rig.** `HostileBatches` in `enemies.js` keeps one `InstancedMesh` per
  archetype and part — torso, rig, head, head kit, upper and lower arm,
  thigh, shin, gun, band and eye, and a coat's skirt for the archetypes that
  wear one — and writes every shown hostile into them
  from `scene.onBeforeRender`, which three calls after it has brought every
  matrix up to date, so every pass in a frame (both cascades, the occlusion
  depth, the scene) draws the same instances. The rig's own meshes are
  built exactly as before and hidden (`visible = false`, tagged
  `userData.batch`): a raycast ignores `visible`, so `hitscan`, `hitMeshes`
  and every check that reads `parts.*` are untouched, and so is the number
  of objects a spawn mints, which is part of the stream that picks the next
  spawn. Four things about it are load-bearing. A lower limb hangs off its
  hidden upper one, so "is this shown" walks the ancestors and treats a rig
  mesh as shown — the first version did not, and drew every hostile with no
  shins and no forearms. The band and the eye keep their per-hostile
  materials, because the elite's gold and the hurt flash write to them, and
  the batch reads each colour into `instanceColor`. The contact shadow and
  the laser stay a mesh per hostile: each fades on its own opacity, which an
  instance cannot carry, and neither casts a shadow. And a batch is built at
  boot inside `reserve`, and grown inside one, because an object minted
  mid-run spends four draws of the stream. A body has to be `track`ed to be
  drawn at all — an `Enemy` does it in its constructor and the boot compile
  does it for the sample bodies — and anything that ever adds a mesh to a
  hostile adds it to `BATCHED` or leaves it a mesh of its own. Twelve
  hostiles on seed 1, software rendering: 731 draw calls a frame on high
  against 251 for the empty street, now 408; on low 267, now 142. What it
  gives up is culling a hostile on its own, which put the high frame's
  triangles up 3% (547k to 565k), and no frame time moved past noise
  (2,410 against 2,451 ms on high). `a wave is drawn a part at a time, and
  looks like the hostiles it is` asks for nine more hostiles to cost only
  their contact shadows and for the batched frame to match the rigs drawn
  directly: 9 calls and 2 differing pixels of 16,844; 144 calls with the
  batches taken out, and 2,730 pixels with a shin hung off a hidden thigh
  counted as hidden.
- **Boot is a list of stages, and it yields between them.** `Game.boot` runs
  a plan of `[label, weight, run]` and gives the page a frame before each
  one (`yieldToPaint`), so the loading screen can say what is happening and
  move. It used to be the body of the constructor — one task, seventeen
  seconds under software rendering, with the page frozen on the word
  LOADING. Three things keep that from costing the seed anything. Every
  stage that mints three objects still runs inside `reserve`, or is the city
  itself, exactly as before. The order is unchanged. And nothing that runs
  while boot waits may draw on `Math.random`: the loading screen cycles its
  field notes off the seed and the clock, and the only listeners bound by
  then are input. The city's materials are `CITY_PAINT` in `city.js`, a step
  per facade style and per family, because painting them is seven of those
  seventeen seconds and as one step the bar would sit still for most of
  boot. Anything that moves *continuously* on the loading screen is a CSS
  transform or opacity, because between yields no script runs and only the
  compositor can animate. Weights are tenths of a second: as measured for
  the CPU stages, estimated for the three GPU ones, which software
  rendering inflates about a hundredfold. `window.__game` exists from the
  first stage; `state` is `'loading'` until the last, which is what the
  harness waits on, and `game.booted` resolves then too.
- **Under `reserve`, a UUID is not unique — never key anything on one.**
  `reserve` rewinds the seeded stream, so every reserve that starts from the
  same place mints the same UUIDs. That was true before boot was staged
  (each archetype's kit is its own reserve), but nothing keyed on them until
  `bakeStatic` bucketing by `material.uuid` met the city's materials painted
  in separate steps: 16 of its 27 materials were merged into other steps'
  batches, every facade and the streetlights among them, and nothing errored.
  Key on the object (a `Map` takes one), or on `id`, which three counts and
  never rewinds. `every city material survives the bake` reports the 16 with
  the UUID key put back. The texture side of the split was checked the other
  way: a hash over every pixel of all 66 city textures is identical before
  and after, because each is painted on its own generator.
- **Every shader is built before the first fight, and nothing is built
  lazily in one.** `renderer.compile` only compiles what is visible, and at
  boot that was the city: every hostile, every pooled tracer, casing and
  sprite, and the muzzle flash compiled on the first frame that drew them —
  five programs at first sight of a hostile and three on the first shot,
  measured on seed 1, a stall at exactly the moment of first contact.
  `Game.precompileStages` shows every hidden thing, stands one body of each
  archetype in front of the camera (`sampleBodies`, inside `reserve`, never
  pooled), compiles both scenes, uploads every texture their materials hold,
  draws one real frame, and puts everything back. Three things in it are
  load-bearing. It compiles against `post.sceneTarget()`, because a
  program's key carries its output colour space — linear into the post
  target, sRGB onto the canvas — and the first version compiled all eight
  for the canvas and then compiled them again in the fight. It leaves lights
  alone, because the light count is in every lit key too. And the real frame
  is there because a compiled program is not always a finished one: with
  every program built and every texture uploaded, the first-contact frame was
  still 0.7 s slower than the next under software rendering, and the frame
  is what took that out. The other half of the rule: the muzzle flash used
  to be built on the first shot, which is a compile mid-fight *and* a sprite
  and a material minted out of the seeded stream at the trigger pull. Build
  a thing with its owner, inside the owner's `reserve`, never on first use.
  `nothing compiles at first contact` deploys, shows every archetype, fires,
  throws and detonates, and requires zero new programs; it reports all eight
  with the old boot compile put back.
- **`auto` quality watches the whole run, pulls resolution before tiers, and
  never goes back up.** It used to judge the first three seconds of a run —
  an empty street before wave one, the cheapest the game ever is — and then
  stop. A dozen hostiles is 555 draw calls against 421, and the high tier on
  a 2x screen draws 1.75x resolution, which costs 2.4x the frame under
  software rendering — so the fight is where a machine falls short, and the
  old calibration had stopped looking by then. Now any three seconds of
  unbroken play under 55 fps (it was 45) gives something back: in a fight, 15% of
  resolution (`renderScale`, down to 70%), because a pixel ratio change moves
  no shader; with nothing alive, a tier, because a tier change recompiles
  every lit material and that stall belongs between waves. Wall clock, since
  `dt` is clamped; and any gap over a quarter second (a pause, a hidden tab)
  restarts the window rather than reading as a slow frame, which also means
  the suite — a software frame takes a second or more — never trips it.
  Never stepping back up is deliberate: a picture that see-saws between two
  settings is worse than either. `auto quality keeps watching, and gives
  back resolution before shaders` fakes the frame clock; it fails on the old
  calibration and when the tier is allowed to change mid-fight.
  Because it only ever steps down, where it *starts* matters, and it used to
  start on high on every machine and earn its way down in the first fight —
  three seconds of slow frames per step, at the worst possible moment. A
  boot stage (`chooseStartingTier`) now times a few frames of the city at
  each tier, behind the loading screen, and starts on the best one that
  draws the empty street in 12.5 ms (`START_BUDGET_MS`) — 60 fps with the
  third a fight costs on top; it was 16.7, which started machines on a tier
  they could hold only until the first hostile. And once resolution is
  spent in a fight and it is still short, it drops a tier anyway: one stall
  while shaders rebuild beats a wave at 40 fps. One rule keeps it honest: a frame over 250 ms is not a
  measurement — it is software rendering, or a tab in the background — and
  then it changes nothing and starts on high, which is also why the suite
  never sees it pick anything else. `auto starts at the tier this machine
  can hold` fakes the clock and fails when the function always says high,
  and with the old 16.7 ms budget; `auto quality keeps watching` fails with
  the bar at 45 and with the in-fight tier drop taken out.
- **The post chain reads the scene through `sane()`, and bloom is why.**
  One pixel that is not a finite number — a NaN from a normalise of zero, an
  overflow in a half-float target — is invisible as one pixel. The bloom
  takes it through a 9-tap blur at half resolution and another at a quarter,
  and it comes out as a black box tens of pixels across that blinks as the
  view moves: reported from play as boxes in a rough vertical line round the
  gun. It never reproduced here — 200 swept frames under software rendering,
  0 non-finite pixels — because what makes the bad pixel is the GPU's own
  arithmetic. So the bright pass and the composite clean what they read
  instead: anything whose exponent bits say NaN or infinity, or that is
  brighter than 1024, becomes black before the blur sees it, and the bloom
  input is capped at 64. The test is the exponent bits rather than `isnan`,
  because a compiler is allowed to assume no NaN and fold `isnan` away. The
  1024 bar is not arbitrary either: SwiftShader saturates an infinity to
  65504 when it stores half float, and a bilinear half-resolution read
  blends that down to about 16,000 — finite, and still a box. The sun disc,
  the brightest honest thing in the frame, is about 40. Both bloom inputs
  are bound to the scene itself when bloom is off, at strength 0, and NaN
  times 0 is NaN, so the composite cleans them even then. `a bad pixel stays
  one pixel, it does not bloom into a box` puts a speck of NaN and then of
  infinity in front of the camera: 4 pixels changed each, against 6,589 with
  `sane` returning its input.
- **The low tier is plain, and point lights are pooled.** Low used to drop
  shadows and post and keep everything else, and everything else was most of
  it: reported from play as 14 fps on an Intel HD with auto already on low.
  Measured on seed 1 under software rendering, three views, low went 986 ms
  a frame → 176. Three changes, each measured on its own. **The canvas has
  no multisampling** (`antialias: false`): high and medium draw into the
  post chain's own multisampled target, so the canvas's samples only ever
  antialiased low, and cost every tier a resolve — 27% of low's frame.
  **Fire lights are pooled**: every barrel carried a point light and every
  lit pixel looped over all twelve (ten fires, the muzzle, the blast). Each
  tier lights a fixed number (`fires`: 3, 2, 0), handed to the nearest
  barrels every quarter second by `placeFireLights`; the muzzle and blast
  lights are hidden on low. *Fixed* is the load-bearing word — the count of
  visible point lights is part of every lit program's key, so a count that
  changed as you walked would recompile the city; which barrels hold them is
  not. **Low draws Lambert twins** of every PBR material in the world scene
  (`dress`, `twinOf`): PBR against the sky's environment was half of low's
  frame on its own. A twin shares the original's map, vertex colours, fog
  and its `Color` objects, so a hostile's band and hurt flash still change
  both; it is built once, inside `reserve`, because a material mints a UUID.
  Anything that joins the scene after the tier is applied must be dressed —
  a hostile on spawn, a drop when it is cloned, the bodies shown to the
  boot compile — or it arrives in PBR and compiles at first contact (booted
  on low: 18 programs at the menu, 0 new in the fight). The view scene is
  not dressed: the gun turned flat chalk as Lambert, it is a small share of
  the frame, and its scene has no point lights. And Lambert cannot see the
  environment, which is most of the light a shaded wall gets, so on low the
  hemisphere rises from 0.28 to 2.8 (`HEMI_PLAIN`), matched against the PBR
  frame: mean 82.1 against 82.2 and darkest fifth 42.5 against 39.5, where
  0.28 left shaded walls black. Two checks, each confirmed to fail by
  breaking the reader: `the low tier draws plainly` (163 PBR meshes with
  low left on PBR, 57.1 against 80.9 brightness with the hemisphere left
  alone) and `the fire nearest you is lit, and the light count never
  changes` (12 visible on the old code). High and medium gained about 10%
  from the pooling and the canvas (1537 → 1403 ms, 1396 → 1259).
- **A hostile climbs after you, and then holds the deck.** `mantleTarget`
  was always entity-agnostic and only the player called it, so a car roof
  was somewhere to stand over a melee hostile that could only circle it
  until the watchdog took it away. A hostile now climbs (`CLIMB` in
  `enemies.js`) when it is alerted, off any perch, already heading for you
  — its move direction within about 45 degrees of you, so a raider
  strafing at its range or backing off to hold it never charges a car —
  you stand at least half a metre above its feet, and you are within 9 m.
  Three things make it work. Avoidance turns a hostile aside from anything
  chest-high two metres out, so it never reached a lip: when there is a
  climbable lip ahead (`mantleTarget` with a longer `reach`), avoidance
  stands down and it walks to the face. The climb owns the body the way a
  pull-up owns the player — the player's own curve, slower (0.6 s + 0.4 a
  metre), no turning and no firing — and a hostile killed halfway up drops
  to whatever is under it. And once up, it holds the deck: a melee hostile
  at its range strafes, and of twelve that climbed after the player on seed
  1, six strafed straight back off the edge within seconds. The edge guard
  stops any step that drops more than a step height while the player is not
  below it — following you down is still allowed. Perch-holders never climb.
  `a hostile follows you onto a car roof, and stays up there with you` puts
  the player on eight decks on seed 1: 8 of 8 up within 1.3 s and still up;
  0 of 8 with the climb taken out and 4 of 8 still up without the guard.
- **A hostile runs dry, and a reload is a window.** Every ranged archetype
  carries a magazine (`mag`) and a reload time (`reload`): a raider 30 and
  2.2 s, a breaker 6 and 2.6 s fed a shell at a time, a marksman 5 and
  2.4 s, a juggernaut's drum 60 and 3.2 s. When it empties, nothing fires
  for the reload, the marksman's laser stays off, and the stages are heard
  where they happen (`audio.reload` takes a place now, like every other
  sound from somewhere). The pose is the rig's, as every pose is: the gun
  dips and cants, and the support hand's IK target walks a path keyed to
  the reload's progress (`_reloadHand`) — handguard, magazine (`hold.mag`,
  a point on each weapon), down, a pouch on the hip, back — so nothing
  about the arm is animated directly. The pouch sits on the hip and not on
  the belt buckle because the first one was 2 cm from the magazine and the
  trip was invisible. Cover is decided once, when the reload starts, by
  asking two lines of sight from the target: if a standing chest is seen
  and a crouched one is not, it kneels (`CROUCH`: hips down 0.36 m, one
  foot planted, the other knee down, worked out from the 0.43 m thigh and
  shin) and stops dead for the duration, and looks from its lowered eyes,
  so it sees what its body can. In the ring of gunfire past the alert
  radius (`alertNearby`, out to twice it) an unalerted hostile `hear`s the
  shot and turns its head toward it for 2.5 s, clamped at a neck's turn
  — a tell, not an alert. None of it draws on `Math.random`, though the
  pauses it puts in the fire move every later runtime draw, which is the
  ninth testing trap's noise. `a hostile reloads behind cover, and turns its
  head to a far-off shot` measures the gap in the fire (0.17 s with the
  hold taken out, against the 2.2 s reload), the fist at the magazine
  (0.139 m off it with the hand left on the handguard), the kneel (a head
  0.04 m lower with the body not lowered), and a head held 60 degrees off
  a shot coming round to 0.99 (0.5 with the ring not heard or the neck not
  turned).
- **A sound from somewhere is placed there, and only its direction is the
  panner's.** Every sound was mono. Now anything that happens at a point —
  a hostile's shot (at its muzzle), an impact, a hit, a death, a blast, a
  grenade bounce, an alert — goes through `_out(at)`, a fresh HRTF panner
  at that point, and `listen` puts the listener on the camera every frame.
  HRTF rather than equal-power because a stereo pan cannot tell front from
  back. `rolloffFactor` is 0: loudness stays the caller's own distance gain,
  exactly as before, so placing a sound changed nothing about how loud
  anything is. What is yours — your gun, your steps, the HUD — stays
  unplaced, and so do the tails off the buildings (a shot's echo, a blast's
  roll), which come from every wall at once. Nothing here touches the seeded
  stream; `distantFire` and the alert's 30% gate already drew on it and still
  do, in the same order. `a shot from your right is heard on your right`
  stands a raider at the player's right, records where the game placed its
  shot and the ears, and plays that shot through the real chain into an
  `OfflineAudioContext` (`audio.init(ctx)` takes one): right over left 2.42,
  0.42 from the mirror position, 1.03 unplaced; 1.0 with the panner taken
  out, and no place at all with the muzzle not passed. A hostile's
  footfalls go the same way (`onFootfall` in `main.js`, `footfall` in
  `audio.js`): one each time a leg reaches the front of its swing, off the
  same `walkPhase` the legs are drawn from, so the sound keeps time with the
  picture. Two things keep them from being noise. The phase creeps even
  standing still, so only a hostile actually walking (`amp` over 0.3) makes
  a sound; and a wave is a crowd, so steps carry 26 m (`FOOTFALL_RANGE`)
  and at most four play in any quarter second (`FOOTFALL_VOICES`). The pitch
  varies off a counter, never `Math.random`. `a hostile is heard walking,
  where it walks, and only while it walks` counts four footfalls in two
  seconds at 2.4 m/s and none standing or 60 m off, and plays one through
  the real chain: 0.30 right-over-left from the left, 3.4 from the right;
  1.01 with the step left unplaced, and none at all with the stride's
  footfall taken out.
- **Tone mapping belongs to exactly one stage.** With post on, the scene pass
  stays linear and `post.js` applies the ACES curve; with post off the
  renderer does it. Both at once looks chalky and washed. `Post.configure`
  owns that switch — do not set `renderer.toneMapping` anywhere else.
- **Perch-holders never leave a perch.** Marksmen do not drift while unalerted,
  do not strafe on a perch, and get a longer stuck-watchdog leash. All three
  routes had to be closed before they stopped falling off roofs.
- **A perch may be a window, and a holdout may be upstairs.** Two uses of the
  floors, both reading them rather than scripted into them.
  `findWindowPerches` in `main.js` picks one window a stairwell building —
  on any floor — for a marksman to stand 0.95 m back from: whichever sees
  most of a fan of street out to 55 m (`WINDOW_PERCH`), which favours a
  window onto a junction without being told to. 12 of 13 buildings on seed
  1, all on the first floor, because a sill cuts off the near street from
  higher up. They are computed at boot and draw nothing, so `g.perches` and
  the layout are untouched; `findPerch` draws from both lists, so about
  half of marksman spawns and relocations land at a window. A marksman there
  holds it with no new code: `onPerch` is any perch-holder over 1.5 m.
  Every other rescue (`rescues` in `objectives.js`, so the first is a shop)
  puts the holdout on a floor (`floorSite`), sited only where the walk to
  the landing door the hostiles' way (`Enemy._floorWay`, run in
  `_walksOut`) stays clear of furniture — without it a crate stack held one
  on its floor for the whole escort; the handler says to find the stair;
  it counts only from within 1.2 m of the floor's height, because floors
  can be 2.9 m apart and the shop's 3 m let the floor below cut it loose.
  Cut loose, it comes down by the stair walk (`_follow` calls
  `_stairWalk`): back to the door, onto the landing, down the points, into
  the street, out of the building within 11 s on all 32 floors of seed 1.
  The street was the hard part. A holdout has no watchdog, and it used to
  have no avoidance: walking straight at you over the last 8 m it stood
  against every wreck between you, 16 of 16 on seed 1. It shares the
  hostiles' now (`_avoid`, extracted), with one difference, `keep`: it
  searches every angle round the side it chose before any round the other.
  Along a wreck's long face the probe grazes it, the nearest open angle
  swapped sides every frame, and a holdout stood shuffling at the door. The
  hostiles keep the nearest-angle order, so nothing about them moved. Two
  more were written and taken out because nothing needed them once those
  were in: a "same floor as the player" gate on following, and a probe at
  the feet for a step too high, which helped one heap and turned a holdout
  away from another it would have slid past. Shop rescues, all 21 rooms
  under three draws: 62 of 63 before, 63 after. Floor rescues under the
  same three: 95 of 96, and the one short stopped against a steep heap in
  the street after the building — see the rubble invariant — which is why
  the check allows two. While the player is
  on a floor, the hostiles' cover posts are the shop's stair door
  (`roomAt` reads a floor as its stair's shop), which is the floor's only
  way down, so a floor's landing needs no posts of its own.
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
- **The operation is data, and the cast is hostiles that read a flag.**
  `story.js` is the briefing, the three acts, the plan (`objectiveFor`:
  which objective each wave brings, the convoy until it is out, then a
  rotation) and every radio line, picked by a count and never by
  `Math.random`. So the story moves neither the layout nor the spawns,
  and changing a line changes nothing else. What the newer objectives put
  on the map is built out of `Enemy`, not beside it. **A holdout is an
  archetype with `friendly`**, and five readers have to know it:
  `aliveCount` (or the wave never clears while one lives), `hitscan` and
  `meleeStrike` (it is not a target), `alert`/`hear` (it never fights), and
  `explode`, which hurts it and credits nobody. It is drawn by its own
  batches, which cost nothing while none is alive, and the boot compile
  shows one with every other archetype. It follows by the route field
  (`_follow`), straight at you only for the last 8 m, because a line of
  sight out of a shop runs through windows. Pressed against a wall it
  stands in the shoulder of cells the field blocks round every solid, where
  `heading` has no answer, and steering at the player from there is
  steering into the wall. A hostile gets out of that with its avoidance,
  and a holdout has none, so `_route` steps to the cheapest open cell
  beside it (`NavGrid.costAt`). Without that, on seed 1 a holdout cut loose
  79 m from its pickup moved 6 m in a minute. **A lieutenant is a raider
  with `flee`**, walking a second `NavGrid` built from his exit (the class
  imports nothing, so a second instance is free of the stream). His
  `escort`s keep with him until something alerts them. While a charge is
  live, `game.lure` draws any alerted hostile that cannot see you to it.
  All three are walking somewhere other than at you on purpose, so the
  watchdog holds off for each of them; it would otherwise read a
  lieutenant leaving as lost and relocate him. The new props are built in
  a `reserve`, because the objective system is built after the city, where
  the stream is picking spawns. Siting draws `Math.random` at run time, the
  same as `findSite` always has. Where the city has nowhere for an
  objective (no stairwell in reach of a relay), a beacon stands in for it,
  and carries what was asked for (`instead`), so the handler says why
  rather than calling a beacon from nowhere. A charge blows on top of its drum
  (`y + 1.1`): blown from the drum's middle, every blast line started
  inside its collider, and nothing in reach was exposed.
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
looking at state, and guessing first cost hours. A probe body may return a
promise, and it is awaited, so `return (async () => { const T = await
import('/src/textures.js'); ... })()` reaches any module directly — the
same import a check can make inside `page.evaluate`.

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

Two more framings came out of the hostile-bodies and open-buildings passes.
A close-up from the player's side of a lineup is usually backlit — the sun
is low and behind whatever stands in the plaza — and a backlit body is a
silhouette that hides every fault in its shape. Put the camera between the
sun and the subject instead (`SUN_DIR` from `atmosphere.js`, camera at
subject + sun·d looking along −sun, the subject turned to face it). And a
room is framed off its own doorways, not off its footprint: `world.rooms`
gives each doorway's middle and outward normal, so stand 8 m out along the
normal looking in, on the threshold, and at the back looking out. Placing
the camera by footprint alone put it inside the next building twice.

When a change is meant to move the layout in one place only, prove it
collider by collider rather than by fingerprint: dump every box (rounded
to a centimetre) on both trees for the three pinned seeds, diff them as
multisets, and require that everything gone and everything new lies inside
the footprints that were meant to change, with the perches and
`Math.random.mark()` after boot identical. That is what the open-buildings
pass recorded in the layout check, and a fingerprint alone could not have
said it.

A sixth, which is really a tool rather than a trap: the bot that plays the
scripted run lives in `tests/harness.js` as `window.__botRun(seconds)`, not
inside a check, because more than one check now reads it and two divergent
copies of a bot with this much history is worse than one. `game.reload({ seed })`
reboots on a different city mid-suite, which is what a check needs when the
bug it guards is a property of a layout the pinned seed does not have.

A seventh, from the lighting pass, about checks on how something looks.
Three of them were written there, and all three failed first on code that
rendered correctly — and in all three the code was fine and the measurement
was wrong. Averaging the cascade's effect over the bottom half of the frame
measured sunlit foreground that either map lights the same, while the
shadows sat mid-frame. Comparing the sky's warmth after tone mapping measured
the ACES shoulder, which rolls the bright sky by the sun toward white; read
the linear scene target instead. And the occlusion check, framed looking
straight down at pavement, *passed with the striping bug restored*, because
the stripes only form at a grazing angle. That last one is the expensive
kind, and the only thing that caught it was the rule that a check is
confirmed to fail against what it guards before it is kept. Two related
traps came out of the same check. "Open" by the box list is not open: the
sidewalks are a 28 cm kerb that every obstacle query skips, so a spot clear
of every obstacle still has kerbs either side, and kerbs are rightly
occluded. The
check now hides every city mesh but the merged ground plane, so the frame is
flat by construction. And a look bench that hides the city for one view has
to put it back before it measures frame cost, or it measures an empty
sector (the first perf numbers for this pass were 2,606 triangles a frame).

For timing anything in the headless browser, `gl.finish()` is not a sync
point — it returns early in the GPU process and made a 142k-triangle frame
look like 2.6 ms. A one-pixel `readPixels` is.

The other side of that: a frame drawn without a sync is not free, it is
queued. `the fire nearest you is lit` first drew ten high-tier frames in a
loop to see whether any compiled a program, which under software rendering
queued 20-30 s of drawing that nothing waited for — until the next check's
page load, which waited for all of it and hit the 30 s navigation timeout.
It looked like a flake: it passed at 41 s on one local run and failed on
CI and on another. If a check only needs to know what would compile, ask
`renderer.compile(scene, camera)`, which builds programs under the current
lights and draws nothing; if it needs pixels, sync each frame it draws.
And a check that drives `g.frame()` for what it does besides drawing — the
ears follow the camera there — stubs `g.render` while it does, because
nothing in it is looked at and each drawn frame is seconds of software
rendering.

**No check may wait for ever.** CI's shards were cancelled at the job's
25-minute limit three times, each with nothing in the log after the last
check that passed, and each time the next check was one of the two that
play a sound through an `OfflineAudioContext`: `a shot from your right…`
twice, and `a hostile is heard walking…` once, which draws nothing at all.
So the hang is `startRendering()` now and then never resolving on CI's
headless Chrome. It never reproduced here, in dozens of runs. The first
diagnosis blamed the shot check's drawn frames, and stubbing them was
pushed as the fix; the next CI run hung on the walking check, which is
what showed the two had only the offline render in common. Two guards now:
`__offline` in the harness gives every offline render a deadline and a
fresh context to retry on, failing by name if every try stalls; and the
runner gives every check 300 s (`CHECK_LIMIT_S`, against about 95 for the
slowest), so any hang still to come fails as itself instead of taking its
shard down with it. Confirmed both ways: a 1 ms render deadline fails the
shot check saying so, and a 3 s limit fails the scripted run by name and
lets the run finish.

It finally reproduced here, in the hostile-bodies pass: the walking check
stalled in two runs of eight, the last five clean, while `main` passed four
of four alongside — too few runs to call a difference, and the same stall
CI had already shown three times on the old code. What
it showed is that a stall is not one render: once one hangs, every later
offline render in that page hangs too (all three of `__offline`'s tries),
and the page will not navigate either. The reload after it timed out at
30 s, outside any check, and the runner died on the uncaught exception with
every check after it unrun. So a reload that fails now relaunches the
browser (`renew` in the harness), and a check that failed *and* left the
browser wedged runs once more on the new one: a wedge is the browser's
failure, and a failure that leaves the page healthy still stands. Confirmed
with a simulated wedge — the check's first run failing and the reload after
it throwing — which relaunched, reran and passed.

An eighth, from the perch pass, and it is the expensive kind again: a
tolerance is a place for a bug to live. `stairs carry the player onto a
perch` passed a perch once the feet came within 0.7 m of the deck, which the
last tread always does, so it passed while half of seed 1's perches could
not be stepped onto, and two earlier notes in this file filed the failures it
did show as seed noise. It asks whether you stood on the deck now. The same
check only tried the first eight perches, and the one container stack on the
pinned seed is the tenth — sample everything when everything is a dozen. And
its setup had a trap of its own once the stairs moved: the walk started 4 m
out from the first tread, which on one deck put a streetlight between the
player and the stairs. Start a walk where the thing being walked onto
begins, not where a margin happens to land.

A ninth, from the floors pass, in two halves. "On the street" was written
into setups as a height — `feetY < 0.2`, `groundHeight(...) > 0.2` — and
meant two different things: *on the road* (`__place`, the route check, which
want level ground at both ends) and *on the ground rather than on a prop*
(the ledge, wall and pull-up setups). Once the pavement held you up at
0.28 m the second kind started refusing every approach from a pavement. They
read 0.5 m now, which is above every floor and below every prop; the first
kind was left alone, because the road is still what they mean. When a
floor's height changes, grep the suite for both.

The other half is how to tell a bot-run regression from noise, and it is
cheap. Any change that perturbs one runtime draw — here, objective siting
rejecting a different number of candidates — sends every later spawn, wave
composition and pick down another path, and the scripted run diverges
completely: seed 1 went from wave 5 at 185 s with 55 kills to wave 5 at
240 s with 40, because its wave 4 rolled eight marksmen on perches the bot
can neither reach nor often see. Before reading anything into that, put one
extra `Math.random()` at the top of `startRun` on the *unchanged* code and
run the same seeds. On seven seeds it swung 20260101 from wave 5 and 54
kills to wave 4 and 39, and seed 7 from 52 kills to 69 — the same size as
the change being judged. That is the noise floor; a regression has to clear
it. And trace what the bot spent the slow wave on before concluding either
way: the trace is what found a real (if harmless) economy change hiding in
the same diff.

A tenth, from the settling pass, and all four cost an hour between them.
**The suite reads `src/` from disk on every page load**, so editing a file
while a run is going changes the code under the checks still to come: a
run that straddles an edit tests nothing, and one check booted in the few
seconds a half-made edit was on disk and hung until it was killed. Finish
editing, then run, and kill a run before changing the layout under it.
Nor render alongside it: a look script booting a second game on the same
machine pushed one of the suite's boots past the harness's 60 s wait, and
the whole run died eighteen checks in. Four shards started together on this
machine all missed that wait on their very first boot and ran nothing;
two, the second started a minute and a half after the first, ran the
whole suite. And do not edit `tests/run.js` between starting one shard
and the next: each shard reads the file when it starts and deals itself
every other check by index, so one more check in the second shard's copy
shifted which checks it dealt itself, and some were in neither shard —
the layout check among them, which would have failed. Work on a second change in a `git
worktree` (it serves its own `src/`, with `node_modules` symlinked in), and
give a look script its own longer wait for the menu.
**`buildCity`'s helpers are nested `function`s declared after its
`return`**, so they hoist but anything they share does not: a `let`
written beside them is never initialised, and the first call throws.
State a builder shares (`settled`, `heaps`, `floors`) is declared at the
top of `buildCity`, before the first lot is laid. **`tests/probe.js`
serves on a fixed port**, so it cannot run while the suite does (it fails
`EADDRINUSE`); a script that calls `openGame({ seed, port })` from
`tests/harness.js` on a port of its own can. And `pgrep -f`/`pkill -f`
on a pattern such as `tests/run.js` matches the shell running the
command, which kills it (exit 144); select by the process listing
instead (`ps -eo pid,args | grep "node tests/run"`).

An eleventh, from the open-buildings pass: a ceiling turns a ledge into
something else. Two checks sampled every chest-high box as somewhere to
climb or to stand — the ledge check took the window sills of the open
shops, and the car-roof check stood the player on a shop counter, its
crown through the slab, and waited for a scavenger that rightly could not
follow. Both now ask `ceilingAbove` for a body's height of headroom before
calling a box a deck. Anything that samples decks, ledges or standing spots
from the box list has to ask the same.

A twelfth, from the stairs pass: a counter is not a ledge under a 3 m
ceiling. The first version of the stairwell check asked for a counter or a
crate to be climbable in most shops under a roof, found 6 of 13, and the
reason was right there in the readers: a counter tops out at 1.28 m, and
1.28 + 1.9 of headroom is through a ceiling at 3.03, in every shop, stairs
or not. Sample what a body can stand on (`ceilingAbove` again) before
counting a refusal against the reader under test.

Every check reloads the page, and `localStorage` outlives the reload.
The operation check dies at wave 18 to read its debrief, which wrote a best
score of 36,000, and `settings and records survive a reload`, three checks
later, saved 4,321 under it and read back the larger. A check that ends a
run takes its record back out (`ashfall.records`). `--only="a|b"` runs
both in one browser, in suite order, which is how to see a leak like it.

A check that samples "the first N" of a list is a check on the list's
order. `a hostile follows you onto a car roof` took the first eight decks
in `world.boxes`, which after the fountain became sixteen staves were all
the fountain's rim: one place measured eight times, beside the plaza's
barricades. It takes one deck per place now (4 m apart). The same thing
can happen to anything that samples by index.

## Performance

Shadow mapping dominates — roughly 8x the rest of the scene combined. Quality
tiers (`applyQuality`) drop it first; `auto` watches wall-clock FPS for the
whole run and gives back resolution in a fight, a tier between waves, over
any three seconds under 45 (see the invariant).

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

The lighting pass spent about a fifth of it. Measured back to back on seed 1
from the same view, before and after: high went from 1534 to 1834 ms a frame
(+20%), medium from 1468 to 1705 (+16%), low unchanged at 1142 against 1150,
and draw calls on high from 70 to 98. Most of that is two things. The
occlusion is four passes, three of them at half resolution, about +8%. And
the near shadow cascade draws the whole city a second time: its box is 26 m
across, but the city is merged into meshes that span the sector, so nothing
can be culled out of it — 109k more triangles a frame for a map that only
needs the street in front of you. Splitting the merge per city block is the
fix for both that and the main camera, and is the first thing to reach for
if frame rate matters. Low pays nothing for any of it, and `auto` steps down
to medium and then low on its own. (The per-block split has since landed;
see the pixel-cap paragraph below the hardware note.)

All frame-rate figures in this repo's history come from software rendering,
which exaggerates shadow cost. Relative ordering holds; absolutes do not. On
real hardware the extra shadow pass is vertex work a GPU barely notices, and
the half-resolution passes are fractions of a millisecond; software
rendering makes both look expensive.

They also all come from a pixel ratio of 1, because headless Chromium has
one, and nobody playing on a laptop does. High draws at up to 1.75x, which
on a 2x screen is 3.06x the pixels of every figure above, and the passes this
repo has been adding — occlusion, bloom, two soft cascades, the window
tracing — are all paid per pixel. Measured with `devicePixelRatio`
overridden to 2, twelve alerted hostiles on the plaza, seed 1: 2,946 ms a
frame becomes 7,066, with the same 555 draw calls and the same 1 ms of game
step. To measure what a player actually gets, override it the same way
(`Object.defineProperty(window, 'devicePixelRatio', ...)` before
`applyQuality`).

The pixel caps came down for that reason, in the pass after the table
below: high to 1.25 and medium to 1.0. At a forced ratio of 2, seed 1, the
same view, a software frame costs (ms):

| tier @ ratio cap | ms |
| --- | --- |
| high @ 1.75 (old) | 5,968 |
| high @ 1.25 | 3,287 |
| medium @ 1.4 (old) | 3,659 |
| medium @ 1.0 | 1,958 |
| low @ 1.0 | 1,419 |

Frame time tracks pixels almost exactly, and nothing else measured here
moves it that much. The same pass split the city's batches per patch (see
the invariant). On seed 1 at high, from a street, the plaza and the edge of
the sector, that took triangles a frame from 370k to 179-253k and draw calls
from 96 to 177-248; the near cascade takes in 49% of the city's casting
triangles against 99%. Under software rendering the frame time did not move
either way, within noise (2,283 against 2,420-2,445 ms), because there
triangles are nearly free and pixels are not. On a GPU the shadow passes are
vertex work and that is where the triangles came out. Measured before the
split, at ratio 1 on high: switching the near cascade off saved about 15% of
a software frame and all shadows about 28%. `BATCH_LOTS` 1 takes triangles
lower again (135-175k) for 240-372 calls; 2 is the middle of that trade.

What the frame costs on the CPU side, the same twelve hostiles across the
last five passes (median game step, draw calls, median time to *issue* the
frame — what three spends in JS before the GPU sees any of it):

| after | step | calls | issue |
| --- | --- | --- | --- |
| lighting + perches (#17) | 0.7 ms | 423 | 4.3 ms |
| windows + stains (#18) | 0.7 ms | 423 | 4.5 ms |
| hands (#19) | 0.8 ms | 421 | 4.0 ms |
| motion (#20) | 1.1 ms | 555 | 4.7-6.8 ms |
| floors | 1.0 ms | 555 | 4.7 ms |

The motion pass is the one step in it: four more meshes a hostile, drawn in
three passes. About 6 ms of CPU a frame leaves room on anything modern, and
the software frame time did not move across any of the five, so when "it
feels laggy" comes back from play the order to look in is pixels first,
then stalls, then calls — which is the order this pass found them in.

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

The floors pass came out of one line from play: more floors of the
buildings should be accessible. Upper floors had sat on the list as
"if play asks for them", and play asked. It is the invariant above: every
stairwell building's laps are floors, the building a concrete frame with
real windows, hostiles following onto a floor as a branch off the stair
walk. Two things worth keeping. Every fix to the hostiles was found by
probing all 32 floors with three archetypes rather than a sample, and
every one was then taken out alone and in pairs over all 32 again, which is
what showed two of the four were redundant. And a check that stages a
hostile has to stage it where the game puts one: the juggernaut's walk back
off a floor passed the check without the fix until it started behind the
shaft.

The pass after that closed the frags at a roof and the stair door, both
in the buildings invariant. The frags were a question, and the answer was
the arm: roofs over about 10 m are out of a hand throw's reach, and two
ways of reaching them anyway were tried and taken back out. The stair door
is a post on the shop floor, and it is what the posts were always for —
the door the player will come out of.

The pass before it took two more off the list: a juggernaut up the stairs and
litter on the shop floors, both in the invariants above. The juggernaut
needed nothing new, only the stoop asked about at the foot of a stair, and
looking for why a stooped one fitted turned up every hostile stooping on
every flight since the stoop landed. The litter is about 1,350 sheets, 600
chips and 3,000 shards on seed 1: 13k triangles on a 404k city, and the
layout and the stream mark after boot unchanged.

The pass after it took three things off the list: a warlord's head
through a shop's ceiling (it stoops), the bare stair shops (furnished), and
a relay that fell back to a beacon without a word (HALCYON says why). The
invariants on the stoop and the furnishing have the measurements. Two
traps from it are worth keeping. Both new behaviours first came out
redundant or wrong against their own checks: the stoop's look-ahead passed
with itself taken out, and the first furnishing count measured walls
rather than furniture. Confirming every part of a change bites is what
found both. And a ranged hostile walking toward a player in a building
takes a post outside the door, so a check that wants one to walk in has
to keep it off the posts (`postAfter = Infinity`).

The operation pass came out of one question from play: who are the
enemies, why are they attacking us, and what are we trying to do? Asked
back, the answers were a recovery operation (Carrow, the Cinder, WREN and
HALCYON), told by a handler on the radio and a briefing card, in three
acts over twelve waves with the convoy as a finale and endless survival
after it, and all four objectives offered: a rooftop relay, sabotage, a
hunt and a rescue. The invariant on the operation has the parts that
bite. Five checks came with it, fifteen breaks between them, each
confirmed to fail: the old schedule (the plan comes out cache and hold),
the acts never announced, DEPLOY skipping the briefing, a convoy that
never completes, a relay on the street, a relay counted from the shop
under it (4 s of progress), no lure (a scavenger out of sight never came
nearer the charge than 12 m), a charge that hurts no hostile, no flee (the
lieutenant walked 26 m *away* from his exit, toward the player), no escort
(12.8 m apart), the holdout counted as a hostile, shootable, never
drained, without the field fallback (6 m in a minute), and never
following. The shootable break first *passed*: the check shot the holdout
the moment it was placed, before anything had brought its rig's matrices
to where it stood, so the round was tested against where it spawned. The
same thing is true of anything a check moves and then raycasts against
without stepping; `updateMatrixWorld(true)` first. Rendering the cast is
what found the holdout wearing the same red lenses as every hostile, which
at any distance reads as one of them; it wears its band's mint now
(`type.eye`). The briefing first clipped its own title in a 620 px window;
it scrolls from its top now (`align-items: safe center`). Nothing is
drawn a frame that was not before while none of the cast is alive.

The tactics-and-armoury pass came straight after the stairs, as the two
smaller things asked for alongside them: hostiles that use the buildings,
and upgrades between waves. Both are invariants above, with the clock fix
that the armoury check found under them. What the hostiles cost the CPU,
measured with the player held in a shop at wave 3 and eleven hostiles
alive, against `main` twice: the game step 0.3 → 0.3-0.4 ms median, 0.7-0.8
→ 0.9-1.0 at the 95th, the worst frame unmoved (6-11 ms either way) — the
throw planner flies a frag through the bounce at most once every 1.5 s a
hostile. Nothing is drawn that was not before, so no frame time.

The stairs pass came after the open buildings, asked for as the next big
jump: stairs and rooftops. Ground floors only had been the open-buildings
pass's answer, and the cost of going up was always the route field, which
is one grid at street level; the answer here is a stairwell with its own
list of points, which the hostiles walk, and a route field built from its
foot while the player is up it. The invariant on decks has the rest, and
the landing fix that came with it. On seed 1: 13 stairwells (7 and 12 on
the other pinned seeds), boxes 1,258 → 2,466 and solids 1,069 → 1,462, a
scavenger up eight flights in 10-15 s and back down in 8-11 s with no
relocations. What it cost, twelve hostiles on seed 1 under software
rendering, interleaved against `main` twice: the game step unmoved (0.2 ms
median, 0.5 at the 95th, twice the boxes — the grid index is why); high
2,872-3,003 → 2,935-3,124 ms a frame, about 3%, triangles 807k → 853k,
calls unchanged at 434; low within noise.

The open-buildings pass came straight after it, asked for in one line:
can we make it so we can enter buildings? Asked back, the answer was
ground floors only, in about a third of the buildings (the invariant on
ceilings has the rest). What it cost, the same twelve hostiles on seed 1,
against `main`: high 2,550 → 2,730 ms a frame (+7% with the hostile bodies
under it, of which this pass is about 2%), triangles 579k → 807k, calls
417 → 434; low 520 → 530 ms. The game step went the other way, 0.45 →
0.2 ms median, because the grid index came with it. Seed 1 lays out 1,258
boxes and 1,069 solids against 771 and 561, in 21 rooms.

The hostile-bodies pass came after the hands, asked for in one line: the
enemy models need more work. Rendered close before touching them, every
hostile was a block robot — a brick torso, a cube head, box fists and block
boots, kit hung on as more boxes. They are swept and worn now (invariant
above). What it cost, twelve alerted hostiles on seed 1 under software
rendering, interleaved against `main`: high 2,540 → 2,680 ms a frame (+6%),
triangles 579k → 766k, calls 417 → 423; low 525 → 535 ms, which is about
noise, triangles 193k → 257k. The spawn stream and the layout are
untouched. The same pass made the runner survive a wedged browser (testing
traps, under "No check may wait for ever").

The instancing pass is the eighteenth, and it was item 1 of the list: a
hostile was about forty draw calls a frame, and a wave was most of the
frame's calls. Every archetype is drawn as one instanced batch a part now
(invariant above), which takes twelve hostiles from 480 calls to 157 on
high — and 12 of those 157 are the contact shadows, which stay one each.
It changes nothing about the layout, the spawn stream or what a bullet can
hit. Under software rendering it changes no frame time either, for the
reason the Performance section gives: there calls are cheap and pixels are
not. The machine this is for is a real GPU with a weak driver, where a
call is CPU time the frame waits on.

The arms and hands were rebuilt after the drops, asked for in one line:
work on the visible parts of the player. Rendered close before touching
them, every finger was the same tube with a ball on the end, the back of
the hand a chamfered brick with a tube for its knuckles, and the forearm a
smooth pale pipe that was the largest thing on screen at the hip. They are
swept now (invariant above). What it cost: each weapon from 14-17k
triangles to 24-28k and two more meshes (the moulded parts and the dial);
one weapon is drawn at a time, in a scene that casts no shadow.

The drops were rebuilt after the fire escapes, asked for in one line:
improve the models for the player drops. Rendered close before touching
them, an ammunition drop was a mustard chest whose two latches read as
holes, a medical drop a white chest with a flat neon cross and a black
block for a handle, and a frag a chamfered prism that read as a canteen —
the three objects the player walks up to and looks down at from a metre.
They are drawn by side view and lathe now (`drops.js`, invariant above):
an M2A1 can with its lot stencilled on both long sides, a moulded case
with the first-aid sign, an M67 with its band, spoon and pin. Three things
went wrong first and only a render showed them: the stencil was painted
and absent, because a chamfered box is unwrapped about its own middle
before its offset and the raised panel over the stencil sampled the tile's
plain edge; then it read backwards on one side of the can, because a
planar unwrap runs the same way on both faces of a slab; and the paint
came out lime, because a fully metallic material reflects the sky through
its base colour — paint is a dielectric, and only the wear shows bare
metal. The drop halos are the gameplay half (invariant above).

The kerb drops landed in the same pass as the drops, and were item 2 of
the list (invariant above, under the floors). They moved props off the
corners they now slope, which is a layout change, re-measured once in the
layout check with the reason: on seeds 7 and 20260101 a handful of prop
colliders and nothing else, on seed 1 one barricade and one streetlight,
and the perches placed round them.

The fire escapes were rebuilt after the reload pass, from one line of
play: they look fine from a distance, but there is no detail and they do
not look right close up. Rendered close before touching them, a landing was
a solid slab, its railing one bar on two posts, its stair a plank tilted
off the end into nothing, nothing held any of it to the wall, and every
landing ran through a pilaster. `fireEscape` in `city.js` builds one the
way one is built now — grated landings in an angle-iron frame on bearers
and braces, railings of posts, rails and baluster infill, stairs of
stringers and treads up through a hatch in the landing above, every flight
climbing the same way, a drop ladder off the lowest — 0.3 m off the face,
clear of the pilasters. Two things are worth keeping. **A cut-out texture
needs mipmaps that keep its coverage** (`keepCoverage` in `textures.js`):
averaged the ordinary way, a grating that is a third iron at full size
keeps none of it two levels down, so the alpha test discards every texel
and a fire escape vanishes from exactly the distance it used to look
right from; each level's alpha is rescaled so the same fraction of it
stands over the cut-off. And it is decoration, so it cost the layout
nothing; seed 1's city gained 12k triangles (352k to 364k) in three new
materials. `a fire escape is open grating near and far, and hangs above
every head` asks every mip level for most of the full size's coverage (0
with ordinary mips) and the lowest piece to clear a head on a car roof
(2.4 m with the ladder dropped a metre).

The reload pass is the nineteenth, and it was item 2 of the list, the
poses the rig made possible: a reload visible from across a street, a
crouch behind cover and a head turned toward a sound. Each turned out to
want a reason to exist, because a pose with nothing driving it is a
puppet. So a reload is real — a hostile's fire stops while it does it,
which is the window it reads as — the crouch is what it does with cover
during one, and the head turn is what gunfire does in the ring past the
alert radius. The invariant above has all of it. The fire escape near a
perch, item 4 of the same list, was closed in the same session; see the
perch invariant.

The guns-and-vehicles pass is the sixteenth, asked for in one line: work
on the vehicle and gun models. Rendered before touching anything, both were
still stacks of boxes — a gun was twenty chamfered prisms with every grip
raked forward, and a wreck was a slab with a dark box on it, half of them
wearing a container's corrugated rust. Both are drawn by their side view
now (invariant above): the four view models, every hostile's weapon, and
the saloon and pickup. What it cost, seed 1, interleaved against the commit
before under software rendering, best of two rounds each: high 1,621 →
1,738 ms a frame (+7%), low 207 → 213 ms, and triangles drawn a frame on
high 240k → 394k — measured with no hostiles in view, so before their guns. The layout fingerprints are
unchanged; every shape is minted inside the `reserve` it always was, and a
wreck still pays the same `spend`. A wreck went from about 750 triangles to
about 4,000 — 8,000 in the first cut, which took the merged city from 228k
to 606k, so the bevels, fillets and wheel were cut back until it did not
read any worse from the street. The view models went from about 9,300 to
13,500-17,000 triangles in the same six to nine meshes.

Two things worth keeping from it. The first render of every new shape was
right in outline and wrong in some detail only a render showed: a stock
with no wrist under it, a pickup whose tail outline doubled back on itself
and stuck 2.6 cm out of its collider, door handles 4 mm past it. And
`every grip rakes back` first sliced the guns by their *vertices*, which on
an extruded grip exist only at its two ends, so it found no grip at all;
it slices facets now, and its two levels sit between the bottom of the
shotgun's butt and the bottom of the shortest grip — the first levels read
the butt as a backstrap and reported a rake of −10.

The rain-and-litter pass is the fifteenth, and it is more of the
fourteenth, asked for by name after the screenshots of that one: what else
says a city has been left. Standing water in the gutters and the dips —
142 puddles on seed 1, each a mirror of the clouded sky with a damp ring —
litter drifted against the kerbs (484 sheets of newsprint, card, white
paper and plastic, one card in four quarters), chips of brick and concrete
along the foot of every wall, and a breeze in the weeds. The invariant
above has the three things that went wrong on the way: a sun glint the
size of a puddle, a damp ring paler than the dry road, and litter hanging
over kerbs. Measured interleaved against the commit before: low 217 →
226 ms, high 1,654 → 1,723 under software rendering, triangles on high
190k → 245k. The layout fingerprints are unchanged.

The weather-and-weeds pass is the fourteenth, and it came from looking at
four frames before touching anything and asking what still read as made.
Three things did. The sky was a bare gradient — clouds now, invariant above.
Nothing grew in a city meant to have been abandoned for years — 6,877 tufts
of weeds on seed 1 now, along every kerb, at the foot of every building and
through the cracks, about 55k triangles in 9 batches. And the asphalt's
potholes were filled ellipses, a row of identical black discs repeating
every 8 m of road; they are ragged polygons with a rim that follows the
pit's own outline and a scatter of kicked-out gravel. The layout is
untouched (all three pinned fingerprints), because everything placed is
placed by `decor`.

The rubble fix came from play, the day after the street pass, as one
line: objects around that you can clip right through, rubble and the like.
An audit of everything drawn at body height with no collider under it found
exactly two things, both in the rubble — the heaps and the leaning slabs —
and nothing else in the sector. That audit sampled each facet at its
centre, and a second one sampling every 30 cm across each facet found two
more it had missed: the fountain's plinth, which you walked through from
the deck, and the top of every leaning slab, whose tiers were cut at their
middle and left up to 0.6 m of a lean's overhang at head height. Looking
at the fountain is what found the props standing in each other, which was
item 1 of the list from the other side — the invariant on settling props
has all of it. The invariant above has the fix and the
check that keeps it. The same report said the frame rate was much improved
from the last one, which is the first word from a real machine since the
low-tier pass.

The street pass is the seventeenth, and it was two things asked for at
once: footsteps for the hostiles, and more on the ground. Both are in the
invariants above. Footsteps were what the sound pass left for next time —
a flanker was silent until it fired. The ground got manhole covers, gully
grates, tactile paving at the crossings, parking bays, double yellow lines
and yellow box junctions; kerb drops at the crossings were left out,
because a dropped kerb is a change to a floor's collider and so to the
layout, and flush paving says "crossing" without it. On seed 1: 53 covers,
198 grates, 60 pads and 544 facets of yellow paint, four new materials,
each one batch. Layout fingerprints unchanged. Measured interleaved against `main`
under software rendering, best of two rounds each: high 1,689 → 1,668 ms
a frame and low 219 → 228 ms, which is noise either way, and triangles on
high 394k → 397k.

The sound pass is the thirteenth, and it was item 4 of the list: you could
not hear which side fire was coming from. The invariant above has it, and
the street pass added the hostiles' footsteps to it.

The climbing pass is the twelfth, and it was item 5 of the list: a car
roof was a place hostiles could not follow you to. It is the invariant
above, and one addition to the rig: a climb pose, one knee up onto the lip,
the other trailing, the upper body leaning over it, riding a hump over the
climb so it is gone by the time the hostile tops out. Rendered mid-climb
from the street to confirm it reads as a haul rather than a lift.

The low-tier pass is the eleventh, and it is the first that had numbers
from the machine that reported the problem, because the readout from the
tenth was there to give them: about 14 fps, auto settled on low, the mouse
captured, and an Intel HD — an old integrated GPU. So the lag was the frame
rate, and the cheapest tier was not cheap. What low still paid for, and
what it pays now, is the invariant above; it went 5.6x cheaper under
software rendering, which scales per-pixel work the way a weak GPU does
more faithfully than it scales anything else. Medium is still about seven
times low's cost, so a machine like that one belongs on low and `auto` will
put it there. If low is still short on it, the next levers are resolution
(`renderScale` already reaches 0.7 in a fight) and a pixel ratio below 1
for low, then the facade texture size.

The lag pass is the tenth, and it came from play the day the ninth merged:
no black boxes on a second machine, but the game still slow and laggy —
the mouse not as quick as it once was, and the same for moving. Two
machines, neither visible from here, so it starts by ruling things out.

The CPU is not it. Twelve hostiles of a real fight on seed 1: the game step
is 0.5 ms a frame (0.9 at the 95th percentile), the HUD nothing, and the
frame allocates 191 KB, almost all of it inside three's renderer — a minor
collection every second or so, not a stutter. Mouse look is applied raw
the frame it arrives, as it always was, and the sensitivity constant has
not changed since the first commit. What is left is the GPU frame rate,
which is what every realism pass has been spending, and two things in the
game that made a short frame rate feel worse than it was. `auto` held to
45 fps, so a machine at 46 played the whole run there; it is 55 now, a fight
short of it gives up a tier once resolution is spent, and the starting tier
needs a third of headroom (invariant above). And under 20 fps the game ran
in slow motion — which is exactly "moving the player is not as quick" — so a
long frame is split into steps now (the game-time invariant).

None of that can be confirmed on the machines that reported it, so the
other half of the pass is the readout (`src/perf.js`, the key left of 1):
frames a second, frame time and the worst, CPU time, tier and resolution,
draw calls, whether the mouse is captured, and the GPU's name, which also
catches a browser drawing without the graphics card and says so on the
menu. The next report should carry those numbers. If it shows a GPU
holding 55+ and the lag is still there, the remaining suspect is latency
rather than frame rate — frames queued behind a busy GPU — and the
experiment is to keep one frame in flight (a fence per frame, skipping a
frame's submit while the last is unsignalled). Two things the readout will
settle that nothing here can: whether the mouse is ever left steering
rather than captured, which feels exactly like lag, and whether the
browser is on the integrated GPU of a two-GPU laptop.

Four checks, each confirmed to fail against what it guards: `a slow frame
is still real time, and the mouse moves once` (0.5 s of game time a second
with the clamp back), `the frame-rate readout shows on a key, and names the
GPU` (nothing shown with the key unbound), and the two `auto` checks, both
made stricter (above).

The frame-rate pass is the ninth, and it came from play as two sentences:
performance is still bad, and black boxes blink in a rough vertical line
round the gun while the view turns. Nothing about either could be measured
on the machine that said it, so both were measured here at a forced pixel
ratio of 2, which is what a laptop has and headless Chromium does not.

The boxes never appeared — 200 frames swept round the view model, no
non-finite pixel in the scene target, nothing in a sheet of turning frames —
and their shape is the diagnosis: square, blinking, and grouped, which is a
single bad pixel after two blur passes. The post chain now cleans what it
reads (invariant above), and a check proves one pixel of NaN or infinity
stays one pixel. If the report comes back after this, the next step is a
screenshot and the GPU and tier it happened on; the likeliest remaining
source is the view scene's own arithmetic on that GPU, and a probe that
scans `post.sceneTarget()` for non-finite texels on the player's machine
would settle it.

The frame rate was pixels, as the Performance section had predicted: high
drew 1.75x on a 2x screen, three times the pixels of every figure in this
file. The caps are 1.25 and 1.0 now, which in software halves the frame at
high (5,968 to 3,287 ms) and at medium (3,659 to 1,958). `auto` starts on a
tier it has measured rather than on high (invariant above), and the city is
batched per patch so the cascades and the camera can cull (invariant and
Performance). Three checks came with it, each confirmed to fail against what
it guards: `auto starts at the tier this machine can hold`, `a bad pixel
stays one pixel, it does not bloom into a box`, and `the near shadow cascade
draws the street it covers, not the city` (0.49 of the city's casting
triangles; 0.99 with one batch per material put back). Layout and the spawn
stream are untouched. Boot has one more stage, `Measuring this machine`.

The loading pass is the eighth, and it came from play too: a better loading
screen, or something to look at while the world builds. What there was to
look at was the word LOADING, frozen, because boot never let the page draw.
Measured on seed 1 under software rendering, boot was 17 s: 7.0 s painting
the city's textures, 7.6 s compiling and warming shaders (the part real
hardware does in a fraction of that), 1.6 s building the guns, and the rest
small. Boot is staged now (invariant above), and the screen has four things
on it: the stage and a weighted bar, the last few stages ticked off, a field
note — twelve, each a real mechanic, cycling every six seconds — and a
survey of the sector, drawn as a street grid from the constants before
anything is built and filled in with buildings shaded by height, the
perches and the insertion point once the city is laid out. A radar sweep
and a shimmer on the bar are CSS on the compositor, so they keep moving
through the long stages.

When boot ends the progress gives way to DEPLOY and the best-score line in
the same column, and the survey stays, because it is the sector you are
about to drop into. Hiding the panel, the obvious thing, lifted everything
under it by most of its height at the moment the player was reading it.

Boot is no faster; it is 17 s in software and some seconds on real
hardware, and this pass makes those seconds legible rather than shorter.
The way to shorten them is the texture painting, which is pure CPU: painting
the five facade styles in a worker, or caching the painted canvases between
visits, is where the time is.

Two checks, each confirmed to fail: `the loading screen moves, and the menu
does not jump when it is done` (0 frames drawn across 18 stages with the
yields taken out, and DEPLOY gone with the panel hidden) and `every city
material survives the bake` (16 of 27 lost with the UUID key put back — the
bug the staging itself exposed, invariant above).

A trap for anyone looking at it: Playwright cannot photograph boot mid-stage.
`page.screenshot` and `page.evaluate` both wait for the main thread, so a
loop that tries to sample the loading screen gets the menu. The look was
judged by booting, putting the panel back into its busy state and replaying
a few stages by hand — the survey keeps what it drew.

The responsiveness pass is the seventh, and it came from play as one
sentence: the most recent version is starting to feel laggy. Nothing could
be measured on the machine that said it, so it measured the five most recent
versions against one fixed fight and found the CPU side flat (the table in
Performance), the GPU side dominated by pixels the suite had never been
measuring at, and two certain faults: `auto` had stopped looking before the
first hostile arrived, and first contact compiled eight shaders. Both are
invariants above now, each with a check confirmed to fail against the old
code. What it costs: boot to the menu went from 15.5 s to 18 s under
software rendering, over three boots each — the warm-up frame plus the
compiles, which are the same compiles that used to land at first contact.

What it does not do is make a frame cheaper. If a machine is short at the
high tier's resolution floor, the next levers are the ones Performance
already names: split the merged city per block, so the near cascade stops
drawing the whole sector a second time, and instance hostiles per archetype
and part, which is where the motion pass's extra calls went. (Both have
since landed.)

The floors pass is the sixth, and it was item 1 of the list: the
sidewalks were drawn and not stood on. It turned out to be four slabs, not
one — the pavement apron (0.28 m) on every lot, the plaza (0.30), the rubble
lots' slab (0.35) and the ruins' courtyard floor (0.45) — and none was in
`world.boxes` or `world.solids`. Seed 1 has 47 of them: 36 aprons, the plaza,
4 rubble slabs and 6 courtyards. `registerFloors` puts them in both, last
(invariant above). Rendered before and after from the kerb, the difference is
the whole point: before, a hostile on the pavement is cut off at the shin;
after, it has boots and they are on the pavement.

Everything that had been quietly assuming the ground is at y=0 came with it.
The player is reset onto whatever is underfoot (the run starts on the
plaza's 0.30 m slab, not under it); a step up moves the feet at once and
takes the rise out of the eye height for the damp to hand back, so the view
moves 0.044 m in its worst frame onto a kerb against 0.278 m; casings, blast
debris and scorch marks land on the floor under them (`effects.groundAt`,
asked once at spawn, never per frame); a drop floats over the floor where
its hostile fell — but never a roof, because a marksman's drop has always
landed at street level and that is half of what killing one pays; and an
objective is sited on, and measures "street level" from, the floor under it.

`the pavement is a floor you stand on, step onto and shoot` reads the merged
city — every level face low enough to walk onto with room for a body on it,
13,751 m² on seed 1 — and asks the footing what holds each up, then walks a
road onto the pavement and shoots straight down at it. It was confirmed to
fail three ways, breaking one reader at a time: floors never registered
(17,434 m² held up by nothing), in the box list but not the raycast list
(the shot stops at 0), and the step taken all at once (0.278 m in a frame).
The layout check was re-measured once, with the old fingerprints written
into it and reproduced over every box but the floors. Four checks had "on
the street" written as a height in their setups and were corrected — the
ninth testing trap above has both halves of that, including how the
scripted run's swing on seed 1 was shown to be noise.

The motion pass is the fifth, and it started from item 6 of the list — the
hostiles walked on a sine wave — and found something worse underneath:
every hostile faced away from you (invariant above). The rest is the rig.
Each limb is two pieces, so a knee and an elbow can bend; the upper body
hangs off a waist pivot (`parts.upper`) and the head off a neck
(`parts.neck`), so the shoulders can blade into a stance while the head
stays on the target, a run can lean, and a hit can shove the torso back on
a spring the way the bullet was going. The stride advances with distance
covered rather than time, the knee folds through the swing phase, and the
body bobs at twice the stride, lowest with the feet furthest apart. The
weapon kicks on every shot, follows the target's height (a marksman on a
roof aims down), and both hands stay on it by IK. A death buckles the knees
first and then falls away from the shot, arms gone slack. Every hit zone
still carries its zone — the four new lower limbs are `limb` — so a hostile
has 12 shootable meshes against 8, and the kit check now reads the head kit
by name (`parts.headKit`) because it no longer hangs off the group.
`a hostile faces you, and holds its weapon in both hands` fails with the
old turn (-0.94) and with the IK switched off (0.736 m off the weapon).

What it costs: four more meshes a hostile, each drawn in the main pass and
both shadow cascades, so twelve hostiles in view go from 432 draw calls to
576 — and frame time does not move (2,364 against 2,373 ms, then 2,194
against 2,184, on seed 1 under software rendering). Forty-eight calls per
hostile is now the biggest per-object bill in the frame, though, and a
hostile cannot be merged the way the city is, because its parts move. If a
big wave ever costs frame rate, instancing per archetype and part is the
lever: every raider's left shin is the same geometry and material. (It has
since landed, and a hostile is one call more than the empty street.)

The hands pass is the fourth, and it went after the thing on screen in
every frame: the gun floated. Nothing held it, and each weapon was eight to
twenty chamfered boxes with no trigger, port or charging handle. Now two
gloved hands close round each gun's own grips (`hand` in `weapons.js`: each
finger an arc round the grip's cross-section, so one function covers a
pistol grip, a handguard, a vertical foregrip and a pump), with the trigger
finger indexed along the frame and sleeved forearms running out of the
bottom of the frame; and each gun gained the parts that say what it is.
Merged by material, a weapon is 6-9 meshes and about 9,200 triangles,
against 8-20 meshes and 372-856 triangles before (measured on `main`) —
fewer draw calls for every weapon, carrying ten to twenty-five times the
shape. The layout fingerprints are unchanged; the weapons are built inside
`reserve`. The weave is the hostiles' `fatigues` tinted twice
(glove near black, sleeve a worn drab); the first sleeve tint, a mid khaki,
came out mustard under the view scene's warm key light, which is the
`map`-multiplies-`color` lesson from the other side. Reload, sprint and
melee were each rendered mid-pose to confirm no arm passes through the
camera. `the gun in your hands is solid, held, and textured at its declared
scale` replaced the old view-model check: it asks that every weapon carry a
glove and a sleeve, and judges each material's texel density against the
tile it declares (0.84-1.08 measured), where the old one compared a single
median across all parts — which ten thousand finger triangles would have
decided on their own. It fails with the pistol's hands removed and with the
glove's UVs left unscaled (3x). Its old "more than 30 meshes" bar measured
how the gun was stored rather than what it is, and merging made it
meaningless, so it is gone.

The stains pass is the third, and it was the next thing a close look found:
every large stain in every texture was a filled ellipse, so the plaza, the
barriers and the containers were covered in soft polka dots. `mottle` is a
thresholded warped fractal now (invariant above), and the five other places
that painted discs by hand — the containers' rust and dents, oil on the
asphalt, failed stucco, rubbed-off road paint — go through it too. Small
flecks (`splotches`) are clusters of uneven offset blobs rather than one
ellipse each. Layout untouched (378/420/12): painting runs on each texture's
own generator. Boot went 14.8 s → 15.5 s, measured over three boots each.

The windows pass is the second realism pass, and it went after the largest
thing left that read as a picture: the windows. Every building is most of
the frame and every window on it was paint flush with the brick — glass a
grey card, a broken pane a black square with white triangles on it. Now each
opening is traced in the facade's fragment shader (`windows.js`, invariant
above): a 22 cm reveal with its own normals, so the sun lights one jamb and
the lintel soffit stays in shade; glass and boards on the back plane, sampled
from the painted map where the view ray reaches it, so the frame and boards
move with real parallax; and a room behind each broken pane, two and a half
to five metres deep, with a ray toward the sun through the opening so a low
sun lays a patch across the floor. Shards still in a frame are kept, read off
a blurred lookup — thresholding the grainy painted pane directly gave every
shard a jagged edge.

Measured on seed 1, back to back: no change in frame cost that survives
noise (high 1930/1886 ms on, 1888/1930 off), the same 98 calls and 361k
triangles, and the layout untouched (378/420/12), because it is a material
property. `a window is a hole in a wall, and only in a wall` compares frames
with the effect on and off: close to a tall wall 6.3% of the frame changes,
and straight down onto a ruin wall top nothing does. It was confirmed to fail
both ways — with the patch not applied the wall view changes 0%, and with the
horizontal-face gate removed the ruin-top band changes 33%. The second break
first *passed*, because the check compared only the middle 30% of the frame
and that was mostly plain wall between two windows; it compares the full
width of the band the wall top runs across now. The check also renders both
frames from one placement, because stepping between them moved the film
grain, which is noise in exactly the thing being measured.

The perch pass came out of play, as a staircase you climb and then a box
beside it that you fall through. Both readings were right: terrace crates
and lips drawn with no collider, and stair runs ending short of their decks
— the invariant above has both. On seed 1 the audit found 74 faces standing
on a deck that the footing could not see; it finds none now, and all 12
perches can be walked onto against 6 when the check asks properly. Jumping
at any of the five crates on seed 1 lands on top of it; walking into one
stops you at its face. Two checks guard it, both confirmed to fail on the
old builders: the stairs check, made strict (6/12 walked onto), and `what
stands on a perch holds you up`, which reads the merged city — what you
see — and asks the footing about every face on a deck (72 of 72
unsupported). The layout check's numbers were re-measured once for it, with
the before-and-after written into the check. The one neighbour of the bug
it left — a fire escape within a jump of a terrace — was closed later; see
the invariant.

The lighting pass came out of one sentence — make the graphics more
realistic — and out of looking at the frame before touching it. What read
as fake was light, not texture: nothing darkened where an object met the
ground, shadows were six centimetres a texel across the sun and sixteen along
it, the sky was a painted sunset over a sun standing 31 degrees up, distance
had no haze, and the grade pushed saturation past neutral. Four changes, one
for each, and they only work together — contact shading under blocky
shadows still looks wrong:

1. **Screen-space ambient occlusion** (`post.js`), applied before the gun is
   drawn. Invariant above.
2. **One atmosphere** (`atmosphere.js`): a computed sky with a small sun
   whose glare is the bloom's, an environment map rendered from it, and
   height fog that takes the horizon's colour in the direction you look.
   The sun came down to 24 degrees, chosen by sampling every walkable point
   for a line to the sun — 18 left a fifth of the plaza lit. The hemisphere
   and cool fill lights were cut by half, because the sky now carries the
   ambient they used to fake and the shade had gone moonlight blue.
3. **Two shadow cascades** (`shadows.js`), the tight one placed on the
   street in front of the player, both snapped to texels. Invariant above.
4. **A grade below neutral saturation**, warm and cool by a nudge rather than
   a tint.

Two bugs that predated it surfaced on the way, both because the sun sprite
went. The wide bloom blurred at radius 2 with taps placed for radius 1, which
turns anything as bright as the sun into a square grid; it is two passes at
radius 1 now. And the sun sprite had been the first `Sprite` in the page,
which turned out to be load-bearing for the layout — see the invariant.

Three checks guard it, each confirmed to fail against what it guards, six
breaks in all: the occlusion check with the half-res addressing bug put back
(23.8% of flat ground occluded against 0%) and with occlusion switched off;
the cascade check with the sun and cascade swapped and with the lookup never
patched; the atmosphere check with the horizon given no bearing and with the
fog chunk never installed. All three needed their measurement fixed before
they meant anything — the testing note above has the details, and the first
of them passed with the bug restored.

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
The suite runs as four parallel shards (`--shard=i/4`, dealt round-robin),
and the build only after all four pass. It was one job with a twenty-minute
limit until every run from #21 onward was cancelled at exactly twenty
minutes: every check reboots the game, a boot is most of a check under
software rendering, and two passes in a row added boot stages that draw
(the shader warm-up, then the starting-tier timing, which spent five
software frames deciding it could not measure one). **Anything added to
boot is paid once per check**, and the suite prints each check's seconds so
the bill is visible; a boot stage that draws should give up early when the
frames say software.
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
walkable. It was not seed-dependent. It was the stair runs ending short of
their decks, which is every perch on every seed by up to 0.85 m and every
container stack by 1.6 m, and which the check's 0.7 m tolerance hid on the
seeds where it passed. Fixed by the perch pass; see the invariant.

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
numbers below. On seed 1, one perch in six had an unwalkable stair run,
which the check tolerated at its 0.7 threshold and this note called the
seed-dependent failure recorded further down. It was neither; it was every
stair run stopping short of its deck, half the perches on seed 1 once the
check asked properly, and the perch pass fixed it.

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

1. **Tune the operation against play.** The payouts (300-1,500 a wave, in
   `OBJECTIVE_PAY`), the clocks, the lieutenant's pace and the holdout's
   drain are first guesses, and so is whether twelve waves is the right
   length for an operation. Whether a holdout can be walked out at wave 9
   with a wave on the street, and whether anyone reaches the convoy, are
   play questions.
2. **Let a ruin's windows see into the ruin.** A broken pane in a roofless
   shell wall opens onto an invented room 2.6-5 m deep, where the real space
   behind it is the courtyard. Ruin walls share the facade materials. Giving
   the ruins their own copies that `discard` the opening instead would make
   it a real hole, because a box's far faces are back-facing and culled —
   the courtyard would show through. The shadow map would still see a solid
   wall, and so would `hitscan`, which is the bigger question: a hole you can
   see through and not shoot through reads as a bug.
3. **Tune the armoury's prices against play.** The costs (500-4,000
   scrip) are first guesses against about 1,500 points a wave early on.
   Whether a run can afford the plate carrier before wave 4, and whether
   anyone buys optics, is a play question.
4. **Make rubble something a body can climb, or a wall to the route
   field.** Most heap tiers are a 0.6 m step at a body's reach (the rubble
   invariant), so the field leads hostiles and holdouts into heaps they
   stand against. Two ways: register heaps so each tier stands 0.31 m proud
   of the one above where the shape allows, and bake what is left over a
   step as a wall; or bake only the sheerest (96 tiers over 0.9 m on seed
   1). Either has to keep `the route field reaches the whole sector` at
   0.995, and moves every hostile's route, so the scripted run's noise floor
   applies.
5. **A floored building's look.** The concrete frame reads as a building
   you can go into, which is the point, but all 13 are the same grey;
   giving the frame a facade style's colour, or a band of the facade's
   texture between the floors, would keep the skyline varied.

One piece of housekeeping that cannot be done from here: the merged branch
`claude/project-memory` still exists on the remote. Deleting it returns 403
through the agent proxy, and the GitHub tools available here have no
delete-branch call, so it needs a hand on a normal client. Do not spend time
retrying it.
