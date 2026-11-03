// Gmail connector. Each client creates an "Internal" OAuth app in their own Google
// Workspace (no Google verification needed), pastes its client ID/secret into
// Settings, then clicks Connect. Tokens are stored encrypted on the engine.
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const STATE_TTL = 10 * 60 * 1000;

function createGmail({ store, secrets, publicUrl }) {
  const pending = new Map(); // OAuth state -> { userId, at }
  let access = null; // { token, expires }

  const redirectUri = () => `${publicUrl()}/api/connectors/gmail/callback`;

  async function status() {
    const app = await secrets.get('gmail_app');
    const conn = await store.getSetting('connector_gmail', null);
    return { configured: !!(app && app.client_id), client_id: app ? app.client_id : '', connected: !!conn, email: conn ? conn.email : null, redirect_uri: redirectUri() };
  }

  async function saveApp({ client_id, client_secret }) {
    const existing = (await secrets.get('gmail_app')) || {};
    await secrets.set('gmail_app', { client_id: client_id.trim(), client_secret: (client_secret || existing.client_secret || '').trim() });
  }

  async function authUrl(user) {
    const app = await secrets.get('gmail_app');
    if (!app || !app.client_id || !app.client_secret) throw httpError(400, 'Add the Google OAuth client ID and secret first');
    const state = crypto.randomBytes(24).toString('base64url');
    pending.set(state, { userId: user.id, at: Date.now() });
    const params = new URLSearchParams({
      client_id: app.client_id, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    return `${AUTH_URL}?${params}`;
  }

  // Google redirects the browser here after the person consents.
  async function finish({ code, state, error }) {
    const p = pending.get(state);
    pending.delete(state);
    if (!p || Date.now() - p.at > STATE_TTL) throw httpError(400, 'This sign-in link expired. Start again from Settings.');
    if (error) throw httpError(400, `Google said: ${error}`);
    const app = await secrets.get('gmail_app');
    const tok = await tokenRequest({ code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
    if (!tok.refresh_token) throw httpError(400, 'Google did not return a refresh token. Remove KenjiFlow from the account\'s third-party access and try again.');
    access = { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 };
    const profile = await gfetch(`${API}/profile`);
    await secrets.set('gmail_tokens', { refresh_token: tok.refresh_token });
    await store.setSetting('connector_gmail', { email: profile.emailAddress, connected_at: new Date().toISOString(), connected_by: p.userId });
    await store.audit('user', p.userId, 'connector.gmail.connect', { email: profile.emailAddress });
    await store.postFeed({ kind: 'connector', importance: 'important', summary: `Gmail connected (${profile.emailAddress})` });
    return profile.emailAddress;
  }

  async function disconnect(user) {
    const tokens = await secrets.get('gmail_tokens');
    if (tokens) {
      // Revoke at Google too, so the grant doesn't linger on the account.
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token)}`, { method: 'POST' }).catch(() => {});
    }
    await secrets.remove('gmail_tokens');
    await store.setSetting('connector_gmail', null);
    access = null;
    await store.audit('user', user.id, 'connector.gmail.disconnect');
  }

  async function tokenRequest(body) {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, `Google token error: ${data.error_description || data.error || res.status}`);
    return data;
  }

  async function accessToken() {
    if (access && access.expires > Date.now()) return access.token;
    const app = await secrets.get('gmail_app');
    const tokens = await secrets.get('gmail_tokens');
    if (!app || !tokens) throw httpError(409, 'Gmail is not connected');
    const tok = await tokenRequest({ refresh_token: tokens.refresh_token, client_id: app.client_id, client_secret: app.client_secret, grant_type: 'refresh_token' });
    access = { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 };
    return access.token;
  }

  async function gfetch(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await accessToken()}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, `Gmail error: ${(data.error && data.error.message) || res.status}`);
    return data;
  }

  async function send({ to, subject, body, cc, inReplyTo, threadId }) {
    const conn = await store.getSetting('connector_gmail', null);
    if (!conn) throw httpError(409, 'Gmail is not connected');
    const raw = buildMime({ from: conn.email, to, cc, subject, body, inReplyTo });
    const sent = await gfetch(`${API}/messages/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    });
    return { id: sent.id, threadId: sent.threadId, from: conn.email };
  }

  async function search(query, max = 10) {
    const list = await gfetch(`${API}/messages?${new URLSearchParams({ q: query || 'in:inbox', maxResults: String(Math.min(25, Math.max(1, max))) })}`);
    const ids = (list.messages || []).map((m) => m.id);
    const out = [];
    for (const id of ids) {
      const m = await gfetch(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      const h = headerMap(m.payload);
      out.push({ id: m.id, thread_id: m.threadId, from: h.from, to: h.to, subject: h.subject, date: h.date, snippet: m.snippet, unread: (m.labelIds || []).includes('UNREAD') });
    }
    return out;
  }

  async function read(id) {
    const m = await gfetch(`${API}/messages/${encodeURIComponent(id)}?format=full`);
    const h = headerMap(m.payload);
    return { id: m.id, thread_id: m.threadId, from: h.from, to: h.to, subject: h.subject, date: h.date, message_id: h['message-id'], body: plainText(m.payload).slice(0, 20000) };
  }

  return { status, saveApp, authUrl, finish, disconnect, send, search, read, SCOPES };
}

function headerMap(payload = {}) {
  return Object.fromEntries((payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
}

// Prefer the text/plain part anywhere in the message; fall back to stripped HTML.
function plainText(payload) {
  const find = (part, type) => {
    if (!part) return null;
    if (part.mimeType === type && part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
    for (const p of part.parts || []) {
      const t = find(p, type);
      if (t) return t;
    }
    return null;
  };
  const text = find(payload, 'text/plain');
  if (text) return text;
  const html = find(payload, 'text/html');
  return html ? html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// RFC 2822 message, base64url-encoded as Gmail's API expects.
function buildMime({ from, to, cc, subject, body, inReplyTo }) {
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection
  const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const lines = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    ...(cc ? [`Cc: ${clean(cc)}`] : []),
    `Subject: ${encodeHeader(clean(subject))}`,
    ...(inReplyTo ? [`In-Reply-To: ${clean(inReplyTo)}`, `References: ${clean(inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(body || '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createGmail, buildMime, plainText };
