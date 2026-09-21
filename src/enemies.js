import * as THREE from 'three';
import { audio } from './audio.js';
import { randRange, SUPPORT_RADIUS } from './world.js';
import * as TEX from './textures.js';
import { TILE, blobShadow } from './textures.js';
import { chamferGeo, mergeIntoOne } from './shapes.js';
import { reserve } from './rng.js';

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const V5 = new THREE.Vector3();

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
    damage: 6, rate: 0.16, burst: 3, burstPause: 2.4, preferred: 13, accuracy: 0.085,
    color: 0x66788a, accent: 0x3f4750, score: 150, detect: 65, sound: 'rifle', marker: 0xe8a33a,
    kit: { head: 'helm', armour: 'carrier', coat: 0, weapon: 'rifle' },
  },
  shotgunner: {
    name: 'BREAKER', hp: 170, speed: 3.6, scale: 1.08, melee: false,
    damage: 5, pellets: 6, rate: 1.15, preferred: 6, accuracy: 0.14, falloff: 16,
    color: 0x9a7550, accent: 0x53412f, score: 200, detect: 50, sound: 'shotgun', marker: 0x3fa9d8,
    kit: { head: 'visor', armour: 'heavy', coat: 0, weapon: 'shotgun' },
  },
  marksman: {
    name: 'MARKSMAN', hp: 90, speed: 2.4, scale: 1.0, melee: false,
    damage: 26, rate: 2.9, preferred: 26, accuracy: 0.022, detect: 95,
    color: 0x5c6f5a, accent: 0x2f3a30, score: 250, sound: 'rifle', marker: 0x7ce04a,
    laser: true, perch: true,
    kit: { head: 'hood', armour: 'light', coat: 0.34, weapon: 'long' },
  },
  brute: {
    name: 'JUGGERNAUT', hp: 420, speed: 2.4, scale: 1.35, melee: false,
    damage: 7, rate: 0.13, burst: 6, burstPause: 2.8, preferred: 9, accuracy: 0.105,
    color: 0x7d5a5a, accent: 0x3a3533, score: 400, detect: 70, sound: 'smg', marker: 0xb03be0,
    kit: { head: 'helm', armour: 'plated', coat: 0, weapon: 'drum' },
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
  band: [0, 1.36, 0], eye: [0.07, 1.63, -0.175],
  armL: [-0.34, 1.45, 0], armR: [0.34, 1.45, 0],
  legL: [-0.14, 0.86, 0], legR: [0.14, 0.86, 0],
  weapon: [0.30, 1.28, -0.12],
};

function kitFor(type) {
  let kit = KITS.get(type.name);
  if (!kit) KITS.set(type.name, kit = reserve(() => makeKit(type)));
  return kit;
}

/** Build every archetype's kit up front, so no wave pays for it mid-fight. */
export function primeEnemyKits() {
  for (const type of Object.values(ENEMY_TYPES)) kitFor(type);
}

