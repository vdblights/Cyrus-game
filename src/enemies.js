import * as THREE from 'three';
import { audio } from './audio.js';
import { randRange, SUPPORT_RADIUS } from './world.js';
import * as TEX from './textures.js';
import { TILE, blobShadow } from './textures.js';
import { chamferGeo, mergeIntoOne, sideGeo, latheGeo, sweepGeo, bend, creaseNormals } from './shapes.js';
import { reserve } from './rng.js';
import { FUSE, GRAVITY as GRAVITY_FRAG } from './grenades.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const V5 = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const IK_A = new THREE.Vector3(), IK_B = new THREE.Vector3(), IK_C = new THREE.Vector3();
const IK_Q = new THREE.Quaternion();
const POSE = new THREE.Object3D();          // the weapon's pose, worked out before it is applied
const M4 = new THREE.Matrix4();
// the support hand's way through a reload: where it is, where it goes next
const HAND_A = new THREE.Vector3(), HAND_B = new THREE.Vector3(), HAND_FORE = new THREE.Vector3();
const HAND_MAG = new THREE.Vector3(), HAND_LOW = new THREE.Vector3();
// a pouch on the left hip, in the upper body's frame: far enough from the
// magazine that the hand's trip to it reads from across a street
const POUCH = new THREE.Vector3(-0.26, 0.04, -0.06);
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Bend a two-piece limb so its end reaches `target`.
 *
 * Both points are in the frame the limb's top piece hangs in. Each piece is
 * built hanging down its own -y from its joint, so placing it is turning -y
 * onto the direction it has to point: the upper piece toward the elbow, the
 * lower one — in the upper piece's own frame — toward the target. The elbow
 * is put where the law of cosines says it must be, on the side `pole` points
 * to, which is what keeps an elbow from folding the wrong way. A target out
 * of reach is reached for with a straight arm.
 */
function reach(top, low, target, a, b, pole) {
  const S = top.position;
  const d = IK_A.copy(target).sub(S);
  const L = THREE.MathUtils.clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-4);
  d.normalize();
  const cosA = (a * a + L * L - b * b) / (2 * a * L);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = IK_B.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  const elbow = IK_C.copy(S).addScaledVector(d, a * cosA).addScaledVector(perp, a * sinA);
  top.quaternion.setFromUnitVectors(DOWN, IK_B.copy(elbow).sub(S).normalize());
  const toEnd = IK_A.copy(target).sub(elbow).normalize()
    .applyQuaternion(IK_Q.copy(top.quaternion).invert());
  low.quaternion.setFromUnitVectors(DOWN, toEnd);
}

/**
 * How long the stuck watchdog watches before it believes a hostile is going
 * nowhere, and how far it has to end up from where it started to count as
 * having gone somewhere. A city block is 34 m of frontage, so anything that
 * rounds one covers far more than this; a hostile sliding along the face of
 * one covers far less.
 */
const HORIZON = 10;
const DRIFT = 5;

/**
 * How long a hostile that has run into something sticks with the side it
 * chose to go round. This used to be 1.4 s and was re-rolled at random, so a
 * hostile walked one way round a corner, reversed, and walked back — metres
 * of path for centimetres of progress. A detour is only a detour if you
 * finish it.
 */
const COMMIT = 6;

/**
 * How long a perch-holder gets to see nobody before its perch stops counting
 * as a post it is holding.
 *
 * A marksman on a roof is exempt from most of what moves a hostile: it does
 * not drift while unalerted, does not strafe, and waits four times as long
 * before the stuck watchdog believes it is stuck — all three deliberate, all
 * three there to stop it walking off the edge. The cost is a hostile that can
 * sit on a roof with no line to anyone for the better part of a minute, and
 * when it is the last of its wave the wave waits on it. Overwatch is a job
 * while there is something to overwatch; past this it is furniture.
 */
const PERCH_PATIENCE = 15;

/**
 * A frag, thrown. A hostile carries `frags` of them (per archetype), cooks
 * one for `cook` seconds before it lets go, and plans the throw by flying it
 * (`_planThrow`) through the same bounce the grenade will take: a throw is
 * kept only if it comes to rest within `reach` of the player with a line
 * from the blast to them. The flat angles are for a doorway, which a lob
 * meets as the wall over its lintel; 21 m/s is a hard throw, and carries
 * one about 22 m on the full at 45 degrees. `every` is how long one hostile waits between
 * throws, and `gap` how long the whole wave does — one grenade at a time is
 * a warning you can act on, two is a trap.
 */
const THROW = { cook: 0.6, reach: 3.2, minRange: 6, maxRange: 26, blind: 2.5, every: 14, gap: 7, retry: 1.5,
  angles: [0.12, 0.22, 0.35, 0.55, 0.8, 1.05], fastest: 21, step: 1 / 30 };
const TH_P = new THREE.Vector3(), TH_V = new THREE.Vector3(), TH_D = new THREE.Vector3();
const V_WATCH = new THREE.Vector3();
const FUSE_LEFT = FUSE - THROW.cook;

/**
 * While the player is reloading or changing weapon, every hostile this close
 * stops holding and comes for them, for at least `hold` seconds after the
 * reload ends — the window a hostile's own reload gives the player, turned
 * round. Faster, too, by `haste`.
 */
const PUSH = { range: 25, hold: 1.2, haste: 1.3 };

/**
 * A hostile follows you up.
 *
 * The player could haul themselves onto a car roof, a crate or a low wall,
 * and nothing could follow: `mantleTarget` was always entity-agnostic, but
 * only the player called it. So a waist-high roof was a place to stand over
 * a melee hostile that could only circle it until the stuck watchdog took it
 * away. A hostile now climbs when it is coming for you, you stand at least
 * `above` higher than its feet, you are within `near`, and there is a lip in
 * front of it — the same lip the player would grip, asked the same way.
 * Perch-holders never do: they never leave a perch, and a climb is leaving
 * the ground for somewhere new. And a hostile climbs slower than you
 * (`base` + `perM` a metre against 0.32 + 0.22), with its weapon off you for
 * the duration, because a climb is the moment it cannot fight back.
 */
const CLIMB = { above: 0.5, near: 9, min: 0.6, max: 1.8, base: 0.6, perM: 0.4 };

/**
 * The cast an objective puts on the map (`objectives.js`), and how each of
 * them moves differently from a hostile hunting you.
 *
 * A holdout follows the player once cut loose, by the same route field the
 * hostiles use, standing off `near` and hurrying past `far`. A lieutenant
 * walks his own route field to the far side of the sector at `pace` of his
 * archetype's speed, shooting at you if he sees you but never stopping to;
 * his escort keeps within `escort` of him until something alerts it. And
 * while a charge is live, an alerted hostile that cannot see you and is
 * within `lure` of it goes for the charge instead.
 */
const CAST = { near: 2.6, far: 8, pace: 0.8, escort: 2.5, lure: 40 };

/**
 * A crouch behind cover: how far the hips come down (in the body's own
 * units, so a big archetype drops further), and the thigh and knee that put
 * the feet back on the ground under them — a 0.42 m thigh and a 0.44 m shin
 * at these angles stand 0.50 m tall with the foot 6 cm forward of the hip.
 */
const CROUCH = { drop: 0.36, thigh: 1.1, knee: -1.9, lean: 0.22 };

/**
 * A stoop under a low ceiling. A hostile collides at its archetype's height
 * so a warlord can follow you into a shop, but it is drawn at its own, and
 * an elite juggernaut is 3.6 m of body under 2.75 m of headroom. So under a
 * ceiling lower than its crown (`top`, in the body's units, with `margin`
 * of air) it bends both knees until its head clears: the thigh forward by
 * `a` and the shin back by `2a` keep the foot under the hip, and the hip
 * comes down by `leg * (1 - cos a)`. At most `max` of the body's height,
 * and it leans into it. Headroom is asked across the whole body, which is
 * what has it down before a lintel rather than under it: in a doorway the
 * head leans in under the slab's edge before the feet are under it.
 */
const STOOP = { top: 1.9, margin: 0.06, leg: 0.86, max: 0.5, lean: 0.3, hip: 0.9 };

/** The crown of a body stooped as far as it goes, in metres. */
const stoopedHeight = (e) => (STOOP.top - STOOP.max + STOOP.margin) * e.group.scale.x;

/** Whether a body goes up a stairwell: stooped, under a flight's headroom. */
const fitsStair = (e, stair) => stoopedHeight(e) <= stair.clear;

/**
 * The height a body collides at. Its archetype's, so an elite follows you
 * into a shop; on a stair, its stooped crown, or a flight overhead is a
 * wall and the shaft's door a lintel it cannot pass.
 */
const bodyHeight = (e) => (e.stair ? Math.min(1.9 * e.type.scale, stoopedHeight(e)) : 1.9 * e.type.scale);

/**
 * Hostile archetypes. `preferred` is the range the AI tries to hold; melee
 * types simply close to contact.
 *
 * `kit` is what the thing is wearing, and it is not decoration: a wave is
 * read at forty metres against a dusk skyline, where the archetype's colour
 * is barely a colour. What tells you a JUGGERNAUT from a SCAVENGER at that
 * range is the outline — plate and pauldrons against a hood and a coat — so
 * the outline is what carries it, and the marker band is the confirmation.
 */
export const ENEMY_TYPES = {
  scavenger: {
    name: 'SCAVENGER', hp: 65, speed: 4.6, scale: 0.95, melee: true,
    damage: 14, rate: 1.0, preferred: 1.6, accuracy: 1, color: 0x8a9c62, accent: 0xb07a42,
    score: 100, detect: 55, marker: 0xd8452f,
    kit: { head: 'hood', armour: 'scrap', coat: 0.26, weapon: 'hook' },
  },
  raider: {
    name: 'RAIDER', hp: 110, speed: 3.0, scale: 1.0, melee: false,
    damage: 6, rate: 0.16, burst: 3, burstPause: 2.4, preferred: 13, accuracy: 0.085, mag: 30, reload: 2.2, frags: 1,
    color: 0x66788a, accent: 0x3f4750, score: 150, detect: 65, sound: 'rifle', marker: 0xe8a33a,
    kit: { head: 'helm', armour: 'carrier', coat: 0, weapon: 'rifle' },
  },
  shotgunner: {
    name: 'BREAKER', hp: 170, speed: 3.6, scale: 1.08, melee: false,
    damage: 5, pellets: 6, rate: 1.15, preferred: 6, accuracy: 0.14, falloff: 16, mag: 6, reload: 2.6, shells: 4, frags: 1,
    color: 0x9a7550, accent: 0x53412f, score: 200, detect: 50, sound: 'shotgun', marker: 0x3fa9d8,
    kit: { head: 'visor', armour: 'heavy', coat: 0, weapon: 'shotgun' },
  },
  marksman: {
    name: 'MARKSMAN', hp: 90, speed: 2.4, scale: 1.0, melee: false,
    damage: 26, rate: 2.9, preferred: 26, accuracy: 0.022, detect: 95, mag: 5, reload: 2.4,
    color: 0x5c6f5a, accent: 0x2f3a30, score: 250, sound: 'rifle', marker: 0x7ce04a,
    laser: true, perch: true,
    kit: { head: 'hood', armour: 'light', coat: 0.34, weapon: 'long' },
  },
  brute: {
    name: 'JUGGERNAUT', hp: 420, speed: 2.4, scale: 1.35, melee: false,
    damage: 7, rate: 0.13, burst: 6, burstPause: 2.8, preferred: 9, accuracy: 0.105, mag: 60, reload: 3.2, frags: 1,
    color: 0x7d5a5a, accent: 0x3a3533, score: 400, detect: 70, sound: 'smg', marker: 0xb03be0,
    kit: { head: 'helm', armour: 'plated', coat: 0, weapon: 'drum' },
  },
  // Not a hostile: a survivor a rescue puts on the map. `friendly` keeps it
  // out of the wave count, the player's fire and every hostile's attention
  // but the drain `objectives.js` applies; it follows the player once freed.
  holdout: {
    name: 'HOLDOUT', hp: 120, speed: 4.4, scale: 0.95, melee: false, friendly: true,
    damage: 0, rate: 1, preferred: 2, accuracy: 1, color: 0x8d8574, accent: 0x5a4c3a,
    score: 0, detect: 0, marker: 0x9cf0c0,
    // the lenses every hostile glows red through are the band's mint on
    // them: at forty metres a red-eyed body in a coat reads as one of them
    eye: 0x9cf0c0,
    kit: { head: 'hood', armour: 'light', coat: 0.22, weapon: 'rifle' },
  },
};

/**
 * Everything a hostile is built from, per archetype, minted once.
 *
 * Two reasons this is a cache rather than a constructor. A hostile used to
 * mint four materials and fourteen geometries every time one spawned — a
 * wave of sixteen was sixty-odd one-off materials, none of which any batching
 * can merge, and the textures they now carry would have been repainted with
 * each of them. And it is built inside `reserve` (see `rng.js`), so the
 * seeded stream never sees it; `primeEnemyKits` runs at boot for the same
 * reason, because a kit built mid-run costs the stream whatever it costs.
 *
 * What differs per archetype is what it is wearing, which is the point: a
 * BREAKER should be recognisable as the thing that closes on you fast from
 * its outline alone, before the colour band is legible. So the silhouette
 * carries it — plate, pauldrons, a hood, a coat — rather than a hue.
 */
const KITS = new Map();

/**
 * Where each part sits on the body.
 *
 * The geometry is built *about* these rather than baked to them, so a part's
 * own position is still where that part is — `parts.head.getWorldPosition()`
 * is the head, which is what every check that aims at a hit zone reads, and
 * what the note in CLAUDE.md means by "use the actual part's world position"
 * instead of a hardcoded aim height. Baking the offsets in put every part at
 * the feet and quietly turned a headshot check into a leg shot.
 */
const AT = {
  torso: [0, 1.18, 0], rig: [0, 1.22, 0], head: [0, 1.66, 0], headKit: [0, 1.66, 0],
  band: [0, 1.36, 0], eye: [0, 1.672, -0.116],
  armL: [-0.34, 1.45, 0], armR: [0.34, 1.45, 0],
  legL: [-0.14, 0.86, 0], legR: [0.14, 0.86, 0],
  weapon: [0.30, 1.28, -0.12],
  skirt: [0, 0.9, 0],
  // the upper body turns, leans and flinches about the waist
  waist: [0, 0.88, 0],
};

/**
 * A hostile's weapon, drawn by its side view the way the player's are (see
 * `sideGeo`). Seen at twenty metres in a stranger's hands, what says "rifle"
 * is the outline — a receiver, a magazine curving forward, a grip raked back,
 * a stock, a barrel with something on the end of it — and a stack of boxes
 * had none of it. Chunkier than the view models, because it is read from
 * across a street; cut with fewer bevel steps, because twelve of them are
 * drawn three times a frame. The hand-holds (`hold`) and the muzzle point are
 * where they always were, so the pose and the shot are untouched.
 */
