import * as THREE from 'three';
import { World, randRange, pick } from './world.js';
import * as TEX from './textures.js';
import { TILE, FACADE_BAYS, FACADE_FLOORS, FACADE_VARIANTS } from './textures.js';
import { reserve } from './rng.js';

const BLOCK = 34;      // centre-to-centre distance between city lots
const GRID = 6;        // lots per axis
const LOT = 22;        // buildable footprint inside a lot (street = BLOCK - LOT)
const HALF = (GRID - 1) / 2;

const lotCenter = (i) => (i - HALF) * BLOCK;

/** Window and floor pitch in metres — what a wall's UVs are snapped to. */
const BAY = TILE.facade / FACADE_BAYS;
const STOREY = TILE.facade / FACADE_FLOORS;

/**
 * Box geometry with planar UVs at a declared world scale.
 *
 * Every face is unwrapped from its own position and normal rather than from
 * the vertex order three happens to emit, so the same code works whatever the
 * box is subdivided into, and one copy of the texture always covers `tile`
 * metres. Options:
 *
 *   snapU/snapV  round the span to a whole number of these, in metres, and
 *                stretch to fit. A wall then never cuts a window in half at
 *                the corner, and its floors line up with the ground and roof.
 *   offsetU      slide the tile along, in tiles. Two identical walls given
 *                different offsets stop reading as the same wall.
 *   bands        horizontal subdivisions, so `bakeStatic` has vertices to
 *                hang the ground-contact shading on.
 */
function boxGeo(w, h, d, tile = TILE.concrete, opts = {}) {
  const { snapU = 0, snapV = 0, offsetU = 0, offsetV = 0, bands = 1, cells = 1 } = opts;
  const g = new THREE.BoxGeometry(w, h, d, cells, bands, cells);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;

  // span of the tile across a face, snapped to whole features where asked
  const span = (len, snap) => {
    if (!snap) return len / tile;
    return Math.max(1, Math.round(len / snap)) * (snap / tile);
  };
  const su = { x: span(d, snapU), y: span(w, snapU), z: span(w, snapU) };
  const sv = { x: span(h, snapV), y: span(d, snapU), z: span(h, snapV) };

  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let axis, u, v;
    if (ny > nx && ny > nz) { axis = 'y'; u = pos.getX(i) / w; v = pos.getZ(i) / d; }
    else if (nx > nz) { axis = 'x'; u = pos.getZ(i) / d; v = pos.getY(i) / h; }
    else { axis = 'z'; u = pos.getX(i) / w; v = pos.getY(i) / h; }
    uv.setXY(i, (u + 0.5) * su[axis] + offsetU, (v + 0.5) * sv[axis] + offsetV);
  }
  uv.needsUpdate = true;
  return g;
}

/* ------------------------------------------------------------- shading bake */

/** Deterministic value in 0..1 from a position, so tints cost no stream. */
function hash2(x, z, salt = 0) {
  let h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791), 2654435761);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/**
 * A per-building colour drift, baked into vertex colours at merge time.
 *
 * Five facade textures over a hundred and fifty buildings means the eye finds
 * the same wall again and again. A tint costs nothing once the geometry is
 * merged — the attribute rides along in `mergeIntoOne` — and a few percent of
 * brightness and warmth is enough to stop two neighbours reading as one
 * prefab. It is keyed off position rather than drawn from `Math.random`,
 * because the seeded stream belongs to the layout, not to the paint.
 */
function tintAt(x, z, salt = 0, spread = 0.15) {
  const b = 1 + (hash2(Math.round(x * 4), Math.round(z * 4), salt) - 0.5) * spread * 2;
  const warm = (hash2(Math.round(x * 4), Math.round(z * 4), salt + 77) - 0.5) * 0.14;
  return [
    Math.max(0, b * (1 + warm)),
    Math.max(0, b),
    Math.max(0, b * (1 - warm * 1.1)),
  ];
}

/**
 * Coarse occlusion field over the sector, sampled by `bakeStatic`.
 *
 * A city of right angles is mostly missing the darkening where surfaces meet:
 * shadow maps give you the sun's shadow, not the ambient light a wall keeps
 * out of the gutter beside it. Every registered box deposits into a grid,
 * which is blurred a few times; horizontal surfaces near the ground then read
 * it back and darken. It is the cheapest thing in this file and close to the
 * most valuable.
 */
function occlusionField(world, extent, cell = 1.6) {
  const n = Math.ceil((extent * 2) / cell);
  const idx = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + extent) / cell)));
  let occ = new Float32Array(n * n);

  for (const b of world.boxes) {
    if (b.top < 0.8) continue;
    const weight = Math.min(1, b.top / 3.2);
    const x0 = idx(b.minX), x1 = idx(b.maxX), z0 = idx(b.minZ), z1 = idx(b.maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * n + x;
        if (occ[i] < weight) occ[i] = weight;
      }
    }
  }

  // separable box blur; three passes spread the darkening about 5 m
  const tmp = new Float32Array(n * n);
  for (let pass = 0; pass < 3; pass++) {
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const l = occ[z * n + Math.max(0, x - 1)], r = occ[z * n + Math.min(n - 1, x + 1)];
        tmp[z * n + x] = (l + occ[z * n + x] * 2 + r) / 4;
      }
    }
    for (let z = 0; z < n; z++) {
      const up = Math.max(0, z - 1) * n, dn = Math.min(n - 1, z + 1) * n;
      for (let x = 0; x < n; x++) {
        occ[z * n + x] = (tmp[up + x] + tmp[z * n + x] * 2 + tmp[dn + x]) / 4;
      }
    }
  }

  return (x, z) => occ[idx(z) * n + idx(x)];
}

