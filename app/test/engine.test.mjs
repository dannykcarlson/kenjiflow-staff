// End-to-end engine tests against the mock model (no API key, in-memory Postgres).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');

let engine;
let token;
let staffToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-test-'));

async function api(method, url, body, tk = token) {
  const res = await fetch(engine.url + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

// Bot turns run in the background; wait until a condition holds.
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
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('rejects bad logins and unauthenticated calls', async () => {
  await assert.rejects(api('POST', '/api/login', { email: 'owner@northwind.test', password: 'nope' }, null), { status: 401 });
  await assert.rejects(api('GET', '/api/bots', null, null), { status: 401 });
});

test('seeds the B2B pack bots', async () => {
  const { bots, user } = await api('GET', '/api/bootstrap');
  assert.equal(user.role, 'owner');
  assert.deepEqual(bots.map((b) => b.name), ['Chief of Staff', 'Sales', 'Finance', 'Inbox']);
});

test('bots can be renamed and recoloured; bad input is refused', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const sales = bots.find((b) => b.name === 'Sales');
  const renamed = await api('PATCH', `/api/bots/${sales.id}`, { name: 'Sunny', avatar: { variant: 'orb', body: '#8B5CF6', eye: '#FFFFFF', accent: '#22D3EE' } });
  assert.equal(renamed.name, 'Sunny');
  assert.equal(renamed.avatar.variant, 'orb');
  assert.equal(renamed.avatar.body, '#8B5CF6');
  await assert.rejects(api('PATCH', `/api/bots/${sales.id}`, { name: '' }), { status: 400 });
  await assert.rejects(api('PATCH', `/api/bots/${sales.id}`, { name: 'X' }, staffToken), { status: 403 });
  await api('PATCH', `/api/bots/${sales.id}`, { name: 'Sales' });
});

test('questions get answers without creating a task', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const cos = bots.find((b) => b.name === 'Chief of Staff');
  const before = (await api('GET', '/api/tasks')).length;
  await api('POST', `/api/bots/${cos.id}/messages`, { text: "What's in the pipeline this week?" });
  await until(async () => (await api('GET', `/api/bots/${cos.id}/messages`)).some((m) => m.role === 'assistant'));
  assert.equal((await api('GET', '/api/tasks')).length, before);
});

test('an action request creates a task, asks for approval, and finishes once approved', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const sales = bots.find((b) => b.name === 'Sales');
  await api('POST', `/api/bots/${sales.id}/messages`, { text: 'Follow up with Jordan at Acme about the proposal' });
  const task = await until(async () => (await api('GET', '/api/tasks')).find((t) => t.bot_id === sales.id && t.status === 'approval_needed'));
  assert.equal(task.approval.action, 'send_email');

  // Staff can't approve outgoing email; the Owner can.
  await assert.rejects(api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve' }, staffToken), { status: 403 });
  await api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve', edits: { subject: 'Following up on our proposal' } });
  const done = await until(async () => { const t = await api('GET', `/api/tasks/${task.id}`); return t.status === 'review' && t; });
  assert.equal(done.approval.payload.subject, 'Following up on our proposal');
  assert.ok(done.approval.edited);
  assert.ok(done.steps.some((s) => /recorded, not done \(test mode is on\)/.test(s.text)));

  const feed = await api('GET', '/api/feed');
  assert.ok(feed.some((f) => f.kind === 'approval_requested' && f.task_id === task.id));
});

test('feedback questions pause a task until answered', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const sales = bots.find((b) => b.name === 'Sales');
  await api('POST', `/api/bots/${sales.id}/messages`, { text: 'Send Acme a quote for the website refresh' });
  const task = await until(async () => (await api('GET', '/api/tasks')).find((t) => t.status === 'awaiting_feedback'));
  await api('POST', `/api/tasks/${task.id}/feedback`, { answer: '$12,000, 50% deposit' });
  await until(async () => (await api('GET', `/api/tasks/${task.id}`)).status === 'review');
});

test('documents become artifacts with versions', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const cos = bots.find((b) => b.name === 'Chief of Staff');
  await api('POST', `/api/bots/${cos.id}/messages`, { text: 'Draft the weekly round-up report' });
  const art = await until(async () => (await api('GET', '/api/artifacts'))[0]);
  const v2 = await api('POST', `/api/artifacts/${art.id}/versions`, { content: '# Edited', note: 'Tightened intro' });
  assert.equal(v2.versions[0].version, 2);
  assert.equal(v2.versions.length, 2);
});

test('files filter by who uploaded them', async () => {
  const res = await fetch(`${engine.url}/api/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv', 'X-File-Name': 'clients.csv' }, body: 'name,email\nAcme,a@acme.example',
  });
  assert.equal(res.status, 200);
  const mine = await api('GET', '/api/files?source=mine');
  assert.ok(mine.some((f) => f.name === 'clients.csv'));
  assert.equal((await api('GET', '/api/files?source=bots')).filter((f) => f.name === 'clients.csv').length, 0);
  assert.ok((await api('GET', '/api/files?source=team', null, staffToken)).some((f) => f.name === 'clients.csv'));
});

test('feed items track read state per user', async () => {
  const feed = await api('GET', '/api/feed?unread=1');
  assert.ok(feed.length > 0);
  await api('POST', `/api/feed/${feed[0].id}/read`, { read: true });
  assert.ok(!(await api('GET', '/api/feed?unread=1')).some((f) => f.id === feed[0].id));
  assert.ok((await api('GET', '/api/feed?unread=1', null, staffToken)).some((f) => f.id === feed[0].id));
  await api('POST', '/api/feed/read-all');
  assert.equal((await api('GET', '/api/feed?unread=1')).length, 0);
});
