// Posts to X as the account whose keys are in the environment, signed with
// OAuth 1.0a (user context), which is what POST /2/tweets takes for a bot
// posting as itself. No dependencies: the signature is HMAC-SHA1 over the
// request, and a JSON body is not part of it.
import { createHmac, randomBytes } from 'node:crypto';

const KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
const ENDPOINT = 'https://api.x.com/2/tweets';

export function xConfigured(env = process.env) {
  return KEYS.every((k) => env[k]);
}

// RFC 3986, which encodeURIComponent is short of by five characters.
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signature(method, url, params, consumerSecret, tokenSecret) {
  const base = [
    method.toUpperCase(),
    pct(url),
    pct(Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&')),
  ].join('&');
  return createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
}

export function authHeader(method, url, env, extra = {}) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: extra.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: extra.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = signature(method, url, { ...oauth, ...(extra.query ?? {}) },
    env.X_API_SECRET, env.X_ACCESS_TOKEN_SECRET);
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}

// Returns the new post's id.
export async function postToX(text, env = process.env) {
  if (!xConfigured(env)) throw new Error(`X is not set up: missing ${KEYS.filter((k) => !env[k]).join(', ')}`);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: authHeader('POST', ENDPOINT, env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X answered ${res.status}: ${body}`);
  return JSON.parse(body).data.id;
}
