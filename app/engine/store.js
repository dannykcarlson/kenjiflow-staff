// Data access + domain rules. Every change emits an event on `bus` so the server
// can push it to connected apps over the websocket.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { newId, hashPassword, verifyPassword, newToken, publicUser } = require('./util');
const { ruleFor, canApprove } = require('./policy');

// Bots move finished work to "review"; only a person sets "done".
const TASK_STATUSES = ['queued', 'in_progress', 'approval_needed', 'awaiting_feedback', 'review', 'scheduled', 'done', 'failed', 'cancelled'];

function createStore(db, { filesDir }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const emit = (type, data) => bus.emit('event', { type, data });

  async function audit(actorType, actorId, action, detail = {}) {
    await db.run('INSERT INTO audit_log (id, actor_type, actor_id, action, detail) VALUES ($1,$2,$3,$4,$5)',
      [newId('aud'), actorType, actorId, action, JSON.stringify(detail)]);
  }

  // ---------- settings ----------
  async function getSetting(key, fallback) {
    const row = await db.one('SELECT value FROM settings WHERE key=$1', [key]);
    return row ? row.value : fallback;
  }
  async function setSetting(key, value, { silent = false } = {}) {
    await db.run('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
    if (!silent) emit('settings', { key, value });
  }

  // ---------- users & sessions ----------
  async function createUser({ email, name, role, password }) {
    const id = newId('usr');
    await db.run('INSERT INTO users (id, email, name, role, pass_hash) VALUES ($1,$2,$3,$4,$5)',
      [id, email.trim().toLowerCase(), name.trim(), role, hashPassword(password)]);
    return publicUser(await db.one('SELECT * FROM users WHERE id=$1', [id]));
  }
  async function login(email, password) {
    const user = await db.one('SELECT * FROM users WHERE email=$1', [String(email || '').trim().toLowerCase()]);
    if (!user || !verifyPassword(String(password || ''), user.pass_hash)) return null;
    const token = newToken();
    await db.run('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, user.id]);
    return { token, user: publicUser(user) };
  }
  async function userForToken(token) {
    if (!token) return null;
    return publicUser(await db.one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1', [token]));
  }
  async function logout(token) { await db.run('DELETE FROM sessions WHERE token=$1', [token]); }
  async function listUsers() { return (await db.all('SELECT * FROM users ORDER BY created_at')).map(publicUser); }
  async function getUser(id) { return publicUser(await db.one('SELECT * FROM users WHERE id=$1', [id])); }

  // ---------- bots ----------
  const canSeeBot = (user, bot) => !!bot && (user.role === 'owner' || user.role === 'admin' || (bot.allowed_roles || []).includes(user.role));

  async function listBots(user) {
    const bots = await db.all('SELECT * FROM bots ORDER BY sort, created_at');
    return bots.filter((b) => canSeeBot(user, b)).map(shapeBot);
  }
  async function getBot(id) { return shapeBot(await db.one('SELECT * FROM bots WHERE id=$1', [id])); }
  async function createBot(fields) {
    const id = newId('bot');
    const maxSort = await db.one('SELECT COALESCE(MAX(sort), 0) AS s FROM bots');
    await db.run(`INSERT INTO bots (id, name, role_title, description, instructions, avatar, autonomy, allowed_roles, sort)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, fields.name, fields.role_title || '', fields.description || '', fields.instructions || '',
      JSON.stringify(fields.avatar), fields.autonomy || 'ask_risky',
      JSON.stringify(fields.allowed_roles || ['owner', 'manager', 'staff', 'admin']), Number(maxSort.s) + 1]);
    const bot = await getBot(id);
    emit('bot', bot);
    return bot;
  }
  async function updateBot(id, fields) {
    const allowed = ['name', 'role_title', 'description', 'instructions', 'autonomy', 'avatar', 'allowed_roles', 'status_text', 'monthly_cap_usd'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      const v = (key === 'avatar' || key === 'allowed_roles') ? JSON.stringify(fields[key]) : fields[key];
      vals.push(v);
      sets.push(`${key}=$${vals.length}`);
    }
    if (sets.length) {
      vals.push(id);
      await db.run(`UPDATE bots SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }
    const bot = await getBot(id);
    emit('bot', bot);
    return bot;
  }
  async function deleteBot(id) {
    await db.run('DELETE FROM bots WHERE id=$1', [id]);
    emit('bot_deleted', { id });
  }
  function shapeBot(b) {
    if (!b) return null;
    return { ...b, monthly_cap_usd: Number(b.monthly_cap_usd) };
  }

  // ---------- messages ----------
  async function addMessage({ botId, role, apiContent, text = '', cards = [], hidden = false, userId = null }) {
    const id = newId('msg');
    await db.run(`INSERT INTO messages (id, bot_id, role, api_content, text, cards, hidden, user_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, clock_timestamp())`,
    [id, botId, role, apiContent ? JSON.stringify(apiContent) : null, text, JSON.stringify(cards), hidden, userId]);
    const msg = await db.one('SELECT * FROM messages WHERE id=$1', [id]);
    if (!hidden) emit('message', shapeMessage(msg));
    return msg;
  }
  async function listMessages(botId, limit = 200) {
    const rows = await db.all('SELECT * FROM messages WHERE bot_id=$1 AND hidden=false ORDER BY created_at DESC LIMIT $2', [botId, limit]);
    return rows.reverse().map(shapeMessage);
  }
  function shapeMessage(m) {
    return { id: m.id, bot_id: m.bot_id, role: m.role, text: m.text, cards: m.cards, user_id: m.user_id, created_at: m.created_at };
  }
  // The exact turns sent to the model, oldest first. Append-only, so the prompt cache holds.
  async function apiHistory(botId, maxTurns = 120) {
    const rows = await db.all('SELECT role, api_content FROM messages WHERE bot_id=$1 AND api_content IS NOT NULL ORDER BY created_at', [botId]);
    let turns = rows.map((r) => ({ role: r.role, content: r.api_content }));
    if (turns.length > maxTurns) {
      turns = turns.slice(-maxTurns);
      // Start on a plain user message (never on a tool_result or assistant turn).
      const start = turns.findIndex((t) => t.role === 'user' && Array.isArray(t.content) && t.content.every((c) => c.type === 'text'));
      turns = start >= 0 ? turns.slice(start) : [];
    }
    return turns;
  }

  // ---------- tasks ----------
  // Task numbers count up with no gaps (a Postgres sequence can skip ahead after a restart).
  async function nextTaskId() {
    const row = await db.one("SELECT COALESCE(MAX(SUBSTRING(id FROM 3)::int), 0) + 1 AS n FROM tasks WHERE id ~ '^T-[0-9]+$'");
    return `T-${String(row.n).padStart(4, '0')}`;
  }
  async function createTask(fields) {
    let id;
    for (let attempt = 0; ; attempt++) {
      id = await nextTaskId();
      try {
        await db.run(`INSERT INTO tasks (id, title, instructions, bot_id, status, priority, due_at, source, created_by_type, created_by, description)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, fields.title, fields.instructions || '', fields.bot_id || null, fields.status || 'queued', fields.priority || 'normal',
          fields.due_at || null, fields.source || 'chat', fields.created_by_type || 'user', fields.created_by || null, fields.description || '']);
        break;
      } catch (err) {
        if (err.code !== '23505' || attempt >= 5) throw err; // two bots took the same number; try the next one
      }
    }
    await addStep(id, fields.created_by_type === 'bot' ? 'Created from chat' : 'Task created', fields.created_by_type || 'user');
    const task = await getTask(id);
    emit('task', task);
    return task;
  }
  async function getTask(id) {
    const t = await db.one('SELECT * FROM tasks WHERE id=$1', [id]);
    return t ? shapeTask(t) : null;
  }
  async function taskDetail(id) {
    const task = await getTask(id);
    if (!task) return null;
    task.steps = await db.all('SELECT * FROM task_steps WHERE task_id=$1 ORDER BY created_at', [id]);
    task.artifacts = await db.all('SELECT id, title, kind FROM artifacts WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at', [id]);
    task.files = (await db.all('SELECT * FROM files WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at', [id])).map(shapeFile);
    task.notes = await db.all(`SELECT n.id, n.text, n.user_id, n.created_at, u.name AS user_name FROM task_notes n
      LEFT JOIN users u ON u.id = n.user_id WHERE n.task_id=$1 ORDER BY n.created_at`, [id]);
    task.big_jobs = await db.all('SELECT id, title, web, status, budget_usd, cost_usd, summary, error, created_at, finished_at FROM big_jobs WHERE task_id=$1 ORDER BY created_at', [id]);
    return task;
  }
  async function addNote(taskId, user, text) {
    await db.run('INSERT INTO task_notes (id, task_id, user_id, text, created_at) VALUES ($1,$2,$3,$4, clock_timestamp())', [newId('nte'), taskId, user.id, text]);
    await db.run('UPDATE tasks SET updated_at=now() WHERE id=$1', [taskId]);
    const task = await getTask(taskId);
    emit('task', task);
    return task;
  }
  async function listNotes(taskId) {
    return db.all(`SELECT n.text, n.created_at, u.name AS user_name FROM task_notes n
      LEFT JOIN users u ON u.id = n.user_id WHERE n.task_id=$1 ORDER BY n.created_at`, [taskId]);
  }

  // ---------- task templates ----------
  // Reusable task recipes (title, instructions, bot, files). Seeded once from the industry pack.
  function shapeTemplate(t) { return { ...t, file_ids: t.file_ids || [] }; }
  async function seedTemplates() {
    if (await getSetting('templates_seeded', false)) return;
    const pack = await getSetting('pack', null);
    const bots = await db.all('SELECT id, name FROM bots');
    for (const [i, t] of ((pack && pack.task_templates) || []).entries()) {
      const bot = bots.find((b) => b.name === t.bot);
      await db.run(`INSERT INTO task_templates (id, title, description, instructions, bot_id, priority, sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newId('tpl'), t.title, t.description || '', t.instructions || '', bot ? bot.id : null, t.priority || 'normal', i]);
    }
    await setSetting('templates_seeded', true, { silent: true });
  }
  async function listTemplates() {
    const rows = await db.all('SELECT * FROM task_templates ORDER BY sort, created_at');
    const fileIds = [...new Set(rows.flatMap((t) => t.file_ids || []))];
    const files = fileIds.length ? (await db.all('SELECT * FROM files WHERE id = ANY($1) AND deleted_at IS NULL', [fileIds])).map(shapeFile) : [];
    return rows.map((t) => ({ ...shapeTemplate(t), files: (t.file_ids || []).map((id) => files.find((f) => f.id === id)).filter(Boolean) }));
  }
  async function getTemplate(id) {
    return (await listTemplates()).find((t) => t.id === id) || null;
  }
  async function saveTemplate(id, fields, userId) {
    const cols = ['title', 'description', 'instructions', 'bot_id', 'priority', 'file_ids'];
    const val = (k) => (k === 'file_ids' ? JSON.stringify(fields[k] || []) : fields[k]);
    if (!id) {
      id = newId('tpl');
      const n = (await db.one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM task_templates')).n;
      await db.run(`INSERT INTO task_templates (id, title, description, instructions, bot_id, priority, file_ids, sort, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, fields.title, fields.description || '', fields.instructions || '', fields.bot_id || null, fields.priority || 'normal', val('file_ids'), n, userId]);
    } else {
      const sets = ['updated_at=now()'];
      const vals = [];
      for (const k of cols) if (fields[k] !== undefined) { vals.push(val(k)); sets.push(`${k}=$${vals.length}`); }
      vals.push(id);
      await db.run(`UPDATE task_templates SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }
    const tpl = await getTemplate(id);
    emit('template', tpl);
    return tpl;
  }
  async function deleteTemplate(id) {
    await db.run('DELETE FROM task_templates WHERE id=$1', [id]);
    emit('template_deleted', { id });
  }
  async function listTasks(user, { status, botId } = {}) {
    const visible = new Set((await listBots(user)).map((b) => b.id));
    const rows = await db.all('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500');
    return rows.map(shapeTask).filter((t) => (!t.bot_id || visible.has(t.bot_id))
      && (!status || t.status === status) && (!botId || t.bot_id === botId));
  }
  async function updateTask(id, fields, actor = 'bot') {
    const allowed = ['title', 'description', 'instructions', 'bot_id', 'status', 'priority', 'due_at', 'result', 'approval', 'feedback'];
    const sets = ['updated_at=now()'];
    const vals = [];
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      if (key === 'status' && !TASK_STATUSES.includes(fields[key])) throw new Error(`Unknown status ${fields[key]}`);
      vals.push((key === 'approval' || key === 'feedback') && fields[key] !== null ? JSON.stringify(fields[key]) : fields[key]);
      sets.push(`${key}=$${vals.length}`);
    }
    vals.push(id);
    await db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    if (fields.status) await addStep(id, `Status → ${statusLabel(fields.status)}`, actor);
    const task = await getTask(id);
    emit('task', task);
    return task;
  }
  async function addStep(taskId, text, actor = 'bot') {
    await db.run('INSERT INTO task_steps (id, task_id, text, actor, created_at) VALUES ($1,$2,$3,$4, clock_timestamp())', [newId('stp'), taskId, text, actor]);
  }
  async function addTaskCost(taskId, usd) {
    await db.run('UPDATE tasks SET cost_usd = cost_usd + $1 WHERE id=$2', [usd, taskId]);
  }
  function shapeTask(t) { return { ...t, cost_usd: Number(t.cost_usd) }; }

  // ---------- approvals & feedback ----------
  async function requestApproval(taskId, { action, summary, payload }) {
    const rules = await getSetting('approval_rules', undefined);
    const rule = ruleFor(action, rules);
    const approval = { action, summary, payload, roles: rule.roles, rule: rule.label, requested_at: new Date().toISOString() };
    const task = await updateTask(taskId, { status: 'approval_needed', approval });
    await postFeed({ botId: task.bot_id, taskId, kind: 'approval_requested', importance: 'important', summary: `Approval requested: ${summary}` });
    return task;
  }
  async function decideApproval(taskId, user, { decision, edits, note }) {
    const task = await getTask(taskId);
    if (!task || task.status !== 'approval_needed' || !task.approval) throw httpError(409, 'This task is not waiting for approval');
    if (!canApprove(user, task.approval)) throw httpError(403, `Only ${task.approval.roles.join(' or ')} can approve this`);
    const payload = { ...task.approval.payload, ...(edits || {}) };
    const approval = { ...task.approval, payload, decision, decided_by: user.id, decided_by_name: user.name, note: note || '', decided_at: new Date().toISOString(), edited: !!edits && Object.keys(edits).length > 0 };
    // Either way the bot picks the task back up: it carries out the action or revises it.
    const updated = await updateTask(taskId, { status: 'in_progress', approval }, 'user');
    await addStep(taskId, `${decision === 'approve' ? 'Approved' : 'Rejected'} by ${user.name}${note ? `: ${note}` : ''}`, 'user');
    await audit('user', user.id, `approval.${decision}`, { taskId, action: task.approval.action, edited: approval.edited });
    return updated;
  }
  async function askFeedback(taskId, question) {
    const task = await updateTask(taskId, { status: 'awaiting_feedback', feedback: { question, asked_at: new Date().toISOString() } });
    await postFeed({ botId: task.bot_id, taskId, kind: 'feedback_requested', importance: 'important', summary: `Needs your input: ${question}` });
    return task;
  }
  async function answerFeedback(taskId, user, answer) {
    const task = await getTask(taskId);
    if (!task || task.status !== 'awaiting_feedback') throw httpError(409, 'This task is not waiting for feedback');
    const feedback = { ...task.feedback, answer, answered_by: user.id, answered_by_name: user.name, answered_at: new Date().toISOString() };
    await addStep(taskId, `${user.name} answered: ${answer}`, 'user');
    return updateTask(taskId, { status: 'in_progress', feedback }, 'user');
  }

  // ---------- feed ----------
  async function postFeed({ botId, taskId, kind, importance = 'info', summary }) {
    const id = newId('fed');
    await db.run('INSERT INTO feed (id, bot_id, task_id, kind, importance, summary, created_at) VALUES ($1,$2,$3,$4,$5,$6, clock_timestamp())',
      [id, botId || null, taskId || null, kind, importance, summary]);
    const item = await db.one('SELECT * FROM feed WHERE id=$1', [id]);
    emit('feed', item);
    return item;
  }
  async function listFeed(user, { botId, importance, unread } = {}) {
    const visible = new Set((await listBots(user)).map((b) => b.id));
    const rows = await db.all(`SELECT f.*, (r.user_id IS NOT NULL) AS read FROM feed f
      LEFT JOIN feed_reads r ON r.feed_id=f.id AND r.user_id=$1 ORDER BY f.created_at DESC LIMIT 300`, [user.id]);
    return rows.filter((f) => (!f.bot_id || visible.has(f.bot_id))
      && (!botId || f.bot_id === botId) && (!importance || f.importance === importance) && (!unread || !f.read));
  }
  async function setFeedRead(user, feedId, read) {
    if (read) await db.run('INSERT INTO feed_reads (feed_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [feedId, user.id]);
    else await db.run('DELETE FROM feed_reads WHERE feed_id=$1 AND user_id=$2', [feedId, user.id]);
    emit('feed_read', { user_id: user.id });
  }
  async function markAllFeedRead(user) {
    const items = await listFeed(user, { unread: true });
    for (const f of items) await db.run('INSERT INTO feed_reads (feed_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [f.id, user.id]);
    emit('feed_read', { user_id: user.id });
  }

  // ---------- files ----------
  async function saveFile({ name, mime, buffer, source, uploadedBy = null, botId = null, taskId = null }) {
    const id = newId('fil');
    const safe = path.basename(name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    const dir = path.join(filesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, safe);
    fs.writeFileSync(storagePath, buffer);
    await db.run(`INSERT INTO files (id, name, mime, size, storage_path, source, uploaded_by, bot_id, task_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, clock_timestamp())`,
    [id, safe, mime || 'application/octet-stream', buffer.length, storagePath, source, uploadedBy, botId, taskId]);
    const file = shapeFile(await db.one('SELECT * FROM files WHERE id=$1', [id]));
    emit('file', file);
    return file;
  }
  async function listFiles(user, { source = 'all', type, q } = {}) {
    const rows = await db.all(`SELECT f.*, u.name AS uploaded_by_name FROM files f LEFT JOIN users u ON u.id=f.uploaded_by
      WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 500`);
    const visible = new Set((await listBots(user)).map((b) => b.id));
    return rows.map(shapeFile).filter((f) => {
      if (f.bot_id && !visible.has(f.bot_id) && f.uploaded_by !== user.id) return false;
      if (source === 'mine' && !(f.source === 'upload' && f.uploaded_by === user.id)) return false;
      if (source === 'team' && !(f.source === 'upload' && f.uploaded_by !== user.id)) return false;
      if (source === 'bots' && f.source !== 'bot') return false;
      if (type && fileType(f) !== type) return false;
      if (q && !f.name.toLowerCase().includes(String(q).toLowerCase())) return false;
      return true;
    });
  }
  async function getFile(id) {
    const row = await db.one('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [id]);
    return row ? { ...shapeFile(row), storage_path: row.storage_path } : null;
  }
  async function deleteFile(id, user) {
    await db.run('UPDATE files SET deleted_at=now() WHERE id=$1', [id]);
    await audit('user', user.id, 'file.delete', { id });
    emit('file_deleted', { id });
  }
  function shapeFile(f) {
    const { storage_path, ...rest } = f;
    return { ...rest, size: Number(f.size), type: fileType(f) };
  }

  // ---------- artifacts ----------
  async function createArtifact({ title, kind = 'document', content, format = 'markdown', botId, taskId }) {
    const id = newId('art');
    await db.run('INSERT INTO artifacts (id, title, kind, bot_id, task_id) VALUES ($1,$2,$3,$4,$5)', [id, title, kind, botId || null, taskId || null]);
    await db.run('INSERT INTO artifact_versions (id, artifact_id, version, format, content, note, created_by) VALUES ($1,$2,1,$3,$4,$5,$6)',
      [newId('arv'), id, format, content, 'First draft', botId ? 'bot' : 'user']);
    const art = await getArtifact(id);
    emit('artifact', art);
    return art;
  }
  async function addArtifactVersion(id, { content, format, note, createdBy }) {
    const last = await db.one('SELECT version, format FROM artifact_versions WHERE artifact_id=$1 ORDER BY version DESC LIMIT 1', [id]);
    if (!last) throw httpError(404, 'Artifact not found');
    await db.run('INSERT INTO artifact_versions (id, artifact_id, version, format, content, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [newId('arv'), id, last.version + 1, format || last.format, content, note || '', createdBy]);
    await db.run('UPDATE artifacts SET updated_at=now() WHERE id=$1', [id]);
    const art = await getArtifact(id);
    emit('artifact', art);
    return art;
  }
  async function getArtifact(id) {
    const art = await db.one('SELECT * FROM artifacts WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!art) return null;
    art.versions = await db.all('SELECT * FROM artifact_versions WHERE artifact_id=$1 ORDER BY version DESC', [id]);
    return art;
  }
  async function listArtifacts(user, { botId, kind, pinned } = {}) {
    const visible = new Set((await listBots(user)).map((b) => b.id));
    const rows = await db.all(`SELECT a.*, v.version, v.format, LEFT(v.content, 600) AS preview FROM artifacts a
      JOIN LATERAL (SELECT version, format, content FROM artifact_versions WHERE artifact_id=a.id ORDER BY version DESC LIMIT 1) v ON true
      WHERE a.deleted_at IS NULL ORDER BY a.pinned DESC, a.updated_at DESC LIMIT 300`);
    return rows.filter((a) => (!a.bot_id || visible.has(a.bot_id)) && (!botId || a.bot_id === botId)
      && (!kind || a.kind === kind) && (!pinned || a.pinned));
  }
  async function updateArtifact(id, { title, pinned }) {
    if (title !== undefined) await db.run('UPDATE artifacts SET title=$1 WHERE id=$2', [title, id]);
    if (pinned !== undefined) await db.run('UPDATE artifacts SET pinned=$1 WHERE id=$2', [!!pinned, id]);
    const art = await getArtifact(id);
    emit('artifact', art);
    return art;
  }
  async function deleteArtifact(id, user) {
    await db.run('UPDATE artifacts SET deleted_at=now() WHERE id=$1', [id]);
    await audit('user', user.id, 'artifact.delete', { id });
    emit('artifact_deleted', { id });
  }

  // ---------- usage ----------
  async function recordUsage({ botId, taskId, model, usage, costUsd }) {
    await db.run(`INSERT INTO usage (id, bot_id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [newId('use'), botId, taskId || null, model, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, costUsd]);
    if (taskId) await addTaskCost(taskId, costUsd);
  }
  async function monthSpend(botId) {
    const row = await db.one("SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE bot_id=$1 AND created_at >= date_trunc('month', now())", [botId]);
    return Number(row.s);
  }

  // ---------- app actions (Composio) usage meter ----------
  // Each client's plan includes a monthly number of app actions; anything over is billed.
  const DEFAULT_PLAN = { included_actions: 2000, overage_per_1000_usd: 5, hard_cap: false };
  async function billingPlan() { return { ...DEFAULT_PLAN, ...(await getSetting('billing_plan', {})) }; }

  async function appActionUsage(months = 1) {
    const rows = await db.all(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS actions
      FROM app_actions WHERE created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
      GROUP BY 1 ORDER BY 1 DESC`, [months]);
    const plan = await billingPlan();
    return rows.map((r) => {
      const over = Math.max(0, r.actions - plan.included_actions);
      return { ...r, included: plan.included_actions, overage_actions: over, overage_usd: Math.round(over * plan.overage_per_1000_usd / 10) / 100 };
    });
  }

  async function usageSummary() {
    const plan = await billingPlan();
    const [current] = await appActionUsage(1);
    const used = current ? current.actions : 0;
    return { plan, used, remaining: Math.max(0, plan.included_actions - used), overage_usd: current ? current.overage_usd : 0 };
  }

  async function checkAppActionAllowance() {
    const { plan, used } = await usageSummary();
    if (plan.hard_cap && used >= plan.included_actions) {
      throw httpError(429, `This month's ${plan.included_actions.toLocaleString()} app actions are used up. Ask KenjiFlow to raise the limit.`);
    }
  }

  async function recentAppActions(limit = 10) {
    return db.all('SELECT bot_id, task_id, toolkit, slug, ok, log_id, created_at FROM app_actions ORDER BY created_at DESC LIMIT $1', [limit]);
  }

  async function recordAppAction({ botId, taskId, toolkit, slug, ok, logId = null }) {
    await db.run('INSERT INTO app_actions (id, bot_id, task_id, toolkit, slug, ok, log_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId('act'), botId, taskId, toolkit, slug, ok, logId]);
    // Tell the team once when they reach 80% and 100% of the month's allowance.
    const { plan, used } = await usageSummary();
    for (const pct of [80, 100]) {
      if (used === Math.ceil(plan.included_actions * pct / 100)) {
        await postFeed({ kind: 'usage', importance: pct === 100 ? 'critical' : 'important', summary: pct === 100 ? `App actions: this month's ${plan.included_actions.toLocaleString()} included actions are used up${plan.hard_cap ? '. Bots can\'t use connected apps until next month' : '; extra actions are billed'}` : `App actions: ${used.toLocaleString()} of ${plan.included_actions.toLocaleString()} used this month` });
      }
    }
    emit('usage', { used });
  }

  return {
    billingPlan, appActionUsage, usageSummary, checkAppActionAllowance, recordAppAction, recentAppActions,
    bus, emit, audit, getSetting, setSetting,
    createUser, login, userForToken, logout, listUsers, getUser,
    canSeeBot, listBots, getBot, createBot, updateBot, deleteBot,
    addMessage, listMessages, apiHistory,
    createTask, getTask, taskDetail, listTasks, updateTask, addStep, addNote, listNotes,
    seedTemplates, listTemplates, getTemplate, saveTemplate, deleteTemplate,
    requestApproval, decideApproval, askFeedback, answerFeedback,
    postFeed, listFeed, setFeedRead, markAllFeedRead,
    saveFile, listFiles, getFile, deleteFile,
    createArtifact, addArtifactVersion, getArtifact, listArtifacts, updateArtifact, deleteArtifact,
    recordUsage, monthSpend,
  };
}

function fileType(f) {
  const ext = path.extname(f.name).toLowerCase();
  if (/^image\//.test(f.mime)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.csv', '.xlsx', '.xls'].includes(ext)) return 'spreadsheet';
  if (['.doc', '.docx', '.md', '.txt', '.rtf'].includes(ext)) return 'document';
  return 'other';
}

function statusLabel(s) {
  return {
    queued: 'Queued', in_progress: 'In Progress', approval_needed: 'Approval Needed', awaiting_feedback: 'Awaiting Feedback',
    review: 'Ready for review', scheduled: 'Scheduled', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
  }[s] || s;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createStore, httpError, statusLabel, TASK_STATUSES };
