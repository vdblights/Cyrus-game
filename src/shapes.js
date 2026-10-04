/**
 * Geometry that is not a box.
 *
 * Everything in this game is built out of right angles, and under one low sun
 * a right-angled prism is the flattest thing a renderer can draw: two lit
 * faces, two dark ones, and no line anywhere between them. That is most of
 * what "boxy" means. The two builders here are the answer to it, and they are
 * shared rather than per-file because a wreck, a barrier and a hostile all
 * want the same thing — a shape with a broken edge or a profile — and the
 * alternative was three copies of the same winding bug.
 *
 * Both follow the texture contract the rest of the game follows: UVs are
 * unwrapped planar off the facet's dominant axis at a declared world scale
 * (`TILE` in `textures.js`), so a part is textured at the same density
 * whatever its size, and the check that measures texels per metre off the
 * finished city covers anything built here.
 *
 * Both also derive their winding from the normal the facet is meant to face,
 * rather than from a corner order written by hand. That is not fastidiousness:
 * an inverted facet does not error, it vanishes, so it reads as a notch bitten
 * out of the part. Writing the order by hand gets every facet with an odd
 * number of negative axes backwards, which was found the expensive way on the
 * view model and again on the road markings.
 */
import * as THREE from 'three';

/**
 * Accumulates triangles, deriving each one's winding from its intended normal.
 *
 * `tri` takes the three corners in whatever order reads clearly at the call
 * site and the direction the facet faces; it emits them in the order that
 * actually faces that way.
 */
function facets(tile) {
  const pos = [], nor = [], uv = [];

  const push = (p, n) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(n[0], n[1], n[2]);
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    if (ay >= ax && ay >= az) uv.push(p[0] / tile, p[2] / tile);
    else if (ax >= az) uv.push(p[2] / tile, p[1] / tile);
    else uv.push(p[0] / tile, p[1] / tile);
  };

  const tri = (a, c, e, n) => {
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
    const wx = e[0] - a[0], wy = e[1] - a[1], wz = e[2] - a[2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (Math.hypot(cx, cy, cz) < 1e-9) return;        // degenerate, skip it
    push(a, n);
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { push(e, n); push(c, n); }
    else { push(c, n); push(e, n); }
  };

  return {
    tri,
    quad: (a, c, e, f, n) => { tri(a, c, e, n); tri(a, e, f, n); },
    build: () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      return g;
    },
  };
}

const unit = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/**
 * A box with its edges taken off.
 *
 * Nothing manufactured has a perfectly sharp 90° edge, and a chamfer costs 20
 * extra triangles to put a bright sliver along every edge that moves as you
 * move. Built non-indexed so each facet keeps a flat normal.
 *
 * `offset` slides the whole part off its own origin, which matters for a
 * limb: an arm has to rotate about the shoulder, not about its middle.
 */
export function chamferGeo(w, h, d, bevel, tile, offset = null) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const b = Math.min(bevel, hx * 0.8, hy * 0.8, hz * 0.8);
  const f = facets(tile);

  // Three vertices per corner, one pulled out to each adjacent face.
  const S = [-1, 1];
  const vx = {}, vy = {}, vz = {};
  for (const sx of S) for (const sy of S) for (const sz of S) {
    const k = `${sx}${sy}${sz}`;
    vx[k] = [sx * hx, sy * (hy - b), sz * (hz - b)];
    vy[k] = [sx * (hx - b), sy * hy, sz * (hz - b)];
    vz[k] = [sx * (hx - b), sy * (hy - b), sz * hz];
  }
  const K = (sx, sy, sz) => `${sx}${sy}${sz}`;

  // six faces, inset by the bevel
  for (const s of S) {
    f.quad(vx[K(s, -1, -1)], vx[K(s, -1, 1)], vx[K(s, 1, 1)], vx[K(s, 1, -1)], [s, 0, 0]);
    f.quad(vy[K(-1, s, -1)], vy[K(1, s, -1)], vy[K(1, s, 1)], vy[K(-1, s, 1)], [0, s, 0]);
    f.quad(vz[K(-1, -1, s)], vz[K(-1, 1, s)], vz[K(1, 1, s)], vz[K(1, -1, s)], [0, 0, s]);
  }

  // twelve edge strips, each bridging the two faces it separates
  for (const a of S) for (const c of S) {
    f.quad(vx[K(a, c, -1)], vy[K(a, c, -1)], vy[K(a, c, 1)], vx[K(a, c, 1)], unit(a, c, 0));   // along Z
    f.quad(vy[K(-1, a, c)], vz[K(-1, a, c)], vz[K(1, a, c)], vy[K(1, a, c)], unit(0, a, c));   // along X
    f.quad(vz[K(a, -1, c)], vx[K(a, -1, c)], vx[K(a, 1, c)], vz[K(a, 1, c)], unit(a, 0, c));   // along Y
  }

  // eight corner triangles
  for (const sx of S) for (const sy of S) for (const sz of S) {
    const k = K(sx, sy, sz);
    f.tri(vx[k], vy[k], vz[k], unit(sx, sy, sz));
  }

  const g = f.build();
  if (offset) g.translate(offset[0], offset[1], offset[2]);
  return g;
}

