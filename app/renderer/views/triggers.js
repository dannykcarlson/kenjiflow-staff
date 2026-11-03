// Triggers: start a bot on a schedule or when something happens in a connected app.
import { api } from '../api.js';
import { esc, timeAgo, toast, modal, icon } from '../ui.js';
import { avatarSVG } from '../avatars.js';
import { state, botById } from '../app.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Quick starts for the B2B services pack; bots are matched by name.
const TEMPLATES = [
  { name: 'Morning brief', bot: 'Chief of Staff', kind: 'schedule', schedule: { freq: 'weekdays', time: '08:30' }, instructions: 'Post a short brief: what needs approval, what\'s waiting on people, and today\'s priorities.' },
  { name: 'Chase overdue invoices', bot: 'Finance', kind: 'schedule', schedule: { freq: 'weekly', day: 5, time: '15:00' }, instructions: 'Find invoices 7+ days overdue and draft a polite reminder for each.' },
  { name: 'Follow up quiet deals', bot: 'Sales', kind: 'schedule', schedule: { freq: 'weekly', day: 1, time: '10:00' }, instructions: 'Find deals with no activity for 7 days and draft a short follow-up for each.' },
  { name: 'Triage new email', bot: 'Inbox', kind: 'app', app: 'gmail', instructions: 'If it\'s a client request, create a task. If it\'s routine, draft a reply. Ignore newsletters and receipts.' },
];

// Templates name the pack role, so they still find the bot after it's renamed.
const findBot = (role) => state.bots.find((b) => b.role_title === role) || state.bots.find((b) => b.name === role);
const canEdit = () => ['owner', 'manager', 'admin'].includes(state.user.role);

export function render(main) {
  const list = state.triggers;
  main.innerHTML = `
    <section class="page">
      <header class="view-head">
        <div><h1>Triggers</h1><p class="muted">Bots start work on their own: on a schedule, or when something happens in a connected app.</p></div>
        <div class="head-actions">${canEdit() ? `<button class="btn btn-primary" data-new>${icon.plus} New trigger</button>` : ''}</div>
      </header>
      <div class="page-body">
        ${canEdit() ? `<div class="templates">${TEMPLATES.map((t, i) => {
          const bot = findBot(t.bot);
          return `<button class="template" data-template="${i}">${bot ? avatarSVG(bot.avatar, 30) : ''}<span><strong>${esc(t.name)}</strong><span class="muted small">${esc(t.kind === 'schedule' ? scheduleText(t.schedule) : 'When a new email arrives')}</span></span></button>`;
        }).join('')}</div>` : ''}
        ${list.length ? `<div class="trigger-list">${list.map(row).join('')}</div>` : '<div class="empty">No triggers yet. Start from one of the examples above.</div>'}
      </div>
    </section>`;
  main.querySelector('.page').addEventListener('click', onClick);
  main.querySelector('.page').addEventListener('change', onToggle);
}

export function onEvent({ type }) {
  if (['trigger', 'trigger_deleted', 'bot', 'bot_deleted'].includes(type)) render(document.getElementById('main'));
}

