import * as THREE from 'three';
import * as TEX from './textures.js';
import { TILE } from './textures.js';
import { chamferGeo, mergeIntoOne } from './shapes.js';
import { audio } from './audio.js';

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
    ...clothBits, color: 0x5a5b4c, roughness: 1, metalness: 0, envMapIntensity: 0.45,
  });
  return MATS;
}

// The builders read these by name, so each one resolves through `mats()` at
// the moment a model is built rather than at import.
const POLY = 'POLY', METAL = 'METAL', DARK = 'DARK', ACCENT = 'ACCENT', GLOW = 'GLOW';
const GLOVE = 'GLOVE', SLEEVE = 'SLEEVE';

/** The tile a material's parts unwrap at — see `TILE`. */
const tileOf = (mat) => (mat === POLY ? TILE.gunPoly : mat === GLOVE ? TILE.glove
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

/** A tube through `points`, rounded at both ends — a finger, a thumb. */
function digit(points, r, mat = GLOVE) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, Math.max(6, points.length * 4), r, 10, false);
  const tile = tileOf(mat), len = curve.getLength();
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / tile, uv.getY(i) * (2 * Math.PI * r) / tile);
  uv.needsUpdate = true;
  const out = [new THREE.Mesh(geo, mats()[mat])];
  out[0].userData.tile = tile;
  for (const p of [points[0], points[points.length - 1]]) {
    const cap = new THREE.SphereGeometry(r, 10, 8);
    const cuv = cap.attributes.uv;
    for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) * (2 * Math.PI * r) / tile, cuv.getY(i) * (Math.PI * r) / tile);
    cuv.needsUpdate = true;
    const m = new THREE.Mesh(cap, mats()[mat]);
    m.position.copy(p);
    m.userData.tile = tile;
    out.push(m);
  }
  return out;
}

/** A tapered limb from `a` (radius ra) to `b` (radius rb): wrist, forearm. */
function limb(a, b, ra, rb, mat) {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(rb, ra, len, 14, 1, true);
  const tile = tileOf(mat), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (Math.PI * (ra + rb)) / tile, uv.getY(i) * len / tile);
  uv.needsUpdate = true;
  // open-ended, so it is seen from inside where it leaves the frame
  const m = new THREE.Mesh(geo, sided(mat));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), b.clone().sub(a).normalize());
  m.userData.tile = tile;
  return m;
}

const SIDED = {};
function sided(mat) {
  if (!SIDED[mat]) { SIDED[mat] = mats()[mat].clone(); SIDED[mat].side = THREE.DoubleSide; }
  return SIDED[mat];
}

/**
 * A gloved hand closed around a grip, and the arm behind it.
 *
 * The grip is described by a frame rather than by the gun: `c` is where the
 * hand sits, `A` the axis the fingers stack along, `U` the side the palm is
 * on, `F` the way the fingers go first as they leave it, and `hu`/`hf` the
 * grip's half-thickness along `U` and `F`. Each finger is an arc around that
 * cross-section — the same four lines of arithmetic close a hand on a pistol
 * grip, a handguard, a vertical grip or a pump — and the arm runs from the
 * heel of the hand back to `elbow`, which is chosen off the bottom of the
 * frame so the sleeve leaves the picture rather than ending in it.
 *
 * `index` replaces the first finger with a path of its own, for a trigger
 * finger laid along the frame; `thumb` is a path likewise.
 */