/**
 * A prism described by its cross-sections instead of by a width and a depth.
 *
 * Each section is a rectangle at a height — `{ y, hx, hz, cx = 0, cz = 0 }` —
 * and consecutive sections are bridged by four quads, so a taper, a slope or
 * a kink in the profile costs one more entry rather than another mesh. The
 * shapes this exists for are the ones a box gets most wrong: a jersey barrier
 * is a kinked profile, a car's greenhouse is a raked one, and both read as
 * furniture the moment the sides stop being vertical.
 *
 * Normals come off the section pair, so a sloped face is lit as a sloped
 * face. A section with a zero half-extent collapses to a ridge, which is how
 * a wedge is written: give the last section `hz: 0`.
 */
export function loftGeo(input, tile, { capTop = true, capBottom = true } = {}) {
  const f = facets(tile);
  const at = (s, sx, sz) => [s.cx + sx * s.hx, s.y, (s.cz || 0) + sz * s.hz];

  // Every normal here is derived from the direction the profile runs, so the
  // whole geometry comes out inside out if it runs downward. Sorting is
  // cheaper than remembering: a profile reads the same written either way.
  const sections = input[0].y <= input[input.length - 1].y ? input : [...input].reverse();

  for (let i = 0; i + 1 < sections.length; i++) {
    const a = { cx: 0, cz: 0, ...sections[i] }, b = { cx: 0, cz: 0, ...sections[i + 1] };
    const dy = b.y - a.y;

    // +X and -X faces: the normal leans by how much the side moved over `dy`
    for (const sx of [-1, 1]) {
      const d = (b.cx + sx * b.hx) - (a.cx + sx * a.hx);
      f.quad(at(a, sx, -1), at(a, sx, 1), at(b, sx, 1), at(b, sx, -1), unit(sx * dy, -sx * d, 0));
    }
    for (const sz of [-1, 1]) {
      const d = (b.cz + sz * b.hz) - (a.cz + sz * a.hz);
      f.quad(at(a, -1, sz), at(a, 1, sz), at(b, 1, sz), at(b, -1, sz), unit(0, -sz * d, sz * dy));
    }
  }

  const cap = (s, sy) => {
    f.quad(at(s, -1, -1), at(s, 1, -1), at(s, 1, 1), at(s, -1, 1), [0, sy, 0]);
  };
  if (capBottom) cap({ cx: 0, cz: 0, ...sections[0] }, -1);
  if (capTop) cap({ cx: 0, cz: 0, ...sections[sections.length - 1] }, 1);

  return f.build();
}

/**
 * The same loft laid down, with its sections stacked along +Z.
 *
 * `loftGeo` stacks up +Y because that is how a barrier or a plinth is
 * described — by its profile from the ground. A bonnet, a boot lid or a wing
 * is described the other way round: by what its profile does along the length
 * of the thing. Sections are `{ z, hx, hy, cy = 0, cx = 0 }`, so `hy` is a
 * height and `cy` is up, and the whole geometry is rotated at the end.
 *
 * Rotating afterwards keeps one builder rather than two, and the UVs survive
 * it because they are planar off each facet's own normal — a rotation moves
 * where a tile lands, not how big it is, which is the part the texture
 * contract cares about.
 */
export function loftGeoZ(sections, tile) {
  const mapped = sections.map((s) => ({
    y: s.z, hx: s.hx, hz: s.hy, cx: s.cx || 0, cz: -(s.cy || 0),
  }));
  return loftGeo(mapped, tile).rotateX(Math.PI / 2);
}

