// Settings: business profile, safety switches, team logins, sign out.
import { api } from '../api.js';
import { esc, modal, toast, icon } from '../ui.js';
import { state, signOut, cap, render } from '../app.js';

export async function openSettings() {
  const role = state.user.role;
  const isOwner = role === 'owner';
  const canPause = ['owner', 'manager'].includes(role);
  const canIntegrate = ['owner', 'admin'].includes(role);
  const users = ['owner', 'manager', 'admin'].includes(role) ? await api('GET', '/api/users') : [];
  const integ = canIntegrate ? await api('GET', '/api/integrations') : null;
  const apps = canIntegrate ? await api('GET', '/api/apps').catch(() => null) : null;
  const billing = role === 'admin' ? await api('GET', '/api/billing').catch(() => null) : null;
  const b = state.business || {};
  const m = modal(`
    <div class="modal-head"><h2>Settings</h2><button class="icon-btn" data-close aria-label="Close">${icon.x}</button></div>
    <div class="settings">
      ${integ ? integrationsHTML(integ, apps, billing, role === 'admin') : `<section><h3>AI</h3><p>${state.llm?.provider === 'mock' ? 'Demo mode: no Claude API key is set up yet. Ask the Owner to add one.' : `Claude (<span class="mono">${esc(state.llm?.model)}</span>)`}</p></section>`}
      ${canPause ? `<section>
        <h3>Safety</h3>
        <div class="setting-row"><div><strong>Kill switch</strong><p class="muted">Pause every bot at once. They stop mid-task and wait.</p></div><button class="btn ${state.paused ? 'btn-primary' : 'btn-danger'}" data-pause>${icon.power} ${state.paused ? 'Resume all bots' : 'Pause all bots'}</button></div>
        ${isOwner ? `<div class="setting-row"><div><strong>Test mode</strong><p class="muted">Bots draft but nothing leaves the business: approved emails are logged, not sent.</p></div><label class="switch"><input type="checkbox" data-test-mode ${state.testMode ? 'checked' : ''}><span></span></label></div>
        <div class="setting-row"><div><strong>Big job spend limit</strong><p class="muted">Bots can hand heavy work to a cloud sandbox. Each job stops at this limit, on your Claude bill.</p></div><label class="money-input">$<input type="number" min="0.5" max="50" step="0.5" value="${Number(state.bigJobs?.budget_usd ?? 5)}" data-job-budget aria-label="Spend limit per big job in dollars"></label></div>
        <div class="setting-row"><div><strong>Let big jobs use the web</strong><p class="muted">Lets jobs search and read websites. Their sandbox then has open internet, so a harmful web page could try to send a job's files elsewhere. Sandboxes never hold logins. Leave this off unless you need research.</p></div><label class="switch"><input type="checkbox" data-job-web ${state.bigJobs?.web ? 'checked' : ''}><span></span></label></div>` : ''}
      </section>` : ''}
      ${isOwner ? `<section>
        <h3>Business profile</h3>
        <form class="form" id="biz-form">
          <label>Business name<input name="name" value="${esc(b.name || '')}"></label>
          <label>What the business does<textarea name="about" rows="2">${esc(b.about || '')}</textarea></label>
          <label>Voice and tone<input name="voice" value="${esc(b.voice || '')}"></label>
          <div class="modal-actions"><button class="btn btn-primary" type="submit">Save profile</button></div>
        </form>
      </section>` : ''}
      ${users.length ? `<section>
        <h3>Team logins</h3>
        <div class="users">${users.map((u) => `<div class="user-row"><span class="me-avatar sm">${esc(u.name.split(' ').map((p) => p[0]).join('').slice(0, 2))}</span><span>${esc(u.name)}</span><span class="muted">${esc(u.email)}</span><span class="chip chip-neutral">${esc(cap(u.role))}</span></div>`).join('')}</div>
        ${isOwner ? `<form class="form form-inline" id="user-form">
          <input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required>
          <select name="role"><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option><option value="admin">KenjiFlow Admin</option></select>
          <input name="password" type="password" placeholder="Temporary password (8+)" minlength="8" required>
          <button class="btn" type="submit">Add</button>
        </form>` : ''}
      </section>` : ''}
      <section>
        <h3>Approve from your phone</h3>
        ${phoneHTML()}
      </section>
      ${['owner', 'admin'].includes(role) ? `<section>
        <h3>Activity log</h3>
        <div class="setting-row"><div><p class="muted">Every sign-in, approval, setting change and bot action outside the app, with who did it and when.</p></div><button class="btn" data-audit>Open activity log</button></div>
      </section>` : ''}
      <section><button class="btn btn-ghost" data-signout>Sign out</button></section>
    </div>`, { wide: true });
  m.el.querySelector('[data-audit]')?.addEventListener('click', () => openAudit());

  m.el.querySelector('[data-close]').onclick = m.close;
  m.el.querySelector('[data-signout]').onclick = () => { m.close(); signOut(); };
  if (integ) bindIntegrations(m);
  m.el.querySelector('[data-pause]')?.addEventListener('click', async () => {
    const res = await api('POST', '/api/kill-switch', { paused: !state.paused });
    state.paused = res.paused;
    m.close();
    render();
    toast(res.paused ? 'All bots paused' : 'Bots resumed', res.paused ? 'danger' : 'success');
  });
  m.el.querySelector('[data-test-mode]')?.addEventListener('change', async (e) => {
    await api('PATCH', '/api/settings', { test_mode: e.target.checked });
    state.testMode = e.target.checked;
    toast(e.target.checked ? 'Test mode on: nothing will be sent' : 'Test mode off', 'neutral');
  });
  m.el.querySelector('[data-job-web]')?.addEventListener('change', async (e) => {
    try {
      await api('PATCH', '/api/settings', { big_jobs: { web: e.target.checked } });
      toast(e.target.checked ? 'Big jobs can use the web' : 'Big jobs stay off the web', 'neutral');
    } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'danger'); }
  });
  m.el.querySelector('[data-job-budget]')?.addEventListener('change', async (e) => {
    try {
      await api('PATCH', '/api/settings', { big_jobs: { budget_usd: Number(e.target.value) } });
      toast('Spend limit saved', 'success');
    } catch (err) { e.target.value = state.bigJobs?.budget_usd ?? 5; toast(err.message, 'danger'); }
  });
  m.el.querySelector('#biz-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const business = Object.fromEntries(new FormData(e.target));
    await api('PATCH', '/api/settings', { business });
    state.business = business;
    render();
    toast('Profile saved', 'success');
  });
  m.el.querySelector('#user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/users', Object.fromEntries(new FormData(e.target)));
      m.close();
      toast('Login created', 'success');
      openSettings();
    } catch (err) { toast(err.message, 'danger'); }
  });
}

