// Information Feed: the important things every bot did, with per-user read state.
import { api } from '../api.js';
import { esc, clock, dayLabel, toast } from '../ui.js';
import { avatarSVG } from '../avatars.js';
import { state, botById } from '../app.js';
import { openTask } from './tasks.js';

let filter = { bot: '', importance: '', unread: false };

export function render(main) {
  const items = state.feed.filter((f) => (!filter.bot || f.bot_id === filter.bot) && (!filter.importance || f.importance === filter.importance) && (!filter.unread || !f.read));
  const unread = state.feed.filter((f) => !f.read).length;
  const groups = [];
  for (const f of items) {
    const label = dayLabel(f.created_at);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(f);
  }
  main.innerHTML = `
    <section class="page">
      <header class="view-head">
        <div><h1>Information Feed</h1><p class="muted">${unread ? `${unread} unread` : 'All caught up'} · what your bots did that matters</p></div>
        <div class="head-actions">
          <select id="f-bot" aria-label="Filter by bot"><option value="">All bots</option>${state.bots.map((b) => `<option value="${b.id}" ${filter.bot === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
          <select id="f-imp" aria-label="Filter by importance"><option value="">All events</option>${['critical', 'important', 'info'].map((i) => `<option value="${i}" ${filter.importance === i ? 'selected' : ''}>${i[0].toUpperCase() + i.slice(1)}</option>`).join('')}</select>
          <button class="btn ${filter.unread ? 'btn-on' : ''}" id="f-unread">Unread</button>
          <button class="btn" id="read-all" ${unread ? '' : 'disabled'}>Mark all read</button>
        </div>
      </header>
      <div class="page-body feed" id="feed-body">
        ${groups.length ? groups.map((g) => `<h3 class="day">${esc(g.label)}</h3>${g.items.map(row).join('')}`).join('') : '<div class="empty">Nothing here yet.</div>'}
      </div>
    </section>`;
  main.querySelector('#f-bot').onchange = (e) => { filter.bot = e.target.value; render(main); };
  main.querySelector('#f-imp').onchange = (e) => { filter.importance = e.target.value; render(main); };
  main.querySelector('#f-unread').onclick = () => { filter.unread = !filter.unread; render(main); };
  main.querySelector('#read-all').onclick = async () => { await api('POST', '/api/feed/read-all'); state.feed.forEach((f) => { f.read = true; }); render(main); };
  main.querySelector('#feed-body').onclick = async (e) => {
    const b = e.target.closest('[data-toggle],[data-task]');
    if (!b) return;
    if (b.dataset.task) {
      const item = state.feed.find((f) => f.id === b.dataset.item);
      if (item && !item.read) setRead(item, true);
      return openTask(b.dataset.task);
    }
    const item = state.feed.find((f) => f.id === b.dataset.toggle);
    await setRead(item, !item.read);
    render(main);
  };
}

async function setRead(item, read) {
  try { await api('POST', `/api/feed/${item.id}/read`, { read }); item.read = read; } catch (err) { toast(err.message, 'danger'); }
}

function row(f) {
  const bot = botById(f.bot_id);
  return `<div class="feed-row ${f.read ? 'read' : 'unread'}">
    <span class="unread-dot"></span>
    <span class="feed-face">${bot ? avatarSVG(bot.avatar, 30) : '<img src="assets/kenjiflow-mark-color.svg" width="26" height="26" alt="">'}</span>
    <div class="feed-main">
      <div class="feed-summary">${esc(f.summary)}</div>
      <div class="feed-meta"><span>${esc(bot ? bot.name : 'KenjiFlow')}</span><span class="mono">${clock(f.created_at)}</span>${f.task_id ? `<button class="link" data-task="${f.task_id}" data-item="${f.id}">${esc(f.task_id)}</button>` : ''}</div>
    </div>
    <span class="chip chip-${f.importance === 'critical' ? 'danger' : f.importance === 'important' ? 'warning' : 'neutral'}">${f.importance[0].toUpperCase() + f.importance.slice(1)}</span>
    <button class="link small" data-toggle="${f.id}">${f.read ? 'Mark unread' : 'Mark read'}</button>
  </div>`;
}