/* ------------------------------------------------------ profiles and lathes */

/**
 * Normals that are smooth across a curve and sharp across an edge.
 *
 * A curved part built of flat facets reads as a faceted pencil; the same
 * part with every normal averaged reads as a balloon, because a crisp edge
 * gets smoothed into the faces either side of it. The answer is the
 * crease: each corner of each facet averages only the facets meeting it
 * that turn by less than `angle` degrees from its own. A rounded grip comes
 * out round and the edge where it meets the frame stays an edge.
 *
 * Every normal is derived from the facets' own winding, so a part built
 * this way cannot disagree with itself about which way it faces.
 */
export function creaseNormals(geo, angle = 34) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const tris = p.length / 9;
  const fn = new Float32Array(tris * 3);         // area-weighted
  const un = new Float32Array(tris * 3);         // unit
  for (let t = 0; t < tris; t++) {
    const a = t * 9;
    const ux = p[a + 3] - p[a], uy = p[a + 4] - p[a + 1], uz = p[a + 5] - p[a + 2];
    const wx = p[a + 6] - p[a], wy = p[a + 7] - p[a + 1], wz = p[a + 8] - p[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const l = Math.hypot(cx, cy, cz);
    fn[t * 3] = cx; fn[t * 3 + 1] = cy; fn[t * 3 + 2] = cz;
    if (l > 1e-14) { un[t * 3] = cx / l; un[t * 3 + 1] = cy / l; un[t * 3 + 2] = cz / l; }
  }
  // corners are welded by position at a twentieth of a millimetre
  const key = (i) => `${Math.round(p[i] * 2e4)},${Math.round(p[i + 1] * 2e4)},${Math.round(p[i + 2] * 2e4)}`;
  const buckets = new Map();
  for (let v = 0; v < tris * 3; v++) {
    const k = key(v * 3);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push((v / 3) | 0);
  }
  const cos = Math.cos((angle * Math.PI) / 180);
  const nor = new Float32Array(p.length);
  for (let v = 0; v < tris * 3; v++) {
    const t = (v / 3) | 0;
    const ox = un[t * 3], oy = un[t * 3 + 1], oz = un[t * 3 + 2];
    let x = 0, y = 0, z = 0;
    for (const u of buckets.get(key(v * 3))) {
      if (ox * un[u * 3] + oy * un[u * 3 + 1] + oz * un[u * 3 + 2] < cos) continue;
      x += fn[u * 3]; y += fn[u * 3 + 1]; z += fn[u * 3 + 2];
    }
    const l = Math.hypot(x, y, z);
    if (l > 1e-14) { nor[v * 3] = x / l; nor[v * 3 + 1] = y / l; nor[v * 3 + 2] = z / l; }
    else { nor[v * 3] = ox; nor[v * 3 + 1] = oy || (ox || oz ? 0 : 1); nor[v * 3 + 2] = oz; }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/**
 * Planar UVs off each facet's own dominant axis, at a declared tile — the
 * same unwrap `facets` gives a chamfered box, for a geometry that arrived
 * from somewhere else. Non-indexed input, so a facet owns its corners.
 */
export function planarUV(geo, tile) {
  const p = geo.attributes.position.array;
  const uv = new Float32Array((p.length / 3) * 2);
  for (let a = 0; a < p.length; a += 9) {
    const ux = p[a + 3] - p[a], uy = p[a + 4] - p[a + 1], uz = p[a + 5] - p[a + 2];
    const wx = p[a + 6] - p[a], wy = p[a + 7] - p[a + 1], wz = p[a + 8] - p[a + 2];
    const ax = Math.abs(uy * wz - uz * wy), ay = Math.abs(uz * wx - ux * wz), az = Math.abs(ux * wy - uy * wx);
    for (let c = 0; c < 3; c++) {
      const i = a + c * 3, o = (i / 3) * 2;
      if (ay >= ax && ay >= az) { uv[o] = p[i] / tile; uv[o + 1] = p[i + 2] / tile; }
      else if (ax >= az) { uv[o] = p[i + 2] / tile; uv[o + 1] = p[i + 1] / tile; }
      else { uv[o] = p[i] / tile; uv[o + 1] = p[i + 1] / tile; }
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Round the corners of an outline: each point may carry a third number, the
 * radius of the fillet at that corner, which is swapped for a short curve
 * through it. Most of what makes a machined part read as machined rather
 * than cut out of card is that no corner of it is sharp.
 */
export function fillet(points, steps = 4) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [px, py, r = 0] = points[i];
    if (!r) { out.push([px, py]); continue; }
    const [ax, ay] = points[(i + n - 1) % n], [bx, by] = points[(i + 1) % n];
    const la = Math.hypot(ax - px, ay - py), lb = Math.hypot(bx - px, by - py);
    if (la < 1e-9 || lb < 1e-9) { out.push([px, py]); continue; }
    const ux = (ax - px) / la, uy = (ay - py) / la, vx = (bx - px) / lb, vy = (by - py) / lb;
    const half = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy))) / 2;
    const t = Math.min(r / Math.max(Math.tan(half), 1e-3), la * 0.45, lb * 0.45);
    const s = [px + ux * t, py + uy * t], e = [px + vx * t, py + vy * t];
    for (let k = 0; k <= steps; k++) {
      const q = k / steps, w0 = (1 - q) * (1 - q), w1 = 2 * q * (1 - q), w2 = q * q;
      out.push([s[0] * w0 + px * w1 + e[0] * w2, s[1] * w0 + py * w1 + e[1] * w2]);
    }
  }
  return out;
}

