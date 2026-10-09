/**
 * Operation ASHFALL: who you are, who you are fighting, and what a run is
 * the story of.
 *
 * Eleven weeks ago the Halloran refinery burned for nine days and buried the
 * city of Carrow in ash. The city was evacuated, and not everyone got out.
 * The Cinder stayed — looters first, then a militia under warlords who hold
 * the city street by street. Somewhere in Sector 7 a group of survivors is
 * still holding out. You are WREN, a recovery contractor; HALCYON is your
 * handler on the radio. The job: bring the district's relays back so the
 * holdouts can be found, get them out, and hold the depot when the convoy
 * comes for the last of them.
 *
 * A run is three acts over twelve waves, each wave bringing the objective
 * the plan gives it, and then endless survival once the convoy is out. The
 * warlord waves (every fifth) bring their own evac, as they always did. If
 * the convoy is lost it comes again the next wave, until it is out.
 *
 * Everything here is data: what each wave brings and what the handler says.
 * Nothing in it draws on `Math.random` — a line is picked by the wave or a
 * count — so the story moves neither the layout nor the spawns.
 */

export const OPERATION = { name: 'ASHFALL', city: 'CARROW', handler: 'HALCYON', callsign: 'WREN' };

/** The card shown before a run, paragraph by paragraph. */
export const BRIEFING = [
  'Eleven weeks ago the Halloran refinery burned for nine days and buried Carrow in ash. The city was evacuated. Not everyone got out.',
  'The Cinder stayed. Looters at first; now a militia of a few hundred under warlords, holding the city street by street and anyone left in it.',
  'Somewhere in Sector 7 a group of survivors is still holding out. The relays that could find them went dark when the Cinder took the district.',
  'Your job: bring the relays back, find the holdouts, and hold the depot when the convoy comes for them. HALCYON has you on the radio. Nobody else does.',
];

/** The acts, by the wave each begins on. */
export const ACTS = [
  { act: 1, from: 1, title: 'ACT I', name: 'DEAD AIR' },
  { act: 2, from: 5, title: 'ACT II', name: 'HOLDOUTS' },
  { act: 3, from: 9, title: 'ACT III', name: 'THE CONVOY' },
];

/** The wave the convoy comes on. Win it and the run goes on as endless survival. */
export const FINALE = 12;

/** What each wave of the operation brings. Warlord waves (5, 10) bring an evac when the warlord falls. */
const PLAN = { 2: 'relay', 3: 'cache', 4: 'sabotage', 6: 'rescue', 7: 'hunt', 8: 'relay', 9: 'rescue', 11: 'sabotage', 12: 'convoy' };
/** And after it, in turn. */
const ENDLESS = ['cache', 'relay', 'sabotage', 'rescue', 'hunt', 'hold'];

/**
 * The objective a wave brings, if any. Wave 1 is left clean so the first
 * contact is about learning to shoot; a warlord wave gets its evac when the
 * warlord drops, not at the start; a lost convoy comes again until it is out.
 */
export function objectiveFor(wave, complete = false) {
  if (wave < 2 || wave % 5 === 0) return null;
  if (wave <= FINALE) return PLAN[wave] || null;
  if (!complete) return 'convoy';
  return ENDLESS[wave % ENDLESS.length];
}

/** The act a wave belongs to, and whether it is the wave that act opens on. */
export function actFor(wave) {
  let current = ACTS[0];
  for (const a of ACTS) if (wave >= a.from) current = a;
  return { ...current, opens: ACTS.some((a) => a.from === wave), endless: wave > FINALE };
}

/** One of several lines, picked by a number so the same run says the same thing. */
export const pickLine = (lines, n = 0) => lines[Math.abs(n) % lines.length];