// ---------- integrations ----------
// The phone page lives on the engine at /m. It only works from a phone when the engine
// is the company server (https), not an engine running on this PC.
function phoneHTML() {
  const base = (window.kf && window.kf.engineUrl) || location.origin;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)/.test(base);
  return local
    ? '<p class="muted">Bots are running on this computer, so phones can\'t reach them. Once the business has its company server, open its address plus <span class="mono">/m</span> on your phone to approve work and get notifications, even with every PC off.</p>'
    : `<p class="muted">On your phone, open <a class="link mono" href="${esc(base)}/m/" target="_blank" rel="noopener">${esc(base.replace(/^https?:\/\//, ''))}/m</a>, sign in, and tap <strong>Get notified</strong>. On iPhone, add it to your Home Screen first.</p>`;
}

const AUDIT_LABELS = {
  login: 'signed in', 'big_job.start': 'started a big job', 'big_job.finish': 'finished a big job', 'big_job.stop': 'stopped a big job', 'big_jobs.settings': 'changed big job settings', 'approval.approve': 'approved', 'approval.reject': 'rejected', 'email.send': 'sent an email', 'app.action': 'ran an app action',
  'trigger.create': 'set up a recurring task', 'trigger.update': 'changed a recurring task', 'trigger.delete': 'removed a recurring task',
  'push.subscribe': 'turned on phone notifications', 'task.note': 'added a task note', 'bot.update': 'changed a bot', 'bot.create': 'added a bot', 'connector.app.connected': 'connected an app', 'connector.app.disconnect': 'disconnected an app',
};

