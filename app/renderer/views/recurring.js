// Recurring tasks (Tasks > Recurring): work bots repeat on a schedule or when something
// happens in a connected app. Bots set these up from chat; here people see, pause,
// test and remove them.
import { api } from '../api.js';
import { esc, timeAgo, toast, icon } from '../ui.js';
import { avatarSVG } from '../avatars.js';
import { state, botById } from '../app.js';

const canEdit = () => ['owner', 'manager', 'admin'].includes(state.user.role);

export function recurringHTML(botFilter) {
  const list = state.triggers.filter((t) => !botFilter || t.bot_id === botFilter);
  return `
    <p class="muted recurring-hint">To add or change one, ask a bot in chat, e.g. <em>"Every Monday at 9, send me a pipeline summary"</em> or <em>"Whenever a new lead emails, draft a reply"</em>.</p>
    ${list.length ? `<div class="trigger-list">${list.map(row).join('')}</div>` : '<div class="empty">No recurring tasks yet.</div>'}`;
}

function row(t) {
  const bot = botById(t.bot_id);
  return `<div class="trigger-row ${t.enabled ? '' : 'off'}" data-id="${t.id}">
    <span class="trigger-face">${bot ? avatarSVG(bot.avatar, 36) : ''}</span>
    <div class="trigger-main">
      <div class="trigger-name">${esc(t.name)} <span class="chip ${t.kind === 'schedule' ? 'chip-brand' : 'chip-success'}">${t.kind === 'schedule' ? 'Schedule' : 'App event'}</span></div>
      <div class="muted small"><strong>When</strong> ${esc(t.when)} · <strong>Who</strong> ${esc(bot ? bot.name : 'no bot')}${t.instructions ? `: ${esc(t.instructions.slice(0, 110))}${t.instructions.length > 110 ? '…' : ''}` : ''}</div>
      <div class="muted small mono">${t.next_run ? `Next ${esc(t.next_run)} · ` : ''}${t.last_fired_at ? `Last ran ${timeAgo(t.last_fired_at)} · ${t.fire_count} run${t.fire_count === 1 ? '' : 's'}` : 'Hasn\'t run yet'}${t.last_error ? ` · <span class="danger-text">${esc(t.last_error)}</span>` : ''}</div>
      <div class="trigger-events" id="events-${t.id}" hidden></div>
    </div>
    <div class="row-actions">
      <button class="btn btn-sm" data-events="${t.id}">History</button>
      ${canEdit() ? `<button class="btn btn-sm" data-run="${t.id}" title="Run it once now">Run now</button>
      <label class="switch" title="${t.enabled ? 'On' : 'Paused'}"><input type="checkbox" data-enable="${t.id}" ${t.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn" data-delete="${t.id}" aria-label="Delete">${icon.x}</button>` : ''}
    </div>
  </div>`;
}

// Returns true when the click was one of ours.
export async function onRecurringClick(e) {
  const b = e.target.closest('[data-run],[data-delete],[data-events]');
  if (!b) return false;
  try {
    if (b.dataset.run) {
      const { outcome } = await api('POST', `/api/triggers/${b.dataset.run}/run`);
      toast(outcome === 'handed to bot' ? 'Sent to the bot. Check its chat.' : `Not run: ${outcome.replace('skipped: ', '')}`, outcome === 'handed to bot' ? 'success' : 'neutral');
    }
    if (b.dataset.delete) {
      const t = state.triggers.find((x) => x.id === b.dataset.delete);
      if (!window.confirm(`Stop and delete "${t.name}"? Tasks it already created stay.`)) return true;
      await api('DELETE', `/api/triggers/${t.id}`);
    }
    if (b.dataset.events) {
      const box = document.getElementById(`events-${b.dataset.events}`);
      if (!box.hidden) { box.hidden = true; return true; }
      const events = await api('GET', `/api/triggers/${b.dataset.events}/events`);
      box.innerHTML = events.length ? events.map((ev) => `<div class="small"><span class="mono muted">${timeAgo(ev.created_at)}</span> ${esc(ev.summary)} <span class="chip ${ev.outcome === 'handed to bot' ? 'chip-success' : 'chip-neutral'}">${esc(ev.outcome)}</span></div>`).join('') : '<div class="muted small">No runs yet.</div>';
      box.hidden = false;
    }
  } catch (err) { toast(err.message, 'danger'); }
  return true;
}

export async function onRecurringToggle(e) {
  const id = e.target.dataset.enable;
  if (!id) return;
  try { await api('PATCH', `/api/triggers/${id}`, { enabled: e.target.checked }); } catch (err) { toast(err.message, 'danger'); e.target.checked = !e.target.checked; }
}
