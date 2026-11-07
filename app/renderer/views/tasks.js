// Tasks: board, list, "my approvals", templates and recurring tasks, plus the task detail panel.
// Bots move finished work to "Ready for review"; only a person marks a task done.
import { api, uploadFile } from '../api.js';
import { esc, timeAgo, statusChip, toast, modal, money, icon, STATUS, bytes } from '../ui.js';
import { avatarSVG } from '../avatars.js';
import { state, botById, taskById } from '../app.js';
import { approvalCard, feedbackCard, bindCardActions } from './cards.js';
import { recurringHTML, onRecurringClick, onRecurringToggle } from './recurring.js';

const COLUMNS = ['approval_needed', 'awaiting_feedback', 'review', 'in_progress', 'queued', 'scheduled', 'done'];
const CLOSED = ['done', 'failed', 'cancelled'];
let tab = 'board';
let botFilter = '';
let openId = null;
let detailModal = null;
let templates = null; // loaded on first use
const canManage = () => ['owner', 'manager', 'admin'].includes(state.user.role);

async function loadTemplates() {
  templates = await api('GET', '/api/templates');
  return templates;
}

export function render(main) {
  const visible = state.tasks.filter((t) => !botFilter || t.bot_id === botFilter);
  const mine = visible.filter((t) => t.status === 'approval_needed' && t.approval && (state.user.role === 'owner' || (t.approval.roles || []).includes(state.user.role)));
  const tabs = [['board', 'Board'], ['list', 'List'], ['mine', `My approvals${mine.length ? ` <b class="badge badge-warning">${mine.length}</b>` : ''}`], ['templates', 'Templates'], ['recurring', 'Recurring']];
  main.innerHTML = `
    <section class="page">
      <header class="view-head">
        <div><h1>Tasks</h1><p class="muted">${tab === 'templates' ? 'Reusable tasks: instructions, the right bot and any files it needs.' : tab === 'recurring' ? 'Work your bots repeat on their own, on a schedule or when something happens in an app.' : 'Everything your bots are doing, and what needs you.'}</p></div>
        <div class="head-actions">
          <div class="seg" role="tablist">
            ${tabs.map(([k, l]) => `<button role="tab" class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
          </div>
          ${tab === 'templates' ? '' : `<select id="bot-filter" aria-label="Filter by bot"><option value="">All bots</option>${state.bots.map((b) => `<option value="${b.id}" ${botFilter === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`}
          ${tab === 'templates'
            ? (canManage() ? `<button class="btn btn-primary" id="new-template">${icon.plus} New template</button>` : '')
            : `<button class="btn btn-primary" id="new-task">${icon.plus} New task</button>`}
        </div>
      </header>
      <div class="page-body" id="tasks-body">
        ${tab === 'board' ? board(visible) : tab === 'list' ? list(visible) : tab === 'mine' ? list(mine, 'Nothing is waiting for your approval.') : tab === 'templates' ? templatesHTML() : recurringHTML(botFilter)}
      </div>
    </section>`;
  main.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(main); } };
  main.querySelector('#bot-filter')?.addEventListener('change', (e) => { botFilter = e.target.value; render(main); });
  main.querySelector('#new-task')?.addEventListener('click', () => newTask());
  main.querySelector('#new-template')?.addEventListener('click', () => editTemplate(null));
  main.querySelector('#tasks-body').onclick = async (e) => { if (tab === 'recurring' && await onRecurringClick(e)) return; onBodyClick(e); };
  main.querySelector('#tasks-body').onchange = (e) => { if (tab === 'recurring') onRecurringToggle(e); };
  if (tab === 'templates' && !templates) loadTemplates().then(() => { if (tab === 'templates') render(main); }).catch((err) => toast(err.message, 'danger'));
}

export function onEvent({ type, data }) {
  if (type === 'template' || type === 'template_deleted') { templates = null; if (tab !== 'templates') return; }
  if (['trigger', 'trigger_deleted'].includes(type) && tab !== 'recurring') return;
  if (['task', 'bot', 'bot_deleted', 'template', 'template_deleted', 'trigger', 'trigger_deleted'].includes(type)) render(document.getElementById('main'));
  if (detailModal && (type === 'task' && data.id === openId || type === 'artifact' || type === 'file')) refreshDetail();
}

