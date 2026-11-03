// One-click chat with a bot. Requests become tasks; questions get answers.
import { api, uploadFile } from '../api.js';
import { esc, clock, toast, icon, statusChip, timeAgo } from '../ui.js';
import { avatarSVG } from '../avatars.js';
import { markdown } from '../markdown.js';
import { state, botById } from '../app.js';
import { cardHTML, bindCardActions } from './cards.js';
import { openBotEditor } from './bot-editor.js';
import { openTask } from './tasks.js';
import { createDictation, dictationAvailable } from '../dictation.js';

const AUTONOMY = { ask_all: 'Ask for everything', ask_risky: 'Ask for risky', just_do_it: 'Just do it' };
const AUTONOMY_HELP = {
  ask_all: 'Every send and record change waits for approval',
  ask_risky: 'Sends, payments and deletes wait for approval',
  just_do_it: 'Acts on its own; still asks before paying or deleting',
};

function setAutonomyMenu(root, open) {
  const btn = root?.querySelector('[data-autonomy]');
  const menu = root?.querySelector('.menu');
  if (!btn || !menu) return;
  btn.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (open) menu.querySelector('.menu-item.on')?.focus();
}
// Clicks outside the menu and Esc close it.
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) setAutonomyMenu(document.getElementById('chat-head'), false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setAutonomyMenu(document.getElementById('chat-head'), false); });
const messages = new Map();
let mounted = null; // bot id the DOM is built for
let attachments = [];
let dictation = null;

export function render(main) {
  const bot = botById(state.route.botId) || state.bots[0];
  if (!bot) { main.innerHTML = '<div class="empty">No bots yet. Add one with the + next to YOUR TEAM.</div>'; mounted = null; return; }
  if (mounted === bot.id && main.querySelector('.chat')) { renderHeader(bot); renderThread(bot); renderPanel(bot); return; }
  mounted = bot.id;
  attachments = [];
  dictation?.cancel();
  dictation = null;
  main.innerHTML = `
    <section class="chat">
      <header class="view-head" id="chat-head"></header>
      <div class="chat-row">
      <div class="chat-main">
      <div class="thread" id="thread"><div class="thread-col" id="thread-col"></div></div>
      <div class="composer-wrap">
        <form class="composer" id="composer">
          <div class="attachments" id="attachments"></div>
          <div class="dictation-bar" id="dictation-bar" hidden><span class="rec-dot"></span><span class="wave" id="wave">${'<i></i>'.repeat(24)}</span><span class="mono small" id="rec-time">0:00</span><span class="muted small" id="rec-hint">Release Ctrl+Space or click stop · Esc cancels</span></div>
          <textarea id="composer-input" rows="1" placeholder="Message ${esc(bot.name)}, or ask it to do something…"></textarea>
          <div class="composer-row">
            <button type="button" class="icon-btn" id="attach-btn" title="Attach files" aria-label="Attach files">${icon.clip}</button>
            <input type="file" id="file-input" multiple hidden>
            <span class="mono hint">Requests become tasks · questions get answers</span>
            <span class="grow"></span>
            <button type="button" class="icon-btn mic" id="mic-btn" title="Dictate (hold Ctrl+Space)" aria-label="Voice dictation">${icon.mic}</button>
            <button type="submit" class="send" id="send-btn" title="Send (Enter)" aria-label="Send">${icon.send}</button>
          </div>
        </form>
      </div>
      </div>
      <aside class="bot-panel" id="bot-panel" ${panelOpen() ? '' : 'hidden'}>
        <section><h3>Tasks</h3><div id="panel-tasks"></div></section>
        <section><h3>Special instructions</h3><div id="panel-instructions"></div></section>
      </aside>
      </div>
    </section>`;
  renderPanel(bot, true);
  bindPanel(main, bot);
  renderHeader(bot);
  bindComposer(main, bot);
  bindCardActions(main.querySelector('#thread'));
  main.querySelector('#chat-head').addEventListener('click', (e) => {
    const head = e.currentTarget;
    if (e.target.closest('[data-bot-settings]')) openBotEditor(bot.id);
    else if (e.target.closest('[data-toggle-panel]')) togglePanel(main, bot);
    else if (e.target.closest('[data-autonomy]')) setAutonomyMenu(head, head.querySelector('.menu').hidden);
    else if (e.target.closest('[data-level]')) {
      const level = e.target.closest('[data-level]').dataset.level;
      setAutonomyMenu(head, false);
      if (level === botById(bot.id)?.autonomy) return;
      api('PATCH', `/api/bots/${bot.id}`, { autonomy: level })
        .then(() => toast(`${bot.name} is now set to "${AUTONOMY[level]}"`))
        .catch((err) => toast(err.message, 'danger'));
    }
  });
  if (!messages.has(bot.id)) {
    renderThread(bot);
    api('GET', `/api/bots/${bot.id}/messages`).then((list) => { messages.set(bot.id, list); if (mounted === bot.id) renderThread(bot, true); });
  } else renderThread(bot, true);
}