/**
 * UV options for a wall wearing a facade: floors and window bays snapped to
 * the wall's own extent so nothing is cut at a corner, the tile slid along by
 * a whole bay or floor so two buildings do not show the same window in the
 * same place, and enough horizontal bands for the bake to shade the footing.
 */
function wallUV(x, z, h) {
  const key = [Math.round(x), Math.round(z)];
  return {
    snapU: BAY,
    snapV: STOREY,
    offsetU: Math.floor(hash2(key[0], key[1], 3) * FACADE_BAYS) / FACADE_BAYS,
    offsetV: Math.floor(hash2(key[0], key[1], 4) * FACADE_FLOORS) / FACADE_FLOORS,
    bands: Math.max(1, Math.min(14, Math.round(h / 2.2))),
  };
}

/** Smooth value noise over the ground plane, for breaking up a tiled floor. */
function smoothNoise(x, z, scale) {
  const fx = x / scale, fz = z / scale;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(fx - x0), v = s(fz - z0);
  const a = hash2(x0, z0, 11), b = hash2(x0 + 1, z0, 11);
  const c = hash2(x0, z0 + 1, 11), d = hash2(x0 + 1, z0 + 1, 11);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Write vertex colours into a world-space geometry: tint everywhere, plus
 * ambient darkening where a surface meets the ground or stands close to it.
 *
 * `mottle` adds low-frequency drift per vertex instead of per mesh, which is
 * what a floor the size of the whole sector needs — one 8 m tile repeated
 * forty times reads as wallpaper until something varies at a scale the tile
 * does not have.
 */
function shadeGeometry(geo, tint, occlusion, mottle = 0) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const up = nor ? nor.getY(i) : 0;
    let ao = 1;
    if (up > 0.6 && y < 2.2) {
      // a floor: darken by what stands around it
      ao = 1 - 0.5 * Math.min(1, occlusion(x, z) * 1.25);
    } else if (Math.abs(up) < 0.6) {
      // a wall: darken toward its own footing, where light does not reach.
      // Gentler than the floor term, and over a shorter run: a wall already
      // spends half the day in shadow, and doubling that is just black.
      ao = 0.66 + 0.34 * Math.min(1, Math.max(0, y) / 2.2);
    }
    let r = tint[0], g = tint[1], b = tint[2];
    if (mottle) {
      const drift = 1 + ((smoothNoise(x, z, 11) - 0.5) * 1.2
                       + (smoothNoise(x, z, 37) - 0.5) * 0.8) * mottle;
      const warm = (smoothNoise(x + 500, z - 500, 23) - 0.5) * mottle * 0.7;
      r *= drift * (1 + warm); g *= drift; b *= drift * (1 - warm);
    }
    col[i * 3] = Math.max(0, r * ao);
    col[i * 3 + 1] = Math.max(0, g * ao);
    col[i * 3 + 2] = Math.max(0, b * ao);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * Concatenate geometries that are already in world space into one buffer.
 *
 * `BufferGeometryUtils` lives in three's examples, which this repo does not
 * vendor, so this covers the one case the city needs: position/normal/uv/
 * colour, indexed output, indexed or non-indexed input.
 */
function mergeIntoOne(geos) {
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

/**
 * Collapse the finished city into one mesh per material.
 *
 * The city is ~1500 boxes that never move, and drawing them one at a time
 * cost 567 calls for under 10k triangles — about 18 triangles a call, which
 * is all driver and no pixels. The shadow pass paid the same bill again.
 *
 * Rendering and raycasting want different shapes, so they get different
 * ones. The merged meshes go into the scene; the meshes they were built
 * from leave it but stay alive in `world.solids`, off the scene graph with
 * their transforms frozen, because that is what bullets are traced against.
 * Tracing one merged city mesh instead would mean testing every triangle in
 * the sector for every pellet, and would quietly change what a shot can hit:
 * the solid set is deliberately not everything you can see.
 *
 * It is also where per-surface shading is baked in, because this is the only
 * point at which every mesh is in world space together — see `shadeGeometry`.
 */
function bakeStatic(group, world) {
  group.updateMatrixWorld(true);

  const meshes = [];
  group.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });

  // the merge is also the one moment every surface is in world space at once,
  // which is what the tint and the ambient darkening need
  const occlusion = occlusionField(world, (GRID * BLOCK) / 2 + 62);

  const buckets = new Map();
  for (const m of meshes) {
    let b = buckets.get(m.material.uuid);
    if (!b) buckets.set(m.material.uuid, b = { material: m.material, geos: [], cast: false, receive: false });
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    shadeGeometry(geo, m.userData.tint || [1, 1, 1], occlusion, m.userData.mottle || 0);
    b.geos.push(geo);
    b.cast = b.cast || m.castShadow;
    b.receive = b.receive || m.receiveShadow;
  }

  // nothing updates a detached mesh's matrix, so freeze it at what it was
  for (const m of meshes) {
    m.matrixAutoUpdate = false;
    m.removeFromParent();
  }
  // the groups the wrecked cars were assembled in are empty now
  for (const child of [...group.children]) {
    if (child.isGroup && child.children.length === 0) group.remove(child);
  }

  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(mergeIntoOne(b.geos), b.material);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    for (const g of b.geos) g.dispose();
  }
  return buckets.size;
}

