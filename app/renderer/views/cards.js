// Inline cards shown in chat and on the task page: tasks, approvals, questions,
// artifacts and files. Actions are wired by bindCardActions().
import { api, downloadFile } from '../api.js';
import { esc, statusChip, toast, bytes, icon, modal } from '../ui.js';
import { state, taskById, botById } from '../app.js';
import { openTask } from './tasks.js';
import { openArtifact } from './library.js';

export function cardHTML(card) {
  switch (card.type) {
    case 'task': return taskCard(taskById(card.task_id), card.task_id);
    case 'approval': return approvalCard(taskById(card.task_id));
    case 'feedback': return feedbackCard(taskById(card.task_id));
    case 'artifact': return artifactCard(state.artifacts.find((a) => a.id === card.artifact_id), card.artifact_id);
    case 'file': return fileCard(state.files.find((f) => f.id === card.file_id));
    case 'event': return `<div class="event-line">${esc(card.text)}</div>`;
    default: return '';
  }
}

function taskCard(t, id) {
  if (!t) return `<div class="card card-task"><span class="mono">${esc(id)}</span></div>`;
  return `<button class="card card-task" data-open-task="${t.id}">
    <span class="card-kicker">${t.status === 'done' ? 'Task complete' : t.status === 'review' ? 'Ready for your review' : 'Task created'} <span class="mono">${esc(t.id)}</span></span>
    <span class="card-title">${esc(t.title)}</span>
    ${statusChip(t.status)}
  </button>`;
}

export function approvalCard(t, { full = false } = {}) {
  if (!t || !t.approval) return '';
  const a = t.approval;
  const p = a.payload || {};
  const decided = a.decision;
  const email = a.action === 'send_email' ? p
    : p.slug === 'GMAIL_SEND_EMAIL' ? { to: p.arguments.recipient_email || p.arguments.to, subject: p.arguments.subject, body: p.arguments.body } : null;
  const preview = email
    ? `<div class="email-preview"><div><span class="muted">To</span> ${esc(email.to)}</div><div><span class="muted">Subject</span> <strong>${esc(email.subject)}</strong></div><pre>${esc(email.body)}</pre></div>`
    : a.action === 'app_action'
      ? `<div class="email-preview"><div><span class="muted">App action</span> <span class="mono">${esc(p.slug)}</span> <span class="chip chip-${p.risk === 'delete' || p.risk === 'pay' ? 'danger' : 'warning'}">${esc(p.risk)}</span></div>${Object.entries(p.arguments || {}).map(([k, v]) => `<div><span class="muted">${esc(k)}</span> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`).join('')}</div>`
      : `<pre>${esc(JSON.stringify(p, null, 2))}</pre>`;
  if (decided) {
    return `<div class="card card-approval decided">
      <span class="card-kicker">${decided === 'approve' ? 'Approved' : 'Rejected'} by ${esc(a.decided_by_name)}${a.edited ? ' · edited first' : ''}</span>
      <span class="card-title">${esc(a.summary)}</span>
      ${full ? preview : ''}
    </div>`;
  }
  const canApprove = state.user.role === 'owner' || (a.roles || []).includes(state.user.role);
  return `<div class="card card-approval" data-task="${t.id}">
    <span class="card-kicker warn">Approval needed <span class="mono">${esc(t.id)}</span></span>
    <span class="card-title">${esc(a.summary)}</span>
    ${preview}
    <div class="why">${esc(a.rule || '')}</div>
    ${canApprove ? `<div class="card-actions">
      <button class="btn btn-primary" data-approve="${t.id}">Approve</button>
      ${a.action === 'send_email' ? `<button class="btn" data-edit-approve="${t.id}">Edit, then approve</button>` : ''}
      <button class="btn btn-ghost" data-reject="${t.id}">Reject</button>
    </div>` : `<div class="muted small">Waiting for ${esc((a.roles || []).join(' or '))} to approve.</div>`}
  </div>`;
}