function hostileGun(kind) {
  const T = TILE.gunMetal;
  const cut = { tile: T, segs: 1, curve: 2 };
  const side = (outline, width, opts = {}) => sideGeo(outline, width, { bevel: Math.min(0.012, width * 0.2), ...cut, ...opts });
  const turned = (profile, y, sides = 10) => latheGeo(profile, sides, T, { crease: 50 }).translate(0, y, 0);
  const gun = [];
  if (kind === 'hook') {
    gun.push(turned([[0, -0.68], [0.026, -0.68], [0.026, 0.06], [0.034, 0.07], [0.034, 0.10], [0, 0.10]], 0, 8));
    // the hook itself: a blade swept back from the head of the shaft
    gun.push(side([[-0.60, 0.02], [-0.68, 0.02, 0.02], [-0.70, -0.06, 0.03], [-0.66, -0.20, 0.02],
      [-0.62, -0.19], [-0.645, -0.07, 0.03], [-0.62, -0.02]], 0.03));
    return gun;
  }
  const long = kind === 'long', shotgun = kind === 'shotgun', drum = kind === 'drum';
  // upper receiver running into the handguard
  gun.push(side([[-0.47, -0.036, 0.012], [-0.47, 0.046, 0.014], [-0.44, 0.062, 0.01], [0.05, 0.062, 0.012],
    [0.08, 0.040, 0.01], [0.08, -0.030], [-0.47, -0.036]], 0.072));
  // lower: magazine well, trigger guard as a hole
  gun.push(side([[-0.21, -0.030], [0.076, -0.030], [0.076, -0.060, 0.01], [0.036, -0.062], [0.032, -0.100, 0.008],
    [-0.074, -0.100, 0.012], [-0.104, -0.080, 0.01], [-0.104, -0.062], [-0.21, -0.062, 0.012]], 0.066,
  { holes: [[[0.024, -0.064], [0.022, -0.090, 0.006], [-0.034, -0.090, 0.008], [-0.046, -0.064]]] }));
  // grip, raked back, about the shooting hand's hold
  const rx = -0.30, A = [-Math.sin(rx), -Math.cos(rx)], F = [-Math.cos(rx), Math.sin(rx)];
  const at = (a, f) => [0.064 + A[0] * a + F[0] * f, -0.122 + A[1] * a + F[1] * f];
  gun.push(side([[...at(-0.075, 0.034), 0.01], [...at(-0.075, -0.034), 0.01], [...at(0.06, -0.034), 0.014],
    [...at(0.06, 0.034), 0.014]], 0.054));
  // magazine: a curve forward, or a drum
  if (drum) {
    gun.push(turned([[0, -0.03], [0.12, -0.03], [0.125, -0.02], [0.125, 0.02], [0.12, 0.03], [0, 0.03]], 0, 14)
      .rotateY(Math.PI / 2).translate(0, -0.17, -0.15));
  } else if (!shotgun) {
    gun.push(side([[-0.205, -0.06], [-0.125, -0.06], [-0.13, -0.15, 0.06], [-0.16, -0.25, 0.008],
      [-0.25, -0.24, 0.008], [-0.22, -0.15, 0.06]], 0.050));
  }
  // stock
  if (long) {
    gun.push(side([[0.07, 0.044], [0.20, 0.036, 0.02], [0.33, 0.030, 0.01], [0.34, 0.010], [0.34, -0.12, 0.012],
      [0.31, -0.13, 0.012], [0.15, -0.05, 0.04], [0.07, -0.04]], 0.058, { holes: [[[0.17, -0.01], [0.27, -0.01], [0.27, -0.065, 0.01]]] }));
  } else {
    gun.push(side([[0.07, 0.034], [0.27, 0.026, 0.008], [0.28, 0.012], [0.28, -0.10, 0.01], [0.26, -0.11, 0.01],
      [0.12, -0.036, 0.02], [0.07, -0.030]], 0.056, { holes: [[[0.14, -0.004], [0.23, -0.004], [0.23, -0.06, 0.008]]] }));
  }
  // barrel and what is on the end of it
  const muzzle = long ? -0.86 : -0.74;
  if (shotgun) {
    gun.push(turned([[0, muzzle], [0.024, muzzle], [0.024, -0.46], [0, -0.46]], 0.016));
    gun.push(turned([[0, -0.70], [0.018, -0.70], [0.018, -0.46], [0, -0.46]], -0.026));
    gun.push(side([[-0.62, -0.050, 0.012], [-0.62, 0.006, 0.01], [-0.44, 0.008, 0.01], [-0.44, -0.052, 0.012]], 0.072));
  } else {
    gun.push(turned([[0, muzzle + 0.05], [0.015, muzzle + 0.05], [0.015, -0.46], [0, -0.46]], 0.012));
    gun.push(turned([[0, muzzle], [0.022, muzzle], [0.022, muzzle + 0.06], [0.015, muzzle + 0.07], [0, muzzle + 0.07]], 0.012));
    gun.push(side([[-0.53, 0.012], [-0.49, 0.012], [-0.495, 0.075, 0.006], [-0.525, 0.075, 0.006]], 0.03));   // front sight
  }
  if (drum) {
    // a heavy barrel shroud, and a bipod folded up under it
    gun.push(turned([[0, -0.66], [0.03, -0.66], [0.03, -0.47], [0, -0.47]], 0.012, 12));
    for (const sx of [-1, 1]) gun.push(chamferGeo(0.016, 0.016, 0.26, 0.005, T, [sx * 0.022, -0.035, -0.56]));
  }
  if (long) {
    // a scope on rings
    gun.push(turned([[0, -0.32], [0.034, -0.32], [0.034, -0.27], [0.024, -0.24], [0.024, -0.04],
      [0.03, -0.02], [0.03, 0.02], [0, 0.02]], 0.115, 12));
    for (const z of [-0.20, -0.08]) gun.push(chamferGeo(0.04, 0.05, 0.022, 0.006, T, [0, 0.085, z]));
  }
  return gun;
}

/** Upper arm to elbow, elbow to the middle of the fist; thigh, shin. */
const ARM = { upper: 0.28, fore: 0.30 };
const LEG = { thigh: 0.43 };

function kitFor(type) {
  let kit = KITS.get(type.name);
  if (!kit) KITS.set(type.name, kit = reserve(() => makeKit(type)));
  return kit;
}

/** Build every archetype's kit up front, so no wave pays for it mid-fight. */
export function primeEnemyKits() {
  for (const type of Object.values(ENEMY_TYPES)) kitFor(type);
}

/**
 * One body of every archetype, for compiling their shaders before play rather
 * than on the frame the first one comes into view (`Game.precompileStages`). Built
 * inside `reserve`, so the meshes it mints cost the seeded stream nothing,
 * and never pooled, so it changes nothing about how a wave is spawned.
 */
export function sampleBodies() {
  return reserve(() => {
    const g = new THREE.Group();
    for (const type of Object.values(ENEMY_TYPES)) g.add(buildBody(type).group);
    return g;
  });
}

