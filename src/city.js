import * as THREE from 'three';
import { World, randRange, pick } from './world.js';
import * as TEX from './textures.js';

const BLOCK = 34;      // centre-to-centre distance between city lots
const GRID = 6;        // lots per axis
const LOT = 22;        // buildable footprint inside a lot (street = BLOCK - LOT)
const HALF = (GRID - 1) / 2;

const lotCenter = (i) => (i - HALF) * BLOCK;

/** Box geometry whose UVs are scaled per face so textures keep a constant world size. */
function boxGeo(w, h, d, texelSize = 4) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const scales = [
    [d / texelSize, h / texelSize], [d / texelSize, h / texelSize], // +x, -x
    [w / texelSize, d / texelSize], [w / texelSize, d / texelSize], // +y, -y
    [w / texelSize, h / texelSize], [w / texelSize, h / texelSize], // +z, -z
  ];
  for (let face = 0; face < 6; face++) {
    const [su, sv] = scales[face];
    for (let v = 0; v < 4; v++) {
      const idx = face * 4 + v;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

export function buildCity(scene) {
  const world = new World();
  world.bounds = (GRID * BLOCK) / 2 - 2;

  const group = new THREE.Group();
  scene.add(group);

  const facades = [0, 1, 2, 3, 4].map((s) => new THREE.MeshLambertMaterial({ map: TEX.facade(s, 0) }));
  const concreteMat = new THREE.MeshLambertMaterial({ map: TEX.concrete() });
  const darkConcrete = new THREE.MeshLambertMaterial({ map: TEX.concrete('#565459') });
  const rustMat = new THREE.MeshLambertMaterial({ map: TEX.rustMetal() });
  const metalMat = new THREE.MeshLambertMaterial({ color: 0x4a4e54 });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x27313a });

  // ---------------------------------------------------------------- ground
  const groundSize = GRID * BLOCK + 120;
  const asphaltMat = new THREE.MeshLambertMaterial({ map: TEX.asphalt() });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), asphaltMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);
  world.solids.push(ground);   // so bullets that miss still kick up dust

  // sidewalks: a raised concrete apron around every lot
  const walkMat = concreteMat;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const walk = new THREE.Mesh(boxGeo(LOT + 6, 0.28, LOT + 6, 3), walkMat);
      walk.position.set(lotCenter(i), 0.14, lotCenter(j));
      walk.receiveShadow = true;
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
        buildPlaza(group, world, cx, cz, darkConcrete, rustMat, metalMat);
        continue;
      }

      const roll = Math.random();
      if (roll < 0.16) {
        buildRubbleLot(group, world, cx, cz, darkConcrete, rustMat);
      } else if (roll < 0.28) {
        buildLowRuin(group, world, cx, cz, facades, darkConcrete, rustMat);
      } else {
        buildTower(group, world, cx, cz, facades, concreteMat, metalMat, glassMat, rustMat);
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
        wreckedCar(group, world, cx + along, cz + half + randRange(2, 5), Math.random() < 0.5 ? 0 : Math.PI, metalMat, rustMat, glassMat);
      }
      if (Math.random() < 0.6) {
        const along = randRange(-LOT / 2, LOT / 2);
        wreckedCar(group, world, cx + half + randRange(2, 5), cz + along, Math.PI / 2 + randRange(-0.35, 0.35), metalMat, rustMat, glassMat);
      }
      // barricades and containers block some intersections
      if (Math.random() < 0.30) {
        barricade(group, world, cx + half + randRange(-3, 3), cz + half + randRange(-3, 3), Math.random() * Math.PI, darkConcrete);
      }
      if (Math.random() < 0.16) {
        container(group, world, cx + half + randRange(-2, 2), cz + half + randRange(-2, 2), Math.random() < 0.5 ? 0 : Math.PI / 2, rustMat);
      }
      if (Math.random() < 0.35) {
        const b = fireBarrel(group, world, cx + half + randRange(-4, 4), cz + half + randRange(-4, 4), rustMat);
        fireBarrels.push(b);
      }
      rubblePile(group, cx + randRange(-half, half), cz + half + randRange(1, 5), darkConcrete);
    }
  }

  // ---------------------------------------------------- perimeter blockade
  const edge = (GRID * BLOCK) / 2;
  for (const [ax, az, rot] of [[0, -edge, 0], [0, edge, 0], [-edge, 0, Math.PI / 2], [edge, 0, Math.PI / 2]]) {
    const len = GRID * BLOCK + 20;
    const wall = new THREE.Mesh(boxGeo(rot === 0 ? len : 4, 9, rot === 0 ? 4 : len), darkConcrete);
    wall.position.set(ax, 4.5, az);
    wall.castShadow = wall.receiveShadow = true;
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

  return { world, group, fireBarrels };

  // ------------------------------------------------------------- builders
  function buildTower(g, w, cx, cz, facadeMats, conc, metal, glass, rust) {
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
      const body = new THREE.Mesh(boxGeo(bw, h, bd), mat);
      body.position.set(x, h / 2, z);
      body.castShadow = body.receiveShadow = true;
      g.add(body);
      w.addSolid(body, bw / 2, bd / 2, h);

      // parapet
      const cap = new THREE.Mesh(boxGeo(bw + 0.6, 0.8, bd + 0.6, 3), conc);
      cap.position.set(x, h + 0.4, z);
      cap.castShadow = true;
      g.add(cap);

      // rooftop clutter
      if (h > 14) {
        for (let k = 0; k < 2 + (Math.random() * 3 | 0); k++) {
          const uw = randRange(1.2, 2.8), uh = randRange(0.8, 2.2);
          const unit = new THREE.Mesh(boxGeo(uw, uh, uw, 2), metal);
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
      const band = new THREE.Mesh(boxGeo(bw + 0.1, 2.6, bd + 0.1, 3), glass);
      band.position.set(x, 1.6, z);
      g.add(band);
      const shut = new THREE.Mesh(boxGeo(bw * 0.4, 2.4, 0.2, 2), rust);
      shut.position.set(x + randRange(-bw / 4, bw / 4), 1.4, z + bd / 2 + 0.12);
      g.add(shut);
    }
  }

  function buildLowRuin(g, w, cx, cz, facadeMats, conc, rust) {
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
      const m = new THREE.Mesh(boxGeo(wgt, hh, dgt), mat);
      m.position.set(cx + ox + (bw > bd ? randRange(-2, 2) : 0), hh / 2, cz + oz + (bd > bw ? randRange(-2, 2) : 0));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      w.addSolid(m, wgt / 2, dgt / 2, hh);
    }
    // floor slab + interior rubble
    const slab = new THREE.Mesh(boxGeo(LOT - 2, 0.3, LOT - 2, 4), conc);
    slab.position.set(cx, 0.3, cz);
    slab.receiveShadow = true;
    g.add(slab);
    for (let k = 0; k < 5; k++) rubblePile(g, cx + randRange(-8, 8), cz + randRange(-8, 8), conc);
    if (Math.random() < 0.5) container(g, w, cx + randRange(-6, 6), cz + randRange(-6, 6), Math.random() * Math.PI, rust);
  }

  function buildRubbleLot(g, w, cx, cz, conc, rust) {
    const slab = new THREE.Mesh(boxGeo(LOT, 0.2, LOT, 4), conc);
    slab.position.set(cx, 0.25, cz);
    slab.receiveShadow = true;
    g.add(slab);
    for (let k = 0; k < 14; k++) {
      rubblePile(g, cx + randRange(-9, 9), cz + randRange(-9, 9), conc, randRange(0.7, 1.9));
    }
    // leaning slabs of collapsed floor
    for (let k = 0; k < 3; k++) {
      const sw = randRange(3, 7), sh = randRange(2.5, 5);
      const m = new THREE.Mesh(boxGeo(sw, 0.4, sh, 4), conc);
      m.position.set(cx + randRange(-7, 7), randRange(0.8, 2), cz + randRange(-7, 7));
      m.rotation.set(randRange(-0.9, 0.9), Math.random() * Math.PI, randRange(-0.9, 0.9));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      w.solids.push(m);
    }
    if (Math.random() < 0.6) container(g, w, cx + randRange(-7, 7), cz + randRange(-7, 7), Math.random() * Math.PI, rust);
  }

  function buildPlaza(g, w, cx, cz, conc, rust, metal) {
    const slab = new THREE.Mesh(boxGeo(LOT + 4, 0.3, LOT + 4, 4), conc);
    slab.position.set(cx, 0.15, cz);
    slab.receiveShadow = true;
    g.add(slab);

    // dry fountain in the middle: cover to fight from
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 1, 16, 1, true), conc);
    ring.position.set(cx, 0.5, cz);
    ring.material = conc;
    ring.castShadow = ring.receiveShadow = true;
    g.add(ring);
    w.addBox(cx - 3.4, cz - 3.4, cx + 3.4, cz + 3.4, 1);
    w.solids.push(ring);

    const plinth = new THREE.Mesh(boxGeo(1.4, 2.2, 1.4, 2), conc);
    plinth.position.set(cx, 1.1, cz);
    plinth.castShadow = true;
    g.add(plinth);

    // sandbagged firing positions around the plaza
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      barricade(g, w, cx + Math.cos(a) * 8, cz + Math.sin(a) * 8, a, conc);
    }
    for (let k = 0; k < 3; k++) container(g, w, cx + randRange(-9, 9), cz + randRange(-9, 9), Math.random() * Math.PI, rust);
  }

  function streetlight(g, w, x, z, metal) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 7, 6), metal);
    pole.position.set(x, 3.5, z);
    pole.castShadow = true;
    g.add(pole);
    const arm = new THREE.Mesh(boxGeo(1.8, 0.16, 0.16, 2), metal);
    arm.position.set(x + 0.9, 6.9, z);
    g.add(arm);
    const head = new THREE.Mesh(boxGeo(0.9, 0.22, 0.4, 2), metal);
    head.position.set(x + 1.7, 6.78, z);
    g.add(head);
    w.addBox(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 7);
  }

  function wreckedCar(g, w, x, z, rot, metal, rust, glass) {
    const car = new THREE.Group();
    const bodyMat = Math.random() < 0.5 ? rust : new THREE.MeshLambertMaterial({ color: pick([0x4a4f55, 0x6b3a32, 0x3b4a3c, 0x5a5a52, 0x2f3338]) });
    const bw = 1.9, bl = 4.4;

    const chassis = new THREE.Mesh(boxGeo(bw, 0.75, bl, 2), bodyMat);
    chassis.position.y = 0.75;
    chassis.castShadow = chassis.receiveShadow = true;
    car.add(chassis);

    const cabin = new THREE.Mesh(boxGeo(bw - 0.25, 0.75, bl * 0.45, 2), glass);
    cabin.position.set(0, 1.5, -0.2);
    cabin.castShadow = true;
    car.add(cabin);

    const hood = new THREE.Mesh(boxGeo(bw - 0.1, 0.35, bl * 0.3, 2), bodyMat);
    hood.position.set(0, 1.25, bl * 0.32);
    car.add(hood);

    // burnt-out cars lose their wheels and sit on the rims
    const burnt = Math.random() < 0.4;
    if (!burnt) {
      const tire = new THREE.MeshLambertMaterial({ color: 0x17181a });
      for (const [wx, wz] of [[-bw / 2, bl / 3], [bw / 2, bl / 3], [-bw / 2, -bl / 3], [bw / 2, -bl / 3]]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 10), tire);
        t.rotation.z = Math.PI / 2;
        t.position.set(wx, 0.42, wz);
        car.add(t);
      }
    } else {
      chassis.material = new THREE.MeshLambertMaterial({ color: 0x1d1c1b });
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
      const m = new THREE.Mesh(boxGeo(2.2, 1.05, 0.7, 2), conc);
      const off = (k - (n - 1) / 2) * 2.3;
      m.position.set(x + Math.cos(rot) * off, 0.55, z + Math.sin(rot) * off);
      m.rotation.y = rot + Math.PI / 2 + randRange(-0.08, 0.08);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      w.solids.push(m);
      const px = m.position.x, pz = m.position.z;
      w.addBox(px - 1.1, pz - 1.1, px + 1.1, pz + 1.1, 1.05);
    }
  }

  function container(g, w, x, z, rot, rust) {
    const cw = 2.5, ch = 2.6, cd = 6.0;
    const m = new THREE.Mesh(boxGeo(cw, ch, cd, 3), rust);
    m.position.set(x, ch / 2, z);
    m.rotation.y = rot;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const halfW = (cw / 2) * cos + (cd / 2) * sin;
    const halfD = (cw / 2) * sin + (cd / 2) * cos;
    w.addBox(x - halfW, z - halfD, x + halfW, z + halfD, ch);
    w.solids.push(m);
  }

  function fireBarrel(g, w, x, z, rust) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.05, 10), rust);
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
    m.position.set(x, randRange(0.05, 0.3) * scale, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.y = randRange(0.35, 0.7);
    m.receiveShadow = m.castShadow = true;
    g.add(m);
  }
}
