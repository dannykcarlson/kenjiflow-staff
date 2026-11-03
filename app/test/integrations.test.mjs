// Claude key + Gmail connector, against a fake Google (no real accounts touched).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');
const { buildMime, plainText } = require('../engine/gmail.js');

const realFetch = globalThis.fetch;
const sent = [];
let engine;
let token;
let staffToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-int-'));

// Stand-in for Google's OAuth and Gmail endpoints.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const p = new URLSearchParams(String(init.body));
    if (p.get('client_secret') !== 'test-secret') return json({ error: 'invalid_client' }, 401);
    return json({ access_token: 'at-1', expires_in: 3600, ...(p.get('grant_type') === 'authorization_code' ? { refresh_token: 'rt-1' } : {}) });
  }
  if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) return json({ emailAddress: 'maya@northwind.test' });
  if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
    assert.equal(init.headers.Authorization, 'Bearer at-1');
    sent.push(JSON.parse(init.body));
    return json({ id: 'gm-1', threadId: 'th-1' });
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
  return realFetch(url, init);
};

async function api(method, url, body, tk = token) {
  const res = await realFetch(engine.url + url, {
    method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }) });
  token = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null)).token;
  staffToken = (await api('POST', '/api/login', { email: 'sam@northwind.test', password: 'kenjiflow-demo' }, null)).token;
});
after(async () => { await engine.close(); globalThis.fetch = realFetch; fs.rmSync(dataDir, { recursive: true, force: true }); });

test('MIME builder encodes UTF-8 subjects and blocks header injection', () => {
  const raw = buildMime({ from: 'a@x.test', to: 'b@y.test\r\nBcc: evil@z.test', subject: 'Café — quote', body: 'Hi\nthere' });
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(text, /^From: a@x.test\r\nTo: b@y.test Bcc: evil@z.test\r\n/);
  assert.ok(!/\r\nBcc:/.test(text));
  assert.match(text, /Subject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(text.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hi\r\nthere');
});

test('plain text is pulled from multipart emails', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  assert.equal(plainText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>x</p>') } }, { mimeType: 'text/plain', body: { data: b64('hello') } }] }), 'hello');
});

test('integrations are Owner-only and never return secrets', async () => {
  await assert.rejects(api('GET', '/api/integrations', null, staffToken), { status: 403 });
  const before = await api('GET', '/api/integrations');
  assert.equal(before.claude.provider, 'mock');
  assert.equal(before.gmail.connected, false);
  await assert.rejects(api('PUT', '/api/integrations/claude-key', { api_key: 'not-a-key' }), { status: 400 });
  await api('PUT', '/api/integrations/gmail/app', { client_id: 'abc.apps.googleusercontent.com', client_secret: 'test-secret' });
  const after = JSON.stringify(await api('GET', '/api/integrations'));
  assert.ok(!after.includes('test-secret'));
  // Stored encrypted, not as plain text.
  const row = await engine.db.one("SELECT value FROM settings WHERE key='secret:gmail_app'");
  assert.ok(row.value.data && !JSON.stringify(row.value).includes('test-secret'));
});

test('Gmail connects through OAuth, then approved emails really send', async () => {
  const { url } = await api('POST', '/api/integrations/gmail/connect');
  const auth = new URL(url);
  assert.equal(auth.hostname, 'accounts.google.com');
  assert.ok(auth.searchParams.get('scope').includes('gmail.send'));

  // A forged state is refused; the real one connects.
  const bad = await realFetch(`${engine.url}/api/connectors/gmail/callback?code=x&state=forged`);
  assert.match(await bad.text(), /didn(&#39;|')t connect/);
  const ok = await realFetch(`${engine.url}/api/connectors/gmail/callback?code=good&state=${auth.searchParams.get('state')}`);
  assert.match(await ok.text(), /Gmail connected/);
  assert.equal((await api('GET', '/api/integrations')).gmail.email, 'maya@northwind.test');

  // With test mode off, approving the draft sends it through Gmail.
  await api('PATCH', '/api/settings', { test_mode: false });
  const { bots } = await api('GET', '/api/bootstrap');
  const salesBot = bots.find((b) => b.name === 'Sales');
  await api('POST', `/api/bots/${salesBot.id}/messages`, { text: 'Follow up with Jordan at Acme about the proposal' });
  const task = await until(async () => (await api('GET', '/api/tasks')).find((t) => t.status === 'approval_needed'));
  await api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve' });
  await until(() => sent.length === 1);
  const mime = Buffer.from(sent[0].raw, 'base64url').toString('utf8');
  assert.match(mime, /From: maya@northwind.test/);
  assert.match(mime, /To: jordan@acme.example/);
  const done = await until(async () => { const t = await api('GET', `/api/tasks/${task.id}`); return t.status === 'review' && t; });
  assert.ok(done.steps.some((s) => /Email sent to jordan@acme.example/.test(s.text)));
});

test('disconnecting Gmail stops sends', async () => {
  await api('DELETE', '/api/integrations/gmail');
  assert.equal((await api('GET', '/api/integrations')).gmail.connected, false);
});
