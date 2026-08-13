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

function make(key, builder, repeat = [1, 1], colorSpace = THREE.SRGBColorSpace) {
  if (cache.has(key)) return cache.get(key);
  const tex = new THREE.CanvasTexture(builder());
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 8;
  tex.colorSpace = colorSpace;      // normal maps carry vectors, not colour
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
    // aggregate: the chips of stone that make asphalt read as a surface
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const r = 0.6 + Math.random() * 1.9;
      ctx.fillStyle = Math.random() < 0.5
        ? `rgba(150,146,138,${0.05 + Math.random() * 0.18})`
        : `rgba(24,23,26,${0.10 + Math.random() * 0.25})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // patches where the surface has been repaired
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = `rgba(38,37,41,${0.3 + Math.random() * 0.25})`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * s, Math.random() * s, 30 + Math.random() * 70,
        24 + Math.random() * 50, Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }

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
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, s, s);
    splotches(ctx, s, 44, 'rgba(0,0,0,0.16)', 4, 22);
    splotches(ctx, s, 22, 'rgba(255,255,255,0.05)', 4, 18);
    // exposed aggregate and pitting
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      ctx.fillStyle = Math.random() < 0.5
        ? `rgba(255,255,255,${0.03 + Math.random() * 0.10})`
        : `rgba(0,0,0,${0.06 + Math.random() * 0.16})`;
      ctx.beginPath(); ctx.arc(x, y, 0.5 + Math.random() * 1.6, 0, Math.PI * 2); ctx.fill();
    }
    // hairline cracks wandering across the slab
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < 8; i++) {
      ctx.lineWidth = 0.5 + Math.random();
      ctx.beginPath();
      let x = Math.random() * s, y = Math.random() * s;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (Math.random() - 0.5) * 60; y += (Math.random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
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
    const s = 512, c = canvas(s), ctx = c.getContext('2d');
    const bases = ['#5e584e', '#6b6157', '#4e535a', '#7a6a58', '#575b60'];
    const base = bases[style % bases.length];
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);

    if (style % 5 === 3) {
      // brick coursing
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = 0; y < s; y += 16) ctx.fillRect(0, y, s, 2);
      for (let y = 0; y < s; y += 16) {
        const off = (y / 16) % 2 ? 16 : 0;
        for (let x = off; x < s; x += 32) ctx.fillRect(x, y, 2, 16);
      }
    }

    splotches(ctx, s, 46, 'rgba(0,0,0,0.16)', 10, 60);
    splotches(ctx, s, 20, 'rgba(90,60,30,0.20)', 14, 60);   // rust runoff

    const rows = 4, cols = 4;
    const pad = 20, w = (s - pad * (cols + 1)) / cols, h = (s - pad * (rows + 1)) / rows;

    // a slab of floor between each band of windows, which the normal map
    // turns into a real ledge
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * (h + pad) + pad * 0.15, s, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * (h + pad) + pad * 0.15 + 5, s, 4);

    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const x = pad + cI * (w + pad), y = pad + r * (h + pad);
        const roll = Math.random();
        const state = roll < 0.62 ? 'broken' : roll < 0.8 ? 'boarded' : 'intact';

        // recessed reveal, so the opening reads as depth
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x - 3, y - 3, w + 6, h + 6);

        if (state === 'broken') {
          ctx.fillStyle = '#08080a';
          ctx.fillRect(x, y, w, h);
          // shards clinging to the frame
          ctx.fillStyle = 'rgba(150,164,172,0.35)';
          for (let k = 0; k < 3; k++) {
            ctx.beginPath();
            ctx.moveTo(x + Math.random() * w, y);
            ctx.lineTo(x + Math.random() * w, y + h * (0.2 + Math.random() * 0.4));
            ctx.lineTo(x + Math.random() * w, y);
            ctx.closePath();
            ctx.fill();
          }
          // scorch licking up the wall above
          if (Math.random() < 0.45) {
            const g = ctx.createLinearGradient(0, y, 0, y - h * 0.9);
            g.addColorStop(0, 'rgba(10,8,6,0.62)');
            g.addColorStop(1, 'rgba(10,8,6,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - 6, y - h * 0.9, w + 12, h * 0.9);
          }
        } else if (state === 'boarded') {
          ctx.fillStyle = '#3b3126';
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = 'rgba(120,96,64,0.85)';
          for (let k = 0; k < 4; k++) {
            const by = y + 3 + k * (h / 4);
            ctx.save();
            ctx.translate(x + w / 2, by + 4);
            ctx.rotate((Math.random() - 0.5) * 0.14);
            ctx.fillRect(-w / 2 - 3, -4, w + 6, 8);
            ctx.restore();
          }
        } else {
          // grimy glass with a sky reflection sliding down it
          const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
          g.addColorStop(0, 'rgba(150,170,190,0.55)');
          g.addColorStop(0.45, 'rgba(70,86,104,0.40)');
          g.addColorStop(1, 'rgba(28,34,44,0.55)');
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          ctx.fillRect(x + w * 0.48, y, 3, h);          // mullion
        }

        // frame
        ctx.strokeStyle = 'rgba(230,225,215,0.16)';
        ctx.lineWidth = 3;
        ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        // grime bleeding from the sill
        if (Math.random() < 0.6) {
          const g = ctx.createLinearGradient(0, y + h, 0, y + h + 40);
          g.addColorStop(0, 'rgba(20,16,12,0.34)');
          g.addColorStop(1, 'rgba(20,16,12,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x + 2, y + h, w - 4, 40);
        }
      }
    }

    // vertical streaking over the whole face
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * s;
      const g = ctx.createLinearGradient(x, 0, x, s);
      g.addColorStop(0, 'rgba(18,14,10,0)');
      g.addColorStop(Math.random(), `rgba(18,14,10,${0.05 + Math.random() * 0.10})`);
      g.addColorStop(1, 'rgba(18,14,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1 + Math.random() * 5, s);
    }

    noise(ctx, s, 16);
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

/**
 * Dusk sky. The vertical band does the work: deep blue overhead falling
 * through violet to a smoggy orange at the horizon, with a dust layer sitting
 * on the skyline. The sun itself is a sprite placed at the light's actual
 * direction, not painted here, so the two can never drift apart.
 */
export function skyTexture() {
  return make('sky', () => {
    const s = 1024, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0.00, '#0d1120');   // zenith
    g.addColorStop(0.30, '#232a42');
    g.addColorStop(0.50, '#4a3f55');
    g.addColorStop(0.64, '#8a5c4c');
    g.addColorStop(0.76, '#c2764a');
    g.addColorStop(0.88, '#d08c4c');
    g.addColorStop(0.96, '#96633a');
    g.addColorStop(1.00, '#5d4630');   // below the horizon line, not glowing
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // torn cloud, soft and low contrast — hard bands read as painted stripes
    ctx.filter = 'blur(6px)';
    for (let i = 0; i < 46; i++) {
      const y = s * (0.32 + Math.pow(Math.random(), 0.7) * 0.44);
      const h = 6 + Math.random() * 22;
      const w = s * (0.2 + Math.random() * 0.55);
      const x = Math.random() * s;
      const light = y / s;
      ctx.fillStyle = Math.random() < 0.4
        ? `rgba(255, ${170 + light * 60 | 0}, ${130 + light * 40 | 0}, ${0.03 + Math.random() * 0.06})`
        : `rgba(${34 + light * 40 | 0}, ${28 + light * 26 | 0}, ${44 + light * 16 | 0}, ${0.05 + Math.random() * 0.10})`;
      ctx.beginPath();
      ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.filter = 'none';

    // dust haze thickening onto the skyline
    const haze = ctx.createLinearGradient(0, s * 0.68, 0, s);
    haze.addColorStop(0, 'rgba(214, 150, 96, 0)');
    haze.addColorStop(1, 'rgba(214, 150, 96, 0.38)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, s * 0.68, s, s * 0.32);
    return c;
  });
}

/**
 * Derive a normal map from a texture's own luminance (Sobel on brightness,
 * treating dark as recessed). Painted windows and mortar lines then catch
 * light like relief instead of reading as a flat decal.
 */
export function normalFrom(sourceTexture, strength = 1.6, key = '') {
  return make('normal' + key + strength, () => {
    const src = sourceTexture.image;
    const size = src.width;
    const read = document.createElement('canvas');
    read.width = read.height = size;
    const rctx = read.getContext('2d');
    rctx.drawImage(src, 0, 0);
    const px = rctx.getImageData(0, 0, size, size).data;

    const lum = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      lum[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    }
    const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];

    const out = document.createElement('canvas');
    out.width = out.height = size;
    const octx = out.getContext('2d');
    const img = octx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
                 - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
        const dy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
                 - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
        let nx = dx * strength, ny = dy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }, [sourceTexture.repeat.x, sourceTexture.repeat.y], THREE.NoColorSpace);
}

/** Sun glow: a smooth falloff, unlike the hard-cored particle sprite. */
export function sunSprite(inner = '#fff3d6', outer = '#ff9a3c') {
  return make('sun' + inner + outer, () => {
    const s = 256, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.00, inner);
    g.addColorStop(0.12, inner);
    g.addColorStop(0.30, outer);
    g.addColorStop(0.55, 'rgba(255,140,60,0.22)');
    g.addColorStop(0.78, 'rgba(255,120,50,0.06)');
    g.addColorStop(1.00, 'rgba(255,120,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
}

/** Soft round blob for contact shadows under characters and props. */
export function blobShadow() {
  return make('blob', () => {
    const s = 128, c = canvas(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return c;
  });
}
