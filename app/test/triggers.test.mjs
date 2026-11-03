// Triggers: schedules and app events start bots on their own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');
const { dueSlot, describeSchedule, nextRunLabel, validSchedule, summarize } = require('../engine/triggers.js');

// Fake Composio with triggers: captures the realtime handler so tests can push events.
const fake = { handler: null, created: [], deleted: [] };
const fakeComposio = () => ({
  connectedAccounts: {
    list: async ({ userIds } = {}) => ({ items: [{ id: 'ca_gmail', userId: userIds && userIds[0], toolkit: { slug: 'gmail' }, status: 'ACTIVE', createdAt: '2026-11-01T00:00:00Z' }] }),
  },
  triggers: {
    listTypes: async () => ({ items: [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New Gmail message', description: 'A new email arrived', config: { type: 'object', properties: { labelIds: { type: 'string' } } } }] }),
    create: async (userId, slug, body) => { fake.created.push({ userId, slug, body }); return { triggerId: 'ti_1' }; },
    delete: async (id) => { fake.deleted.push(id); },
    enable: async () => {}, disable: async () => {},
    subscribe: async (fn) => { fake.handler = fn; },
  },
});

let engine;
let owner;
let staff;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-trg-'));

async function api(method, url, body, tk = owner) {
  const res = await fetch(engine.url + url, {
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
  process.env.COMPOSIO_API_KEY = 'ak_test_project_key_0001';
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }), composioFactory: fakeComposio });
  owner = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null)).token;
  staff = (await api('POST', '/api/login', { email: 'sam@northwind.test', password: 'kenjiflow-demo' }, null)).token;
});
after(async () => { delete process.env.COMPOSIO_API_KEY; await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('schedule maths: due slots, labels and next run', () => {
  const tue0905 = new Date('2026-11-03T09:05:00Z'); // a Tuesday
  assert.equal(dueSlot({ freq: 'weekdays', time: '09:00' }, tue0905, 'UTC'), '2026-11-03 09:00');
  assert.equal(dueSlot({ freq: 'weekdays', time: '10:00' }, tue0905, 'UTC'), null);
  assert.equal(dueSlot({ freq: 'weekly', day: 5, time: '09:00' }, tue0905, 'UTC'), null);
  assert.equal(dueSlot({ freq: 'hourly', minute: '00' }, tue0905, 'UTC'), '2026-11-03 09:00');
  assert.equal(dueSlot({ freq: 'weekdays', time: '09:00' }, new Date('2026-11-07T12:00:00Z'), 'UTC'), null, 'not on Saturday');
  assert.equal(describeSchedule({ freq: 'weekly', day: 5, time: '15:00' }), 'Fridays at 15:00');
  assert.equal(nextRunLabel({ freq: 'daily', time: '09:00' }, tue0905, 'UTC'), 'Wed 09:00');
  assert.equal(nextRunLabel({ freq: 'daily', time: '17:00' }, tue0905, 'UTC'), 'Today 17:00');
  assert.equal(nextRunLabel({ freq: 'weekly', day: 5, time: '15:00' }, tue0905, 'UTC'), 'Fri 15:00');
  assert.ok(validSchedule({ freq: 'daily', time: '9am' }));
  assert.equal(summarize({ triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', payload: { sender: 'jordan@acme.example', subject: 'Proposal question' } }), 'New gmail message from jordan@acme.example “Proposal question”');
});

test('staff can see triggers but not create them; bad schedules are refused', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  await assert.rejects(api('POST', '/api/triggers', { name: 'x', bot_id: bots[0].id, kind: 'schedule', schedule: { freq: 'daily', time: '09:00' } }, staff), { status: 403 });
  await assert.rejects(api('POST', '/api/triggers', { name: 'x', bot_id: bots[0].id, kind: 'schedule', schedule: { freq: 'daily', time: '25:00' } }), { status: 400 });
});

test('a schedule fires once per slot and the bot creates a task', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const finance = bots.find((b) => b.name === 'Finance');
  const trg = await api('POST', '/api/triggers', { name: 'Chase overdue invoices', bot_id: finance.id, kind: 'schedule', schedule: { freq: 'weekly', day: 5, time: '15:00' }, instructions: 'Chase anything 7+ days overdue' });
  assert.equal(trg.when, 'Fridays at 15:00');

  // Pretend it's Friday 15:01 UTC: fires once, a second tick in the same slot does nothing.
  await engine.store.setSetting('business', { ...(await engine.store.getSetting('business', {})), timezone: 'UTC' });
  await engine.triggers.tick(new Date('2026-11-06T15:01:00Z'));
  await engine.triggers.tick(new Date('2026-11-06T15:20:00Z'));
  const task = await until(async () => (await api('GET', '/api/tasks')).find((t) => t.title === 'Chase overdue invoices' && t.status === 'review'));
  assert.equal(task.source, 'schedule');
  assert.equal(task.created_by_type, 'bot');
  const events = await api('GET', `/api/triggers/${trg.id}/events`);
  assert.equal(events.filter((e) => e.outcome === 'handed to bot').length, 1);
});

test('app events reach the bot, are de-duplicated and rate-limited', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const inbox = bots.find((b) => b.name === 'Inbox');
  const types = await api('GET', '/api/trigger-types?app=gmail');
  assert.equal(types[0].slug, 'GMAIL_NEW_GMAIL_MESSAGE');
  const trg = await api('POST', '/api/triggers', {
    name: 'Triage new email', bot_id: inbox.id, kind: 'app', max_per_hour: 2,
    app_event: { app: 'gmail', slug: 'GMAIL_NEW_GMAIL_MESSAGE', name: 'New Gmail message' }, instructions: 'Draft replies for routine mail',
  });
  assert.equal(fake.created[0].slug, 'GMAIL_NEW_GMAIL_MESSAGE');
  assert.match(fake.created[0].userId, /:workspace$/);
  assert.ok(fake.handler, 'subscribed to the event stream');

  const evt = (n) => ({ id: 'ti_1', uuid: `u${n}`, triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkitSlug: 'gmail', userId: 'x', payload: { sender: 'jordan@acme.example', subject: `Question ${n}` }, metadata: { id: 'ti_1' } });
  await fake.handler(evt(1));
  await fake.handler(evt(1)); // redelivered
  await fake.handler(evt(2));
  await fake.handler(evt(3)); // over the 2/hour limit
  const events = await api('GET', `/api/triggers/${trg.id}/events`);
  assert.deepEqual(events.map((e) => e.outcome).sort(), ['handed to bot', 'handed to bot', 'skipped: hourly limit']);
  const task = await until(async () => (await api('GET', '/api/tasks')).find((t) => t.title === 'Triage new email' && t.source === 'trigger'));
  assert.equal(task.bot_id, inbox.id);

  await api('DELETE', `/api/triggers/${trg.id}`);
  assert.deepEqual(fake.deleted, ['ti_1']);
});

test('turning a trigger off or pausing bots skips events', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const trg = await api('POST', '/api/triggers', { name: 'Morning brief', bot_id: bots[0].id, kind: 'schedule', schedule: { freq: 'daily', time: '08:00' } });
  await api('PATCH', `/api/triggers/${trg.id}`, { enabled: false });
  assert.equal((await api('POST', `/api/triggers/${trg.id}/run`)).outcome, 'skipped: trigger off');
  await api('PATCH', `/api/triggers/${trg.id}`, { enabled: true });
  await api('POST', '/api/kill-switch', { paused: true });
  assert.equal((await api('POST', `/api/triggers/${trg.id}/run`)).outcome, 'skipped: bots paused');
  await api('POST', '/api/kill-switch', { paused: false });
  assert.equal((await api('POST', `/api/triggers/${trg.id}/run`)).outcome, 'handed to bot');
});
