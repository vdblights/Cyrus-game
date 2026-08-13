# ASHFALL

A small browser first-person shooter set in an abandoned city at dusk. Hold a
ruined plaza in Sector 7 against waves of scavengers and raiders with a modern
weapon set.

No build step, no asset files, no network calls — open the page and play.

## Running it

```bash
npm start          # serves the repo at http://localhost:8000
```

`npm start` needs no dependencies — it runs a small static server from
`tests/serve.js`. Any static server works just as well; the game only needs
HTTP rather than a `file://` path, because it loads ES modules. Three.js is
vendored in `vendor/`, so it runs fully offline.

Add `?seed=12345` to the URL to replay an exact city; the seed for the current
one is printed under the menu.

### One-file build

```bash
npm run build      # writes dist/ashfall.html
```

That inlines the markup, CSS, all modules and Three.js into a single ~620 KB
HTML file with no external references. It runs straight from a `file://` path
or from anywhere that can host one static file — useful for sharing a playable
copy without the repo.

## Testing

```bash
npm install        # playwright + esbuild, only needed for tests and builds
npx playwright install chromium
npm test           # 16 checks, headless
```

The suite drives the real game in a headless browser through `window.__game`,
stepping the loop at a fixed timestep instead of waiting on frames — a
four-minute simulated run finishes in seconds and does not depend on render
speed, which matters because software WebGL renders at a couple of frames a
second.

| Flag | Effect |
| --- | --- |
| `--seed=N` | Replay an exact city (default is pinned, so runs are repeatable) |
| `--headed` | Watch it play |
| `--shots` | Also write screenshots to `tests/shots/` |

It covers boot and city generation, hit registration and headshots, melee
reach, grenade flight and blast falloff, cook-offs, stair climbing, fall
damage, marksman perching and laser tracking, warlord spawns, the objective
schedule and its payouts, objective decay and expiry, waypoint projection,
aiming without pointer lock, settings and record persistence, and a
four-minute scripted run that must reach wave 3 with hostiles still able to
engage.

Three things make it trustworthy rather than merely green: the random stream
is seeded, every check reloads the page so none of them inherit another's
state, and the render loop is stopped during checks — otherwise it steps the
game on real frame timing underneath the test and results stop repeating.

### Asking the game questions

When something looks wrong, measure it rather than guessing:

```bash
node tests/probe.js world                       # city stats for this seed
node tests/probe.js enemies                     # every hostile's AI state
node tests/probe.js objectives                  # where each objective lands
node tests/probe.js shot                        # what a bullet actually hits
node tests/probe.js perches                     # height profiles through each perch
node tests/probe.js --seed=777 "g.startRun(); __step(45); return __enemies()"
node tests/probe.js --list                      # the canned ones
```

It boots the game seeded and frozen, evaluates the expression inside it, and
prints JSON. In scope: `g` (the whole game), `__step(seconds)`, `__enemies()`,
`__profile(x, z, axis)`, `__place(range)`. `--file=path.js` runs a longer
probe from disk.

Every bug in this project has been found by looking at real state, and each
time the first move was writing a throwaway script to get at it. This is that
script, kept. It found a latent one within a minute of existing: hostiles
spawned before the first wave got `NaN` health, because the per-wave health
scale had no initial value.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint (drops when you fire or aim) |
| `Ctrl` / `C` | Crouch — tighter spread |
| `Space` | Jump |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `R` | Reload |
| `1`–`4`, `Q`, mouse wheel | Switch weapons |
| `G` | Frag grenade — **hold to cook**, release to throw |
| `F` / `V` | Melee bash |
| `M` | Mute |
| `Esc` | Pause |

Click the canvas to capture the mouse — with pointer lock held, the cursor
physically cannot leave the window, and losing it pauses the game.

Some contexts refuse pointer lock, most commonly a cross-origin `<iframe>`
without `allow="pointer-lock"`. The game detects that and switches to cursor
steering: the pointer's offset from the centre of the screen becomes a turn
rate, with a dead zone in the middle. That keeps working at the very edge of
the window and stops cleanly if the cursor leaves it, where raw mouse deltas
would simply die. A banner says which mode you are in, and offers to open the
page in its own tab, where capture works.

## Weapons

