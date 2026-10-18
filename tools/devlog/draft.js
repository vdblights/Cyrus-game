import { readFileSync } from 'node:fs';

// Writes posts about the game: from a merged pull request here, and on
// other topics for schedule.js.
//
// Without ANTHROPIC_API_KEY a merged PR's post is a template off its title.
// With it, Claude writes it in the voice set out in voice.md, and the
// template is the fallback whenever that fails or comes back too long.

// X counts every link as 23 characters whatever its length, and anything
// outside the Basic Multilingual Plane (most emoji) as two.
export const LIMIT = 280;
const LINK = 23;

export function postLength(text) {
  let n = 0;
  for (const word of text.split(/(\s+)/)) {
    if (/^https?:\/\/\S+$/.test(word)) { n += LINK; continue; }
    for (const ch of word) n += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return n;
}

const TAGS = '#gamedev #indiedev';

export function templatePost(pr, link) {
  const title = pr.title.trim().replace(/[.\s]+$/, '');
  const tail = `\n\n${link} ${TAGS}`;
  let text = `ASHFALL dev log: ${title}.${tail}`;
  if (postLength(text) > LIMIT) {
    // Cut the title at a word, leaving room for the ellipsis.
    const room = LIMIT - postLength(`ASHFALL dev log: …${tail}`);
    let cut = '';
    for (const word of title.split(' ')) {
      const next = cut ? `${cut} ${word}` : word;
      if (postLength(next) > room) break;
      cut = next;
    }
    text = `ASHFALL dev log: ${cut}…${tail}`;
  }
  return text;
}

// The voice is a file of its own so it can be changed without touching code.
const VOICE = readFileSync(new URL('./voice.md', import.meta.url), 'utf8');

// Asks Claude for a post. `register` is 'diary' or 'radio' (voice.md), `brief`
// says what this post is for, `material` is what it may draw on, and
// `recent` is what the account said lately, so it does not repeat itself.
export async function claudeWrite({ register, brief, material, recent = [] }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const lately = recent.length
    ? `\n\nRecent posts from the account. Do not repeat their openings, jokes or topics:\n${recent.map((r) => `---\n${r}`).join('\n')}`
    : '';
  const response = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: VOICE,
    messages: [{
      role: 'user',
      content: `Write one ${register} post.\n\n${brief}\n\nMaterial:\n${material}${lately}`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write the post');
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^"(.*)"$/s, '$1');
  if (!text) throw new Error('Claude returned no text');
  return text;
}

// The text with its link, or null if Claude could not fit it into a post.
export function withLink(text, link) {
  const post = link ? `${text}\n\n${link}` : text;
  return postLength(post) <= LIMIT ? post : null;
}

export async function draftPost(pr, link, recent = []) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const text = withLink(await claudeWrite({
        register: 'diary',
        brief: 'A pull request was just merged. Say what changed in the game, as a player would notice it. If the change is only internal, say what it makes possible or better.',
        material: `Title: ${pr.title}\n\nDescription:\n${pr.body || '(none)'}`,
        recent,
      }), link);
      if (text) return { text, by: 'claude' };
      console.warn("Claude's post came back too long; using the template");
    } catch (err) {
      console.warn(`Claude could not draft the post (${err.message}); using the template`);
    }
  }
  return { text: templatePost(pr, link), by: 'template' };
}