function makeKit(type) {
  const k = type.kit;
  const T = TILE.kit;

  const clothTex = TEX.fatigues();
  const gearTex = TEX.webbing();
  const gearSurface = TEX.surfaceFrom(gearTex, { dark: 1, lite: 0.35, metalDark: 0, metalLite: 0.8 }, 'webbing');
  const steelTex = TEX.gunMetal();

  // The maps are pale and carry only the weave, the strapping and the wear —
  // the archetype's own colours still say what it is, the way `paintedMetal`
  // lets one texture paint a grey streetlight and a maroon wreck. Vertex
  // colours darken what is cut from the same stuff but is not the same
  // thing: a glove at the end of a sleeve, a boot under a trouser leg.
  const cloth = new THREE.MeshStandardMaterial({
    color: type.color, map: clothTex, vertexColors: true,
    normalMap: TEX.normalFrom(clothTex, 1.3, 'fatigues', 1),
    normalScale: new THREE.Vector2(0.75, 0.75),
    roughnessMap: TEX.surfaceFrom(clothTex, { dark: 1, lite: 0.86 }, 'fatigues'),
    // the sky is the only fill a hostile gets on the side away from the
    // sun, and it is facing you from that side more often than not
    roughness: 1, metalness: 0, envMapIntensity: 0.75,
  });
  const gear = new THREE.MeshStandardMaterial({
    color: type.accent, map: gearTex, vertexColors: true,
    normalMap: TEX.normalFrom(gearTex, 1.4, 'webbing', 1),
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: gearSurface, metalnessMap: gearSurface,
    roughness: 1, metalness: 1, envMapIntensity: 0.8,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0x8c7159, map: clothTex, vertexColors: true,
    normalMap: TEX.normalFrom(clothTex, 1.3, 'fatigues', 1),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.92, metalness: 0, envMapIntensity: 0.4,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x9aa0a8, map: steelTex,
    normalMap: TEX.normalFrom(steelTex, 1.2, 'gunmetal', 1),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughnessMap: TEX.surfaceFrom(steelTex, { dark: 0.92, lite: 0.2, metalDark: 0.5, metalLite: 1 }, 'gunmetal'),
    roughness: 1, metalness: 1, envMapIntensity: 0.8,
  });

  // ------------------------------------------------------------ the tools
  const lerp = THREE.MathUtils.lerp;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  /** 0 below `a`, 1 past `b`, eased between; `a > b` runs it the other way. */
  const ramp = (a, b, x) => smooth(clamp01((x - a) / (b - a)));
  const ACROSS = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);
  /** One shade over a whole piece, multiplied into its material's colour. */
  const tone = (geo, c = 1) => {
    const n = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(c), 3));
    return geo;
  };
  /** A chamfered part, in the frame of whatever it is merged into. */
  const box = (w, h, d, at, bevel, c = 1) =>
    tone(chamferGeo(w, h, d, bevel ?? Math.min(w, h, d) * 0.22, T, at), c);
  /** A swept piece: a limb, a strap, a hood (see `sweepGeo`). */
  const tube = (points, size, opts = {}, c = 1) => tone(sweepGeo(points.map((p) => new THREE.Vector3(...p)), size, T,
    { side: ACROSS, around: 10, step: 0.06, dome: 2, ...opts }), c);
  /**
   * A flat swept piece — a strap, a plate edge-on. Smoothed the way a limb is,
   * the knife edge down each side averages its top face with its bottom one
   * and a facet there ends up lit as if it faced inward; creased, each face
   * keeps its own.
   */
  const flat = (points, size, opts = {}, c = 1) => creaseNormals(tube(points, size, { around: 6, ...opts }, c), 40);
  /** Turned about +Z, then laid where it goes by the caller. */
  const turned = (profile, sides, c = 1) => tone(latheGeo(profile, sides, T, { crease: 50 }), c);

  // ------------------------------------------------------------ the body
  //
  // The body's own section from the hips to the shoulder line: height,
  // half-width, half-depth and how far forward its middle sits, in the
  // body's frame. Everything worn over the torso is cut from these rows
  // (`wrap`), so a plate lies on the chest it is strapped to and a belt goes
  // round the waist it is on, rather than a box standing off a box.
  const BODY = [
    [0.84, 0.190, 0.112, 0.012],
    [0.95, 0.200, 0.116, 0.010],
    [1.05, 0.178, 0.106, 0.004],
    [1.20, 0.200, 0.120, -0.004],
    [1.33, 0.225, 0.128, -0.010],
    [1.43, 0.240, 0.118, -0.002],
  ];
  const TOP = BODY[BODY.length - 1];
  const at = (y) => {
    let i = 0;
    while (i < BODY.length - 2 && y > BODY[i + 1][0]) i++;
    const [y0, w0, d0, z0] = BODY[i], [y1, w1, d1, z1] = BODY[i + 1];
    const t = clamp01((y - y0) / (y1 - y0));
    return { w: lerp(w0, w1, t), d: lerp(d0, d1, t), z: lerp(z0, z1, t) };
  };
  /** The body's surface at a height and across, at the front (-1) or the back (+1). */
  const face = (x, y, side) => { const s = at(y); return s.z + side * s.d * Math.sqrt(Math.max(0, 1 - (x / s.w) ** 2)); };
  // The torso closes over the shoulders in a dome (as `sweepGeo` domes an
  // end), which is the slope from the neck to the shoulder; a strap over it
  // has to know where it is.
  const DOME = 0.9 * Math.min(TOP[1], TOP[2]);
  const crown = (x, z) => TOP[0] + DOME * Math.sqrt(Math.max(0, 1 - (x / TOP[1]) ** 2 - ((z - TOP[3]) / TOP[2]) ** 2));
  const FRONT = Math.PI / 2, BACK = Math.PI * 1.5, TAU = Math.PI * 2;

  /**
   * Something worn over the torso between two heights: the body's own
   * section grown by `out`, standing proud across `arcs` (angles round the
   * body: 0 its right side, `FRONT`, `BACK`) and tucked under the cloth
   * everywhere else, so its edges roll into the body instead of standing off
   * it. No arcs is all the way round, which is a belt or a vest.
   */
  const wrap = (y0, y1, out, arcs = null, { edge = 0.3, lip = 0.035 } = {}, c = 1) => {
    const n = Math.max(2, Math.round((y1 - y0) / 0.05));
    const pts = [];
    for (let i = 0; i <= n; i++) { const y = lerp(y0, y1, i / n); pts.push([0, y, at(y).z]); }
    const span = y1 - y0;
    const of = (t) => at(lerp(y0, y1, t));
    const one = arcs && arcs.length === 1 ? arcs[0] : null;
    const range = one ? [one[0] - one[1] - 0.05, one[0] + one[1] + 0.05] : null;
    return tube(pts, (t) => { const s = of(t); return [s.w + out, s.d + out]; }, {
      open: [true, true], step: lip, arc: range,
      around: range ? Math.max(6, Math.ceil((range[1] - range[0]) / 0.26)) : 18,
      bump: (t, th) => {
        const s = of(t);
        const hide = (Math.min(s.w, s.d) - 0.008) / (Math.min(s.w, s.d) + out);
        let on = 1;
        if (arcs) {
          on = 0;
          for (const [mid, half] of arcs) {
            let d = (th - mid) % TAU;
            if (d > Math.PI) d -= TAU;
            if (d < -Math.PI) d += TAU;
            on = Math.max(on, ramp(half, half - edge, Math.abs(d)));
          }
        }
        on *= ramp(0, lip, Math.min(t, 1 - t) * span);
        return lerp(hide, 1, on);
      },
    }, c);
  };
  /** A strap from the chest, over the shoulder and down the back, on whatever it lies over. */
  const strap = (x, out, wide = 0.028, c = 0.8) => {
    const pts = [
      [x, 1.25, face(x, 1.25, -1) - out], [x, 1.38, face(x, 1.38, -1) - out - 0.004],
      [x, crown(x, -0.07) + 0.012, -0.07], [x, crown(x, 0) + 0.012, 0], [x, crown(x, 0.07) + 0.012, 0.07],
      [x, 1.38, face(x, 1.38, 1) + out + 0.004], [x, 1.25, face(x, 1.25, 1) + out],
    ];
    return flat(pts, () => [wide / 2, 0.006], { step: 0.05, open: [true, true] }, c);
  };
  /** A pouch on the front (-1) or the back (+1), its inside face on what it is clipped to. */
  const pouch = (x, y, w, h, d, out, side = -1, c = 0.85) =>
    box(w, h, d, [x, y, face(x, y, side) + side * (out + d / 2 - 0.006)], 0.014, c);
  /** A short sleeve round the neck, or round anything upright. */
  const collar = (y0, y1, r0, r1, c = 1, z = 0) =>
    tube([[0, y0, z], [0, y1, z + 0.004]], (t) => [lerp(r0[0], r1[0], t), lerp(r0[1], r1[1], t)],
      { open: [true, true], around: 14, step: 0.06 }, c);
  /** A shoulder plate: a shallow lens laid over the deltoid, tipped out. */
  const pauldron = (side, x, y, r, tilt, c = 0.9) => {
    const g = turned([[0, 0.062], [r * 0.6, 0.05], [r, 0], [r * 0.95, -0.014], [0, -0.014]], 12, c);
    g.rotateX(-Math.PI / 2);
    g.scale(1, 1, 1.15);
    g.rotateZ(-side * tilt);
    return g.translate(side * x, y, 0);
  };

  const heavy = k.armour === 'heavy' || k.armour === 'plated';
  const L = heavy ? 0.02 : 0;

  // The torso proper, a neck and a jacket collar, in the body's frame.
  // The dome that closes the bottom of it is flattened into a seat, or it
  // hangs between the legs.
  const torso = [
    bend(tube(BODY.map((r) => [0, r[0], r[3]]), (t) => { const s = at(lerp(BODY[0][0], TOP[0], t)); return [s.w, s.d]; },
      { around: 16, step: 0.07, dome: 4 }), (v) => { if (v.y < BODY[0][0]) v.y = BODY[0][0] - (BODY[0][0] - v.y) * 0.45; }),
    tube([[0, 1.46, 0.006], [0, 1.60, 0.0]], () => [0.052, 0.056], { around: 8, step: 0.14, dome: 1 }, 0.95),
    collar(1.47, 1.53, [0.088, 0.082], [0.076, 0.072], 0.85),
  ];
  // A coat that hangs past the belt, flaring as it falls, which is most of
  // what reads as a long-range shooter standing still on a roof. Its skirt
  // hangs from the hips rather than the waist (`skirt`), so the upper body
  // can blade into a stance without swinging it through a leg, and it is
  // near round for the same reason: the waist turns inside its top.
  let skirt = null;
  if (k.coat) {
    const y0 = 0.985, y1 = 0.84 - k.coat;
    skirt = tube([[0, y0, 0.006], [0, 0.90, 0.02], [0, y1, 0.04]],
      // flaring fast off the belt and then falling straight, or the tops of
      // the thighs stand out through it
      (t) => [lerp(0.212, 0.29, Math.sqrt(t)), lerp(0.172, 0.26, Math.sqrt(t))], { around: 16, step: 0.06, open: [true, true] }, 0.92);
    torso.push(collar(1.44, 1.55, [0.13, 0.12], [0.1, 0.09], 0.9));   // its collar, turned up
  }

  // What is worn over it.
  const rig = [
    wrap(0.955, 1.005, heavy ? 0.018 : 0.013, null, { lip: 0.016 }, 0.6),             // belt
    wrap(0.80, 0.965, 0.006, null, { lip: 0.04 }),                                      // the seat of the trousers
  ];
  let band = 0.03;     // how far proud the archetype's marker band stands
  if (k.armour === 'carrier') {
    rig.push(wrap(1.07, 1.27, 0.022, null, { lip: 0.02 }, 0.9));                       // cummerbund
    rig.push(wrap(1.09, 1.41, 0.036, [[FRONT, 0.95]]));                                 // front plate
    rig.push(wrap(1.09, 1.41, 0.036, [[BACK, 0.95]]));                                  // back plate
    for (const x of [-0.115, 0.115]) rig.push(strap(x, 0.036));
    for (const x of [-0.088, 0, 0.088]) rig.push(pouch(x, 1.19, 0.078, 0.13, 0.05, 0.036));
    rig.push(pouch(0.11, 1.30, 0.07, 0.16, 0.05, 0.036, 1));                            // radio
    rig.push(pouch(-0.2, 1.0, 0.07, 0.1, 0.06, 0.0, 1, 0.75));                         // dump pouch
    band = 0.044;
  } else if (k.armour === 'heavy') {
    rig.push(wrap(1.03, 1.42, 0.05, null, { lip: 0.04 }));                              // the vest, all round
    rig.push(wrap(1.12, 1.38, 0.068, [[FRONT, 0.8]]));                                  // a trauma plate over it
    rig.push(wrap(0.86, 1.02, 0.036, [[FRONT, 0.55], [0.15, 0.35], [Math.PI - 0.15, 0.35]], { edge: 0.25, lip: 0.02 }, 0.85));
    rig.push(collar(1.42, 1.52, [0.135, 0.125], [0.105, 0.098], 0.85));                 // neck guard
    for (const s of [-1, 1]) rig.push(pauldron(s, 0.31, 1.49, 0.135, 0.55));
    for (const x of [-0.12, 0.12]) rig.push(pouch(x, 1.08, 0.09, 0.09, 0.06, 0.05));
    band = 0.074;
  } else if (k.armour === 'plated') {
    rig.push(wrap(1.0, 1.42, 0.066, null, { lip: 0.04 }));
    rig.push(wrap(1.10, 1.39, 0.09, [[FRONT, 0.75]]));
    rig.push(wrap(0.84, 1.0, 0.05, [[FRONT, 0.6], [0.25, 0.4], [Math.PI - 0.25, 0.4]], { edge: 0.25, lip: 0.02 }, 0.85));
    rig.push(collar(1.40, 1.54, [0.155, 0.14], [0.112, 0.104], 0.85));                  // gorget
    for (const s of [-1, 1]) {
      rig.push(pauldron(s, 0.33, 1.50, 0.16, 0.5));
      rig.push(pauldron(s, 0.37, 1.41, 0.125, 0.95, 0.8));
    }
    // a pack on the back, two tanks strapped to it, and the hoses over the shoulders
    const back = face(0, 1.25, 1) + 0.066;
    rig.push(box(0.38, 0.42, 0.18, [0, 1.25, back + 0.09], 0.04, 0.8));
    for (const x of [-0.11, 0.11]) {
      const tank = turned([[0, -0.2], [0.05, -0.185], [0.062, -0.16], [0.062, 0.16], [0.05, 0.185], [0, 0.2]], 10, 0.95);
      rig.push(tank.rotateX(-Math.PI / 2).translate(x, 1.27, back + 0.22));
      const front = face(x * 0.7, 1.3, -1) - 0.1;
      rig.push(tube([[x, 1.47, back + 0.2], [x * 1.4, 1.53, back * 0.5 + 0.02], [x * 1.5, crown(x * 1.5, 0) + 0.03, -0.01],
        [x * 1.3, 1.45, front], [x * 0.8, 1.32, front]], () => [0.018, 0.018], { around: 6, step: 0.05, dome: 1 }, 0.5));
    }
    band = 0.098;
  } else if (k.armour === 'scrap') {
    // whatever was to hand, strapped on one side and not the other
    rig.push(wrap(1.15, 1.37, 0.022, [[FRONT + 0.4, 0.55]], { edge: 0.2 }, 0.85));       // a sheet of tin
    rig.push(pauldron(1, 0.31, 1.49, 0.13, 0.6, 0.8));
    // a bandolier, over the left shoulder and round under the right arm
    const R = 0.02;
    const pts = [
      [-0.13, crown(-0.13, -0.05) + R, -0.05], [-0.09, 1.38, face(-0.09, 1.38, -1) - R],
      [0.02, 1.24, face(0.02, 1.24, -1) - R], [0.14, 1.08, face(0.14, 1.08, -1) - R],
      [at(1.0).w + R, 1.0, 0.0],
      [0.13, 1.1, face(0.13, 1.1, 1) + R], [-0.03, 1.26, face(-0.03, 1.26, 1) + R],
      [-0.12, 1.4, face(-0.12, 1.4, 1) + R], [-0.14, crown(-0.14, 0.04) + R, 0.04],
    ];
    rig.push(tube(pts, () => [0.018, 0.015], { around: 6, step: 0.05, open: [true, true] }, 0.7));
    rig.push(pouch(0.1, 1.08, 0.12, 0.1, 0.06, 0.0, -1, 0.75));
    rig.push(pouch(-0.21, 0.98, 0.1, 0.14, 0.07, 0.0, 1, 0.7));                        // a satchel on the hip
    band = 0.036;
  } else {
    // a chest rig: a row of magazine pouches on a yoke
    rig.push(wrap(1.15, 1.32, 0.03, [[FRONT, 1.0]]));
    for (const x of [-0.12, -0.04, 0.04, 0.12]) rig.push(pouch(x, 1.22, 0.07, 0.11, 0.045, 0.03));
    for (const x of [-0.12, 0.12]) rig.push(strap(x, 0.03, 0.03));
    rig.push(pouch(0, 1.03, 0.18, 0.1, 0.07, 0.0, 1, 0.75));                           // a butt pack
    band = 0.038;
  }

  // ------------------------------------------------------------ the head
  // A head, about its own middle: the eyes on the line through it.
  const head = [tube([[0, -0.035, 0.008], [0, 0.0, 0.004], [0, 0.03, 0]],
    (t) => [lerp(0.084, 0.096, t), lerp(0.1, 0.108, t)], { around: 14, step: 0.032, dome: 4 })];

  const headKit = [];
  // goggles: two cups over the eyes, the lenses (`eye`) in them, and a strap round the back
  for (const x of [-0.042, 0.042]) {
    headKit.push(turned([[0.025, 0.002], [0.034, 0.002], [0.032, -0.018], [0.025, -0.018], [0.025, 0.002]], 10, 0.5)
      .translate(x, 0.012, -0.097));
  }
  const ring = [];
  for (let i = 0; i <= 8; i++) {
    const a = lerp(0.3, 1.7, i / 8) * Math.PI;
    ring.push([Math.sin(a) * 0.1, 0.012, 0.004 - Math.cos(a) * 0.113]);
  }
  headKit.push(flat(ring, () => [0.011, 0.004], { side: UP, step: 0.05, open: [true, true] }, 0.55));
  // a canister filter, pointing forward and down from wherever it is screwed in
  const filter = (x, y, z, c = 0.7) => turned([[0, 0], [0.034, 0], [0.036, -0.006], [0.036, -0.034], [0, -0.04]], 10, c)
    .rotateX(-0.45).rotateY(-x * 4).translate(x, y, z);
  if (k.head === 'visor') {
    // a face guard over the mouth and jaw, the filters out at its cheeks
    headKit.push(flat([[-0.104, -0.048, -0.02], [-0.075, -0.05, -0.095], [0, -0.052, -0.128], [0.075, -0.05, -0.095], [0.104, -0.048, -0.02]],
      () => [0.046, 0.008], { side: UP, around: 8, step: 0.03, dome: 1 }, 0.9));
    for (const x of [-0.07, 0.07]) headKit.push(filter(x, -0.06, -0.115));
  } else {
    // a respirator: a moulded cup over the nose and mouth
    headKit.push(tube([[0, -0.042, -0.07], [0, -0.05, -0.1], [0, -0.056, -0.122]],
      (t) => [lerp(0.072, 0.05, t), lerp(0.056, 0.04, t)], { around: 12, step: 0.025, open: [true, false] }, 0.75));
    if (k.head === 'hood') headKit.push(filter(0, -0.072, -0.15));
    else for (const x of [-0.05, 0.05]) headKit.push(filter(x, -0.07, -0.13));
  }
  if (k.head === 'hood') {
    // a hood: an arch over the crown from shoulder to shoulder, open at the
    // face, closed behind the head, and a cowl round the neck under it
    const arch = [];
    for (let i = 0; i <= 10; i++) {
      const a = lerp(-0.5, Math.PI + 0.5, i / 10);
      arch.push([Math.cos(a) * 0.128, -0.02 + Math.sin(a) * 0.166, 0.004]);
    }
    headKit.push(tube(arch, () => [0.125, 0.022], { side: new THREE.Vector3(0, 0, 1), around: 10, step: 0.055, dome: 1 }, 1));
    headKit.push(tube([[0, -0.11, 0.075], [0, 0.0, 0.1], [0, 0.09, 0.07]], () => [0.112, 0.05], { around: 10, step: 0.07 }, 1));
    headKit.push(collar(-0.21, -0.09, [0.17, 0.15], [0.124, 0.118], 1, 0.012));
  } else {
    // a helmet, turned, with the back brought down over the nape
    const helmet = turned([[0, 0.128], [0.068, 0.116], [0.112, 0.082], [0.13, 0.038], [0.134, 0.0], [0.131, -0.012], [0, -0.012]], 16);
    helmet.rotateX(-Math.PI / 2);
    bend(helmet, (v) => { v.y -= (Math.max(0, v.z) / 0.134) * 0.05 * (1 - ramp(-0.012, 0.07, v.y)); });
    headKit.push(helmet.scale(1, 1, 1.12).translate(0, 0.035, 0.008));
    if (k.armour === 'plated') {
      // a brow plate riveted across the front of it
      const brow = [];
      for (let i = 0; i <= 8; i++) {
        const a = lerp(-1.2, 1.2, i / 8);
        brow.push([Math.sin(a) * 0.142, 0.048, 0.008 - Math.cos(a) * 0.158]);
      }
      headKit.push(flat(brow, () => [0.024, 0.008], { side: UP, step: 0.04, dome: 1 }, 0.85));
    } else if (k.head === 'helm') {
      // ear defenders, and a night-vision mount on the brow
      for (const s of [-1, 1]) {
        headKit.push(turned([[0, 0], [0.044, 0], [0.044, -0.022], [0, -0.034]], 10, 0.65)
          .rotateY(-s * Math.PI / 2).translate(s * 0.096, -0.004, 0.006));
      }
      headKit.push(box(0.045, 0.05, 0.026, [0, 0.085, -0.148], 0.008, 0.6));
    }
  }

  // ------------------------------------------------------------ the limbs
  // Each piece hangs from its own joint, and the lower one is parented at the
  // end of the upper (`ARM` and `LEG` have the lengths). A joint is a dome
  // at each end of the pieces that meet there, so a bent knee or elbow
  // stays closed.
  const arm = [tube([[0, 0.012, 0], [0, -0.13, 0.004], [0, -0.28, 0]],
    (t) => [lerp(0.074, 0.054, t) + L, lerp(0.078, 0.058, t) + L], { step: 0.07 })];
  if (heavy) arm.push(tube([[0, -0.05, 0], [0, -0.19, 0]], () => [0.074 + L, 0.078 + L], { open: [true, true], step: 0.14 }, 0.85));
  const fore = [
    // a sleeve, bunched where it meets the glove
    tube([[0, 0, 0], [0, -0.12, -0.004], [0, -0.24, 0]], (t) => [lerp(0.058, 0.043, t) + L, lerp(0.061, 0.046, t) + L],
      { step: 0.04, bump: (t) => 1 + 0.14 * Math.exp(-(((t - 0.84) / 0.07) ** 2)) }),
    // the gloved fist, its middle where the arm's reach puts the hand, and a thumb across the front
    tube([[0, -0.255, -0.004], [0, -0.28, -0.009], [0, -0.305, -0.006]], () => [0.045, 0.053], { step: 0.05, dome: 3 }, 0.32),
    tube([[0, -0.262, -0.044], [0, -0.302, -0.06]], () => [0.016, 0.018], { around: 6, step: 0.04, dome: 1 }, 0.32),
  ];
  if (heavy) fore.push(tube([[0, -0.04, -0.002], [0, -0.19, -0.002]], (t) => [lerp(0.066, 0.056, t) + L, lerp(0.07, 0.06, t) + L], { open: [true, true], step: 0.15 }, 0.85));
  const leg = [tube([[0, 0.035, 0.004], [0, -0.2, -0.01], [0, -0.43, 0]],
    (t) => [lerp(0.1, 0.072, t) + L, lerp(0.108, 0.076, t) + L], { step: 0.09 })];
  // a calf, and a trouser leg gathered into a boot
  const shin = [
    tube([[0, 0, 0], [0, -0.12, 0.012], [0, -0.3, 0.004]], (t) => {
      const calf = Math.exp(-(((t - 0.3) / 0.25) ** 2));
      return [lerp(0.07, 0.054, t) + 0.004 * calf + L, lerp(0.072, 0.056, t) + 0.01 * calf + L];
    }, { step: 0.045, bump: (t) => 1 + 0.1 * Math.exp(-(((t - 0.86) / 0.06) ** 2)) }),
    tone(sideGeo([[0.068, -0.434, 0.012], [0.066, -0.29, 0.01], [-0.05, -0.29, 0.01], [-0.06, -0.335, 0.03],
      [-0.135, -0.38, 0.035], [-0.178, -0.40, 0.02], [-0.182, -0.434, 0.008]], 0.112 + L, { bevel: 0.012, tile: T, segs: 1, curve: 1 }), 0.42),
    box(0.122 + L, 0.022, 0.262, [0, -0.443, -0.057], 0.006, 0.22),                  // sole
  ];
  if (k.armour === 'carrier' || heavy) {
    // knee pads
    const r = heavy ? 0.068 : 0.056;
    shin.push(turned([[0, -0.03], [r * 0.7, -0.022], [r, 0], [0, 0]], 8, 0.7)
      .scale(1, 1.25, 1).translate(0, -0.02, -0.06 - L));
  }

  // ---------------------------------------------------------- the weapon
  const gun = hostileGun(k.weapon);

  // Where the two hands close on the weapon, in the weapon's own frame: the
  // shooting hand on the grip, the support hand under the front of the
  // receiver — or both on the shaft, for the hook.
  // `mag` is where the support hand goes to reload: the foot of the curved
  // magazine, the underside of the drum, the shotgun's loading port.
  const hold = k.weapon === 'hook'
    ? { grip: [0, 0, 0.02], fore: [0, 0, -0.24] }
    : { grip: [0, -0.12, 0.06], fore: [0, -0.085, -0.26],
      mag: k.weapon === 'drum' ? [0, -0.28, -0.15] : k.weapon === 'shotgun' ? [0, -0.075, -0.12] : [0, -0.21, -0.20] };

  /** Merge pieces built in the body's frame, and take them back to the part's own origin. */
  const about = (geos, where) => mergeIntoOne(geos).translate(-where[0], -where[1], -where[2]);
  return {
    hold,
    materials: { cloth, gear, skin, steel },
    geo: {
      torso: about(torso, AT.torso),
      skirt: skirt && about([skirt], AT.skirt),
      rig: about(rig, AT.rig),
      head: mergeIntoOne(head),
      headKit: mergeIntoOne(headKit),
      arm: mergeIntoOne(arm),
      fore: mergeIntoOne(fore),
      leg: mergeIntoOne(leg),
      shin: mergeIntoOne(shin),
      gun: mergeIntoOne(gun),
      // the marker band, round the chest over whatever is worn there
      band: about([wrap(1.325, 1.385, band, null, { lip: 0.02 })], AT.band),
      // two lenses, in the goggles' cups
      eye: mergeIntoOne([-0.042, 0.042].map((x) => turned([[0, 0.002], [0.025, 0.002], [0.025, -0.004], [0, -0.006]], 10).translate(x, 0, 0))),
      shadow: new THREE.PlaneGeometry(1.5, 1.5),
      beam: null,
    },
  };
}

