import * as THREE from 'three';
import { randRange, SUPPORT_RADIUS } from './world.js';
import { audio } from './audio.js';
import { reserve } from './rng.js';
import { NavGrid } from './nav.js';
import { objectiveFor } from './story.js';
import { Enemy } from './enemies.js';

/**
 * Objectives: a reason to leave the plaza.
 *
 * The map is 200 m of city, but wave survival on its own rewards standing
 * still in the best piece of cover you can find. An objective puts something
 * worth having at the other end of that city and starts a clock, so the
 * question stops being "where do I hold" and becomes "can I get there and
 * back".
 *
 * Each one is the same shape: a site on open ground, a channel you have to
 * stand in the middle of, and a deadline. What differs is how far away it is,
 * how long you are pinned there, and what it pays.
 */

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const MAT = new THREE.Matrix4();

/**
 * `channel` is seconds spent inside the site; `decay` is how fast that bleeds
 * back when you step out, so being driven off costs ground without wiping the
 * work. `draws` is a radius of hostiles the site pulls in while you are on it.
 */
export const OBJECTIVES = {
  cache: {
    label: 'SUPPLY CACHE', brief: 'STRIP THE CACHE', verb: 'STRIPPING',
    colour: 0xffd23f, radius: 2.8, column: 0.9, channel: 4, decay: 1.2,
    limit: 55, minD: 42, maxD: 80,
  },
  hold: {
    label: 'BEACON', brief: 'HOLD THE BEACON', verb: 'HOLDING',
    colour: 0x4fd2ff, radius: 6.5, column: 2.6, channel: 18, decay: 0.4,
    limit: 80, minD: 38, maxD: 74, draws: 55,
  },
  extraction: {
    label: 'EVAC POINT', brief: 'REACH THE EVAC POINT', verb: 'BOARDING',
    colour: 0x7ad06a, radius: 3.4, column: 1.4, channel: 2, decay: 2,
    limit: 65, minD: 55, maxD: 105,
  },
  // up a stairwell onto a roof, and held while the Cinder come up after you
  relay: {
    label: 'RELAY MAST', brief: 'RESTORE THE RELAY', verb: 'HANDSHAKING',
    colour: 0xb48cff, radius: 3.4, column: 1.2, channel: 20, decay: 0.5,
    limit: 120, minD: 25, maxD: 120, draws: 60,
  },
  // a charge planted on a burning drum, then kept from them for `fuse` seconds
  sabotage: {
    label: 'FUEL DUMP', brief: 'MINE THE DUMP', verb: 'PLANTING',
    colour: 0xff7a2f, radius: 2.4, column: 1.0, channel: 3.5, decay: 1.5,
    limit: 75, minD: 30, maxD: 90, fuse: 18, defuse: 1.8, standOff: 6,
  },
  // a marked hostile crossing the sector to its far side with an escort
  hunt: {
    label: 'LIEUTENANT', brief: 'KILL THE LIEUTENANT', verb: '',
    colour: 0xff3b2f, radius: 1.6, column: 0.7, channel: 1, decay: 1,
    limit: 140, minD: 40, maxD: 75, cross: 70,
  },
  // a survivor pinned in a shop, cut loose and walked to a pickup
  rescue: {
    label: 'HOLDOUT', brief: 'REACH THE HOLDOUT', verb: 'CUTTING FREE',
    colour: 0x9cf0c0, radius: 2.4, column: 1.0, channel: 2.5, decay: 1.5,
    limit: 90, minD: 30, maxD: 95, escort: 120, pickup: 4,
  },
  // the finale: the depot held while the convoy loads
  convoy: {
    label: 'DEPOT', brief: 'HOLD THE DEPOT', verb: 'LOADING',
    colour: 0x7ad06a, radius: 7, column: 2.8, channel: 40, decay: 0.3,
    limit: 150, minD: 45, maxD: 95, draws: 70,
  },
};

/**
 * Which objective a wave brings, if any: the operation's plan (`objectiveFor`
 * in `story.js`), kept under this name for anything that asks here.
 */
export function objectiveForWave(wave, complete = false) {
  return objectiveFor(wave, complete);
}

export const cssColour = (n) => '#' + n.toString(16).padStart(6, '0');

export class ObjectiveSystem {
  constructor(scene, game) {
    this.game = game;
    this.active = null;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.buildMarker();
    this.buildStoryProps();
  }

