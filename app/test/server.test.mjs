// Company server (phase 0): health check, phone page, phone notifications for approvals,
// the activity log and the sign-in limit. A recurring task runs and asks for approval
// with no desktop app open at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');

// Stands in for web-push: records what would reach each phone.
const pushed = [];
const pushSender = {
  sendNotification: async (sub, body) => {
    if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, ...JSON.parse(body) });
  },
};

let engine;
let owner;
let staff;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-srv-'));

async function call(method, url, body, tk = owner) {
  const res = await fetch(engine.url + url, {
    method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* a page, not JSON */ }
  return { status: res.status, data, text };
}
async function api(method, url, body, tk) {
  const r = await call(method, url, body, tk);
  if (r.status >= 400) throw Object.assign(new Error(r.data && r.data.error), { status: r.status });
  return r.data;
}
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const sub = (name) => ({ endpoint: `https://push.example.test/${name}`, keys: { p256dh: 'BKey', auth: 'auth' } });

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }), pushSender });
  owner = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null)).token;
  staff = (await api('POST', '/api/login', { email: 'sam@northwind.test', password: 'kenjiflow-demo' }, null)).token;
});
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('health check and the phone page are public; the desktop UI is not served', async () => {
  const health = await call('GET', '/api/health', null, null);
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.ai, 'demo');
  const page = await call('GET', '/m/', null, null);
  assert.equal(page.status, 200);
  assert.match(page.text, /KenjiFlow Approvals/);
  assert.equal((await call('GET', '/m/sw.js', null, null)).status, 200);
  assert.equal((await call('GET', '/index.html', null, null)).status, 404, 'the full UI only with --serve-ui');
});

test('a recurring task runs on the server, asks for approval and reaches the right phones', async () => {
  const { key } = await api('GET', '/api/push/key', null, owner);
  assert.ok(key.length > 40, 'VAPID public key');
  await api('POST', '/api/push/subscribe', { subscription: sub('owner-phone'), label: 'iPhone' }, owner);
  await api('POST', '/api/push/subscribe', { subscription: sub('owner-gone'), label: 'old phone' }, owner);
  await api('POST', '/api/push/subscribe', { subscription: sub('staff-phone'), label: 'Android phone' }, staff);
  await assert.rejects(api('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure' } }, owner), { status: 400 });

  const { bots } = await api('GET', '/api/bootstrap', null, owner);
  const finance = bots.find((b) => b.name === 'Finance'); // asks before every send
  const trg = await api('POST', '/api/triggers', { name: 'Overdue reminders', bot_id: finance.id, kind: 'schedule', schedule: { freq: 'daily', time: '09:00' }, instructions: 'Email a reminder for each overdue invoice' }, owner);
  await engine.store.setSetting('business', { ...(await engine.store.getSetting('business', {})), timezone: 'UTC' });
  await engine.triggers.tick(new Date('2031-01-03T09:01:00Z'));

  const task = await until(async () => (await api('GET', '/api/tasks', null, owner)).find((t) => t.title === 'Overdue reminders' && t.status === 'approval_needed'));
  const note = await until(() => pushed.find((p) => p.tag === task.id));
  assert.equal(note.endpoint, 'https://push.example.test/owner-phone');
  assert.equal(note.title, 'Approval needed · Finance');
  assert.equal(note.url, `/m/#${task.id}`);
  assert.ok(!pushed.some((p) => p.endpoint.endsWith('staff-phone')), 'staff can\'t approve sends, so they aren\'t woken up');
  const devices = await api('GET', '/api/push/devices', null, owner);
  assert.deepEqual(devices.map((d) => d.label), ['iPhone'], 'the dead subscription was dropped');

  await api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve' }, owner);
  await until(async () => (await api('GET', `/api/tasks/${task.id}`, null, owner)).status !== 'approval_needed');
  await api('DELETE', `/api/triggers/${trg.id}`, null, owner);
});

test('a test notification goes only to your own devices', async () => {
  pushed.length = 0;
  const { sent } = await api('POST', '/api/push/test', null, staff);
  assert.equal(sent, 1);
  assert.equal(pushed[0].endpoint, 'https://push.example.test/staff-phone');
});

test('the activity log is for Owners and KenjiFlow Admins', async () => {
  const rows = await api('GET', '/api/audit?limit=200', null, owner);
  const approved = rows.find((r) => r.action === 'approval.approve');
  assert.ok(approved);
  assert.equal(approved.actor_name, 'Maya Ruiz');
  assert.ok(rows.some((r) => r.action === 'push.subscribe'));
  await assert.rejects(api('GET', '/api/audit', null, staff), { status: 403 });
  const older = await api('GET', `/api/audit?limit=1&before=${encodeURIComponent(rows[0].created_at)}`, null, owner);
  assert.ok(older.length <= 1 && (!older.length || older[0].created_at < rows[0].created_at));
});

test('repeated wrong passwords are slowed down', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/login', { email: 'owner@northwind.test', password: 'nope' }, null)).status, 401);
  }
  const blocked = await call('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null);
  assert.equal(blocked.status, 429);
});