| Slot | Weapon | Behaviour |
| --- | --- | --- |
| 1 | M9 sidearm | Semi-auto, high headshot multiplier, always available |
| 2 | MP5K SMG | 880 rpm, wide spread, best inside a room |
| 3 | M4A1 carbine | Recovered on wave 2 — the reliable mid-range answer |
| 4 | M1014 breacher | Recovered on wave 3 — nine pellets, heavy damage falloff |

Every weapon has its own recoil pattern, spread (which tightens when you aim or
crouch and opens when you move), reload timing and ADS zoom. Headshots do
extra damage and are called out in the killfeed; limb hits do less.

You also carry **frags** (three to start, five max, dropped by kills). The fuse
starts the moment you pull the pin, not when the grenade lands — hold `G` to
cook one so it airbursts on arrival, and watch the fuse bar, because holding it
too long detonates it in your hand. Grenades arc, bounce off walls and wrecks,
and roll to a stop; damage falls off with distance and is cut sharply for
anything hiding behind cover.

The **melee bash** interrupts whatever you are doing — including a reload —
and knocks a target back. That is the point: it is the answer to something
already inside your guard.

## Hostiles

| Type | Behaviour |
| --- | --- |
| Scavenger | Fast melee rusher, closes to contact |
| Raider | Rifleman, holds ~13 m and fires in bursts |
| Breaker | Shotgunner, pushes to close range (wave 3+) |
| Marksman | Takes high ground and hits for 26 (wave 4+) |
| Juggernaut | Heavy, 420 HP, suppressing fire (wave 5+) |
| Warlord | Elite juggernaut that closes out every fifth wave |

A marksman claims a rooftop or terrace and stays there while it can see you.
Before each shot it paints you with an aiming laser for about a second — that
red line is your warning to break line of sight. Warlords are outsized, carry
roughly 1100 HP, wear a gold band, and get their own health bar at the top of
the screen.

They hunt by sight, by proximity and by the sound of your gunfire, steer around
buildings and wrecks, strafe while holding their preferred range, and hold fire
for a beat after spotting you. Health scales ~9% per wave.

Waves grow each round, hostiles trickle in rather than appearing all at once,
and clearing a wave awards a score bonus plus an ammo resupply. Kills sometimes
drop ammo crates, medkits and frags. Health regenerates five seconds after you
stop taking fire. Your best wave and score are kept between sessions.

## Objectives

Wave survival on its own rewards standing still in the best cover you can
find, and the other 200 m of city may as well not exist. So most waves put
something worth having at the far end of it and start a clock.

| Objective | Where | What it asks | What it pays |
| --- | --- | --- | --- |
| Supply cache | 40&ndash;80 m out | Stand on it for 4 s | Ammo, frags, 300 &times; wave |
| Beacon | 40&ndash;75 m out | Hold a 6.5 m circle for 18 s | Ammo, 35 health, 500 &times; wave |
| Evac point | 55&ndash;105 m out | Reach it before the window shuts | Full heal, full rearm, 750 &times; wave |

One runs at a time. Wave 1 is left clean, every third wave calls for a beacon
and the rest call for a cache; an evac window opens instead when a warlord
goes down. Progress bleeds back if you are driven off rather than resetting,
so being pushed out costs ground without wiping the job, and a beacon
transmits &mdash; working one pulls hostiles in from 55 m while you stand there.

Finding the site is most of the problem, because one ruined block looks much
like the next. A light column marks it, occluded by whatever is in front of
it so it reads as a bearing over the rooftops rather than a decal; a waypoint
tracks it on screen and pins to the edge when it is behind you; the radar
holds it at the rim when it is past the sweep.

The payouts sit above a wave-clear bonus on purpose. Crossing the sector
under fire should beat holding the plaza &mdash; otherwise there is no reason
to leave, which was the problem to begin with.

## Looks

Dusk, and the light is doing the work. A single warm key sits low in the
west with a cool sky fill opposite it, so a wall tells you which way it faces
before you read anything else on it. The sun is a sprite placed at the light's
own direction rather than painted into the sky, so it can never drift away
from the shadows it casts. Fog is tinted to the sky's horizon, which drains
colour out of distance.

Surfaces carry a normal map derived from their own texture — the painted
window reveals, mortar lines and pitted concrete become relief that catches
the key light instead of reading as a decal. Facades are built with broken,
boarded and intact windows, grime bleeding from every sill, and scorch licking
up from the blown ones. Tall blocks step back near the top, which is most of
what gives a skyline its shape.

