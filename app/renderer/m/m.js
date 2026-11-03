// Phone page: approve, answer and review bot work from anywhere, with push notifications.
// Self-contained (no imports) so it loads fast on a phone and works without the desktop UI.
const TOKEN_KEY = 'kf.m.token';
const app = document.getElementById('app');
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
let me = null;
let data = { tasks: [], bots: [], business: {} };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { signOut(); throw new Error('Please sign in again'); }
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

function signOut() {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  renderLogin();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ---------- sign in ----------
function renderLogin(error = '') {
  app.innerHTML = `
    <form class="login" id="login">
      <img src="/assets/kenjiflow-mark-color.svg" alt="" width="44" height="44">
      <h1>Approvals</h1>
      <p class="muted">Sign in with your KenjiFlow Staff login.</p>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="error" role="alert">${esc(error)}</p>
      <button class="btn primary" type="submit">Sign in</button>
    </form>`;
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('POST', '/api/login', { email: fd.get('email'), password: fd.get('password') });
      token = res.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
      await load();
    } catch (err) { renderLogin(err.message); }
  };
}

// ---------- data ----------
async function load() {
  const [boot, tasks] = await Promise.all([api('GET', '/api/bootstrap'), api('GET', '/api/tasks')]);
  me = boot.user;
  data = { tasks, bots: boot.bots || [], business: boot.business || {} };
  render();
}

const botName = (id) => (data.bots.find((b) => b.id === id) || {}).name || 'A bot';
const canApprove = (t) => me.role === 'owner' || ((t.approval && t.approval.roles) || []).includes(me.role);

function preview(t) {
  const p = (t.approval && t.approval.payload) || {};
  const args = p.arguments || {};
  const email = t.approval.action === 'send_email' ? p
    : p.slug === 'GMAIL_SEND_EMAIL' ? { to: args.recipient_email || args.to, subject: args.subject, body: args.body } : null;
  if (email) return `<dl><dt>To</dt><dd>${esc(email.to)}</dd><dt>Subject</dt><dd><strong>${esc(email.subject)}</strong></dd></dl><pre>${esc(email.body)}</pre>`;
  if (p.slug) return `<dl><dt>Action</dt><dd class="mono">${esc(p.slug)}</dd>${Object.entries(args).slice(0, 8).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')}</dl>`;
  return '';
}

function render() {
  const approvals = data.tasks.filter((t) => t.status === 'approval_needed' && t.approval && canApprove(t));
  const questions = data.tasks.filter((t) => t.status === 'awaiting_feedback' && t.feedback);
  const review = data.tasks.filter((t) => t.status === 'review');
  const nothing = !approvals.length && !questions.length && !review.length;
  app.innerHTML = `
    <header class="top">
      <div><h1>${esc(data.business.name || 'KenjiFlow Staff')}</h1><p class="muted">${esc(me.name)}</p></div>
      <button class="link" data-signout>Sign out</button>
    </header>
    <div id="notify"></div>
    ${nothing ? '<p class="empty">Nothing needs you right now.</p>' : ''}
    ${approvals.length ? `<h2>Needs your approval <span class="count">${approvals.length}</span></h2>${approvals.map((t) => `
      <article class="card warn" id="${t.id}">
        <p class="kicker">${esc(botName(t.bot_id))} · ${esc(t.title)}</p>
        <h3>${esc(t.approval.summary)}</h3>
        ${preview(t)}
        <div class="actions"><button class="btn" data-reject="${t.id}">Reject</button><button class="btn primary" data-approve="${t.id}">Approve</button></div>
      </article>`).join('')}` : ''}
    ${questions.length ? `<h2>Questions from your bots <span class="count">${questions.length}</span></h2>${questions.map((t) => `
      <article class="card" id="${t.id}">
        <p class="kicker">${esc(botName(t.bot_id))} · ${esc(t.title)}</p>
        <h3>${esc(t.feedback.question)}</h3>
        <form data-answer="${t.id}"><textarea name="answer" rows="3" required placeholder="Your answer"></textarea><div class="actions"><button class="btn primary" type="submit">Send answer</button></div></form>
      </article>`).join('')}` : ''}
    ${review.length ? `<h2>Ready for review <span class="count">${review.length}</span></h2>${review.map((t) => `
      <article class="card" id="${t.id}">
        <p class="kicker">${esc(botName(t.bot_id))}</p>
        <h3>${esc(t.title)}</h3>
        ${t.result ? `<p>${esc(t.result)}</p>` : ''}
        <div class="actions"><button class="btn primary" data-done="${t.id}">Mark done</button></div>
      </article>`).join('')}` : ''}`;
  renderNotify();
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) { target.classList.add('focus'); target.scrollIntoView({ block: 'center' }); }
}