export function onEvent({ type, data }) {
  const bot = botById(mounted);
  if (!bot || state.route.view !== 'chat') return;
  if (type === 'message') {
    const list = messages.get(data.bot_id);
    if (list && !list.some((m) => m.id === data.id)) list.push(data);
    if (data.bot_id === mounted) renderThread(bot, true);
    return;
  }
  if (type === 'bot' && data.id === mounted) { renderHeader(bot); renderThread(bot); return; }
  if (['task', 'artifact', 'file'].includes(type)) { renderThread(bot); renderPanel(bot); }
  if (type === 'bot' && data.id === mounted) renderPanel(bot);
}

// ---------- right panel: the bot's tasks and its special instructions ----------
// Open by default; the choice is remembered per viewer.
const panelOpen = () => { try { return localStorage.getItem('kf.botPanel') !== 'hidden'; } catch { return true; } };
const CLOSED = ['done', 'failed', 'cancelled'];

function togglePanel(main, bot) {
  const open = !panelOpen();
  try { localStorage.setItem('kf.botPanel', open ? 'shown' : 'hidden'); } catch { /* ignore */ }
  main.querySelector('#bot-panel').hidden = !open;
  renderHeader(bot);
}

function renderPanel(bot, fresh = false) {
  const list = document.getElementById('panel-tasks');
  if (!list) return;
  const mine = state.tasks.filter((t) => t.bot_id === bot.id);
  const open = mine.filter((t) => !CLOSED.includes(t.status));
  const recent = mine.filter((t) => CLOSED.includes(t.status)).slice(0, 5);
  const row = (t) => `<button class="panel-task" data-open-task="${t.id}">
      <span class="panel-task-title">${esc(t.title)}</span>
      <span class="panel-task-meta">${statusChip(t.status)}<span class="muted small">${timeAgo(t.updated_at)}</span></span>
    </button>`;
  list.innerHTML = (open.length ? open.map(row).join('') : `<p class="muted small">No open tasks. Ask ${esc(bot.name)} to do something and it shows up here.</p>`)
    + (recent.length ? `<div class="panel-sub">Recently finished</div>${recent.map(row).join('')}` : '');

  // Leave the instructions box alone while someone is editing it.
  const box = document.getElementById('panel-instructions');
  const ta = box.querySelector('textarea');
  if (!fresh && ta && (document.activeElement === ta || ta.dataset.dirty)) return;
  const canEdit = ['owner', 'manager', 'admin'].includes(state.user.role);
  box.innerHTML = canEdit ? `
    <form id="instr-form">
      <textarea name="instructions" rows="9" maxlength="8000" placeholder="How ${esc(bot.name)} should work for you: tone, rules, who to copy in, things to never do…">${esc(bot.instructions || '')}</textarea>
      <div class="panel-actions"><span class="muted small" id="instr-status">Applies from the next message.</span><button class="btn btn-primary" type="submit" disabled>Save</button></div>
    </form>`
    : `<p class="pre-wrap small">${esc(bot.instructions || 'None yet.')}</p><p class="muted small">An Owner or Manager can change these.</p>`;
}