Hostiles carry a contact shadow under them, because the sun's shadow map only
covers the ground near the player and anything beyond it would otherwise
float.

### Graphics settings

Shadow mapping costs more than everything else in the scene put together, so
it is the first thing the quality tiers drop:

| Tier | Shadows | Normal maps | Pixel ratio | Dust |
| --- | --- | --- | --- | --- |
| High | 2048, soft | yes | up to 1.75 | yes |
| Medium | 1024, hard | yes | up to 1.4 | yes |
| Low | off | no | 1.0 | no |

The default is **Auto**: it watches the first few seconds of a run and steps
down a tier if the frame rate is under 40, telling you when it does. Picking a
tier yourself in the pause menu turns that off — an explicit choice is never
overridden.

## Vertical ground

The city is not flat. Raised terraces of collapsed floor and stacked shipping
containers are scattered through the blocks, each reachable by a stair run of
half-metre steps — low enough that you simply walk up them, no jumping. Take
the high ground and the ground-level hostiles lose their shot at you; step to
the edge and you get yours.

The same rules apply to everyone: hostiles climb, stand on, and fall off the
same surfaces, and a melee rusher cannot reach you across a height gap. Drops
of more than about four metres hurt, and a long enough fall will kill you.

## How it is put together

```
index.html          page shell, HUD markup, import map
src/main.js         game loop, scene/lighting setup, waves, hit resolution
src/city.js         procedural city generation
src/world.js        AABB collision, ground height, line-of-sight, bounds
src/player.js       input, movement, camera, health
src/weapons.js      weapon definitions, view models, firing and recoil
src/enemies.js      hostile archetypes, AI, procedural bodies
src/objectives.js   objective sites, channels, markers and waypoints
src/grenades.js     thrown frags: fuse, bounce physics, detonation
src/effects.js      pooled tracers, impacts, blood, casings, explosions
src/textures.js     canvas-painted textures (asphalt, facades, rust, sky)
src/audio.js        synthesised gunfire and feedback via Web Audio
src/hud.js          HUD readouts, killfeed, radar, damage indicators
vendor/             Three.js r169 build
```

A few notes on the implementation:

- **Nothing is loaded from disk or network.** Every texture is painted into a
  canvas at boot, every sound is synthesised from noise bursts and oscillator
  envelopes, and every model is assembled from boxes and cylinders.
- **Normal maps are generated, not authored.** A Sobel pass over each
  texture's own luminance becomes its normal map, so painted detail lights
  like geometry without shipping a second set of images.
- **The city is generated per session.** A 6×6 grid of lots is filled with
  towers, gutted low ruins and rubble lots, then dressed with wrecked cars,
  shipping containers, barricades, streetlights and burning barrels.
- **Collision is AABB-based.** Everything solid registers a box; entities are
  cylinders pushed out along the shallowest axis. Line of sight uses a slab
  test against the same boxes, so shots can pass over low cover.
- **The view model renders in its own scene** over the world with a cleared
  depth buffer, so the weapon never clips into geometry.
- **Combat effects are pooled** — tracers, sprites, bullet holes and casings
  are recycled, so firefights allocate nothing.
- **Hostiles have a stuck watchdog.** If one stops closing on the player and
  is not deliberately holding its range, it is quietly re-inserted elsewhere
  so a wave can never stall.
- **Grenades use a sphere-vs-AABB solver** that resolves along the shallowest
  of the three axes, distinguishing a bounce from resting contact so a frag
  rolls to a halt instead of stopping dead where it lands.
- **Camera trauma is squared before use**, so a distant blast is a nudge and a
  close one throws your aim off.
- **Verticality is derived from the same box list.** `groundHeight()` reports
  the highest surface under an entity below its step ceiling, so walking up
  stairs, standing on a terrace and falling off a ledge all fall out of one
  query — no separate navmesh or heightfield.
- **Climbable structures are validated before they are built.** Both the
  platform footprint and the whole stair corridor must be clear ground, or the
  structure is not placed; a buried staircase is an unclimbable one.
- **Settings and records persist** in `localStorage` — sensitivity, FOV,
  volume, invert-look and mute, plus your best wave and score.
