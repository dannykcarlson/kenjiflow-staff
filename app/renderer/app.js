// App shell: state, routing, live updates and the sidebar.
import { api, hasToken, setToken, connectLive } from './api.js';
import { esc, icon, $, toast } from './ui.js';
import { avatarSVG } from './avatars.js';
import { renderLogin } from './views/login.js';
import * as chat from './views/chat.js';
import * as tasks from './views/tasks.js';
import * as feed from './views/feed.js';
import * as library from './views/library.js';
import { openBotEditor } from './views/bot-editor.js';
import { openSettings, onSettingsEvent } from './views/settings.js';

export const state = {
  user: null, bots: [], business: {}, pack: null, testMode: true, paused: false, llm: null,
  tasks: [], feed: [], files: [], artifacts: [], triggers: [], connected: false,
  route: { view: 'chat', botId: null },
};

const VIEWS = { chat, tasks, feed, library };
let stopLive = null;

// ---------- per-viewer preferences: theme and sidebar ----------
const pref = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const setPref = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* ignore */ } };
const osDark = window.matchMedia('(prefers-color-scheme: dark)');

// No saved choice means "follow the operating system".
function applyTheme() {
  const t = pref('kf.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const isDark = () => (document.documentElement.dataset.theme || (osDark.matches ? 'dark' : 'light')) === 'dark';
function toggleTheme() {
  setPref('kf.theme', isDark() ? 'light' : 'dark');
  applyTheme();
  renderSidebar();
}
osDark.addEventListener('change', () => renderSidebar());
applyTheme();

const sideCollapsed = () => pref('kf.sidebar') === 'collapsed';
function toggleSidebar() {
  setPref('kf.sidebar', sideCollapsed() ? null : 'collapsed');
  render();
}
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && $('#sidebar')) { e.preventDefault(); toggleSidebar(); }
});

export const botById = (id) => state.bots.find((b) => b.id === id);
export const taskById = (id) => state.tasks.find((t) => t.id === id);

export function go(route) {
  state.route = route;
  try { localStorage.setItem('kf.route', JSON.stringify(route)); } catch { /* ignore */ }
  render();
}

export function render() {
  renderSidebar();
  const view = VIEWS[state.route.view] || chat;
  view.render($('#main'));
}

async function boot() {
  if (!hasToken()) return renderLogin(start);
  try { await start(); } catch (err) {
    if (err.status === 401) { setToken(null); renderLogin(start); } else throw err;
  }
}

async function start() {
  const boot = await api('GET', '/api/bootstrap');
  Object.assign(state, { user: boot.user, bots: boot.bots, business: boot.business, pack: boot.pack, testMode: boot.test_mode, paused: boot.paused, llm: boot.llm });
  [state.tasks, state.feed, state.files, state.artifacts, state.triggers] = await Promise.all([
    api('GET', '/api/tasks'), api('GET', '/api/feed'), api('GET', '/api/files'), api('GET', '/api/artifacts'), api('GET', '/api/triggers'),
  ]);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('kf.route') || 'null'); } catch { /* ignore */ }
  state.route = saved && VIEWS[saved.view] && (saved.view !== 'chat' || botById(saved.botId)) ? saved : { view: 'chat', botId: state.bots[0]?.id };
  document.body.innerHTML = `<div class="app"><aside class="sidebar" id="sidebar"></aside><main class="main" id="main"></main></div>`;
  bindSidebar();
  render();
  stopLive?.();
  stopLive = connectLive(onEvent, (ok) => { state.connected = ok; $('#conn')?.classList.toggle('off', !ok); });
}

export async function signOut() {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  stopLive?.();
  setToken(null);
  try { localStorage.removeItem('kf.route'); } catch { /* ignore */ }
  renderLogin(start);
}

// Live events from the engine: patch local state, then let the current view react.
async function onEvent({ type, data }) {
  const upsert = (list, item) => { const i = list.findIndex((x) => x.id === item.id); if (i >= 0) list[i] = item; else list.unshift(item); };
  switch (type) {
    case 'bot': if (state.bots.some((b) => b.id === data.id)) upsert(state.bots, data); else state.bots = await api('GET', '/api/bots'); break;
    case 'bot_deleted': state.bots = state.bots.filter((b) => b.id !== data.id); break;
    case 'task': upsert(state.tasks, data); break;
    case 'trigger': if (data) upsert(state.triggers, data); break;
    case 'trigger_deleted': state.triggers = state.triggers.filter((t) => t.id !== data.id); break;
    case 'feed': state.feed.unshift({ ...data, read: false }); if (data.importance === 'critical') notify(data); break;
    case 'feed_read': if (data.user_id === state.user.id) state.feed = await api('GET', '/api/feed'); break;
    case 'file': upsert(state.files, data); break;
    case 'file_deleted': state.files = state.files.filter((f) => f.id !== data.id); break;
    case 'artifact': state.artifacts = await api('GET', '/api/artifacts'); break;
    case 'artifact_deleted': state.artifacts = state.artifacts.filter((a) => a.id !== data.id); break;
    case 'settings':
      if (data.key === 'paused') state.paused = data.value;
      if (data.key === 'test_mode') state.testMode = data.value;
      if (data.key === 'llm') state.llm = data.value;
      onSettingsEvent(data);
      break;
    default: break;
  }
  renderSidebar();
  const view = VIEWS[state.route.view];
  if (view.onEvent) view.onEvent({ type, data }); else view.render($('#main'));
}