function bindPanel(main, bot) {
  const panel = main.querySelector('#bot-panel');
  panel.addEventListener('click', (e) => { const t = e.target.closest('[data-open-task]'); if (t) openTask(t.dataset.openTask); });
  panel.addEventListener('input', (e) => {
    if (e.target.name !== 'instructions') return;
    e.target.dataset.dirty = '1';
    panel.querySelector('#instr-form button[type=submit]').disabled = false;
  });
  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('PATCH', `/api/bots/${bot.id}`, { instructions: form.instructions.value });
      delete form.instructions.dataset.dirty;
      form.querySelector('#instr-status').textContent = 'Saved. Applies from the next message.';
    } catch (err) { btn.disabled = false; toast(err.message, 'danger'); }
  });
}

function renderHeader(bot) {
  const head = document.getElementById('chat-head');
  if (!head) return;
  const canEdit = ['owner', 'manager', 'admin'].includes(state.user.role);
  const level = `<i class="pill-dot ${bot.autonomy}"></i>${AUTONOMY[bot.autonomy]}`;
  // Owners and Managers change the level right here; Staff just see it.
  const autonomy = canEdit ? `
      <div class="menu-wrap">
        <button class="pill pill-btn" data-autonomy aria-haspopup="menu" aria-expanded="false" title="Choose what ${esc(bot.name)} needs approval for">${level}${icon.chevron}</button>
        <div class="menu" role="menu" hidden>
          ${Object.entries(AUTONOMY).map(([k, label]) => `
            <button class="menu-item ${k === bot.autonomy ? 'on' : ''}" role="menuitemradio" aria-checked="${k === bot.autonomy}" data-level="${k}">
              <i class="pill-dot ${k}"></i><span><b>${label}</b><small>${AUTONOMY_HELP[k]}</small></span>
            </button>`).join('')}
        </div>
      </div>` : `<span class="pill">${level}</span>`;
  head.innerHTML = `
    <div class="head-title">
      <span class="head-face">${avatarSVG(bot.avatar, 44)}</span>
      <div><h1>${esc(bot.name)}</h1><p class="muted">${esc(bot.description || bot.role_title)}</p></div>
    </div>
    <div class="head-actions">
      ${autonomy}
      ${state.llm?.provider === 'mock' ? '<span class="pill pill-warn" title="No Claude API key configured on the engine">Demo mode</span>' : ''}
      ${canEdit ? `<button class="btn" data-bot-settings>${icon.gear} Bot settings</button>` : ''}
      <button class="icon-btn" data-toggle-panel title="${panelOpen() ? 'Hide' : 'Show'} tasks and instructions" aria-label="Tasks and instructions panel" aria-expanded="${panelOpen()}">${icon.panelRight}</button>
    </div>`;
}

function renderThread(bot, scroll = false) {
  const col = document.getElementById('thread-col');
  if (!col) return;
  const thread = col.parentElement;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  const list = messages.get(bot.id);
  if (!list) { col.innerHTML = '<div class="empty small">Loading…</div>'; return; }
  const thinking = bot.status_text === 'Thinking…';
  col.innerHTML = (list.length ? '' : `
    <div class="chat-hello">
      ${avatarSVG(bot.avatar, 96)}
      <h2>Hi, I'm ${esc(bot.name)}.</h2>
      <p class="muted">${esc(bot.description || '')}. Ask me a question, or tell me what to do and I'll track it as a task.</p>
    </div>`)
    + list.map((m) => {
      const cards = (m.cards || []).map(cardHTML).join('');
      if (m.role === 'user') {
        if (!m.text) return cards;
        return `<div class="msg msg-me"><div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><span class="msg-time">${clock(m.created_at)}</span></div>${cards}`;
      }
      return `<div class="msg msg-bot">
        <span class="msg-face">${avatarSVG(bot.avatar, 34)}</span>
        <div class="msg-body">
          <div class="msg-meta"><strong>${esc(bot.name)}</strong> <span class="msg-time">${clock(m.created_at)}</span></div>
          ${m.text ? `<div class="md">${markdown(m.text)}</div>` : ''}
          ${cards}
        </div>
      </div>`;
    }).join('')
    + (thinking ? `<div class="msg msg-bot"><span class="msg-face">${avatarSVG(bot.avatar, 34)}</span><div class="typing"><i></i><i></i><i></i></div></div>` : '');
  if (scroll || nearBottom) thread.scrollTop = thread.scrollHeight;
}

