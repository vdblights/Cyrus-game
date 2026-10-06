import * as THREE from 'three';
import * as TEX from './textures.js';
import { TILE } from './textures.js';
import { chamferGeo, sweepGeo, mergeIntoOne, sideGeo, latheGeo } from './shapes.js';
import { audio } from './audio.js';
import { EFFECT } from './armoury.js';

/**
 * Materials for the gun in your hands.
 *
 * Standard, so it reflects the same sky the street does
 * (`viewScene.environment`), and textured, because a weapon is the one
 * surface always within arm's reach — flat colour on a 0.2 m slide reads as a
 * toy. Polymer stays matte and stippled; machined parts stay bright, with the
 * roughness map keyed off the wear painted into their own texture, so the
 * rubbed edges catch the sky and the phosphate does not.
 *
 * Built once, on demand, rather than at import: `WeaponSystem` is constructed
 * inside `reserve` (see `rng.js`), so minting them there costs the seeded
 * stream nothing.
 */
let MATS = null;

function mats() {
  if (MATS) return MATS;
  const poly = TEX.gunPolymer();
  const metal = TEX.gunMetal();
  const polyBits = {
    map: poly,
    normalMap: TEX.normalFrom(poly, 1.5, 'gunpoly', 1),
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: TEX.surfaceFrom(poly, { dark: 1, lite: 0.62 }, 'gunpoly'),
  };
  const metalBits = {
    map: metal,
    normalMap: TEX.normalFrom(metal, 1.2, 'gunmetal', 1),
    normalScale: new THREE.Vector2(0.6, 0.6),
    // bright wear goes smooth and stays metal; the dark finish goes flat
    roughnessMap: TEX.surfaceFrom(metal, { dark: 0.92, lite: 0.18, metalDark: 0.55, metalLite: 1 }, 'gunmetal'),
  };

  // `map` multiplies `color`, and the textures already carry the base value,
  // so these tint rather than darken. Anything below white here is a part
  // finished differently, not a part in shadow.
  MATS = {
    POLY: new THREE.MeshStandardMaterial({
      ...polyBits, color: 0xffffff, roughness: 1, metalness: 0.08, envMapIntensity: 0.55,
    }),
    METAL: new THREE.MeshStandardMaterial({
      ...metalBits, color: 0xffffff, roughness: 1, metalness: 1, envMapIntensity: 1,
    }),
    DARK: new THREE.MeshStandardMaterial({
      ...metalBits, color: 0x8d939b, roughness: 1, metalness: 1, envMapIntensity: 0.8,
    }),
    ACCENT: new THREE.MeshStandardMaterial({
      ...metalBits, color: 0xc8cfd6, roughness: 1, metalness: 1, envMapIntensity: 1,
    }),
    GLOW: new THREE.MeshBasicMaterial({ color: 0xff3b2f }),
  };

  // The hands. One pale weave tinted twice: a synthetic glove nearly black,
  // a faded sleeve in the drab every hostile also wears.
  const cloth = TEX.fatigues();
  const clothBits = {
    map: cloth,
    normalMap: TEX.normalFrom(cloth, 1.3, 'fatigues-hand', 1),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: TEX.surfaceFrom(cloth, { dark: 1, lite: 0.8 }, 'fatigues-hand'),
  };
  MATS.GLOVE = new THREE.MeshStandardMaterial({
    ...clothBits, color: 0x3d3a36, roughness: 1, metalness: 0, envMapIntensity: 0.5,
  });
  MATS.SLEEVE = new THREE.MeshStandardMaterial({
    ...clothBits, color: 0x46493b, roughness: 1, metalness: 0, envMapIntensity: 0.45,
  });
  // The moulded parts of a tactical glove — the knuckle guard and the cuff's
  // strap — in the stippled polymer of the gun, near black, so the hand reads
  // as cloth over a hard shell rather than one dyed sock.
  MATS.PAD = new THREE.MeshStandardMaterial({
    ...polyBits, color: 0x3a3b3e, roughness: 1, metalness: 0, envMapIntensity: 0.5,
  });
  // a watch's crystal over its dial: dark, smooth and a little reflective
  MATS.DIAL = new THREE.MeshStandardMaterial({
    ...metalBits, color: 0x6f7e86, roughness: 0.35, metalness: 0.6, envMapIntensity: 1.2,
  });
  return MATS;
}

// The builders read these by name, so each one resolves through `mats()` at
// the moment a model is built rather than at import.
const POLY = 'POLY', METAL = 'METAL', DARK = 'DARK', ACCENT = 'ACCENT', GLOW = 'GLOW';
const GLOVE = 'GLOVE', SLEEVE = 'SLEEVE', PAD = 'PAD', DIAL = 'DIAL';

/** The tile a material's parts unwrap at — see `TILE`. */
// The glove's moulded pad declares the glove's tile, not the gun's: it is
// part of the hand, and a check that measures the gun leaves the hand out by
// the tile it declares.
const tileOf = (mat) => (mat === POLY ? TILE.gunPoly : mat === GLOVE || mat === PAD || mat === DIAL ? TILE.glove
  : mat === SLEEVE ? TILE.kit : TILE.gunMetal);

/**
 * Gun parts, chamfered.
 *
 * `chamferGeo` was written here and now lives in `shapes.js`, because the
 * city wants the same thing: a cube under one sun is two faces, two values
 * and no line between them, and a broken edge is most of the cure. The
 * winding rule it follows was learned on these models — see the note there.
 *
 * @param {string} mat key into `mats()`
 * @param {number} [bevel] edge break; defaults to a quarter of the thinnest
 *        dimension, which is roughly how a real part is broken
 */
function box(w, h, d, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, bevel = 0) {
  const M = mats()[mat];
  const tile = tileOf(mat);
  const geo = mat === GLOW
    ? new THREE.BoxGeometry(w, h, d)    // the dot is a lit speck, not a part
    : chamferGeo(w, h, d, bevel || Math.min(w, h, d) * 0.25, tile);
  const m = new THREE.Mesh(geo, M);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.userData.tile = tile;
  return m;
}

/**
 * Barrels, shrouds and tubes. Sixteen sides rather than ten: at the distance
 * a view model sits from the camera, ten reads as a faceted pencil. UVs are
 * rescaled off the real circumference so the machining marks stay the size
 * they are everywhere else.
 */
function tube(r1, r2, len, mat, x = 0, y = 0, z = 0, rx = Math.PI / 2) {
  const g = new THREE.CylinderGeometry(r1, r2, len, 16, 1, false);
  const tile = tileOf(mat);
  const uv = g.attributes.uv;
  const around = (Math.PI * (r1 + r2)) / tile, along = len / tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * along);
  uv.needsUpdate = true;
  const m = new THREE.Mesh(g, mats()[mat]);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  m.userData.tile = tile;
  return m;
}

/**
 * A part drawn by its side view, the way a gunsmith draws one — see
 * `sideGeo`. Outline points are `[z, y]` with the muzzle toward -z, and may
 * carry a fillet radius. Frames, slides, receivers, grips, stocks and
 * magazines are all this: a box can be none of them, because none of them
 * has a right angle anywhere a hand would notice.
 */
function side(outline, width, mat, { holes = [], bevel = null, x = 0, segs = 2 } = {}) {
  const tile = tileOf(mat);
  const geo = sideGeo(outline, width, { holes, bevel: bevel ?? Math.min(width * 0.2, 0.005), segs, tile });
  const m = new THREE.Mesh(geo, mats()[mat]);
  m.position.x = x;
  m.userData.tile = tile;
  return m;
}

/**
 * A part turned about an axis parallel to the bore: `[radius, z]` pairs,
 * listed from the muzzle end and walked out and back the way a lathe tool
 * would cut it (material on the left), so a barrel's bore faces in and its
 * crown faces forward. Barrels, buffer tubes, magazine tubes, handguards.
 */
function turned(profile, mat, y = 0, { sides = 20, x = 0, crease = 40, spin = 0 } = {}) {
  const tile = tileOf(mat);
  const geo = latheGeo(profile, sides, tile, { crease });
  if (spin) geo.rotateZ(spin);
  const m = new THREE.Mesh(geo, mats()[mat]);
  m.position.set(x, y, 0);
  m.userData.tile = tile;
  return m;
}

