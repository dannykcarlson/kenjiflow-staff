// Big jobs: heavy work handed to a Managed Agent (faked here), with a hard spend limit.
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

// A stand-in for the Anthropic client. Tests script what each session does next.
const fake = { environments: [], agents: [], sessions: {}, sent: [], uploads: 0 };
async function* items(list) { yield* list; }
const fakeClient = () => ({
  beta: {
    environments: { create: async (p) => { fake.environments.push(p); return { id: `env_${fake.environments.length}` }; } },
    agents: { create: async (p) => { fake.agents.push(p); return { id: `agent_${fake.agents.length}`, version: 1 }; } },
    files: {
      upload: async ({ file }) => { file.destroy(); fake.uploads++; return { id: `file_in_${fake.uploads}` }; },
      list: ({ scope_id: id }) => items(fake.sessions[id].outputs),
      download: async () => ({ arrayBuffer: async () => new TextEncoder().encode('region,total\nnorth,10\n').buffer }),
    },
    sessions: {
      create: async (p) => {
        const id = `sesn_${Object.keys(fake.sessions).length + 1}`;
        fake.sessions[id] = { params: p, events: [], outputs: [], usage: {} };
        return { id };
      },
      retrieve: async (id) => ({ id, usage: fake.sessions[id].usage }),
      events: {
        send: async (id, { events }) => {
          fake.sent.push(...events.map((e) => ({ session: id, ...e })));
          if (events[0].type === 'user.message') fake.sessions[id].events.push({ ...events[0], processed_at: '2026-11-06T10:00:00Z' });
        },
        list: (id, { types }) => items(fake.sessions[id].events.filter((e) => types.includes(e.type))),
      },
    },
  },
});
const idle = (type, extra = {}) => ({ type: 'session.status_idle', processed_at: '2026-11-06T10:05:00Z', stop_reason: { type, ...extra } });
const said = (text) => ({ type: 'agent.message', processed_at: '2026-11-06T10:04:00Z', content: [{ type: 'text', text }] });

let engine;
let owner;
let task;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-job-'));

async function api(method, url, body, tk = owner) {
  const res = await fetch(engine.url + url, {
    method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
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
async function setup(botName) {
  const { bots } = await api('GET', '/api/bootstrap');
  const bot = await engine.store.getBot(bots.find((b) => b.name === botName).id);
  task = await engine.store.createTask({ title: `Job for ${botName}`, bot_id: bot.id, status: 'in_progress', source: 'chat', created_by_type: 'user', created_by: null });
  return { store: engine.store, bot, user: null, connectors: engine.connectors, connected: {} };
}

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }), bigJobsFactory: fakeClient, bigJobsPollMs: 3600000 });
  owner = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null)).token;
});
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('a job runs in a capped sandbox, refuses paused steps, and its files land on the task', async () => {
  const ctx = await setup('Sales');
  const input = await engine.store.saveFile({ name: 'deals.csv', mime: 'text/csv', buffer: Buffer.from('a,b\n1,2\n'), source: 'upload', taskId: task.id });
  const out = await runTool('start_big_job', { task_id: task.id, title: 'Pipeline analysis', instructions: 'Total the deals by region', file_ids: [input.id] }, ctx);
  assert.equal(out.result.status, 'running');

  const session = fake.sessions.sesn_1;
  assert.deepEqual(session.params.budget, { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } });
  assert.deepEqual(session.params.resources, [{ type: 'file', file_id: 'file_in_1', mount_path: '/deals.csv' }]);
  assert.equal(fake.environments[0].config.networking.type, 'limited');
  const tools = fake.agents[0].tools[0];
  assert.deepEqual(tools.configs.map((c) => c.enabled), [false, false], 'no web by default');
  const message = fake.sent.find((e) => e.type === 'user.message');
  assert.match(message.content[0].text, /\/mnt\/session\/uploads\/deals\.csv/);

  // Still working: nothing happens.
  await engine.bigJobs.tick();
  assert.equal((await api('GET', `/api/tasks/${task.id}`)).big_jobs[0].status, 'running');

  // It pauses to ask: nobody is watching, so the step is refused, once.
  session.events.push(idle('requires_action', { event_ids: ['sevt_1'] }));
  await engine.bigJobs.tick();
  await engine.bigJobs.tick();
  const refused = fake.sent.filter((e) => e.type === 'user.tool_confirmation');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].result, 'deny');

  // It finishes: output saved, cost recorded, and the bot picks it up for review.
  session.events.push(said('North leads with 10.'), idle('end_turn'));
  session.outputs = [{ id: 'file_out_1', filename: 'summary.csv', mime_type: 'text/csv', size_bytes: 22, downloadable: true }];
  session.usage = { input_tokens: 1000, output_tokens: 200, list_cost: { amount: '137', currency: 'USD' } };
  await engine.bigJobs.tick();
  const done = await until(async () => { const t = await api('GET', `/api/tasks/${task.id}`); return t.status === 'review' && t; });
  const job = done.big_jobs[0];
  assert.equal(job.status, 'done');
  assert.equal(Number(job.cost_usd), 1.37);
  assert.equal(job.summary, 'North leads with 10.');
  assert.ok(done.files.some((f) => f.name === 'summary.csv' && f.source === 'bot'));
  assert.equal(Number(done.cost_usd), 1.37);
  const log = await api('GET', '/api/audit?limit=200');
  assert.ok(log.some((r) => r.action === 'big_job.finish'));
  await engine.bigJobs.tick();
  assert.equal((await api('GET', `/api/tasks/${task.id}`)).files.filter((f) => f.name === 'summary.csv').length, 1, 'a finished job is not collected twice');
});

