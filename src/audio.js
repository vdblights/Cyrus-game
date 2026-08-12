/**
 * All sound is synthesised at runtime with the Web Audio API — no asset
 * files. Gunshots are a noise burst through a resonant filter plus a low
 * body thump; everything else is built from short envelopes.
 */
class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;

    // a touch of room: the city is all concrete
    const conv = this.ctx.createConvolver();
    conv.buffer = this._impulse(1.5, 2.6);
    const wet = this.ctx.createGain();
    wet.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
    this.master.connect(conv);
    conv.connect(wet);
    wet.connect(this.ctx.destination);

    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = (rate * seconds) | 0;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _noise(dur, filterType, freq, q, gain, sweepTo) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.value = freq;
    flt.Q.value = q;
    if (sweepTo) flt.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
    return g;
  }

  _tone(type, f0, f1, dur, gain, delay = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  /** @param {'pistol'|'smg'|'rifle'|'shotgun'} kind */
  shot(kind, distanceGain = 1) {
    if (!this.ctx) return;
    const spec = {
      pistol:  { dur: 0.16, freq: 1800, q: 1.2, gain: 0.55, body: 150 },
      smg:     { dur: 0.11, freq: 2400, q: 1.0, gain: 0.42, body: 190 },
      rifle:   { dur: 0.20, freq: 1500, q: 1.4, gain: 0.60, body: 120 },
      shotgun: { dur: 0.32, freq: 900,  q: 0.9, gain: 0.75, body: 80  },
    }[kind] || { dur: 0.16, freq: 1600, q: 1.2, gain: 0.5, body: 140 };

    this._noise(spec.dur, 'bandpass', spec.freq, spec.q, spec.gain * distanceGain, spec.freq * 0.25);
    this._tone('sine', spec.body, spec.body * 0.35, spec.dur * 1.4, 0.5 * distanceGain);
    // tail slapping off the buildings
    this._noise(0.5, 'lowpass', 900, 0.7, 0.10 * distanceGain, 250);
  }

  reload(stage) {
    if (!this.ctx) return;
    if (stage === 'out') { this._tone('square', 320, 170, 0.07, 0.10); this._noise(0.06, 'highpass', 2600, 1, 0.10); }
    if (stage === 'in')  { this._tone('square', 220, 140, 0.09, 0.13); this._noise(0.08, 'bandpass', 1400, 2, 0.12); }
    if (stage === 'bolt'){ this._tone('square', 480, 260, 0.06, 0.12); this._noise(0.05, 'highpass', 3200, 1, 0.13); }
    if (stage === 'shell'){ this._tone('square', 600, 380, 0.05, 0.09); }
  }

  dryFire() { if (this.ctx) this._tone('square', 900, 300, 0.04, 0.10); }

  swap() { if (this.ctx) { this._tone('square', 260, 400, 0.05, 0.07); this._noise(0.07, 'highpass', 2200, 1, 0.06); } }

  impact() { if (this.ctx) this._noise(0.09, 'bandpass', 2200, 1.6, 0.14, 700); }

  flesh() { if (this.ctx) { this._noise(0.10, 'lowpass', 700, 1, 0.30, 220); this._tone('sine', 90, 50, 0.10, 0.16); } }

  hitmark() { if (this.ctx) this._tone('square', 1400, 1400, 0.035, 0.09); }

  kill() { if (this.ctx) { this._tone('square', 1700, 1200, 0.05, 0.10); this._tone('square', 2300, 1800, 0.06, 0.08, 0.05); } }

  hurt() { if (this.ctx) { this._tone('sawtooth', 180, 70, 0.28, 0.18); this._noise(0.20, 'lowpass', 500, 1, 0.16); } }

  pickup() { if (this.ctx) { this._tone('sine', 700, 1050, 0.08, 0.12); this._tone('sine', 1050, 1500, 0.09, 0.10, 0.07); } }

  wave() {
    if (!this.ctx) return;
    this._tone('sawtooth', 110, 108, 0.9, 0.10);
    this._tone('sawtooth', 165, 160, 0.9, 0.07, 0.05);
    this._noise(1.2, 'lowpass', 400, 0.8, 0.10, 120);
  }

  death() {
    if (!this.ctx) return;
    this._tone('sawtooth', 220, 40, 1.6, 0.20);
    this._noise(1.8, 'lowpass', 700, 0.8, 0.22, 90);
  }

  step(crouch = false) {
    if (!this.ctx) return;
    this._noise(0.09, 'bandpass', crouch ? 500 : 900, 1.2, crouch ? 0.05 : 0.10, 260);
  }

  enemyAlert() { if (this.ctx) { this._tone('sawtooth', 300, 120, 0.35, 0.10); this._noise(0.3, 'bandpass', 700, 1.5, 0.10, 300); } }
}

export const audio = new Audio();
