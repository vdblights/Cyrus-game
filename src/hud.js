import { WEAPON_DEFS } from './weapons.js';
import { cssColour } from './objectives.js';

const $ = (id) => document.getElementById(id);

/** All DOM-side readouts: bars, ammo, killfeed, radar, damage indicators. */
export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), wave: $('wave'), enemies: $('enemies-left'), score: $('score'),
      healthFill: $('health-fill'), healthNum: $('health-num'), staminaFill: $('stamina-fill'),
      weaponName: $('weapon-name'), mag: $('mag'), reserve: $('reserve'), ammo: $('ammo'),
      reloadHint: $('reload-hint'), slots: $('weapon-slots'), crosshair: $('crosshair'),
      hitmarker: $('hitmarker'), killfeed: $('killfeed'), banner: $('wave-banner'),
      flash: $('damage-flash'), hurtDirs: $('hurt-dirs'), toast: $('pickup-toast'),
      nades: $('nades'), nadeCount: $('nade-count'),
      cookBar: $('cook-bar'), cookFill: $('cook-fill'),
      bossBar: $('boss-bar'), bossFill: $('boss-fill'),
      objective: $('objective'), objLabel: $('objective-label'), objTimer: $('objective-timer'),
      objFill: $('objective-fill'), objNote: $('objective-note'),
      objMarker: $('objective-marker'), objDist: $('objective-marker').querySelector('.om-dist'),
      captureHint: $('capture-hint'), captureText: $('capture-text'),
      captureNewTab: $('capture-newtab'),
    };
    this.radar = $('radar');
    this.radarCtx = this.radar.getContext('2d');
    this.hitTimer = 0;
    this.flashTimer = 0;

    this.el.slots.innerHTML = '';
    this.slotEls = WEAPON_DEFS.map((def, i) => {
      const d = document.createElement('div');
      d.className = 'slot';
      d.textContent = (i + 1) + ' ' + def.name.split(' ')[0];
      this.el.slots.appendChild(d);
      return d;
    });
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }

  /**
   * Mouse capture state. Hidden once the pointer is locked; otherwise it says
   * what to do about it — including the escape hatch when the page is embedded
   * in a frame that denies pointer lock.
   */
  captureState({ locked, fallback, embedded }) {
    const hide = locked;
    this.el.captureHint.classList.toggle('hidden', hide);
    if (hide) return;
    if (fallback) {
      this.el.captureText.textContent = embedded
        ? 'MOUSE CAPTURE BLOCKED IN THIS EMBED — STEERING WITH CURSOR'
        : 'MOUSE CAPTURE UNAVAILABLE — STEERING WITH CURSOR';
      this.el.captureNewTab.classList.toggle('hidden', !embedded);
      this.el.captureNewTab.href = location.href;
    } else {
      this.el.captureText.textContent = 'CLICK TO CAPTURE MOUSE';
      this.el.captureNewTab.classList.add('hidden');
    }
  }

  setCrosshairSpread(px, hidden) {
    const c = this.el.crosshair;
    c.classList.toggle('hidden-ads', hidden);
    c.style.width = c.style.height = (16 + px) + 'px';
    c.style.margin = `-${(16 + px) / 2}px 0 0 -${(16 + px) / 2}px`;
  }

  update(game) {
    const p = game.player, ws = game.weapons, w = ws.current;

    this.el.wave.textContent = game.wave;
    this.el.enemies.textContent = game.aliveCount + (game.pendingSpawns > 0 ? '+' : '');
    this.el.score.textContent = game.score.toLocaleString();

    const hp = Math.max(0, Math.round(p.health));
    this.el.healthFill.style.width = (hp / p.maxHealth) * 100 + '%';
    this.el.healthFill.classList.toggle('low', hp < 40);
    this.el.healthNum.textContent = hp;
    this.el.staminaFill.style.width = p.stamina * 100 + '%';

    this.el.weaponName.textContent = w.def.name;
    this.el.mag.textContent = w.mag;
    this.el.reserve.textContent = w.reserve;
    this.el.ammo.classList.toggle('empty', w.mag === 0);
    this.el.reloadHint.classList.toggle('hidden', !(w.mag === 0 && w.reserve > 0 && !ws.reloading));

    this.slotEls.forEach((el, i) => {
      el.classList.toggle('active', i === ws.index);
      el.style.opacity = ws.weapons[i].unlocked ? '' : '0.25';
    });

    // crosshair opens up with spread
    const spreadPx = (ws.adsT > 0.6 ? w.def.adsSpread : w.def.spread) * 900
      * (Math.hypot(p.velocity.x, p.velocity.z) > 1 ? 1.4 : 1);
    this.setCrosshairSpread(spreadPx, ws.adsT > 0.75);

    this.el.nadeCount.textContent = game.nades;
    this.el.nades.classList.toggle('empty', game.nades === 0);

    // fuse readout while a frag is being cooked
    const cooking = game.cookStart >= 0;
    this.el.cookBar.classList.toggle('hidden', !cooking);
    if (cooking) {
      const left = Math.max(0, 1 - (game.time - game.cookStart) / game.fuseLength);
      this.el.cookFill.style.width = left * 100 + '%';
      this.el.cookFill.classList.toggle('hot', left < 0.35);
    }

    const boss = game.boss;
    const bossUp = !!boss && boss.alive;
    this.el.bossBar.classList.toggle('hidden', !bossUp);
    if (bossUp) this.el.bossFill.style.width = Math.max(0, (boss.hp / boss.maxHp) * 100) + '%';

    this.captureState({
      locked: game.input.locked,
      fallback: game.input.fallback,
      embedded: game.embedded,
    });

    this.objective(game);
    this.drawRadar(game);
  }

  /**
   * Objective readout and its waypoint. The waypoint matters more than the
   * panel: the city is a maze of identical blocks, and a bearing is the only
   * thing that makes a site 70 m away findable.
   */
  objective(game) {
    const o = game.objectives.active;
    this.el.objective.classList.toggle('hidden', !o);
    this.el.objMarker.classList.toggle('hidden', !o);
    if (!o) return;

    const left = Math.max(0, o.expiresAt - game.time);
    const mins = Math.floor(left / 60);
    const secs = Math.floor(left % 60).toString().padStart(2, '0');
    this.el.objLabel.textContent = o.def.label;
    this.el.objTimer.textContent = `${mins}:${secs}`;
    this.el.objTimer.classList.toggle('urgent', left < 20);
    this.el.objFill.style.width = (o.progress / o.def.channel) * 100 + '%';
    this.el.objNote.textContent = o.inside
      ? `${o.def.verb} ${Math.round((o.progress / o.def.channel) * 100)}%`
      : `${o.def.brief} — ${Math.round(o.dist)} M`;

    const m = game.objectives.screenMarker(game.camera, innerWidth, innerHeight);
    if (!m) return;
    this.el.objMarker.style.transform = `translate(${Math.round(m.x)}px, ${Math.round(m.y)}px) translate(-50%, -50%)`;
    this.el.objMarker.style.color = m.colour;
    this.el.objMarker.classList.toggle('edge', m.offscreen);
    this.el.objDist.textContent = Math.round(m.dist) + ' M';
    this.el.objective.style.setProperty('--obj', m.colour);
  }

  hitmark(kill) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'kill');
    void h.offsetWidth;              // restart the animation
    h.classList.add('show');
    if (kill) h.classList.add('kill');
  }

  kill(text, weapon, headshot) {
    const d = document.createElement('div');
    d.className = 'kf';
    d.innerHTML = `${headshot ? '<span class="hs">HEADSHOT</span> ' : ''}<span class="w">${weapon}</span> &rsaquo; ${text}`;
    this.el.killfeed.prepend(d);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => d.remove(), 4200);
  }

  toast(text) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    this.el.toast.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }

  banner(title, sub) {
    const b = this.el.banner;
    b.classList.remove('hidden');
    b.innerHTML = `${title}<span class="sub">${sub}</span>`;
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
  }

  damage(fromAngle, severity) {
    this.el.flash.style.opacity = Math.min(0.9, 0.25 + severity);
    this.flashTimer = 0.12;
    if (fromAngle !== null && fromAngle !== undefined) {
      const d = document.createElement('div');
      d.className = 'hurt-dir';
      d.style.transform = `translate(-50%, -50%) rotate(${fromAngle}rad) translateY(-130px)`;
      this.el.hurtDirs.appendChild(d);
      setTimeout(() => d.remove(), 1200);
    }
  }

  tick(dt) {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.el.flash.style.opacity = '0';
    }
  }

  /** Top-down sweep radar showing hostiles relative to the player's facing. */
  drawRadar(game) {
    const ctx = this.radarCtx;
    const size = this.radar.width, r = size / 2 - 6;
    const cx = size / 2, cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(255,190,130,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,190,130,0.15)';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // view cone
    ctx.fillStyle = 'rgba(255,190,130,0.10)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
    ctx.closePath();
    ctx.fill();

    const range = 60;
    const p = game.player;
    const yaw = p.yaw;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - p.position.x;
      const dz = e.pos.z - p.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      // rotate into player space: forward (-sin, -cos) maps to screen up
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const px = cx + (rx / range) * r;
      const py = cy + (rz / range) * r;
      ctx.fillStyle = e.type.hp > 200 ? '#ff8a2a' : '#ff4033';
      ctx.beginPath();
      ctx.arc(px, py, e.type.hp > 200 ? 3.5 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const pk of game.pickups) {
      if (!pk.active) continue;
      const dx = pk.mesh.position.x - p.position.x;
      const dz = pk.mesh.position.z - p.position.z;
      if (Math.hypot(dx, dz) > range) continue;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      ctx.fillStyle = pk.kind === 'health' ? '#7ad06a' : '#ffd23f';
      ctx.fillRect(cx + (rx / range) * r - 2, cy + (rz / range) * r - 2, 4, 4);
    }

    // objective bearing, clamped to the rim when the site is past the sweep —
    // the radar should always say which way to run, not just what is close
    const obj = game.objectives.active;
    if (obj) {
      const dx = obj.x - p.position.x, dz = obj.z - p.position.z;
      const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const d = Math.hypot(rx, rz) || 1;
      const s = (Math.min(d, range) / range) * r / d;
      ctx.save();
      ctx.translate(cx + rx * s, cy + rz * s);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = cssColour(obj.def.colour);
      ctx.lineWidth = 2;
      ctx.strokeRect(-3.4, -3.4, 6.8, 6.8);
      ctx.restore();
    }

    // player marker
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath();
    ctx.fill();
  }
}