test('web stays off until the Owner allows it, and the setup is reused', async () => {
  const ctx = await setup('Sales');
  const call = () => runTool('start_big_job', { task_id: task.id, title: 'Prospect research', instructions: 'Research 5 prospects', web: true }, ctx);
  await assert.rejects(call(), /Owner can allow it/);
  await assert.rejects(api('PATCH', '/api/settings', { big_jobs: { budget_usd: 500 } }), { status: 400 });
  await api('PATCH', '/api/settings', { big_jobs: { web: true, budget_usd: 2.5 } });
  await call();
  const made = fake.agents[fake.agents.length - 1];
  assert.deepEqual(made.tools[0].configs.map((c) => c.enabled), [true, true]);
  assert.equal(fake.environments[fake.environments.length - 1].config.networking.type, 'unrestricted');
  const session = fake.sessions.sesn_2;
  assert.equal(session.params.budget.max_list_cost.amount, '250');

  // Hitting the spend limit keeps what it made and says why.
  session.events.push(said('Partial research.'), idle('budget_reached'));
  await engine.bigJobs.tick();
  const job = (await api('GET', `/api/tasks/${task.id}`)).big_jobs[0];
  assert.equal(job.status, 'stopped');
  assert.match(job.error, /\$2\.50 limit/);

  const agents = fake.agents.length;
  await runTool('start_big_job', { task_id: task.id, title: 'Second job', instructions: 'More files work' }, ctx);
  assert.equal(fake.agents.length, agents, 'the agent is made once, not per job');
});

test('"Ask for everything" bots need approval to start a job', async () => {
  const ctx = await setup('Finance');
  const out = await runTool('start_big_job', { task_id: task.id, title: 'Invoice ageing', instructions: 'Age the invoices' }, ctx);
  assert.equal(out.result.status, 'approval_needed');
  assert.equal((await api('GET', `/api/tasks/${task.id}`)).big_jobs.length, 0);
  await api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve' });
  const jobs = await until(async () => { const j = (await api('GET', `/api/tasks/${task.id}`)).big_jobs; return j.length && j; });
  assert.equal(jobs[0].status, 'running');
});

test('the Stop button and the kill switch interrupt running jobs', async () => {
  const ctx = await setup('Sales');
  await runTool('start_big_job', { task_id: task.id, title: 'Stop me', instructions: 'Long work' }, ctx);
  const job = (await api('GET', `/api/tasks/${task.id}`)).big_jobs[0];
  await api('POST', `/api/big-jobs/${job.id}/stop`);
  assert.ok(fake.sent.some((e) => e.type === 'user.interrupt'));
  const row = await engine.bigJobs.get(job.id);
  fake.sessions[row.session_id].events.push(idle('end_turn'));
  await engine.bigJobs.tick();
  const stopped = (await api('GET', `/api/tasks/${task.id}`)).big_jobs[0];
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.error, /Maya Ruiz stopped it/);

  const before = fake.sent.filter((e) => e.type === 'user.interrupt').length;
  await api('POST', '/api/kill-switch', { paused: true });
  await engine.bigJobs.tick();
  assert.ok(fake.sent.filter((e) => e.type === 'user.interrupt').length > before, 'jobs still running get stopped');
  const ctx2 = await setup('Sales');
  await assert.rejects(runTool('start_big_job', { task_id: task.id, title: 'No', instructions: 'No' }, ctx2), /paused/);
  await api('POST', '/api/kill-switch', { paused: false });
});