function makeKit(type) {
  const k = type.kit;
  const T = TILE.kit;
  /** A chamfered part, offset from the origin of the part it belongs to. */
  const box = (w, h, d, at, bevel) =>
    chamferGeo(w, h, d, bevel ?? Math.min(w, h, d) * 0.22, T, at);

  const clothTex = TEX.fatigues();
  const gearTex = TEX.webbing();
  const gearSurface = TEX.surfaceFrom(gearTex, { dark: 1, lite: 0.35, metalDark: 0, metalLite: 0.8 }, 'webbing');
  const steelTex = TEX.gunMetal();

  // The maps are pale and carry only the weave, the strapping and the wear —
  // the archetype's own colours still say what it is, the way `paintedMetal`
  // lets one texture paint a grey streetlight and a maroon wreck.
  const cloth = new THREE.MeshStandardMaterial({
    color: type.color, map: clothTex,
    normalMap: TEX.normalFrom(clothTex, 1.3, 'fatigues', 1),
    normalScale: new THREE.Vector2(0.75, 0.75),
    roughnessMap: TEX.surfaceFrom(clothTex, { dark: 1, lite: 0.86 }, 'fatigues'),
    // the sky is the only fill a hostile gets on the side away from the
    // sun, and it is facing you from that side more often than not
    roughness: 1, metalness: 0, envMapIntensity: 0.75,
  });
  const gear = new THREE.MeshStandardMaterial({
    color: type.accent, map: gearTex,
    normalMap: TEX.normalFrom(gearTex, 1.4, 'webbing', 1),
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: gearSurface, metalnessMap: gearSurface,
    roughness: 1, metalness: 1, envMapIntensity: 0.8,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: 0x8c7159, map: clothTex,
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

  // ------------------------------------------------------------ the body
  const heavy = k.armour === 'heavy' || k.armour === 'plated';
  const limb = heavy ? 0.04 : 0;

  const torso = [
    box(0.52, 0.66, 0.30, [0, 0, 0], 0.07),
    box(0.36, 0.10, 0.26, [0, 0.32, 0], 0.03),                   // collar
    box(0.16, 0.16, 0.22, [-0.28, 0.29, 0], 0.04),               // shoulder caps
    box(0.16, 0.16, 0.22, [0.28, 0.29, 0], 0.04),
  ];
  if (k.coat) {
    // a coat that hangs past the belt, which is most of what reads as a
    // long-range shooter standing still on a roof
    torso.push(box(0.52, k.coat, 0.34, [0, -0.33 - k.coat / 2, 0], 0.05));
  }

  const rig = [];
  if (k.armour === 'carrier') {
    rig.push(box(0.56, 0.36, 0.36, [0, 0, 0], 0.05));
    for (const px of [-0.17, 0, 0.17]) rig.push(box(0.14, 0.14, 0.10, [px, -0.15, -0.20], 0.03));
    for (const px of [-0.16, 0.16]) rig.push(box(0.08, 0.28, 0.07, [px, 0.20, -0.15], 0.02));
  } else if (k.armour === 'heavy') {
    rig.push(box(0.60, 0.44, 0.40, [0, 0, 0], 0.06));
    rig.push(box(0.46, 0.14, 0.34, [0, -0.26, 0], 0.04));        // belly plate
    for (const px of [-0.35, 0.35]) rig.push(box(0.22, 0.18, 0.30, [px, 0.28, 0], 0.05));
  } else if (k.armour === 'plated') {
    rig.push(box(0.64, 0.50, 0.44, [0, 0, 0], 0.07));
    rig.push(box(0.50, 0.16, 0.38, [0, -0.28, 0], 0.04));
    for (const px of [-0.40, 0.40]) rig.push(box(0.26, 0.24, 0.34, [px, 0.30, 0], 0.06));
    rig.push(box(0.40, 0.44, 0.20, [0, 0.04, 0.26], 0.05));      // pack
    for (const px of [-0.13, 0.13]) rig.push(box(0.10, 0.34, 0.10, [px, 0.38, 0.26], 0.03));
  } else if (k.armour === 'scrap') {
    // whatever was to hand, strapped on one side and not the other
    rig.push(box(0.42, 0.30, 0.34, [-0.05, 0.02, 0], 0.04));
    rig.push(box(0.24, 0.20, 0.28, [0.30, 0.26, 0], 0.05));
    rig.push(box(0.09, 0.40, 0.08, [0.10, 0.12, -0.16], 0.02));
    rig.push(box(0.14, 0.14, 0.10, [-0.18, -0.16, -0.19], 0.03));
  } else {
    rig.push(box(0.50, 0.24, 0.33, [0, 0.08, 0], 0.04));
    for (const px of [-0.16, 0.16]) rig.push(box(0.13, 0.13, 0.09, [px, -0.12, -0.19], 0.03));
  }

  const headKit = [box(0.27, 0.14, 0.10, [0, -0.04, -0.12], 0.03)];  // respirator
  headKit.push(box(0.10, 0.10, 0.09, [0, -0.075, -0.20], 0.03));     // filter
  if (k.head === 'hood') {
    headKit.push(box(0.35, 0.32, 0.35, [0, 0.05, 0.02], 0.11));
  } else {
    headKit.push(box(0.30, 0.13, 0.30, [0, 0.13, 0], 0.05));
    headKit.push(box(0.30, 0.05, 0.13, [0, 0.095, -0.16], 0.02));    // brim
    if (k.head === 'visor') headKit.push(box(0.32, 0.12, 0.09, [0, -0.005, -0.145], 0.03));
  }

  const arm = [box(0.15 + limb, 0.52, 0.16 + limb, [0, -0.26, 0], 0.04)];
  if (heavy) arm.push(box(0.20, 0.14, 0.22, [0, -0.13, 0], 0.04));   // vambrace
  const leg = [
    box(0.19 + limb, 0.85, 0.20 + limb, [0, -0.42, 0], 0.04),
    box(0.22 + limb, 0.15, 0.27, [0, -0.80, -0.03], 0.04),           // boot
  ];
  if (heavy) leg.push(box(0.22, 0.16, 0.12, [0, -0.44, -0.10], 0.03));   // knee plate

  // ---------------------------------------------------------- the weapon
  const gun = [];
  if (k.weapon === 'hook') {
    gun.push(chamferGeo(0.055, 0.055, 0.76, 0.015, TILE.gunMetal, [0, 0, -0.30]));
    gun.push(chamferGeo(0.05, 0.20, 0.05, 0.012, TILE.gunMetal, [0, -0.09, -0.63]));
    gun.push(chamferGeo(0.07, 0.07, 0.14, 0.02, TILE.gunMetal, [0, 0, 0.02]));
  } else {
    const long = k.weapon === 'long';
    gun.push(chamferGeo(0.075, 0.15, 0.50, 0.02, TILE.gunMetal, [0, 0, -0.18]));
    gun.push(chamferGeo(0.05, 0.19, 0.075, 0.015, TILE.gunMetal, [0, -0.15, -0.16]));   // magazine
    gun.push(chamferGeo(0.05, 0.11, 0.09, 0.015, TILE.gunMetal, [0, -0.11, 0.06]));     // grip
    const barrel = new THREE.CylinderGeometry(
      k.weapon === 'shotgun' ? 0.032 : 0.022, 0.022, long ? 0.48 : 0.34, 8);
    barrel.rotateX(Math.PI / 2).translate(0, 0.01, long ? -0.62 : -0.55);
    gun.push(barrel);
    if (long) {
      gun.push(chamferGeo(0.05, 0.05, 0.22, 0.015, TILE.gunMetal, [0, 0.11, -0.18]));   // scope
      gun.push(chamferGeo(0.03, 0.06, 0.03, 0.01, TILE.gunMetal, [0, 0.06, -0.10]));
      gun.push(chamferGeo(0.05, 0.14, 0.14, 0.02, TILE.gunMetal, [0, -0.03, 0.22]));    // stock
    }
    if (k.weapon === 'drum') {
      const drum = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 10);
      drum.rotateX(Math.PI / 2).translate(0, -0.16, -0.14);
      gun.push(drum);
    }
  }

  return {
    materials: { cloth, gear, skin, steel },
    geo: {
      torso: mergeIntoOne(torso),
      rig: mergeIntoOne(rig),
      head: box(0.25, 0.27, 0.25, [0, 0, 0], 0.05),
      headKit: mergeIntoOne(headKit),
      arm: mergeIntoOne(arm),
      leg: mergeIntoOne(leg),
      gun: mergeIntoOne(gun),
      band: new THREE.BoxGeometry(0.58, 0.09, 0.38),
      eye: new THREE.BoxGeometry(0.05, 0.03, 0.02),
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
  const { cloth, gear, skin, steel } = kit.materials;
  const geo = kit.geo;
  const g = new THREE.Group();

  const parts = {};
  const add = (mesh, where, zone, key) => {
    mesh.position.set(where[0], where[1], where[2]);
    mesh.castShadow = true;
    mesh.userData.zone = zone;
    g.add(mesh);
    if (key) parts[key] = mesh;
    return mesh;
  };

  add(new THREE.Mesh(geo.torso, cloth), AT.torso, 'body', 'torso');
  add(new THREE.Mesh(geo.rig, gear), AT.rig, 'body', 'rig');
  add(new THREE.Mesh(geo.head, skin), AT.head, 'head', 'head');
  add(new THREE.Mesh(geo.headKit, gear), AT.headKit, 'head');

  // The archetype band and the eye stay flat-shaded and per-instance: one
  // turns gold on an elite and the other flares white when hurt, and a
  // material shared across a wave would do it to all of them at once.
  const band = new THREE.Mesh(geo.band, new THREE.MeshBasicMaterial({ color: type.marker || 0xd8452f }));
  band.position.set(...AT.band);
  g.add(band);
  parts.band = band;

  const eye = new THREE.Mesh(geo.eye, new THREE.MeshBasicMaterial({ color: 0xff4a2a }));
  eye.position.set(...AT.eye);
  g.add(eye);
  parts.eye = eye;

  add(new THREE.Mesh(geo.arm, cloth), AT.armL, 'limb', 'armL');
  add(new THREE.Mesh(geo.arm, cloth), AT.armR, 'limb', 'armR');
  add(new THREE.Mesh(geo.leg, gear), AT.legL, 'limb', 'legL');
  add(new THREE.Mesh(geo.leg, gear), AT.legR, 'limb', 'legR');

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
  return { group: g, parts };
}

export class Enemy {
  constructor(typeKey, scene, game) {
    this.typeKey = typeKey;
    this.type = ENEMY_TYPES[typeKey];
    this.game = game;
    const built = buildBody(this.type);
    this.group = built.group;
    this.parts = built.parts;
    this.hitMeshes = [];
    this.group.traverse((o) => {
      if (o.isMesh && o.userData.zone) { o.userData.enemy = this; this.hitMeshes.push(o); }
    });
    scene.add(this.group);

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
    this.alerted = false;
    this.nextFire = 0;
    this.burstLeft = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = randRange(1, 3);
    this.walkPhase = Math.random() * 6.28;
    this.deathT = 0;
    this.hurtFlash = 0;
    this.swingT = 0;
    this.group.visible = true;
    this.group.rotation.set(0, 0, 0);
    this.group.scale.setScalar(this.type.scale);
    this.avoidDir = 0;
    this.avoidTimer = 0;
    this.routed = false;
    this.blindFor = 0;
    this.stuckTimer = 0;
    this.noProgress = 0;
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
    if (this.alerted || !this.alive) return;
    this.alerted = true;
    this.nextFire = Math.max(this.nextFire, time + readyIn);
    if (Math.random() < 0.3) audio.enemyAlert();
  }

  /** @returns {'kill'|'hit'|null} */
  damage(amount, zone, fromDir, point) {
    if (!this.alive) return null;
    let dmg = amount;
    if (zone === 'head') dmg *= 1;      // multiplier already applied by shooter
    else if (zone === 'limb') dmg *= 0.75;
    this.hp -= dmg;
    this.hurtFlash = 0.12;
    this.alert(this.game.time, 0.35);
    this.game.effects.blood(point, fromDir);
    if (this.hp <= 0) {
      this.die(fromDir);
      return 'kill';
    }
    audio.flesh();
    return 'hit';
  }

  die(fromDir) {
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.vel.set(0, 0, 0);
    this.fallDir = Math.atan2(fromDir ? fromDir.x : 0, fromDir ? fromDir.z : 1);
    this.game.effects.gib(V1.copy(this.pos).setY(this.pos.y + 1.2));
    audio.flesh();
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
    if (!sees && nav && nav.heading(this.pos.x, this.pos.z, out)) {
      this.routed = true;
      return out;
    }
    this.routed = false;
    return out.copy(toPlayer);
  }

  update(dt, time, player, world) {
    if (!this.alive) {
      this.deathT += dt;
      // topple over in the direction of the killing shot
      const t = Math.min(1, this.deathT / 0.55);
      const fall = Math.sin(t * Math.PI * 0.5) * (Math.PI / 2);
      this.group.rotation.x = Math.cos(this.fallDir) * fall;
      this.group.rotation.z = -Math.sin(this.fallDir) * fall;
      this.group.position.y = this.pos.y - 0.1 * t;
      if (this.parts.shadow) this.parts.shadow.material.opacity = 0.75 * Math.max(0, 1 - this.deathT);
      if (this.deathT > 6) {
        const k = Math.max(0, 1 - (this.deathT - 6) / 1.5);
        this.group.scale.setScalar(this.type.scale * k);
        if (k <= 0.01) this.group.visible = false;
      }
      return;
    }

    if (this.hurtFlash > 0) this.hurtFlash -= dt;

    const toPlayer = V1.copy(player.position).sub(this.pos);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    toPlayer.normalize();
    const heightGap = player.position.y - (this.pos.y + 1.5);

    const eyeY = this.pos.y + 1.5 * this.type.scale;
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

    const nav = this.game.nav;
    let moveDir = V2.set(0, 0, 0);
    if (!this.alerted) {
      // still hunting: drift toward the player at a walk
      if (!onPerch) this._approach(moveDir, toPlayer, sees, nav);
    } else {
      const t = this.type;
      const holdPerch = onPerch;
      const wantCloser = !holdPerch && dist > t.preferred * (t.melee ? 1 : 1.15);
      const wantBack = !t.melee && !holdPerch && dist < t.preferred * 0.6;

      if (!sees && !onPerch) {
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

    // ---- obstacle avoidance --------------------------------------------
    // The last few metres, which the route field is too coarse to see: a
    // wreck in the street, another hostile's corner, the kerb of the very
    // building being rounded. Probe the heading; if it is blocked, fan
    // outwards and take the first clear direction.
    if (moveDir.lengthSq() > 1e-4) {
      moveDir.normalize();
      const probe = 1.8 + this.radius;
      const clear = (x, z) => !world.occupied(this.pos.x + x * probe, this.pos.z + z * probe, this.radius, this.pos.y + 0.9);
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

    // ---- stuck watchdog --------------------------------------------------
    // Geometry can still trap a hostile in a corner. If one has made no
    // progress for a long stretch, pull it out and re-insert it elsewhere so
    // a wave can never stall forever.
    // Someone holding a perch is doing their job while they wait for a target
    // to walk into view, so give them far longer before the watchdog moves
    // them — but not forever, or a wave could stall on a roof.
    this.stuckTimer += dt;
    const checkEvery = onPerch && !parked ? 12 : 4;
    if (this.stuckTimer > checkEvery) {
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

    const speed = this.type.speed * (this.alerted ? 1 : 0.45);
    this.vel.lerp(V3.copy(moveDir).multiplyScalar(speed), Math.min(1, dt * 6));
    this.pos.addScaledVector(this.vel, dt);
    world.resolve(this.pos, this.radius, this.pos.y, 0.55);
    world.clampToBounds(this.pos, this.radius);

    // Follow the surface underfoot: stairs and platforms carry hostiles too,
    // and stepping off a ledge drops them rather than leaving them floating.
    // Asked with the same foot the player stands on, or a hostile holds a
    // ledge you fall off and the two of you are walking different cities.
    const support = world.groundHeight(this.pos.x, this.pos.z, SUPPORT_RADIUS, this.pos.y + 0.55);
    if (support > this.pos.y) this.pos.y = Math.min(support, this.pos.y + dt * 6);
    else if (support < this.pos.y) this.pos.y = Math.max(support, this.pos.y - dt * 14);

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
    const faceTarget = this.alerted ? toPlayer : (this.vel.lengthSq() > 0.05 ? V3.copy(this.vel).normalize() : null);
    if (faceTarget) {
      const want = Math.atan2(faceTarget.x, faceTarget.z);
      let diff = want - this.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.group.rotation.y += diff * Math.min(1, dt * 7);
    }

    this._updateLaser(player, sees, time);
    this._animate(dt, dist);
    // hit detection raycasts against these meshes before the renderer runs,
    // so their world matrices have to be current now, not next frame
    this.group.updateMatrixWorld(true);

    // ---- shooting / melee ---------------------------------------------
    if (!this.alerted || !sees) return;
    const t = this.type;
    if (time < this.nextFire) return;

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
    audio.shot(t.sound || 'rifle', THREE.MathUtils.clamp(14 / Math.max(3, dist), 0.16, 1));

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
    const aiming = this.alerted && sees && this.nextFire - time < 1.1;
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

  _animate(dt, dist) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (2 + speed * 2.6);
    const amp = Math.min(speed / 4, 1);
    const s = Math.sin(this.walkPhase) * 0.8 * amp;
    const c = Math.cos(this.walkPhase) * 0.55 * amp;
    if (this.parts.legL) this.parts.legL.rotation.x = s;
    if (this.parts.legR) this.parts.legR.rotation.x = -s;
    if (this.parts.armL) this.parts.armL.rotation.x = -s * 0.6;

    // right arm holds the weapon level once alerted
    const aim = this.alerted ? -0.15 : 0.2;
    if (this.parts.armR) this.parts.armR.rotation.x = aim + (this.swingT > 0 ? -1.6 : 0);
    if (this.swingT > 0) this.swingT -= dt;

    const hop = Math.abs(Math.sin(this.walkPhase)) * 0.05 * amp;
    this.group.position.y = this.pos.y + hop;
    if (this.parts.shadow) {
      // stays on the floor while the body bobs, and fades as it rises
      this.parts.shadow.position.y = -hop / this.type.scale + 0.03;
      this.parts.shadow.material.opacity = 0.75 * Math.max(0, 1 - hop * 4);
    }

    // eye flares when hurt
    if (this.parts.eye) {
      this.parts.eye.material.color.setHex(this.hurtFlash > 0 ? 0xffffff : 0xff4a2a);
    }
    if (this.parts.torso) {
      this.parts.torso.material.emissive?.setScalar?.(0);
    }
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
