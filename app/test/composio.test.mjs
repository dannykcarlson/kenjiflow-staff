// Connected apps through Composio (faked) + the usage meter used for billing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { start } = require('../engine/server.js');
const { createLLM } = require('../engine/llm.js');
const { riskOf } = require('../engine/composio.js');

// A stand-in Composio client with the same method shapes as @composio/core.
const fake = { accounts: [], executed: [], keys: [] };
function fakeComposio(key) {
  fake.keys.push(key);
  if (key === 'bad-key-0000000000') {
    return { connectedAccounts: { list: async () => { throw new Error('401 Unauthorized'); } } };
  }
  return {
    connectedAccounts: {
      list: async ({ userIds } = {}) => ({ items: fake.accounts.filter((a) => !userIds || userIds.includes(a.userId)) }),
      waitForConnection: async () => new Promise(() => {}),
      delete: async (id) => { fake.accounts = fake.accounts.filter((a) => a.id !== id); },
    },
    client: {
      link: {
        create: async ({ auth_config_id: authConfigId, user_id: userId }) => {
          const toolkit = authConfigId.replace(/^ac_/, '');
          fake.accounts.push({ id: `ca_${toolkit}`, userId, toolkit: { slug: toolkit }, status: 'ACTIVE', createdAt: new Date().toISOString() });
          return { connected_account_id: `ca_${toolkit}`, redirect_url: `https://connect.composio.test/${toolkit}` };
        },
      },
    },
    authConfigs: {
      list: async () => ({ items: [] }),
      create: async (toolkit) => ({ id: `ac_${toolkit}` }),
    },
    tools: {
      getRawComposioTools: async ({ tools, toolkits }) => [
        { slug: 'HUBSPOT_SEARCH_DEALS', name: 'Search deals', toolkit: { slug: 'hubspot', name: 'HubSpot' }, version: 'v1', inputParameters: { type: 'object', properties: { query: { type: 'string' } } } },
        { slug: 'HUBSPOT_DELETE_CONTACT', name: 'Delete contact', toolkit: { slug: 'hubspot', name: 'HubSpot' }, version: 'v1', inputParameters: { type: 'object', properties: { id: { type: 'string' } } } },
      ].filter((t) => (!tools || tools.includes(t.slug)) && (!toolkits || toolkits.includes(t.toolkit.slug))),
      execute: async (slug, body) => { fake.executed.push({ slug, ...body }); return { successful: true, error: null, data: { deals: [{ name: 'Acme' }] } }; },
    },
  };
}

let engine;
let owner;
let admin;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-apps-'));

