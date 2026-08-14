import * as THREE from 'three';
import { randRange } from './world.js';
import { audio } from './audio.js';

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
};

/**
 * Which objective a wave brings, if any. Wave 1 is left clean so the first
 * contact is about learning to shoot; warlord waves get an evac instead, run
 * once the elite is down.
 */
export function objectiveForWave(wave) {
  if (wave < 2 || wave % 5 === 0) return null;
  return wave % 3 === 0 ? 'hold' : 'cache';
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

  reset() {
    this.active = null;
    this.group.visible = false;
    for (const p of Object.values(this.props)) p.visible = false;
  }

  /** Start the objective a wave calls for, unless one is already running. */
  startForWave(wave) {
    if (this.active) return null;
    const kind = objectiveForWave(wave);
    return kind ? this.start(kind) : null;
  }

  start(kind) {
    const def = OBJECTIVES[kind];
    if (!def || this.active) return null;
    const site = this.findSite(def);
    if (!site) return null;                 // no room on this seed: skip it

    const g = this.game;
    const p = g.player.position;
    this.active = {
      kind, def, x: site.x, y: site.y, z: site.z,
      // seeded rather than left blank: the HUD reads this before the first
      // update lands, and a run always starts with a real bearing
      progress: 0, dist: Math.hypot(p.x - site.x, p.z - site.z), inside: false, ticked: 0,
      startedAt: g.time, expiresAt: g.time + def.limit, nextCall: 0,
    };

    this.group.position.set(site.x, site.y, site.z);
    this.group.visible = true;
    this.ring.scale.set(def.radius, def.radius, 1);
    this.column.scale.set(def.column, 1, def.column);
    this.ringMat.color.setHex(def.colour);
    this.columnMat.color.setHex(def.colour);
    this.glowMat.color.setHex(def.colour);
    for (const [k, p] of Object.entries(this.props)) p.visible = k === kind;

    audio.objectiveStart();
    g.hud.banner(def.label, def.brief);
    return this.active;
  }

  /**
   * Open street-level ground a long way off. Rooftops are excluded on
   * purpose: an objective you can only reach by finding the one staircase
   * that serves it is a search, not a run.
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
        if (w.groundHeight(x, z, 1.4, 99) > 0.35) continue;      // street level only
        if (w.occupied(x, z, def.radius * 0.8, 0.6)) continue;   // room to stand and fight
        return { x, y: 0, z };
      }
    }
    return null;
  }

  update(dt) {
    const a = this.active;
    if (!a) return;
    const g = this.game;
    const p = g.player.position;

    a.dist = Math.hypot(p.x - a.x, p.z - a.z);
    // the height test is what stops a rooftop directly above the site from
    // counting as standing on it
    a.inside = a.dist < a.def.radius && Math.abs(g.player.feetY - a.y) < 3 && !g.player.dead;

    if (a.inside) {
      a.progress = Math.min(a.def.channel, a.progress + dt);
      // a beacon transmits: working it brings the sector down on you
      if (a.def.draws && g.time >= a.nextCall) {
        a.nextCall = g.time + 4;
        g.alertNearby(a.def.draws);
      }
      const quarter = Math.floor((a.progress / a.def.channel) * 4);
      if (quarter > a.ticked) { a.ticked = quarter; audio.objectiveTick(); }
      if (a.progress >= a.def.channel) { this.finish(true); return; }
    } else if (a.progress > 0) {
      a.progress = Math.max(0, a.progress - dt * a.def.decay);
      a.ticked = Math.floor((a.progress / a.def.channel) * 4);
    }

    if (g.time >= a.expiresAt) { this.finish(false); return; }
    this.animate();
  }

  finish(secured) {
    const a = this.active;
    this.active = null;
    this.group.visible = false;
    for (const p of Object.values(this.props)) p.visible = false;
    if (secured) this.game.onObjectiveSecured(a);
    else this.game.onObjectiveLost(a);
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
    prop.rotation.y = t * 0.6;
    prop.position.y = Math.sin(t * 1.7) * 0.05;
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