  /**
   * One marker, restyled per objective: a ground ring the size of the site, a
   * light column that reads over rooftops, and a prop to shoot toward. All
   * three are built once and recoloured, so starting an objective allocates
   * nothing.
   */
  buildMarker() {
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
      depthWrite: false, fog: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 56), this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    this.ring = ring;
    this.group.add(ring);

    // open-ended cylinder, additive and depth-tested: the beam is hidden by
    // the block in front of it and shows over the top, which is what makes it
    // usable as a bearing rather than a decal
    this.columnMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 18, 20, 1, true), this.columnMat);
    column.position.y = 9;
    this.column = column;
    this.group.add(column);

    this.propMat = new THREE.MeshLambertMaterial({ color: 0x6a6c60 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });

    const crate = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.72, 0.8), this.propMat);
    box.position.y = 0.36;
    box.castShadow = true;
    crate.add(box);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.1, 0.86), this.glowMat);
    lid.position.y = 0.76;
    crate.add(lid);

    const beacon = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.7, 8), this.propMat);
    pole.position.y = 0.85;
    pole.castShadow = true;
    beacon.add(pole);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), this.glowMat);
    lamp.position.y = 1.85;
    beacon.add(lamp);

    const mast = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 3.1, 8), this.propMat);
    post.position.y = 1.55;
    post.castShadow = true;
    mast.add(post);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.12), this.glowMat);
    panel.position.y = 2.4;
    mast.add(panel);

    this.props = { cache: crate, hold: beacon, extraction: mast };
    for (const p of Object.values(this.props)) {
      p.visible = false;
      this.group.add(p);
    }
  }

  /**
   * The props the newer objectives show, built inside a `reserve`: the
   * marker is built after the city, where the stream is picking spawns, and
   * the original three cost it what they always did.
   */
  buildStoryProps() {
    reserve(() => {
      const relay = new THREE.Group();
      for (const a of [0, 2.1, 4.2]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 6), this.propMat);
        leg.position.set(Math.cos(a) * 0.45, 1.0, Math.sin(a) * 0.45);
        leg.rotation.set(Math.sin(a) * 0.22, 0, -Math.cos(a) * 0.22);
        relay.add(leg);
      }
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.4, 8), this.propMat);
      head.position.y = 2.6;
      relay.add(head);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 6, 0, Math.PI * 2, 0, 0.9), this.propMat);
      dish.position.y = 2.9;
      dish.rotation.x = Math.PI / 2.4;
      relay.add(dish);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), this.glowMat);
      tip.position.y = 3.35;
      relay.add(tip);

      const charge = new THREE.Group();
      const brick = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.22), this.propMat);
      brick.position.y = 1.05;
      charge.add(brick);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), this.glowMat);
      lamp.position.set(0.1, 1.17, 0.06);
      charge.add(lamp);

      const depot = new THREE.Group();
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 3.4, 8), this.propMat);
        post.position.set(s * 1.6, 1.7, 0);
        depot.add(post);
      }
      const sign = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.5, 0.1), this.glowMat);
      sign.position.y = 3.3;
      depot.add(sign);

      Object.assign(this.props, { relay, charge, convoy: depot, sabotage: new THREE.Group(), hunt: new THREE.Group(), rescue: new THREE.Group() });
      for (const k of ['relay', 'charge', 'convoy', 'sabotage', 'hunt', 'rescue']) {
        this.props[k].visible = false;
        this.group.add(this.props[k]);
      }
    });
  }

  reset() {
    if (this.active) this.release(this.active, false);
    this.active = null;
    this.rescues = 0;
    this.group.visible = false;
    for (const p of Object.values(this.props)) p.visible = false;
  }

  /** Start the objective a wave calls for, unless one is already running. */
  startForWave(wave) {
    if (this.active) return null;
    const kind = objectiveForWave(wave, this.game.op?.complete);
    return kind ? this.start(kind) : null;
  }

  start(kind, instead = null) {
    const def = OBJECTIVES[kind];
    if (!def || this.active) return null;
    const site = this.siteFor(kind, def);
    // A relay needs a stairwell in reach, a rescue a shop, a hunt a route
    // across the sector; a seed short of one gets a beacon instead, rather
    // than a wave with nothing to do.
    if (!site) return kind === 'hold' ? null : this.start('hold', kind);

    const g = this.game;
    const p = g.player.position;
    this.active = {
      kind, def, x: site.x, y: site.y, z: site.z,
      // seeded rather than left blank: the HUD reads this before the first
      // update lands, and a run always starts with a real bearing
      progress: 0, dist: Math.hypot(p.x - site.x, p.z - site.z), inside: false, ticked: 0,
      startedAt: g.time, expiresAt: g.time + def.limit, nextCall: 0,
      stage: 'go', label: null, note: null, fill: null,
      exit: site.exit || null, target: null,
      instead,                          // what was asked for, when this is the beacon in its place
      upstairs: !!site.floor,           // on a floor of a building, up its stair
    };
    const a = this.active;

    this.group.position.set(site.x, site.y, site.z);
    this.group.visible = true;
    this.ring.scale.set(def.radius, def.radius, 1);
    this.column.scale.set(def.column, 1, def.column);
    this.ringMat.color.setHex(def.colour);
    this.columnMat.color.setHex(def.colour);
    this.glowMat.color.setHex(def.colour);
    for (const [k, prop] of Object.entries(this.props)) prop.visible = k === kind;

    if (kind === 'hunt') this.spawnHunt(a, site);
    if (kind === 'rescue') this.spawnHoldout(a, site);

    audio.objectiveStart();
    g.hud.banner(def.label, def.brief);
    g.onObjectiveStart?.(a);
    return a;
  }

  // ------------------------------------------------------------------ sites
  siteFor(kind, def) {
    if (kind === 'relay') return this.roofSite(def);
    if (kind === 'sabotage') return this.dumpSite(def) || this.findSite(def);
    if (kind === 'rescue') {
      // every other holdout has gone to ground upstairs, where there is one
      const up = (this.rescues = (this.rescues || 0) + 1) % 2 === 0;
      return (up && this.floorSite(def)) || this.shopSite(def);
    }
    if (kind === 'hunt') return this.routeSite(def);
    return this.findSite(def);
  }

  /**
   * Open street-level ground a long way off. Rooftops are excluded on
   * purpose: an objective you can only reach by finding the one staircase
   * that serves it is a search, not a run. The relay is the exception, and
   * it is sited by `roofSite` on a roof whose stairwell door is what the
   * radio sends you to find.
   */
  findSite(def) {
    const w = this.game.world;
    const p = this.game.player.position;
    const lim = w.bounds - 6;
    // Later passes widen the band rather than giving up. The preferred ring
    // can genuinely have nowhere to stand — a dense seed, or a player backed
    // into a corner of the map, where most of that ring is outside the walls.
    const bands = [[def.minD, def.maxD], [def.minD * 0.55, def.maxD * 1.3], [16, w.bounds * 1.6]];
    for (const [lo, hi] of bands) {
      for (let i = 0; i < 90; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = randRange(lo, hi);
        const x = p.x + Math.cos(a) * d;
        const z = p.z + Math.sin(a) * d;
        if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
        // Street level only, measured from the floor underfoot: most of the
        // sector is pavement, which is a floor and not a rooftop.
        const floor = w.groundHeight(x, z, SUPPORT_RADIUS, 0.5);
        if (w.groundHeight(x, z, 1.4, 99) > floor + 0.35) continue;
        if (w.occupied(x, z, def.radius * 0.8, 0.6)) continue;   // room to stand and fight
        return { x, y: floor, z };
      }
    }
    return null;
  }
  /** In the distance band from the player, first by a shuffled order. */
  _inBand(list, def, at) {
    const p = this.game.player.position;
    const ok = list.filter((o) => { const d = Math.hypot(at(o).x - p.x, at(o).z - p.z); return d >= def.minD && d <= def.maxD; });
    if (!ok.length) return null;
    return ok[Math.floor(Math.random() * ok.length)];
  }

  /** A stair roof in reach, on its open deck clear of the bulkhead and the plant. */
  roofSite(def) {
    const w = this.game.world;
    const s = this._inBand(w.stairs, def, (s) => ({ x: (s.roof.minX + s.roof.maxX) / 2, z: (s.roof.minZ + s.roof.maxZ) / 2 }));
    if (!s) return null;
    const cx = (s.roof.minX + s.roof.maxX) / 2, cz = (s.roof.minZ + s.roof.maxZ) / 2;
    const qx = (s.roof.maxX - s.roof.minX) / 4, qz = (s.roof.maxZ - s.roof.minZ) / 4;
    for (const [ox, oz] of [[0, 0], [qx, qz], [-qx, qz], [qx, -qz], [-qx, -qz], [qx, 0], [-qx, 0], [0, qz], [0, -qz]]) {
      const x = cx + ox, z = cz + oz, q = s.shaft;
      if (x > q.minX - 1.2 && x < q.maxX + 1.2 && z > q.minZ - 1.2 && z < q.maxZ + 1.2) continue;
      if (w.blocked(x, z, 1.0, s.deck + 0.9)) continue;
      return { x, y: s.deck, z, stair: s };
    }
    return null;
  }

  /** A burning drum: the Cinder keep their fuel where they keep their fires. */
  dumpSite(def) {
    const g = this.game, w = g.world;
    const b = this._inBand(g.fireBarrels || [], def, (b) => b.flame.position);
    if (!b) return null;
    const { x, z } = b.flame.position;
    return { x, y: w.groundHeight(x, z, SUPPORT_RADIUS, 0.6), z };
  }

  /** The back of a shop: somewhere a holdout would have gone to ground. */
  shopSite(def) {
    const g = this.game, w = g.world;
    const room = this._inBand(w.rooms, def, (r) => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 }));
    if (!room) return null;
    const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
    const d = room.doors[0];
    for (const t of [0.35, 0.2, 0.5, 0]) {
      const x = cx - d.nx * (room.maxX - room.minX) * t, z = cz - d.nz * (room.maxZ - room.minZ) * t;
      if (w.blocked(x, z, 0.6, room.floor + 0.9) || g.nav.solidAt(x, z)) continue;
      if (room.stair) {
        const q = room.stair.shaft;
        if (x > q.minX - 1 && x < q.maxX + 1 && z > q.minZ - 1 && z < q.maxZ + 1) continue;
      }
      return { x, y: room.floor, z, room };
    }
    return null;
  }

  /**
   * A floor up a stairwell, away from its door: further to go and a stair
   * to find, and a walk back down with them. A holdout has no avoidance, so
   * a spot is only taken if the walk to the landing door — the way a body
   * crosses a floor, round the shaft by its corners (`Enemy._floorWay`) —
   * runs clear of the furniture all the way.
   */
  floorSite(def) {
    const g = this.game, w = g.world;
    const floors = w.floors.filter((f) => f.stair);
    const rec = this._inBand(floors, def, (r) => ({ x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 }));
    if (!rec) return null;
    const s = rec.stair, F = rec.floor;
    const floor = s.floors.find((f) => Math.abs(f.y - F) < 0.01);
    if (!floor) return null;
    const cx = (rec.minX + rec.maxX) / 2, cz = (rec.minZ + rec.maxZ) / 2, d = rec.doors[0], q = s.shaft;
    for (const t of [0.35, 0.2, 0.5, 0.1, 0.42]) {
      for (const side of [0, 0.25, -0.25]) {
        const x = cx - d.nx * (rec.maxX - rec.minX) * t + d.nz * (rec.maxX - rec.minX) * side;
        const z = cz - d.nz * (rec.maxZ - rec.minZ) * t + d.nx * (rec.maxZ - rec.minZ) * side;
        if (x > q.minX - 1.2 && x < q.maxX + 1.2 && z > q.minZ - 1.2 && z < q.maxZ + 1.2) continue;
        if (Math.abs(w.groundHeight(x, z, SUPPORT_RADIUS, F + 0.5) - F) > 0.05) continue;
        if (w.blocked(x, z, 0.6, F + 0.9) || !this._walksOut(x, z, s, floor)) continue;
        return { x, y: F, z, room: rec, floor };
      }
    }
    return null;
  }

  /** Whether a body walking a floor the hostiles' way reaches its door unblocked. */
  _walksOut(x, z, s, floor) {
    const w = this.game.world, body = { pos: { x, z }, radius: 0.45 };
    for (let i = 0; i < 240; i++) {
      if (Math.hypot(floor.door.x - body.pos.x, floor.door.z - body.pos.z) < 0.6) return true;
      Enemy.prototype._floorWay.call(body, V1, floor.door.x, floor.door.z, s, floor, w);
      body.pos.x += V1.x * 0.2; body.pos.z += V1.z * 0.2;
      if (w.blocked(body.pos.x, body.pos.z, body.radius, floor.y + 0.9)) return false;
    }
    return false;
  }

  /** Where a lieutenant comes in, and the far side of the sector he is making for. */
  routeSite(def) {
    const from = this.findSite(def);
    if (!from) return null;
    const w = this.game.world, lim = w.bounds - 8;
    const p = this.game.player.position;
    let best = null, bd = 0;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, r = lim * (0.75 + (i % 3) * 0.1);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const d = Math.hypot(x - from.x, z - from.z);
      if (d < def.cross || Math.hypot(x - p.x, z - p.z) < 30) continue;
      const floor = w.groundHeight(x, z, SUPPORT_RADIUS, 0.5);
      if (floor > 0.5 || w.blocked(x, z, 0.8, floor + 0.9) || this.game.nav.solidAt(x, z)) continue;
      if (d > bd) { bd = d; best = { x, z }; }
    }
    if (!best) return null;
    return { ...from, exit: best };
  }

  // -------------------------------------------------------------- the cast
  /** A lieutenant, marked, with an escort, walking the route field to his exit. */
  spawnHunt(a, site) {
    const g = this.game;
    if (!this.huntNav) this.huntNav = new NavGrid(g.world);
    this.huntNav.update(a.exit.x, a.exit.z, true);
    const lt = g.spawnEnemy('raider');
    this.place(lt, site.x, site.z);
    lt.lieutenant = true;
    lt.flee = { nav: this.huntNav, exit: a.exit };
    lt.hp = lt.maxHp = Math.round(lt.maxHp * 3.2);
    lt.parts.band?.material.color.setHex(0xff3b2f);
    lt.alerted = true;
    a.target = lt;
    a.from = Math.hypot(a.exit.x - site.x, a.exit.z - site.z);
    for (const [k, type] of [[0, 'raider'], [1, 'raider'], [2, 'scavenger']]) {
      const e = g.spawnEnemy(type);
      const ang = k * 2.1;
      this.place(e, site.x + Math.cos(ang) * 2, site.z + Math.sin(ang) * 2);
      e.escort = lt;
    }
  }

  /** A holdout where they went to ground, waiting to be cut loose. */
  spawnHoldout(a, site) {
    const h = this.game.spawnEnemy('holdout');
    this.place(h, site.x, site.z, site.y);
    h.following = false;
    // up a floor, it is already on the stair's floor branch, and comes down
    // it the way a hostile does when the player leaves the floor
    if (site.floor) {
      h.stair = site.floor.stair;
      h.onFloor = site.floor;
      h.floorStep = 'on';
    }
    a.target = h;
  }

  place(e, x, z, y = 0) {
    const w = this.game.world;
    e.pos.set(x, w.groundHeight(x, z, SUPPORT_RADIUS, y + 0.6), z);
    e.group.position.copy(e.pos);
    e.markWatchdog(this.game.player);
  }

  /** Take a lieutenant who got away, or a holdout who got out, off the map. */
  remove(e) {
    if (!e || !e.alive) return;
    e.alive = false;
    e.state = 'dead';
    e.deathT = 99;
    e.group.visible = false;
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    const a = this.active;
    if (!a) return;
    const g = this.game;
    const p = g.player.position;

    if (a.kind === 'hunt') { this.updateHunt(a); if (this.active) this.animate(); return; }
    if (a.kind === 'rescue' && a.stage === 'escort') { this.updateEscort(a, dt); if (this.active) this.animate(); return; }
    if (a.kind === 'sabotage' && a.stage === 'fuse') { this.updateFuse(a); if (this.active) this.animate(); return; }
    if (a.kind === 'rescue') this.drainHoldout(a, dt);
    if (!this.active) return;

    a.dist = Math.hypot(p.x - a.x, p.z - a.z);
    // the height test is what stops a rooftop directly above the site from
    // counting as standing on it; up a building, the floor under it is closer
    a.inside = a.dist < a.def.radius && Math.abs(g.player.feetY - a.y) < (a.upstairs ? 1.2 : 3) && !g.player.dead;

    if (a.inside) {
      a.progress = Math.min(a.def.channel, a.progress + dt);
      // a beacon transmits: working it brings the sector down on you
      if (a.def.draws && g.time >= a.nextCall) {
        a.nextCall = g.time + 4;
        g.alertNearby(a.def.draws);
      }
      const quarter = Math.floor((a.progress / a.def.channel) * 4);
      if (quarter > a.ticked) { a.ticked = quarter; audio.objectiveTick(); }
      if (a.progress >= a.def.channel) {
        if (a.kind === 'sabotage') this.armCharge(a);
        else if (a.kind === 'rescue') this.cutLoose(a);
        else { this.finish(true); return; }
      }
    } else if (a.progress > 0) {
      a.progress = Math.max(0, a.progress - dt * a.def.decay);
      a.ticked = Math.floor((a.progress / a.def.channel) * 4);
    }

    if (g.time >= a.expiresAt) { this.finish(false); return; }
    this.animate();
  }

  /** The charge is live: a fuse to hold, and every hostile near drawn to pull it. */
  armCharge(a) {
    const g = this.game;
    a.stage = 'fuse';
    a.fuseEnd = g.time + a.def.fuse;
    a.expiresAt = a.fuseEnd + 1;
    a.label = 'CHARGE';
    this.props.sabotage.visible = false;
    this.props.charge.visible = true;
    g.lure = { x: a.x, z: a.z };
    g.alertNearby(45);
    g.onObjectiveStage?.(a);
  }

  updateFuse(a) {
    const g = this.game, p = g.player.position;
    a.dist = Math.hypot(p.x - a.x, p.z - a.z);
    const left = a.fuseEnd - g.time;
    a.fill = 1 - left / a.def.fuse;
    a.note = `BLOWS IN ${Math.max(0, Math.ceil(left))} S — KEEP THEM OFF IT`;
    // pulled by a hostile who reaches it with the player standing off
    for (const e of g.enemies) {
      if (!e.alive || e.type.friendly) continue;
      if (Math.hypot(e.pos.x - a.x, e.pos.z - a.z) < a.def.defuse && a.dist > a.def.standOff) {
        a.reason = 'pulled';
        this.finish(false);
        return;
      }
    }
    if (left <= 0) {
      // on top of the drum, where it was planted
      g.explode(new THREE.Vector3(a.x, a.y + 1.1, a.z), 'charge');
      this.finish(true);
    }
  }

  updateHunt(a) {
    const g = this.game, p = g.player.position, lt = a.target;
    if (!lt || !lt.alive) { this.finish(true); return; }
    a.x = lt.pos.x; a.y = lt.pos.y; a.z = lt.pos.z;
    this.group.position.set(a.x, a.y, a.z);
    a.dist = Math.hypot(p.x - a.x, p.z - a.z);
    const left = Math.hypot(a.exit.x - a.x, a.exit.z - a.z);
    a.fill = Math.max(0, 1 - left / a.from);
    a.note = `${a.def.brief} — ${Math.round(a.dist)} M`;
    if (left < 3) { a.reason = 'escaped'; this.finish(false); return; }
    if (g.time >= a.expiresAt) { a.reason = 'escaped'; this.finish(false); }
  }

  /** Cut loose: the holdout follows, and the marker moves to the pickup. */
  cutLoose(a) {
    const g = this.game, h = a.target;
    const pickup = this.findSite({ ...OBJECTIVES.extraction, minD: 35, maxD: 85 });
    if (!pickup || !h || !h.alive) { this.finish(false); return; }
    h.following = true;
    a.stage = 'escort';
    a.label = 'PICKUP';
    a.x = pickup.x; a.y = pickup.y; a.z = pickup.z;
    a.expiresAt = g.time + a.def.escort;
    this.group.position.set(pickup.x, pickup.y, pickup.z);
    this.ring.scale.set(a.def.pickup, a.def.pickup, 1);
    g.onObjectiveStage?.(a);
  }

  /**
   * Hostile fire finds a holdout the way it finds you: anything alerted with
   * a line to them wears them down, faster up close. They are not in the fire
   * loop — no hostile aims at one — so this is how being exposed costs them.
   */
  drainHoldout(a, dt) {
    const g = this.game, h = a.target;
    if (!h || !h.alive) { this.finish(false); return; }
    for (const e of g.enemies) {
      if (!e.alive || e.type.friendly || !e.alerted) continue;
      const d = Math.hypot(e.pos.x - h.pos.x, e.pos.z - h.pos.z);
      if (e.type.melee ? d > 1.8 : d > 25) continue;
      if (!e.type.melee && !g.world.lineOfSight(e.pos.x, e.pos.y + 1.5, e.pos.z, h.pos.x, h.pos.y + 1.2, h.pos.z)) continue;
      h.hp -= (e.type.melee ? 12 : 2.5) * dt;
      h.hurtFlash = 0.08;
    }
    if (h.hp <= 0) { h.die(null); this.finish(false); }
  }

  updateEscort(a, dt) {
    const g = this.game, p = g.player.position, h = a.target;
    this.drainHoldout(a, dt);
    if (!this.active) return;
    a.dist = Math.hypot(p.x - a.x, p.z - a.z);
    a.fill = Math.max(0, h.hp / h.maxHp);
    a.note = `GET THEM TO THE PICKUP — ${Math.round(a.dist)} M`;
    if (Math.hypot(h.pos.x - a.x, h.pos.z - a.z) < a.def.pickup) { this.finish(true); return; }
    if (g.time >= a.expiresAt) this.finish(false);
  }

  finish(secured) {
    const a = this.active;
    this.active = null;
    this.group.visible = false;
    for (const p of Object.values(this.props)) p.visible = false;
    this.release(a, secured);
    if (secured) this.game.onObjectiveSecured(a);
    else this.game.onObjectiveLost(a);
  }

  /** Whatever an objective put on the map, taken back off it. */
  release(a, secured) {
    const g = this.game;
    if (a.kind === 'sabotage') g.lure = null;
    if (a.kind === 'hunt' && !secured) this.remove(a.target);
    if (a.kind === 'rescue' && a.target?.alive) this.remove(a.target);
  }

  /**
   * Deliberately driven off game time rather than a per-frame random, so two
   * runs on the same seed stay identical (see the note in `flickerFires`).
   */
  animate() {
    const a = this.active;
    const t = this.game.time;
    const pulse = 0.5 + Math.sin(t * 2.4) * 0.5;
    const urgent = a.expiresAt - t < 15 ? 0.55 + Math.sin(t * 9) * 0.45 : 1;
    this.ringMat.opacity = (0.45 + pulse * 0.35) * urgent;
    this.columnMat.opacity = (0.10 + pulse * 0.07) * urgent;
    const prop = this.props[a.kind];
    if (a.kind === 'relay' || a.kind === 'convoy') {
      prop.position.y = 0;                 // a mast stands; only the light breathes
    } else {
      prop.rotation.y = t * 0.6;
      prop.position.y = Math.sin(t * 1.7) * 0.05;
    }
    // a live charge blinks faster as it runs down
    if (a.stage === 'fuse') this.props.charge.children[1].visible = (t * (2 + a.fill * 8)) % 1 < 0.5;
  }

  /**
   * Where to draw the waypoint, in pixels. Off-screen sites clamp to the edge
   * of the viewport; sites behind the camera are mirrored through the centre
   * first, so the marker slides to the side you would actually turn toward.
   */
  screenMarker(camera, width, height) {
    const a = this.active;
    if (!a) return null;

    // the test suite steps the game without rendering, so the camera's
    // matrices are not guaranteed current here
    camera.updateMatrixWorld();
    MAT.copy(camera.matrixWorld).invert();

    V1.set(a.x, a.y + 1.8, a.z);
    const behind = V2.copy(V1).applyMatrix4(MAT).z > 0;
    V1.project(camera);

    let x = (V1.x * 0.5 + 0.5) * width;
    let y = (-V1.y * 0.5 + 0.5) * height;
    if (behind) { x = width - x; y = height - y; }

    const margin = 44;
    const offscreen = behind || x < margin || x > width - margin
      || y < margin || y > height - margin;

    if (offscreen) {
      // push the point out along its own bearing from the centre until it
      // lands on the inset border
      const cx = width / 2, cy = height / 2;
      let dx = x - cx, dy = y - cy;
      if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = 1;
      const scale = Math.min(
        (width / 2 - margin) / Math.max(1e-3, Math.abs(dx)),
        (height / 2 - margin) / Math.max(1e-3, Math.abs(dy)));
      x = cx + dx * scale;
      y = cy + dy * scale;
    }
    return { x, y, offscreen, dist: a.dist, colour: cssColour(a.def.colour) };
  }
}
