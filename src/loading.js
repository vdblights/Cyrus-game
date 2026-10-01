/**
 * The loading screen: what is being built, how far along it is, something to
 * read, and a survey of the sector being drawn as it is laid out — which
 * stays on the menu once boot is done, beside the DEPLOY button.
 *
 * Boot is CPU work on the main thread — painting textures, laying out the
 * city, compiling shaders — so nothing on the page can move unless boot
 * yields. `Game.boot` yields between its stages and calls `stage` before each
 * one. Between those yields the page is frozen, which is why everything that
 * moves continuously here (the radar sweep, the shimmer on the bar, the
 * insertion ring) is a CSS transform or opacity animation: the browser runs
 * those on its compositor, and they keep moving through a frozen stretch.
 *
 * Nothing in here may touch `Math.random`. Boot is laying out a seeded city
 * between these calls, and one draw from the stream on the loading screen's
 * behalf would hand the seed a different city. The field notes cycle off the
 * seed and the clock instead.
 */
import { SECTOR } from './city.js';

const NOTES = [
  'Hold Space at a waist-high ledge to haul yourself onto it. Hold it through a jump to reach about two and a half metres.',
  'Marksmen hold the rooftops. A red laser on you means one has the shot: break the line before it fires.',
  'Hold G to cook a frag, release to throw. Cook it too long and it goes off in your hand.',
  'Objectives pay more than a wave clear does. Crossing the sector under fire is where the score is.',
  'A warlord going down opens an evac window. Get to it before it closes.',
  'Cover between you and a frag does not cancel the blast, but it cuts it to well under half.',
  'A gun with nothing left in it swaps itself for one that still has rounds. Keep moving.',
  'F bashes whatever is in arm\'s reach, and it does not wait on a reload.',
  'Drops of more than about four metres hurt. The stairs up to a perch are there for a reason.',
  'Headshots hurt a great deal more than body shots, at every range.',
  'The fallen drop ammo, health and frags. They do not drop them for long.',
  'Hostiles route around buildings to reach you. A corner buys you seconds, not safety.',
];
const NOTE_SECONDS = 6;

export class LoadingScreen {
  /** @param {number} seed picks which field note comes first */
  constructor(seed = 0) {
    this.root = document.getElementById('loading');
    this.stageEl = document.getElementById('load-stage');
    this.pctEl = document.getElementById('load-pct');
    this.fillEl = document.getElementById('load-fill');
    this.stepsEl = document.getElementById('load-steps');
    this.noteEl = document.getElementById('load-tip');
    this.canvas = document.getElementById('survey');
    this.marker = document.getElementById('survey-insertion');

    this.seed = seed >>> 0;
    this.started = performance.now();
    this.done = 0;            // weight of the stages already finished
    this.current = null;      // { label, weight, at }
    /** Every stage as it began, with the share of the bar it began at. */
    this.log = [];

    this.root?.classList.add('busy');
    this._note();
    this._grid();
  }

  /**
   * The stage about to run, and roughly how long it takes, in any unit, as
   * long as it is the same unit as `total`. Finishes the one before it.
   */
  stage(label, weight, total) {
    this.total = total;
    if (this.current) this._finish(this.current);
    this.current = { label, weight, at: performance.now() };
    const pct = Math.min(100, Math.round((this.done / total) * 100));
    this.log.push({ label, pct, t: Math.round(this.current.at - this.started) });

    if (this.stageEl) this.stageEl.textContent = label;
    if (this.pctEl) this.pctEl.textContent = pct + '%';
    if (this.fillEl) this.fillEl.style.transform = `scaleX(${pct / 100})`;
    if (this.stepsEl) {
      const li = document.createElement('li');
      li.textContent = label;
      li.className = 'active';
      this.stepsEl.appendChild(li);
      // the last few, so the list scrolls rather than grows
      while (this.stepsEl.children.length > 4) this.stepsEl.firstChild.remove();
    }
    this._note();
  }

  _finish(s) {
    this.done += s.weight;
    const last = this.stepsEl?.lastElementChild;
    if (last) last.className = 'done';
  }

  /**
   * Boot is over. The progress gives way to the DEPLOY button in the same
   * column, and the survey stays: it is the sector you are about to drop
   * into, with its perches marked, and taking the panel away instead moved
   * everything under it up the page by most of its height.
   */
  finish() {
    if (this.current) this._finish(this.current);
    this.current = null;
    this.log.push({ label: 'ready', pct: 100, t: Math.round(performance.now() - this.started) });
    this.root?.classList.remove('busy');
    this.root?.classList.add('ready');
  }