function hand(g, { c, A, U, F, hu, hf, stack, sweep = 3.6, r = 0.0088, index = null, thumb = null, elbow }) {
  A = A.clone().normalize(); U = U.clone().normalize(); F = F.clone().normalize();
  const at = (a, th, out = 0) => c.clone()
    .addScaledVector(A, a)
    .addScaledVector(U, Math.cos(th) * (hu + r + out))
    .addScaledVector(F, Math.sin(th) * (hf + r + out));
  const fingers = index ? stack.slice(1) : stack;
  for (const [k, a] of fingers.entries()) {
    const reach = sweep * (k === fingers.length - 1 ? 0.88 : 1);   // the little finger is short
    const pts = [];
    for (let i = 0; i <= 7; i++) pts.push(at(a, 0.32 + (reach - 0.32) * (i / 7), i === 0 ? r * 0.6 : 0));
    for (const m of digit(pts, r * (k === fingers.length - 1 ? 0.88 : 1))) g.add(m);
  }
  if (index) for (const m of digit(index, r)) g.add(m);
  if (thumb) for (const m of digit(thumb, r * 1.12)) g.add(m);

  // the back of the hand: from the knuckle line back to the wrist, lying on
  // the palm side of the grip
  const a0 = stack[0], a1 = stack[stack.length - 1], mid = (a0 + a1) / 2;
  const span = Math.abs(a1 - a0) + r * 3.2, length = 0.085, thick = 0.026;
  const back = new THREE.Mesh(chamferGeo(thick, span, length, 0.009, TILE.glove), mats()[GLOVE]);
  back.userData.tile = TILE.glove;
  const centre = c.clone().addScaledVector(A, mid).addScaledVector(U, hu + thick / 2 + 0.002)
    .addScaledVector(F, hf * 0.55 - length / 2);
  back.position.copy(centre);
  back.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(U, A, F.clone().negate()));
  g.add(back);

  // wrist and arm, from the heel of the hand to the elbow
  const heel = centre.clone().addScaledVector(F, -length / 2 + 0.01);
  const toElbow = elbow.clone().sub(heel).normalize();
  const cuff = heel.clone().addScaledVector(toElbow, 0.07);
  g.add(limb(heel, cuff, 0.03, 0.036, GLOVE));
  g.add(limb(cuff.clone().addScaledVector(toElbow, -0.006), elbow, 0.041, 0.054, SLEEVE));
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
  hand(g, { c, A: v3(0, 0, -1), U: v3(0, -1, 0), F: v3(1, 0, 0), hu, hf, stack, sweep: 2.5, thumb, elbow });
}

/* ------------------------------------------------------------------ models */