/**
 * A part described by its side view: an outline in (z, y), extruded across
 * X to `width` and centred on it, with its edges rolled over by `bevel`.
 *
 * This is how a gunsmith or a car designer draws the thing, and it is what a
 * box could never be — a trigger guard is a hole in the frame, a grip rakes
 * back with a beavertail over the web of the hand, a car's wheel arch is a
 * bite out of the body. `holes` are outlines too. Points may carry a fillet
 * radius (see `fillet`). The bevel is taken *inside* the outline, so the
 * silhouette is exactly what was drawn and the caps sit at ±width/2.
 */
export function sideGeo(outline, width, { holes = [], bevel = 0, segs = 2, tile = 1, crease = 34, curve = 4 } = {}) {
  const v2 = (pts) => fillet(pts, curve).map(([z, y]) => new THREE.Vector2(-z, y));
  const shape = new THREE.Shape(v2(outline));
  for (const h of holes) shape.holes.push(new THREE.Path(v2(h)));
  const b = Math.min(bevel, width * 0.45);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * b, steps: 1, curveSegments: 1,
    bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: segs,
  });
  geo.deleteAttribute('uv');
  geo.translate(0, 0, -(width - 2 * b) / 2);
  geo.rotateY(Math.PI / 2);                 // shape x is -z, the extrusion is +x
  return creaseNormals(planarUV(geo, tile), crease);
}

/**
 * A part turned on a lathe: a profile of `[radius, along]` pairs revolved
 * about the Z axis — a barrel, a muzzle brake, a buffer tube, a wheel.
 *
 * UVs run round the part by arc length at its own radius and along it by the
 * profile's own length, so the machining marks are the size they are on
 * every flat part. `uv`, if given, replaces that per corner: it receives the
 * corner and the facet's normal, for a part that wants two surfaces off one
 * tile (a tyre's tread and its sidewall).
 */