function row(t) {
  const bot = botById(t.bot_id);
  return `<div class="trigger-row ${t.enabled ? '' : 'off'}" data-id="${t.id}">
    <span class="trigger-face">${bot ? avatarSVG(bot.avatar, 36) : ''}</span>
    <div class="trigger-main">
      <div class="trigger-name">${esc(t.name)} <span class="chip ${t.kind === 'schedule' ? 'chip-brand' : 'chip-success'}">${t.kind === 'schedule' ? 'Schedule' : 'App event'}</span></div>
      <div class="muted small"><strong>When</strong> ${esc(t.when)} · <strong>Then</strong> ${esc(bot ? bot.name : 'no bot')}${t.instructions ? `: ${esc(t.instructions.slice(0, 110))}${t.instructions.length > 110 ? '…' : ''}` : ''}</div>
      <div class="muted small mono">${t.next_run ? `Next ${esc(t.next_run)} · ` : ''}${t.last_fired_at ? `Last ran ${timeAgo(t.last_fired_at)} · ${t.fire_count} run${t.fire_count === 1 ? '' : 's'}` : 'Hasn\'t run yet'}${t.last_error ? ` · <span class="danger-text">${esc(t.last_error)}</span>` : ''}</div>
      <div class="trigger-events" id="events-${t.id}" hidden></div>
    </div>
    <div class="row-actions">
      <button class="btn btn-sm" data-events="${t.id}">History</button>
      ${canEdit() ? `<button class="btn btn-sm" data-run="${t.id}" title="Fire it now, for testing">Run now</button>
      <button class="btn btn-sm" data-edit="${t.id}">Edit</button>
      <label class="switch" title="${t.enabled ? 'On' : 'Off'}"><input type="checkbox" data-enable="${t.id}" ${t.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn" data-delete="${t.id}" aria-label="Delete">${icon.x}</button>` : ''}
    </div>
  </div>`;
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.hasAttribute('data-new')) return openEditor();
    if (b.dataset.template) return openEditor(null, TEMPLATES[b.dataset.template]);
    if (b.dataset.edit) return openEditor(state.triggers.find((t) => t.id === b.dataset.edit));
    if (b.dataset.run) {
      const { outcome } = await api('POST', `/api/triggers/${b.dataset.run}/run`);
      toast(outcome === 'handed to bot' ? 'Sent to the bot. Check its chat.' : `Not run: ${outcome.replace('skipped: ', '')}`, outcome === 'handed to bot' ? 'success' : 'neutral');
    }
    if (b.dataset.delete) {
      const t = state.triggers.find((x) => x.id === b.dataset.delete);
      if (!window.confirm(`Delete the trigger "${t.name}"?`)) return;
      await api('DELETE', `/api/triggers/${t.id}`);
    }
    if (b.dataset.events) {
      const box = document.getElementById(`events-${b.dataset.events}`);
      if (!box.hidden) { box.hidden = true; return; }
      const events = await api('GET', `/api/triggers/${b.dataset.events}/events`);
      box.innerHTML = events.length ? events.map((ev) => `<div class="small"><span class="mono muted">${timeAgo(ev.created_at)}</span> ${esc(ev.summary)} <span class="chip ${ev.outcome === 'handed to bot' ? 'chip-success' : 'chip-neutral'}">${esc(ev.outcome)}</span></div>`).join('') : '<div class="muted small">No runs yet.</div>';
      box.hidden = false;
    }
  } catch (err) { toast(err.message, 'danger'); }
}

async function onToggle(e) {
  const id = e.target.dataset.enable;
  if (!id) return;
  try { await api('PATCH', `/api/triggers/${id}`, { enabled: e.target.checked }); } catch (err) { toast(err.message, 'danger'); e.target.checked = !e.target.checked; }
}

function scheduleText(s) {
  if (s.freq === 'hourly') return `Every hour at :${s.minute}`;
  if (s.freq === 'daily') return `Every day at ${s.time}`;
  if (s.freq === 'weekdays') return `Weekdays at ${s.time}`;
  return `${DAYS[s.day - 1]}s at ${s.time}`;
}

async function openEditor(existing = null, template = null) {
  const draft = existing
    ? { ...existing, app: existing.app_event && existing.app_event.app }
    : {
      name: template ? template.name : '', kind: template ? template.kind : 'schedule', instructions: template ? template.instructions : '',
      bot_id: ((template && findBot(template.bot)) || state.bots[0] || {}).id,
      schedule: template && template.schedule ? { ...template.schedule } : { freq: 'weekdays', time: '09:00' },
      app: template ? template.app : '', max_per_hour: 20,
    };
  let apps = [];
  try { apps = ((await api('GET', '/api/apps')).apps || []).filter((a) => a.status === 'ACTIVE'); } catch { /* apps not switched on */ }
  let eventTypes = [];

  const m = modal('<form class="form" id="trg-form"></form>', { wide: true });
  const form = m.el.querySelector('#trg-form');
  const s = draft.schedule || { freq: 'weekdays', time: '09:00' };

  const draw = () => {
    const ev = eventTypes.find((t) => t.slug === draft.slug);
    const configProps = ev && ev.config && ev.config.properties ? Object.entries(ev.config.properties) : [];
    form.innerHTML = `
      <h2>${existing ? 'Edit trigger' : 'New trigger'}</h2>
      <div class="form-row">
        <label>Name<input name="name" required maxlength="60" value="${esc(draft.name)}" placeholder="e.g. Morning brief"></label>
        <label>Bot<select name="bot_id">${state.bots.map((b) => `<option value="${b.id}" ${draft.bot_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      </div>
      ${existing ? '' : `<div class="seg" role="tablist"><button type="button" class="${draft.kind === 'schedule' ? 'on' : ''}" data-kind="schedule">On a schedule</button><button type="button" class="${draft.kind === 'app' ? 'on' : ''}" data-kind="app">When something happens in an app</button></div>`}
      ${draft.kind === 'schedule' ? `
        <div class="form-row">
          <label>How often<select name="freq">${[['weekdays', 'Weekdays'], ['daily', 'Every day'], ['weekly', 'Once a week'], ['hourly', 'Every hour']].map(([k, l]) => `<option value="${k}" ${s.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${s.freq === 'weekly' ? `<label>Day<select name="day">${DAYS.map((d, i) => `<option value="${i + 1}" ${Number(s.day) === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>` : ''}
          ${s.freq === 'hourly' ? `<label>Minutes past the hour<input name="minute" type="number" min="0" max="59" value="${Number(s.minute || 0)}"></label>` : `<label>Time<input name="time" type="time" value="${esc(s.time || '09:00')}"></label>`}
        </div>`
    : existing ? `<p class="muted">When: ${esc(existing.when)}</p>` : apps.length ? `
        <div class="form-row">
          <label>App<select name="app"><option value="">Pick an app</option>${apps.map((a) => `<option value="${a.slug}" ${draft.app === a.slug ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
          <label>Event<select name="slug" ${eventTypes.length ? '' : 'disabled'}><option value="">${draft.app ? (eventTypes.length ? 'Pick an event' : 'Loading…') : 'Pick an app first'}</option>${eventTypes.map((t) => `<option value="${t.slug}" ${draft.slug === t.slug ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        </div>
        ${ev ? `<p class="muted small">${esc(ev.description || '')}</p>` : ''}
        ${configProps.map(([k, p]) => `<label>${esc(p.title || k)}${p.description ? ` <span class="muted">(${esc(p.description.slice(0, 90))})</span>` : ''}<input name="cfg_${esc(k)}" data-type="${esc(p.type || 'string')}" value="${esc((draft.config || {})[k] ?? p.default ?? '')}"></label>`).join('')}`
      : '<p class="muted">No apps are connected yet. Connect Gmail, HubSpot or another app in Settings first, or use a schedule.</p>'}
      <label>What should the bot do?<textarea name="instructions" rows="4" placeholder="e.g. If it's a client request, create a task. If routine, draft a reply.">${esc(draft.instructions || '')}</textarea></label>
      <label>Max runs per hour<input name="max_per_hour" type="number" min="1" max="500" value="${draft.max_per_hour || 20}"></label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">${existing ? 'Save' : 'Create trigger'}</button></div>`;
  };

  const read = () => {
    const fd = new FormData(form);
    draft.name = fd.get('name') ?? draft.name;
    draft.bot_id = fd.get('bot_id') ?? draft.bot_id;
    draft.instructions = fd.get('instructions') ?? draft.instructions;
    draft.max_per_hour = Number(fd.get('max_per_hour') || draft.max_per_hour || 20);
    if (draft.kind === 'schedule' && fd.get('freq')) {
      draft.schedule = { freq: fd.get('freq') };
      if (fd.get('time')) draft.schedule.time = fd.get('time');
      if (fd.get('day')) draft.schedule.day = Number(fd.get('day'));
      if (fd.get('minute') !== null) draft.schedule.minute = String(Math.max(0, Math.min(59, Number(fd.get('minute'))))).padStart(2, '0');
      Object.assign(s, draft.schedule);
    }
    if (draft.kind === 'app') {
      draft.slug = fd.get('slug') || draft.slug;
      draft.config = {};
      for (const [k, v] of fd.entries()) {
        if (!k.startsWith('cfg_') || v === '') continue;
        const type = form.querySelector(`[name="${k}"]`).dataset.type;
        draft.config[k.slice(4)] = type === 'number' || type === 'integer' ? Number(v) : type === 'boolean' ? v === 'true' : v;
      }
    }
  };

  const loadEvents = async () => {
    eventTypes = [];
    draw();
    if (!draft.app) return;
    try { eventTypes = await api('GET', `/api/trigger-types?app=${encodeURIComponent(draft.app)}`); } catch (err) { toast(err.message, 'danger'); }
    draw();
  };

  draw();
  if (draft.kind === 'app' && draft.app && !existing) loadEvents();
  form.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.kind) { read(); draft.kind = b.dataset.kind; draw(); if (draft.kind === 'app' && draft.app) loadEvents(); }
    if (b.hasAttribute('data-cancel')) m.close();
  });
  form.addEventListener('change', (e) => {
    if (['freq'].includes(e.target.name)) { read(); draw(); }
    if (e.target.name === 'app') { read(); draft.app = e.target.value; draft.slug = ''; loadEvents(); }
    if (e.target.name === 'slug') { read(); draw(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    read();
    const body = { name: draft.name, bot_id: draft.bot_id, instructions: draft.instructions, max_per_hour: draft.max_per_hour };
    try {
      if (existing) {
        if (existing.kind === 'schedule') body.schedule = draft.schedule;
        await api('PATCH', `/api/triggers/${existing.id}`, body);
      } else {
        body.kind = draft.kind;
        if (draft.kind === 'schedule') body.schedule = draft.schedule;
        else {
          const ev = eventTypes.find((t) => t.slug === draft.slug);
          if (!ev) { toast('Pick the app and the event', 'danger'); return; }
          body.app_event = { app: draft.app, slug: ev.slug, name: ev.name, config: draft.config };
        }
        await api('POST', '/api/triggers', body);
      }
      m.close();
      toast(existing ? 'Saved' : 'Trigger created', 'success');
    } catch (err) { toast(err.message, 'danger'); }
  });
}