export function feedbackCard(t) {
  if (!t || !t.feedback) return '';
  const f = t.feedback;
  if (f.answer) {
    return `<div class="card card-feedback decided"><span class="card-kicker">Answered by ${esc(f.answered_by_name)}</span><span class="card-title">${esc(f.question)}</span><div>${esc(f.answer)}</div></div>`;
  }
  return `<form class="card card-feedback" data-feedback="${t.id}">
    <span class="card-kicker warn">Awaiting your feedback <span class="mono">${esc(t.id)}</span></span>
    <span class="card-title">${esc(f.question)}</span>
    <div class="row"><input name="answer" placeholder="Type your answer…" autocomplete="off"><button class="btn btn-primary" type="submit">Reply</button></div>
  </form>`;
}

function artifactCard(a, id) {
  if (!a) return `<div class="card"><span class="muted">Artifact ${esc(id)}</span></div>`;
  return `<button class="card card-artifact" data-open-artifact="${a.id}">
    <span class="card-icon">${icon.doc}</span>
    <span><span class="card-kicker">Artifact · ${esc(a.kind)}</span><span class="card-title">${esc(a.title)}</span><span class="muted small">v${a.version} · click to open</span></span>
  </button>`;
}

function fileCard(f) {
  if (!f) return '';
  return `<button class="card card-file" data-download="${f.id}">
    <span class="card-icon">${icon.file}</span>
    <span><span class="card-title">${esc(f.name)}</span><span class="muted small">${bytes(f.size)} · ${f.source === 'bot' ? `made by ${esc(botById(f.bot_id)?.name || 'a bot')}` : 'uploaded'}</span></span>
  </button>`;
}

export function bindCardActions(root) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-open-task],[data-approve],[data-edit-approve],[data-reject],[data-open-artifact],[data-download]');
    if (!b) return;
    if (b.dataset.openTask) return openTask(b.dataset.openTask);
    if (b.dataset.openArtifact) return openArtifact(b.dataset.openArtifact);
    if (b.dataset.download) return downloadFile(state.files.find((f) => f.id === b.dataset.download));
    if (b.dataset.approve) return decide(b.dataset.approve, 'approve');
    if (b.dataset.reject) return rejectWithNote(b.dataset.reject);
    if (b.dataset.editApprove) return editThenApprove(b.dataset.editApprove);
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-feedback]');
    if (!form) return;
    e.preventDefault();
    const answer = new FormData(form).get('answer');
    if (!String(answer).trim()) return;
    form.querySelector('button').disabled = true;
    try { await api('POST', `/api/tasks/${form.dataset.feedback}/feedback`, { answer }); toast('Sent. The bot is picking it back up.'); } catch (err) { toast(err.message, 'danger'); form.querySelector('button').disabled = false; }
  });
}

async function decide(taskId, decision, edits = null, note = '') {
  try {
    await api('POST', `/api/tasks/${taskId}/approve`, { decision, edits, note });
    toast(decision === 'approve' ? 'Approved' : 'Rejected. The bot will revise.', decision === 'approve' ? 'success' : 'neutral');
  } catch (err) { toast(err.message, 'danger'); }
}

function rejectWithNote(taskId) {
  const m = modal(`
    <h2>Reject</h2>
    <form id="rj-form" class="form">
      <label>What should change? <span class="muted">(the bot uses this to revise)</span><textarea name="note" rows="4" autofocus></textarea></label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-danger" type="submit">Reject</button></div>
    </form>`);
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#rj-form').onsubmit = async (e) => {
    e.preventDefault();
    const note = new FormData(e.target).get('note');
    m.close();
    await decide(taskId, 'reject', null, note);
  };
}

function editThenApprove(taskId) {
  const t = taskById(taskId);
  const p = t.approval.payload;
  const m = modal(`
    <h2>Edit, then approve</h2>
    <p class="muted">The bot remembers what you changed and writes it your way next time.</p>
    <form id="ea-form" class="form">
      <label>To<input name="to" value="${esc(p.to)}"></label>
      <label>Subject<input name="subject" value="${esc(p.subject)}"></label>
      <label>Message<textarea name="body" rows="10">${esc(p.body)}</textarea></label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Approve and send</button></div>
    </form>`, { wide: true });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#ea-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const edits = {};
    for (const k of ['to', 'subject', 'body']) if (fd.get(k) !== p[k]) edits[k] = fd.get(k);
    m.close();
    await decide(taskId, 'approve', edits);
  };
}