export function latheGeo(profile, sides, tile, { uv = null, crease = 40 } = {}) {
  const pts = profile.map(([r, a]) => new THREE.Vector2(Math.max(r, 0), a));
  const lathe = new THREE.LatheGeometry(pts, sides);
  // arc length along the profile, for the default unwrap
  const run = [0];
  for (let j = 1; j < pts.length; j++) run.push(run[j - 1] + pts[j].distanceTo(pts[j - 1]));
  const luv = lathe.attributes.uv;
  for (let k = 0; k < luv.count; k++) {
    const j = Math.round(luv.getY(k) * (pts.length - 1));
    luv.setXY(k, luv.getX(k) * Math.PI * 2 * pts[j].x / tile, run[j] / tile);
  }
  let g = lathe.toNonIndexed();
  const nRef = g.attributes.normal.array;   // three's own outward normals

  // Which way three winds a lathe depends on which way the profile runs, so
  // ask it rather than remember: compare each facet's winding with the
  // outward normal three computed off the profile, and turn the lot round if
  // most of them disagree.
  const p = g.attributes.position.array, u = g.attributes.uv.array;
  let agree = 0;
  for (let a = 0; a < p.length; a += 9) {
    const ux = p[a + 3] - p[a], uy = p[a + 4] - p[a + 1], uz = p[a + 5] - p[a + 2];
    const wx = p[a + 6] - p[a], wy = p[a + 7] - p[a + 1], wz = p[a + 8] - p[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const nx = nRef[a] + nRef[a + 3] + nRef[a + 6], ny = nRef[a + 1] + nRef[a + 4] + nRef[a + 7];
    const nz = nRef[a + 2] + nRef[a + 5] + nRef[a + 8];
    agree += Math.sign(cx * nx + cy * ny + cz * nz);
  }
  if (agree < 0) {
    for (let a = 0; a < p.length; a += 9) {
      for (let c = 0; c < 3; c++) { const t = p[a + 3 + c]; p[a + 3 + c] = p[a + 6 + c]; p[a + 6 + c] = t; }
      const o = (a / 3) * 2;
      for (let c = 0; c < 2; c++) { const t = u[o + 2 + c]; u[o + 2 + c] = u[o + 4 + c]; u[o + 4 + c] = t; }
    }
  }
  g.rotateX(Math.PI / 2);                   // the lathe's Y axis becomes +Z
  g = creaseNormals(g, crease);
  if (uv) {
    const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array;
    for (let a = 0; a < P.length; a += 9) {
      // the facet's normal, so a corner on a crease is unwrapped with its facet
      const fx = N[a] + N[a + 3] + N[a + 6], fy = N[a + 1] + N[a + 4] + N[a + 7], fz = N[a + 2] + N[a + 5] + N[a + 8];
      const ang = [0, 1, 2].map((c) => Math.atan2(P[a + c * 3 + 1], P[a + c * 3]));
      // a facet straddling the seam takes its corners from one side of it
      if (Math.max(...ang) - Math.min(...ang) > Math.PI) for (let c = 0; c < 3; c++) if (ang[c] < 0) ang[c] += Math.PI * 2;
      for (let c = 0; c < 3; c++) {
        const i = a + c * 3;
        const [s, t] = uv(P[i], P[i + 1], P[i + 2], fx, fy, fz, ang[c]);
        U[(i / 3) * 2] = s; U[(i / 3) * 2 + 1] = t;
      }
    }
  }
  return g;
}

/**
 * A tube of elliptical section swept along a path: a finger, the back of a
 * hand, a forearm in its sleeve. What a lathe is to a barrel this is to
 * anything that bends.
 *
 * `size(t)` gives the section's semi-axes `[a, b]` a fraction `t` of the way
 * along — `a` across the side the frame starts on (`side`, kept square to the
 * path by parallel transport, so the section never twists), `b` across the
 * other — and `bump(t, th)`, if given, scales the radius at angle `th` round
 * it, which is how a knuckle stands up or a sleeve bunches. Each closed end is
 * a dome as long as the section is wide; an open end (`open: [start, end]`)
 * is left a ring, for a sleeve seen from inside.
 *
 * UVs run round the section by arc length at its mean size and along the
 * path by distance, both over `tile`, so the texel-density checks cover it.
 * The winding is decided by comparing a facet with the way out from the path
 * at its corner, never written down.
 */
export function sweepGeo(points, size, tile, { side, bump = null, around = 14, step = 0.005, open = [false, false], dome = 5 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const len = curve.getLength();
  const n = Math.max(4, Math.ceil(len / step));
  // parallel-transported frames: N stays as square to the path as `side` was
  const frames = [];
  let N = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const P = curve.getPointAt(t), T = curve.getTangentAt(t).normalize();
    if (!N) N = side.clone().addScaledVector(T, -side.dot(T)).normalize();
    else {
      const prev = frames[i - 1].T;
      N.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(prev, T));
      N.addScaledVector(T, -N.dot(T)).normalize();
    }
    frames.push({ P, T, N: N.clone(), B: new THREE.Vector3().crossVectors(T, N), t, s: t * len });
  }
  // the rings, with a dome on each closed end
  const rings = [];
  const ring = (f, k, offset, s) => {
    const [a, b] = size(f.t);
    rings.push({ C: f.P.clone().addScaledVector(f.T, offset), N: f.N, B: f.B, a: a * k, b: b * k, t: f.t, s });
  };
  const capLen = (f) => Math.min(...size(f.t)) * 0.9;
  if (!open[0]) {
    const f = frames[0], L = capLen(f);
    for (let j = dome; j >= 1; j--) {
      const ph = (j / dome) * (Math.PI / 2);
      ring(f, Math.cos(ph), -Math.sin(ph) * L, -Math.sin(ph) * L);
    }
  }
  for (const f of frames) ring(f, 1, 0, f.s);
  if (!open[1]) {
    const f = frames[frames.length - 1], L = capLen(f);
    for (let j = 1; j <= dome; j++) {
      const ph = (j / dome) * (Math.PI / 2);
      ring(f, Math.cos(ph), Math.sin(ph) * L, len + Math.sin(ph) * L);
    }
  }
  // a mean circumference, so the weave is one size the whole way along
  const [ma, mb] = size(0.5);
  const round = Math.PI * (3 * (ma + mb) - Math.sqrt((3 * ma + mb) * (ma + 3 * mb)));
  const pos = [], nor = [], uv = [], out = [];
  for (const r of rings) {
    for (let j = 0; j <= around; j++) {
      const th = (j / around) * Math.PI * 2;
      const k = bump ? bump(Math.min(1, Math.max(0, r.t)), th) : 1;
      const c = Math.cos(th), s = Math.sin(th);
      const p = r.C.clone().addScaledVector(r.N, c * r.a * k).addScaledVector(r.B, s * r.b * k);
      pos.push(p.x, p.y, p.z);
      // the ellipse's own normal; a dome's ring also leans along the path
      const o = r.N.clone().multiplyScalar(c / Math.max(r.a, 1e-5)).addScaledVector(r.B, s / Math.max(r.b, 1e-5)).normalize();
      out.push(o);
      nor.push(0, 0, 0);
      uv.push(((j / around) * round) / tile, r.s / tile);
    }
  }
  const W = around + 1, idx = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // which way a facet faces is asked of the first one big enough to answer
  const P = (v) => new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  for (let q = 0; q < idx.length; q += 3) {
    const a = P(idx[q]), b = P(idx[q + 1]), c = P(idx[q + 2]);
    const cr = b.sub(a).cross(c.sub(a));
    if (cr.lengthSq() < 1e-16) continue;
    if (cr.dot(out[idx[q]]) < 0) for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    break;
  }
  g.setIndex(idx);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  // the seam column is two copies of one ring of points; give both the same
  // normal, or a line runs down the length of every finger
  const nr = g.attributes.normal;
  for (let i = 0; i < rings.length; i++) {
    const a = i * W, b = a + around;
    const x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nr.setXYZ(a, x / l, y / l, z / l); nr.setXYZ(b, x / l, y / l, z / l);
  }
  // a dome's tip is a ring of one point, whose triangles have no area to
  // average: hand it the way the path leaves
  for (const [i, sign] of [[0, -1], [rings.length - 1, 1]]) {
    if (rings[i].a > 1e-6) continue;
    const T = (i === 0 ? frames[0] : frames[frames.length - 1]).T;
    for (let j = 0; j <= around; j++) nr.setXYZ(i * W + j, T.x * sign, T.y * sign, T.z * sign);
  }
  return g;
}