  /** Boot threw. Say so where the player is looking, rather than hang. */
  fail(err) {
    this.root?.classList.remove('busy');
    this.root?.classList.add('failed');
    if (this.stageEl) this.stageEl.textContent = 'Deployment failed';
    if (this.noteEl) this.noteEl.textContent = String(err && err.message || err);
  }

  _note() {
    if (!this.noteEl) return;
    const elapsed = (performance.now() - this.started) / 1000;
    const i = (this.seed + Math.floor(elapsed / NOTE_SECONDS)) % NOTES.length;
    this.noteEl.textContent = NOTES[i];
  }

  // ------------------------------------------------------------- the survey

  /** Map a world position onto the survey canvas, -Z up, as you face at insertion. */
  _toMap(x, z) {
    const { size } = this;
    const k = size / (SECTOR.edge * 2);
    return [(x + SECTOR.edge) * k, (z + SECTOR.edge) * k];
  }

  _context() {
    const c = this.canvas;
    if (!c) return null;
    const css = c.clientWidth || 200;
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(css * ratio)) {
      c.width = c.height = Math.round(css * ratio);
    }
    this.size = c.width;
    return c.getContext('2d');
  }

  /** The street grid needs no seed, so it goes up before anything is built. */
  _grid() {
    const ctx = this._context();
    if (!ctx) return;
    const { size } = this;
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, size, size);
    const k = size / (SECTOR.edge * 2);
    const half = (SECTOR.grid - 1) / 2;
    ctx.strokeStyle = 'rgba(255, 190, 120, 0.16)';
    ctx.lineWidth = Math.max(1, size / 240);
    for (let i = 0; i < SECTOR.grid; i++) {
      for (let j = 0; j < SECTOR.grid; j++) {
        const [x, y] = this._toMap((i - half) * SECTOR.block, (j - half) * SECTOR.block);
        const a = SECTOR.apron * k;
        ctx.strokeRect(x - a / 2, y - a / 2, a, a);
      }
    }
    ctx.strokeStyle = 'rgba(255, 190, 120, 0.35)';
    ctx.strokeRect(1, 1, size - 2, size - 2);
  }

  /**
   * The city as laid out: everything that stands up off the floor, shaded by
   * height, the perches a marksman will take, and where you go in.
   */
  survey(world, perches, insertion) {
    const ctx = this._context();
    if (!ctx) return;
    const k = this.size / (SECTOR.edge * 2);
    const boxes = world.boxes.filter((b) => b.top > 0.55 && !b.floor)
      .sort((a, b) => a.top - b.top);            // tall last, so it reads on top
    for (const b of boxes) {
      const [x, y] = this._toMap(b.cx, b.cz);
      const lift = Math.min(1, b.top / 30);
      ctx.fillStyle = b.top < 3
        ? 'rgba(150, 130, 110, 0.55)'
        : `rgb(${Math.round(70 + lift * 110)}, ${Math.round(62 + lift * 92)}, ${Math.round(56 + lift * 70)})`;
      ctx.save();
      ctx.translate(x, y);
      // the box's own turn: its frame is (cos, sin) about Y
      ctx.rotate(-Math.atan2(b.sin, b.cos));
      ctx.fillRect(-b.hx * k, -b.hz * k, b.hx * 2 * k, b.hz * 2 * k);
      ctx.restore();
    }

    const r = Math.max(3, this.size / 60);
    ctx.fillStyle = '#ffb347';
    for (const p of perches) {
      const [x, y] = this._toMap(p.x, p.z);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.9, y + r * 0.7);
      ctx.lineTo(x - r * 0.9, y + r * 0.7);
      ctx.closePath();
      ctx.fill();
    }

    if (this.marker && insertion) {
      const [x, y] = this._toMap(insertion.x, insertion.z);
      this.marker.style.left = (x / this.size) * 100 + '%';
      this.marker.style.top = (y / this.size) * 100 + '%';
      this.marker.classList.remove('hidden');
    }
    this.surveyed = { boxes: boxes.length, perches: perches.length };
  }
}

/**
 * Give the page a chance to paint, and come back.
 *
 * A frame callback and then a task lands after the paint; the timeout is the
 * floor for a hidden tab, where frame callbacks stop altogether and boot would
 * otherwise wait for the tab to come back.
 */
export function yieldToPaint() {
  return new Promise((resolve) => {
    if (document.hidden) { setTimeout(resolve, 0); return; }
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
}
