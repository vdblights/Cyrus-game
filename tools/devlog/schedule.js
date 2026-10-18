// The scheduled half of the dev log (.github/workflows/devlog-schedule.yml):
// a post on something other than the latest merge, drafted as an issue
// labelled `devlog`, a few times a week. Posting it is the same as posting a
// merge's draft (run.js), and so is DEVLOG_AUTOPOST.
//
// Each run takes the next topic in ROTATION by the workflow's run number, so
// a week's posts differ without anything to remember between runs. Every
// topic draws only on what is in the repo, because the voice says never to
// claim anything the material does not.
import { readFileSync } from 'node:fs';
import { claudeWrite, withLink } from './draft.js';
import { xConfigured } from './x.js';
import { gh, draftBody, recentPosts, LABEL } from './github.js';
import { link, publish } from './run.js';

const env = process.env;
const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// The invariants in CLAUDE.md, one bullet each: what building the game
// taught, with the numbers.
export function invariants(text = read('CLAUDE.md')) {
  const from = text.indexOf('## Invariants worth not breaking');
  const to = text.indexOf('\n## ', from + 1);
  return text.slice(from, to).split(/\n(?=- \*\*)/).slice(1).map((b) => b.trim());
}

// The field notes the loading screen cycles through: real mechanics.
export function fieldNotes(text = read('src/loading.js')) {
  const list = text.slice(text.indexOf('const NOTES = ['), text.indexOf('];', text.indexOf('const NOTES = [')));
  return [...list.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
}

// Picks without repeating soon: steps through a list by a stride prime to it.
const pick = (list, n, stride = 7) => list[(n * stride) % list.length];

export const TOPICS = {
  transmission: (n) => ({
    label: 'a transmission from Carrow',
    register: 'radio',
    brief: 'Write a transmission or field log from inside Carrow, between waves of the operation. It can be about the city, the ash, the Cinder, the relays, the holdouts or the convoy. Make it feel like a moment, not a summary of the story.',
    material: read('src/story.js'),
  }),
  mechanic: (n) => {
    const bullet = pick(invariants(), n);
    return {
      label: `behind the scenes: ${bullet.match(/\*\*(.+?)\*\*/)?.[1] ?? 'a mechanic'}`,
      register: 'diary',
      brief: 'Write a behind-the-scenes post about one thing building the game taught. Pick the single most surprising detail in the material (a bug and why it happened, or a number) and tell it plainly.',
      material: bullet,
    };
  },
  tip: (n) => {
    const note = pick(fieldNotes(), n, 5);
    return {
      label: 'a tip from HALCYON',
      register: 'radio',
      brief: 'Write HALCYON giving WREN this piece of advice over the radio, in character. Keep the facts of the tip exactly as given.',
      material: note,
    };
  },
  seed: (n) => {
    if (!env.DEVLOG_LINK) return null;
    const seed = (n * 2654435761) % 1000000;
    const url = new URL(env.DEVLOG_LINK);
    url.searchParams.set('seed', String(seed));
    return {
      label: `a city to try (seed ${seed})`,
      register: 'diary',
      brief: `Invite people to play one particular city. The game lays out a new ruined city from every seed, and the link opens city number ${seed} exactly, so everyone who follows it fights through the same streets. You know nothing about what is in this city, so describe none of it.`,
      material: 'ASHFALL is a free browser first-person shooter: twelve waves in a procedurally generated ruined city at dusk, then as long as you can last. No download.',
      link: url.toString(),
    };
  },
};

// A run of six posts: two transmissions, two behind-the-scenes, a tip and a
// seed. A topic with nothing to say (a seed with no link to the game) passes
// to the next.
export const ROTATION = ['transmission', 'mechanic', 'tip', 'transmission', 'mechanic', 'seed'];

export async function main() {
  if (!env.ANTHROPIC_API_KEY) {
    return console.log('No ANTHROPIC_API_KEY, so there is nobody to write a scheduled post. Nothing drafted.');
  }
  const n = Number(env.GITHUB_RUN_NUMBER || 0);
  let name = env.INPUT_TOPIC || ROTATION[n % ROTATION.length];
  if (!TOPICS[name]) throw new Error(`No topic "${name}"; the topics are ${Object.keys(TOPICS).join(', ')}`);
  let topic = TOPICS[name](n);
  for (let i = 1; !topic && i < ROTATION.length; i++) {
    name = ROTATION[(n + i) % ROTATION.length];
    topic = TOPICS[name](n);
  }

  const recent = await recentPosts();
  let text = null;
  // A post that comes back too long gets one more try.
  for (let tries = 0; !text && tries < 2; tries++) text = withLink(await claudeWrite({ ...topic, recent }), topic.link ?? link());
  if (!text) throw new Error('Claude wrote two posts too long for X');
  console.log(`${name} (${topic.register}):\n${text}`);

  const issue = await gh('/repos/{repo}/issues', {
    method: 'POST',
    body: JSON.stringify({ title: `Dev log draft: ${topic.label}`, labels: [LABEL], body: '(drafting)' }),
  });
  const record = { kind: 'issue', id: issue.number, body: '', issue };
  if (env.DEVLOG_AUTOPOST === 'true') {
    if (!xConfigured()) throw new Error('DEVLOG_AUTOPOST is on but the X secrets are not all set');
    return publish(issue.number, text, record);
  }
  await gh(`/repos/{repo}/issues/${issue.number}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: draftBody(issue.number, text, 'claude', `Topic: ${topic.label}. Close this issue to drop it.`) }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