async function openAudit() {
  let rows = [];
  const m = modal('<div class="modal-head"><h2>Activity log</h2><button class="icon-btn" data-close aria-label="Close">' + icon.x + '</button></div><div class="audit" id="audit-list"><p class="muted">Loading…</p></div><div class="modal-actions"><button class="btn" data-more style="display:none">Load older</button></div>', { wide: true });
  m.el.querySelector('[data-close]').onclick = m.close;
  const list = m.el.querySelector('#audit-list');
  const more = m.el.querySelector('[data-more]');
  const load = async () => {
    const before = rows.length ? rows[rows.length - 1].created_at : '';
    const page = await api('GET', `/api/audit?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    rows = rows.concat(page);
    list.innerHTML = rows.length ? rows.map((r) => {
      const detail = Object.entries(r.detail || {}).filter(([, v]) => v !== '' && v !== null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ');
      return `<div class="audit-row"><span class="mono muted">${new Date(r.created_at).toLocaleString()}</span><span><strong>${esc(r.actor_name || (r.actor_type === 'system' ? 'System' : r.actor_type))}</strong> ${esc(AUDIT_LABELS[r.action] || r.action)}</span><span class="muted small">${esc(detail)}</span></div>`;
    }).join('') : '<p class="muted">Nothing logged yet.</p>';
    more.style.display = page.length < 100 ? 'none' : '';
  };
  more.onclick = () => load().catch((err) => toast(err.message, 'danger'));
  load().catch((err) => { list.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; });
}

function integrationsHTML({ claude, gmail }, apps, billing, isAdmin) {
  const claudeStatus = claude.provider === 'mock'
    ? '<span class="chip chip-warning">Demo mode</span> No Claude key yet, so bots give scripted replies.'
    : `<span class="chip chip-success">Connected</span> <span class="mono">${esc(claude.model)}</span> ${claude.key_source === 'settings' ? `using the saved key ending <span class="mono">${esc(claude.key_hint)}</span>` : 'using the key in the engine\'s environment (.env)'}`;
  const gmailStatus = gmail.connected
    ? `<span class="chip chip-success">Connected</span> as <strong>${esc(gmail.email)}</strong>`
    : gmail.configured ? '<span class="chip chip-brand">Ready</span> Google app saved. Click Connect and sign in.' : '<span class="chip chip-neutral">Not set up</span>';
  return `
    <section>
      <h3>Claude</h3>
      <p>${claudeStatus}</p>
      <form class="form form-inline" id="claude-form" autocomplete="off">
        <input name="api_key" type="password" placeholder="${claude.key_source === 'settings' ? 'Paste a new key to replace it' : 'Paste the business\'s Anthropic API key (sk-ant-…)'}" autocomplete="off" spellcheck="false" required>
        <button class="btn btn-primary" type="submit">Save key</button>
        ${claude.key_source === 'settings' ? '<button class="btn btn-ghost" type="button" data-remove-key>Remove</button>' : ''}
      </form>
      <p class="muted small">Create a key at console.anthropic.com → API keys, in the business's own Anthropic account so they own the bill. It's checked, encrypted on the engine and never shown again.</p>
    </section>
    ${appsHTML(apps, billing, isAdmin)}
    <details class="advanced" ${gmail.connected || gmail.configured ? 'open' : ''}>
      <summary>Direct Gmail connection (advanced)</summary>
      <p class="muted small">For clients who don't want a third party in the loop: uses the client's own Google app instead of Connected apps.</p>
      <p>${gmailStatus}</p>
      ${gmail.connected ? `<div class="row-actions" style="justify-content:flex-start"><button class="btn" data-gmail-disconnect>Disconnect</button></div>` : `
      <form class="form" id="gmail-form" autocomplete="off">
        <div class="form-row">
          <label>OAuth client ID<input name="client_id" value="${esc(gmail.client_id)}" placeholder="…apps.googleusercontent.com" spellcheck="false" required></label>
          <label>Client secret<input name="client_secret" type="password" placeholder="${gmail.configured ? 'Saved (paste to replace)' : 'GOCSPX-…'}" autocomplete="off" spellcheck="false"></label>
        </div>
        <label>Authorised redirect URI (add this in Google Cloud)<div class="copy-row"><input readonly value="${esc(gmail.redirect_uri)}"><button type="button" class="btn" data-copy="${esc(gmail.redirect_uri)}">Copy</button></div></label>
        <div class="modal-actions"><button class="btn" type="submit">Save Google app</button><button class="btn btn-primary" type="button" data-gmail-connect ${gmail.configured ? '' : 'disabled'}>Connect Gmail</button></div>
      </form>`}
      <p class="muted small">Bots can search, read and send email from this account. Sends still follow approvals, and nothing goes out while test mode is on.</p>
    </details>`;
}

function appsHTML(apps, billing, isAdmin) {
  if (!apps) return '';
  const u = apps.usage;
  const pct = u.plan.included_actions ? Math.min(100, Math.round((u.used / u.plan.included_actions) * 100)) : 100;
  const over = u.used > u.plan.included_actions;
  const tile = (a) => `
    <div class="app-tile ${a.status === 'ACTIVE' ? 'on' : ''}">
      <span class="app-name">${esc(a.name)}</span>
      ${a.status === 'ACTIVE'
    ? `<span class="chip chip-success">Connected</span><button class="link small" data-app-disconnect="${esc(a.slug)}">Disconnect</button>`
    : `<button class="btn btn-sm" data-app-connect="${esc(a.slug)}">${a.status ? 'Reconnect' : 'Connect'}</button>`}
    </div>`;
  const meterNote = over
    ? `${(u.used - u.plan.included_actions).toLocaleString()} extra actions so far: about ${u.overage_usd.toFixed(2)} on next month's invoice (${u.plan.overage_per_1000_usd} per 1,000).`
    : `Each read, send or update a bot does in a connected app counts as one action. Extra actions are ${u.plan.overage_per_1000_usd} per 1,000.`;
  return `
    <section>
      <h3>Connected apps</h3>
      ${apps.enabled ? `
        <p class="muted">Click Connect and sign in to the app. Bots can then use it, and anything that sends, changes, pays or deletes still asks first.</p>
        ${apps.error ? `<p class="form-error">Couldn't reach the app connector: ${esc(apps.error)}</p>` : ''}
        <div class="app-grid">${apps.apps.map(tile).join('')}</div>
        <div class="meter">
          <div class="meter-head"><strong>App actions this month</strong><span class="mono">${u.used.toLocaleString()} / ${u.plan.included_actions.toLocaleString()} included</span></div>
          <div class="meter-bar"><i style="width:${pct}%" class="${over ? 'over' : pct >= 80 ? 'warn' : ''}"></i></div>
          <p class="muted small">${meterNote}${u.plan.hard_cap ? ' Bots stop using apps when the allowance runs out.' : ''}</p>
        </div>`
    : `<p><span class="chip chip-neutral">Not switched on</span> ${isAdmin ? "Add this client's Composio project key below." : 'KenjiFlow switches this on for you during setup.'}</p>`}
      ${isAdmin ? adminAppsHTML(apps, billing) : ''}
    </section>`;
}

function adminAppsHTML(apps, billing) {
  const plan = billing ? billing.plan : apps.usage.plan;
  const months = billing ? billing.months : [];
  return `
    <div class="admin-box">
      <div class="admin-tag">KenjiFlow Admin</div>
      <form class="form form-inline" id="composio-form" autocomplete="off">
        <input name="api_key" type="password" placeholder="${apps.key_hint ? `Project key ending ${esc(apps.key_hint)} saved (paste to replace)` : "This client's Composio project API key"}" autocomplete="off" spellcheck="false" required>
        <button class="btn" type="submit">Save key</button>
        ${apps.key_source === 'settings' ? '<button class="btn btn-ghost" type="button" data-composio-remove>Remove</button>' : ''}
      </form>
      <p class="muted small">Make one project per client in KenjiFlow's Composio account and paste that project's key, so this server can only reach this client's connections.</p>
      <form class="form form-inline" id="plan-form">
        <label>Included actions / month<input name="included_actions" type="number" min="0" step="1" value="${plan.included_actions}"></label>
        <label>Overage $ per 1,000<input name="overage_per_1000_usd" type="number" min="0" step="0.01" value="${plan.overage_per_1000_usd}"></label>
        <label class="check"><input type="checkbox" name="hard_cap" ${plan.hard_cap ? 'checked' : ''}> Stop at the limit</label>
        <button class="btn" type="submit">Save plan</button>
      </form>
      <form class="form form-inline" id="extra-apps-form">
        <input name="slugs" placeholder="Extra Composio apps, comma-separated (e.g. stripe, trello)" value="${esc(apps.apps.filter((a) => a.name === a.slug).map((a) => a.slug).join(', '))}">
        <button class="btn" type="submit">Save apps</button>
      </form>
      ${months.length ? `<div class="bill-table"><div class="bill-row th"><span>Month</span><span>Actions</span><span>Over</span><span>Overage</span></div>${months.map((r) => `<div class="bill-row"><span class="mono">${esc(r.month)}</span><span>${r.actions.toLocaleString()}</span><span>${r.overage_actions.toLocaleString()}</span><span class="mono">${r.overage_usd.toFixed(2)}</span></div>`).join('')}</div>` : ''}
    </div>`;
}


function bindIntegrations(m) {
  const reopen = () => { m.close(); openSettings(); };
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-app-connect],[data-app-disconnect],[data-composio-remove]');
    if (!b) return;
    try {
      if (b.dataset.appConnect) {
        if (b.disabled) return;
        const label = b.textContent;
        b.disabled = true;
        b.innerHTML = '<span class="spinner" aria-hidden="true"></span>Opening…';
        try {
          const { url } = await api('POST', `/api/apps/${b.dataset.appConnect}/connect`);
          window.open(url, '_blank', 'noopener'); // desktop app: opens in the real browser
          toast("Sign in to the app in your browser. This updates when it's done.");
        } finally {
          b.disabled = false;
          b.textContent = label;
        }
      } else if (b.dataset.appDisconnect) {
        if (!window.confirm("Disconnect this app? Bots stop using it until it's connected again.")) return;
        await api('DELETE', `/api/apps/${b.dataset.appDisconnect}`);
        reopen();
      } else if (b.hasAttribute('data-composio-remove')) {
        if (!window.confirm('Remove the Composio key? Connected apps stop working for this client.')) return;
        await api('DELETE', '/api/apps/key');
        reopen();
      }
    } catch (err) { toast(err.message, 'danger'); }
  });
  m.el.querySelector('#composio-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/apps/key', { api_key: new FormData(e.target).get('api_key') }); toast('Connected apps switched on', 'success'); reopen(); } catch (err) { toast(err.message, 'danger'); }
  });
  m.el.querySelector('#plan-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('PUT', '/api/billing/plan', { included_actions: Number(fd.get('included_actions')), overage_per_1000_usd: Number(fd.get('overage_per_1000_usd')), hard_cap: fd.get('hard_cap') === 'on' });
      toast('Plan saved', 'success');
      reopen();
    } catch (err) { toast(err.message, 'danger'); }
  });
  m.el.querySelector('#extra-apps-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const slugs = String(new FormData(e.target).get('slugs') || '').split(',').map((x) => x.trim()).filter(Boolean);
    try { await api('PUT', '/api/apps/extra', { slugs }); reopen(); } catch (err) { toast(err.message, 'danger'); }
  });

  m.el.querySelector('#claude-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      state.llm = await api('PUT', '/api/integrations/claude-key', { api_key: new FormData(e.target).get('api_key') });
      e.target.reset();
      toast('Claude connected. Bots are now live.', 'success');
      render();
      reopen();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; btn.textContent = 'Save key'; }
  });
  m.el.querySelector('[data-remove-key]')?.addEventListener('click', async () => {
    if (!window.confirm('Remove the saved Claude key? Bots fall back to the .env key, or demo mode.')) return;
    state.llm = await api('DELETE', '/api/integrations/claude-key');
    render();
    reopen();
  });
  m.el.querySelector('#gmail-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api('PUT', '/api/integrations/gmail/app', { client_id: fd.client_id, client_secret: fd.client_secret || undefined });
      toast('Google app saved. Now click Connect Gmail.', 'success');
      reopen();
    } catch (err) { toast(err.message, 'danger'); }
  });
  m.el.querySelector('[data-gmail-connect]')?.addEventListener('click', async () => {
    try {
      const { url } = await api('POST', '/api/integrations/gmail/connect');
      window.open(url, '_blank', 'noopener'); // desktop app: opens in the real browser
      toast('Finish signing in to Google in your browser. This updates when it\'s done.');
    } catch (err) { toast(err.message, 'danger'); }
  });
  m.el.querySelector('[data-gmail-disconnect]')?.addEventListener('click', async () => {
    if (!window.confirm('Disconnect Gmail? Bots stop reading and sending email until it\'s connected again.')) return;
    await api('DELETE', '/api/integrations/gmail');
    reopen();
  });
  m.el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Select the text and copy it', 'danger'); }
  }));
}

// Refresh the open settings when Gmail finishes connecting in the browser.
export function onSettingsEvent({ key, value }) {
  if (key === 'composio_connections' && document.querySelector('.settings')) {
    document.querySelector('.modal-backdrop')?.remove();
    openSettings();
    if (value && value.status === 'ACTIVE') toast(`${value.toolkit} connected`, 'success');
    return;
  }
  if (key === 'connector_gmail' && value && document.querySelector('.settings')) {
    document.querySelector('.modal-backdrop')?.remove();
    openSettings();
    toast('Gmail connected', 'success');
  }
}