function bindComposer(main, bot) {
  const form = main.querySelector('#composer');
  const input = main.querySelector('#composer-input');
  const fileInput = main.querySelector('#file-input');
  const micBtn = main.querySelector('#mic-btn');
  const bar = main.querySelector('#dictation-bar');
  let recTimer = null;
  let recStart = 0;
  let baseText = '';

  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    const ids = attachments.map((f) => f.id);
    attachments = [];
    renderAttachments(main);
    try { await api('POST', `/api/bots/${bot.id}/messages`, { text, file_ids: ids }); } catch (err) { toast(err.message, 'danger'); input.value = text; }
  });

  main.querySelector('#attach-btn').onclick = () => fileInput.click();
  fileInput.onchange = () => addFiles(main, fileInput.files).finally(() => { fileInput.value = ''; });
  const thread = main.querySelector('.chat');
  thread.addEventListener('dragover', (e) => { e.preventDefault(); thread.classList.add('dropping'); });
  thread.addEventListener('dragleave', (e) => { if (e.target === thread) thread.classList.remove('dropping'); });
  thread.addEventListener('drop', (e) => { e.preventDefault(); thread.classList.remove('dropping'); addFiles(main, e.dataTransfer.files); });

  // ---- dictation ----
  if (!dictationAvailable()) { micBtn.title = 'Dictation needs the desktop app (or a browser with speech recognition)'; micBtn.classList.add('disabled'); }
  const waves = [...bar.querySelectorAll('#wave i')];
  const setState = (s, msg) => {
    micBtn.classList.toggle('recording', s === 'recording');
    micBtn.innerHTML = s === 'recording' ? icon.stop : icon.mic;
    bar.hidden = !(s === 'recording' || s === 'transcribing');
    bar.querySelector('#rec-hint').textContent = s === 'transcribing' ? 'Transcribing on this PC…' : 'Release Ctrl+Space or click stop · Esc cancels';
    if (s === 'recording') { recStart = Date.now(); recTimer = setInterval(() => { const t = Math.floor((Date.now() - recStart) / 1000); bar.querySelector('#rec-time').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }, 250); } else { clearInterval(recTimer); }
    if (s === 'error') toast(`Dictation: ${msg}`, 'danger');
    if (s === 'idle' || s === 'error') { dictation = dictation && s === 'error' ? null : dictation; input.focus(); }
  };
  const startDictation = async () => {
    if (!dictationAvailable() || micBtn.classList.contains('recording')) return;
    baseText = input.value ? `${input.value.trimEnd()} ` : '';
    dictation = createDictation({
      onText: (text) => { input.value = baseText + text; autosize(); },
      onLevel: (lvl) => { waves.forEach((w, i) => { w.style.height = `${4 + Math.max(0, lvl * 18 * (0.5 + Math.abs(Math.sin(Date.now() / 120 + i))))}px`; }); },
      onState: setState,
    });
    try { await dictation.start(); } catch (err) { setState('error', err.message); }
  };
  const stopDictation = () => { if (micBtn.classList.contains('recording')) dictation?.stop(); };
  micBtn.onclick = () => (micBtn.classList.contains('recording') ? stopDictation() : startDictation());
  main.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.code === 'Space' && !e.repeat) { e.preventDefault(); startDictation(); }
    if (e.key === 'Escape' && micBtn.classList.contains('recording')) { dictation?.cancel(); input.value = baseText.trimEnd(); }
  });
  main.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.key === 'Control') stopDictation(); });
  input.focus();
}

async function addFiles(main, fileList) {
  for (const file of [...fileList]) {
    try { attachments.push(await uploadFile(file)); } catch (err) { toast(`${file.name}: ${err.message}`, 'danger'); }
  }
  renderAttachments(main);
}

function renderAttachments(main) {
  const el = main.querySelector('#attachments');
  el.innerHTML = attachments.map((f, i) => `<span class="attach-chip">${icon.file}${esc(f.name)}<button type="button" data-rm="${i}" aria-label="Remove">${icon.x}</button></span>`).join('');
  el.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { attachments.splice(Number(b.dataset.rm), 1); renderAttachments(main); } };
}