/**
 * A hostile, assembled from its archetype's kit. Parts are tagged for hit
 * zones; anything untagged is not raycast against, which is why the detail
 * is merged into the parts that are rather than hung beside them.
 */
function buildBody(type) {
  const kit = kitFor(type);
  const hold = kit.hold;
  const { cloth, gear, skin, steel } = kit.materials;
  const geo = kit.geo;
  const g = new THREE.Group();

  const parts = {};
  // Everything above the belt hangs off `upper`, which pivots at the waist:
  // that is what turns the shoulders into a shooting stance, leans a run and
  // takes a hit. Positions stay written in the body's own frame (`AT`) and
  // are taken back to the parent here, so a part's position is still where
  // that part is.
  const upper = new THREE.Group();
  upper.position.set(...AT.waist);
  g.add(upper);
  parts.upper = upper;
  const local = (where, parent) => (parent === upper
    ? [where[0] - AT.waist[0], where[1] - AT.waist[1], where[2] - AT.waist[2]] : where);
  const add = (mesh, where, zone, key, parent = g) => {
    const at = local(where, parent);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = true;
    mesh.userData.zone = zone;
    parent.add(mesh);
    if (key) parts[key] = mesh;
    return mesh;
  };

  add(new THREE.Mesh(geo.torso, cloth), AT.torso, 'body', 'torso', upper);
  add(new THREE.Mesh(geo.rig, gear), AT.rig, 'body', 'rig', upper);
  // A coat's skirt is a mesh no hostile used to have, and a hostile is built
  // mid-run out of the stream that picks the next spawn; minted inside
  // `reserve`, a spawn still costs that stream what it always did.
  if (geo.skirt) add(reserve(() => new THREE.Mesh(geo.skirt, cloth)), AT.skirt, 'body', 'skirt');
  // the head turns on a neck of its own, so it can stay on the target while
  // the shoulders blade into a stance
  const neck = new THREE.Group();
  neck.position.set(...local(AT.head, upper));
  upper.add(neck);
  parts.neck = neck;
  const atNeck = (where) => [where[0] - AT.head[0], where[1] - AT.head[1], where[2] - AT.head[2]];
  add(new THREE.Mesh(geo.head, skin), [0, 0, 0], 'head', 'head', neck);
  add(new THREE.Mesh(geo.headKit, gear), atNeck(AT.headKit), 'head', 'headKit', neck);

  // The archetype band and the eye stay flat-shaded and per-instance: one
  // turns gold on an elite and the other flares white when hurt, and a
  // material shared across a wave would do it to all of them at once.
  const band = new THREE.Mesh(geo.band, new THREE.MeshBasicMaterial({ color: type.marker || 0xd8452f }));
  band.position.set(...local(AT.band, upper));
  upper.add(band);
  parts.band = band;

  const eye = new THREE.Mesh(geo.eye, new THREE.MeshBasicMaterial({ color: type.eye ?? 0xff4a2a }));
  eye.position.set(...atNeck(AT.eye));
  neck.add(eye);
  parts.eye = eye;

  // each limb is two pieces, the lower one parented at the joint
  const limbPair = (upperGeo, lowerGeo, mat, where, key, lowerKey, joint, parent) => {
    const top = add(new THREE.Mesh(upperGeo, mat), where, 'limb', key, parent);
    const low = new THREE.Mesh(lowerGeo, mat);
    low.position.set(0, -joint, 0);
    low.castShadow = true;
    low.userData.zone = 'limb';
    top.add(low);
    parts[lowerKey] = low;
  };
  limbPair(geo.arm, geo.fore, cloth, AT.armL, 'armL', 'foreL', ARM.upper, upper);
  limbPair(geo.arm, geo.fore, cloth, AT.armR, 'armR', 'foreR', ARM.upper, upper);
  limbPair(geo.leg, geo.shin, gear, AT.legL, 'legL', 'shinL', LEG.thigh, g);
  limbPair(geo.leg, geo.shin, gear, AT.legR, 'legR', 'shinR', LEG.thigh, g);

  // weapon in the right hand
  const weapon = new THREE.Group();
  weapon.add(new THREE.Mesh(geo.gun, steel));
  if (type.laser) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    beam.geometry.translate(0, 0.5, 0);
    beam.geometry.rotateX(Math.PI / 2);
    beam.visible = false;
    beam.frustumCulled = false;
    g.add(beam);
    parts.beam = beam;
  }

  weapon.position.set(...AT.weapon);
  g.add(weapon);
  parts.weapon = weapon;
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.75);
  weapon.add(muzzle);
  parts.muzzle = muzzle;

  // Contact shadow. The sun's shadow map only covers the area around the
  // player, so distant hostiles would otherwise float; this grounds every one
  // of them at any range, and follows them onto rooftops. Its material fades
  // per hostile as one dies or bobs, so it stays per-instance.
  const shadow = new THREE.Mesh(geo.shadow, new THREE.MeshBasicMaterial({
    map: blobShadow(), transparent: true, depthWrite: false,
    opacity: 0.75, blending: THREE.NormalBlending,
  }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.renderOrder = -1;
  g.add(shadow);
  parts.shadow = shadow;

  g.scale.setScalar(type.scale);
  // yaw outermost, so a lean or a topple is about the body's own axes
  g.rotation.order = 'YXZ';

  // The rig's meshes are not drawn: `HostileBatches` draws every hostile of
  // an archetype in one call a part. They stay where they are, hidden, as
  // the skeleton the batches read and the thing `hitscan` shoots — a raycast
  // ignores `visible`, and the matrices are kept current either way.
  const drawn = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    const key = BATCHED.find((k) => geo[k] === o.geometry);
    if (!key) return;
    o.userData.batch = key;
    o.visible = false;
    drawn.push(o);
  });
  g.userData.drawn = drawn;
  g.userData.archetype = type.name;
  return { group: g, parts, hold };
}

/**
 * Which of a kit's geometries are drawn instanced, and how many of each one
 * body carries. The contact shadow and the laser stay a mesh per hostile:
 * each fades on its own opacity, which an instance cannot carry, and neither
 * casts a shadow, so each is one call rather than three.
 */
const BATCHED = ['torso', 'skirt', 'rig', 'head', 'headKit', 'arm', 'fore', 'leg', 'shin', 'gun', 'band', 'eye'];
const PER_BODY = { arm: 2, fore: 2, leg: 2, shin: 2 };
const TINTED = new Set(['band', 'eye']);
const NO_RAYCAST = () => {};

/**
 * Every hostile in the scene, drawn as one `InstancedMesh` per archetype and
 * part.
 *
 * A hostile is fourteen drawn meshes, nine of which cast a shadow, so it was
 * about forty draw calls a frame across the main pass and both cascades, and
 * a wave was most of the frame's calls. Every raider's left shin is the same
 * geometry and the same material as every other raider's, so this keeps one
 * batch for each and writes the instances from the rigs just before each
 * render (`scene.onBeforeRender`, which three calls after it has brought every
 * matrix up to date). A batch costs its calls whether it holds one hostile or
 * twenty, and an archetype with nobody standing is hidden and costs none.
 *
 * Built at boot inside `reserve`, like the kits it draws: every batch is an
 * object, and an object minted out of the seeded stream mid-run would move
 * every spawn after it. Growing a batch is done the same way.
 *
 * The rigs are untouched and stay the authority: `hitscan` raycasts their
 * meshes, every check reads their parts, and the low tier dresses them on
 * spawn as it always did. What the batches add is the drawing, and the one
 * thing they give up is culling a hostile on its own — at a hostile's
 * triangle count that is cheaper than the calls it used to take.
 */
export class HostileBatches {
  constructor(scene, capacity = 16) {
    this.scene = scene;
    this.bodies = new Set();
    this.root = new THREE.Group();
    this.root.name = 'hostiles';
    this.byType = new Map();
    this.white = new THREE.Color(1, 1, 1);
    for (const type of Object.values(ENEMY_TYPES)) {
      const kit = kitFor(type);
      const { cloth, gear, skin, steel } = kit.materials;
      const material = {
        torso: cloth, skirt: cloth, rig: gear, head: skin, headKit: gear, arm: cloth, fore: cloth,
        leg: gear, shin: gear, gun: steel,
        band: new THREE.MeshBasicMaterial({ color: 0xffffff }),
        eye: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      };
      const set = {};
      // an archetype draws only the parts it has: not everyone wears a coat
      for (const key of BATCHED) {
        if (kit.geo[key]) set[key] = this._make(kit.geo[key], material[key], capacity * (PER_BODY[key] || 1), key);
      }
      this.byType.set(type.name, set);
    }
    scene.add(this.root);
    const before = scene.onBeforeRender;
    scene.onBeforeRender = (...args) => { before.apply(scene, args); this.sync(); };
  }

  _make(geometry, material, capacity, key) {
    const m = new THREE.InstancedMesh(geometry, material, capacity);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (TINTED.has(key)) {
      m.setColorAt(0, this.white);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    } else {
      m.castShadow = true;
    }
    m.count = 0;
    m.visible = false;
    // the batch is drawn as a whole, wherever its hostiles are; and it is
    // never shot, the rigs are
    m.frustumCulled = false;
    m.raycast = NO_RAYCAST;
    m.userData.batch = key;
    m.userData.capacity = capacity;
    this.root.add(m);
    return m;
  }

  /** A body built by `buildBody` — a hostile, or one shown to the compile. */
  track(group) { this.bodies.add(group); }

  untrack(group) { this.bodies.delete(group); }

  /** Write every shown hostile into its archetype's batches. */
  sync() {
    for (const set of this.byType.values()) for (const batch of Object.values(set)) batch.count = 0;
    for (const group of this.bodies) {
      if (!this._shown(group)) continue;
      const set = this.byType.get(group.userData.archetype);
      for (const mesh of group.userData.drawn) {
        if (!this._shown(mesh.parent, group)) continue;
        const key = mesh.userData.batch;
        let batch = set[key];
        if (batch.count >= batch.userData.capacity) batch = set[key] = this._grow(batch);
        const i = batch.count++;
        batch.setMatrixAt(i, mesh.matrixWorld);
        if (batch.instanceColor) batch.setColorAt(i, mesh.material.color);
      }
    }
    for (const set of this.byType.values()) {
      for (const batch of Object.values(set)) {
        batch.visible = batch.count > 0;
        if (!batch.visible) continue;
        batch.instanceMatrix.needsUpdate = true;
        if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
      }
    }
  }

