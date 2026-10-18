// What the devlog keeps on GitHub, and how it reads it back.
//
// Every draft is a record: on a merged PR it is a comment on the PR, and for
// a scheduled post it is the body of an issue labelled `devlog`. A record
// opens with a marker that says whether it is a draft or was posted, and
// holds the post's text in a ```text block, which is what gets posted, so
// editing the block edits the post.
import { postLength, LIMIT } from './draft.js';

const env = process.env;
const API = 'https://api.github.com';
export const MARK = '<!-- ashfall-devlog';
export const LABEL = 'devlog';

export async function gh(path, init = {}) {
  const res = await fetch(`${API}${path.replace('{repo}', env.GITHUB_REPOSITORY)}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// The record on issue or PR `number`: { kind: 'issue' | 'comment', id, body,
// issue }, or null if there is none.
export async function findRecord(number) {
  const issue = await gh(`/repos/{repo}/issues/${number}`);
  if (issue.body?.startsWith(MARK)) return { kind: 'issue', id: number, body: issue.body, issue };
  const comments = await gh(`/repos/{repo}/issues/${number}/comments?per_page=100`);
  const c = comments.find((x) => x.body.startsWith(MARK));
  return c ? { kind: 'comment', id: c.id, body: c.body, issue } : null;
}

export async function saveRecord(number, record, body) {
  if (record?.kind === 'issue') return gh(`/repos/{repo}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  if (record) return gh(`/repos/{repo}/issues/comments/${record.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  return gh(`/repos/{repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
}

export const isPosted = (record) => !!record?.body.startsWith(`${MARK} posted:`);

export function textIn(body) {
  const m = body?.match(/```text\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

const block = (text) => '```text\n' + text + '\n```';

export function draftBody(number, text, by, note = '') {
  const who = { claude: 'Claude', template: 'the template', hand: 'hand' }[by] ?? by;
  return `${MARK} draft -->
**Dev log draft** — not posted to X.${note ? `\n\n${note}` : ''}

${block(text)}

${postLength(text)}/${LIMIT} characters, written by ${who}. To post it, edit the text above if you want to, then run **Actions → Devlog → Run workflow** with \`${number}\` and **post** ticked.`;
}

export function postedBody(text, id, note = '') {
  const handle = env.DEVLOG_HANDLE;
  const url = handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
  return `${MARK} posted:${id} -->
**Posted to X:** ${url}${note ? `\n\n${note}` : ''}

${block(text)}`;
}

// What the account has said lately, newest first: the text of the latest
// devlog issues, and the titles of the latest PRs it drafted from.
export async function recentPosts(n = 10) {
  const items = await gh(`/repos/{repo}/issues?labels=${LABEL}&state=all&sort=created&direction=desc&per_page=${n}`);
  return items.map((i) => (i.pull_request ? `(a post about the update "${i.title}")` : textIn(i.body))).filter(Boolean);
}