async function onBodyClick(e) {
  const t = e.target.closest('[data-open-task],[data-use-template],[data-edit-template]');
  if (!t) return;
  if (t.dataset.openTask) return openTask(t.dataset.openTask);
  if (t.dataset.editTemplate) return editTemplate(templates.find((x) => x.id === t.dataset.editTemplate));
  if (t.dataset.useTemplate) {
    try {
      const task = await api('POST', `/api/templates/${t.dataset.useTemplate}/use`, {});
      toast(task.bot_id ? `${task.id} started with ${botById(task.bot_id)?.name || 'its bot'}` : `${task.id} created`, 'success');
      openTask(task.id);
    } catch (err) { toast(err.message, 'danger'); }
  }
}

function board(tasks) {
  return `<div class="board">${COLUMNS.map((s) => {
    const items = tasks.filter((t) => t.status === s || (s === 'done' && ['failed', 'cancelled'].includes(t.status)));
    return `<div class="col col-${s}">
      <div class="col-head"><span>${STATUS[s].label}</span><span class="mono muted">${items.length}</span></div>
      <div class="col-body">${items.slice(0, s === 'done' ? 12 : 50).map(taskTile).join('') || '<div class="col-empty">Nothing here</div>'}</div>
    </div>`;
  }).join('')}</div>`;
}

function taskTile(t) {
  const bot = botById(t.bot_id);
  const extra = t.status === 'awaiting_feedback' && t.feedback ? `<div class="tile-q">“${esc(t.feedback.question)}”</div>`
    : t.status === 'approval_needed' && t.approval ? `<div class="tile-q">${esc(t.approval.summary)}</div>`
      : t.description ? `<div class="tile-desc">${esc(t.description)}</div>` : '';
  return `<button class="tile" data-open-task="${t.id}">
    <div class="tile-top"><span class="mono muted">${esc(t.id)}</span>${t.priority === 'high' ? '<span class="chip chip-danger">High</span>' : ''}${['failed', 'cancelled'].includes(t.status) ? statusChip(t.status) : ''}</div>
    <div class="tile-title">${esc(t.title)}</div>
    ${extra}
    <div class="tile-foot">${bot ? `<span class="tile-bot">${avatarSVG(bot.avatar, 20)}${esc(bot.name)}</span>` : '<span class="muted">Unassigned</span>'}<span class="muted">${timeAgo(t.updated_at)}</span></div>
  </button>`;
}