async function api(method, url, body, tk = owner) {
  const res = await fetch(engine.url + url, {
    method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

before(async () => {
  engine = await start({ port: 0, dataDir, llm: createLLM({ provider: 'mock' }), composioFactory: fakeComposio });
  owner = (await api('POST', '/api/login', { email: 'owner@northwind.test', password: 'kenjiflow-demo' }, null)).token;
  await api('POST', '/api/users', { name: 'KF Admin', email: 'admin@kenjiflow.test', role: 'admin', password: 'admin-pass-123' });
  admin = (await api('POST', '/api/login', { email: 'admin@kenjiflow.test', password: 'admin-pass-123' }, null)).token;
});
after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('action names map to risk levels', () => {
  assert.equal(riskOf('GMAIL_SEND_EMAIL'), 'send');
  assert.equal(riskOf('GMAIL_FETCH_EMAILS'), 'read');
  assert.equal(riskOf('HUBSPOT_DELETE_CONTACT'), 'delete');
  assert.equal(riskOf('QUICKBOOKS_CREATE_PAYMENT'), 'pay');
  assert.equal(riskOf('HUBSPOT_UPDATE_DEAL'), 'write');
});

test('only a KenjiFlow Admin can set the Composio key, and a bad key is refused', async () => {
  await assert.rejects(api('PUT', '/api/apps/key', { api_key: 'ak_live_owner_should_not_0000' }), { status: 403 });
  await assert.rejects(api('PUT', '/api/apps/key', { api_key: 'bad-key-0000000000' }, admin), { status: 400 });
  const status = await api('PUT', '/api/apps/key', { api_key: 'ak_project_northwind_1234' }, admin);
  assert.equal(status.enabled, true);
  assert.equal(status.key_hint, '1234');
  assert.ok(!JSON.stringify(await api('GET', '/api/apps')).includes('ak_project_northwind'));
});

test('the Owner connects an app with one click; bots get the app tools', async () => {
  const { url } = await api('POST', '/api/apps/hubspot/connect');
  assert.equal(url, 'https://connect.composio.test/hubspot');
  const apps = await api('GET', '/api/apps');
  assert.equal(apps.apps.find((a) => a.slug === 'hubspot').status, 'ACTIVE');
  // Connections live under this workspace's own Composio user.
  assert.match(fake.accounts[0].userId, /^ws_[0-9a-f]+:workspace$/);
});

test('reads run and are metered; deletes wait for approval', async () => {
  // Call the bot tools directly (the mock model doesn't use app tools), wired like the runtime.
  const { store } = engine;
  const { bots } = await api('GET', '/api/bootstrap');
  const bot = bots[0];
  const { runTool } = require('../engine/tools.js');
  const { createComposio } = require('../engine/composio.js');
  const { createSecrets } = require('../engine/secrets.js');
  const { createConnectors } = require('../engine/connectors.js');
  const composio = createComposio({ store, secrets: createSecrets(store, dataDir), clientFactory: fakeComposio });
  const ctx = { store, bot: await store.getBot(bot.id), user: null, taskId: null, composio, connectors: createConnectors({ store, gmail: null, composio }) };

  const found = await runTool('app_find_actions', { app: 'hubspot', query: 'deals' }, ctx);
  assert.ok(found.result.actions.some((a) => a.slug === 'HUBSPOT_SEARCH_DEALS' && a.risk === 'read'));

  const read = await runTool('app_run_action', { slug: 'HUBSPOT_SEARCH_DEALS', arguments: { query: 'quiet' } }, ctx);
  assert.deepEqual(read.result, { deals: [{ name: 'Acme' }] });
  assert.equal(fake.executed.at(-1).version, 'v1');

  const task = await store.createTask({ title: 'Tidy HubSpot', bot_id: bot.id, status: 'in_progress' });
  const del = await runTool('app_run_action', { slug: 'HUBSPOT_DELETE_CONTACT', arguments: { id: '42' }, task_id: task.id, summary: 'Delete duplicate contact Jo' }, ctx);
  assert.equal(del.result.status, 'approval_needed');
  assert.equal(fake.executed.length, 1, 'delete did not run before approval');

  // Approving in test mode logs it instead of deleting; with test mode off it runs.
  await api('PATCH', '/api/settings', { test_mode: false });
  await api('POST', `/api/tasks/${task.id}/approve`, { decision: 'approve' });
  assert.equal(fake.executed.at(-1).slug, 'HUBSPOT_DELETE_CONTACT');

  const usage = (await api('GET', '/api/apps')).usage;
  assert.equal(usage.used, 2);
});

test('the plan meters overage and can hard-cap', async () => {
  await assert.rejects(api('PUT', '/api/billing/plan', { included_actions: 1, overage_per_1000_usd: 5 }), { status: 403 });
  await api('PUT', '/api/billing/plan', { included_actions: 1, overage_per_1000_usd: 5, hard_cap: false }, admin);
  const bill = await api('GET', '/api/billing');
  assert.equal(bill.months[0].actions, 2);
  assert.equal(bill.months[0].overage_actions, 1);
  assert.equal(bill.months[0].overage_usd, 0.01);

  await api('PUT', '/api/billing/plan', { included_actions: 2, overage_per_1000_usd: 5, hard_cap: true }, admin);
  await assert.rejects(engine.store.checkAppActionAllowance(), { status: 429 });
});
