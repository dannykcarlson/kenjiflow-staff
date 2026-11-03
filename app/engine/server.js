// KenjiFlow Staff engine: REST API + websocket push. Runs 24/7 on the client's
// server (Docker) or inside the desktop app for single-PC installs and dev.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db');
const { createStore, httpError } = require('./store');
const { createRuntime } = require('./runtime');
const { createLLM, createSwitchableLLM, checkApiKey } = require('./llm');
const { seedIfEmpty } = require('./seed');
const { createSecrets } = require('./secrets');
const { createGmail } = require('./gmail');
const { createConnectors } = require('./connectors');
const { createComposio } = require('./composio');
const { createMemory } = require('./memory');
const { createTriggers, cleanTrigger } = require('./triggers');
const { createPush } = require('./push');
const { version: VERSION } = require('../package.json');

// Engine settings can live in app/.env (ANTHROPIC_API_KEY=..., PORT=..., etc.).
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env: fine */ }

const UI_ROOT = path.join(__dirname, '..', 'renderer');
const MAX_UPLOAD = 25 * 1024 * 1024;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const ROLES = ['owner', 'manager', 'staff', 'admin'];

async function start({ port = Number(process.env.PORT) || 4310, host = process.env.HOST || '127.0.0.1', dataDir, serveUi = false, llm, composioFactory, memoryClientFactory, pushSender } = {}) {
  dataDir = dataDir || process.env.KF_DATA_DIR || path.join(__dirname, '..', 'data');
  const db = await openDb({ dataDir, databaseUrl: process.env.DATABASE_URL });
  const store = createStore(db, { filesDir: path.join(dataDir, 'files') });
  await seedIfEmpty(store, db);
  await store.seedTemplates();
  const secrets = createSecrets(store, dataDir);
  const llmOpts = { model: process.env.KF_MODEL || 'claude-opus-5-5', effort: process.env.KF_EFFORT || 'medium' };
  const fixedLLM = !!llm; // tests pass their own
  const savedKey = await secrets.get('anthropic_api_key');
  llm = createSwitchableLLM(llm || createLLM({ ...llmOpts, apiKey: savedKey && savedKey.key }));
  let publicUrl = process.env.KF_PUBLIC_URL || '';
  const gmail = createGmail({ store, secrets, publicUrl: () => publicUrl });
  const composio = createComposio({ store, secrets, clientFactory: composioFactory });
  const connectors = createConnectors({ store, gmail, composio });
  const memory = createMemory({ store, clientFactory: memoryClientFactory });
  const runtime = createRuntime({ store, llm, connectors, gmail, composio, memory });
  const triggers = createTriggers({ db, store, runtime, composio });
  runtime.attachTriggers(triggers);
  const push = createPush({ db, store, secrets, sender: pushSender });
  push.start();
  const startedAt = Date.now();
  const llmInfo = () => ({ provider: llm.provider, model: llm.model, key_source: llm.keySource });

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler, opts });
  };

  // ---------- health (for uptime checks on the client's server) ----------
  route('GET', '/api/health', async () => ({ ok: true, version: VERSION, ai: llm.provider === 'mock' ? 'demo' : 'claude', paused: !!(await store.getSetting('paused', false)), uptime_s: Math.round((Date.now() - startedAt) / 1000) }), { public: true });

  // ---------- auth ----------
  // The engine can face the internet, so repeated wrong passwords from one address are slowed down.
  const failures = new Map(); // ip -> { n, until }
  route('POST', '/api/login', async ({ req, body }) => {
    // Behind the HTTPS proxy (KF_TRUST_PROXY=1) the caller's address is in X-Forwarded-For.
    const fwd = process.env.KF_TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.socket.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && f.n >= 10 && Date.now() < f.until) throw httpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const res = await store.login(body.email, body.password);
    if (!res) {
      const next = { n: f && Date.now() < f.until ? f.n + 1 : 1, until: Date.now() + 15 * 60 * 1000 };
      failures.set(ip, next);
      if (failures.size > 5000) failures.delete(failures.keys().next().value);
      throw httpError(401, 'Wrong email or password');
    }
    failures.delete(ip);
    await store.audit('user', res.user.id, 'login', { ip });
    return res;
  }, { public: true });
  route('POST', '/api/logout', async ({ token }) => { await store.logout(token); return { ok: true }; });

  route('GET', '/api/bootstrap', async ({ user }) => ({
    user,
    bots: await store.listBots(user),
    business: await store.getSetting('business', {}),
    pack: await store.getSetting('pack', null),
    test_mode: await store.getSetting('test_mode', true),
    paused: await store.getSetting('paused', false),
    llm: llmInfo(),
  }));

  // ---------- integrations: Claude key + Gmail (Owner / KenjiFlow Admin) ----------
  route('GET', '/api/integrations', async ({ user }) => {
    requireRole(user, ['owner', 'admin']);
    const saved = await secrets.get('anthropic_api_key');
    return { claude: { ...llmInfo(), key_hint: saved ? saved.hint : null }, gmail: await gmail.status() };
  });
  route('PUT', '/api/integrations/claude-key', async ({ user, body }) => {
    requireRole(user, ['owner', 'admin']);
    const key = String(body.api_key || '').trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw httpError(400, "That doesn't look like an Anthropic API key (it starts with sk-ant-)");
    const check = await checkApiKey(key, llmOpts.model);
    if (!check.ok) throw httpError(400, check.error);
    await secrets.set('anthropic_api_key', { key, hint: key.slice(-4) });
    if (!fixedLLM) llm.swap(createLLM({ ...llmOpts, apiKey: key }));
    await store.audit('user', user.id, 'claude_key.set', { hint: key.slice(-4) });
    store.emit('settings', { key: 'llm', value: llmInfo() });
    return llmInfo();
  });
  route('DELETE', '/api/integrations/claude-key', async ({ user }) => {
    requireRole(user, ['owner', 'admin']);
    await secrets.remove('anthropic_api_key');
    if (!fixedLLM) llm.swap(createLLM(llmOpts));
    await store.audit('user', user.id, 'claude_key.remove');
    store.emit('settings', { key: 'llm', value: llmInfo() });
    return llmInfo();
  });
  route('PUT', '/api/integrations/gmail/app', async ({ user, body }) => {
    requireRole(user, ['owner', 'admin']);
    const clientId = String(body.client_id || '').trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw httpError(400, 'The client ID ends in .apps.googleusercontent.com');
    const current = await gmail.status();
    if (!body.client_secret && !current.configured) throw httpError(400, 'Add the client secret too');
    await gmail.saveApp({ client_id: clientId, client_secret: body.client_secret });
    await store.audit('user', user.id, 'connector.gmail.app_saved');
    return gmail.status();
  });
  route('POST', '/api/integrations/gmail/connect', async ({ user }) => {
    requireRole(user, ['owner', 'admin']);
    return { url: await gmail.authUrl(user) };
  });
  route('DELETE', '/api/integrations/gmail', async ({ user }) => {
    requireRole(user, ['owner', 'admin']);
    await gmail.disconnect(user);
    return gmail.status();
  });
  // ---------- connected apps (Composio on KenjiFlow's account) ----------
  route('GET', '/api/apps', async ({ user }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    return { ...(await composio.status()), usage: await store.usageSummary(), recent_actions: await store.recentAppActions() };
  });
  route('POST', '/api/apps/:toolkit/connect', async ({ user, params }) => {
    requireRole(user, ['owner', 'admin']);
    if (!/^[a-z0-9_]{2,40}$/.test(params.toolkit)) throw httpError(400, 'Unknown app');
    return { url: await composio.connect(params.toolkit, user) };
  });
  route('DELETE', '/api/apps/:toolkit', async ({ user, params }) => {
    requireRole(user, ['owner', 'admin']);
    await composio.disconnect(params.toolkit, user);
    return composio.status();
  });
  // KenjiFlow Admin only: the client's Composio project key and their plan.
  route('PUT', '/api/apps/key', async ({ user, body }) => {
    requireRole(user, ['admin']);
    const key = String(body.api_key || '').trim();
    if (key.length < 16) throw httpError(400, 'Paste the Composio project API key');
    await composio.setKey(key);
    await store.audit('user', user.id, 'composio_key.set', { hint: key.slice(-4) });
    return composio.status();
  });
  route('DELETE', '/api/apps/key', async ({ user }) => {
    requireRole(user, ['admin']);
    await composio.removeKey();
    await store.audit('user', user.id, 'composio_key.remove');
    return composio.status();
  });
  route('PUT', '/api/apps/extra', async ({ user, body }) => {
    requireRole(user, ['admin']);
    const slugs = (Array.isArray(body.slugs) ? body.slugs : []).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-z0-9_]{2,40}$/.test(s));
    await store.setSetting('composio_extra_apps', [...new Set(slugs)].slice(0, 30), { silent: true });
    return composio.status();
  });
  route('GET', '/api/billing', async ({ user }) => {
    requireRole(user, ['owner', 'admin']);
    return { plan: await store.billingPlan(), months: await store.appActionUsage(12) };
  });
  route('PUT', '/api/billing/plan', async ({ user, body }) => {
    requireRole(user, ['admin']);
    const included = Number(body.included_actions);
    const price = Number(body.overage_per_1000_usd);
    if (!(Number.isInteger(included) && included >= 0 && included <= 10000000)) throw httpError(400, 'Included actions must be a whole number');
    if (!(price >= 0 && price <= 1000)) throw httpError(400, 'Overage price must be between $0 and $1,000 per 1,000');
    const plan = { included_actions: included, overage_per_1000_usd: price, hard_cap: !!body.hard_cap };
    await store.setSetting('billing_plan', plan, { silent: true });
    await store.audit('user', user.id, 'billing.plan', plan);
    return plan;
  });

  // Google sends the browser back here; it carries no session, so it's checked by OAuth state.
  route('GET', '/api/connectors/gmail/callback', async ({ query, res }) => {
    let title;
    let detail;
    try {
      const email = await gmail.finish({ code: query.code, state: query.state, error: query.error });
      title = 'Gmail connected';
      detail = `KenjiFlow Staff can now read and send email as ${email}. You can close this tab.`;
    } catch (err) {
      title = "Gmail didn't connect";
      detail = err.status ? err.message : 'Something went wrong. Try again from Settings.';
      if (!err.status) console.error(err);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:Arial,sans-serif;display:grid;place-items:center;height:90vh;color:#0B1220"><div style="max-width:420px;text-align:center"><h1 style="font-size:22px">${escapeHtml(title)}</h1><p style="color:#475569">${escapeHtml(detail)}</p></div></body>`);
    return undefined;
  }, { public: true });

  // ---------- bots ----------
  route('GET', '/api/bots', async ({ user }) => store.listBots(user));
  route('POST', '/api/bots', async ({ user, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    return store.createBot(cleanBot(body, true));
  });
  route('PATCH', '/api/bots/:id', async ({ user, params, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    await visibleBot(user, params.id);
    const bot = await store.updateBot(params.id, cleanBot(body, false));
    await store.audit('user', user.id, 'bot.update', { id: params.id, fields: Object.keys(body) });
    return bot;
  });
  route('DELETE', '/api/bots/:id', async ({ user, params }) => {
    requireRole(user, ['owner', 'admin']);
    await store.deleteBot(params.id);
    await store.audit('user', user.id, 'bot.delete', { id: params.id });
    return { ok: true };
  });

  // ---------- chat ----------
  route('GET', '/api/bots/:id/messages', async ({ user, params }) => {
    await visibleBot(user, params.id);
    return store.listMessages(params.id);
  });
  route('POST', '/api/bots/:id/messages', async ({ user, params, body }) => {
    await visibleBot(user, params.id);
    const text = String(body.text || '').trim();
    if (!text) throw httpError(400, 'Message is empty');
    const files = [];
    for (const id of body.file_ids || []) {
      const f = await store.getFile(id);
      if (f) files.push(f);
    }
    const withFiles = files.length ? `${text}\n\n[Attached files: ${files.map((f) => `${f.name} (${f.id})`).join(', ')}]` : text;
    runtime.send(params.id, { userText: withFiles, user });
    return { ok: true };
  });

  // ---------- tasks ----------
  route('GET', '/api/tasks', async ({ user, query }) => store.listTasks(user, { status: query.status, botId: query.bot }));
  route('POST', '/api/tasks', async ({ user, body }) => {
    const title = String(body.title || '').trim();
    if (!title) throw httpError(400, 'Give the task a title');
    if (body.bot_id) await visibleBot(user, body.bot_id);
    const task = await store.createTask({
      title, description: String(body.description || '').slice(0, 300), instructions: body.instructions || '', bot_id: body.bot_id || null,
      priority: body.priority || 'normal', due_at: body.due_at || null, status: 'queued', source: 'manual', created_by_type: 'user', created_by: user.id,
    });
    runtime.describeTask(task.id);
    const files = [];
    for (const id of (body.file_ids || []).slice(0, 20)) { const f = await store.getFile(id); if (f) files.push(f); }
    if (body.bot_id) assignToBot(task, user, { files });
    return task;
  });
  // Tells the bot about a task it now owns, with any template files it can read.
  function assignToBot(task, user, { files = [], verb = 'assigned you' } = {}) {
    const fileLine = files.length ? ` Files for this task (read them with read_file): ${files.map((f) => `${f.name} (${f.id})`).join(', ')}.` : '';
    runtime.send(task.bot_id, {
      engineText: `[Task assigned] ${user.name} ${verb} ${task.id}: "${task.title}".${task.instructions ? ` Instructions: ${task.instructions}` : ''}${task.due_at ? ` Due ${task.due_at}.` : ''}${fileLine} Start on it now and use update_task as you go. When you think it's finished, set status "review".`,
      eventText: `${user.name} ${verb} ${task.id}: ${task.title}`,
      user, taskId: task.id,
    });
  }
  route('GET', '/api/tasks/:id', async ({ user, params }) => visibleTask(user, params.id, true));
  route('PATCH', '/api/tasks/:id', async ({ user, params, body }) => {
    const task = await visibleTask(user, params.id);
    const fields = {};
    for (const k of ['title', 'description', 'instructions', 'priority', 'due_at']) if (body[k] !== undefined) fields[k] = body[k];
    if (fields.title !== undefined) {
      fields.title = String(fields.title).trim().slice(0, 200);
      if (!fields.title) throw httpError(400, 'Give the task a title');
    }
    if (fields.description !== undefined) fields.description = String(fields.description).trim().slice(0, 300);
    // Only people mark tasks done.
    if (['cancelled', 'done'].includes(body.status)) fields.status = body.status;
    if (body.status === 'done' && task.status !== 'done') {
      await store.postFeed({ botId: task.bot_id, taskId: task.id, kind: 'task_done', importance: 'info', summary: `${user.name} marked done: ${task.title}` });
    }
    const updated = await store.updateTask(task.id, fields, 'user');
    // Retry a failed task, or reopen one from review with a note on what's left.
    if (['retry', 'reopen'].includes(body.status) && task.bot_id) {
      await store.updateTask(task.id, { status: 'in_progress' }, 'user');
      const note = String(body.note || '').trim();
      if (note) await store.addNote(task.id, user, note);
      const what = body.status === 'retry' ? 'asked you to retry' : 'reopened';
      runtime.send(task.bot_id, {
        engineText: `[Task assigned] ${user.name} ${what} ${task.id}: "${task.title}".${note ? ` Their note: ${note}` : ''} Carry on and set status "review" when you think it's finished.`,
        eventText: `${user.name} ${what} ${task.id}${note ? `: ${note}` : ''}`, user, taskId: task.id,
      });
    }
    if (task.bot_id) await runtime.refreshStatus(task.bot_id);
    return store.getTask(task.id);
  });
  route('POST', '/api/tasks/:id/notes', async ({ user, params, body }) => {
    const task = await visibleTask(user, params.id);
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw httpError(400, 'Note is empty');
    await store.addNote(task.id, user, text);
    await store.audit('user', user.id, 'task.note', { id: task.id });
    return store.taskDetail(task.id);
  });

  // ---------- task templates ----------
  route('GET', '/api/templates', async () => store.listTemplates());
  const cleanTemplate = async (user, body, creating) => {
    const out = {};
    if (body.title !== undefined || creating) {
      out.title = String(body.title || '').trim().slice(0, 200);
      if (!out.title) throw httpError(400, 'Give the template a title');
    }
    for (const k of ['description', 'instructions']) if (body[k] !== undefined) out[k] = String(body[k]).slice(0, k === 'instructions' ? 8000 : 300);
    if (body.bot_id !== undefined) { if (body.bot_id) await visibleBot(user, body.bot_id); out.bot_id = body.bot_id || null; }
    if (body.priority !== undefined) { if (!['low', 'normal', 'high'].includes(body.priority)) throw httpError(400, 'Unknown priority'); out.priority = body.priority; }
    if (body.file_ids !== undefined) {
      if (!Array.isArray(body.file_ids)) throw httpError(400, 'file_ids must be a list');
      for (const id of body.file_ids) if (!(await store.getFile(id))) throw httpError(400, `No file ${id}`);
      out.file_ids = body.file_ids.slice(0, 20);
    }
    return out;
  };
  route('POST', '/api/templates', async ({ user, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    return store.saveTemplate(null, await cleanTemplate(user, body, true), user.id);
  });
  route('PATCH', '/api/templates/:id', async ({ user, params, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    if (!(await store.getTemplate(params.id))) throw httpError(404, 'Template not found');
    return store.saveTemplate(params.id, await cleanTemplate(user, body, false), user.id);
  });
  route('DELETE', '/api/templates/:id', async ({ user, params }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    await store.deleteTemplate(params.id);
    return { ok: true };
  });
  // Starts a task from a template; the bot gets the template's files to read.
  route('POST', '/api/templates/:id/use', async ({ user, params, body }) => {
    const tpl = await store.getTemplate(params.id);
    if (!tpl) throw httpError(404, 'Template not found');
    const botId = body.bot_id !== undefined ? body.bot_id : tpl.bot_id;
    if (botId) await visibleBot(user, botId);
    const task = await store.createTask({
      title: tpl.title, description: tpl.description, instructions: tpl.instructions, bot_id: botId || null, priority: tpl.priority,
      due_at: body.due_at || null, status: 'queued', source: 'manual', created_by_type: 'user', created_by: user.id,
    });
    runtime.describeTask(task.id);
    if (botId) assignToBot(task, user, { files: tpl.files });
    return task;
  });
  route('POST', '/api/tasks/:id/approve', async ({ user, params, body }) => {
    const task = await visibleTask(user, params.id);
    const decision = body.decision === 'reject' ? 'reject' : 'approve';
    const edits = body.edits && typeof body.edits === 'object' ? pick(body.edits, ['to', 'subject', 'body']) : null;
    const updated = await store.decideApproval(task.id, user, { decision, edits, note: body.note });
    const approval = updated.approval;
    let outcome = '';
    if (decision === 'approve') {
      const bot = await store.getBot(task.bot_id);
      try {
        const res = await connectors.execute(approval.action, approval.payload, { bot, task: updated });
        outcome = res.sent || res.done ? (approval.action === 'send_email' ? 'It was sent.' : 'It was done.') : `It was recorded but not done (${res.reason}).`;
      } catch (err) {
        outcome = `It failed (${err.message}).`;
        await store.addStep(task.id, `Send failed: ${err.message}`, 'bot');
        await store.postFeed({ botId: task.bot_id, taskId: task.id, kind: 'send_failed', importance: 'critical', summary: `Couldn't complete "${approval.summary}": ${err.message}` });
      }
    }
    const editNote = approval.edited ? ` ${user.name} edited it before approving; final version: ${JSON.stringify(approval.payload)}. Note what changed so you match it next time.` : '';
    runtime.send(task.bot_id, {
      engineText: `[Approval] ${user.name} ${decision === 'approve' ? 'approved' : 'rejected'} "${approval.summary}" on ${task.id}.${body.note ? ` Note: ${body.note}` : ''}${editNote} ${outcome} Continue the task accordingly.`,
      eventText: `${user.name} ${decision === 'approve' ? 'approved' : 'rejected'} ${task.id}${approval.edited ? ' after editing it' : ''}${decision === 'approve' ? ` · ${outcome.replace(/^It was /, '').replace(/\.$/, '')}` : ''}`,
      user, taskId: task.id,
    });
    return updated;
  });
  route('POST', '/api/tasks/:id/feedback', async ({ user, params, body }) => {
    const task = await visibleTask(user, params.id);
    const answer = String(body.answer || '').trim();
    if (!answer) throw httpError(400, 'Type an answer first');
    const updated = await store.answerFeedback(task.id, user, answer);
    runtime.send(task.bot_id, { engineText: `[Feedback] ${user.name} answered your question on ${task.id} ("${task.feedback.question}"): ${answer}`, eventText: `${user.name} answered on ${task.id}: ${answer}`, user, taskId: task.id });
    return updated;
  });

  // ---------- triggers ----------
  route('GET', '/api/triggers', async ({ user }) => {
    const visible = new Set((await store.listBots(user)).map((b) => b.id));
    return (await triggers.list()).filter((t) => !t.bot_id || visible.has(t.bot_id));
  });
  route('GET', '/api/triggers/:id/events', async ({ params }) => triggers.recent(params.id));
  route('GET', '/api/trigger-types', async ({ user, query }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    return composio.listTriggerTypes(String(query.app || ''));
  });
  route('POST', '/api/triggers', async ({ user, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    const fields = cleanTrigger(body, true);
    await visibleBot(user, fields.bot_id);
    return triggers.create(fields, user);
  });
  route('PATCH', '/api/triggers/:id', async ({ user, params, body }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    const fields = cleanTrigger(body, false);
    if (fields.bot_id) await visibleBot(user, fields.bot_id);
    return triggers.update(params.id, fields, user);
  });
  route('DELETE', '/api/triggers/:id', async ({ user, params }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    await triggers.remove(params.id, user);
    return { ok: true };
  });
  route('POST', '/api/triggers/:id/run', async ({ user, params }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    return { outcome: await triggers.runNow(params.id, user) };
  });

  // ---------- phone notifications ----------
  route('GET', '/api/push/key', async () => ({ key: await push.publicKey() }));
  route('POST', '/api/push/subscribe', async ({ user, body }) => { await push.subscribe(user, body.subscription, body.label); return { ok: true }; });
  route('DELETE', '/api/push/subscribe', async ({ user, query }) => { await push.unsubscribe(user, query.endpoint); return { ok: true }; });
  route('GET', '/api/push/devices', async ({ user }) => push.devices(user));
  route('POST', '/api/push/test', async ({ user }) => ({ sent: await push.notify((u) => u.id === user.id, { title: 'KenjiFlow Staff', body: 'Notifications are on. Approvals will show up here.', url: '/m/' }) }));

  // ---------- activity log ----------
  route('GET', '/api/audit', async ({ user, query }) => {
    requireRole(user, ['owner', 'admin']);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    const before = query.before ? new Date(query.before) : new Date(Date.now() + 1000);
    if (Number.isNaN(before.getTime())) throw httpError(400, 'Bad date');
    return db.all(`SELECT a.id, a.actor_type, a.actor_id, a.action, a.detail, a.created_at,
        COALESCE(u.name, b.name) AS actor_name
      FROM audit_log a
      LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
      LEFT JOIN bots b ON a.actor_type = 'bot' AND b.id = a.actor_id
      WHERE a.created_at < $1 ORDER BY a.created_at DESC LIMIT $2`, [before.toISOString(), limit]);
  });

  // ---------- feed ----------
  route('GET', '/api/feed', async ({ user, query }) => store.listFeed(user, { botId: query.bot, importance: query.importance, unread: query.unread === '1' }));
  route('POST', '/api/feed/read-all', async ({ user }) => { await store.markAllFeedRead(user); return { ok: true }; });
  route('POST', '/api/feed/:id/read', async ({ user, params, body }) => { await store.setFeedRead(user, params.id, body.read !== false); return { ok: true }; });

  // ---------- files ----------
  route('GET', '/api/files', async ({ user, query }) => store.listFiles(user, { source: query.source, type: query.type, q: query.q }));
  route('POST', '/api/files', async ({ user, req, query }) => {
    const buffer = await readRaw(req, MAX_UPLOAD);
    const name = decodeURIComponent(req.headers['x-file-name'] || 'upload');
    return store.saveFile({ name, mime: req.headers['content-type'], buffer, source: 'upload', uploadedBy: user.id, taskId: query.task || null });
  }, { raw: true });
  route('GET', '/api/files/:id/download', async ({ params, res }) => {
    const file = await store.getFile(params.id);
    if (!file) throw httpError(404, 'File not found');
    res.writeHead(200, {
      'Content-Type': file.mime, 'Content-Length': file.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
    });
    fs.createReadStream(file.storage_path).pipe(res);
    return undefined;
  });
  route('DELETE', '/api/files/:id', async ({ user, params }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    await store.deleteFile(params.id, user);
    return { ok: true };
  });

  // ---------- artifacts ----------
  route('GET', '/api/artifacts', async ({ user, query }) => store.listArtifacts(user, { botId: query.bot, kind: query.kind, pinned: query.pinned === '1' }));
  route('GET', '/api/artifacts/:id', async ({ params }) => {
    const art = await store.getArtifact(params.id);
    if (!art) throw httpError(404, 'Artifact not found');
    return art;
  });
  route('POST', '/api/artifacts/:id/versions', async ({ user, params, body }) => {
    if (!String(body.content || '').trim()) throw httpError(400, 'Content is empty');
    return store.addArtifactVersion(params.id, { content: body.content, note: body.note || `Edited by ${user.name}`, createdBy: user.id });
  });
  route('PATCH', '/api/artifacts/:id', async ({ params, body }) => store.updateArtifact(params.id, { title: body.title, pinned: body.pinned }));
  route('DELETE', '/api/artifacts/:id', async ({ user, params }) => {
    requireRole(user, ['owner', 'manager', 'admin']);
    await store.deleteArtifact(params.id, user);
    return { ok: true };
  });

  // ---------- team & settings ----------
  route('GET', '/api/users', async ({ user }) => { requireRole(user, ['owner', 'manager', 'admin']); return store.listUsers(); });
  route('POST', '/api/users', async ({ user, body }) => {
    requireRole(user, ['owner']);
    if (!ROLES.includes(body.role)) throw httpError(400, 'Pick a role');
    if (!body.email || !body.name || String(body.password || '').length < 8) throw httpError(400, 'Name, email and a password of 8+ characters are required');
    const created = await store.createUser(body);
    await store.audit('user', user.id, 'user.create', { id: created.id, role: created.role });
    return created;
  });
  route('POST', '/api/kill-switch', async ({ user, body }) => {
    requireRole(user, ['owner', 'manager']);
    await store.setSetting('paused', !!body.paused);
    await store.audit('user', user.id, body.paused ? 'bots.pause' : 'bots.resume');
    await store.postFeed({ kind: 'kill_switch', importance: 'critical', summary: body.paused ? `${user.name} paused all bots` : `${user.name} resumed all bots` });
    return { paused: !!body.paused };
  });
  route('PATCH', '/api/settings', async ({ user, body }) => {
    requireRole(user, ['owner']);
    if (body.test_mode !== undefined) await store.setSetting('test_mode', !!body.test_mode);
    if (body.business) await store.setSetting('business', pick(body.business, ['name', 'about', 'voice']));
    return { ok: true };
  });

  // ---------- helpers ----------
  async function visibleBot(user, id) {
    const bot = await store.getBot(id);
    if (!bot || !store.canSeeBot(user, bot)) throw httpError(404, 'Bot not found');
    return bot;
  }
  async function visibleTask(user, id, detail = false) {
    const task = detail ? await store.taskDetail(id) : await store.getTask(id);
    if (!task) throw httpError(404, 'Task not found');
    if (task.bot_id) await visibleBot(user, task.bot_id);
    return task;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      // The phone page is always served: it's how people approve from anywhere.
      if (serveUi || url.pathname === '/m' || url.pathname.startsWith('/m/') || url.pathname.startsWith('/assets/')) return serveStatic(url.pathname === '/m' ? '/m/' : url.pathname, res);
      res.writeHead(404); return res.end();
    }

    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) return sendJson(res, 404, { error: 'Not found' });
    const params = {};
    const m = url.pathname.match(match.re);
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(url.searchParams);

    try {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = match.opts.public ? null : await store.userForToken(token);
      if (!match.opts.public && !user) throw httpError(401, 'Please sign in');
      const body = match.opts.raw || req.method === 'GET' ? {} : await readJson(req);
      const out = await match.handler({ req, res, user, token, params, query, body });
      if (out !== undefined) sendJson(res, 200, out);
    } catch (err) {
      if (!err.status) console.error(err);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  });

  // Websocket: each signed-in app gets every change and filters what it shows.
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const user = await store.userForToken(token);
    if (!user) return ws.close(4001, 'unauthorized');
    ws.user = user;
  });
  store.bus.on('event', (event) => {
    const msg = JSON.stringify(event);
    for (const ws of wss.clients) if (ws.user && ws.readyState === 1) ws.send(msg);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  triggers.start(); // schedules tick every 30s; app events stream from Composio
  const address = `http://${host}:${server.address().port}`;
  // Where Google sends people back to; set KF_PUBLIC_URL when the engine sits behind a domain.
  if (!publicUrl) publicUrl = `http://localhost:${server.address().port}`;
  console.log(`KenjiFlow Staff engine on ${address} (AI: ${llm.provider}${llm.provider === 'mock' ? ', demo mode' : `, ${llm.model}`}; memory: ${memory.enabled ? 'Honcho' : 'off'})`);
  return {
    url: address, store, runtime, db, triggers, push,
    async close() { triggers.stop(); wss.close(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(UI_ROOT, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
  if (!file.startsWith(UI_ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'File is too large (25 MB max)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readRaw(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw httpError(403, "Your role can't do that");
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, String(obj[k])]));
}

function cleanBot(body, creating) {
  const out = {};
  if (body.name !== undefined || creating) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 40) throw httpError(400, 'Bot name must be 1–40 characters');
    out.name = name;
  }
  for (const k of ['role_title', 'description', 'instructions']) if (body[k] !== undefined) out[k] = String(body[k]).slice(0, k === 'instructions' ? 8000 : 120);
  if (body.autonomy !== undefined) {
    if (!['ask_all', 'ask_risky', 'just_do_it'].includes(body.autonomy)) throw httpError(400, 'Unknown autonomy level');
    out.autonomy = body.autonomy;
  }
  if (body.avatar !== undefined || creating) {
    const a = body.avatar || {};
    const avatar = {
      variant: /^[a-z0-9]{2,20}$/.test(a.variant || '') ? a.variant : 'bean',
      body: HEX.test(a.body || '') ? a.body : '#F4F7FB',
      eye: HEX.test(a.eye || '') ? a.eye : '#22D3EE',
      accent: HEX.test(a.accent || '') ? a.accent : '#22D3EE',
    };
    if (a.eyeStyle && /^[a-z]{2,12}$/.test(a.eyeStyle)) avatar.eyeStyle = a.eyeStyle;
    out.avatar = avatar;
  }
  if (body.allowed_roles !== undefined) {
    if (!Array.isArray(body.allowed_roles)) throw httpError(400, 'allowed_roles must be a list');
    out.allowed_roles = body.allowed_roles.filter((r) => ROLES.includes(r));
  }
  if (body.monthly_cap_usd !== undefined) {
    const cap = Number(body.monthly_cap_usd);
    if (!(cap >= 0 && cap <= 10000)) throw httpError(400, 'Budget must be between $0 and $10,000');
    out.monthly_cap_usd = cap;
  }
  return out;
}

module.exports = { start };

if (require.main === module) {
  start({ serveUi: process.argv.includes('--serve-ui') || process.env.KF_SERVE_UI === '1' }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
