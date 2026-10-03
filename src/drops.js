import * as THREE from 'three';
import * as TEX from './textures.js';
import { TILE } from './textures.js';
import { chamferGeo, sideGeo, latheGeo, planarUV, mergeIntoOne } from './shapes.js';

/**
 * What a hostile leaves behind: an ammunition can, a medical case and a
 * fragmentation grenade, built once at boot and cloned per drop.
 *
 * A pickup is the one object in the game the player deliberately walks up to
 * and looks down at from a metre away, so it gets the treatment the guns got:
 * each is drawn the way the real thing is made — a pressed can with a hinged
 * lid, a cam latch and a bail handle; a moulded case in two halves with a
 * handle and latches; a turned body under a fuze, a spoon and a pin — out of
 * side views and lathes rather than boxes.
 *
 * Every part of a kind that shares a material is merged into one mesh, so
 * the detail is triangles rather than draw calls, and all of it is built
 * inside the boot stage's `reserve`, so none of it costs the layout anything.
 * A clone mid-fight is paid for at a fixed price (`DROP_COST`, `maybeDrop`
 * in `main.js`) rather than by however many objects it happens to mint, so
 * a drop can change shape without moving the spawn stream behind it.
 *
 * Each also lies over a soft halo in its own colour — amber for ammunition,
 * green for a medical case, red for a grenade. Drawn as the real things are,
 * in olive and steel, a can and a grenade disappeared into a dusk street at
 * eight metres, where the flat mustard box they replaced was the brightest
 * thing in the frame; a drop that cannot be found does not exist. The halo
 * lies on the floor whatever the drop is doing above it (`updatePickups`).
 *
 * Each kind is built standing on y = 0 and then lowered by half its height,
 * so it floats on its middle where the old ones did.
 */
/**
 * What a clone of each kind used to spend of the seeded stream, in draws, and
 * so what a drop pays however it is built. Measured, not counted: a group
 * costs one UUID, but a cloned mesh costs three, because `clone()` builds a
 * bare `Mesh` before copying into it, and a bare `Mesh` mints a default
 * geometry and material of its own first. So a group of two meshes was 28
 * draws and a group of three 40.
 */
export const DROP_COST = { ammo: 28, health: 40, frag: 28 };

