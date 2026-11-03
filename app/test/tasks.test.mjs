// Task editing, notes, people-only "done", auto descriptions and task templates (mock model).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');
const { runTool } = require('../engine/tools.js');

let engine;
let token;
let staffToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-tasks-'));

async function api(method, url, body, tk = token) {
  const res = await fetch(engine.url + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
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
const login = async (email) => (await fetch(`${engine.url}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'kenjiflow-demo' }),
}).then((r) => r.json())).token;

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }) });
  token = await login('owner@northwind.test');
  staffToken = await login('sam@northwind.test');
});
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('bots can only suggest done; a person marks it done', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const bot = await engine.store.getBot(bots[0].id);
  const task = await engine.store.createTask({ title: 'Send the deck', bot_id: bot.id, status: 'in_progress' });
  const out = await runTool('update_task', { task_id: task.id, status: 'done', result: 'Sent' }, { store: engine.store, bot });
  assert.equal(out.result.status, 'review');
  assert.equal((await engine.store.getTask(task.id)).status, 'review');

  const done = await api('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
  assert.equal(done.status, 'done');
  const again = await runTool('update_task', { task_id: task.id, status: 'in_progress' }, { store: engine.store, bot }).catch((e) => e);
  assert.match(again.message, /already done/);
});

test('titles are editable, notes are kept, descriptions fill in', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const task = await api('POST', '/api/tasks', { title: 'Tidy CRM', instructions: 'Merge duplicate contacts in HubSpot. Then fill gaps.' });
  const described = await until(async () => { const t = await api('GET', `/api/tasks/${task.id}`); return t.description && t; });
  assert.equal(described.description, 'Merge duplicate contacts in HubSpot.');

  const renamed = await api('PATCH', `/api/tasks/${task.id}`, { title: '  Tidy HubSpot  ' });
  assert.equal(renamed.title, 'Tidy HubSpot');
  await assert.rejects(api('PATCH', `/api/tasks/${task.id}`, { title: '   ' }), { status: 400 });

  const detail = await api('POST', `/api/tasks/${task.id}/notes`, { text: 'Skip the Acme contacts' }, staffToken);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].text, 'Skip the Acme contacts');
  assert.equal(detail.notes[0].user_name, 'Sam Patel');
  await assert.rejects(api('POST', `/api/tasks/${task.id}/notes`, { text: ' ' }), { status: 400 });
  assert.ok(bots.length);
});

test('templates seed from the pack, can be edited with files, and start tasks', async () => {
  const seeded = await api('GET', '/api/templates');
  assert.equal(seeded.length, 5);
  assert.ok(seeded.every((t) => t.bot_id), 'pack templates find their bots');

  const file = await fetch(`${engine.url}/api/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'X-File-Name': 'checklist.txt' }, body: 'Step 1: welcome email',
  }).then((r) => r.json());
  const { bots } = await api('GET', '/api/bootstrap');
  const tpl = await api('POST', '/api/templates', { title: 'Onboard a client', instructions: 'Follow the checklist.', bot_id: bots[0].id, file_ids: [file.id] });
  assert.equal(tpl.files[0].name, 'checklist.txt');
  await assert.rejects(api('POST', '/api/templates', { title: 'Nope' }, staffToken), { status: 403 });
  const edited = await api('PATCH', `/api/templates/${tpl.id}`, { title: 'Onboard a new client', priority: 'high' });
  assert.equal(edited.title, 'Onboard a new client');

  const task = await api('POST', `/api/templates/${tpl.id}/use`, {}, staffToken);
  assert.equal(task.title, 'Onboard a new client');
  assert.equal(task.priority, 'high');
  // The bot is told about the file and can read it.
  const history = await until(async () => {
    const h = await engine.store.apiHistory(bots[0].id);
    return h.some((m) => m.content.some((c) => c.text && c.text.includes(file.id))) && h;
  });
  assert.ok(history);
  const bot = await engine.store.getBot(bots[0].id);
  const read = await runTool('read_file', { file_id: file.id }, { store: engine.store, bot });
  assert.equal(read.result.text, 'Step 1: welcome email');

  await api('DELETE', `/api/templates/${tpl.id}`);
  assert.equal((await api('GET', '/api/templates')).length, 5);
});
