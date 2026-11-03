import { api, setToken } from '../api.js';
import { esc } from '../ui.js';
import { avatarSVG } from '../avatars.js';

export function renderLogin(onSignedIn) {
  document.body.innerHTML = `
    <div class="login">
      <form class="login-card" id="login-form">
        <div class="login-faces">
          ${avatarSVG({ variant: 'pebble', body: '#2563EB', eye: '#22D3EE', accent: '#22D3EE' }, 52)}
          ${avatarSVG({ variant: 'bean', body: '#F4F7FB', eye: '#22D3EE', accent: '#22D3EE' }, 60)}
          ${avatarSVG({ variant: 'cube', body: '#1B2A44', eye: '#FFFFFF', accent: '#22D3EE' }, 52)}
        </div>
        <img class="login-logo logo-light" src="assets/kenjiflow-logo-horizontal-color.svg" alt="KenjiFlow">
        <img class="login-logo logo-dark" src="assets/kenjiflow-logo-horizontal-reversed.svg" alt="" aria-hidden="true">
        <h1>Sign in to your team</h1>
        <label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" id="login-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <p class="muted small login-server" id="login-server" hidden></p>
      </form>
    </div>`;
  const form = document.getElementById('login-form');
  if (window.kf && window.kf.server) showServer();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { token } = await api('POST', '/api/login', { email: fd.get('email'), password: fd.get('password') });
      setToken(token);
      await onSignedIn();
    } catch (err) {
      document.getElementById('login-error').textContent = esc(err.message);
      btn.disabled = false;
    }
  });
}

// Desktop app only: which company server it talks to, and a way to change it.
async function showServer() {
  const el = document.getElementById('login-server');
  const { url, local, fromEnv } = await window.kf.server();
  el.hidden = false;
  el.innerHTML = `Server: ${local ? 'this computer' : `<span class="mono">${esc(url.replace(/^https?:\/\//, ''))}</span>`}${fromEnv ? '' : ' · <button type="button" class="link" data-change-server>Change</button>'}`;
  el.querySelector('[data-change-server]')?.addEventListener('click', async () => {
    const next = window.prompt('Your company server address (https://…). Leave empty to run on this computer.', local ? '' : url);
    if (next === null) return;
    try {
      el.textContent = 'Checking the server…';
      await window.kf.setServer(next); // the app restarts on success
    } catch (err) {
      document.getElementById('login-error').textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      showServer();
    }
  });
}