/** Move every vertex of a geometry through `fn(v)`, then redo its normals. */
export function bend(geo, fn, crease = 34) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return creaseNormals(geo, crease);
}

/**
 * Concatenate geometries that are already in world space into one buffer.
 *
 * `BufferGeometryUtils` lives in three's examples, which this repo does not
 * vendor, so this covers the one case anything here needs: position/normal/
 * uv/colour, indexed output, indexed or non-indexed input.
 *
 * Two jobs, and they are the same job. `bakeStatic` uses it to collapse the
 * whole city into one mesh per material, which is where the frame budget
 * came from; the prop and hostile builders use it to make one mesh out of
 * the six or seven shapes a thing is actually made of, which is where the
 * detail came from. Both are trading vertices, which are cheap, for objects,
 * which are not.
 */
export function mergeIntoOne(geos) {
  let verts = 0, indices = 0;
  for (const g of geos) {
    verts += g.attributes.position.count;
    indices += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(verts * 3);
  const nor = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const col = new Float32Array(verts * 3).fill(1);
  const idx = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    pos.set(p.array, vOff * 3);
    if (n) nor.set(n.array, vOff * 3);
    if (t) uv.set(t.array, vOff * 2);
    if (g.attributes.color) col.set(g.attributes.color.array, vOff * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[iOff + i] = src[i] + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