  /**
   * Whether `o` and everything above it, up to `top` or the scene, is shown.
   * A rig mesh counts as shown: they are all hidden, and a shin hangs off
   * its thigh.
   */
  _shown(o, top = null) {
    for (; o; o = o.parent) {
      if (!o.visible && !o.userData.batch) return false;
      if (o === top || o === this.scene) return true;
    }
    return false;
  }

  _grow(batch) {
    const grown = reserve(() => this._make(batch.geometry, batch.material, batch.userData.capacity * 2, batch.userData.batch));
    this.root.remove(batch);
    batch.dispose();
    return grown;
  }

  /** Every batch, for a check or a compile to walk. */
  get meshes() { return this.root.children; }
}

export class Enemy {
  constructor(typeKey, scene, game) {
    this.typeKey = typeKey;
    this.type = ENEMY_TYPES[typeKey];
    this.game = game;
    const built = buildBody(this.type);
    this.group = built.group;
    this.parts = built.parts;
    this.hold = {
      grip: new THREE.Vector3(...built.hold.grip),
      fore: new THREE.Vector3(...built.hold.fore),
      mag: built.hold.mag ? new THREE.Vector3(...built.hold.mag) : null,
    };
    this.poleR = new THREE.Vector3(0.7, -1, 0.35);
    this.fist = ARM.fore;     // elbow to the middle of the fist
    this.poleL = new THREE.Vector3(-0.8, -1, 0.1);
    this.hitMeshes = [];
    this.group.traverse((o) => {
      if (o.isMesh && o.userData.zone) { o.userData.enemy = this; this.hitMeshes.push(o); }
    });
    scene.add(this.group);
    game.hostiles?.track(this.group);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = 0.45 * this.type.scale;
    this.reset();
  }

  reset() {
    this.hp = this.type.hp;
    this.maxHp = this.type.hp;
    this.alive = true;
    this.state = 'idle';
    this.frags = this.type.frags || 0;  // grenades it carries
    this.nextThrow = 0;               // game time it may next try to throw
    this.post = null;                 // a doorway it is covering (`Game.coverPost`)
    this.postAfter = 0;               // not before this time, after it left one
    this.pushUntil = 0;               // pushing while the player reloads
    this.alerted = false;
    this.nextFire = 0;
    this.burstLeft = 0;
    this.mag = this.type.mag || 0;   // rounds left before a reload
    this.reloadT = 0;                // seconds of reload still to go
    this.reloadCue = 0;              // which of its sounds have played
    this.crouch = 0;                 // 0 standing, 1 down behind cover
    this.stoop = 0;                  // how far the hips are down for a ceiling, in body units
    this.crouchWant = false;
    this.heard = null;               // where a far-off shot came from, while it listens
    this.heardUntil = 0;
    this.lookYaw = 0;                // the head's turn toward it, eased
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = randRange(1, 3);
    this.walkPhase = Math.random() * 6.28;
    this.footfall = null;     // which half-stride the last footfall was in
    this.deathT = 0;
    this.hurtFlash = 0;
    this.swingT = 0;
    this.aimT = 0;            // 0 at low ready, 1 shouldered
    this.kick = 0;            // recoil, decaying
    this.flinch = { x: 0, z: 0, vx: 0, vz: 0 };   // a spring, kicked by hits
    this.idleT = Math.random() * 6.28;
    this.aimPitch = 0;
    this.group.visible = true;
    this.group.rotation.set(0, 0, 0);
    this.parts.upper?.rotation.set(0, 0, 0);
    this.parts.upper?.position.set(...AT.waist);
    for (const k of ['legL', 'legR', 'shinL', 'shinR']) this.parts[k]?.rotation.set(0, 0, 0);
    this.group.scale.setScalar(this.type.scale);
    this.avoidDir = 0;
    this.avoidTimer = 0;
    this.routed = false;
    this.blindFor = 0;
    this.stuckTimer = 0;
    this.noProgress = 0;
    this.mantle = null;
    this.stair = null;        // the stairwell it is up, if any (`_stairWalk`)
    this.stairFrom = 0;       // the point of its walk it last reached
    this.stairTo = 0;         // and the one it is walking to
    this.flee = null;         // a lieutenant's route off the map ({ nav, exit })
    this.escort = null;       // the lieutenant it walks beside
    this.lieutenant = false;
    this.following = false;   // a holdout, cut loose
    this.lastDistCheck = Infinity;
    this.watchX = this.pos.x;
    this.watchZ = this.pos.z;
    this.watchPx = Infinity;
    this.watchPz = Infinity;
    this.trail = [];
    this.pos.y = 0;
    if (this.parts.beam) this.parts.beam.visible = false;
    this.applyElite(false);
  }

  /** What the killfeed calls this hostile. */
  get displayName() { return this.elite ? 'WARLORD' : this.type.name; }

  /** Points awarded for putting it down. */
  get scoreValue() { return this.type.score * (this.elite ? 3 : 1); }

  /**
   * Elite variant: a scaled-up, tougher, higher-value version used for the
   * boss that closes out every fifth wave.
   */
  applyElite(on) {
    this.elite = on;
    const s = this.type.scale * (on ? 1.45 : 1);
    this.group.scale.setScalar(s);
    this.radius = 0.45 * s;
    if (this.parts.band) this.parts.band.material.color.setHex(on ? 0xffd23f : (this.type.marker || 0xd8452f));
  }

  spawn(x, z, waveScale = 1, y = 0) {
    this.reset();
    this.hp = this.maxHp = Math.round(this.type.hp * waveScale);
    this.pos.set(x, y, z);
    this.group.position.copy(this.pos);
    this.markWatchdog();
  }

  /**
   * Forget everything the stuck watchdog knows about this hostile's history.
   *
   * Called after any move that is not the hostile's own walking — a spawn, a
   * relocation. Measuring the next window, or the next horizon, against a
   * position it no longer occupies is what turned one relocation into a chain
   * of them.
   */
  markWatchdog(player = this.game.player) {
    this._snapshotWindow(player);
    this.trail.length = 0;
  }

  /**
   * Snapshot what one watchdog window measures progress against: where this
   * hostile stood, where its target stood, and how far apart the two were.
   * Taken after every window — unlike the horizon in `trail`, which spans
   * several of them and so survives one.
   */
  _snapshotWindow(player) {
    this.watchX = this.pos.x;
    this.watchZ = this.pos.z;
    this.watchPx = player.position.x;
    this.watchPz = player.position.z;
    this.lastDistCheck = Math.hypot(player.position.x - this.pos.x, player.position.z - this.pos.z);
    this.stuckTimer = 0;
  }

  /**
   * Wake this hostile up — from sight, proximity, gunfire or being shot.
   * `readyIn` holds their fire briefly so the player is never insta-shot by
   * something that just noticed them.
   */
  alert(time = 0, readyIn = randRange(0.55, 1.3)) {
    if (this.alerted || !this.alive || this.type.friendly) return;
    this.alerted = true;
    this.nextFire = Math.max(this.nextFire, time + readyIn);
    this.nextThrow = Math.max(this.nextThrow, time + 3);
    if (Math.random() < 0.3) audio.enemyAlert({ x: this.pos.x, y: this.pos.y + 1.5, z: this.pos.z });
  }

  /**
   * A shot heard from too far off to come looking: the head turns toward it
   * for a few seconds, and that is all — a tell that it has noticed you,
   * before it does anything about it.
   */
  hear(x, z, time) {
    if (this.alerted || !this.alive || this.type.friendly) return;
    this.heard = { x, z };
    this.heardUntil = time + 2.5;
  }

  /** @returns {'kill'|'hit'|null} */
  damage(amount, zone, fromDir, point) {
    if (!this.alive) return null;
    let dmg = amount;
    if (zone === 'head') dmg *= 1;      // multiplier already applied by shooter
    else if (zone === 'limb') dmg *= 0.75;
    this.hp -= dmg;
    this.hurtFlash = 0.12;
    // the shot shoves the upper body the way it was travelling, in the
    // body's own frame: a spring takes it back over a few tenths of a second
    if (fromDir) {
      const yaw = this.group.rotation.y, c = Math.cos(yaw), sn = Math.sin(yaw);
      const lx = fromDir.x * c - fromDir.z * sn, lz = fromDir.x * sn + fromDir.z * c;
      const hard = Math.min(1.6, 0.5 + dmg / 40) * (zone === 'head' ? 1.5 : 1);
      this.flinch.vx += lz * 4.5 * hard;
      this.flinch.vz -= lx * 4.5 * hard;
    }
    this.alert(this.game.time, 0.35);
    this.game.effects.blood(point, fromDir);
    if (this.hp <= 0) {
      this.die(fromDir);
      return 'kill';
    }
    audio.flesh(point || this.pos);
    return 'hit';
  }

  die(fromDir) {
    // killed halfway up a wall: fall to whatever is under it, not hang there
    if (this.mantle) {
      this.mantle = null;
      this.pos.y = this.game.world.groundHeight(this.pos.x, this.pos.z, SUPPORT_RADIUS, this.pos.y + 0.05);
    }
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.vel.set(0, 0, 0);
    this.fallDir = Math.atan2(fromDir ? fromDir.x : 0, fromDir ? fromDir.z : 1);
    this.game.effects.gib(V1.copy(this.pos).setY(this.pos.y + 1.2));
    audio.flesh(V1);
  }

  /**
   * Point `out` at the player.
   *
   * With a clear view that is simply toward them, which is what it has always
   * been and what makes a hostile in a firefight read as coming for you.
   * Without one it is whichever way the route field says, because straight at
   * someone you cannot see is how a hostile ends up walking into the wall of
   * the building standing between you and sliding along it until the watchdog
   * takes pity. The field declines to answer for anywhere it does not cover —
   * a rooftop, a spot cut off from the player entirely — and then this falls
   * back to the old behaviour, which is the right fallback: steering at them
   * is wrong far less often than it is right.
   */
  _approach(out, toPlayer, sees, nav) {
    // the route field is a map of the street: up on a roof it would route
    // from the shop underneath
    if (!sees && nav && !this.stair && nav.heading(this.pos.x, this.pos.z, out)) {
      this.routed = true;
      return out;
    }
    this.routed = false;
    return out.copy(toPlayer);
  }

  /**
   * Up or down a stairwell, toward wherever the player is on it.
   *
   * The route field is one grid at street level and knows nothing of a
   * roof, so this is the part that does: while the player is up a stair, the
   * field is built from the foot of it (`Game.update`), a hostile in the
   * street follows it there, and from the foot it walks the stair's own list
   * of points — through the door, up each flight, across each landing and
   * out of the bulkhead — one at a time. It turns round mid-flight when the
   * player does, comes back down the same way when the player leaves, and
   * forgets the stair at its foot. A body sent up stoops under each flight
   * (`_headroom`) and collides at its stooped height while it is on one, so
   * the question at the foot is whether it fits stooped under the headroom
   * of a flight. A juggernaut does, and every elite but a warlord.
   *
   * @returns {false|'out'|'in'|'with'} false when there is no stair in it;
   *   'out' when walking open ground or a roof toward one, where avoidance
   *   still applies; 'in' inside the shaft or at a door, where it does not,
   *   and nor does climbing or the edge guard; 'with' when on the player's
   *   own flight, and `out` points at them
   */
  _stairWalk(out, player, toPlayer, world) {
    const here = this.game.playerStair;
    if (this.stair) {
      const r = this.stair.roof;
      if (this.pos.x < r.minX - 2 || this.pos.x > r.maxX + 2 || this.pos.z < r.minZ - 2 || this.pos.z > r.maxZ + 2) this.stair = null;
    }
    if (!this.stair) {
      if (!here || !fitsStair(this, here.stair)) return false;
      const foot = here.stair.path[0];
      const d = Math.hypot(foot.x - this.pos.x, foot.z - this.pos.z);
      if (d > 0.7 || Math.abs(this.pos.y - foot.y) > 0.6) {
        // to the foot of it, by the route field, which is built from there
        const nav = this.game.nav;
        if (d < 4 || !nav || !nav.heading(this.pos.x, this.pos.z, out)) out.set(foot.x - this.pos.x, 0, foot.z - this.pos.z).normalize();
        this.routed = true;
        return d < 2.5 ? 'in' : 'out';
      }
      this.stair = here.stair;
      this.stairFrom = 0;
      this.stairTo = 0;
    }
    const s = this.stair, path = s.path, last = path.length - 1;
    const want = here && here.stair === s ? here.idx : 0;
    // turned round mid-flight: walk back to the point just left
    if ((want > this.stairFrom && this.stairTo < this.stairFrom) || (want < this.stairFrom && this.stairTo > this.stairFrom)) {
      const t = this.stairFrom; this.stairFrom = this.stairTo; this.stairTo = t;
    }
    const at = path[this.stairTo];
    if (Math.hypot(at.x - this.pos.x, at.z - this.pos.z) < (this.stairTo === 0 || this.stairTo === last ? 0.7 : 0.45)
        && Math.abs(at.y - this.pos.y) < 0.7) {
      if (this.stairTo !== this.stairFrom) {
        // a point reached is progress the watchdog cannot see: the walk up
        // is laps of a shaft a few metres across
        this.markWatchdog(player);
        this.noProgress = 0;
      }
      this.stairFrom = this.stairTo;
    }
    if (this.stairFrom === this.stairTo) {
      if (this.stairFrom === want) {
        if (want === 0) { this.stair = null; return false; }   // back in the street
        if (want === last) return false;                        // on the roof with them
        out.copy(toPlayer);
        return 'with';
      }
      this.stairTo = this.stairFrom + Math.sign(want - this.stairFrom);
    }
    const to = path[this.stairTo];
    out.set(to.x - this.pos.x, 0, to.z - this.pos.z);
    if (out.lengthSq() > 1e-6) out.normalize();
    // out on the roof, heading for the bulkhead with the hut perhaps between
    if (this.stairFrom === last && Math.hypot(to.x - this.pos.x, to.z - this.pos.z) > 2.5) return 'out';
    return 'in';
  }