/** A point `a` down a grip's axis and `f` out of its front, in (z, y). */
function gripPoint({ c: [cz, cy], rx }, a, f) {
  return [cz - Math.sin(rx) * a - Math.cos(rx) * f, cy - Math.cos(rx) * a + Math.sin(rx) * f];
}

/**
 * The outline of a grip, and the frame the hand that holds it is built from.
 *
 * A grip is a raked band `len` long and `depth` deep about `c` (z, y). The
 * rake is the same number `gripFrame` turns a hand by, so the fingers close
 * round exactly the shape that is drawn — and it is *negative*: down the grip
 * runs back toward the shooter. Every grip here used to rake the other way,
 * the bottom of each one tucked forward under the gun, which nothing measured
 * and every side view showed. `top` extends the band up to the frame it hangs
 * from; `grooves` puts finger swells down the front strap.
 */
function gripOutline([cz, cy], rx, len, depth, { top = null, r = 0.006, grooves = 0 } = {}) {
  const A = [-Math.sin(rx), -Math.cos(rx)];      // down the grip, in (z, y)
  const F = [-Math.cos(rx), Math.sin(rx)];       // out of its front strap
  const at = (a, f) => [cz + A[0] * a + F[0] * f, cy + A[1] * a + F[1] * f];
  let a0f = -len / 2, a0b = -len / 2;
  if (top != null) {
    a0f = -len / 2 - (top - at(-len / 2, depth / 2)[1]) / Math.cos(rx);
    a0b = -len / 2 - (top - at(-len / 2, -depth / 2)[1]) / Math.cos(rx);
  }
  const front = [];
  // finger swells: the strap bulges between where three fingers lie
  for (let k = 1; k <= grooves; k++) {
    const a = a0f + ((len / 2 - a0f) * k) / (grooves + 1);
    front.push([...at(a, depth / 2 + 0.004), 0.008]);
  }
  return [
    [...at(a0f, depth / 2), r],
    [...at(a0b, -depth / 2), r],
    [...at(len / 2, -depth / 2), r * 1.6],
    [...at(len / 2, depth / 2), r * 1.6],
    ...front.reverse(),
  ];
}

/**
 * Red-dot sight, shared by the long guns. The housing is a hollow frame —
 * the player aims *through* it, so the four bars are modelled separately
 * instead of as one solid block.
 */
const SIGHT_Y = 0.098;   // height of the sight line above the model origin

function optic(g, z) {
  g.add(box(0.045, 0.012, 0.10, DARK, 0, 0.062, z));                  // rail
  const t = 0.009, ap = 0.052, d = 0.07;                              // bar, aperture, depth
  g.add(box(ap + t * 2, t, d, POLY, 0, SIGHT_Y + ap / 2 + t / 2, z));  // top
  g.add(box(ap + t * 2, t, d, POLY, 0, SIGHT_Y - ap / 2 - t / 2, z));  // bottom
  g.add(box(t, ap, d, POLY, -ap / 2 - t / 2, SIGHT_Y, z));             // left
  g.add(box(t, ap, d, POLY, ap / 2 + t / 2, SIGHT_Y, z));              // right

  const lens = new THREE.Mesh(new THREE.BoxGeometry(ap, ap, 0.003), new THREE.MeshBasicMaterial({
    color: 0x3d7f8f, transparent: true, opacity: 0.18, depthWrite: false,
  }));
  lens.position.set(0, SIGHT_Y, z - d / 2 + 0.01);
  g.add(lens);
  g.add(box(0.006, 0.006, 0.004, GLOW, 0, SIGHT_Y, z - d / 2 + 0.004)); // dot
}


/* ------------------------------------------------------------------- hands */

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

/** One piece of a hand, swept along a path (see `sweepGeo`), in `mat`. */
function piece(points, size, mat, opts) {
  const tile = tileOf(mat);
  const m = new THREE.Mesh(sweepGeo(points, size, tile, opts), opts.open ? sided(mat) : mats()[mat]);
  m.userData.tile = tile;
  return m;
}

/**
 * A finger, or a thumb: wider than it is deep, tapering to the tip, standing
 * up at each knuckle and creased just past it where the glove folds. `side`
 * is the way across the finger's back — along the line its neighbours lie
 * on — so the flat of it faces the way a finger's does.
 */
function finger(points, r, side, { joints = [0.42, 0.74], taper = 0.8, root = 1, kind = 'finger' } = {}) {
  const width = (t) => r * (1 + (root - 1) * Math.max(0, 1 - t / 0.35)) * (1 - (1 - taper) * t);
  // what it is and where it runs, for the check that asks whether it holds on
  DIGITS.push({ kind, hand: HANDS, r, depth: r * 0.88, taper, path: points.map((p) => [p.x, p.y, p.z]) });
  return piece(points, (t) => [width(t) * 1.1, width(t) * 0.88], GLOVE, {
    side, around: 12, step: 0.004,
    bump: (t) => {
      let k = 1;
      for (const j of joints) {
        k += 0.09 * Math.exp(-(((t - j) / 0.05) ** 2));          // the knuckle
        k -= 0.05 * Math.exp(-(((t - j - 0.075) / 0.03) ** 2));  // the fold past it
      }
      return k;
    },
  });
}

let DIGITS = [], HANDS = 0;

const SIDED = {};
function sided(mat) {
  if (!SIDED[mat]) { SIDED[mat] = mats()[mat].clone(); SIDED[mat].side = THREE.DoubleSide; }
  return SIDED[mat];
}

/**
 * A gloved hand closed around a grip, and the arm behind it.
 *
 * The grip is described by a frame rather than by the gun: `c` is where the
 * hand sits, `A` the axis the fingers stack along, `U` the side the back of
 * the hand is on, `F` the way the fingers go first as they leave it, and
 * `hu`/`hf` the grip's half-thickness along `U` and `F`. Each finger is an
 * arc around that cross-section — the same four lines of arithmetic close a
 * hand on a pistol grip, a handguard, a vertical grip or a pump — and the arm
 * runs from the heel of the hand back to `elbow`, which is chosen off the
 * bottom of the frame so the sleeve leaves the picture rather than ending in
 * it.
 *
 * Every part is swept along a path rather than boxed: fingers with knuckles
 * and the fold of the glove past each one, a thumb that grows into the
 * mound at its root, a back of the hand that narrows from the knuckles to
 * the wrist and arches over them, a moulded knuckle guard, a cuff with its
 * strap, and a forearm in a sleeve that bunches where it meets the glove.
 * `watch` straps one to the wrist, on the support hand.
 *
 * `index` replaces the first finger with a path of its own, for a trigger
 * finger laid along the frame; `thumb` is a path likewise, root first.
 */