export function buildDropPrototypes() {
  const surface = (tex, key, opts, extra) => ({
    map: tex,
    normalMap: TEX.normalFrom(tex, 1.2, key, 1),
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughnessMap: TEX.surfaceFrom(tex, opts, key),
    roughness: 1,
    ...extra,
  });
  const steelTex = TEX.gunMetal();
  const mats = {
    // The emissive is deliberately kept: a drop has to be findable in a dusk
    // street, and every one of these is darker than the flat colour it was.
    ammo: new THREE.MeshStandardMaterial(surface(TEX.ammoCan(), 'ammocan',
      { dark: 0.9, lite: 0.55, metalDark: 0, metalLite: 0.55 },
      { metalness: 1, envMapIntensity: 0.7, emissive: 0x1a1d0c })),
    health: new THREE.MeshStandardMaterial(surface(TEX.medCase(), 'medcase',
      { dark: 0.75, lite: 0.5 }, { color: 0xe6e4dc, metalness: 0, envMapIntensity: 0.7, emissive: 0x0e140e })),
    frag: new THREE.MeshStandardMaterial(surface(TEX.fragBody(), 'fragbody',
      { dark: 0.85, lite: 0.5, metalDark: 0, metalLite: 0.55 },
      { metalness: 1, envMapIntensity: 0.8, emissive: 0x0c1205 })),
    latch: new THREE.MeshStandardMaterial(surface(steelTex, 'gunmetal',
      { dark: 0.9, lite: 0.2, metalDark: 0.5, metalLite: 1 }, { color: 0xb8bec6, metalness: 1, envMapIntensity: 0.9 })),
    fitting: new THREE.MeshStandardMaterial(surface(TEX.gunPolymer(), 'gunpoly',
      { dark: 1, lite: 0.6 }, { color: 0x5a5c60, metalness: 0, envMapIntensity: 0.6 })),
  };
  // unlit, as the flat cross was, and dimmed below white so the bloom leaves it
  const crossMat = new THREE.MeshBasicMaterial({ map: TEX.firstAidLabel(), color: 0xd4d4d4 });

  const proto = {};
  const haloTex = TEX.particleSprite('#ffffff');
  const haloGeo = new THREE.PlaneGeometry(0.8, 0.8).rotateX(-Math.PI / 2);
  const haloMats = [];
  const halo = (group, color) => {
    const mat = new THREE.MeshBasicMaterial({
      map: haloTex, color, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    haloMats.push(mat);
    const m = new THREE.Mesh(haloGeo, mat);
    m.userData.halo = true;
    m.renderOrder = 1;
    m.position.y = 0.012 - 0.42;          // on the floor under a drop at rest
    group.add(m);
  };
  // `tile` is the scale the part is unwrapped at, for the check that holds
  // it to that; a decal has none
  const part = (geos, mat, lower, tile = 0) => {
    const g = mergeIntoOne(geos);
    g.translate(0, -lower, 0);
    const m = new THREE.Mesh(g, mat);
    m.userData.tile = tile;
    return m;
  };

  // ---- the ammunition can: an M2A1, half again its real size so it reads
  {
    const A = TILE.ammoCan, L = 0.19, H = 0.235, W = 0.095;
    // the long sides take the tile centred on them, so the stencil lands in
    // the middle of each; everything else stays on the tile's plain edges
    // (and the far side's unwrap turned round, or its stencil reads backwards)
    const sides = (g) => shiftUV(g, (axis, sign) => (axis === 'x' ? [0.5, 0, sign > 0] : [0, 0]));
    const body = [
      sides(sideGeo([[-L, 0, 0.015], [L, 0, 0.015], [L, H, 0.006], [-L, H, 0.006]], 2 * W, { tile: A, bevel: 0.007 })),
      // the lid, a little wider, sitting over the top of the body
      sides(sideGeo([[-L - 0.006, H - 0.003], [L + 0.006, H - 0.003], [L + 0.006, H + 0.04, 0.012], [-L - 0.006, H + 0.04, 0.012]],
        2 * W + 0.008, { tile: A, bevel: 0.007 })),
    ];
    // the pressed panel on each long side, a few millimetres proud
    // (a chamfered box is unwrapped about its own middle, before it is moved,
    // so the panel is slid up the tile by as far as it was lifted)
    for (const s of [-1, 1]) {
      body.push(shiftUV(chamferGeo(0.006, 0.15, 0.30, 0.002, A, [s * (W + 0.001), 0.118, 0]),
        (axis, sign) => [axis === 'x' ? 0.5 : 0, axis === 'y' ? 0 : 0.118 / A, axis === 'x' && sign > 0]));
    }
    const top = H + 0.04;
    const steel = [
      // the hinge along the back of the lid
      rod(0.009, 0.17, 'x', [0, H + 0.004, -L - 0.008], TILE.gunMetal),
      // the cam latch: a lever hung off a pivot at the lid's front edge, over
      // the catch on the body
      chamferGeo(0.085, 0.13, 0.012, 0.004, TILE.gunMetal, [0, top - 0.072, L + 0.014]),
      rod(0.008, 0.10, 'x', [0, top - 0.012, L + 0.012], TILE.gunMetal),
      chamferGeo(0.05, 0.03, 0.02, 0.005, TILE.gunMetal, [0, H - 0.1, L + 0.008]),
      // the bail handle, folded flat on the lid
      frame(0.20, 0.11, 0.012, 0.011, [0, top + 0.0055, 0]),
      // the two lugs it folds on, on the side of the lid
      chamferGeo(0.024, 0.016, 0.03, 0.004, TILE.gunMetal, [-0.062, top + 0.006, -0.07]),
      chamferGeo(0.024, 0.016, 0.03, 0.004, TILE.gunMetal, [-0.062, top + 0.006, 0.07]),
    ];
    proto.ammo = new THREE.Group();
    proto.ammo.add(part(body, mats.ammo, top / 2, A));
    proto.ammo.add(part(steel, mats.latch, top / 2, TILE.gunMetal));
    halo(proto.ammo, 0xe2a83c);
  }

  // ---- the medical case: two moulded halves, a handle, two latches
  {
    const M = TILE.medCase, X = 0.4, D = 0.1, split = 0.158, H = 0.26;
    const half = (y0, y1, rBottom, rTop) =>
      sideGeo([[-D, y0, rBottom], [D, y0, rBottom], [D, y1, rTop], [-D, y1, rTop]], X, { tile: M, bevel: 0.018, segs: 3 });
    const shell = [
      half(0, split - 0.003, 0.03, 0.004),
      half(split + 0.003, H, 0.004, 0.03),
      // the seal between them, set back, which is what makes the line dark
      chamferGeo(X - 0.03, 0.012, 2 * D - 0.012, 0.003, M, [0, split, 0]),
      // a moulded rib round each half near either end
    ];
    for (const s of [-1, 1]) {
      shell.push(sideGeo([[-D - 0.004, 0.012, 0.03], [D + 0.004, 0.012, 0.03], [D + 0.004, split - 0.012, 0.006], [-D - 0.004, split - 0.012, 0.006]],
        0.026, { tile: M, bevel: 0.004 }).translate(s * 0.13, 0, 0));
      shell.push(sideGeo([[-D - 0.004, split + 0.012, 0.006], [D + 0.004, split + 0.012, 0.006], [D + 0.004, H - 0.012, 0.03], [-D - 0.004, H - 0.012, 0.03]],
        0.026, { tile: M, bevel: 0.004 }).translate(s * 0.13, 0, 0));
    }
    // the handle: an arch along the lid, drawn in its own side view
    const handle = sideGeo([[-0.085, H - 0.004], [-0.085, H + 0.038, 0.022], [0.085, H + 0.038, 0.022], [0.085, H - 0.004],
      [0.064, H - 0.004], [0.064, H + 0.018, 0.012], [-0.064, H + 0.018, 0.012], [-0.064, H - 0.004]],
    0.028, { tile: TILE.gunPoly, bevel: 0.007 }).rotateY(Math.PI / 2);
    const fittings = [handle];
    // two draw latches across the parting line, front and back
    for (const z of [-1, 1]) {
      for (const x of [-0.12, 0.12]) {
        fittings.push(chamferGeo(0.05, 0.066, 0.014, 0.004, TILE.gunPoly, [x, split + 0.004, z * (D + 0.006)]));
        fittings.push(chamferGeo(0.034, 0.012, 0.01, 0.003, TILE.gunPoly, [x, split + 0.03, z * (D + 0.014)]));
      }
    }
    // the first-aid sign on the lid, front and back, and on either end
    const signs = [];
    for (const z of [-1, 1]) signs.push(decal([0, 0.21, z * (D + 0.0012)], [z, 0, 0], [0, 1, 0], [0, 0, z], 0.082));
    for (const x of [-1, 1]) signs.push(decal([x * (X / 2 + 0.0012), 0.085, 0], [0, 0, -x], [0, 1, 0], [x, 0, 0], 0.09));
    proto.health = new THREE.Group();
    proto.health.add(part(shell, mats.health, H / 2, M));
    proto.health.add(part(signs, crossMat, H / 2));
    proto.health.add(part(fittings, mats.fitting, H / 2, TILE.gunPoly));
    halo(proto.health, 0x3cd264);
  }

  // ---- the grenade: a turned body under a fuze, the spoon and the pin
  {
    const R = 0.066, c = R, mouth = 1.22;          // the body is a sphere cut at 70 degrees
    const profile = [];
    for (let k = 0; k <= 16; k++) {
      const a = -Math.PI / 2 + (k / 16) * (mouth + Math.PI / 2);
      profile.push([R * Math.cos(a), c + R * Math.sin(a)]);
    }
    const neck = c + R * Math.sin(mouth);            // 0.128
    profile.push([0.017, neck + 0.003], [0, neck + 0.003]);
    const body = latheGeo(profile, 24, TILE.frag).rotateX(-Math.PI / 2);
    const fuze = latheGeo([[0, neck - 0.004], [0.02, neck - 0.004], [0.02, neck + 0.012], [0.025, neck + 0.014],
      [0.025, neck + 0.030], [0.019, neck + 0.036], [0, neck + 0.036]], 16, TILE.gunMetal).rotateX(-Math.PI / 2);
    // The spoon, in side view: over the top of the fuze and down the body a
    // few millimetres off it, curling in at the tip. Drawn in (x, y) and
    // stood on its edge, the way `sideGeo` extrudes a gun's frame.
    const rb = (y) => (y > neck ? 0.025 : Math.sqrt(Math.max(0, R * R - (y - c) * (y - c))));
    const outer = [], inner = [];
    for (let y = neck + 0.02; y >= 0.05; y -= 0.012) { outer.push([rb(y) + 0.009, y]); inner.unshift([rb(y) + 0.004, y]); }
    const spoon = sideGeo([[0.008, neck + 0.043], [0.03, neck + 0.043, 0.006], ...outer,
      [rb(0.04) + 0.006, 0.036], [rb(0.044) + 0.002, 0.042], ...inner, [0.026, neck + 0.037], [0.008, neck + 0.037]],
    0.026, { tile: TILE.gunMetal, bevel: 0.002, segs: 1 }).rotateY(Math.PI / 2);
    // the pin through the fuze, and the ring off its end
    const pin = rod(0.003, 0.068, 'z', [0, neck + 0.022, 0.002], TILE.gunMetal);
    const ring = planarUV(new THREE.TorusGeometry(0.02, 0.0035, 6, 16).toNonIndexed(), TILE.gunMetal)
      .rotateY(Math.PI / 2).translate(0, neck + 0.022, 0.056);
    const top = neck + 0.043;
    proto.frag = new THREE.Group();
    proto.frag.add(part([body], mats.frag, top / 2, TILE.frag));
    proto.frag.add(part([fuze, spoon, pin, ring], mats.latch, top / 2, TILE.gunMetal));
    halo(proto.frag, 0xe0583a);
  }

  for (const p of Object.values(proto)) p.traverse((o) => { if (o.isMesh && !o.userData.halo) o.castShadow = true; });
  return { proto, crossMat, haloMats };
}

/** A round bar of `r` and `len` along an axis, centred on `at`. */
function rod(r, len, axis, at, tile) {
  const g = latheGeo([[r, -len / 2], [r, len / 2]], 10, tile);    // along Z
  if (axis === 'x') g.rotateY(Math.PI / 2);
  if (axis === 'y') g.rotateX(-Math.PI / 2);
  return g.translate(...at);
}

/** A flat rectangular loop of bar, `w` by `d` in plan and `t` thick. */
function frame(w, d, bar, t, at) {
  const out = [[-w / 2, -d / 2, 0.02], [w / 2, -d / 2, 0.02], [w / 2, d / 2, 0.02], [-w / 2, d / 2, 0.02]];
  const hole = [[-w / 2 + bar, -d / 2 + bar, 0.012], [w / 2 - bar, -d / 2 + bar, 0.012], [w / 2 - bar, d / 2 - bar, 0.012], [-w / 2 + bar, d / 2 - bar, 0.012]];
  // drawn in (z, y) and laid down: y becomes -x and the thickness becomes y,
  // so its long side runs along the can
  return sideGeo(out, t, { holes: [hole], tile: TILE.gunMetal, bevel: t * 0.4, segs: 1 })
    .rotateZ(Math.PI / 2).translate(...at);
}

/**
 * A square decal of side `size` centred on `at`, spanning `u` and `v`,
 * wound to face `n` whatever order the axes came in, with UVs covering its
 * texture once.
 */
function decal(at, u, v, n, size) {
  const h = size / 2;
  const P = (su, sv) => [at[0] + (u[0] * su + v[0] * sv) * h, at[1] + (u[1] * su + v[1] * sv) * h, at[2] + (u[2] * su + v[2] * sv) * h];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const cross = [
    u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0],
  ];
  const order = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const pos = [], nor = [], uv = [];
  for (const i of order) {
    const [su, sv] = corners[i];
    pos.push(...P(su, sv)); nor.push(...n); uv.push((su + 1) / 2, (sv + 1) / 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Slide a planar unwrap, chosen per facet by the axis `planarUV` unwrapped it
 * along and which way along it the facet faces — so one part of a thing can
 * be sent to one region of its tile without changing its scale. `by` returns
 * `[du, dv, mirror]`; a mirrored facet runs `u` the other way about the
 * slid centre, which is what reading the same stencil from the other side
 * of a can takes.
 */
function shiftUV(geo, by) {
  const p = geo.attributes.position.array, uv = geo.attributes.uv.array;
  for (let a = 0; a < p.length; a += 9) {
    const ux = p[a + 3] - p[a], uy = p[a + 4] - p[a + 1], uz = p[a + 5] - p[a + 2];
    const wx = p[a + 6] - p[a], wy = p[a + 7] - p[a + 1], wz = p[a + 8] - p[a + 2];
    const ax = Math.abs(uy * wz - uz * wy), ay = Math.abs(uz * wx - ux * wz), az = Math.abs(ux * wy - uy * wx);
    const axis = ay >= ax && ay >= az ? 'y' : ax >= az ? 'x' : 'z';
    const n = axis === 'x' ? uy * wz - uz * wy : axis === 'y' ? uz * wx - ux * wz : ux * wy - uy * wx;
    const [du, dv, mirror] = by(axis, Math.sign(n));
    for (let c = 0; c < 3; c++) {
      const o = ((a / 3) + c) * 2;
      uv[o] = mirror ? du - uv[o] : uv[o] + du;
      uv[o + 1] += dv;
    }
  }
  geo.attributes.uv.needsUpdate = true;
  return geo;
}
