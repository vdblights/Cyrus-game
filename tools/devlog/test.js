// `npm test` in this folder. Nothing here reaches GitHub, X or Claude: fetch
// is replaced with a fake that records what would have been sent.
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signature, authHeader } from './x.js';
import { postLength, templatePost, LIMIT } from './draft.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await check('the signature matches the worked example in X\'s OAuth 1.0a docs', () => {
  const params = {
    include_entities: 'true',
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  };
  const sig = signature('POST', 'https://api.twitter.com/1.1/statuses/update.json', params,
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
  assert.equal(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

await check('the header carries every oauth field and the signature', () => {
  const env = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' };
  const h = authHeader('POST', 'https://api.x.com/2/tweets', env, { nonce: 'n', timestamp: '1' });
  for (const f of ['oauth_consumer_key="k"', 'oauth_nonce="n"', 'oauth_token="t"', 'oauth_timestamp="1"', 'oauth_signature="']) {
    assert.ok(h.includes(f), `${f} missing from ${h}`);
  }
});

await check('a link counts 23 characters and an emoji two, as X counts them', () => {
  assert.equal(postLength('hi https://example.com/a/very/long/path/indeed'), 3 + 23);
  assert.equal(postLength('🔥'), 2);
});

await check('the template fits a post, however long the title', () => {
  const link = 'https://github.com/vdblights/Cyrus-game';
  const short = templatePost({ title: 'Doors open and close.' }, link);
  assert.equal(short, `ASHFALL dev log: Doors open and close.\n\n${link} #gamedev #indiedev`);
  const long = templatePost({ title: 'word '.repeat(100) }, link);
  assert.ok(postLength(long) <= LIMIT, `${postLength(long)} characters`);
  assert.ok(long.includes('…'));
});

// run.js and schedule.js read their inputs from the environment.
const run = (await import('./run.js')).main;
const schedule = await import('./schedule.js');
const dir = await mkdtemp(join(tmpdir(), 'devlog-'));
let events = 0;

const BASE = {
  GITHUB_REPOSITORY: 'vdblights/Cyrus-game', GITHUB_TOKEN: 'gh', DEVLOG_LINK: 'https://example.com/play',
  ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '', DEVLOG_AUTOPOST: '', DEVLOG_HANDLE: '',
  X_API_KEY: '', X_API_SECRET: '', X_ACCESS_TOKEN: '', X_ACCESS_TOKEN_SECRET: '',
  INPUT_NUMBER: '', INPUT_POST: '', INPUT_TEXT: '', INPUT_TOPIC: '', GITHUB_RUN_NUMBER: '',
};

// Runs `main` with `env` over the base, answering requests from `routes`
// ([method, url pattern, response]) and recording every request made.
async function drive(main, env, routes) {
  const sent = [];
  const before = {};
  for (const [k, v] of Object.entries({ ...BASE, ...env })) { before[k] = process.env[k]; process.env[k] = v; }
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    sent.push({ url: String(url), method, body: init.body && JSON.parse(init.body) });
    const hit = routes.find(([m, re]) => m === method && re.test(String(url)));
    if (!hit) throw new Error(`unexpected ${method} ${url}`);
    const body = typeof hit[2] === 'function' ? hit[2](JSON.parse(init.body ?? 'null')) : hit[2];
    return {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body, text: async () => JSON.stringify(body),
    };
  };
  let error = null;
  try { await main(); } catch (e) { error = e; }
  for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { sent, error };
}

async function mergedEvent(pr) {
  const path = join(dir, `event${++events}.json`);
  await writeFile(path, JSON.stringify({ pull_request: pr }));
  return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path };
}

const PR = { number: 57, merged: true, title: 'Hang doors in some shop doorways', body: '', user: { login: 'vdblights' }, labels: [] };
const RECENT = ['GET', /issues\?labels=devlog/, []];
const NO_RECORD = [['GET', /issues\/57$/, { number: 57, body: 'A PR body', pull_request: {} }], ['GET', /issues\/57\/comments/, []]];

await check('a merged PR gets a draft comment and the devlog label, and nothing goes to X', async () => {
  const { sent, error } = await drive(run, await mergedEvent(PR), [
    ...NO_RECORD, RECENT,
    ['POST', /issues\/57\/labels/, []],
    ['POST', /issues\/57\/comments/, {}],
  ]);
  assert.equal(error, null);
  assert.ok(!sent.some((s) => s.url.includes('x.com')));
  const body = sent.find((s) => s.method === 'POST' && s.url.endsWith('comments')).body.body;
  assert.ok(body.startsWith('<!-- ashfall-devlog draft -->'));
  assert.ok(body.includes('ASHFALL dev log: Hang doors in some shop doorways.'));
});

await check('a closed PR, a bot\'s PR and a no-devlog PR get nothing', async () => {
  for (const pr of [{ ...PR, merged: false }, { ...PR, user: { login: 'dependabot[bot]' } }, { ...PR, labels: [{ name: 'no-devlog' }] }]) {
    const { sent, error } = await drive(run, await mergedEvent(pr), []);
    assert.equal(error, null);
    assert.equal(sent.length, 0);
  }
});

const X = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_TOKEN_SECRET: 'ts' };
const DRAFT = '<!-- ashfall-devlog draft -->\nDraft\n\n```text\nEdited by hand.\n\nhttps://example.com/play\n```\n\nfoot';
const POST = { ...X, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_NUMBER: '57', INPUT_POST: 'true' };