function hand(g, { c, A, U, F, hu, hf, stack, sweep = 3.6, r = 0.0088, index = null, thumb = null, elbow, watch = false }) {
  HANDS++;
  A = A.clone().normalize(); U = U.clone().normalize(); F = F.clone().normalize();
  const at = (a, th, out = 0) => c.clone()
    .addScaledVector(A, a)
    .addScaledVector(U, Math.cos(th) * (hu + r + out))
    .addScaledVector(F, Math.sin(th) * (hf + r + out));
  // Fingers round the grip. No two are the same: the middle is the longest
  // and stoutest, the ring a little less, the little finger shorter and finer
  // than either — four equal tubes in a row read as a bunch of sausages.
  const SIZES = [[0.97, 1.0], [1.0, 1.04], [0.95, 0.96], [0.84, 0.84]];   // [reach, girth]
  const fingers = index ? stack.slice(1) : stack;
  const first = index ? 1 : 0;
  for (const [k, a] of fingers.entries()) {
    const [long, girth] = SIZES[Math.min(3, k + first)];
    const reach = sweep * long;
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push(at(a, 0.1 + (reach - 0.1) * (i / 8), i === 0 ? r * 0.9 : 0));
    g.add(finger(pts, r * girth, A));
  }
  if (index) g.add(finger(index, r, A, { kind: 'index' }));
  // the thumb, swelling into the mound at its root
  if (thumb) g.add(finger(thumb, r * 1.08, A, { joints: [0.55], taper: 0.78, root: 1.45, kind: 'thumb' }));

  // The back of the hand: from the knuckles to the wrist, on the back side of
  // the grip, narrowing as it goes and arched across the knuckles.
  const a0 = stack[0], a1 = stack[stack.length - 1], mid = (a0 + a1) / 2;
  const span = Math.abs(a1 - a0) + r * 2.6;
  const knuckles = c.clone().addScaledVector(A, mid).addScaledVector(U, hu + 0.009).addScaledVector(F, hf * 0.62);
  const wrist = knuckles.clone().addScaledVector(F, -0.088).addScaledVector(U, 0.004);
  const arch = knuckles.clone().lerp(wrist, 0.5).addScaledVector(U, 0.004);
  g.add(piece([knuckles, arch, wrist], (t) => [span / 2 * (1 - 0.32 * t), 0.0115 + 0.006 * t], GLOVE, {
    side: A, around: 18, step: 0.006,
    // the knuckles stand up across the front of it, one to a finger
    bump: (t, th) => 1 + 0.16 * Math.exp(-((t / 0.12) ** 2)) * Math.max(0, Math.sin(th)) ** 2
      * (0.6 + 0.4 * Math.abs(Math.cos(th * 4))),
  }));
  // the knuckle guard: a moulded plate over them, ridged one to a finger
  const guard = [];
  for (let k = 0; k <= 4; k++) {
    guard.push(c.clone().addScaledVector(A, a0 + (a1 - a0) * (k / 4) - (k === 0 ? r : k === 4 ? -r : 0))
      .addScaledVector(U, hu + 0.0205).addScaledVector(F, hf * 0.62 - 0.012));
  }
  g.add(piece(guard, () => [0.0085, 0.0034], PAD, {
    side: F, around: 10, step: 0.003,
    bump: (t) => 1 + 0.35 * Math.abs(Math.sin(t * Math.PI * 4)),
  }));

  // the wrist and the glove's cuff, flaring a little toward the arm
  const toElbow = elbow.clone().sub(wrist).normalize();
  const cuffEnd = wrist.clone().addScaledVector(toElbow, 0.075);
  g.add(piece([wrist.clone().addScaledVector(toElbow, -0.012), cuffEnd], (t) => [0.029 + 0.007 * t, 0.025 + 0.006 * t], GLOVE, {
    side: A, around: 18, step: 0.006, open: [false, true],
  }));
  // its strap, round the cuff near the end, and the tab you pull it by
  const strapAt = wrist.clone().addScaledVector(toElbow, 0.05);
  g.add(piece([strapAt, strapAt.clone().addScaledVector(toElbow, 0.019)], () => [0.0352, 0.0306], PAD, {
    side: A, around: 18, step: 0.004,
  }));
  const tab = new THREE.Mesh(chamferGeo(0.006, 0.026, 0.022, 0.0025, TILE.glove), mats()[PAD]);
  tab.userData.tile = TILE.glove;
  tab.position.copy(strapAt).addScaledVector(toElbow, 0.0095).addScaledVector(U, 0.031).addScaledVector(A, 0.012);
  tab.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(U, A, toElbow));
  g.add(tab);

  if (watch) {
    // A watch over the cuff, its face on the back of the wrist: a moulded
    // case and strap in the glove's polymer, and a crystal over a dark dial.
    // It is part of the hand, so it is built in the hand's materials and at
    // the glove's tile — merged into the gun's steel, it was the rearmost
    // surface of the pistol and read as its grip raking forward.
    const at2 = wrist.clone().addScaledVector(toElbow, 0.028);
    g.add(piece([at2, at2.clone().addScaledVector(toElbow, 0.02)], () => [0.0345, 0.030], PAD, { side: A, around: 18, step: 0.005 }));
    const basis = new THREE.Matrix4().makeBasis(U, A, toElbow);
    const face = new THREE.Mesh(chamferGeo(0.012, 0.04, 0.036, 0.004, TILE.glove), mats()[PAD]);
    face.userData.tile = TILE.glove;
    face.position.copy(at2).addScaledVector(toElbow, 0.01).addScaledVector(U, 0.031);
    face.quaternion.setFromRotationMatrix(basis);
    g.add(face);
    const dial = new THREE.Mesh(chamferGeo(0.003, 0.03, 0.027, 0.0012, TILE.glove), mats()[DIAL]);
    dial.userData.tile = TILE.glove;
    dial.position.copy(face.position).addScaledVector(U, 0.0065);
    dial.quaternion.copy(face.quaternion);
    g.add(dial);
  }

  // The forearm in its sleeve, from just over the cuff to the elbow. The
  // sleeve ends in a hem, and it bunches in folds where it is pushed up
  // against the glove; past them it hangs in a few long ones.
  const sleeveFrom = cuffEnd.clone().addScaledVector(toElbow, -0.018);
  const reach = elbow.distanceTo(sleeveFrom);
  // A forearm is narrow at the wrist and swells toward the elbow, and that
  // taper is most of what tells an arm from a pole when it points away.
  g.add(piece([sleeveFrom, sleeveFrom.clone().lerp(elbow, 0.5), elbow], (t) => [0.039 + 0.026 * Math.sqrt(t), 0.034 + 0.017 * Math.sqrt(t)], SLEEVE, {
    side: A, around: 26, step: 0.008, open: [true, true],
    // Deep enough to be seen from where the eye is: a fold a few millimetres
    // proud of a 4 cm sleeve was lit as one smooth pipe. The bunching rings
    // run round the arm and wander along it; the long folds run across it
    // on a slant, the way cloth hangs off a raised forearm.
    bump: (t, th) => {
      const s = t * reach;
      const hem = s < 0.012 ? 0.06 : s < 0.017 ? 0.025 : 0;
      const bunch = Math.max(0, 1 - s / 0.15) ** 0.7;
      const ring = Math.sin(s * 120 + 2.2 * Math.sin(th * 2 + 0.6) + 0.9 * Math.sin(th * 5 + 1.3));
      const folds = 0.14 * bunch * (ring > 0 ? ring : ring * 0.45)
        + 0.07 * Math.sin(th * 3 + s * 26) * (0.35 + 0.65 * t)
        + 0.035 * Math.sin(th * 7 - s * 41);
      return 1 + hem + Math.max(-0.06, folds);
    },
  }));
}

/**
 * The frame of a grip built by `box(w, h, d, ..., rx)`: its axis runs down
 * the grip, its front is the face the fingers close over, both turned by the
 * grip's own rake.
 */
function gripFrame(rx) {
  return {
    A: v3(0, -Math.cos(rx), -Math.sin(rx)),          // down the grip
    F: v3(0, Math.sin(rx), -Math.cos(rx)),           // its front strap
  };
}

/** Right hand on a pistol grip, trigger finger laid straight along the frame. */
function shootingHand(g, { c, rx, hu, hf, stack, index, thumb, elbow = v3(0.11, -0.42, 0.48) }) {
  const { A, F } = gripFrame(rx);
  hand(g, { c, A, U: v3(1, 0, 0), F, hu, hf, stack, index, thumb, elbow });
}

/** Left hand under a handguard or a pump, fingers up its far side. */
function supportHand(g, { c, hu, hf, stack, thumb, elbow = v3(-0.30, -0.46, 0.12) }) {
  hand(g, { c, A: v3(0, 0, -1), U: v3(0, -1, 0), F: v3(1, 0, 0), hu, hf, stack, sweep: 2.5, thumb, elbow, watch: true });
}

/* ------------------------------------------------------------------ models */

/**
 * An M9: a slide with the nose cut back, a frame whose trigger guard is a
 * hole in it, and a grip raked back with a tang over the web of the hand.
 */