  /**
   * A throw that lands: fly a frag from the hand at each of a few angles
   * toward the player, and toward the inside of each doorway of the building
   * they are in, through the same bounce and roll the grenade will take, and
   * keep the one that comes to rest nearest them with a line from the blast
   * to them. Through a doorway is how one gets into a shop; over a parapet is
   * how one gets onto a roof. Null when nothing lands close enough.
   *
   * @returns {THREE.Vector3|null} launch velocity (shared; copy it)
   */
  _planThrow(player, world) {
    const ox = this.pos.x, oy = this.pos.y + 1.6 * this.type.scale, oz = this.pos.z;
    const P = player.position;
    const targets = [[P.x, player.feetY + 0.2, P.z]];
    const room = this.game.playerRoom;
    // in at a doorway — not while they are up the stair, where the shop's
    // doors are nowhere near them
    if (room && !this.game.playerStair) for (const d of room.doors) targets.push([d.x - d.nx * 1.5, room.floor + 0.2, d.z - d.nz * 1.5]);
    let best = Infinity;
    const out = TH_D;
    for (const [tx, ty, tz] of targets) {
      const dx = tx - ox, dz = tz - oz, d = Math.hypot(dx, dz);
      if (d < 2) continue;
      const ux = dx / d, uz = dz / d, h = ty - oy;
      for (const a of THROW.angles) {
        const c = Math.cos(a), denom = 2 * c * c * (d * Math.tan(a) - h);
        if (denom <= 0) continue;
        const v = Math.sqrt(GRAVITY_FRAG * d * d / denom);
        if (v > THROW.fastest) continue;
        TH_V.set(ux * v * c, v * Math.sin(a), uz * v * c);
        const vx = TH_V.x, vy = TH_V.y, vz = TH_V.z;
        // fly it
        TH_P.set(ox, oy, oz);
        for (let t = 0; t < FUSE_LEFT; t += THROW.step) {
          TH_V.y -= GRAVITY_FRAG * THROW.step;
          TH_P.addScaledVector(TH_V, THROW.step);
          if (world.bounceSphere(TH_P, TH_V, 0.09) === 2) {
            const drag = Math.max(0, 1 - 2.6 * THROW.step);
            TH_V.x *= drag; TH_V.z *= drag;
          }
          world.clampToBounds(TH_P, 0.1);
        }
        const miss = Math.hypot(TH_P.x - P.x, TH_P.y - (P.y - 0.9), TH_P.z - P.z);
        if (miss > THROW.reach || miss >= best) continue;
        if (Math.hypot(TH_P.x - ox, TH_P.z - oz) < 5) continue;           // not at its own feet
        if (!world.lineOfSight(TH_P.x, TH_P.y + 0.75, TH_P.z, P.x, P.y, P.z)) continue;
        best = miss;
        out.set(vx, vy, vz);
      }
    }
    return best < Infinity ? out : null;
  }

  update(dt, time, player, world) {
    if (!this.alive) {
      this.deathT += dt;
      // The knees go first, then the body follows the killing shot down. The
      // topple is about the body's own axes (`rotation.order` is YXZ), so the
      // shot's direction is taken into the body's frame before it is used.
      const P = this.parts;
      const buckle = Math.min(1, this.deathT / 0.28);
      const kb = buckle * buckle * (3 - 2 * buckle);
      for (const [thigh, shin] of [[P.legL, P.shinL], [P.legR, P.shinR]]) {
        thigh.rotation.x = 0.75 * kb;
        shin.rotation.x = -1.5 * kb;
      }
      const t = THREE.MathUtils.clamp((this.deathT - 0.12) / 0.6, 0, 1);
      const fall = Math.sin(t * Math.PI * 0.5) * (Math.PI / 2);
      const a = this.fallDir - this.group.rotation.y;
      this.group.rotation.x = Math.cos(a) * fall;
      this.group.rotation.z = -Math.sin(a) * fall;
      // the arms go slack and the upper body folds the way it is falling
      P.upper.rotation.x = Math.cos(a) * 0.35 * kb;
      for (const [arm, fore, side] of [[P.armL, P.foreL, -1], [P.armR, P.foreR, 1]]) {
        arm.rotation.set(-0.3 * kb, 0, side * 0.5 * kb);
        fore.rotation.set(-0.6 * kb, 0, 0);
      }
      // killed stooped under a ceiling, it goes down from there, not from full height
      this.group.position.y = this.pos.y - 0.42 * kb - this.stoop * this.group.scale.x * (1 - kb);
      if (this.parts.shadow) this.parts.shadow.material.opacity = 0.75 * Math.max(0, 1 - this.deathT);
      if (this.deathT > 6) {
        const k = Math.max(0, 1 - (this.deathT - 6) / 1.5);
        this.group.scale.setScalar(this.type.scale * k);
        if (k <= 0.01) this.group.visible = false;
      }
      return;
    }

    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (this.type.friendly) { this._follow(dt, player, world); return; }

    const toPlayer = V1.copy(player.position).sub(this.pos);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    toPlayer.normalize();
    const heightGap = player.position.y - (this.pos.y + 1.5);

    // a hostile down behind cover is looking from where its eyes are
    const eyeY = this.pos.y + (1.5 - CROUCH.drop * this.crouch - this.stoop) * this.type.scale;
    const sees = dist < this.type.detect &&
      world.lineOfSight(this.pos.x, eyeY, this.pos.z, player.position.x, player.position.y, player.position.z);

    // spotted the target, or got close enough to hear them
    if (!this.alerted && ((sees && dist < this.type.detect) || dist < 16)) this.alert(time);

    // Anything that fights from high ground stays on it: it overwatches while
    // unalerted and never walks itself back down to street level.
    const onPerch = this.type.perch && this.pos.y > 1.5;
    this.blindFor = sees ? 0 : this.blindFor + dt;
    // A post with nothing in front of it is not a post. This never walks a
    // marksman off its roof — it only stops the watchdog treating a blind
    // one as busy, and the watchdog relocates rather than walks.
    const parked = onPerch && this.blindFor > PERCH_PATIENCE;

    // A climb owns the body for its duration, the way a pull-up owns the
    // player: no walking, no turning away, no firing.
    if (this.mantle) {
      this._advanceClimb(dt);
      this.group.position.copy(this.pos);
      this._updateLaser(player, false, time);
      this._animate(dt, dist);
      this.group.updateMatrixWorld(true);
      return;
    }

    if (this.reloadT > 0) this._advanceReload(dt, dist);

    const nav = this.game.nav;
    let moveDir = V2.set(0, 0, 0);
    // A stairwell between it and the player, or under its feet: which way
    // along it, if that is where it is going. Never for a perch-holder.
    const game = this.game;
    // The player is reloading or changing weapon: everything near comes for
    // them now, and anything holding a post gives it up for a while.
    if (this.alerted && !onPerch && game.playerExposed && dist < PUSH.range) {
      if (time >= this.pushUntil) game.onPush?.(this);
      this.pushUntil = time + PUSH.hold;
      if (this.post) { this.post = null; this.postAfter = time + 8; }
    }
    const pushing = time < this.pushUntil;
    // The player has gone into a building: a ranged hostile covers a doorway
    // from outside rather than walking in after them (`Game.coverPost`
    // hands out at most two posts a building, so the rest still come in).
    this.post = this.alerted && !onPerch && !this.type.melee && !pushing && !this.stair && !this.flee && time >= this.postAfter
      ? (game.coverPost?.(this) || null) : null;
    const post = this.post;
    const stairDir = V5;
    const stairs = onPerch || post || this.flee ? false : this._stairWalk(stairDir, player, toPlayer, world);
    const inShaft = stairs === 'in' || stairs === 'with';
    // Walking beside a lieutenant, it has not been told about you yet.
    const escorting = !this.alerted && this.escort && this.escort.alive;
    // Going for a live charge, it is not coming for you.
    const lure = game.lure;
    const lured = !!lure && this.alerted && !sees && !onPerch && !post && !stairs && !this.flee
      && Math.hypot(lure.x - this.pos.x, lure.z - this.pos.z) < CAST.lure;
    if (this.flee) {
      // A lieutenant makes for his exit by his own route field, and stops for
      // nothing: he shoots at you on the way if he can see you.
      const f = this.flee;
      if (!f.nav.heading(this.pos.x, this.pos.z, moveDir)) {
        moveDir.set(f.exit.x - this.pos.x, 0, f.exit.z - this.pos.z);
        if (moveDir.lengthSq() > 1e-6) moveDir.normalize();
      }
    } else if (escorting) {
      const l = this.escort, ex = l.pos.x - this.pos.x, ez = l.pos.z - this.pos.z, ed = Math.hypot(ex, ez);
      if (ed > CAST.escort) moveDir.set(ex / ed, 0, ez / ed);
    } else if (lured) {
      const lx = lure.x - this.pos.x, lz = lure.z - this.pos.z, ld = Math.hypot(lx, lz);
      if (ld > 0.4) moveDir.set(lx / ld, 0, lz / ld);
    } else if (!this.alerted) {
      // still hunting: drift toward the player at a walk
      if (stairs) moveDir.copy(stairDir);
      else if (!onPerch) this._approach(moveDir, toPlayer, sees, nav);
    } else {
      const t = this.type;
      const holdPerch = onPerch;
      const wantCloser = !holdPerch && dist > t.preferred * (t.melee ? 1 : 1.15);
      const wantBack = !t.melee && !holdPerch && dist < t.preferred * 0.6;

      if (post) {
        // to the post and then still on it, watching the door — by the route
        // field to a stair post it cannot see, which leads to the stair's foot
        const px = post.x - this.pos.x, pz = post.z - this.pos.z, pd = Math.hypot(px, pz);
        if (pd > 0.8) {
          if (!post.stair || !nav || nav.clearLine(this.pos.x, this.pos.z, post.x, post.z)
              || !nav.heading(this.pos.x, this.pos.z, moveDir)) moveDir.set(px / pd, 0, pz / pd);
          else this.routed = true;
        }
      } else if (stairs && (inShaft || !sees || t.melee || wantCloser || pushing)) {
        // Up after them, or down after them: a hostile in the street with a
        // clear shot at a roof still takes it, and one on a roof with a shot
        // down into the street holds the roof — both are using the building.
        moveDir.copy(stairDir);
      } else if (pushing) {
        // their gun is empty: close, whatever range this one likes to hold
        if (sees) moveDir.copy(toPlayer);
        else this._approach(moveDir, toPlayer, sees, nav);
      } else if (!sees && !onPerch) {
        // Nothing to hold a range against and nothing to strafe around: go
        // and find them, by whatever way there is to get there. Holding high
        // ground is the one reason not to.
        this._approach(moveDir, toPlayer, sees, nav);
      } else {
        if (wantCloser) moveDir.copy(toPlayer);
        else if (wantBack) moveDir.copy(toPlayer).negate();

        // strafe when holding position and able to see the target — but never
        // on a perch, where side-stepping walks you off the edge
        if (!wantCloser && sees && !onPerch) {
          this.strafeTimer -= dt;
          if (this.strafeTimer <= 0) { this.strafe *= -1; this.strafeTimer = randRange(1.2, 3); }
          moveDir.x += -toPlayer.z * this.strafe * 0.9;
          moveDir.z += toPlayer.x * this.strafe * 0.9;
        }
      }
    }

    // Down behind cover for a reload, it stays down: walking would take it
    // out from behind the thing it crouched for.
    if (this.reloadT > 0 && this.crouchWant) { moveDir.set(0, 0, 0); this.vel.set(0, 0, 0); }

    // ---- climbing ---------------------------------------------------------
    // You are on something it could follow you onto: go straight at it, and
    // up. Avoidance below would otherwise turn it aside two metres out, from
    // every face it could climb, so it would never reach the lip.
    // Only one already coming for you: a raider strafing at its range, or
    // backing off to hold it, has no business charging a car.
    let climbing = false;
    if (this.alerted && !onPerch && !inShaft && !this.flee && !lured && moveDir.dot(toPlayer) > 0.7 * moveDir.length()
        && player.feetY > this.pos.y + CLIMB.above && dist < CLIMB.near) {
      const ahead = world.mantleTarget(this.pos.x, this.pos.z, this.radius, this.pos.y,
        toPlayer.x, toPlayer.z, CLIMB.min, CLIMB.max, 1.8 + this.radius);
      if (ahead) {
        moveDir.copy(toPlayer);
        climbing = true;
        if (this._tryClimb(world, toPlayer)) {
          this._animate(dt, dist);
          this.group.updateMatrixWorld(true);
          return;
        }
      }
    }

    // ---- obstacle avoidance --------------------------------------------
    // The last few metres, which the route field is too coarse to see: a
    // wreck in the street, another hostile's corner, the kerb of the very
    // building being rounded. Probe the heading; if it is blocked, fan
    // outwards and take the first clear direction.
    if (moveDir.lengthSq() > 1e-4 && !climbing && !inShaft) {
      moveDir.normalize();
      const probe = 1.8 + this.radius;
      const clear = (x, z) => !world.blocked(this.pos.x + x * probe, this.pos.z + z * probe, this.radius, this.pos.y + 0.9);
      const rot = (a, out) => {
        const cos = Math.cos(a), sin = Math.sin(a);
        return out.set(moveDir.x * cos - moveDir.z * sin, 0, moveDir.x * sin + moveDir.z * cos);
      };

      if (!clear(moveDir.x, moveDir.z)) {
        // Which way round, decided once and then kept. `avoidDir` of zero
        // means uncommitted, and it goes back to zero the moment the way
        // ahead opens up, so each new obstacle is judged on its own.
        this.avoidTimer -= dt;
        if (this.avoidDir === 0 || this.avoidTimer <= 0) {
          // Take the side with more room rather than flipping a coin. Only a
          // tie is settled at random, which keeps two hostiles meeting the
          // same corner from filing round it in single file.
          const room = (side) => {
            let n = 0;
            for (const a of [0.6, 1.2, 1.8]) {
              const cand = rot(a * side, V4);
              if (clear(cand.x, cand.z)) n++;
            }
            return n;
          };
          const right = room(1), left = room(-1);
          this.avoidDir = right === left
            ? (this.avoidDir || (Math.random() < 0.5 ? 1 : -1))
            : (right > left ? 1 : -1);
          this.avoidTimer = COMMIT;
        }
        let found = false;
        for (const a of [0.5, 1.0, 1.5, 2.0, 2.5]) {
          for (const side of [this.avoidDir, -this.avoidDir]) {
            const cand = rot(a * side, V4);
            if (clear(cand.x, cand.z)) { moveDir.copy(cand); found = true; break; }
          }
          if (found) break;
        }
        if (!found) moveDir.set(-moveDir.x, 0, -moveDir.z);   // boxed in: back out
      } else {
        this.avoidDir = 0;
      }
    }

    // ---- edges -----------------------------------------------------------
    // Up on something with you, it holds the deck. A melee hostile at its
    // range strafes, and on a car roof a strafe is a step off the edge: of
    // twelve that climbed after the player on seed 1, six were back in the
    // street within the next few seconds and had the whole climb to do again.
    // Following you down is still allowed — the guard is only for a drop you
    // are not at the bottom of.
    if (this.pos.y > CLIMB.min && player.feetY > this.pos.y - CLIMB.above && moveDir.lengthSq() > 1e-4 && !inShaft) {
      const k = (this.radius + 0.35) / moveDir.length();
      const below = world.groundHeight(this.pos.x + moveDir.x * k, this.pos.z + moveDir.z * k,
        SUPPORT_RADIUS, this.pos.y + 0.05);
      if (below < this.pos.y - 0.55) { moveDir.set(0, 0, 0); this.vel.set(0, 0, 0); }
    }

    // ---- stuck watchdog --------------------------------------------------
    // Geometry can still trap a hostile in a corner. If one has made no
    // progress for a long stretch, pull it out and re-insert it elsewhere so
    // a wave can never stall forever.
    // Someone holding a perch is doing their job while they wait for a target
    // to walk into view, so give them far longer before the watchdog moves
    // them — but not forever, or a wave could stall on a roof.
    // Nor is anything walking somewhere other than at you on purpose: a
    // lieutenant leaving, his escort beside him, a hostile going for a charge
    // — or standing still on purpose, on a post covering a door.
    this.stuckTimer += dt;
    const checkEvery = onPerch && !parked ? 12 : 4;
    const onPost = post && Math.hypot(post.x - this.pos.x, post.z - this.pos.z) < 1.5;
    if (this.flee || escorting || lured || onPost) {
      if (this.stuckTimer > checkEvery) { this._snapshotWindow(player); this.trail.length = 0; this.noProgress = 0; }
    } else if (this.stuckTimer > checkEvery) {
      const elapsed = this.stuckTimer;
      // Progress needs three measurements, because every one of them alone
      // lies. Closing distance alone condemns a hostile chasing a player who
      // simply walks faster than it — which is all of them — and that hostile
      // is doing nothing wrong. Own movement alone lets one orbit a wall
      // forever and look busy. And both of those are read over a single
      // window, which is too short to tell a slide along a wall from a lap
      // around a city block. So: wedged means it went nowhere at all this
      // window; lost means it covered ground without gaining any on a target
      // that was not running; adrift means that over several windows it ended
      // up where it started, however much walking it did in between.
      const travelled = Math.hypot(this.pos.x - this.watchX, this.pos.z - this.watchZ);
      const targetMoved = Math.hypot(player.position.x - this.watchPx, player.position.z - this.watchPz);
      const closed = this.lastDistCheck - dist;
      const wedged = travelled < 1;
      const lost = closed < 1.5 && targetMoved < travelled * 0.6;

      // The long horizon. A hostile with a building between it and the player
      // steers straight at them, slides along the wall face, reverses, and
      // slides back: metres of travel a window, no distance closed, and a net
      // displacement near zero. Nothing measured inside one window separates
      // that from a genuine detour, because a detour looks identical for its
      // first few seconds — only where it *ends up* tells them apart. Walking
      // around one city block is 34 m of frontage, so anything that covers
      // ground for ten seconds and lands within five metres of where it
      // started is not going anywhere.
      this.trail.push({ t: time, x: this.pos.x, z: this.pos.z });
      while (this.trail.length > 1 && time - this.trail[0].t > HORIZON + checkEvery) this.trail.shift();
      const anchor = this.trail[0];
      const spanned = time - anchor.t;
      const drift = Math.hypot(this.pos.x - anchor.x, this.pos.z - anchor.z);
      const adrift = spanned >= HORIZON * 0.75 && drift < DRIFT;

      // One holding its preferred range on purpose is exempt, so nobody gets
      // yanked mid-firefight, and neither is anyone already on top of you.
      const holdingRange = sees && (onPerch || dist <= this.type.preferred * 1.4);
      const stalled = (wedged || lost || adrift) && dist > 4 && !holdingRange;
      this.noProgress = stalled ? this.noProgress + elapsed : 0;

      // Several failed windows, not one. Walking around a city block costs
      // more than a single window, and a hostile that vanishes mid-approach
      // reads as a bug to the person watching it — which is why the last
      // guard is line of sight: never teleport one the player can see.
      if (this.noProgress >= (onPerch && !parked ? 24 : 12) &&
          !(sees || world.lineOfSight(player.position.x, player.position.y, player.position.z,
            this.pos.x, this.pos.y + 1.3 * this.type.scale, this.pos.z))) {
        this.game.relocateEnemy(this);
        this.noProgress = 0;
      } else {
        this._snapshotWindow(player);
      }
    }

    const speed = this.type.speed * (this.alerted || escorting ? 1 : 0.45) * (pushing ? PUSH.haste : 1) * (this.flee ? CAST.pace : 1);
    this.vel.lerp(V3.copy(moveDir).multiplyScalar(speed), Math.min(1, dt * 6));
    this.pos.addScaledVector(this.vel, dt);
    world.resolve(this.pos, this.radius, this.pos.y, 0.55, bodyHeight(this));
    world.clampToBounds(this.pos, this.radius);

    // Follow the surface underfoot: stairs and platforms carry hostiles too,
    // and stepping off a ledge drops them rather than leaving them floating.
    // Asked with the same foot the player stands on, or a hostile holds a
    // ledge you fall off and the two of you are walking different cities.
    const support = world.groundHeight(this.pos.x, this.pos.z, SUPPORT_RADIUS, this.pos.y + 0.55);
    if (support > this.pos.y) this.pos.y = Math.min(support, this.pos.y + dt * 6);
    else if (support < this.pos.y) this.pos.y = Math.max(support, this.pos.y - dt * 14);
    this._headroom(dt, world);

    // separation so crowds do not stack into one body
    for (const other of this.game.enemies) {
      if (other === this || !other.alive) continue;
      const dx = this.pos.x - other.pos.x, dz = this.pos.z - other.pos.z;
      const dsq = dx * dx + dz * dz;
      const minD = this.radius + other.radius;
      if (dsq < minD * minD && dsq > 1e-5) {
        const d = Math.sqrt(dsq);
        const push = (minD - d) * 0.5;
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
      }
    }

    this.group.position.copy(this.pos);

    // face the player once alerted, otherwise face travel direction
    // — or, in a stairwell with the player out of sight, the way it is going
    const travel = this.vel.lengthSq() > 0.05 ? V3.copy(this.vel).normalize() : null;
    // — or, leaving or going for a charge with the player out of sight, that way
    // — or, holding a post with the player out of sight, the door it covers
    const watch = post && !sees && Math.hypot(post.x - this.pos.x, post.z - this.pos.z) < 1.5
      ? V_WATCH.set(post.wx - this.pos.x, 0, post.wz - this.pos.z) : null;
    const faceTarget = watch || (this.alerted && !((inShaft || this.flee || lured) && !sees) ? toPlayer : travel);
    if (faceTarget) {
      // the body is built facing -z, so its yaw points -z along the target
      const want = Math.atan2(-faceTarget.x, -faceTarget.z);
      let diff = want - this.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.group.rotation.y += diff * Math.min(1, dt * 7);
    }

    // listening: the head turns toward a far-off shot, as far as a neck turns
    let lookWant = 0;
    if (!this.alerted && this.heard && time < this.heardUntil) {
      let a = Math.atan2(-(this.heard.x - this.pos.x), -(this.heard.z - this.pos.z)) - this.group.rotation.y;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      lookWant = THREE.MathUtils.clamp(a, -1.2, 1.2);
    }
    this.lookYaw += (lookWant - this.lookYaw) * Math.min(1, dt * 5);

    this._updateLaser(player, sees, time);
    // the gun follows the target's height, so a marksman on a roof aims down
    const pitchWant = this.alerted ? Math.atan2(player.position.y - 0.25 - (this.pos.y + 1.36 * this.type.scale), Math.max(1, dist)) : 0;
    this.aimPitch += (pitchWant - this.aimPitch) * Math.min(1, dt * 6);
    this._animate(dt, dist);
    // hit detection raycasts against these meshes before the renderer runs,
    // so their world matrices have to be current now, not next frame
    this.group.updateMatrixWorld(true);

    // ---- a frag --------------------------------------------------------
    // At a player who has gone to ground — out of sight for a few seconds,
    // or inside a building — from the second wave on. One hostile grenade
    // in the air at a time, and a gap after it, so each one is a warning.
    if (this.frags > 0 && this.alerted && !onPerch && !inShaft && !this.mantle && this.reloadT <= 0
        && time >= this.nextThrow && dist > THROW.minRange && dist < THROW.maxRange
        && (game.wave || 0) >= 2 && !player.dead
        && (this.blindFor > THROW.blind || game.playerRoom)
        && time >= (game.nextHostileThrow || 0) && game.grenades && !game.grenades.hostileLive()) {
      this.nextThrow = time + THROW.retry;
      const vel = this._planThrow(player, world);
      if (vel) {
        TH_P.set(this.pos.x, this.pos.y + 1.6 * this.type.scale, this.pos.z);
        if (game.grenades.lob(TH_P, vel, FUSE_LEFT)) {
          this.frags--;
          this.nextThrow = time + THROW.every;
          game.nextHostileThrow = time + THROW.gap;
          this.swingT = 0.25;                      // the arm comes over
          game.onHostileThrow?.(this);
        }
      }
    }

    // ---- shooting / melee ---------------------------------------------
    if (!this.alerted || !sees) return;
    const t = this.type;
    if (time < this.nextFire || this.reloadT > 0) return;

    if (t.melee) {
      if (dist < t.preferred + 0.9 && Math.abs(heightGap) < 1.8) {
        this.nextFire = time + t.rate + 0.6;
        this.swingT = 0.25;
        this.game.damagePlayer(t.damage, this.pos);
      }
      return;
    }

    if (dist > t.detect) return;
    // burst discipline
    if (t.burst) {
      if (this.burstLeft <= 0) this.burstLeft = t.burst;
      this.burstLeft--;
      this.nextFire = time + (this.burstLeft > 0 ? t.rate : t.burstPause * randRange(0.7, 1.3));
    } else {
      this.nextFire = time + t.rate * randRange(0.85, 1.3);
    }
    this._shoot(player, world);
    if (t.mag && --this.mag <= 0) this._startReload(player, world, dist, time);
  }