function list(tasks, empty = 'No tasks yet.') {
  if (!tasks.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table">
    <div class="tr th"><span>Task</span><span>Bot</span><span>Status</span><span>Source</span><span>Updated</span></div>
    ${tasks.map((t) => {
      const bot = botById(t.bot_id);
      return `<button class="tr" data-open-task="${t.id}">
        <span><span class="mono muted">${esc(t.id)}</span> ${esc(t.title)}${t.description ? `<span class="tr-sub">${esc(t.description)}</span>` : ''}</span>
        <span>${bot ? `<span class="tile-bot">${avatarSVG(bot.avatar, 20)}${esc(bot.name)}</span>` : '—'}</span>
        <span>${statusChip(t.status)}</span>
        <span class="muted">${esc(t.source)}</span>
        <span class="muted">${timeAgo(t.updated_at)}</span>
      </button>`;
    }).join('')}
  </div>`;
}

// ---------- templates ----------
function templatesHTML() {
  if (!templates) return '<div class="empty small">Loading…</div>';
  if (!templates.length) return `<div class="empty">No templates yet.${canManage() ? ' Add one with New template.' : ''}</div>`;
  return `<div class="tpl-grid">${templates.map((t) => {
    const bot = botById(t.bot_id);
    return `<div class="tpl-card">
      <div class="tpl-title">${esc(t.title)}${t.priority === 'high' ? ' <span class="chip chip-danger">High</span>' : ''}</div>
      <p class="muted small">${esc(t.description || t.instructions || 'No instructions yet.')}</p>
      <div class="tpl-meta">
        ${bot ? `<span class="tile-bot">${avatarSVG(bot.avatar, 20)}${esc(bot.name)}</span>` : '<span class="muted small">No bot set</span>'}
        ${t.files.length ? `<span class="muted small">${icon.clip} ${t.files.length} file${t.files.length > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="tpl-actions">
        <button class="btn btn-primary" data-use-template="${t.id}">Start task</button>
        ${canManage() ? `<button class="btn btn-ghost" data-edit-template="${t.id}">Edit</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function editTemplate(existing) {
  const draft = existing
    ? { ...existing, files: [...existing.files] }
    : { title: '', description: '', instructions: '', bot_id: state.bots[0]?.id || '', priority: 'normal', files: [] };
  const m = modal(`
    <h2>${existing ? 'Edit template' : 'New template'}</h2>
    <form class="form" id="tpl-form">
      <label>Title<input name="title" required value="${esc(draft.title)}" placeholder="e.g. Onboard a new client"></label>
      <label>Short description<input name="description" maxlength="300" value="${esc(draft.description)}" placeholder="One line for the task board (left blank, it's written for you)"></label>
      <label>Instructions for the bot<textarea name="instructions" rows="7" placeholder="Steps, what done looks like, anything to avoid">${esc(draft.instructions)}</textarea></label>
      <div class="form-row">
        <label>Bot<select name="bot_id"><option value="">Pick when starting</option>${state.bots.map((b) => `<option value="${b.id}" ${draft.bot_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        <label>Priority<select name="priority">${['normal', 'high', 'low'].map((p) => `<option value="${p}" ${draft.priority === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
      </div>
      <div class="tpl-files">
        <span class="label-text">Files the bot gets with every task</span>
        <div id="tpl-file-list"></div>
        <button type="button" class="btn btn-ghost" id="tpl-add-file">${icon.clip} Add files</button>
        <input type="file" id="tpl-file-input" multiple hidden>
      </div>
      <div class="modal-actions">
        ${existing ? '<button type="button" class="btn btn-ghost danger-text" data-delete>Delete template</button><span class="grow"></span>' : ''}
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn btn-primary" type="submit">${existing ? 'Save' : 'Create template'}</button>
      </div>
    </form>`, { wide: true });
  const form = m.el.querySelector('#tpl-form');
  const fileList = m.el.querySelector('#tpl-file-list');
  const drawFiles = () => {
    fileList.innerHTML = draft.files.map((f) => `<span class="attach-chip">${icon.file}${esc(f.name)} <span class="muted">${bytes(f.size)}</span><button type="button" class="icon-btn" data-remove-file="${f.id}" aria-label="Remove ${esc(f.name)}">${icon.x}</button></span>`).join('')
      || '<span class="muted small">No files. Add a checklist, price list or example the bot should follow.</span>';
  };
  drawFiles();
  fileList.onclick = (e) => { const b = e.target.closest('[data-remove-file]'); if (b) { draft.files = draft.files.filter((f) => f.id !== b.dataset.removeFile); drawFiles(); } };
  const input = m.el.querySelector('#tpl-file-input');
  m.el.querySelector('#tpl-add-file').onclick = () => input.click();
  input.onchange = async () => {
    for (const file of input.files) {
      try { draft.files.push(await uploadFile(file)); drawFiles(); } catch (err) { toast(`${file.name}: ${err.message}`, 'danger'); }
    }
    input.value = '';
  };
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete the template "${existing.title}"? Tasks already started from it are kept.`)) return;
    try { await api('DELETE', `/api/templates/${existing.id}`); m.close(); toast('Template deleted'); } catch (err) { toast(err.message, 'danger'); }
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const body = { title: fd.title, description: fd.description, instructions: fd.instructions, bot_id: fd.bot_id || null, priority: fd.priority, file_ids: draft.files.map((f) => f.id) };
    try {
      await api(existing ? 'PATCH' : 'POST', existing ? `/api/templates/${existing.id}` : '/api/templates', body);
      m.close();
      toast(existing ? 'Template saved' : 'Template created', 'success');
    } catch (err) { toast(err.message, 'danger'); }
  };
}

async function newTask() {
  const list = templates || await loadTemplates().catch(() => []);
  const m = modal(`
    <h2>New task</h2>
    <form class="form" id="nt-form">
      ${list.length ? `<label>Start from a template<select name="template"><option value="">—</option>${list.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></label>` : ''}
      <label>Title<input name="title" required autofocus placeholder="e.g. Chase overdue invoices"></label>
      <label>Short description<input name="description" maxlength="300" placeholder="Optional: written for you if left blank"></label>
      <label>Instructions<textarea name="instructions" rows="4" placeholder="What does done look like?"></textarea></label>
      <div class="form-row">
        <label>Assign to<select name="bot_id"><option value="">Nobody yet</option>${state.bots.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
        <label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
        <label>Due<input name="due_at" type="date"></label>
      </div>
      <p class="muted small" id="nt-files" hidden></p>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Create task</button></div>
    </form>`, { wide: true });
  const form = m.el.querySelector('#nt-form');
  let fileIds = [];
  m.el.querySelector('[data-cancel]').onclick = m.close;
  form.template?.addEventListener('change', (e) => {
    const t = list.find((x) => x.id === e.target.value);
    fileIds = t ? t.files.map((f) => f.id) : [];
    const note = m.el.querySelector('#nt-files');
    note.hidden = !fileIds.length;
    if (t && t.files.length) note.textContent = `The bot also gets: ${t.files.map((f) => f.name).join(', ')}`;
    if (!t) return;
    form.title.value = t.title;
    form.description.value = t.description;
    form.instructions.value = t.instructions;
    form.priority.value = t.priority;
    if (t.bot_id) form.bot_id.value = t.bot_id;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    try {
      const task = await api('POST', '/api/tasks', { title: fd.title, description: fd.description, instructions: fd.instructions, bot_id: fd.bot_id || null, priority: fd.priority, due_at: fd.due_at || null, file_ids: fileIds });
      m.close();
      toast(fd.bot_id ? `${task.id} assigned to ${botById(fd.bot_id).name}` : `${task.id} created`, 'success');
    } catch (err) { toast(err.message, 'danger'); }
  };
}

// ---------- task detail ----------
export async function openTask(id) {
  openId = id;
  detailModal?.close();
  detailModal = modal('<div class="task-detail" id="task-detail"><div class="empty small">Loading…</div></div>', { wide: true, onClose: () => { detailModal = null; openId = null; } });
  bindCardActions(detailModal.el);
  detailModal.el.addEventListener('click', onDetailClick);
  detailModal.el.addEventListener('submit', onDetailSubmit);
  detailModal.el.addEventListener('keydown', onDetailKey);
  await refreshDetail();
}

let editing = null; // 'title' | 'description' | 'reopen' while that field is open

const JOB_STATUS = { running: ['Running', 'brand'], done: ['Finished', 'success'], stopped: ['Stopped', 'warning'], failed: ['Failed', 'danger'] };

function bigJobCard(j) {
  const [label, tone] = JOB_STATUS[j.status] || [j.status, 'neutral'];
  const cost = j.status === 'running' ? `up to ${money(Number(j.budget_usd))}` : money(Number(j.cost_usd));
  return `<div class="card big-job">
    <div class="big-job-head"><span class="card-title">${esc(j.title)}</span><span class="chip chip-${tone}">${label}</span></div>
    <div class="muted small">${cost}${j.web ? ' · used the web' : ''} · started ${timeAgo(j.created_at)}</div>
    ${j.error ? `<div class="small">${esc(j.error)}</div>` : ''}
    ${j.summary ? `<div class="pre-wrap small">${esc(j.summary)}</div>` : ''}
    ${j.status === 'running' ? `<div class="row-actions"><button class="btn btn-sm" data-stop-job="${j.id}">Stop</button></div>` : ''}
  </div>`;
}

async function refreshDetail() {
  if (!openId || !detailModal) return;
  let t;
  try { t = await api('GET', `/api/tasks/${openId}`); } catch (err) { toast(err.message, 'danger'); return; }
  const el = detailModal.el.querySelector('#task-detail');
  if (!el) return;
  // Don't wipe a field someone is typing in when a live update arrives.
  if (editing && el.querySelector('[data-editing]')) return;
  editing = null;
  const bot = botById(t.bot_id);
  const live = taskById(t.id);
  if (live) Object.assign(live, t);
  const open = !CLOSED.includes(t.status);
  el.innerHTML = `
    <div class="td-head">
      <div class="td-titles">
        <span class="mono muted">${esc(t.id)}</span> ${statusChip(t.status)}${t.priority === 'high' ? ' <span class="chip chip-danger">High</span>' : ''}
        <h2 class="editable" data-edit="title" title="Click to edit the title">${esc(t.title)}<span class="edit-hint">${icon.pencil}</span></h2>
        <p class="td-desc editable ${t.description ? '' : 'muted'}" data-edit="description" title="Click to edit the description">${esc(t.description || 'Add a short description')}<span class="edit-hint">${icon.pencil}</span></p>
      </div>
      <button class="icon-btn" data-close aria-label="Close">${icon.x}</button>
    </div>
    <div class="td-grid">
      <div class="td-main">
        ${t.status === 'review' ? `<div class="card card-review">
          <span class="card-kicker">${bot ? esc(bot.name) : 'The bot'} thinks this is finished</span>
          ${t.result ? `<div>${esc(t.result)}</div>` : ''}
          <div class="row-actions" id="review-actions">
            <button class="btn btn-primary" data-mark-done>Mark done</button>
            <button class="btn" data-reopen>Not yet, send back…</button>
          </div>
        </div>` : ''}
        ${t.approval ? approvalCard(t, { full: true }) : ''}
        ${t.feedback ? feedbackCard(t) : ''}
        ${t.result && t.status !== 'review' ? `<div class="card"><span class="card-kicker">Result</span><div>${esc(t.result)}</div></div>` : ''}
        ${t.instructions ? `<div><h3>Instructions</h3><p class="pre-wrap">${esc(t.instructions)}</p></div>` : ''}
        ${t.artifacts.length || t.files.length ? `<h3>Outputs</h3><div class="outputs">
          ${t.artifacts.map((a) => `<button class="card card-artifact" data-open-artifact="${a.id}"><span class="card-icon">${icon.doc}</span><span class="card-title">${esc(a.title)}</span></button>`).join('')}
          ${t.files.map((f) => `<button class="card card-file" data-download="${f.id}"><span class="card-icon">${icon.file}</span><span class="card-title">${esc(f.name)}</span></button>`).join('')}
        </div>` : ''}
        ${(t.big_jobs || []).length ? `<h3>Big jobs</h3>${t.big_jobs.map(bigJobCard).join('')}` : ''}
        <div class="notes">
          <h3>Notes</h3>
          ${t.notes.length ? `<ul class="note-list">${t.notes.map((n) => `<li><div class="note-meta"><strong>${esc(n.user_name || 'Someone')}</strong> <span class="muted small">${timeAgo(n.created_at)}</span></div><div class="pre-wrap">${esc(n.text)}</div></li>`).join('')}</ul>` : '<p class="muted small">No notes yet. Notes are for your team; the bot sees them when the task is sent back to it.</p>'}
          <form class="note-form" id="note-form"><textarea name="text" rows="2" placeholder="Add a note…" required></textarea><button class="btn" type="submit">Add note</button></form>
        </div>
        <div class="td-actions">
          ${open && t.status !== 'review' ? '<button class="btn btn-primary" data-mark-done>Mark done</button>' : ''}
          ${bot ? `<button class="btn" data-chat="${bot.id}">Open chat with ${esc(bot.name)}</button>` : ''}
          ${['failed', 'cancelled'].includes(t.status) && bot ? `<button class="btn" data-retry="${t.id}">Retry</button>` : ''}
          ${open ? `<button class="btn btn-ghost" data-cancel-task="${t.id}">Cancel task</button>` : ''}
        </div>
      </div>
      <aside class="td-side">
        <dl>
          <dt>Bot</dt><dd>${bot ? `<span class="tile-bot">${avatarSVG(bot.avatar, 20)}${esc(bot.name)}</span>` : 'Unassigned'}</dd>
          <dt>Source</dt><dd>${esc(t.source)}${t.created_by_type === 'bot' ? ' (bot)' : ''}</dd>
          <dt>Created</dt><dd>${timeAgo(t.created_at)}</dd>
          ${t.due_at ? `<dt>Due</dt><dd>${new Date(t.due_at).toLocaleDateString()}</dd>` : ''}
          <dt>AI cost</dt><dd class="mono">${money(t.cost_usd)}</dd>
        </dl>
        <h3>Steps</h3>
        <ol class="steps">${t.steps.map((s) => `<li><span>${esc(s.text)}</span><span class="muted small">${timeAgo(s.created_at)}</span></li>`).join('')}</ol>
      </aside>
    </div>`;
}

function startEdit(field) {
  const el = detailModal.el.querySelector(`[data-edit="${field}"]`);
  const t = taskById(openId);
  if (!el || !t) return;
  editing = field;
  const value = field === 'title' ? t.title : (t.description || '');
  el.outerHTML = field === 'title'
    ? `<form class="inline-edit" data-editing="title"><input name="value" value="${esc(value)}" maxlength="200" required aria-label="Task title"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-ghost" type="button" data-stop-edit>Cancel</button></form>`
    : `<form class="inline-edit" data-editing="description"><input name="value" value="${esc(value)}" maxlength="300" placeholder="One line: what this task is about" aria-label="Task description"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-ghost" type="button" data-stop-edit>Cancel</button></form>`;
  const input = detailModal.el.querySelector('[data-editing] input');
  input.focus();
  input.select();
}

function startReopen() {
  const box = detailModal.el.querySelector('#review-actions');
  if (!box) return;
  editing = 'reopen';
  box.outerHTML = `<form class="note-form" data-editing="reopen"><textarea name="value" rows="2" placeholder="What's left to do? The bot gets this note." required></textarea><div class="row-actions"><button class="btn btn-primary" type="submit">Send back to the bot</button><button class="btn btn-ghost" type="button" data-stop-edit>Cancel</button></div></form>`;
  detailModal.el.querySelector('[data-editing] textarea').focus();
}

async function onDetailSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const value = new FormData(form).get(form.id === 'note-form' ? 'text' : 'value');
  try {
    if (form.id === 'note-form') await api('POST', `/api/tasks/${openId}/notes`, { text: value });
    else if (form.dataset.editing === 'reopen') { await api('PATCH', `/api/tasks/${openId}`, { status: 'reopen', note: value }); toast('Sent back to the bot'); }
    else await api('PATCH', `/api/tasks/${openId}`, { [form.dataset.editing]: value });
    editing = null;
    await refreshDetail();
  } catch (err) { toast(err.message, 'danger'); }
}

function onDetailKey(e) {
  if (e.key === 'Escape' && editing) { e.stopPropagation(); editing = null; refreshDetail(); }
}

async function onDetailClick(e) {
  const edit = e.target.closest('[data-edit]');
  if (edit) return startEdit(edit.dataset.edit);
  const stop = e.target.closest('[data-stop-job]');
  if (stop) {
    if (!window.confirm('Stop this big job? Anything it has finished so far is kept.')) return;
    stop.disabled = true;
    try { await api('POST', `/api/big-jobs/${stop.dataset.stopJob}/stop`); toast('Stopping the job'); } catch (err) { stop.disabled = false; toast(err.message, 'danger'); }
    return;
  }
  const b = e.target.closest('[data-close],[data-chat],[data-retry],[data-cancel-task],[data-mark-done],[data-reopen],[data-stop-edit]');
  if (!b) return;
  if (b.hasAttribute('data-close')) return detailModal?.close();
  if (b.hasAttribute('data-stop-edit')) { editing = null; return refreshDetail(); }
  if (b.hasAttribute('data-reopen')) return startReopen();
  if (b.dataset.chat) { detailModal?.close(); const { go } = await import('../app.js'); return go({ view: 'chat', botId: b.dataset.chat }); }
  try {
    if (b.hasAttribute('data-mark-done')) { await api('PATCH', `/api/tasks/${openId}`, { status: 'done' }); toast(`${openId} marked done`, 'success'); }
    if (b.dataset.retry) await api('PATCH', `/api/tasks/${b.dataset.retry}`, { status: 'retry' });
    if (b.dataset.cancelTask) await api('PATCH', `/api/tasks/${b.dataset.cancelTask}`, { status: 'cancelled' });
    await refreshDetail();
  } catch (err) { toast(err.message, 'danger'); }
}