function buildPistol() {
  const g = new THREE.Group();
  // slide, with the front cut back at an angle the way a Beretta's is
  g.add(side([
    [-0.188, 0.002, 0.002], [-0.190, 0.034, 0.003], [-0.174, 0.0575, 0.006],
    [0.046, 0.0575, 0.008], [0.062, 0.050, 0.005], [0.064, 0.008, 0.003], [0.060, 0.0, 0.002],
  ], 0.034, METAL, { bevel: 0.004 }));
  // rear serrations, cut across the slide's flanks
  for (let i = 0; i < 8; i++) g.add(box(0.0352, 0.036, 0.0024, DARK, 0, 0.026, 0.053 - i * 0.0056, 0, 0, 0, 0.0006));
  g.add(box(0.002, 0.013, 0.036, DARK, 0.0172, 0.045, -0.034, 0, 0, 0, 0.0006));   // ejection port
  g.add(box(0.040, 0.009, 0.016, DARK, 0, 0.042, 0.040, 0, 0, 0, 0.002));           // decocker
  // the barrel's crown standing proud of the slide, bore and all
  g.add(turned([[0, -0.180], [0.0045, -0.180], [0.0045, -0.195], [0.0085, -0.195], [0.0085, -0.178]], METAL, 0.028));

  // frame: dust cover, trigger guard and grip in one piece
  const GRIP = { c: [0.057, -0.085], rx: -0.26, len: 0.12, depth: 0.068 };
  const grip = gripOutline(GRIP.c, GRIP.rx, GRIP.len, GRIP.depth, { top: -0.028 });
  g.add(side([
    [-0.150, 0.0, 0.002], [0.050, 0.0], [0.074, -0.004, 0.006], [0.088, -0.014, 0.005],
    [grip[1][0], -0.028, 0.004], grip[2], grip[3],
    [grip[3][0] + (grip[0][0] - grip[3][0]) * 0.62, -0.071, 0.004],
    [-0.050, -0.071, 0.010], [-0.066, -0.048, 0.010], [-0.064, -0.022, 0.003], [-0.152, -0.022, 0.003],
  ], 0.030, DARK, {
    bevel: 0.0035,
    holes: [[[0.006, -0.014, 0.003], [0.014, -0.063, 0.004], [-0.047, -0.063, 0.008], [-0.058, -0.046, 0.008], [-0.056, -0.014, 0.003]]],
  }));
  // grip panels, standing proud of the frame
  g.add(side(gripOutline(GRIP.c, GRIP.rx, GRIP.len - 0.022, GRIP.depth - 0.012, { top: -0.032, r: 0.008 }),
    0.044, POLY, { bevel: 0.007 }));
  const base = gripPoint(GRIP, GRIP.len / 2 + 0.004, 0);
  g.add(box(0.034, 0.010, 0.074, DARK, 0, base[1], base[0], GRIP.rx, 0, 0, 0.003));          // mag baseplate
  // trigger: a curved blade hung in the guard
  g.add(side([[-0.020, -0.012], [-0.012, -0.012], [-0.016, -0.034, 0.006], [-0.026, -0.052, 0.003],
    [-0.032, -0.050, 0.002], [-0.024, -0.032, 0.006]], 0.006, DARK, { bevel: 0.0015 }));
  // hammer spur, slide stop
  g.add(side([[0.058, 0.040], [0.068, 0.046], [0.078, 0.066, 0.003], [0.070, 0.070, 0.003], [0.060, 0.058]], 0.010, DARK, { bevel: 0.002 }));
  g.add(box(0.003, 0.006, 0.034, DARK, -0.0158, -0.006, -0.030, 0, 0, 0, 0.001));
  // sights
  g.add(box(0.006, 0.017, 0.008, DARK, 0, 0.066, -0.165, 0, 0, 0, 0.0015));
  g.add(box(0.010, 0.017, 0.012, DARK, -0.017, 0.066, 0.040, 0, 0, 0, 0.0015));
  g.add(box(0.010, 0.017, 0.012, DARK, 0.017, 0.066, 0.040, 0, 0, 0, 0.0015));

  shootingHand(g, {
    c: v3(0, GRIP.c[1], GRIP.c[0]), rx: GRIP.rx, hu: 0.022, hf: GRIP.depth / 2, stack: [-0.046, -0.022, 0.0, 0.022],
    // trigger finger laid along the frame above the guard, off the trigger
    index: [v3(0.027, -0.034, 0.028), v3(0.024, -0.013, -0.020), v3(0.022, -0.010, -0.070)],
    thumb: [v3(0.018, -0.030, 0.090), v3(-0.004, -0.026, 0.094), v3(-0.031, -0.030, 0.064), v3(-0.025, -0.018, 0.018)],
  });
  // the support hand closes over the shooting hand's fingers from the left
  const { A, F } = gripFrame(GRIP.rx);
  hand(g, {
    c: v3(0, GRIP.c[1] - 0.006, GRIP.c[0]), A, U: v3(-1, 0, 0), F, hu: 0.036, hf: 0.047,
    stack: [-0.024, -0.004, 0.014, 0.031], sweep: 2.8,
    thumb: [v3(-0.034, -0.050, 0.060), v3(-0.033, -0.034, 0.018), v3(-0.029, -0.028, -0.028)],
    elbow: v3(-0.26, -0.44, 0.44), watch: true,
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.028, -0.200); g.add(muzzle);
  return { model: g, muzzle };
}

/**
 * An MP5K: a stamped receiver round a cocking tube, a curved magazine raked
 * forward, a vertical grip with a lip to stop the hand riding onto the
 * muzzle, and a trigger housing slung under the back of it all.
 */
function buildSMG() {
  const g = new THREE.Group();
  // receiver, with the cocking tube's housing running out over the barrel
  g.add(side([
    [-0.236, -0.004, 0.006], [-0.236, 0.050, 0.010], [-0.205, 0.058, 0.004], [0.112, 0.058, 0.010],
    [0.126, 0.046, 0.006], [0.126, -0.024], [-0.150, -0.024], [-0.165, -0.004, 0.004],
  ], 0.044, DARK, { bevel: 0.008 }));
  g.add(box(0.0462, 0.004, 0.27, ACCENT, 0, 0.030, -0.06, 0, 0, 0, 0.0012));         // weld seam
  g.add(box(0.002, 0.020, 0.050, DARK, 0.0232, 0.028, -0.005, 0, 0, 0, 0.0006));     // ejection port
  g.add(turned([[0, -0.262], [0.0105, -0.262], [0.0105, -0.234]], DARK, 0.044));      // cocking tube cap
  g.add(box(0.026, 0.010, 0.012, DARK, -0.024, 0.046, -0.220, 0, -0.5, 0, 0.003));   // cocking handle
  // barrel, its three-lug nut, and the crown
  g.add(turned([[0, -0.250], [0.0045, -0.250], [0.0045, -0.300], [0.0095, -0.300], [0.0095, -0.270],
    [0.0135, -0.268], [0.0135, -0.250], [0.0095, -0.248], [0.0095, -0.230]], METAL, 0.012));
  // magazine well and the curved magazine in it
  g.add(side([[-0.104, -0.022], [-0.032, -0.022], [-0.030, -0.048, 0.004], [-0.106, -0.048, 0.004]], 0.040, DARK, { bevel: 0.004 }));
  g.add(side([
    [-0.096, -0.040], [-0.040, -0.040], [-0.044, -0.092, 0.03], [-0.070, -0.160, 0.004],
    [-0.074, -0.172, 0.003], [-0.134, -0.164, 0.003], [-0.130, -0.152, 0.004], [-0.102, -0.094, 0.03],
  ], 0.030, DARK, { bevel: 0.005 }));
  // vertical foregrip, with its hand stop
  g.add(side([
    [-0.226, -0.002], [-0.166, -0.002], [-0.170, -0.040, 0.004], [-0.158, -0.110, 0.006],
    [-0.163, -0.121, 0.004], [-0.214, -0.129, 0.004], [-0.228, -0.124, 0.003], [-0.213, -0.112, 0.004],
    [-0.222, -0.046, 0.006],
  ], 0.036, POLY, { bevel: 0.008 }));
  // trigger housing: guard as a hole, grip raked back
  const GRIP = { c: [0.104, -0.100], rx: -0.20, len: 0.10, depth: 0.060 };
  const grip = gripOutline(GRIP.c, GRIP.rx, GRIP.len, GRIP.depth, { top: -0.040 });
  g.add(side([
    [-0.034, -0.022], [0.124, -0.022], [0.128, -0.034, 0.004], grip[1],
    ...grip.slice(2),
    [0.068, -0.076, 0.004], [-0.010, -0.076, 0.010], [-0.028, -0.056, 0.008], [-0.032, -0.036, 0.004],
  ], 0.034, POLY, {
    bevel: 0.007,
    holes: [[[0.056, -0.034, 0.003], [0.060, -0.066, 0.004], [-0.004, -0.066, 0.008], [-0.018, -0.052, 0.006], [-0.020, -0.034, 0.003]]],
  }));
  g.add(side([[0.020, -0.030], [0.026, -0.030], [0.024, -0.048, 0.006], [0.016, -0.062, 0.002],
    [0.010, -0.060, 0.002], [0.018, -0.046, 0.006]], 0.006, DARK, { bevel: 0.0015 }));   // trigger
  g.add(box(0.050, 0.010, 0.014, ACCENT, 0, -0.010, 0.080, 0, 0, 0, 0.003));             // selector
  g.add(side([[0.120, -0.020], [0.132, -0.016, 0.004], [0.132, 0.050, 0.006], [0.120, 0.056]], 0.046, DARK, { bevel: 0.004 })); // end cap
  optic(g, 0.02);
  shootingHand(g, {
    c: v3(0, GRIP.c[1], GRIP.c[0]), rx: GRIP.rx, hu: 0.025, hf: GRIP.depth / 2, stack: [-0.042, -0.02, 0.003, 0.026],
    index: [v3(0.031, -0.056, 0.080), v3(0.030, -0.040, 0.034), v3(0.028, -0.034, -0.010)],
    thumb: [v3(0.020, -0.040, 0.150), v3(-0.004, -0.034, 0.156), v3(-0.030, -0.040, 0.120), v3(-0.032, -0.034, 0.078)],
  });
  // the support hand round the vertical foregrip, palm on its left
  const fg = gripFrame(-0.15);
  hand(g, {
    c: v3(0, -0.078, -0.19), A: fg.A, U: v3(-1, 0, 0), F: fg.F, hu: 0.0175, hf: 0.025,
    stack: [-0.022, -0.003, 0.016, 0.033], sweep: 3.3,
    thumb: [v3(-0.024, -0.04, -0.16), v3(-0.006, -0.032, -0.19), v3(0.014, -0.036, -0.215)],
    elbow: v3(-0.30, -0.46, 0.10), watch: true,
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, -0.302); g.add(muzzle);
  return { model: g, muzzle };
}

/**
 * An M4: flat-top upper with its rail, a lower whose magazine well flares
 * and whose trigger guard is a hole, a raked grip with finger swells, an
 * octagonal handguard, the A-frame front sight, a birdcage, and a stock
 * riding a buffer tube.
 */
function buildRifle() {
  const g = new THREE.Group();
  // upper receiver, and the rail along it
  g.add(side([
    [-0.176, 0.014, 0.003], [-0.176, 0.060, 0.004], [0.124, 0.060, 0.004], [0.128, 0.052, 0.003],
    [0.128, 0.020, 0.003], [0.104, 0.014],
  ], 0.046, DARK, { bevel: 0.004 }));
  g.add(side([[0.050, 0.020], [0.078, 0.020, 0.006], [0.084, 0.042, 0.006], [0.050, 0.046]], 0.054, DARK, { bevel: 0.004 })); // brass deflector
  g.add(box(0.022, 0.006, 0.30, DARK, 0, 0.063, -0.025, 0, 0, 0, 0.0015));
  for (let i = 0; i < 29; i++) g.add(box(0.026, 0.0045, 0.0052, DARK, 0, 0.0675, -0.168 + i * 0.0102, 0, 0, 0, 0.0012));
  g.add(box(0.003, 0.022, 0.072, ACCENT, 0.0238, 0.036, -0.012, 0, 0, 0, 0.0008));     // ejection port cover
  g.add(turned([[0, 0.060], [0.0085, 0.060], [0.0085, 0.092], [0, 0.092]], METAL, 0.050, { x: 0.026 })); // forward assist
  g.add(box(0.048, 0.010, 0.022, DARK, 0, 0.054, 0.137, 0, 0, 0, 0.003));             // charging handle
  // lower: magazine well, trigger guard, buffer tower
  g.add(side([
    [-0.080, 0.016, 0.003], [0.140, 0.016, 0.003], [0.144, -0.006, 0.006], [0.128, -0.030, 0.006],
    [0.114, -0.032], [0.112, -0.068, 0.004], [0.058, -0.068, 0.005], [0.056, -0.074],
    [0.060, -0.084, 0.003], [-0.032, -0.084, 0.003], [-0.028, -0.074], [-0.032, -0.030, 0.006],
    [-0.080, -0.014, 0.006],
  ], 0.044, DARK, {
    bevel: 0.004,
    holes: [[[0.098, -0.034, 0.003], [0.097, -0.061, 0.003], [0.062, -0.061, 0.003], [0.062, -0.034, 0.003]]],
  }));
  g.add(side([[0.072, -0.030], [0.078, -0.030], [0.077, -0.046, 0.006], [0.070, -0.058, 0.002],
    [0.065, -0.056, 0.002], [0.071, -0.044, 0.006]], 0.006, DARK, { bevel: 0.0015 }));   // trigger
  g.add(box(0.052, 0.008, 0.018, ACCENT, 0, -0.010, 0.112, 0, 0, 0, 0.003));             // selector
  // grip, raked back, with swells between the fingers
  const GRIP = { c: [0.156, -0.098], rx: -0.38, len: 0.10, depth: 0.056 };
  g.add(side(gripOutline(GRIP.c, GRIP.rx, GRIP.len, GRIP.depth, { top: -0.026, grooves: 2 }), 0.048, POLY, { bevel: 0.009 }));
  // STANAG magazine, its few degrees of curve forward
  g.add(side([
    [-0.024, -0.040], [0.054, -0.040], [0.050, -0.100, 0.04], [0.034, -0.182, 0.004],
    [0.038, -0.194, 0.003], [-0.052, -0.194, 0.003], [-0.048, -0.182, 0.004], [-0.030, -0.100, 0.04],
  ], 0.024, DARK, { bevel: 0.004 }));
  // buffer tube and the stock riding it
  g.add(turned([[0, 0.140], [0.0145, 0.140], [0.0145, 0.372], [0, 0.372]], DARK, 0.020, { sides: 18 }));
  g.add(turned([[0, 0.142], [0.0175, 0.142], [0.0175, 0.158], [0, 0.158]], DARK, 0.020, { sides: 14 })); // castle nut
  g.add(side([
    [0.228, 0.042, 0.006], [0.366, 0.042, 0.006], [0.378, 0.036, 0.004], [0.378, -0.082, 0.006],
    [0.360, -0.090, 0.008], [0.250, -0.004, 0.012], [0.224, -0.002, 0.006],
  ], 0.042, POLY, {
    bevel: 0.008,
    holes: [[[0.282, -0.002, 0.004], [0.342, -0.002, 0.006], [0.342, -0.050, 0.006]]],
  }));
  g.add(box(0.046, 0.128, 0.012, DARK, 0, -0.022, 0.382, 0, 0, 0, 0.004));            // butt pad
  // handguard: octagonal, with slots down its flanks and a delta ring behind
  g.add(turned([[0, -0.405], [0.026, -0.405], [0.0355, -0.395], [0.0355, -0.170], [0.040, -0.166],
    [0.040, -0.152], [0, -0.152]], POLY, 0.022, { sides: 8, crease: 30, spin: Math.PI / 8 }));
  for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
    g.add(box(0.002, 0.012, 0.030, DARK, sx * 0.0331, 0.022, -0.200 - i * 0.050, 0, 0, 0, 0.0008));
  }
  // barrel, gas block and A-frame front sight, birdcage
  g.add(turned([[0, -0.548], [0.0108, -0.548], [0.0108, -0.400], [0, -0.400]], METAL, 0.025, { sides: 16 }));
  g.add(side([
    [-0.455, 0.010, 0.003], [-0.430, 0.010, 0.003], [-0.430, 0.044], [-0.437, 0.086, 0.004],
    [-0.449, 0.086, 0.004], [-0.455, 0.044],
  ], 0.024, DARK, {
    bevel: 0.003,
    holes: [[[-0.436, 0.050, 0.002], [-0.440, 0.080, 0.002], [-0.446, 0.080, 0.002], [-0.450, 0.050, 0.002]]],
  }));
  g.add(box(0.004, 0.030, 0.004, DARK, 0, 0.064, -0.443, 0, 0, 0, 0.001));             // the post
  g.add(turned([[0, -0.580], [0.0065, -0.580], [0.0065, -0.612], [0.0125, -0.612], [0.0125, -0.552], [0.0108, -0.546],
    [0.0108, -0.540], [0, -0.540]], DARK, 0.025, { sides: 12, crease: 50 }));
  optic(g, 0.06);
  shootingHand(g, {
    c: v3(0, GRIP.c[1], GRIP.c[0]), rx: GRIP.rx, hu: 0.024, hf: GRIP.depth / 2, stack: [-0.044, -0.020, 0.003, 0.026],
    index: [v3(0.031, -0.044, 0.104), v3(0.030, -0.022, 0.060), v3(0.029, -0.018, 0.012)],
    thumb: [v3(0.020, -0.034, 0.168), v3(-0.004, -0.028, 0.174), v3(-0.030, -0.034, 0.140), v3(-0.032, -0.030, 0.098)],
  });
  supportHand(g, {
    c: v3(0, 0.022, -0.31), hu: 0.036, hf: 0.034, stack: [-0.028, -0.009, 0.01, 0.028],
    thumb: [v3(-0.038, -0.010, -0.27), v3(-0.044, 0.006, -0.31), v3(-0.042, 0.018, -0.35)],
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.025, -0.615); g.add(muzzle);
  return { model: g, muzzle };
}

/**
 * An M1014: an alloy receiver, a long barrel over a magazine tube, a forend
 * wrapped round both, and a pistol-grip stock in one piece of polymer.
 */
function buildShotgun() {
  const g = new THREE.Group();
  g.add(side([
    [-0.172, -0.040, 0.004], [-0.172, 0.048, 0.006], [-0.150, 0.060, 0.008], [0.096, 0.060, 0.010],
    [0.128, 0.046, 0.008], [0.132, 0.008, 0.004], [0.132, -0.040, 0.004],
  ], 0.050, DARK, { bevel: 0.007 }));
  g.add(box(0.003, 0.026, 0.072, DARK, 0.0255, 0.022, -0.030, 0, 0, 0, 0.0008));    // ejection port
  g.add(box(0.008, 0.012, 0.036, ACCENT, 0.027, 0.004, -0.030, 0, 0, 0, 0.002));    // bolt handle
  g.add(box(0.032, 0.006, 0.090, DARK, 0, -0.042, -0.070, 0, 0, 0, 0.002));         // loading port
  // trigger group: guard as a hole
  g.add(side([
    [-0.020, -0.036], [0.112, -0.036], [0.108, -0.050], [0.100, -0.050], [0.098, -0.080, 0.005],
    [0.020, -0.080, 0.010], [0.004, -0.058, 0.008], [0.002, -0.038],
  ], 0.032, POLY, {
    bevel: 0.006,
    holes: [[[0.084, -0.044, 0.003], [0.083, -0.072, 0.004], [0.026, -0.072, 0.008], [0.014, -0.056, 0.006], [0.014, -0.044, 0.003]]],
  }));
  g.add(side([[0.054, -0.040], [0.060, -0.040], [0.058, -0.056, 0.006], [0.050, -0.070, 0.002],
    [0.044, -0.068, 0.002], [0.052, -0.054, 0.006]], 0.006, DARK, { bevel: 0.0015 }));   // trigger
  g.add(box(0.012, 0.010, 0.020, ACCENT, 0, 0.066, 0.090, 0, 0, 0, 0.003));              // safety
  // stock and pistol grip, one moulding
  const GRIP = { c: [0.136, -0.098], rx: -0.32, len: 0.10, depth: 0.058 };
  const grip = gripOutline(GRIP.c, GRIP.rx, GRIP.len, GRIP.depth, { top: -0.036, grooves: 0 });
  g.add(side([
    [0.126, 0.050, 0.004], [0.200, 0.046, 0.04], [0.372, 0.040, 0.010], [0.386, 0.032, 0.004],
    [0.386, -0.098, 0.006], [0.370, -0.108, 0.010],
    // the underside sweeps up to a wrist behind the grip, then down its backstrap
    [...gripPoint(GRIP, -0.032, -GRIP.depth / 2), 0.016],
    grip[2], grip[3], grip[0], [0.126, -0.036],
  ], 0.044, POLY, { bevel: 0.009 }));
  g.add(box(0.048, 0.140, 0.014, DARK, 0, -0.033, 0.392, 0, 0, 0, 0.005));            // recoil pad
  // barrel and magazine tube, and the forend wrapped round both
  g.add(turned([[0, -0.610], [0.0092, -0.610], [0.0092, -0.632], [0.0135, -0.632], [0.0135, -0.168], [0, -0.168]], METAL, 0.035));
  g.add(turned([[0, -0.560], [0.0150, -0.560], [0.0160, -0.548], [0.0160, -0.534], [0.0130, -0.532],
    [0.0130, -0.170], [0, -0.170]], DARK, -0.012));
  g.add(side([
    [-0.362, -0.034, 0.012], [-0.362, 0.026, 0.010], [-0.174, 0.030, 0.006], [-0.174, -0.036, 0.008],
  ], 0.056, POLY, { bevel: 0.012 }));
  for (let i = 0; i < 7; i++) g.add(box(0.0575, 0.050, 0.004, DARK, 0, -0.004, -0.320 + i * 0.020, 0, 0, 0, 0.0012));
  // ghost ring, and the blade at the muzzle
  for (const sx of [-1, 1]) g.add(side([[0.080, 0.058], [0.104, 0.058], [0.100, 0.078, 0.003], [0.088, 0.080, 0.003]], 0.006, DARK, { bevel: 0.0015, x: sx * 0.010 }));
  g.add(side([[-0.606, 0.045], [-0.586, 0.045], [-0.592, 0.060, 0.003], [-0.602, 0.060, 0.002]], 0.004, DARK, { bevel: 0.001 }));
  shootingHand(g, {
    c: v3(0, GRIP.c[1], GRIP.c[0]), rx: GRIP.rx, hu: 0.026, hf: GRIP.depth / 2, stack: [-0.044, -0.020, 0.003, 0.026],
    index: [v3(0.032, -0.052, 0.092), v3(0.031, -0.044, 0.046), v3(0.030, -0.040, 0.004)],
    thumb: [v3(0.020, -0.034, 0.160), v3(-0.004, -0.028, 0.166), v3(-0.031, -0.034, 0.130), v3(-0.033, -0.030, 0.088)],
  });
  supportHand(g, {
    c: v3(0, -0.004, -0.27), hu: 0.032, hf: 0.029, stack: [-0.03, -0.01, 0.01, 0.03],
    thumb: [v3(-0.036, -0.030, -0.23), v3(-0.042, -0.012, -0.27), v3(-0.040, 0.002, -0.31)],
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.035, -0.636); g.add(muzzle);
  return { model: g, muzzle };
}

/**
 * One mesh per material, for the whole weapon and the hands holding it.
 *
 * A gun is forty-odd parts and the hands add thirty more; drawn as they were
 * built, that is seventy draw calls for something a fifth of a metre long.
 * Every part is a direct child of the model with a frozen pose, so each is
 * baked into its material's buffer once and the parts are dropped — the same
 * trade the city and the hostiles make, vertices for objects. What has to
 * stay its own object does: the muzzle point, the see-through lens, and the
 * dot that is drawn unlit.
 */
function consolidate(model) {
  const groups = new Map();
  for (const o of [...model.children]) {
    if (!o.isMesh || o.material.transparent || o.material.isMeshBasicMaterial) continue;
    o.updateMatrix();
    const geo = o.geometry.clone().applyMatrix4(o.matrix);
    if (!groups.has(o.material)) groups.set(o.material, { geos: [], tile: o.userData.tile });
    groups.get(o.material).geos.push(geo);
    model.remove(o);
    o.geometry.dispose();
  }
  for (const [material, { geos, tile }] of groups) {
    const m = new THREE.Mesh(mergeIntoOne(geos), material);
    m.userData.tile = tile;
    model.add(m);
    for (const g of geos) g.dispose();
  }
}

/* ---------------------------------------------------------------- weapons */

export const WEAPON_DEFS = [
  {
    id: 'pistol', name: 'M9 SIDEARM', sound: 'pistol', build: buildPistol,
    auto: false, damage: 30, headMult: 2.6, rpm: 430, mag: 15, startReserve: 90, maxReserve: 150,
    pellets: 1, spread: 0.016, adsSpread: 0.004, recoil: { v: 0.021, h: 0.006 }, kick: 0.035,
    reload: 1.35, adsTime: 0.16, adsFovMul: 0.88, range: 120, tracer: 0.9, unlock: 1,
    hip: new THREE.Vector3(0.17, -0.14, -0.42), ads: new THREE.Vector3(0, -0.066, -0.34),
  },
  {
    id: 'smg', name: 'MP5K SMG', sound: 'smg', build: buildSMG,
    auto: true, damage: 19, headMult: 2.0, rpm: 880, mag: 30, startReserve: 180, maxReserve: 300,
    pellets: 1, spread: 0.030, adsSpread: 0.011, recoil: { v: 0.013, h: 0.008 }, kick: 0.026,
    reload: 1.9, adsTime: 0.20, adsFovMul: 0.85, range: 90, tracer: 0.9, unlock: 1,
    hip: new THREE.Vector3(0.19, -0.15, -0.54), ads: new THREE.Vector3(0, -0.099, -0.46),
  },
  {
    id: 'rifle', name: 'M4A1 CARBINE', sound: 'rifle', build: buildRifle,
    auto: true, damage: 29, headMult: 2.4, rpm: 720, mag: 30, startReserve: 150, maxReserve: 270,
    pellets: 1, spread: 0.024, adsSpread: 0.0055, recoil: { v: 0.017, h: 0.007 }, kick: 0.032,
    reload: 2.2, adsTime: 0.24, adsFovMul: 0.78, range: 200, tracer: 1.1, unlock: 2,
    hip: new THREE.Vector3(0.20, -0.16, -0.62), ads: new THREE.Vector3(0, -0.099, -0.52),
  },
  {
    id: 'shotgun', name: 'M1014 BREACHER', sound: 'shotgun', build: buildShotgun,
    auto: false, damage: 15, headMult: 1.6, rpm: 130, mag: 7, startReserve: 40, maxReserve: 80,
    pellets: 9, spread: 0.075, adsSpread: 0.048, recoil: { v: 0.055, h: 0.016 }, kick: 0.11,
    reload: 2.6, adsTime: 0.22, adsFovMul: 0.9, range: 40, tracer: 0.8, unlock: 3, falloff: 22,
    hip: new THREE.Vector3(0.20, -0.155, -0.64), ads: new THREE.Vector3(0, -0.069, -0.56),
  },
];

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const Q1 = new THREE.Quaternion();

const MELEE_TIME = 0.42;      // full swing duration
export const MELEE_RANGE = 2.6;
export const MELEE_DAMAGE = 85;

export class WeaponSystem {
  /**
   * @param {THREE.Scene} viewScene separate scene drawn over the world so the
   *        gun never clips into geometry
   */
  constructor(viewScene, game) {
    this.game = game;
    this.root = new THREE.Group();
    viewScene.add(this.root);

    // Built here rather than on the first shot, which is where it used to be:
    // that compiled its shader in the middle of the first fight and minted
    // its UUIDs out of the seeded stream the moment the trigger was pulled.
    this._flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: game.effects.spriteMaps.flash,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this._flashSprite.visible = false;
    this.root.add(this._flashSprite);
    this._flashLife = 0;

    this.weapons = WEAPON_DEFS.map((def) => {
      DIGITS = [];
      const { model, muzzle } = def.build();
      model.userData.digits = DIGITS;
      consolidate(model);
      model.visible = false;
      model.traverse((o) => { o.frustumCulled = false; });
      this.root.add(model);
      return {
        def, model, muzzle,
        mag: def.mag, reserve: def.startReserve, unlocked: def.unlock <= 1,
      };
    });

    this.index = 0;
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextShot = 0;
    this.adsT = 0;
    this.ads = false;
    this.switching = 0;
    this.bobT = 0;
    this.meleeT = 0;
    this.meleeCooldown = 0;

    this.kickPos = new THREE.Vector3();
    this.kickRot = new THREE.Vector3();
    this.sway = new THREE.Vector2();

    this.current.model.visible = true;
  }

  get current() { return this.weapons[this.index]; }
  get def() { return this.weapons[this.index].def; }

  reset() {
    this.meleeT = 0;
    this.meleeCooldown = 0;
    for (const w of this.weapons) {
      w.mag = w.def.mag;
      w.reserve = w.def.startReserve;
      w.unlocked = w.def.unlock <= 1;
      w.model.visible = false;
    }
    this.index = 0;
    this.reloading = false;
    this.ads = false;
    this.adsT = 0;
    this.nextShot = 0;
    this.current.model.visible = true;
  }

  unlockForWave(wave) {
    const newly = [];
    for (const w of this.weapons) {
      if (!w.unlocked && w.def.unlock <= wave) { w.unlocked = true; newly.push(w.def.name); }
    }
    return newly;
  }

  select(i, time) {
    if (i === this.index || i < 0 || i >= this.weapons.length) return;
    if (!this.weapons[i].unlocked) return;
    this.current.model.visible = false;
    this.index = i;
    this.current.model.visible = true;
    this.reloading = false;
    this.switching = 0.32;
    this.nextShot = Math.max(this.nextShot, time + 0.3);
    audio.swap();
  }

  cycle(dir, time) {
    const n = this.weapons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.index + dir * k + n * 2) % n;
      if (this.weapons[i].unlocked) { this.select(i, time); return; }
    }
  }

  /** Has this weapon anything left to fire, loaded or in reserve? */
  static armed(w) { return w.unlocked && (w.mag > 0 || w.reserve > 0); }

  /** Is anything in the loadout still able to shoot? */
  get anyArmed() { return this.weapons.some((w) => WeaponSystem.armed(w)); }

  /**
   * Swap to the next weapon that can still shoot.
   *
   * A gun with an empty mag and an empty reserve is scenery: holding the
   * trigger on one gets you a dry click every quarter second and nothing
   * else, which reads as the gun having broken rather than as being out of
   * ammo — there is not even a reload prompt, because there is nothing to
   * reload from. Reaching for a loaded weapon is what a person would do.
   * @returns {boolean} whether a swap happened
   */
  switchToArmed(time) {
    const n = this.weapons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.index + k) % n;
      if (WeaponSystem.armed(this.weapons[i])) { this.select(i, time); return true; }
    }
    return false;
  }

  addAmmo(fraction = 0.35, all = false) {
    let gained = false;
    for (const w of this.weapons) {
      if (!w.unlocked) continue;
      if (!all && w !== this.current) continue;
      const add = Math.ceil(w.def.maxReserve * fraction);
      const before = w.reserve;
      w.reserve = Math.min(w.def.maxReserve, w.reserve + add);
      if (w.reserve > before) gained = true;
    }
    return gained;
  }

  /** What a magazine holds, with the armoury's extended magazines fitted. */
  magSize(w) {
    const kit = this.game.kit;
    return Math.round(w.def.mag * (kit ? EFFECT.mags[kit.mags] : 1));
  }

  startReload(time) {
    const w = this.current;
    if (this.reloading || w.mag >= this.magSize(w) || w.reserve <= 0) return;
    this.reloading = true;
    this.reloadStart = time;
    this.reloadEnd = time + w.def.reload;
    audio.reload('out');
    setTimeout(() => audio.reload('in'), w.def.reload * 450);
    setTimeout(() => audio.reload(w.def.id === 'shotgun' ? 'shell' : 'bolt'), w.def.reload * 800);
  }

  finishReload() {
    const w = this.current;
    const need = this.magSize(w) - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take;
    w.reserve -= take;
    this.reloading = false;
  }

  canFire(time) {
    return !this.reloading && time >= this.nextShot && this.switching <= 0 && this.meleeT <= 0;
  }

  /**
   * Buttstroke with whatever is in your hands. Interrupts a reload, which is
   * the point: it is the answer to something already inside your guard.
   * @returns {boolean} whether the swing started
   */
  startMelee(time) {
    if (this.meleeT > 0 || this.meleeCooldown > 0 || this.switching > 0) return false;
    this.reloading = false;
    this.meleeT = MELEE_TIME;
    this.meleeCooldown = 0.85;
    this.meleeHitDone = false;
    this.nextShot = Math.max(this.nextShot, time + MELEE_TIME);
    audio.meleeSwing();
    return true;
  }

  /** Fire one round/volley. Returns true if a shot went out. */
  fire(time, camera, moving) {
    const w = this.current, d = w.def;
    if (!this.canFire(time)) return false;
    if (w.mag <= 0) {
      this.nextShot = time + 0.28;
      audio.dryFire();
      return false;
    }

    w.mag--;
    this.nextShot = time + 60 / d.rpm;

    const kit = this.game.kit;
    const spreadBase = this.adsT > 0.6 ? d.adsSpread * (kit ? EFFECT.opticsSpread[kit.optics] : 1) : d.spread;
    const spread = spreadBase * (moving ? 1.5 : 1) * (this.game.player.crouching ? 0.7 : 1);

    camera.getWorldDirection(V1);
    V2.set(0, 1, 0).cross(V1).normalize();   // camera right (negated), fine for jitter
    const up = new THREE.Vector3().crossVectors(V1, V2).normalize();

    for (let p = 0; p < d.pellets; p++) {
      const dir = V1.clone();
      const sx = (Math.random() + Math.random() - 1) * spread;
      const sy = (Math.random() + Math.random() - 1) * spread;
      dir.addScaledVector(V2, sx).addScaledVector(up, sy).normalize();
      this.game.hitscan(dir, d);
    }

    // recoil: vertical kick with a little horizontal wander
    const mult = this.adsT > 0.6 ? 0.7 : 1;
    this.game.applyRecoil(d.recoil.v * mult, (Math.random() - 0.5) * 2 * d.recoil.h * mult);
    this.kickPos.z += d.kick;
    this.kickPos.y += d.kick * 0.25;
    this.kickRot.x -= d.kick * 2.4;
    this.kickRot.z += (Math.random() - 0.5) * d.kick;

    audio.shot(d.sound);
    this.game.alertNearby(d.id === 'shotgun' ? 48 : 40);
    this.muzzleWorld(V1);
    this.game.effects.muzzle(V1, d.id === 'shotgun' ? 1.6 : 1);
    this.game.effects.ejectCasing(V1, V2.clone().negate());
    this.flash(d);
    return true;
  }

  /** Approximate world-space muzzle position for lights, tracers and casings. */
  muzzleWorld(out) {
    const cam = this.game.camera;
    cam.getWorldDirection(out);
    const right = V2.set(0, 1, 0).cross(out).normalize().multiplyScalar(-0.16 * (1 - this.adsT));
    out.multiplyScalar(0.75).add(right);
    out.y -= 0.12 * (1 - this.adsT);
    out.add(cam.position);
    return out;
  }

  flash(def) {
    const w = this.current;
    w.muzzle.getWorldPosition(this._flashSprite.position);
    this.root.worldToLocal(this._flashSprite.position);
    const s = def.id === 'shotgun' ? 0.34 : def.id === 'pistol' ? 0.2 : 0.26;
    this._flashSprite.scale.set(s, s, 1);
    this._flashSprite.material.rotation = Math.random() * 6.28;
    this._flashSprite.visible = true;
    this._flashLife = 0.045;
  }

  update(dt, time, input, player) {
    const d = this.def;

    // ADS blend
    this.ads = input.aim && !this.reloading && this.switching <= 0;
    const rate = dt / Math.max(0.01, d.adsTime);
    this.adsT = THREE.MathUtils.clamp(this.adsT + (this.ads ? rate : -rate * 1.4), 0, 1);

    if (this.switching > 0) this.switching -= dt;
    if (this.meleeCooldown > 0) this.meleeCooldown -= dt;
    if (this.meleeT > 0) {
      this.meleeT -= dt;
      // the strike lands partway through the swing, not on the keypress
      if (!this.meleeHitDone && this.meleeT <= MELEE_TIME * 0.45) {
        this.meleeHitDone = true;
        this.game.meleeStrike();
      }
    }
    if (this.reloading && time >= this.reloadEnd) this.finishReload();

    if (this._flashLife > 0) {
      this._flashLife -= dt;
      if (this._flashLife <= 0) this._flashSprite.visible = false;
    }

    // ---- view model placement -----------------------------------------
    const model = this.current.model;
    const base = V1.copy(d.hip).lerp(d.ads, this.adsT);

    // walk bob
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    this.bobT += dt * (6 + speed * 1.1);
    const bobAmt = Math.min(speed / 6, 1) * (1 - this.adsT * 0.85) * (player.onGround ? 1 : 0.2);
    base.x += Math.cos(this.bobT) * 0.014 * bobAmt;
    base.y += Math.abs(Math.sin(this.bobT)) * 0.016 * bobAmt;

    // mouse sway
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-input.lookDelta.x * 0.6, -0.05, 0.05), 8, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(-input.lookDelta.y * 0.6, -0.05, 0.05), 8, dt);
    base.x += this.sway.x * (1 - this.adsT * 0.7);
    base.y += this.sway.y * (1 - this.adsT * 0.7);

    // recoil spring
    this.kickPos.multiplyScalar(Math.max(0, 1 - 16 * dt));
    this.kickRot.multiplyScalar(Math.max(0, 1 - 14 * dt));
    base.add(this.kickPos);

    // sprint / reload / switch poses
    let rx = this.kickRot.x, ry = this.kickRot.y, rz = this.kickRot.z;
    if (this.reloading) {
      const t = THREE.MathUtils.clamp((time - this.reloadStart) / d.reload, 0, 1);
      const arc = Math.sin(t * Math.PI);
      base.y -= 0.14 * arc;
      base.z += 0.06 * arc;
      rx += 0.5 * arc;
      rz += 0.45 * arc;
    }
    if (this.switching > 0) {
      const t = this.switching / 0.32;
      base.y -= 0.24 * t;
      rx += 0.7 * t;
    }
    if (this.meleeT > 0) {
      // wind up across the chest, then drive through
      const t = 1 - this.meleeT / MELEE_TIME;
      const arc = Math.sin(t * Math.PI);
      const drive = Math.sin(Math.min(1, t * 1.6) * Math.PI);
      base.x += 0.16 * arc - 0.24 * drive;
      base.y += 0.07 * arc;
      base.z += 0.20 * drive;
      rx += 0.35 * arc;
      ry -= 1.15 * drive;
      rz += 0.75 * arc;
    }
    if (player.sprinting && speed > 3 && !this.ads) {
      base.y -= 0.045;
      base.x += 0.02;
      rx += 0.22;
      ry += 0.42;
      rz += 0.18;
    }

    model.position.lerp(base, Math.min(1, dt * 18));
    Q1.setFromEuler(new THREE.Euler(rx, ry, rz));
    model.quaternion.slerp(Q1, Math.min(1, dt * 18));
  }
}
