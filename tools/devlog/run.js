// The Devlog workflow's entry point (.github/workflows/devlog.yml).
//
// A merged pull request gets a draft post as a comment on it; schedule.js
// drafts posts on other topics as issues. Nothing goes to X unless one of two
// things says so:
//   - someone runs the workflow by hand with a PR or issue number and `post`
//     ticked, which posts the text in its draft (edit the draft to change
//     it); or
//   - the repo variable DEVLOG_AUTOPOST is `true`, which posts every draft as
//     soon as it is written.
import { readFile } from 'node:fs/promises';
import { draftPost, postLength, LIMIT } from './draft.js';
import { postToX, xConfigured } from './x.js';
import { gh, findRecord, saveRecord, isPosted, textIn, draftBody, postedBody, recentPosts, LABEL } from './github.js';

const env = process.env;

// Dependabot's bumps and anything labelled no-devlog are not news.
function skip(pr) {
  if (pr.user?.login?.endsWith('[bot]')) return `opened by ${pr.user.login}`;
  if (pr.labels?.some((l) => l.name === 'no-devlog')) return 'labelled no-devlog';
  return null;
}

export const link = () => env.DEVLOG_LINK || `https://github.com/${env.GITHUB_REPOSITORY}`;

// Posts `text`, records it on `number`, and closes it if it is a draft issue.
export async function publish(number, text, record) {
  if (postLength(text) > LIMIT) throw new Error(`The post is ${postLength(text)} characters, over X's ${LIMIT}`);
  const id = await postToX(text);
  await saveRecord(number, record, postedBody(text, id));
  if (record?.kind === 'issue') {
    await gh(`/repos/{repo}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
  console.log(`Posted ${id}`);
}

async function onMerged(pr) {
  if (!pr.merged) return console.log('Closed without merging; nothing to say.');
  const why = skip(pr);
  if (why) return console.log(`Skipping #${pr.number}: ${why}.`);
  const record = await findRecord(pr.number);
  if (record) return console.log(`#${pr.number} already has a dev log record.`);
  const { text, by } = await draftPost(pr, link(), await recentPosts());
  console.log(`Draft (${by}, ${postLength(text)} characters):\n${text}`);
  // The label is what lets the scheduled posts see this one and not repeat it.
  await gh(`/repos/{repo}/issues/${pr.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [LABEL] }) });
  if (env.DEVLOG_AUTOPOST === 'true') {
    if (!xConfigured()) throw new Error('DEVLOG_AUTOPOST is on but the X secrets are not all set');
    return publish(pr.number, text, null);
  }
  await saveRecord(pr.number, null, draftBody(pr.number, text, by));
}

async function onDispatch() {
  const number = Number(env.INPUT_NUMBER);
  if (!Number.isInteger(number) || number < 1) throw new Error(`"${env.INPUT_NUMBER}" is not a PR or issue number`);
  const record = await findRecord(number);
  const override = env.INPUT_TEXT?.trim();

  if (env.INPUT_POST !== 'true') {
    // Draft again, replacing an earlier draft but never a posted record.
    if (isPosted(record)) throw new Error(`#${number} was already posted`);
    let draft;
    if (override) draft = { text: override, by: 'hand' };
    else if (record?.issue.pull_request || !record) {
      const pr = await gh(`/repos/{repo}/pulls/${number}`);
      draft = await draftPost(pr, link(), await recentPosts());
    } else {
      throw new Error(`#${number} is a scheduled draft; give the text input, or run Devlog schedule for a new one`);
    }
    await saveRecord(number, record, draftBody(number, draft.text, draft.by));
    return console.log(`Draft saved on #${number}:\n${draft.text}`);
  }

  if (isPosted(record) && !override) {
    throw new Error(`#${number} was already posted; give the text input to post again on purpose`);
  }
  const text = override || textIn(record?.body);
  if (!text) throw new Error(`#${number} has no draft to post; run once without post to draft one`);
  await publish(number, text, record);
}

export async function main() {
  const name = env.GITHUB_EVENT_NAME;
  if (name === 'pull_request') {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    await onMerged(event.pull_request);
  } else if (name === 'workflow_dispatch') {
    await onDispatch();
  } else {
    throw new Error(`Not written for ${name} events`);
  }
}

// Run only as the entry point, so schedule.js and the checks can import it.
if (import.meta.url === `file://${process.argv[1]}`) await main();
