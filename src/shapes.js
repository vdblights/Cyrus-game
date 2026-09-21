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