function buildPistol() {
  const g = new THREE.Group();
  g.add(box(0.045, 0.075, 0.24, METAL, 0, 0.02, -0.06));        // slide
  g.add(box(0.042, 0.05, 0.20, POLY, 0, -0.04, -0.04));         // frame
  g.add(box(0.05, 0.115, 0.075, POLY, 0, -0.115, 0.045, 0.22, 0, 0, 0.016)); // grip
  // trigger guard as a loop, and a trigger inside it
  g.add(box(0.012, 0.008, 0.058, POLY, 0, -0.088, -0.012, 0, 0, 0, 0.003));   // guard, bottom
  g.add(box(0.012, 0.03, 0.008, POLY, 0, -0.075, -0.039, 0.2, 0, 0, 0.003));  // guard, front
  g.add(box(0.006, 0.026, 0.007, DARK, 0, -0.072, -0.008, 0.28, 0, 0, 0.002)); // trigger
  // slide: rear serrations, ejection port, hammer, decocker
  for (let i = 0; i < 7; i++) g.add(box(0.0465, 0.05, 0.0028, DARK, 0, 0.022, 0.048 - i * 0.0065, 0, 0, 0, 0.0008));
  g.add(box(0.013, 0.012, 0.034, DARK, 0.016, 0.054, -0.035, 0, 0, 0, 0.002));   // ejection port
  g.add(box(0.012, 0.024, 0.012, DARK, 0, 0.046, 0.066, -0.4, 0, 0, 0.003));     // hammer
  g.add(box(0.052, 0.008, 0.016, DARK, 0, 0.036, 0.042, 0, 0, 0, 0.002));        // decocker
  g.add(box(0.03, 0.01, 0.05, POLY, 0, -0.07, -0.11));                          // dust cover
  g.add(box(0.046, 0.012, 0.07, DARK, 0, -0.177, 0.031, 0.22, 0, 0, 0.004));     // mag baseplate
  g.add(tube(0.012, 0.012, 0.05, DARK, 0, 0.02, -0.19));        // muzzle
  g.add(box(0.007, 0.016, 0.008, DARK, 0, 0.070, -0.16));       // front post
  g.add(box(0.010, 0.016, 0.012, DARK, -0.017, 0.070, 0.04));   // rear notch, left
  g.add(box(0.010, 0.016, 0.012, DARK, 0.017, 0.070, 0.04));    // rear notch, right
  shootingHand(g, {
    c: v3(0, -0.115, 0.045), rx: 0.22, hu: 0.025, hf: 0.0375, stack: [-0.05, -0.028, -0.004, 0.02],
    index: [v3(0.031, -0.062, 0.03), v3(0.03, -0.054, -0.015), v3(0.027, -0.05, -0.06)],
    thumb: [v3(0.018, -0.05, 0.085), v3(-0.006, -0.046, 0.088), v3(-0.029, -0.05, 0.05), v3(-0.031, -0.048, 0.005)],
  });
  // the support hand closes over the shooting hand's fingers from the left
  const { A, F } = gripFrame(0.22);
  hand(g, {
    c: v3(0, -0.12, 0.045), A, U: v3(-1, 0, 0), F, hu: 0.044, hf: 0.056,
    stack: [-0.02, 0.003, 0.026, 0.047], sweep: 3.0,
    thumb: [v3(-0.036, -0.08, 0.05), v3(-0.036, -0.066, 0.005), v3(-0.032, -0.06, -0.04)],
    elbow: v3(-0.26, -0.44, 0.44),
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -0.215); g.add(muzzle);
  return { model: g, muzzle };
}

function buildSMG() {
  const g = new THREE.Group();
  g.add(box(0.055, 0.10, 0.34, POLY, 0, 0.01, -0.08));          // receiver
  g.add(tube(0.016, 0.016, 0.10, METAL, 0, 0.03, -0.28));       // barrel shroud
  g.add(box(0.04, 0.14, 0.055, DARK, 0, -0.10, 0.0, -0.30));    // magazine
  g.add(box(0.05, 0.10, 0.06, POLY, 0, -0.10, 0.10, 0.18, 0, 0, 0.015)); // pistol grip
  g.add(box(0.035, 0.075, 0.05, POLY, 0, -0.075, -0.19, -0.15, 0, 0, 0.012)); // vertical foregrip
  g.add(box(0.04, 0.05, 0.13, ACCENT, 0, 0.0, 0.19));           // folding stock
  g.add(box(0.055, 0.02, 0.05, DARK, 0, 0.062, 0.06));
  g.add(tube(0.010, 0.010, 0.14, DARK, 0, 0.058, -0.18));       // cocking tube
  g.add(box(0.024, 0.01, 0.012, DARK, -0.022, 0.058, -0.215, 0, 0, 0, 0.003)); // cocking handle
  g.add(box(0.057, 0.006, 0.26, DARK, 0, 0.032, -0.09, 0, 0, 0, 0.002));        // receiver rib
  g.add(box(0.003, 0.02, 0.05, DARK, 0.028, 0.03, 0.0));                        // ejection port
  g.add(box(0.012, 0.007, 0.06, POLY, 0, -0.062, 0.045, 0, 0, 0, 0.003));       // guard, bottom
  g.add(box(0.012, 0.024, 0.008, POLY, 0, -0.05, 0.015, 0.2, 0, 0, 0.003));     // guard, front
  g.add(box(0.006, 0.024, 0.006, DARK, 0, -0.048, 0.055, 0.25, 0, 0, 0.002));   // trigger
  optic(g, 0.02);
  shootingHand(g, {
    c: v3(0, -0.10, 0.10), rx: 0.18, hu: 0.025, hf: 0.03, stack: [-0.042, -0.02, 0.003, 0.026],
    index: [v3(0.032, -0.062, 0.075), v3(0.032, -0.052, 0.03), v3(0.03, -0.048, -0.01)],
    thumb: [v3(0.02, -0.045, 0.14), v3(-0.004, -0.04, 0.145), v3(-0.03, -0.045, 0.11), v3(-0.032, -0.04, 0.07)],
  });
  // the support hand round the vertical foregrip, palm on its left
  const fg = gripFrame(-0.15);
  hand(g, {
    c: v3(0, -0.078, -0.19), A: fg.A, U: v3(-1, 0, 0), F: fg.F, hu: 0.0175, hf: 0.025,
    stack: [-0.022, -0.003, 0.016, 0.033], sweep: 3.3,
    thumb: [v3(-0.024, -0.04, -0.16), v3(-0.006, -0.032, -0.19), v3(0.014, -0.036, -0.215)],
    elbow: v3(-0.30, -0.46, 0.10),
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.03, -0.34); g.add(muzzle);
  return { model: g, muzzle };
}

function buildRifle() {
  const g = new THREE.Group();
  g.add(box(0.052, 0.05, 0.30, DARK, 0, 0.042, -0.025, 0, 0, 0, 0.008));  // upper receiver
  g.add(box(0.05, 0.056, 0.22, POLY, 0, -0.01, 0.03, 0, 0, 0, 0.010));    // lower receiver
  g.add(box(0.054, 0.042, 0.074, POLY, 0, -0.047, 0.012, 0, 0, 0, 0.008)); // magwell
  g.add(box(0.003, 0.022, 0.07, ACCENT, 0.0275, 0.04, -0.01));            // ejection port cover
  g.add(tube(0.009, 0.009, 0.03, METAL, 0.027, 0.052, 0.075));            // forward assist
  g.add(box(0.05, 0.008, 0.016, DARK, 0, 0.071, 0.13, 0, 0, 0, 0.003));   // charging handle
  g.add(box(0.012, 0.007, 0.07, POLY, 0, -0.064, 0.07, 0, 0, 0, 0.003));  // guard, bottom
  g.add(box(0.012, 0.026, 0.008, POLY, 0, -0.05, 0.036, 0.2, 0, 0, 0.003)); // guard, front
  g.add(box(0.006, 0.024, 0.006, DARK, 0, -0.05, 0.075, 0.25, 0, 0, 0.002)); // trigger
  // front sight: base on the barrel, post between two wings
  g.add(box(0.02, 0.014, 0.03, DARK, 0, 0.042, -0.44, 0, 0, 0, 0.003));
  g.add(box(0.006, 0.042, 0.008, DARK, 0, 0.066, -0.44, 0, 0, 0, 0.002));
  for (const sx of [-1, 1]) g.add(box(0.004, 0.05, 0.022, DARK, sx * 0.011, 0.064, -0.44, 0, 0, sx * 0.12, 0.0015));
  g.add(box(0.06, 0.07, 0.26, DARK, 0, 0.02, -0.28, 0, 0, 0, 0.010)); // handguard
  for (let i = 0; i < 4; i++) g.add(box(0.062, 0.008, 0.012, ACCENT, 0, 0.055, -0.20 - i * 0.05));
  g.add(tube(0.013, 0.013, 0.20, METAL, 0, 0.025, -0.46));      // barrel
  g.add(tube(0.021, 0.024, 0.06, DARK, 0, 0.025, -0.57));       // flash hider
  g.add(box(0.042, 0.16, 0.06, DARK, 0, -0.11, 0.02, -0.12));   // STANAG mag
  g.add(box(0.05, 0.10, 0.06, POLY, 0, -0.10, 0.12, 0.22, 0, 0, 0.015)); // grip
  g.add(tube(0.016, 0.016, 0.20, DARK, 0, 0.022, 0.24));        // buffer tube
  g.add(box(0.046, 0.072, 0.12, POLY, 0, 0.0, 0.29, 0, 0, 0, 0.012));  // collapsible stock
  g.add(box(0.03, 0.012, 0.05, ACCENT, 0, -0.03, 0.24, 0, 0, 0, 0.004)); // stock latch
  g.add(box(0.035, 0.06, 0.02, POLY, 0, -0.06, -0.16, -0.5));   // angled grip
  optic(g, 0.06);
  shootingHand(g, {
    c: v3(0, -0.10, 0.12), rx: 0.22, hu: 0.025, hf: 0.03, stack: [-0.042, -0.02, 0.003, 0.026],
    index: [v3(0.032, -0.064, 0.095), v3(0.032, -0.054, 0.05), v3(0.03, -0.05, 0.01)],
    thumb: [v3(0.02, -0.045, 0.16), v3(-0.004, -0.04, 0.165), v3(-0.03, -0.045, 0.13), v3(-0.032, -0.04, 0.09)],
  });
  supportHand(g, {
    c: v3(0, 0.02, -0.31), hu: 0.035, hf: 0.03, stack: [-0.028, -0.009, 0.01, 0.028],
    thumb: [v3(-0.036, -0.012, -0.27), v3(-0.042, 0.004, -0.31), v3(-0.04, 0.016, -0.35)],
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.025, -0.60); g.add(muzzle);
  return { model: g, muzzle };
}

function buildShotgun() {
  const g = new THREE.Group();
  g.add(box(0.06, 0.10, 0.30, POLY, 0, 0.01, -0.02));           // receiver
  g.add(tube(0.021, 0.021, 0.46, METAL, 0, 0.035, -0.40));      // barrel
  g.add(tube(0.019, 0.019, 0.36, DARK, 0, -0.015, -0.35));      // magazine tube
  g.add(box(0.055, 0.06, 0.16, POLY, 0, -0.005, -0.26, 0, 0, 0, 0.012)); // pump / forend
  for (let i = 0; i < 7; i++) g.add(box(0.058, 0.063, 0.005, DARK, 0, -0.005, -0.32 + i * 0.02, 0, 0, 0, 0.0015)); // pump grooves
  g.add(box(0.03, 0.006, 0.08, DARK, 0, -0.04, -0.06));                    // loading port
  g.add(box(0.003, 0.024, 0.07, DARK, 0.031, 0.02, -0.02));                // ejection port
  g.add(box(0.012, 0.007, 0.06, POLY, 0, -0.06, 0.06, 0, 0, 0, 0.003));    // guard, bottom
  g.add(box(0.012, 0.026, 0.008, POLY, 0, -0.047, 0.03, 0.2, 0, 0, 0.003)); // guard, front
  g.add(box(0.006, 0.024, 0.006, DARK, 0, -0.046, 0.068, 0.25, 0, 0, 0.002)); // trigger
  g.add(box(0.012, 0.01, 0.02, ACCENT, 0, 0.064, 0.09));                   // safety
  g.add(box(0.052, 0.10, 0.06, POLY, 0, -0.095, 0.11, 0.20, 0, 0, 0.015)); // grip
  g.add(box(0.055, 0.11, 0.22, POLY, 0, -0.03, 0.24, -0.12, 0, 0, 0.016)); // stock
  g.add(box(0.010, 0.022, 0.012, DARK, 0, 0.072, -0.56));       // bead sight
  g.add(box(0.012, 0.018, 0.014, DARK, -0.018, 0.072, 0.10));   // ghost ring, left
  g.add(box(0.012, 0.018, 0.014, DARK, 0.018, 0.072, 0.10));    // ghost ring, right
  shootingHand(g, {
    c: v3(0, -0.095, 0.11), rx: 0.20, hu: 0.026, hf: 0.03, stack: [-0.042, -0.02, 0.003, 0.026],
    index: [v3(0.033, -0.06, 0.085), v3(0.033, -0.05, 0.04), v3(0.031, -0.046, 0.0)],
    thumb: [v3(0.02, -0.04, 0.15), v3(-0.004, -0.035, 0.155), v3(-0.031, -0.04, 0.12), v3(-0.033, -0.035, 0.08)],
  });
  supportHand(g, {
    c: v3(0, -0.005, -0.27), hu: 0.03, hf: 0.0275, stack: [-0.03, -0.01, 0.01, 0.03],
    thumb: [v3(-0.034, -0.03, -0.23), v3(-0.04, -0.012, -0.27), v3(-0.038, 0.002, -0.31)],
  });
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.035, -0.63); g.add(muzzle);
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

    this.weapons = WEAPON_DEFS.map((def) => {
      const { model, muzzle } = def.build();
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

  startReload(time) {
    const w = this.current;
    if (this.reloading || w.mag >= w.def.mag || w.reserve <= 0) return;
    this.reloading = true;
    this.reloadStart = time;
    this.reloadEnd = time + w.def.reload;
    audio.reload('out');
    setTimeout(() => audio.reload('in'), w.def.reload * 450);
    setTimeout(() => audio.reload(w.def.id === 'shotgun' ? 'shell' : 'bolt'), w.def.reload * 800);
  }

  finishReload() {
    const w = this.current;
    const need = w.def.mag - w.mag;
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

    const spreadBase = this.adsT > 0.6 ? d.adsSpread : d.spread;
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
    if (!this._flashSprite) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.game.effects.spriteMaps.flash,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      spr.visible = false;
      this.root.add(spr);
      this._flashSprite = spr;
      this._flashLife = 0;
    }
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
