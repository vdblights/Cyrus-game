/**
 * The armoury: what a run can buy between waves, and the screen it is bought
 * on.
 *
 * It is paid for in scrip, not score. Every point scored earns a point of
 * scrip (`Game.update` tops it up from the score), and spending scrip never
 * touches the score — so the best-score line on the menu means what it always
 * meant, and buying armour is never a choice between surviving and ranking.
 *
 * The screen only opens between waves (`Game.openArmoury`), with the sector
 * clear: it stops the clock, so the intermission waits for you. Everything
 * bought lasts the run and is gone at the next `startRun`.
 *
 * Nothing here draws on `Math.random` or mints a three object, so a purchase
 * moves neither the layout nor the stream that picks the next spawn.
 */

/**
 * What each tier does, by the index of the tier owned (0 is none). Read by
 * the systems themselves — `Weapons.magSize` and `fire`, `Game.hitscan`,
 * `Game.damagePlayer`, the field of view in `Game.frame` — so a tier is one
 * number in one place.
 */
export const EFFECT = {
  armour: [1, 0.85, 0.72, 0.6],      // damage taken
  mags: [1, 1.25, 1.5],              // magazine size
  opticsSpread: [1, 0.7, 0.5],       // aimed spread
  opticsZoom: [1, 0.88, 0.78],       // aimed field of view, on top of the weapon's own
  rifling: [1, 1.12, 1.25],          // damage dealt
  pouch: [0, 1, 2],                  // grenades carried over the five
};

/** The shelf. `cost` has one entry a tier; a `repeat` item can be bought again. */
export const ITEMS = [
  { id: 'armour', name: 'PLATE CARRIER', cost: [1200, 2400, 4000],
    what: ['15% off every hit you take', '28% off every hit', '40% off every hit'] },
  { id: 'mags', name: 'EXTENDED MAGAZINES', cost: [1000, 2500],
    what: ['A quarter more in every magazine', 'Half as much again in every magazine'] },
  { id: 'optics', name: 'OPTICS', cost: [900, 2200],
    what: ['Tighter aimed fire and a closer sight picture', 'Tighter and closer again'] },
  { id: 'rifling', name: 'MATCH AMMUNITION', cost: [1500, 3500],
    what: ['12% more damage from every weapon', '25% more damage'] },
  { id: 'pouch', name: 'FRAG POUCH', cost: [800, 1600],
    what: ['Carry one more grenade, and fill up', 'Carry another, and fill up'] },
  { id: 'resupply', name: 'RESUPPLY', cost: [600], repeat: true,
    what: ['Every weapon to full ammunition, and two frags'] },
  { id: 'medkit', name: 'FIELD DRESSING', cost: [500], repeat: true,
    what: ['Back to full health'] },
];

/** A fresh run's kit: no tiers of anything. */
export function freshKit() {
  return { armour: 0, mags: 0, optics: 0, rifling: 0, pouch: 0 };
}

/** What the next purchase of an item costs, or null when it is maxed out. */
export function priceOf(kit, item) {
  if (item.repeat) return item.cost[0];
  const owned = kit[item.id];
  return owned < item.cost.length ? item.cost[owned] : null;
}

/**
 * Buy one item for the game, if it can be afforded and is not maxed out.
 * The tiers go into `game.kit`; the one-off items act at once.
 *
 * @returns {boolean} whether it was bought
 */
export function buy(game, id) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) return false;
  const price = priceOf(game.kit, item);
  if (price === null || game.scrip < price) return false;
  if (id === 'medkit' && game.player.health >= game.player.maxHealth) return false;
  game.scrip -= price;
  if (!item.repeat) game.kit[id]++;
  if (id === 'pouch' || id === 'resupply') {
    game.maxNades = 5 + EFFECT.pouch[game.kit.pouch];
    game.nades = id === 'pouch' ? game.maxNades : Math.min(game.maxNades, game.nades + 2);
  }
  if (id === 'resupply') {
    for (const w of game.weapons.weapons) if (w.unlocked) w.reserve = w.def.maxReserve;
  }
  if (id === 'medkit') game.player.health = game.player.maxHealth;
  return true;
}

/** The screen: a list of the shelf, kept current, bought from by click or by number. */
export class ArmouryScreen {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('armoury');
    this.list = document.getElementById('armoury-items');
    this.scrip = document.getElementById('armoury-scrip');
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-item]');
      if (row) this.purchase(row.dataset.item);
    });
    document.getElementById('armoury-close').addEventListener('click', () => game.closeArmoury());
    addEventListener('keydown', (e) => {
      if (game.state !== 'armoury') return;
      if (e.code === 'KeyB' || e.code === 'Escape') { e.preventDefault(); game.closeArmoury(); return; }
      const n = /^Digit(\d)$/.exec(e.code);
      if (n && ITEMS[+n[1] - 1]) this.purchase(ITEMS[+n[1] - 1].id);
    });
  }

  purchase(id) {
    if (buy(this.game, id)) this.game.onPurchase?.(id);
    this.render();
  }

  render() {
    const g = this.game;
    this.scrip.textContent = `SCRIP ${g.scrip.toLocaleString()}`;
    this.list.innerHTML = ITEMS.map((item, i) => {
      const price = priceOf(g.kit, item);
      const owned = item.repeat ? 0 : g.kit[item.id];
      const maxed = price === null;
      const what = item.what[Math.min(owned, item.what.length - 1)];
      const pips = item.repeat ? '' : item.cost.map((_, k) => `<i class="${k < owned ? 'on' : ''}"></i>`).join('');
      const cant = maxed || g.scrip < price || (item.id === 'medkit' && g.player.health >= g.player.maxHealth);
      return `<button class="shelf${cant ? ' cant' : ''}" data-item="${item.id}">` +
        `<span class="key">${i + 1}</span>` +
        `<span class="name">${item.name}<span class="pips">${pips}</span></span>` +
        `<span class="what">${maxed ? 'Fully fitted' : what}</span>` +
        `<span class="price">${maxed ? '—' : price.toLocaleString()}</span></button>`;
    }).join('');
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
    if (on) this.render();
  }
}