await check('posting by hand sends the text in the comment, as edited', async () => {
  const { sent, error } = await drive(run, { ...POST, DEVLOG_HANDLE: 'ashfallgame' }, [
    ['GET', /issues\/57$/, { number: 57, body: 'A PR body', pull_request: {} }],
    ['GET', /issues\/57\/comments/, [{ id: 9, body: DRAFT }]],
    ['POST', /api\.x\.com\/2\/tweets/, { data: { id: '123' } }],
    ['PATCH', /issues\/comments\/9/, {}],
  ]);
  assert.equal(error, null);
  assert.equal(sent.find((s) => s.url.includes('x.com')).body.text, 'Edited by hand.\n\nhttps://example.com/play');
  const patched = sent.find((s) => s.method === 'PATCH').body.body;
  assert.ok(patched.startsWith('<!-- ashfall-devlog posted:123 -->'));
  assert.ok(patched.includes('https://x.com/ashfallgame/status/123'));
});

await check('posting a scheduled draft posts the issue\'s text and closes the issue', async () => {
  const { sent, error } = await drive(run, POST, [
    ['GET', /issues\/57$/, { number: 57, body: DRAFT }],
    ['POST', /api\.x\.com\/2\/tweets/, { data: { id: '77' } }],
    ['PATCH', /issues\/57$/, {}],
  ]);
  assert.equal(error, null);
  const patches = sent.filter((s) => s.method === 'PATCH').map((s) => s.body);
  assert.ok(patches[0].body.startsWith('<!-- ashfall-devlog posted:77 -->'));
  assert.equal(patches[1].state, 'closed');
});

await check('a draft already posted is not posted twice by accident', async () => {
  const { sent, error } = await drive(run, POST, [
    ['GET', /issues\/57$/, { number: 57, body: '<!-- ashfall-devlog posted:123 -->\n```text\nx\n```' }],
  ]);
  assert.match(error?.message ?? '', /already posted/);
  assert.ok(!sent.some((s) => s.url.includes('x.com')));
});

await check('autopost posts a merged PR straight away, and only with every key set', async () => {
  const ok = await drive(run, { ...X, ...(await mergedEvent(PR)), DEVLOG_AUTOPOST: 'true' }, [
    ...NO_RECORD, RECENT,
    ['POST', /issues\/57\/labels/, []],
    ['POST', /api\.x\.com\/2\/tweets/, { data: { id: '5' } }],
    ['POST', /issues\/57\/comments/, {}],
  ]);
  assert.equal(ok.error, null);
  assert.ok(ok.sent.some((s) => s.url.includes('x.com')));
  const missing = await drive(run, { ...(await mergedEvent(PR)), DEVLOG_AUTOPOST: 'true', X_API_KEY: 'k' }, [
    ...NO_RECORD, RECENT, ['POST', /issues\/57\/labels/, []],
  ]);
  assert.match(missing.error?.message ?? '', /X secrets/);
});

