# ASHFALL

A small browser first-person shooter set in an abandoned city at dusk. Hold a
ruined plaza in Sector 7 against waves of scavengers and raiders with a modern
weapon set.

No build step, no asset files, no network calls — open the page and play.

## Running it

Because the game loads ES modules, it needs to be served over HTTP rather than
opened as a `file://` path:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works. Three.js is vendored in `vendor/`, so the game runs
fully offline.

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

Click the canvas to capture the mouse. Losing pointer lock pauses the game.

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
| Juggernaut | Heavy, 420 HP, suppressing fire (wave 5+) |

They hunt by sight, by proximity and by the sound of your gunfire, steer around
buildings and wrecks, strafe while holding their preferred range, and hold fire
for a beat after spotting you. Health scales ~9% per wave.

Waves grow each round, hostiles trickle in rather than appearing all at once,
and clearing a wave awards a score bonus plus an ammo resupply. Kills sometimes
drop ammo crates, medkits and frags. Health regenerates five seconds after you
stop taking fire. Your best wave and score are kept between sessions.

## How it is put together

```
index.html          page shell, HUD markup, import map
src/main.js         game loop, scene/lighting setup, waves, hit resolution
src/city.js         procedural city generation
src/world.js        AABB collision, line-of-sight, bounds
src/player.js       input, movement, camera, health
src/weapons.js      weapon definitions, view models, firing and recoil
src/enemies.js      hostile archetypes, AI, procedural bodies
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
- **Settings and records persist** in `localStorage` — sensitivity, FOV,
  volume, invert-look and mute, plus your best wave and score.