  /**
   * Out of rounds: a reload, which is a window — the fire stops for a second
   * or three, and it can be heard. If there is cover within reach that would
   * hide a crouched body from the target and not a standing one, it gets
   * down behind it for the duration and stays put.
   */
  _startReload(player, world, dist, time) {
    const t = this.type;
    this.reloadT = t.reload;
    this.reloadCue = 0;
    this.burstLeft = 0;
    const s = t.scale, p = player.position;
    const standing = world.lineOfSight(p.x, p.y, p.z, this.pos.x, this.pos.y + 1.25 * s, this.pos.z);
    const crouched = world.lineOfSight(p.x, p.y, p.z, this.pos.x, this.pos.y + (1.25 - CROUCH.drop) * s, this.pos.z);
    this.crouchWant = standing && !crouched;
    this._reloadSound('out', dist);
  }

  /** The reload's clock, and the sounds that go with its stages. */
  _advanceReload(dt, dist) {
    const t = this.type;
    this.reloadT = Math.max(0, this.reloadT - dt);
    const r = 1 - this.reloadT / t.reload;
    const cues = t.shells
      ? [...Array.from({ length: t.shells }, (_, i) => [0.15 + (0.7 * i) / t.shells, 'shell']), [0.9, 'bolt']]
      : [[0.55, 'in'], [0.85, 'bolt']];
    while (this.reloadCue < cues.length && r >= cues[this.reloadCue][0]) {
      this._reloadSound(cues[this.reloadCue][1], dist);
      this.reloadCue++;
    }
    if (this.reloadT <= 0) {
      this.mag = t.mag;
      this.crouchWant = false;
    }
  }

  _reloadSound(stage, dist) {
    if (dist > 30) return;
    this.parts.weapon.getWorldPosition(V3);
    audio.reload(stage, V3, THREE.MathUtils.clamp(10 / Math.max(3, dist), 0.12, 0.8));
  }

  _shoot(player, world) {
    const t = this.type;
    const muzzle = V3;
    this.parts.muzzle.getWorldPosition(muzzle);
    const dist = muzzle.distanceTo(player.position);
    const toPlayer = V4.copy(player.position).sub(muzzle).normalize();

    const shots = t.pellets || 1;
    let hits = 0;
    for (let i = 0; i < shots; i++) {
      const dir = V5.copy(toPlayer);
      dir.x += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.y += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.z += (Math.random() - 0.5) * 2 * t.accuracy;
      dir.normalize();

      // hit test against the player's capsule, approximated by angle
      const hitAngle = Math.atan2(0.4, Math.max(1.5, dist));
      if (toPlayer.dot(dir) > Math.cos(hitAngle)) hits++;

      this.game.effects.tracer(muzzle, V1.copy(muzzle).addScaledVector(dir, Math.min(dist + 2, 70)), 0.8);
    }

    this.game.effects.muzzle(muzzle, t.pellets ? 1.4 : 0.9);
    this.kick = Math.min(1.5, this.kick + (t.pellets ? 1.3 : 0.8));
    audio.shot(t.sound || 'rifle', THREE.MathUtils.clamp(14 / Math.max(3, dist), 0.16, 1), muzzle);

    if (hits > 0) {
      let dmg = t.damage * hits;
      if (t.falloff) dmg *= THREE.MathUtils.clamp(1 - (dist - t.preferred) / t.falloff, 0.25, 1);
      this.game.damagePlayer(dmg, this.pos);
    }
  }

  /** Sweep the aiming laser onto the target while the shot is lining up. */
  _updateLaser(player, sees, time) {
    const beam = this.parts.beam;
    if (!beam) return;
    const aiming = this.alerted && sees && this.reloadT <= 0 && this.nextFire - time < 1.1;
    beam.visible = aiming;
    if (!aiming) return;

    // The beam's position is parent-local while lookAt works in world space,
    // so both have to read the same transform: refresh it first, or a hostile
    // that just moved aims its laser at where it used to be.
    this.group.updateMatrixWorld(true);
    this.parts.muzzle.getWorldPosition(V3);
    // position is parent-local, but lookAt takes a world-space target, and
    // the length has to be divided out of the parent's scale
    beam.position.copy(beam.parent.worldToLocal(V4.copy(V3)));
    beam.lookAt(player.position);
    const scale = this.group.scale.x || 1;
    beam.scale.set(1 / scale, 1 / scale, V3.distanceTo(player.position) / scale);
    // pulses harder as the shot approaches
    beam.material.opacity = 0.25 + 0.5 * (1 - Math.max(0, (this.nextFire - time) / 1.1));
  }