function notify(item) {
  try { new Notification('KenjiFlow Staff', { body: item.summary }); } catch { /* notifications unavailable */ }
}

// ---------- sidebar ----------
const ACTIVE = new Set(['approval_needed', 'awaiting_feedback', 'review']);

function renderSidebar() {
  const el = $('#sidebar');
  if (!el) return;
  const r = state.route;
  const needsYou = state.tasks.filter((t) => ACTIVE.has(t.status)).length;
  const unread = state.feed.filter((f) => !f.read).length;
  const canEditBots = ['owner', 'manager', 'admin'].includes(state.user.role);
  const botNeeds = (id) => state.tasks.filter((t) => t.bot_id === id && ACTIVE.has(t.status)).length;
  const dot = (b) => (botNeeds(b.id) ? 'needs' : /^(Working|Thinking)/.test(b.status_text) ? 'working' : 'idle');
  const collapsed = sideCollapsed();
  const dark = isDark();
  $('.app')?.classList.toggle('side-collapsed', collapsed);
  // Names show as tooltips only when the labels are hidden.
  const tip = (text) => (collapsed ? ` title="${esc(text)}"` : '');

  el.innerHTML = `
    <div class="brand">
      <img class="logo-light" src="assets/kenjiflow-logo-horizontal-color.svg" alt="KenjiFlow">
      <img class="logo-dark" src="assets/kenjiflow-logo-horizontal-reversed.svg" alt="" aria-hidden="true">
      <span class="brand-tag">STAFF</span>
      <button class="icon-btn" data-collapse title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'} (Ctrl+B)" aria-label="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-expanded="${!collapsed}">${icon.sidebar}</button>
    </div>
    ${state.paused ? `<div class="paused-banner">${collapsed ? 'Paused' : 'All bots paused'}</div>` : ''}
    <nav class="nav">
      <button class="nav-item ${r.view === 'tasks' ? 'active' : ''}" data-go="tasks"${tip('Tasks')}>${icon.tasks}<span>Tasks</span>${needsYou ? `<b class="badge badge-warning">${needsYou}</b>` : ''}</button>
      <button class="nav-item ${r.view === 'feed' ? 'active' : ''}" data-go="feed"${tip('Information Feed')}>${icon.feed}<span>Information Feed</span>${unread ? `<b class="badge badge-tint">${unread}</b>` : ''}</button>
      <button class="nav-item ${r.view === 'library' ? 'active' : ''}" data-go="library"${tip('Files & Artifacts')}>${icon.files}<span>Files &amp; Artifacts</span></button>
    </nav>
    <div class="team-head"><span>YOUR TEAM</span>${canEditBots ? `<button class="icon-btn" data-new-bot title="Add a bot" aria-label="Add a bot">${icon.plus}</button>` : ''}</div>
    <div class="bots">
      ${state.bots.map((b) => `
        <button class="bot-row ${r.view === 'chat' && r.botId === b.id ? 'active' : ''}" data-bot="${b.id}"${tip(`${b.name}: ${b.status_text}`)}>
          <span class="bot-face">${avatarSVG(b.avatar, 40)}<i class="status-dot ${dot(b)}"></i></span>
          <span class="bot-meta"><span class="bot-name">${esc(b.name)}</span><span class="bot-status ${dot(b) === 'needs' ? 'warn' : ''}">${esc(b.status_text)}</span></span>
          ${botNeeds(b.id) ? `<b class="badge badge-primary">${botNeeds(b.id)}</b>` : ''}
        </button>`).join('')}
    </div>
    <div class="side-foot">
      <button class="theme-row" data-theme-toggle role="switch" aria-checked="${dark}" aria-label="Dark mode" title="${dark ? 'Switch to light mode' : 'Switch to dark mode'}">
        ${dark ? icon.moon : icon.sun}<span class="label">Dark mode</span><i class="track ${dark ? 'on' : ''}"></i>
      </button>
      <div class="me"${tip(`${state.user.name} · ${cap(state.user.role)}`)}>
        <span class="me-avatar">${esc(initials(state.user.name))}</span>
        <span class="me-meta"><span class="me-name">${esc(state.user.name)}</span><span class="me-role">${esc(cap(state.user.role))} · ${esc(state.business.name || '')}</span></span>
        <i id="conn" class="conn ${state.connected ? '' : 'off'}" title="Live connection"></i>
        <button class="icon-btn" data-settings title="Settings" aria-label="Settings">${icon.gear}</button>
      </div>
    </div>`;
}

function bindSidebar() {
  $('#sidebar').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.go) go({ view: t.dataset.go, tab: t.dataset.go === 'library' ? 'files' : undefined });
    else if (t.dataset.bot) go({ view: 'chat', botId: t.dataset.bot });
    else if (t.hasAttribute('data-new-bot')) openBotEditor(null);
    else if (t.hasAttribute('data-settings')) openSettings();
    else if (t.hasAttribute('data-theme-toggle')) toggleTheme();
    else if (t.hasAttribute('data-collapse')) toggleSidebar();
  });
}

export const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

window.addEventListener('unhandledrejection', (e) => { toast(e.reason?.message || 'Something went wrong', 'danger'); });

boot();
