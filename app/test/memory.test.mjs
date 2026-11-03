// Long-term memory through Honcho (faked): bots record exchanges and recall what they learned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');

// A stand-in Honcho client with the same method shapes as @honcho-ai/sdk.
const fake = { opts: null, added: [], peersAdded: [], queries: [], down: false };
function fakeHoncho(opts) {
  fake.opts = opts;
  const peer = (id) => ({
    id,
    message: (content, options) => ({ peerId: id, content, metadata: options?.metadata }),
    context: async ({ searchQuery }) => {
      if (fake.down) throw new Error('503 Service Unavailable');
      fake.queries.push({ id, searchQuery });
      const learned = fake.added.filter((m) => m.peerId === id).map((m) => m.content);
      return { peerCard: learned.length ? ['Prefers short emails'] : null, representation: learned.length ? `Has said: ${learned.join('; ')}` : null };
    },
  });
  return {
    peer: async (id) => peer(id),
    session: async (id) => ({
      id,
      addPeers: async (p) => { fake.peersAdded.push(p); },
      addMessages: async (msgs) => { if (fake.down) throw new Error('503 Service Unavailable'); fake.added.push(...msgs); return msgs; },
    }),
  };
}

let engine;
let token;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-mem-'));

async function api(method, url, body) {
  const res = await fetch(engine.url + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }), memoryClientFactory: fakeHoncho });
  token = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' })).token;
});
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('bots record each exchange in Honcho and recall it on the next message', async () => {
  const { bots } = await api('GET', '/api/bootstrap');
  const bot = bots[0];
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'What is on my plate today?' });
  await until(() => fake.added.length >= 2);
  assert.match(fake.opts.workspaceId, /^[a-z0-9_-]+$/);
  assert.equal(fake.added[0].content, 'What is on my plate today?');
  assert.match(fake.added[0].peerId, /^user-/);
  assert.match(fake.added[1].peerId, /^bot-/);
  assert.deepEqual(fake.peersAdded[0], { [fake.added[1].peerId]: { observeMe: false } });

  // Second message: what Honcho learned is attached to the turn as a [Memory] note.
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Who should I call first?' });
  await until(() => fake.added.length >= 4);
  assert.equal(fake.queries.at(-1).searchQuery, 'Who should I call first?');
  const history = await engine.store.apiHistory(bot.id);
  const turn = history.find((m) => m.role === 'user' && m.content.some((c) => c.text === 'Who should I call first?'));
  assert.ok(turn.content.some((c) => c.type === 'text' && c.text.startsWith('[Memory] About ')));
});

test('chat still works when Honcho is down', async () => {
  fake.down = true;
  const { bots } = await api('GET', '/api/bootstrap');
  const bot = bots[1];
  const before = (await api('GET', `/api/bots/${bot.id}/messages`)).length;
  await api('POST', `/api/bots/${bot.id}/messages`, { text: 'What deals are open?' });
  await until(async () => (await api('GET', `/api/bots/${bot.id}/messages`)).some((m, i) => i >= before && m.role === 'assistant' && m.text));
  fake.down = false;
});