  /**
   * Pose the body: legs from the gait, the upper body from the stance, and
   * the arms from wherever the weapon is — never the other way round.
   *
   * The weapon is posed first, in the body's own frame: shouldered and
   * pitched at the target once alerted, carried low and across the body on
   * patrol, raised and brought down through a swing for a melee strike, and
   * kicked back on every shot. Then each arm reaches for its hand-hold on it
   * (`reach`), so the hands are always on the gun whatever the gun is doing,
   * and an animation is only ever written once, for the gun.
   */
  /** Start a climb toward `dir` if there is a lip within an arm's length. */
  /**
   * A holdout: waits where it went to ground until cut loose, then follows
   * the player — by the route field when they are out of sight, straight at
   * them when not — standing off a couple of metres and hurrying when left
   * behind. It never fires and nothing here aims at it; what being exposed
   * costs it is `ObjectiveSystem.drainHoldout`.
   */
  _follow(dt, player, world) {
    const P = player.position;
    const dx = P.x - this.pos.x, dz = P.z - this.pos.z, dist = Math.hypot(dx, dz);
    const move = V2.set(0, 0, 0);
    if (this.following && dist > CAST.near) {
      // By the route field, all the way: a line of sight out of a shop runs
      // through a window as often as a door, and a holdout with no avoidance
      // walks straight into the wall under it. Straight at you only for the
      // last few metres, or where the field has no answer.
      const nav = this.game.nav;
      const close = dist < CAST.far && world.lineOfSight(this.pos.x, this.pos.y + 1.5, this.pos.z, P.x, P.y, P.z);
      if (close || !nav || !this._route(nav, move)) move.set(dx / dist, 0, dz / dist);
    }
    const speed = this.type.speed * (dist > CAST.far ? 1.2 : dist < CAST.near + 1.5 ? 0.55 : 1);
    this.vel.lerp(V3.copy(move).multiplyScalar(speed), Math.min(1, dt * 6));
    this.pos.addScaledVector(this.vel, dt);
    world.resolve(this.pos, this.radius, this.pos.y, 0.55, bodyHeight(this));
    world.clampToBounds(this.pos, this.radius);
    const support = world.groundHeight(this.pos.x, this.pos.z, SUPPORT_RADIUS, this.pos.y + 0.55);
    if (support > this.pos.y) this.pos.y = Math.min(support, this.pos.y + dt * 6);
    else if (support < this.pos.y) this.pos.y = Math.max(support, this.pos.y - dt * 14);
    for (const other of this.game.enemies) {
      if (other === this || !other.alive) continue;
      const ox = this.pos.x - other.pos.x, oz = this.pos.z - other.pos.z, d = Math.hypot(ox, oz);
      const minD = this.radius + other.radius;
      if (d < minD && d > 1e-3) { this.pos.x += (ox / d) * (minD - d) * 0.5; this.pos.z += (oz / d) * (minD - d) * 0.5; }
    }
    this.group.position.copy(this.pos);
    // facing the way it walks, or the player when it has caught up
    const face = this.vel.lengthSq() > 0.05 ? V3.copy(this.vel) : this.following ? V3.set(dx, 0, dz) : null;
    if (face && face.lengthSq() > 1e-6) {
      let diff = Math.atan2(-face.x, -face.z) - this.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.group.rotation.y += diff * Math.min(1, dt * 7);
    }
    this.lookYaw += (0 - this.lookYaw) * Math.min(1, dt * 5);
    this.aimPitch += (0 - this.aimPitch) * Math.min(1, dt * 6);
    this._animate(dt, dist);
    this.group.updateMatrixWorld(true);
  }

  /**
   * The route field's heading from here, or — pressed against a wall, inside
   * the shoulder the field keeps clear of every solid, where it has no
   * answer — toward whichever cell beside it is nearest the player by the
   * field. A hostile gets out of that shoulder by its avoidance; a holdout
   * has none, and steering straight at the player from there is steering
   * into the wall it is against.
   */
  _route(nav, out) {
    if (nav.heading(this.pos.x, this.pos.z, out)) return true;
    let best = -1, bx = 0, bz = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, ox = Math.cos(a), oz = Math.sin(a);
      const c = nav.costAt(this.pos.x + ox * nav.cell, this.pos.z + oz * nav.cell);
      if (c > 0 && (best < 0 || c < best)) { best = c; bx = ox; bz = oz; }
    }
    if (best < 0) return false;
    out.set(bx, 0, bz);
    return true;
  }

  /**
   * Down under a ceiling lower than its crown, by as much as it takes
   * (`STOOP`). Asked from the hips, not the feet: on a flight the tread two
   * steps up has its underside a few centimetres over the feet, and a body
   * asked from its feet stooped all the way up every stair.
   */
  _headroom(dt, world) {
    const s = this.group.scale.x;
    const room = world.ceilingAbove(this.pos.x, this.pos.z, this.radius, this.pos.y + STOOP.hip * s) - this.pos.y;
    const want = THREE.MathUtils.clamp((STOOP.top + STOOP.margin) - room / s, 0, STOOP.max);
    // quick to go down, slower to come back up
    this.stoop += (want - this.stoop) * Math.min(1, dt * (want > this.stoop ? 10 : 3));
  }

  _tryClimb(world, dir) {
    const ledge = world.mantleTarget(this.pos.x, this.pos.z, this.radius, this.pos.y,
      dir.x, dir.z, CLIMB.min, CLIMB.max);
    if (!ledge) return false;
    this.mantle = {
      t: 0, dur: CLIMB.base + (ledge.top - this.pos.y) * CLIMB.perM,
      fromX: this.pos.x, fromZ: this.pos.z, fromY: this.pos.y,
      x: ledge.x, z: ledge.z, top: ledge.top, land: ledge.land,
    };
    this.vel.set(0, 0, 0);
    return true;
  }

  /**
   * The same curve the player climbs on: up first, then over, then settled
   * onto the deck if it sits lower than the lip.
   */
  _advanceClimb(dt) {
    const m = this.mantle;
    m.t = Math.min(1, m.t + dt / m.dur);
    const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const rise = smooth(Math.min(1, m.t / 0.75));
    const reach = smooth(Math.max(0, (m.t - 0.3) / 0.7));
    const settle = smooth(Math.max(0, (m.t - 0.72) / 0.28));
    this.pos.y = m.fromY + (m.top - m.fromY) * rise - (m.top - m.land) * settle;
    this.pos.x = m.fromX + (m.x - m.fromX) * reach;
    this.pos.z = m.fromZ + (m.z - m.fromZ) * reach;
    if (m.t >= 1) {
      this.mantle = null;
      // the climb was its own walking: measure the next window from the top
      this.markWatchdog();
    }
  }

  _animate(dt, dist) {
    const P = this.parts;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // the stride advances with distance covered, not with time, so a foot
    // that is down stays where it was put down instead of sliding
    this.walkPhase += dt * (0.6 + speed * 2.4);
    this.idleT += dt;
    const amp = Math.min(speed / 3.6, 1);
    const ph = this.walkPhase;

    // A footfall each time a leg reaches the front of its swing — twice a
    // stride, off the same phase the legs are drawn from, so what you hear
    // keeps time with what you see. Only walking counts: the phase creeps
    // even standing still, and a climb is its own sound.
    const fall = Math.floor((ph - Math.PI / 2) / Math.PI);
    if (fall !== this.footfall) {
      if (this.footfall !== null && amp > 0.3 && !this.mantle) this.game.onFootfall?.(this);
      this.footfall = fall;
    }

    // ---- legs: hip swing, and the knee folding through the swing phase
    const swing = 0.5 + 0.12 * amp;
    for (const [thigh, shin, off] of [[P.legL, P.shinL, 0], [P.legR, P.shinR, Math.PI]]) {
      const p = ph + off;
      thigh.rotation.x = Math.sin(p) * swing * amp;
      shin.rotation.x = -(0.06 + Math.max(0, Math.cos(p)) * 1.05 * amp);
    }
    // a climb: one knee up onto the lip, the other trailing, body over it
    const haul = this.mantle ? Math.sin(Math.PI * this.mantle.t) : 0;
    if (haul > 0) {
      P.legL.rotation.x = 1.25 * haul; P.shinL.rotation.x = -1.6 * haul;
      P.legR.rotation.x = 0.45 * haul; P.shinR.rotation.x = -0.7 * haul;
    }
    // down behind cover for a reload: one foot planted, the other knee down
    this.crouch += ((this.reloadT > 0 && this.crouchWant ? 1 : 0) - this.crouch) * Math.min(1, dt * 7);
    const c = this.crouch;
    if (c > 0.001) {
      const L = THREE.MathUtils.lerp;
      P.legL.rotation.x = L(P.legL.rotation.x, CROUCH.thigh, c); P.shinL.rotation.x = L(P.shinL.rotation.x, CROUCH.knee, c);
      P.legR.rotation.x = L(P.legR.rotation.x, 0.35, c); P.shinR.rotation.x = L(P.shinR.rotation.x, -1.95, c);
    }
    // under a low ceiling: both knees bent so the feet stay under the hips
    const st = this.stoop;
    const bend = st > 0.001 ? Math.acos(Math.max(-1, 1 - st / STOOP.leg)) : 0;
    if (bend) {
      P.legL.rotation.x += bend; P.shinL.rotation.x -= 2 * bend;
      P.legR.rotation.x += bend; P.shinR.rotation.x -= 2 * bend;
    }
    // lowest with the feet furthest apart, highest as they pass
    const bob = 0.035 * amp * (0.5 + 0.5 * Math.cos(2 * ph));

    // ---- stance: square on patrol, bladed and shouldered once alerted
    this.aimT += ((this.alerted ? 1 : 0) - this.aimT) * Math.min(1, dt * 5);
    const A = this.aimT;
    this.kick *= Math.max(0, 1 - dt * 9);

    // flinch: a damped spring the hits kick
    const f = this.flinch;
    f.vx += (-60 * f.x - 9 * f.vx) * dt; f.vz += (-60 * f.z - 9 * f.vz) * dt;
    f.x += f.vx * dt; f.z += f.vz * dt;

    const up = P.upper;
    const breathe = Math.sin(this.idleT * 1.6) * 0.012 * (1 - amp);
    up.rotation.set(
      -0.10 * amp * (1 - 0.5 * A) + breathe + 0.05 * this.kick + f.x - 0.55 * haul - CROUCH.lean * c
        - STOOP.lean * (st / STOOP.max),
      -0.48 * A + Math.sin(ph) * 0.07 * amp * (1 - A) - 0.30 * (1 - A),
      Math.sin(ph) * 0.035 * amp + f.z,
    );

    // the head stays on the target while the shoulders turn under it
    P.neck.rotation.set(this.aimPitch * 0.6 * A - 0.5 * f.x, 0.48 * A + 0.30 * (1 - A) + this.lookYaw, 0, 'YXZ');

    // ---- the weapon, in the body's frame
    const w = P.weapon;
    POSE.position.set(
      THREE.MathUtils.lerp(-0.02, 0.08, A),
      THREE.MathUtils.lerp(1.20, 1.37, A),
      THREE.MathUtils.lerp(-0.20, -0.22, A) + 0.05 * this.kick,
    );
    POSE.rotation.set(
      THREE.MathUtils.lerp(-0.45, this.aimPitch, A) + 0.12 * this.kick,
      THREE.MathUtils.lerp(0.55, 0.0, A),
      THREE.MathUtils.lerp(0.2, 0.0, A),
      'YXZ',
    );
    // a reload: the muzzle dips and the gun cants toward the support hand,
    // easing in and out at either end so it never snaps
    const reloading = this.reloadT > 0 && this.hold.mag;
    const r = reloading ? 1 - this.reloadT / this.type.reload : 0;
    const R = reloading ? smooth(Math.min(1, r / 0.12, (1 - r) / 0.12)) : 0;
    if (R > 0) {
      POSE.rotation.x -= 0.45 * R;
      POSE.rotation.z += 0.5 * R;
      POSE.position.x -= 0.05 * R;
      POSE.position.y -= 0.05 * R;
      POSE.position.z += 0.06 * R;
    }
    if (this.swingT > 0) {
      // a hook strike: raised over the shoulder, then driven down through
      const t = 1 - this.swingT / 0.25;
      const arc = Math.sin(t * Math.PI);
      POSE.position.y += 0.25 * arc;
      POSE.rotation.x += THREE.MathUtils.lerp(1.4, -1.0, t);
    }
    if (this.swingT > 0) this.swingT -= dt;
    // the weapon rides with the upper body's flinch and recoil, not its turn
    POSE.rotation.x += f.x * 0.8;
    w.position.copy(POSE.position);
    w.quaternion.setFromEuler(POSE.rotation);
    w.position.y += bob;

    // ---- arms reach for it: hand-holds into the upper body's frame
    up.updateMatrix();
    w.updateMatrix();
    M4.copy(up.matrix).invert().multiply(w.matrix);
    reach(P.armR, P.foreR, V4.copy(this.hold.grip).applyMatrix4(M4), ARM.upper, ARM.fore, this.poleR);
    const support = reloading ? this._reloadHand(r, M4) : V4.copy(this.hold.fore).applyMatrix4(M4);
    reach(P.armL, P.foreL, support, ARM.upper, ARM.fore, this.poleL);

    this.group.position.y = this.pos.y + bob - (CROUCH.drop * c + st) * this.group.scale.x;
    if (P.shadow) {
      // stays on the floor while the body bobs or crouches, and fades as it rises
      P.shadow.position.y = -bob / this.group.scale.x + CROUCH.drop * c + st + 0.03;
      P.shadow.material.opacity = 0.75 * Math.max(0, 1 - bob * 4);
    }

    // eye flares when hurt
    if (P.eye) P.eye.material.color.setHex(this.hurtFlash > 0 ? 0xffffff : this.type.eye ?? 0xff4a2a);
  }

  /**
   * Where the support hand is at `r` of the way through a reload, in the
   * upper body's frame. A magazine: off the handguard to the magazine, pull
   * it, down to the pouch on the belt, back up with a fresh one, seat it,
   * back to the handguard. A shotgun: a shell from the pouch to the loading
   * port, once for each shell, in time with the sound of it going in.
   */
  _reloadHand(r, toUpper) {
    HAND_FORE.copy(this.hold.fore).applyMatrix4(toUpper);
    HAND_MAG.copy(this.hold.mag).applyMatrix4(toUpper);
    HAND_LOW.copy(HAND_MAG); HAND_LOW.y -= 0.2;
    const t = this.type;
    let keys;
    if (t.shells) {
      keys = [[0, HAND_FORE], [0.05, HAND_MAG]];
      for (let i = 0; i < t.shells; i++) {
        const at = 0.15 + (0.7 * i) / t.shells;
        keys.push([at - 0.09, POUCH], [at, HAND_MAG]);
      }
      keys.push([0.95, HAND_FORE], [1, HAND_FORE]);
    } else {
      keys = [[0, HAND_FORE], [0.12, HAND_MAG], [0.25, HAND_LOW], [0.42, POUCH],
        [0.55, HAND_LOW], [0.66, HAND_MAG], [0.88, HAND_FORE], [1, HAND_FORE]];
    }
    let k = 1;
    while (k < keys.length - 1 && r > keys[k][0]) k++;
    const [t0, a] = keys[k - 1], [t1, b] = keys[k];
    const u = smooth(THREE.MathUtils.clamp((r - t0) / Math.max(1e-4, t1 - t0), 0, 1));
    return V4.copy(HAND_A.copy(a)).lerp(HAND_B.copy(b), u);
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