export function buildCity(scene) {
  const world = new World();
  world.bounds = (GRID * BLOCK) / 2 - 2;

  const group = new THREE.Group();
  scene.add(group);

  // Standard rather than Phong: every one of these surfaces stands under the
  // image-based sky light hung on `scene.environment`, and only a PBR
  // material reads it. Roughness comes off each texture's own luminance, so
  // soot and grime answer the sky flatly while glass and bare metal catch it.
  //
  // All of it is minted inside `reserve`, which rewinds the seeded stream
  // afterwards. Three spends four `Math.random()` calls per material, texture
  // and geometry on UUIDs, so without this every change to the look here
  // handed each seed a different city (see `rng.js`).
  const mats = reserve(() => {
    // Several variants per style, not one. Every building of a style used to
    // wear the identical wall, and a repeated 10 m tile is far less obvious
    // than a repeated building.
    const facades = [];
    for (let style = 0; style < 5; style++) {
      for (let v = 0; v < FACADE_VARIANTS; v++) {
        const key = 'facade' + style + '_' + v;
        const map = TEX.facade(style, v);
        facades.push(new THREE.MeshStandardMaterial({
          map, normalMap: TEX.normalFrom(map, 1.1, key, 1, true),
          normalScale: new THREE.Vector2(0.55, 0.55),
          roughnessMap: TEX.surfaceFrom(map, { dark: 1, lite: 0.34, half: true }, key),
          roughness: 1, metalness: 0.05, envMapIntensity: 0.7, vertexColors: true,
        }));
      }
    }

    const concreteTex = TEX.concrete('#6a6c72');   // cooler stock; the warm key tints it
    const concreteMat = new THREE.MeshStandardMaterial({
      map: concreteTex, normalMap: TEX.normalFrom(concreteTex, 1.1, 'conc', 1),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: TEX.surfaceFrom(concreteTex, { dark: 1, lite: 0.72 }, 'conc'),
      roughness: 1, metalness: 0.02, envMapIntensity: 0.6, vertexColors: true,
    });

    const darkTex = TEX.concrete('#53565c', 1);
    const darkConcrete = new THREE.MeshStandardMaterial({
      map: darkTex, normalMap: TEX.normalFrom(darkTex, 1.1, 'dark', 1),
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: TEX.surfaceFrom(darkTex, { dark: 1, lite: 0.72 }, 'dark'),
      roughness: 1, metalness: 0.02, envMapIntensity: 0.6, vertexColors: true,
    });

    // Containers, shutters and drums are the most repeated props in the city,
    // and one rust texture made every one of them the same green box. Each
    // variant is a different paint failing to the same oxide underneath.
    // Rust is oxide over what is still metal, so the bright pixels hold some
    // of that back: one packed map feeds both roughness and metalness.
    const rusts = [0, 1, 2, 3].map((v) => {
      const tex = TEX.rustMetal(v);
      const surface = TEX.surfaceFrom(tex, { dark: 1, lite: 0.5, metalDark: 0.1, metalLite: 0.75 }, 'rust' + v);
      return new THREE.MeshStandardMaterial({
        map: tex, normalMap: TEX.normalFrom(tex, 1.6, 'rust' + v, 1),
        normalScale: new THREE.Vector2(1, 1),
        roughnessMap: surface, metalnessMap: surface,
        roughness: 1, metalness: 1, envMapIntensity: 0.8, vertexColors: true,
      });
    });

    const metalTex = TEX.paintedMetal();
    const metalSurface = TEX.surfaceFrom(metalTex, { dark: 0.9, lite: 0.38, metalDark: 0.35, metalLite: 0.85 }, 'painted');
    // the map is a light grey carrying scratches and rust, so what colour a
    // thing is painted stays on the material — one texture, many paints
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x74797f,
      map: metalTex, normalMap: TEX.normalFrom(metalTex, 1.1, 'painted', 1),
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: metalSurface, metalnessMap: metalSurface,
      roughness: 1, metalness: 1, envMapIntensity: 1, vertexColors: true,
    });

    // dark glass catches the sky hard, which is what sells it as glass; the
    // map is the dirt on it, without which it is a mirror in a ruined city
    const glassTex = TEX.dirtyGlass();
    const glassMat = new THREE.MeshStandardMaterial({
      map: glassTex, normalMap: TEX.normalFrom(glassTex, 0.8, 'glass', 1),
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughnessMap: TEX.surfaceFrom(glassTex, { dark: 0.08, lite: 0.7 }, 'glass'),
      roughness: 1, metalness: 0.88, envMapIntensity: 1.35, vertexColors: true,
    });

    const asphaltTex = TEX.asphalt();
    const asphaltMat = new THREE.MeshStandardMaterial({
      map: asphaltTex, normalMap: TEX.normalFrom(asphaltTex, 0.9, 'asph', 1),
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: TEX.surfaceFrom(asphaltTex, { dark: 0.98, lite: 0.55 }, 'asph'),
      roughness: 1, metalness: 0.05, envMapIntensity: 0.5, vertexColors: true,
    });

    // Wrecked cars used to mint a material per car — 140-odd one-off materials
    // that no batching can ever merge. One palette, shared.
    const carBodyMats = [0x74797f, 0xa25b51, 0x5e735f, 0x8b8b80, 0x4c5157].map((color) =>
      new THREE.MeshStandardMaterial({
        color, roughness: 0.68, metalness: 0.55, envMapIntensity: 0.8,
        map: metalTex, normalMap: TEX.normalFrom(metalTex, 1.1, 'painted', 1),
        normalScale: new THREE.Vector2(0.4, 0.4), vertexColors: true,
      }));
    const burntMat = new THREE.MeshStandardMaterial({
      color: 0x1d1c1b, roughness: 0.92, metalness: 0.3, vertexColors: true,
    });
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x17181a, roughness: 0.96, metalness: 0, vertexColors: true,
    });

    // Record the world size each material's tile covers, so the contract in
    // `TILE` is something a check can read back off the finished city rather
    // than something the two files have to be trusted to agree on.
    const label = (m, name, tile) => { m.userData.name = name; m.userData.tile = tile; };
    facades.forEach((m, i) => label(m, 'facade' + i, TILE.facade));
    carBodyMats.forEach((m, i) => label(m, 'car' + i, TILE.metal));
    label(concreteMat, 'concrete', TILE.concrete);
    label(darkConcrete, 'dark', TILE.concrete);
    rusts.forEach((m, i) => label(m, 'rust' + i, TILE.rust));
    label(metalMat, 'metal', TILE.metal);
    label(glassMat, 'glass', TILE.glass);
    label(asphaltMat, 'asphalt', TILE.asphalt);

    return { facades, concreteMat, darkConcrete, rusts, metalMat, glassMat,
      asphaltMat, carBodyMats, burntMat, tireMat };
  });
  const { facades, concreteMat, darkConcrete, rusts, metalMat, glassMat,
    asphaltMat, carBodyMats, burntMat, tireMat } = mats;

  /** Which paint this bit of scrap wears — by position, so it costs no stream. */
  const rustFor = (x, z) =>
    rusts[Math.floor(hash2(Math.round(x), Math.round(z), 21) * rusts.length)];

  // ---------------------------------------------------------------- ground
  const groundSize = GRID * BLOCK + 120;
  // Subdivided, and not for the silhouette: flat ground has four vertices and
  // nowhere to put the ambient darkening the bake computes. At ~2.5 m a cell
  // it also breaks up the tiling, because the per-cell tint lands at a
  // different scale from the 8 m texture.
  const groundCells = Math.round(groundSize / 2.6);
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, groundCells, groundCells);
  const guv = groundGeo.attributes.uv;
  for (let i = 0; i < guv.count; i++) {
    guv.setXY(i, guv.getX(i) * (groundSize / TILE.asphalt), guv.getY(i) * (groundSize / TILE.asphalt));
  }
  guv.needsUpdate = true;
  const ground = new THREE.Mesh(groundGeo, asphaltMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.tint = [1, 1, 1];
  ground.userData.mottle = 0.22;
  group.add(ground);

  // The ground bullets are traced against is the same plane at two triangles.
  // three has no BVH — a raycast walks every triangle inside the bounding
  // sphere, and the ground's covers the sector, so tracing the subdivided one
  // would test thirty thousand triangles per pellet and nine per shotgun
  // blast. It never joins the scene, so nothing will update its matrix later.
  const groundHit = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), asphaltMat);
  groundHit.rotation.x = -Math.PI / 2;
  groundHit.updateMatrixWorld(true);
  groundHit.matrixAutoUpdate = false;
  world.solids.push(groundHit);   // so bullets that miss still kick up dust

  // sidewalks: a raised concrete apron around every lot
  const walkMat = concreteMat;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const walk = new THREE.Mesh(
        boxGeo(LOT + 6, 0.28, LOT + 6, TILE.concrete, { cells: 11 }), walkMat);
      walk.position.set(lotCenter(i), 0.14, lotCenter(j));
      walk.receiveShadow = true;
      walk.userData.tint = tintAt(lotCenter(i), lotCenter(j), 5, 0.07);
      group.add(walk);
    }
  }

  // ------------------------------------------------------------- buildings
  const fireBarrels = [];

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const isCentre = i === 2 && j === 3;      // player insertion plaza
      if (isCentre) {
        buildPlaza(group, world, cx, cz, darkConcrete, metalMat);
        continue;
      }

      const roll = Math.random();
      if (roll < 0.16) {
        buildRubbleLot(group, world, cx, cz, darkConcrete);
      } else if (roll < 0.28) {
        buildLowRuin(group, world, cx, cz, facades, darkConcrete);
      } else {
        buildTower(group, world, cx, cz, facades, concreteMat, metalMat, glassMat);
      }
    }
  }

  // ----------------------------------------------------------- street junk
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const half = LOT / 2 + 3;

      // streetlight on a lot corner
      if (Math.random() < 0.55) {
        streetlight(group, world, cx + half + 1.5, cz + half + 1.5, metalMat);
      }
      // wrecked vehicles along the street running +Z of this lot
      if (Math.random() < 0.8) {
        const along = randRange(-LOT / 2, LOT / 2);
        wreckedCar(group, world, cx + along, cz + half + randRange(2, 5), Math.random() < 0.5 ? 0 : Math.PI, metalMat, glassMat);
      }
      if (Math.random() < 0.6) {
        const along = randRange(-LOT / 2, LOT / 2);
        wreckedCar(group, world, cx + half + randRange(2, 5), cz + along, Math.PI / 2 + randRange(-0.35, 0.35), metalMat, glassMat);
      }
      // barricades and containers block some intersections
      if (Math.random() < 0.30) {
        barricade(group, world, cx + half + randRange(-3, 3), cz + half + randRange(-3, 3), Math.random() * Math.PI, darkConcrete);
      }
      if (Math.random() < 0.16) {
        container(group, world, cx + half + randRange(-2, 2), cz + half + randRange(-2, 2), Math.random() < 0.5 ? 0 : Math.PI / 2);
      }
      if (Math.random() < 0.35) {
        const b = fireBarrel(group, world, cx + half + randRange(-4, 4), cz + half + randRange(-4, 4));
        fireBarrels.push(b);
      }
      rubblePile(group, cx + randRange(-half, half), cz + half + randRange(1, 5), darkConcrete);
    }
  }

  // ---------------------------------------------------- perimeter blockade
  const edge = (GRID * BLOCK) / 2;
  for (const [ax, az, rot] of [[0, -edge, 0], [0, edge, 0], [-edge, 0, Math.PI / 2], [edge, 0, Math.PI / 2]]) {
    const len = GRID * BLOCK + 20;
    const wall = new THREE.Mesh(
      boxGeo(rot === 0 ? len : 4, 9, rot === 0 ? 4 : len, TILE.concrete, { bands: 6 }), darkConcrete);
    wall.position.set(ax, 4.5, az);
    wall.castShadow = wall.receiveShadow = true;
    wall.userData.tint = tintAt(ax, az, 9, 0.06);
    group.add(wall);
    world.solids.push(wall);
    const hw = rot === 0 ? len / 2 : 2, hd = rot === 0 ? 2 : len / 2;
    world.addBox(ax - hw, az - hd, ax + hw, az + hd, 9);
    // piled debris against the inside face so the wall reads as a collapse
    for (let k = 0; k < 14; k++) {
      const t = randRange(-0.45, 0.45) * len;
      const px = rot === 0 ? ax + t : ax - Math.sign(ax) * randRange(3, 6);
      const pz = rot === 0 ? az - Math.sign(az) * randRange(3, 6) : az + t;
      rubblePile(group, px, pz, darkConcrete, 1.6);
    }
  }

  // ------------------------------------------------- climbable structures
  // Vertical ground: raised slabs and stacked containers, each reachable by
  // a stair run of half-metre steps so they can be walked up without jumping.
  const perches = [];
  const edgeLimit = (GRID * BLOCK) / 2 - 8;    // keep clear of the perimeter
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = lotCenter(i), cz = lotCenter(j);
      const half = LOT / 2 + 3;
      const wantTerrace = Math.random() < 0.6;

      // A structure is only worth building if both the platform footprint and
      // the whole stair run land on clear ground — a buried staircase is an
      // unclimbable one.
      for (let attempt = 0; attempt < 16; attempt++) {
        const px = cx + randRange(-half - 5, half + 5);
        const pz = cz + randRange(-half - 5, half + 5);
        if (Math.abs(px) > edgeLimit || Math.abs(pz) > edgeLimit) continue;

        if (wantTerrace) {
          const h = randRange(3.2, 5.4);
          const sw = randRange(5, 8.5), sd = randRange(5, 8.5);
          const fromSouth = Math.random() < 0.5;
          const runLen = h * 1.9 + 1;
          const zLo = fromSouth ? pz - sd / 2 : pz - sd / 2 - runLen;
          const zHi = fromSouth ? pz + sd / 2 + runLen : pz + sd / 2;
          if (!areaClear(world, px - sw / 2 - 1, zLo - 1, px + sw / 2 + 1, zHi + 1)) continue;
          terrace(group, world, px, pz, sw, sd, h, fromSouth, darkConcrete, perches);
        } else {
          const rot = Math.random() < 0.5 ? 0 : Math.PI / 2;
          const halfW = rot === 0 ? 1.6 : 3.4, halfD = rot === 0 ? 3.4 : 1.6;
          if (!areaClear(world, px - halfW - 8, pz - halfD - 8, px + halfW + 8, pz + halfD + 8)) continue;
          containerStack(group, world, px, pz, rot, perches);
        }
        break;
      }
    }
  }

  const batches = bakeStatic(group, world);

  return { world, group, fireBarrels, perches, batches };

  /** True when no registered box taller than `maxTop` overlaps the rectangle. */
  function areaClear(w, minX, minZ, maxX, maxZ, maxTop = 0.4) {
    for (const b of w.boxes) {
      if (b.top <= maxTop) continue;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------- builders
  function buildTower(g, w, cx, cz, facadeMats, conc, metal, glass) {
    // split the lot into 1, 2 or 4 buildings
    const splits = pick([1, 1, 2, 2, 4]);
    const cells = splits === 1 ? [[0, 0, LOT, LOT]]
      : splits === 2
        ? (Math.random() < 0.5
          ? [[-LOT / 4, 0, LOT / 2 - 1, LOT], [LOT / 4, 0, LOT / 2 - 1, LOT]]
          : [[0, -LOT / 4, LOT, LOT / 2 - 1], [0, LOT / 4, LOT, LOT / 2 - 1]])
        : [[-LOT / 4, -LOT / 4, LOT / 2 - 1, LOT / 2 - 1], [LOT / 4, -LOT / 4, LOT / 2 - 1, LOT / 2 - 1],
           [-LOT / 4, LOT / 4, LOT / 2 - 1, LOT / 2 - 1], [LOT / 4, LOT / 4, LOT / 2 - 1, LOT / 2 - 1]];

    for (const [ox, oz, bw, bd] of cells) {
      const h = randRange(7, 12) + Math.random() * randRange(0, 26);
      const mat = pick(facadeMats);
      const x = cx + ox, z = cz + oz;
      const tint = tintAt(x, z, 1);
      const body = new THREE.Mesh(boxGeo(bw, h, bd, TILE.facade, wallUV(x, z, h)), mat);
      body.position.set(x, h / 2, z);
      body.castShadow = body.receiveShadow = true;
      body.userData.tint = tint;
      g.add(body);
      w.addSolid(body, bw / 2, bd / 2, h);

      // parapet
      const cap = new THREE.Mesh(boxGeo(bw + 0.6, 0.8, bd + 0.6, TILE.concrete), conc);
      cap.position.set(x, h + 0.4, z);
      cap.castShadow = true;
      cap.userData.tint = tint;
      g.add(cap);

      // tall blocks step back near the top, which is most of what gives a
      // skyline its silhouette
      if (h > 20 && Math.random() < 0.65) {
        const setH = randRange(4, 10);
        const inset = randRange(1.5, 3);
        const tower = new THREE.Mesh(
          boxGeo(bw - inset * 2, setH, bd - inset * 2, TILE.facade, wallUV(x + 7, z + 7, setH)), mat);
        tower.position.set(x + randRange(-inset, inset) * 0.4, h + setH / 2 + 0.8,
          z + randRange(-inset, inset) * 0.4);
        tower.castShadow = tower.receiveShadow = true;
        tower.userData.tint = tint;
        g.add(tower);
        w.solids.push(tower);
        const capTop = new THREE.Mesh(
          boxGeo(bw - inset * 2 + 0.5, 0.6, bd - inset * 2 + 0.5, TILE.concrete), conc);
        capTop.position.set(tower.position.x, h + setH + 1.1, tower.position.z);
        capTop.userData.tint = tint;
        g.add(capTop);
      }

      // a ledge at the base grounds the block against the pavement
      const skirt = new THREE.Mesh(boxGeo(bw + 0.5, 0.45, bd + 0.5, TILE.concrete), conc);
      skirt.position.set(x, 3.0, z);
      skirt.castShadow = true;
      skirt.userData.tint = tint;
      g.add(skirt);

      // rooftop clutter
      if (h > 14) {
        for (let k = 0; k < 2 + (Math.random() * 3 | 0); k++) {
          const uw = randRange(1.2, 2.8), uh = randRange(0.8, 2.2);
          const unit = new THREE.Mesh(boxGeo(uw, uh, uw, TILE.metal), metal);
          unit.position.set(x + randRange(-bw / 3, bw / 3), h + uh / 2 + 0.6, z + randRange(-bd / 3, bd / 3));
          unit.castShadow = true;
          g.add(unit);
        }
        if (Math.random() < 0.5) {
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, randRange(4, 9), 5), metal);
          mast.position.set(x + randRange(-bw / 3, bw / 3), h + 4 + 0.6, z + randRange(-bd / 3, bd / 3));
          g.add(mast);
        }
      }

      // ground-floor storefront: dark glass band + a shutter
      const band = new THREE.Mesh(boxGeo(bw + 0.1, 2.6, bd + 0.1, TILE.glass), glass);
      band.position.set(x, 1.6, z);
      g.add(band);
      const shut = new THREE.Mesh(boxGeo(bw * 0.4, 2.4, 0.2, TILE.rust), rustFor(x, z));
      shut.position.set(x + randRange(-bw / 4, bw / 4), 1.4, z + bd / 2 + 0.12);
      shut.userData.tint = tintAt(x, z, 2, 0.1);
      g.add(shut);
    }
  }

  function buildLowRuin(g, w, cx, cz, facadeMats, conc) {
    // a shell of walls with the roof gone
    const h = randRange(3.5, 6.5);
    const t = 0.7;
    const mat = pick(facadeMats);
    const half = LOT / 2 - 1;
    const walls = [
      [0, -half, LOT - 2, t], [0, half, LOT - 2, t],
      [-half, 0, t, LOT - 2], [half, 0, t, LOT - 2],
    ];
    for (const [ox, oz, bw, bd] of walls) {
      if (Math.random() < 0.25) continue;              // blown-out wall
      const seg = Math.random() < 0.4 ? 0.55 : 1;      // partial collapse
      const wgt = bw > bd ? bw * seg : bw, dgt = bd > bw ? bd * seg : bd;
      const hh = h * randRange(0.6, 1);
      const px = cx + ox + (bw > bd ? randRange(-2, 2) : 0);
      const pz = cz + oz + (bd > bw ? randRange(-2, 2) : 0);
      const m = new THREE.Mesh(boxGeo(wgt, hh, dgt, TILE.facade, wallUV(px, pz, hh)), mat);
      m.position.set(px, hh / 2, pz);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(cx, cz, 1);
      g.add(m);
      w.addSolid(m, wgt / 2, dgt / 2, hh);
    }
    // floor slab + interior rubble
    const slab = new THREE.Mesh(boxGeo(LOT - 2, 0.3, LOT - 2, TILE.concrete, { cells: 9 }), conc);
    slab.position.set(cx, 0.3, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);
    for (let k = 0; k < 5; k++) rubblePile(g, cx + randRange(-8, 8), cz + randRange(-8, 8), conc);
    if (Math.random() < 0.5) container(g, w, cx + randRange(-6, 6), cz + randRange(-6, 6), Math.random() * Math.PI);
  }

  function buildRubbleLot(g, w, cx, cz, conc) {
    const slab = new THREE.Mesh(boxGeo(LOT, 0.2, LOT, TILE.concrete, { cells: 9 }), conc);
    slab.position.set(cx, 0.25, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);
    for (let k = 0; k < 14; k++) {
      rubblePile(g, cx + randRange(-9, 9), cz + randRange(-9, 9), conc, randRange(0.7, 1.9));
    }
    // leaning slabs of collapsed floor
    for (let k = 0; k < 3; k++) {
      const sw = randRange(3, 7), sh = randRange(2.5, 5);
      const m = new THREE.Mesh(boxGeo(sw, 0.4, sh, TILE.concrete), conc);
      m.position.set(cx + randRange(-7, 7), randRange(0.8, 2), cz + randRange(-7, 7));
      m.rotation.set(randRange(-0.9, 0.9), Math.random() * Math.PI, randRange(-0.9, 0.9));
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(m.position.x, m.position.z, 7, 0.12);
      g.add(m);
      w.solids.push(m);
    }
    if (Math.random() < 0.6) container(g, w, cx + randRange(-7, 7), cz + randRange(-7, 7), Math.random() * Math.PI);
  }

  function buildPlaza(g, w, cx, cz, conc, metal) {
    const slab = new THREE.Mesh(boxGeo(LOT + 4, 0.3, LOT + 4, TILE.concrete, { cells: 11 }), conc);
    slab.position.set(cx, 0.15, cz);
    slab.receiveShadow = true;
    slab.userData.tint = tintAt(cx, cz, 6, 0.07);
    g.add(slab);

    // dry fountain in the middle: cover to fight from
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 1, 16, 1, true), conc);
    ring.position.set(cx, 0.5, cz);
    ring.material = conc;
    ring.castShadow = ring.receiveShadow = true;
    g.add(ring);
    w.addBox(cx - 3.4, cz - 3.4, cx + 3.4, cz + 3.4, 1);
    w.solids.push(ring);

    const plinth = new THREE.Mesh(boxGeo(1.4, 2.2, 1.4, TILE.concrete), conc);
    plinth.position.set(cx, 1.1, cz);
    plinth.castShadow = true;
    g.add(plinth);

    // sandbagged firing positions around the plaza
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      barricade(g, w, cx + Math.cos(a) * 8, cz + Math.sin(a) * 8, a, conc);
    }
    for (let k = 0; k < 3; k++) container(g, w, cx + randRange(-9, 9), cz + randRange(-9, 9), Math.random() * Math.PI);
  }

  /**
   * Stair run of half-metre steps — low enough that the step-up in the
   * movement code carries you and the hostiles up without jumping.
   */
  function stairs(g, w, x, z, rot, height, width = 3) {
    const rise = 0.46;
    const run = 0.85;
    const count = Math.max(1, Math.round(height / rise));
    const dirX = Math.sin(rot), dirZ = Math.cos(rot);
    for (let k = 0; k < count; k++) {
      const top = rise * (k + 1);
      const sx = x + dirX * (run * k);
      const sz = z + dirZ * (run * k);
      // each tread is a solid block from the ground up to its own height
      const m = new THREE.Mesh(boxGeo(
        Math.abs(dirX) > 0.5 ? run : width, top,
        Math.abs(dirX) > 0.5 ? width : run, TILE.concrete), darkConcrete);
      m.position.set(sx, top / 2, sz);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(x, z, 8, 0.06);
      g.add(m);
      w.solids.push(m);
      const hw = (Math.abs(dirX) > 0.5 ? run : width) / 2;
      const hd = (Math.abs(dirX) > 0.5 ? width : run) / 2;
      w.addBox(sx - hw, sz - hd, sx + hw, sz + hd, top);
    }
    // where the run tops out
    return { x: x + dirX * run * count, z: z + dirZ * run * count, y: rise * count };
  }

  /** Raised slab of collapsed floor: cover, a firing position, a perch. */
  function terrace(g, w, x, z, sw, sd, h, fromSouth, conc, perchList) {
    const slab = new THREE.Mesh(boxGeo(sw, h, sd, TILE.concrete, { bands: 3, cells: 3 }), conc);
    slab.position.set(x, h / 2, z);
    slab.castShadow = slab.receiveShadow = true;
    slab.userData.tint = tintAt(x, z, 8, 0.06);
    g.add(slab);
    w.solids.push(slab);
    w.addBox(x - sw / 2, z - sd / 2, x + sw / 2, z + sd / 2, h);

    // stairs climbing to it from the side the caller checked was clear
    const rot = fromSouth ? Math.PI : 0;
    const startZ = fromSouth ? z + sd / 2 + h * 1.85 : z - sd / 2 - h * 1.85;
    stairs(g, w, x, startZ, rot, h, 3);

    // knee-high lip so the top reads as a platform, not a plinth
    for (const [ox, oz, lw, ld] of [
      [0, -sd / 2 + 0.3, sw, 0.5], [0, sd / 2 - 0.3, sw, 0.5],
      [-sw / 2 + 0.3, 0, 0.5, sd], [sw / 2 - 0.3, 0, 0.5, sd],
    ]) {
      if (Math.random() < 0.35) continue;                 // gaps to shoot through
      const lip = new THREE.Mesh(boxGeo(lw, 0.5, ld, TILE.concrete), conc);
      lip.position.set(x + ox, h + 0.25, z + oz);
      lip.castShadow = true;
      g.add(lip);
      w.solids.push(lip);
    }
    if (Math.random() < 0.4) {
      const crate = new THREE.Mesh(boxGeo(1.2, 1.2, 1.2, TILE.rust), rustFor(x, z));
      crate.position.set(x + randRange(-sw / 4, sw / 4), h + 0.6, z + randRange(-sd / 4, sd / 4));
      crate.castShadow = true;
      crate.userData.tint = tintAt(crate.position.x, crate.position.z, 2, 0.12);
      g.add(crate);
    }
    perchList.push({ x, y: h, z });
    return { x, y: h, z };
  }

  /** Two containers stacked, with crate steps up the side. */
  function containerStack(g, w, x, z, rot, perchList) {
    const cw = 2.5, ch = 2.6, cd = 6.0;
    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(boxGeo(cw, ch, cd, TILE.rust), rustFor(x, z + k * 3));
      m.position.set(x + (k ? randRange(-0.4, 0.4) : 0), ch / 2 + k * ch, z);
      m.rotation.y = rot;
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(x, z, 2 + k, 0.14);
      g.add(m);
      w.solids.push(m);
    }
    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const halfW = (cw / 2) * cos + (cd / 2) * sin;
    const halfD = (cw / 2) * sin + (cd / 2) * cos;
    w.addBox(x - halfW, z - halfD, x + halfW, z + halfD, ch * 2);

    // crate steps climbing the long side up to the top of the stack
    const runLen = ch * 2 * 1.85;
    if (rot === 0) {
      stairs(g, w, x + halfW + 1 + runLen, z, Math.PI / 2 * 3, ch * 2, 2.4);
    } else {
      stairs(g, w, x, z + halfD + 1 + runLen, Math.PI, ch * 2, 2.4);
    }

    perchList.push({ x, y: ch * 2, z });
  }

  function streetlight(g, w, x, z, metal) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 7, 6), metal);
    pole.position.set(x, 3.5, z);
    pole.castShadow = true;
    g.add(pole);
    const arm = new THREE.Mesh(boxGeo(1.8, 0.16, 0.16, TILE.metal), metal);
    arm.position.set(x + 0.9, 6.9, z);
    g.add(arm);
    const head = new THREE.Mesh(boxGeo(0.9, 0.22, 0.4, TILE.metal), metal);
    head.position.set(x + 1.7, 6.78, z);
    g.add(head);
    w.addBox(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 7);
  }

  function wreckedCar(g, w, x, z, rot, metal, glass) {
    const car = new THREE.Group();
    // the branch still draws exactly one number either way, so the seeded
    // stream — and every city it lays out — is unchanged by the palette
    const bodyMat = Math.random() < 0.5 ? rustFor(x, z) : pick(carBodyMats);
    const bw = 1.9, bl = 4.4;

    const paint = tintAt(x, z, 4, 0.16);
    const chassis = new THREE.Mesh(boxGeo(bw, 0.75, bl, TILE.metal), bodyMat);
    chassis.position.y = 0.75;
    chassis.castShadow = chassis.receiveShadow = true;
    chassis.userData.tint = paint;
    car.add(chassis);

    const cabin = new THREE.Mesh(boxGeo(bw - 0.25, 0.75, bl * 0.45, TILE.glass), glass);
    cabin.position.set(0, 1.5, -0.2);
    cabin.castShadow = true;
    car.add(cabin);

    const hood = new THREE.Mesh(boxGeo(bw - 0.1, 0.35, bl * 0.3, TILE.metal), bodyMat);
    hood.position.set(0, 1.25, bl * 0.32);
    hood.userData.tint = paint;
    car.add(hood);

    // burnt-out cars lose their wheels and sit on the rims
    const burnt = Math.random() < 0.4;
    if (!burnt) {
      for (const [wx, wz] of [[-bw / 2, bl / 3], [bw / 2, bl / 3], [-bw / 2, -bl / 3], [bw / 2, -bl / 3]]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 10), tireMat);
        t.rotation.z = Math.PI / 2;
        t.position.set(wx, 0.42, wz);
        car.add(t);
      }
    } else {
      chassis.material = burntMat;
      cabin.visible = false;
      chassis.position.y = 0.5;
    }

    car.position.set(x, 0, z);
    car.rotation.y = rot + randRange(-0.12, 0.12);
    car.rotation.z = burnt ? 0 : randRange(-0.03, 0.03);
    g.add(car);

    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const halfW = (bw / 2) * cos + (bl / 2) * sin;
    const halfD = (bw / 2) * sin + (bl / 2) * cos;
    w.addBox(x - halfW, z - halfD, x + halfW, z + halfD, 1.5);
    w.solids.push(chassis, cabin);
  }

  function barricade(g, w, x, z, rot, conc) {
    const n = 2 + (Math.random() * 2 | 0);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(boxGeo(2.2, 1.05, 0.7, TILE.concrete), conc);
      const off = (k - (n - 1) / 2) * 2.3;
      m.position.set(x + Math.cos(rot) * off, 0.55, z + Math.sin(rot) * off);
      m.rotation.y = rot + Math.PI / 2 + randRange(-0.08, 0.08);
      m.castShadow = m.receiveShadow = true;
      m.userData.tint = tintAt(m.position.x, m.position.z, 7, 0.1);
      g.add(m);
      w.solids.push(m);
      const px = m.position.x, pz = m.position.z;
      w.addBox(px - 1.1, pz - 1.1, px + 1.1, pz + 1.1, 1.05);
    }
  }

  function container(g, w, x, z, rot) {
    const cw = 2.5, ch = 2.6, cd = 6.0;
    const m = new THREE.Mesh(boxGeo(cw, ch, cd, TILE.rust), rustFor(x, z));
    m.position.set(x, ch / 2, z);
    m.rotation.y = rot;
    m.castShadow = m.receiveShadow = true;
    m.userData.tint = tintAt(x, z, 2, 0.16);
    g.add(m);
    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const halfW = (cw / 2) * cos + (cd / 2) * sin;
    const halfD = (cw / 2) * sin + (cd / 2) * cos;
    w.addBox(x - halfW, z - halfD, x + halfW, z + halfD, ch);
    w.solids.push(m);
  }

  function fireBarrel(g, w, x, z) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 10), rustFor(x, z));
    drum.userData.tint = tintAt(x, z, 2, 0.16);
    drum.position.set(x, 0.52, z);
    drum.castShadow = true;
    g.add(drum);
    w.addBox(x - 0.45, z - 0.45, x + 0.45, z + 0.45, 1.05);

    const light = new THREE.PointLight(0xff7a26, 2.4, 14, 2);
    light.position.set(x, 1.5, z);
    g.add(light);

    const flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.particleSprite('#ffb04a'), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.9,
    }));
    flame.scale.set(1.1, 1.6, 1);
    flame.position.set(x, 1.35, z);
    g.add(flame);

    return { light, flame, base: 2.4, phase: Math.random() * 10 };
  }

  function rubblePile(g, x, z, conc, scale = 1) {
    const geo = new THREE.IcosahedronGeometry(randRange(0.5, 1.1) * scale, 0);
    const m = new THREE.Mesh(geo, conc);
    m.userData.tint = tintAt(x, z, 10, 0.2);
    m.position.set(x, randRange(0.05, 0.3) * scale, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.y = randRange(0.35, 0.7);
    m.receiveShadow = m.castShadow = true;
    g.add(m);
  }
}