app.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.hasAttribute('data-signout')) {
      await api('POST', '/api/logout').catch(() => {});
      return signOut();
    }
    if (b.dataset.approve || b.dataset.reject) {
      const id = b.dataset.approve || b.dataset.reject;
      const note = b.dataset.reject ? window.prompt('Why reject it? The bot sees this note. (optional)') : '';
      if (note === null) return;
      b.disabled = true;
      await api('POST', `/api/tasks/${id}/approve`, { decision: b.dataset.approve ? 'approve' : 'reject', note: note || undefined });
      toast(b.dataset.approve ? 'Approved' : 'Rejected');
      await load();
    }
    if (b.dataset.done) {
      b.disabled = true;
      await api('PATCH', `/api/tasks/${b.dataset.done}`, { status: 'done' });
      toast('Marked done');
      await load();
    }
    if (b.hasAttribute('data-enable-push')) await enablePush();
    if (b.hasAttribute('data-test-push')) {
      const { sent } = await api('POST', '/api/push/test');
      toast(sent ? 'Test notification sent' : 'No device is set up for notifications yet');
    }
  } catch (err) { b.disabled = false; toast(err.message); }
});

app.addEventListener('submit', async (e) => {
  const id = e.target.dataset.answer;
  if (!id) return;
  e.preventDefault();
  try {
    await api('POST', `/api/tasks/${id}/feedback`, { answer: new FormData(e.target).get('answer') });
    toast('Answer sent');
    await load();
  } catch (err) { toast(err.message); }
});

// ---------- notifications ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function renderNotify() {
  const box = document.getElementById('notify');
  if (!box) return;
  if (!window.isSecureContext) { box.innerHTML = '<p class="hint">Notifications need the secure (https://) address of your company server.</p>'; return; }
  if (!pushSupported()) {
    box.innerHTML = isIOS() && !standalone()
      ? '<p class="hint">To get notifications on iPhone: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, and open KenjiFlow from there.</p>'
      : '<p class="hint">This browser can\'t show notifications. Keep this page bookmarked instead.</p>';
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration('/m/');
  const sub = reg && await reg.pushManager.getSubscription();
  box.innerHTML = sub && Notification.permission === 'granted'
    ? '<p class="hint ok">Notifications are on for this phone. <button class="link" data-test-push>Send a test</button></p>'
    : Notification.permission === 'denied'
      ? '<p class="hint">Notifications are blocked for this site. Allow them in your browser settings to get approvals here.</p>'
      : '<button class="btn primary block" data-enable-push>Get notified when something needs you</button>';
}

async function enablePush() {
  const reg = await navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' });
  if ((await Notification.requestPermission()) !== 'granted') { renderNotify(); return; }
  const { key } = await api('GET', '/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
  toast('Notifications on');
  renderNotify();
}

function deviceLabel() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Browser';
}

function urlBase64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------- start ----------
if (pushSupported() && window.isSecureContext) navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) load().catch(() => {}); });
window.addEventListener('hashchange', () => { if (me) render(); });
setInterval(() => { if (token && !document.hidden) load().catch(() => {}); }, 30000);
if (token) load().catch(() => renderLogin()); else renderLogin();
