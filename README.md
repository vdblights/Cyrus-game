# ASHFALL

[![CI](https://github.com/vdblights/Cyrus-game/actions/workflows/ci.yml/badge.svg)](https://github.com/vdblights/Cyrus-game/actions/workflows/ci.yml)

A small browser first-person shooter set in an abandoned city at dusk.
Operation ASHFALL: twelve waves in the ruins of Carrow, then as long as you
can last.

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

The world is built in the browser on every load — every texture is painted,
the city laid out and the shaders compiled — which takes a few seconds. The
loading screen says which part it is on, with a field note to read, and
draws a survey of the sector as it goes: the street grid first, then the
buildings and the rooftops a marksman can take once the city is laid out,
and where you go in. The survey stays beside DEPLOY afterwards, so you can
see the sector before you drop into it.

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
npm test           # the whole suite, headless
```

The suite drives the real game in a headless browser through `window.__game`,
stepping the loop at a fixed timestep instead of waiting on frames — a
four-minute simulated run finishes in seconds and does not depend on render
speed, which matters because software WebGL renders at a couple of frames a
second.

| Flag | Effect |
| --- | --- |
| `--seed=N` | Replay an exact city (default is pinned, so runs are repeatable) |
| `--only=text` | Run only the checks whose name contains `text` |
| `--shard=i/n` | Run every nth check starting at the ith — CI runs four shards side by side |
| `--headed` | Watch it play |
| `--shots` | Also write screenshots to `tests/shots/` |

It covers boot and city generation, hit registration and headshots, melee
reach, grenade flight and blast falloff, cook-offs, stair climbing, mantling
onto ledges (and not onto walls), fall damage, marksman perching and laser
tracking, warlord spawns, the objective schedule and its payouts, objective
decay and expiry, waypoint projection, the texel density of every baked
surface, the lane paint lying on the carriageway and facing the sky, the
ambient darkening baked under the city, the view model being solid and
unwrapped at its own scale, the route field covering the whole
sector, a hostile walking around a building rather than into it, a turned prop
stopping you where you can see it, the ground you stand on being the ground
you can see, the best-score line sitting clear of the deploy button, ambient
occlusion darkening contact and leaving open ground alone, the sun reading
its near shadow map in the right light order, the sky and fog agreeing about
where the sun is, aiming
without pointer lock, settings and record persistence, every archetype being
kitted and keeping its hit zones, nothing in the city or on a hostile being
wound inside out, three seeds laying out exactly the cities they laid out
before, and a four-minute scripted run that must reach wave 3 with hostiles
still able to engage.

Three things make it trustworthy rather than merely green: the random stream
is seeded, every check reloads the page so none of them inherit another's
state, and the render loop is stopped during checks — otherwise it steps the
game on real frame timing underneath the test and results stop repeating.

### On every push

GitHub Actions runs the same suite, plus the one-file build, on every push to
`main` and every pull request. The built `ashfall.html` is attached to the run
as an artifact, so a change can be played from the Actions tab without checking
the branch out.

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
| `Space` | Jump — held against a ledge, mantle onto it (~1.8 m from the ground, ~2.6 m off a jump) |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `R` | Reload |
| `1`–`4`, `Q`, mouse wheel | Switch weapons |
| `G` | Frag grenade — **hold to cook**, release to throw |
| `F` / `V` | Melee bash |
| `B` | Armoury — between waves, with the sector clear |
| `M` | Mute |
| `` ` `` | Frame-rate readout |
| `Esc` | Pause |

Click the canvas to capture the mouse — with pointer lock held, the cursor
physically cannot leave the window, and losing it pauses the game. The
clock stops while paused, so nothing — an objective, the gap before the
next wave — runs out behind the pause screen.

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

An empty magazine reloads when you pull the trigger. A weapon with an empty
reserve behind it has nothing left to reload from, so the trigger reaches for
the next weapon that can still shoot instead of clicking at nothing.

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

About one building in three has a ground floor you can walk into — the ones
with a concrete ground storey and a shopfront of piers, rust shutters and
windows over a sill. Inside is a dim shop under the floors above: columns,
aisles of shelving, a counter, tables, crates. It is cover from a marksman on a
roof, whose sight line the floors cut, and a fight at close range through
doorways and windows; a jump indoors stops at the ceiling, and so does a
grenade. Hostiles follow you in, a warlord stooping under the ceiling to do it.

Most of the lower ones go further: a stairwell in a back corner of the shop,
switchback flights of concrete steps climbing lap over lap to a bulkhead on
the roof, and the roof itself somewhere to stand. A waist-high parapet runs
round it on the street sides — cover from the street, and a shot down into
it — and a party wall too tall to jump stands where the building next door
is a metre away. A couple of plant boxes give cover from the other roofs.
Hostiles follow you up: while you are on a roof or in its stairwell, the
route field is built from the stair's door, every hostile that can fit under
the flights walks there and climbs after you, and they come back down the
same way when you leave. A ranged hostile with a clear shot at the roof from
the street takes it instead, and one on the roof with a shot down holds it.
Juggernauts are too tall for the stairs and wait below.

They use the buildings against you, too. Go into a shop and up to two of the
riflemen take posts outside, each with a sight line into a doorway, and hold
them while the rest come in after you — so the door you leave by is covered.
A hostile that has lost sight of you, or knows you are inside, throws a frag:
from the second wave on, a raider, a breaker or a juggernaut carries one, and
it only lets go of a throw it has flown first through the same bounce the
grenade will take, so what you hear land is in the room with you. One frag in
the air at a time, a call when it is thrown and a `GRENADE` warning when it
lands near you — move. And your reload is their window, the way theirs is
yours: change magazines or weapons with hostiles within 25 m and they stop
holding, give up their posts and come for you, faster, until a second after
you are ready again. The first one shouts.

Hostiles route around buildings rather than walking into them: a coarse
walkable grid over the city carries a cost field rebuilt from wherever you are
standing, so one that loses sight of you takes the way round the block, or in
through the doorway of a shop you are hiding in, instead of sliding along the
wall between you. With a clear view it comes straight at you, as it always
did.

A marksman claims a rooftop or terrace and stays there while it can see you.
Before each shot it paints you with an aiming laser for about a second — that
red line is your warning to break line of sight. Warlords are outsized, carry
roughly 1100 HP, wear a gold band, and get their own health bar at the top of
the screen.

They hunt by sight, by proximity and by the sound of your gunfire, steer around
buildings and wrecks, strafe while holding their preferred range, and hold fire
for a beat after spotting you. Health scales ~9% per wave.

Each archetype wears its own kit — plate and pauldrons, a carrier and pouches,
scrap strapped on one side, a hood and a long coat — so you can tell what is
walking toward you before the marker band is legible.

Waves grow each round, hostiles trickle in rather than appearing all at once,
and clearing a wave awards a score bonus plus an ammo resupply. Kills sometimes
drop an olive ammunition can with its lot stencilled on the side, a moulded
medical case with the first-aid sign on it, or a frag, each over a soft halo
in its own colour — amber, green, red — so you can find one across a street
at dusk. Health regenerates five seconds after you stop taking fire. Your best wave and score are kept between sessions.

## The armoury

When a wave is cleared, `B` opens the armoury for the intermission, which
waits while you shop. It sells:

| Item | Tiers | What it does |
| --- | --- | --- |
| Plate carrier | 3 | 15%, 28%, 40% off every hit you take |
| Extended magazines | 2 | A quarter more in every magazine, then half as much again |
| Optics | 2 | Tighter aimed fire and a closer sight picture |
| Match ammunition | 2 | 12%, then 25% more damage from every weapon |
| Frag pouch | 2 | One more grenade carried each, and the pouch filled |
| Resupply | — | Every weapon to full ammunition, and two frags |
| Field dressing | — | Back to full health |

It is paid for in scrip, which every point you score earns and which shows
under your score. Spending it costs no score, so buying armour is never a
choice between surviving and your best score. What you fit lasts the run.

## The operation

Eleven weeks ago the Halloran refinery burned for nine days and buried the
city of Carrow in ash. The city was evacuated, and not everyone got out. The
Cinder stayed: looters at first, now a militia of a few hundred under
warlords, holding the city street by street and anyone left in it. That is
who is coming at you, and why. They hold Sector 7 and you are in it.

You are WREN, a recovery contractor. HALCYON is your handler, and the only
voice on your radio. The job: bring the district's dead relays back so the
survivors still holding out in there can be found, get them out, and hold the
depot when the convoy comes for the last of them.

DEPLOY opens the briefing; REDEPLOY after a death goes straight back in. A
run is three acts over twelve waves, each wave bringing the objective the
operation's plan gives it, and HALCYON calls each act, each wave and each
objective over the radio in the bottom left:

| Act | Waves | What it is about |
| --- | --- | --- |
| I &middot; Dead Air | 1&ndash;4 | The first relay, a stockpile, a fuel dump |
| II &middot; Holdouts | 5&ndash;8 | A warlord, the first survivors, a lieutenant with the routes |
| III &middot; The Convoy | 9&ndash;12 | More survivors, another dump, then the depot |

Wave 12 brings the convoy: hold the depot while it loads, and the operation
is complete. If it cannot hold, it comes again the next wave until it is out.
After that the city does not stop, and the objectives keep coming in turn.
When you go down, the debrief says how far the operation got and what you
did for it.

## Objectives

Wave survival on its own rewards standing still in the best cover you can
find, and the other 200 m of city may as well not exist. So most waves put
something worth having at the far end of it and start a clock.

| Objective | Where | What it asks | What it pays |
| --- | --- | --- | --- |
| Supply cache | 40&ndash;80 m out | Stand on it for 4 s | Ammo, frags, 300 &times; wave |
| Beacon | 40&ndash;75 m out | Hold a 6.5 m circle for 18 s | Ammo, 35 health, 500 &times; wave |
| Relay mast | On a roof, 25&ndash;120 m out | Find the stairwell, hold the mast for 20 s | Ammo, 25 health, 600 &times; wave |
| Fuel dump | A burning drum, 30&ndash;90 m out | Plant a charge (3.5 s), keep them off it for 18 s | Ammo, a frag, 600 &times; wave |
| Lieutenant | Crossing the sector | Kill him before he reaches the far edge | Ammo, two frags, 700 &times; wave |
| Holdout | In a shop, 30&ndash;95 m out | Cut them loose (2.5 s), walk them to a pickup | Ammo, 50 health, 800 &times; wave |
| Depot | 45&ndash;95 m out, wave 12 | Hold a 7 m circle for 40 s | Full heal, full rearm, 1,500 &times; wave |
| Evac point | 55&ndash;105 m out | Reach it before the window shuts | Full heal, full rearm, 750 &times; wave |

One runs at a time. Wave 1 is left clean so the first contact is about
learning to shoot; an evac window opens instead when a warlord goes down.
The newer four each ask something different of you:

- **A relay** is up a stairwell on a roof, and only counts from the roof.
  Where no stairwell is in reach, HALCYON sends you to a beacon instead and
  says so.
  Holding it brings the sector up the stairs after you.
- **A charge**, once planted, draws every hostile that cannot see you to the
  drum. One that reaches it while you are more than 6 m off pulls it. When
  it blows it is your blast, so stand off and let it take whoever is near.
- **A lieutenant** walks his own route to the edge of the sector with three
  escorts beside him, and shoots at you on the way without stopping. Get
  there first.
- **A holdout** follows you once cut loose, by the same routes the hostiles
  use. They are not a target and your rounds pass them, but anything near
  wears them down, and a blast hurts them like anyone else.

Progress bleeds back if you are driven off rather than resetting,
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

Every texture declares how many metres of world one copy of it covers, and
the geometry is unwrapped to match, so nothing in the city is stretched or
crammed. A facade tile is 10 m: four window bays and three floors, which puts
a window at about a metre and a half and a floor at three and a third. Wall
UVs are snapped to those, so a window is never cut in half at a corner and
the floor lines meet the ground and the roof square.

One thing refuses to live in a texture at all, and that is the paint on the
road. A tile repeats, and a centre line painted into the asphalt comes out as
a grid of stripes over the whole sector — across the sidewalks, across the
lots, everywhere except down a street — because the one thing a marking needs
is the one thing a tiled image cannot have, which is a position. So the shape
of every marking is geometry, laid off the same grid the lots are: a centre
line down each street, dashed or solid, edge lines inside both kerbs, zebra
crossings on the junction approaches with a stop bar behind each one and an
arrow in the lane that gives way. The texture underneath carries only how
worn the paint is — chalked edges, tyre scuffs, stretches rubbed back to the
aggregate — and roughly one marking in six is missing outright, which is what
a decade without maintenance looks like. Some kerbs carry parking bays or
double yellow lines instead of an edge line, and a few junctions are yellow
boxes, hatched corner to corner. Set into the road are cast-iron manhole
covers and gully grates in the gutter. At each end of every zebra the kerb
is dropped to a lip over the road, the pavement ramping down to it with
flared sides, and the ramp is laid with buff blister paving; where both
streets at a corner are crossed, the two ramps meet in a dish and the paving
turns the corner. Every piece of ironwork asks the ground under each of its
corners and is only laid where they agree, so nothing hangs off a kerb. It costs the layout nothing: like the rest of the
decorative pass it draws from its own generator, so a seed lays out exactly
the city it did before.

A window is a hole in the wall, not a picture of one. The facade's own
shader knows where every opening is — the same four-by-three grid the walls
are snapped to — and traces each one: a reveal a quarter of a metre deep that
catches the sun on one side and shades the glass on the other, intact glass
set back in it mirroring the sky, boards nailed across the back of the
opening, and behind a blown-out pane a room — floor, ceiling, walls — dim and
darker the further in, with a low sun laying a patch of light across the
floor. It is all parallax in the material, so it moves the way a recess moves
as you walk past, and none of it is geometry: it costs no draw calls, no
triangles and nothing on the seeded stream, and a bullet still stops at the
wall face.

Surfaces carry a normal map derived from their own texture — the painted
mortar lines and pitted concrete become relief that catches
the key light instead of reading as a decal. They carry a roughness map from
the same luminance, so soot and grime answer the light flatly while glass and
bare metal stay sharp enough to reflect. Facades are built with broken,
boarded and intact windows, sills and lintels, grime bleeding from every sill,
scorch licking up from the blown ones, bullet pocks and the odd shell crater
with reinforcing bar still standing in it. Each of the five wall materials —
precast panel, brick, curtain wall, render and stone — is painted in several
variants, scrap steel comes in four paints failing to the same oxide, and
every building is given a colour drift and a tile offset of its own, so two
neighbours never read as the same prefab. Tall blocks step back
near the top, which is most of what gives a skyline its shape.

Weathering is fractal rather than drawn. Every stain, wash and bloom of rust
is a warped noise field thresholded to a ragged edge, uneven inside and
present at every size at once, because the soft round blotches it replaced
read as polka dots on every surface they covered. It wraps at the tile edge
like everything else, so the eye has no seam to find.

Where surfaces meet, the light does not reach, and a shadow map will not tell
you that. Every solid in the city deposits into a coarse occlusion grid, and
the ground reads it back as vertex colour when the city is merged — so the
gutter beside a wall, the inside of a corner and the strip under a wreck all
darken, and walls fade toward their own footing. It is baked once, costs
nothing per frame, and is most of what stops a city of right angles looking
like a city of boxes.

The sky, the sun and the air between them are one model, so they agree about
what time it is. The sun stands 24 degrees up at the long end of the
afternoon; the sky is computed rather than painted — blue overhead, a warm
horizon on the sun's side and a cool one opposite, a bright haze around the
sun from forward scattering, and a small, very bright disc whose glare is
the bloom's doing. The same function is rendered into an environment map
that lights every surface, so a wall turned to the sun is warm and a wall
turned away is lit by blue sky. And the air is not one flat colour: dust
hangs thicker at street level than at roof height, and it takes the colour
of the horizon in whichever direction you look — warm toward the sun, grey
away from it — so a building far down a street fades into exactly the sky
behind it.

Where things meet, they darken. A screen-space ambient occlusion pass works
out, for every pixel, how much of the sky above it is blocked by something
within a metre: the foot of a barrier, the gap under a car, an inside
corner, a hostile's boots. Contact shading is the first thing the eye uses
to decide whether an object is standing on the ground or pasted over it.

The sun casts two shadow maps, not one. A wide map covers the sector, and a
tight one — about a centimetre a texel — covers the street in front of you,
where you are actually looking, blended into the wide one at its edge. Both
are snapped to whole texels, so shadow edges hold still while you walk
instead of crawling along the walls.

The frame is then finished rather than shown raw. It is drawn into a floating
point buffer, everything brighter than white is blurred into a bloom (the sun,
the barrel fires, a muzzle flash), and one final pass tone-maps, grades the
image a little *less* saturated than life — dust takes colour out of
everything — vignettes, and lays a fine grain over the top.

Nothing in the sector is a plain box any more, and that is mostly about
shape rather than pixels. A wrecked car is drawn the way a car designer draws
one, by its side view: one outline with the wheel arches bitten out of it, a
nose that drops to the bumper and a boot that falls away, extruded across the
car with its shoulders rolled over and then pinched in toward both ends and
tucked in at the sills. The greenhouse is glass leaning in as it rises, with
painted pillars and a roof laid over it, so the windows sit in frames; the
wheels are turned on a lathe, a tyre with a sidewall and a tread round a
dished rim, under a dark wheel well. The rusted ones wear their own paint
gone to primer and oxide rather than a container's corrugated sheet, and the
whole car fits the box you climb onto — its roof is the deck you stand on.
Half of them are pickups with an open bed, and the burnt-out ones are the
same panels in charred steel with no glass left. A jersey barrier has the splayed foot and the kink at
knee height that make it a jersey barrier; a shipping container has corner
castings, sill and roof rails and doors with locking bars; a burning drum has
its rolling hoops.

Hostiles are bodies, not stacks of boxes: a chest broader than the waist, a
thigh tapering to the knee, a calf, a gloved fist, a boot on a sole, a head
in a gas mask whose goggles glow — each piece swept along its own line or
turned on a lathe. And they are wearing something, cut from the body's own
shape so a plate lies on the chest it is strapped to. A raider has front and
back plates on a cummerbund, shoulder straps, magazine pouches and a radio,
under a helmet with ear defenders; a breaker a vest all round with a trauma
plate, tassets, a neck guard, pauldrons and a guard over its jaw; a
juggernaut all of that heavier, with two-layer pauldrons, a gorget and a
pack of two tanks whose hoses run over its shoulders; a scavenger a hood, a
sheet of tin over one side of its chest, a bandolier and one pauldron; a
marksman a hood, a chest rig and a coat. A coat hangs from the hips rather
than the waist, so the shoulders can turn into a stance without swinging it
through a leg. That is not decoration: a wave is read at forty metres against a dusk skyline
where the archetype's colour is barely a colour, and the outline is what tells
you what is coming. So are their weapons, drawn by their side view like
yours: a rifle with its magazine curving forward and a stock, a breaker's
shotgun over its magazine tube, a marksman's scoped rifle, a juggernaut's
drum-fed gun with its bipod folded, a scavenger's hook. The kit is merged into the parts that already take hits,
so what you can see is what you can shoot. The cloth and the webbing are
painted pale on purpose, because a texture multiplies the colour on the
material — put a mid-grey weave under an olive drab coat and every hostile is
a silhouette.

What they drop is drawn the same way as their guns, by the side view and the
lathe: a pressed-steel ammunition can with its lid, hinge, cam latch and
folded bail handle; a medical case in two moulded halves with ribs, a handle
and draw latches; a grenade turned round its yellow band, under a fuze with
its spoon and pin.

They move like people carrying weapons. Knees and elbows bend; the stride
is paced to the ground covered, so a planted boot does not skate. On patrol
a rifle is carried low across the body; once a hostile has seen you it
squares up, blades its shoulders into a stance with its head on you,
shoulders the weapon and follows your height with it. Both hands stay on the
gun through all of it, because the arms are solved to reach the gun rather
than animated beside it. A hit shoves the upper body the way the round was
travelling and it comes back on a spring; a kill buckles the knees before
the body follows the shot down.

Hostiles carry a contact shadow under them, because the sun's shadow map only
covers the ground near the player and anything beyond it would otherwise
float.

### Graphics settings

Shadow mapping costs more than everything else in the scene put together, so
it is the first thing the quality tiers drop:

| Tier | Shadows | Lighting | Fire lights | Post | Pixel ratio | Dust | Weeds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| High | 2048 wide + 2048 near, soft | PBR + sky, normal maps | nearest 3 | occlusion, bloom + grade, 4x MSAA | up to 1.25 | yes | yes |
| Medium | 1024 wide + 1024 near, hard | PBR + sky, normal maps | nearest 2 | occlusion, bloom + grade, 2x MSAA | up to 1.0 | yes | yes |
| Low | off | Lambert | none | off, straight to the canvas | 1.0 | no | no |

A machine that cannot afford shadows cannot afford a bloom either, so Low
drops the whole post chain and hands tone mapping back to the renderer. It
is meant for the integrated graphics in an older laptop, and it draws the
city with plain Lambert lighting under a brighter sky light instead of the
physically based model, with no point lights at all; the gun in your hands
keeps its full materials. Under software rendering that is 176 ms a frame
against 986 for what Low used to be. On every tier only the nearest few fire
barrels cast real light — a fire's light reaches 14 m, and every barrel in
the sector used to be paid for on every pixel.

The sky carries weather: a layer of broken cloud lit gold on the sun's side
and slate underneath, which the city's reflected light picks up too. And the
city is overgrown — weeds along both sides of every kerb, against the foot of
every building and through the cracks of the pavement — which is the
strongest single thing that says nobody has swept here in years. Weeds are
walked and shot through, as grass is. Low keeps the cloud, at fewer octaves,
and drops the weeds.

Rain has been and gone: puddles lie in the gutters and the dips of the road,
dark and mirror-smooth, showing the sky above them with the sun as a small
glint, each inside a ring of damp asphalt. Paper, card and plastic have
drifted against the kerbs, and chips of brick and concrete lie along the
foot of every wall. The weeds move in a breeze that runs down the street
rather than through every tuft at once.

The pixel ratio is the column that matters most. Every pass the post chain
adds is paid per pixel, and on a 2x screen High used to draw 3.06 times the
pixels of a 1x one — measured in software at that ratio, a frame cost 5,968
ms at High's old cap and 3,287 at 1.25. Above 1.25 the picture is sharper
by an amount nobody notices while a hostile is shooting at them.

The default is **Auto**. It starts by timing a few frames of the city at
each tier behind the loading screen and picks the best one that draws an
empty street in 12.5 ms — 60 frames a second with a third to spare, because
a fight costs about that much more — so a laptop that cannot afford High
starts below it rather than earning its way down in the first fight. Then
it keeps watching for as long as you play. Over any three seconds under 55
frames a second it gives something back and tells you what: in a fight,
resolution, 15% at a time down to 70% of the tier's, because that costs no
stall; between waves, a whole tier, because changing tier rebuilds the
shaders and that hitches. If a fight is still short once the resolution is
spent, it takes the hitch and drops the tier anyway. It never steps back up.
Picking a tier yourself in the pause menu turns all of it off — an explicit
choice is never overridden.

Press `` ` `` (the key left of 1), or tick **Show frame rate** in the pause
menu, to see what your machine is doing: frames a second, the frame time
and the worst one, how much of it the CPU took, the tier and resolution in
use, draw calls, whether the mouse is captured, and the name of the GPU the
browser is drawing with. If that last line says SwiftShader, llvmpipe or
Basic Render, the browser is not using your graphics card at all — turn on
hardware acceleration in its settings. The menu says so too.

A slow frame no longer slows the game down. Below 20 frames a second the
simulation used to take one 50 ms step per frame whatever the frame took, so
walking, falling and every hostile ran in slow motion; a long frame is now
split into steps, up to a fifth of a second.

Every shader a run needs is built, and every texture uploaded, behind the
loading screen, so the first hostile you see and the first shot you fire do
not stall the frame they happen in.

## Vertical ground

The city is not flat. Raised terraces of collapsed floor and stacked shipping
containers are scattered through the blocks, each reachable by a stair run of
half-metre steps — low enough that you simply walk up them, no jumping. Take
the high ground and the ground-level hostiles lose their shot at you; step to
the edge and you get yours.

Anything between a step and chest height is climbed rather than walked around:
hold `Space` facing a car roof, a planter or a low wall and you haul yourself
up over about half a second, ducked and unable to shoot until you top out.
Hold it through a jump and the reach extends to roughly two and a half metres.
Hostiles climb after you. Stand on a car roof, a crate or a low wall and a
hostile coming for you — a scavenger, or anything that has lost sight of you
— walks to the face and hauls itself up the same way you did, only slower,
and with its weapon off you until it tops out: a car roof buys you that
second and a half, not the fight. Once up there with you it holds the deck
rather than strafing off the edge. Marksmen never climb; they hold their
roofs.

Hostiles run dry. A rifle's magazine, a breaker's six shells, a marksman's
five rounds and a juggernaut's drum each end in a reload — two to three
seconds with no fire coming from it, and the magazine out, the fresh one in
and the bolt are heard from where it stands. Watch for the gun dipping and
the hand going to the magazine: that is your moment. If it has cover beside
it that would hide it crouched and not standing, it kneels behind it to
reload and stays there. And gunfire too far off to bring a hostile running
still carries: an unalerted one in the ring beyond turns its head toward the
shot.

The same rules apply to everyone: hostiles climb, stand on, and fall off the
same surfaces, and a melee rusher cannot reach you across a height gap too
tall to climb. Drops
of more than about four metres hurt, and a long enough fall will kill you.

The ground you see is the ground you stand on. The pavement round every block
is a 28 cm kerb above the road, and the plaza, the rubble lots and the ruins'
courtyards are slabs of their own; you step up onto them, hostiles stand on
them rather than in them, and a shot at the pavement stops at the pavement.
Stepping up a kerb or a stair moves your feet at once and eases the view up
after them, so a street crossing is not a jolt — and at a zebra there is no
step at all, because the kerb is dropped and you walk up the ramp you see.

## How it is put together

```
index.html          page shell, HUD markup, import map
src/main.js         game loop, scene/lighting setup, waves, hit resolution
src/city.js         procedural city generation
src/world.js        box collision (square or turned), ground height, line-of-sight
src/nav.js          walkable grid over the city, and a route field to the player
src/player.js       input, movement, camera, health
src/weapons.js      weapon definitions, view models, firing and recoil
src/enemies.js      hostile archetypes, AI, procedural bodies
src/objectives.js   objective sites, channels, stages, the cast they put on the map
src/story.js        Operation ASHFALL: the briefing, the acts, the plan, the radio
src/grenades.js     thrown frags: fuse, bounce physics, detonation
src/effects.js      pooled tracers, impacts, blood, casings, explosions
src/textures.js     canvas-painted textures (asphalt, facades, rust, cloth, sky)
src/shapes.js       chamfers, lofts, side profiles, lathes, creased normals, merging
src/post.js         ambient occlusion, bloom, tone mapping, grade, vignette, grain
src/atmosphere.js   the sky, the sun and the fog, as one model
src/shadows.js      the sun's two shadow cascades
src/windows.js      window openings traced in the facade shader: reveals, glass, rooms
src/audio.js        synthesised gunfire and feedback via Web Audio
src/hud.js          HUD readouts, killfeed, radar, damage indicators
vendor/             Three.js r169 build
```

A few notes on the implementation:

- **Nothing is loaded from disk or network.** Every texture is painted into a
  canvas at boot, every sound is synthesised from noise bursts and oscillator
  envelopes, and every model is assembled out of chamfered boxes, side
  profiles, lathes, and sections swept along a line.
- **What you can see, you can bump into.** Every heap of rubble and every
  fallen slab carries colliders cut to its own shape — a stack of tiers
  shallower than a step, each fitted to the heap's cross-section at that
  height — so a mound stops you at its foot and you can scramble up it, and
  it stops a bullet. Containers, wrecks, barriers, drums and lamps stand
  clear of one another, inside the sector, and on the floor under them —
  a barrier on the pavement stands on the pavement — and the plaza's dry
  fountain is a basin you can climb into, round a plinth that stops you.
- **You hear where things are.** A hostile's shot, a round striking a wall, a
  hit, a blast, a grenade skittering and a hostile's shout are each placed
  where they happened, through an HRTF panner, with the listener riding the
  camera — so fire from behind you sounds like it, best on headphones. So
  are their footsteps, twice a stride off the same phase their legs are
  drawn from, heavier for the armoured ones and hollow on a car roof: a
  flanker is heard working round behind you before it shoots. Your own gun
  and footsteps stay centred, and the echo off the buildings comes from
  everywhere.
- **Normal maps are generated, not authored.** A Sobel pass over each
  texture's own luminance becomes its normal map, so painted detail lights
  like geometry without shipping a second set of images.
- **Big soft shapes are painted small and scaled up.** A canvas `filter` blur
  costs a full-canvas convolution per draw call, which made stains and rust
  blooms the most expensive thing at boot. Low-frequency detail is painted
  into a 96px layer instead and the upscale does the smoothing — the same
  picture, and boot got faster rather than slower as textures got richer.
- **Changing how it looks cannot change what gets built.** Three draws four
  random numbers per material, texture and geometry to build a UUID, off the
  same seeded stream the city is laid out from, so adding a texture used to
  hand every seed a different city. Boot-time graphics now run inside a call
  that rewinds the stream afterwards, and the decorative pass over the city
  draws from a generator of its own — so a seed lays out the same streets
  whether or not the buildings are wearing any of their detail. A prop is the
  harder case, because its collider *is* the city: a wreck builds its shape
  inside the same rewind and then pays a fixed number of draws for what it
  used to cost, so it can be rebuilt out of fourteen shapes instead of seven
  boxes and stay parked in the same street. A check pins three seeds to a
  fingerprint of every collider's position and turn.
- **The city is generated per session.** A 6×6 grid of lots is filled with
  towers, gutted low ruins and rubble lots, then dressed with wrecked cars,
  shipping containers, barricades, streetlights and burning barrels — and the
  blocks themselves with base courses, pilasters, roof tanks and bulkheads,
  shopfront canopies, downpipes, fire escapes and cables strung across the
  streets, because a rectangular prism under one low sun is two lit faces and
  two dark ones with no line anywhere between them. The roads between them
  are painted from the same grid — centre lines, edge lines, crossings, stop
  bars and lane arrows, all of it geometry rather than texture.
- **Collision is AABB-based.** Everything solid registers a box; entities are
  cylinders pushed out along the shallowest axis. Line of sight uses a slab
  test against the same boxes, so shots can pass over low cover.
- **The view model renders in its own scene** over the world with a cleared
  depth buffer, so the weapon never clips into geometry. It is drawn the way
  a gunsmith draws one, by its side view: a pistol's frame is one outline
  with the trigger guard cut out of it and the grip raked back under a
  beavertail, a rifle's lower flares at the magazine well, a stock has its
  lightening cut, and barrels, muzzle devices and buffer tubes are turned on
  a lathe. Every part carries stippled polymer or parkerised steel at its own
  tile scale — an untextured cube lit by one sun is two faces and two values,
  which is what "boxy" means, and the gun is the one surface always within
  reach.
  It is held: two gloved hands closed round its own grips, the trigger finger
  laid along the frame, sleeved forearms running off the bottom of the
  frame. Each finger is an arc round the grip's cross-section, so one
  function closes a hand on a pistol grip, a handguard, a vertical foregrip
  and a pump, and every part of the hand is swept rather than boxed: fingers
  that taper and stand up at each joint with the glove creased past it, no
  two the same length, a thumb that swells into its root, the back of the
  hand arched over a moulded knuckle guard, a strapped cuff, a watch on the
  support wrist, and a sleeve that widens toward the elbow and bunches
  where it meets the glove. Each gun carries the
  parts that make it that gun — a curved trigger in
  a real guard, ejection port, magwell, charging handle and forward assist,
  slide serrations, a pump's grooves — and is merged by material into eight
  to eleven meshes.
- **The city is drawn as a handful of meshes.** It is generated as some
  fifteen hundred boxes, then merged by material once it is finished — 567
  draw calls become 39, and the shadow pass falls with them. The meshes it
  was merged from stay alive off the scene graph, because those, not the
  merged copy, are what bullets are traced against.
- **Combat effects are pooled** — tracers, sprites, bullet holes and casings
  are recycled, so firefights allocate nothing.
- **Hostiles have a stuck watchdog.** If one stops closing on the player and
  is not deliberately holding its range, it is quietly re-inserted elsewhere
  so a wave can never stall. Judging that takes a ten-second horizon as well
  as a four-second window: a hostile working its way around a block and one
  sliding back and forth along a wall look identical for the first few
  seconds, and only where each ends up tells them apart.
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
  structure is not placed; a buried staircase is an unclimbable one. A stair
  run is laid back from the deck edge it climbs to, so its last tread is
  flush and level with the deck, and whatever stands on a deck — the crate,
  the knee-high lip — is a collider as well as something you can see.
- **Settings and records persist** in `localStorage` — sensitivity, FOV,
  volume, invert-look and mute, plus your best wave and score.
