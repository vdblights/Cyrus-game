import * as THREE from 'three';

/**
 * Procedural canvas textures. The game ships no binary assets, so every
 * surface in the city is painted here at boot and cached by key.
 */

const cache = new Map();

function canvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function noise(ctx, size, amount, alpha) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
    if (alpha !== undefined) d[i + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
}

function splotches(ctx, size, count, color, rMin, rMax) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = rMin + Math.random() * (rMax - rMin);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + Math.random()), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

function make(key, builder, repeat = [1, 1]) {
  if (cache.has(key)) return cache.get(key);
  const tex = new THREE.CanvasTexture(builder());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

/** Cracked asphalt with faded lane markings. */
export function asphalt() {
  return make('asphalt', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#4c4b50';
    ctx.fillRect(0, 0, s, s);
    splotches(ctx, s, 60, 'rgba(46,45,48,0.45)', 8, 40);
    splotches(ctx, s, 30, 'rgba(104,99,90,0.30)', 6, 28);

    // cracks
    ctx.strokeStyle = 'rgba(26,26,29,0.8)';
    for (let i = 0; i < 26; i++) {
      ctx.lineWidth = 0.6 + Math.random() * 1.6;
      ctx.beginPath();
      let x = Math.random() * s, y = Math.random() * s;
      ctx.moveTo(x, y);
      for (let j = 0; j < 6; j++) {
        x += (Math.random() - 0.5) * 70;
        y += (Math.random() - 0.5) * 70;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // worn centre line
    ctx.fillStyle = 'rgba(205,185,105,0.34)';
    for (let y = 0; y < s; y += 64) ctx.fillRect(s / 2 - 4, y, 8, 40);
    noise(ctx, s, 26);
    return c;
  }, [6, 6]);
}

/** Pitted sidewalk / plaza concrete. */
export function concrete(tint = '#6d6b6d') {
  return make('concrete' + tint, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, s, s);
    splotches(ctx, s, 44, 'rgba(0,0,0,0.16)', 4, 22);
    splotches(ctx, s, 22, 'rgba(255,255,255,0.05)', 4, 18);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= s; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
    }
    noise(ctx, s, 22);
    return c;
  }, [4, 4]);
}

/**
 * Building facade: a grid of windows, most of them blown out, painted onto
 * a weathered wall. `style` picks the base material look.
 */
export function facade(style = 0, seed = 0) {
  return make('facade' + style + '_' + seed, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    const bases = ['#5e584e', '#6b6157', '#4e535a', '#7a6a58', '#575b60'];
    const base = bases[style % bases.length];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);

    if (style % 5 === 3) {
      // brick coursing
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = 0; y < s; y += 8) ctx.fillRect(0, y, s, 1);
      for (let y = 0; y < s; y += 8) {
        const off = (y / 8) % 2 ? 8 : 0;
        for (let x = off; x < s; x += 16) ctx.fillRect(x, y, 1, 8);
      }
    }

    splotches(ctx, s, 40, 'rgba(0,0,0,0.18)', 6, 30);
    splotches(ctx, s, 16, 'rgba(90,60,30,0.22)', 8, 34); // rust runoff

    // window grid
    const cols = 4, rows = 4;
    const pad = 10, w = (s - pad * (cols + 1)) / cols, h = (s - pad * (rows + 1)) / rows;
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const x = pad + cI * (w + pad), y = pad + r * (h + pad);
        const broken = Math.random() < 0.72;
        ctx.fillStyle = broken ? '#0a0a0c' : 'rgba(120,130,140,0.35)';
        ctx.fillRect(x, y, w, h);
        if (broken) {
          // jagged remains of glass in the frame
          ctx.fillStyle = 'rgba(150,160,168,0.30)';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + w, y);
          ctx.lineTo(x + w * (0.2 + Math.random() * 0.5), y + h * (0.15 + Math.random() * 0.4));
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(255,220,180,0.10)';
          ctx.fillRect(x, y, w, h * 0.35);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        // scorch above blown windows
        if (broken && Math.random() < 0.4) {
          const g = ctx.createLinearGradient(0, y, 0, y - h * 0.8);
          g.addColorStop(0, 'rgba(10,8,6,0.6)');
          g.addColorStop(1, 'rgba(10,8,6,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - 4, y - h * 0.8, w + 8, h * 0.8);
        }
      }
    }
    noise(ctx, s, 20);
    return c;
  }, [1, 1]);
}

/** Rusted sheet metal for shutters, container walls, barricades. */
export function rustMetal() {
  return make('rust', () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#6b4a33';
    ctx.fillRect(0, 0, s, s);
    splotches(ctx, s, 70, 'rgba(120,70,35,0.45)', 5, 30);
    splotches(ctx, s, 50, 'rgba(40,28,20,0.5)', 4, 22);
    splotches(ctx, s, 30, 'rgba(160,110,60,0.3)', 3, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let x = 0; x < s; x += 16) ctx.fillRect(x, 0, 2, s);
    noise(ctx, s, 24);
    return c;
  }, [2, 2]);
}

/** Dust / smoke sprite used by muzzle flashes, impacts and blood. */
export function particleSprite(color = '#ffffff') {
  return make('spr' + color, () => {
    const s = 64, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, color);
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
}

/** Dusk sky: haze at the horizon fading to a bruised blue overhead. */
export function skyTexture() {
  return make('sky', () => {
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0.00, '#141824');
    g.addColorStop(0.42, '#3a3546');
    g.addColorStop(0.62, '#7b5b47');
    g.addColorStop(0.78, '#c07a44');
    g.addColorStop(1.00, '#e0a05c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    splotches(ctx, s, 40, 'rgba(20,18,24,0.20)', 20, 90);
    return c;
  });
}
