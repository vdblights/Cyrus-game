/**
 * The frame-rate readout, and what the browser says it is drawing with.
 *
 * Every frame-rate figure this repo has ever measured came from software
 * rendering in a headless browser, and every report of lag came from a
 * machine nobody here could see. This is the other end of that: ` (the key
 * left of 1) or "Show frame rate" in the pause menu puts the numbers on
 * screen, so a report can carry them — frames a second, the frame time and
 * the worst one, how much of it was the CPU, the tier and the resolution
 * `auto` has settled on, draw calls, whether the mouse is captured, and the
 * GPU's own name.
 *
 * It costs nothing while hidden: a ring of three numbers a frame. While it
 * is shown, draw calls are counted across the whole frame rather than the
 * last pass, and the text is rewritten four times a second, not every frame.
 */

import { Vector2 } from 'three';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const RING = 240;

/** What the browser reports drawing with: the unmasked name where it gives one. */
export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name || 'unknown');
  } catch {
    return 'unknown';
  }
}

/** True when there is no graphics card behind the canvas at all. */
export const isSoftware = (name) => SOFTWARE.test(name);

export class PerfMeter {
  constructor(renderer) {
    this.renderer = renderer;
    this.gpu = gpuName(renderer.getContext());
    this.software = isSoftware(this.gpu);
    // start, interval and cpu time of each recent frame, in ms
    this.began = new Float64Array(RING);
    this.cpu = new Float32Array(RING);
    this.sim = new Float32Array(RING);
    this.count = 0;
    this.visible = false;
    this.drawnAt = 0;
    this.calls = 0;
    this.tris = 0;
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.className = 'hidden';
    (document.getElementById('app') || document.body).appendChild(this.el);
  }

  show(on) {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    // a frame is a dozen render calls (passes, cascades, the gun); count all
    this.renderer.info.autoReset = !on;
  }

  beforeRender() {
    if (this.visible) this.renderer.info.reset();
  }

  /** Record one frame: when it began, when the simulation ended, when it was issued. */
  frame(began, stepped, ended) {
    const i = this.count % RING;
    this.began[i] = began;
    this.cpu[i] = ended - began;
    this.sim[i] = stepped - began;
    this.count++;
    if (this.visible) {
      this.calls = this.renderer.info.render.calls;
      this.tris = this.renderer.info.render.triangles;
    }
  }

  /** Frame statistics over the last `seconds`, or null before there are two frames. */
  stats(seconds = 1) {
    const n = Math.min(this.count, RING);
    if (n < 2) return null;
    const last = (this.count - 1) % RING;
    const now = this.began[last];
    const gaps = [], cpu = [], sim = [];
    for (let k = 1; k < n; k++) {
      const i = (this.count - 1 - k + RING) % RING;
      const j = (i + 1) % RING;
      if (now - this.began[i] > seconds * 1000) break;
      gaps.push(this.began[j] - this.began[i]);
      cpu.push(this.cpu[j]);
      sim.push(this.sim[j]);
    }
    if (!gaps.length) return null;
    const span = gaps.reduce((a, b) => a + b, 0);
    const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return {
      fps: (gaps.length * 1000) / span,
      frame: median(gaps),
      worst: Math.max(...gaps),
      cpu: median(cpu),
      sim: median(sim),
    };
  }

  /** Rewrite the readout, at most four times a second. */
  draw(game, now) {
    if (!this.visible || now - this.drawnAt < 250) return;
    this.drawnAt = now;
    const s = this.stats(1);
    const size = game.renderer.getDrawingBufferSize(SIZE);
    const ratio = game.renderer.getPixelRatio();
    const tier = (game.activeTier || '?').toUpperCase();
    const q = game.settings.quality === 'auto' ? `AUTO → ${tier}` : tier;
    const mouse = game.input.locked ? 'captured' : game.input.fallback ? 'STEERING — not captured' : 'not captured';
    const lines = [
      s ? `<b>${s.fps.toFixed(0)} fps</b> · ${s.frame.toFixed(1)} ms · worst ${s.worst.toFixed(1)}` : '— fps',
      s ? `cpu ${s.cpu.toFixed(1)} ms (game ${s.sim.toFixed(1)})` : '',
      `${q} · ${ratio.toFixed(2)}x · ${size.x}×${size.y}`,
      `${this.calls} calls · ${(this.tris / 1000).toFixed(0)}k tris`,
      `mouse ${mouse}`,
      this.gpu,
    ];
    if (this.software) lines.push('<i>NO GPU — hardware acceleration is off</i>');
    this.el.innerHTML = lines.filter(Boolean).join('<br>');
  }
}

// a Vector2 mints no UUID, so it costs the seeded stream nothing
const SIZE = new Vector2();