/** What HALCYON says, by event. `{d}` is a distance in metres. */
export const RADIO = {
  deploy: ['WREN, HALCYON. You are down in Sector 7. The plaza is yours for now. It will not stay that way.'],
  act: {
    1: ['Every relay in this district is dark. Until we light them, we are deaf and so is anyone still alive in there.'],
    2: ['The relays picked up a voice, WREN. Someone is alive in there. More than one.'],
    3: ['The convoy rolls tonight. It will come for the holdouts at the depot, and it will not wait.'],
  },
  wave: {
    1: ['Movement on every street. Those are Cinder. Hold the plaza and let them come to you.'],
    2: ['They know you are here now. More coming.'],
    3: ['Bigger push. Some of them are carrying shotguns. Do not let them close.'],
    4: ['Marksmen on the rooftops. If you see a red line on you, break it.'],
    6: ['They are hunting the holdouts as hard as we are. We need to get there first.'],
    7: ['Cinder traffic is up. Something is moving across the sector.'],
    8: ['One more relay and the whole district talks to us.'],
    9: ['They have stopped probing. This is what they have.'],
    11: ['They are massing on the convoy route. Make it cost them.'],
    12: ['Convoy is inbound. Everything they have is coming with it.'],
  },
  waveEndless: [
    'More of them, WREN.', 'Another push coming in.', 'They are not running out of people.',
    'Contacts on three streets.', 'Here they come again.',
  ],
  clear: [
    'Street is quiet. Breathe. The armoury is open if you have the scrip.',
    'That is the wave. Rearm while you can.',
    'Quiet for now. It will not last.',
  ],
  warlord: ['Big signature inbound. That is a warlord. The Cinder fight for whoever scares them most.'],
  objective: {
    cache: {
      start: ['Cinder stockpile, {d} metres. Strip it before they move it.', 'Supply drop the Cinder grabbed, {d} metres out. Take it back.'],
      done: ['Good haul. That is food and rounds they will not have.'],
      lost: ['They moved the stockpile. Forget it.'],
    },
    hold: {
      start: ['Signal beacon, {d} metres. Hold it while it transmits. Every Cinder in earshot will hear it.'],
      // in place of an objective this part of the city has nowhere for
      instead: ['Nothing out there we can use for that, WREN. There is a beacon {d} metres off instead. Hold it while it transmits.'],
      done: ['Beacon is up. We can hear the district now.'],
      lost: ['Beacon is down. We will try another.'],
    },
    extraction: {
      start: ['Warlord is down. There is a window, WREN. Evac point is marked, {d} metres. Move.'],
      done: ['You are clear. Rearmed and patched. Get back in there.'],
      lost: ['Window closed. We will make another.'],
    },
    relay: {
      start: ['Relay mast on a rooftop, {d} metres. Find the stairs, get up there and hold it while it handshakes. They will come up after you.',
        'Another dead relay, {d} metres, up on a roof. Same drill: the stairs, the mast, hold it.'],
      done: ['Relay is talking. That is one more ear back on the district.', 'Relay is live. We can hear the whole sector now.'],
      lost: ['Relay dropped before it handshook. We will find another.'],
    },
    sabotage: {
      start: ['That burning drum is Cinder fuel, {d} metres. Plant a charge on it.', 'Cinder fuel dump, {d} metres. Mine it.'],
      stage: ['Charge is live. Keep them off it till it blows, and do not be standing next to it.'],
      done: ['That will hurt them. Nice work.'],
      lost: ['They pulled the charge. Next time, keep them off it.'],
    },
    hunt: {
      start: ['Cinder lieutenant crossing the sector with an escort, {d} metres. He carries their routes. Do not let him reach the edge.'],
      done: ['Lieutenant is down. His maps put the convoy route through the depot.', 'Got him. That is their orders gone with him.'],
      lost: ['He is out of the sector. They will know what we know now.'],
    },
    rescue: {
      start: ['Holdout pinned in a shop, {d} metres. Cut them loose and walk them out.', 'Another voice on the relay. Shop, {d} metres. Go get them.'],
      upstairs: ['Holdout gone to ground upstairs, {d} metres. Find the stair, cut them loose, bring them down.', 'Voice on the relay from a floor up, {d} metres. Stairwell is your way in.'],
      stage: ['You have them. Pickup is marked, {d} metres. Stay close, they cannot take much.'],
      done: ['They are on the bird. One more name off the list.', 'Holdout is out. Good work, WREN.'],
      lost: ['We lost them. Keep going, WREN.'],
    },
    convoy: {
      start: ['Convoy is two minutes out. The depot is marked, {d} metres. Hold it until they are loaded.'],
      done: ['That is the last of them. Convoy is rolling. Operation complete, WREN.'],
      lost: ['The convoy could not hold. It will try again next wave. Keep them alive until then.'],
    },
  },
  complete: ['Carrow is empty of anyone worth saving, except you. The Cinder are not done, and neither are we. Hold the district as long as you can.'],
  dead: ['WREN is down. WREN, respond. ... HALCYON out.'],
};

/** A line, with its distance filled in. */
export function radioLine(lines, n, d) {
  return pickLine(lines, n).replace('{d}', String(Math.round(d / 5) * 5));
}