await check('the scheduled topics read real material out of the repo', () => {
  const bullets = schedule.invariants();
  assert.ok(bullets.length > 40, `${bullets.length} invariants`);
  assert.ok(bullets.every((b) => b.startsWith('- **')));
  const notes = schedule.fieldNotes();
  assert.ok(notes.length >= 10 && notes.some((n) => n.includes("arm's reach")), JSON.stringify(notes));
  process.env.DEVLOG_LINK = 'https://example.com/play';
  for (const name of new Set(schedule.ROTATION)) {
    const t = schedule.TOPICS[name](3);
    assert.ok(t.material.length > 20 && ['diary', 'radio'].includes(t.register), name);
  }
  assert.match(schedule.TOPICS.seed(3).link, /^https:\/\/example\.com\/play\?seed=\d+$/);
  delete process.env.DEVLOG_LINK;
  assert.equal(schedule.TOPICS.seed(3), null, 'no seed post without a link to the game');
});

await check('with no Anthropic key the schedule drafts nothing', async () => {
  const { sent, error } = await drive(schedule.main, {}, []);
  assert.equal(error, null);
  assert.equal(sent.length, 0);
});

// Claude's API is answered by the same fake, at a base URL of its own.
const CLAUDE = (text) => ['POST', /claude\.test\/v1\/messages/, () => ({
  id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 },
})];

await check('a scheduled post is drafted in its voice as a devlog issue', async () => {
  const { sent, error } = await drive(schedule.main, { ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://claude.test', INPUT_TOPIC: 'tip' }, [
    ['GET', /issues\?labels=devlog/, [{ title: 'old', body: DRAFT }]],
    CLAUDE('WREN, HALCYON. Hold G to cook it. Not too long.'),
    ['POST', /repos\/vdblights\/Cyrus-game\/issues$/, { number: 80 }],
    ['PATCH', /issues\/80$/, {}],
  ]);
  assert.equal(error, null);
  const ask = sent.find((s) => s.url.includes('claude.test')).body;
  assert.ok(ask.system.includes('## Radio: posts from inside Carrow'), 'the voice is the system prompt');
  assert.ok(ask.messages[0].content.startsWith('Write one radio post.'));
  assert.ok(ask.messages[0].content.includes('Edited by hand.'), 'recent posts are passed on');
  const created = sent.find((s) => s.method === 'POST' && s.url.endsWith('/issues')).body;
  assert.deepEqual(created.labels, ['devlog']);
  const body = sent.find((s) => s.method === 'PATCH').body.body;
  assert.ok(body.includes('```text\nWREN, HALCYON. Hold G to cook it. Not too long.\n\nhttps://example.com/play\n```'));
  assert.ok(!sent.some((s) => s.url.includes('x.com')));
});

await check('a merged PR\'s draft comes from Claude when there is a key', async () => {
  const { sent, error } = await drive(run, { ...(await mergedEvent(PR)), ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://claude.test' }, [
    ...NO_RECORD, RECENT,
    CLAUDE('Some shop doorways have steel doors now. #gamedev'),
    ['POST', /issues\/57\/labels/, []],
    ['POST', /issues\/57\/comments/, {}],
  ]);
  assert.equal(error, null);
  assert.ok(sent.find((s) => s.url.includes('claude.test')).body.messages[0].content.startsWith('Write one diary post.'));
  assert.ok(sent.find((s) => s.url.endsWith('comments') && s.method === 'POST').body.body.includes('written by Claude'));
});

console.log(`${passed}/${passed} devlog checks passed`);
