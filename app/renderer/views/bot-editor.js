// Create or edit a bot: rename it, pick its face and colours, set its rules.
import { api } from '../api.js';
import { esc, modal, toast } from '../ui.js';
import { avatarSVG, VARIANTS, BODY_COLORS, EYE_COLORS, EYE_STYLES, DEFAULT_AVATAR } from '../avatars.js';
import { state, botById, go } from '../app.js';

const ROLES = [['owner', 'Owner'], ['manager', 'Manager'], ['staff', 'Staff']];

export function openBotEditor(botId) {
  const existing = botId ? botById(botId) : null;
  const draft = existing
    ? { ...existing, avatar: { ...existing.avatar } }
    : { name: '', role_title: '', description: '', instructions: '', autonomy: 'ask_risky', monthly_cap_usd: 50, allowed_roles: ['owner', 'manager', 'staff', 'admin'], avatar: { ...DEFAULT_AVATAR, variant: pickUnusedVariant() } };

  const m = modal(`<form class="bot-editor" id="bot-form"></form>`, { wide: true });
  const form = m.el.querySelector('#bot-form');

  const swatches = (list, key) => `<div class="swatches">${list.map((c) => `<button type="button" class="swatch ${draft.avatar[key].toLowerCase() === c.hex.toLowerCase() ? 'on' : ''}" style="--c:${c.hex}" data-color="${key}" data-hex="${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}
    <label class="swatch custom" title="Custom colour"><input type="color" data-custom="${key}" value="${toSixHex(draft.avatar[key])}"></label></div>`;

  const draw = () => {
    const a = draft.avatar;
    form.innerHTML = `
      <div class="be-head"><h2>${existing ? 'Bot settings' : 'New bot'}</h2></div>
      <div class="be-grid">
        <div class="be-face">
          <div class="be-preview">${avatarSVG(a, 168)}</div>
          <div class="be-sizes">${avatarSVG(a, 40)}${avatarSVG(a, 28)}${avatarSVG(a, 18)}</div>
          <div class="be-name-preview">${esc(draft.name || 'Your bot')}</div>
        </div>
        <div class="be-fields">
          <label>Name<input name="name" maxlength="40" required value="${esc(draft.name)}" placeholder="e.g. Sales, Penny, Front Desk" autofocus></label>
          <div class="form-row">
            <label>Role<input name="role_title" maxlength="60" value="${esc(draft.role_title)}" placeholder="e.g. Sales"></label>
            <label>One-line description<input name="description" maxlength="120" value="${esc(draft.description)}" placeholder="What it handles"></label>
          </div>

          <fieldset><legend>Face</legend>
            <div class="variants">${Object.entries(VARIANTS).map(([k, v]) => `<button type="button" class="variant ${a.variant === k ? 'on' : ''}" data-variant="${k}" title="${v.label}" aria-label="${v.label}">${avatarSVG({ ...a, variant: k, eyeStyle: undefined }, 54)}<span>${v.label}</span></button>`).join('')}</div>
          </fieldset>
          <div class="form-row colors">
            <fieldset><legend>Body</legend>${swatches(BODY_COLORS, 'body')}</fieldset>
            <fieldset><legend>Eyes</legend>${swatches(EYE_COLORS, 'eye')}
              <select name="eyeStyle" aria-label="Eye style"><option value="">Shape's default eyes</option>${EYE_STYLES.map((s) => `<option value="${s}" ${a.eyeStyle === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
            </fieldset>
            <fieldset><legend>Accent</legend>${swatches(EYE_COLORS, 'accent')}</fieldset>
          </div>

          <label>Instructions<textarea name="instructions" rows="5" placeholder="What this bot does, how it writes, what it must never do">${esc(draft.instructions)}</textarea></label>
          <div class="form-row">
            <label>Autonomy<select name="autonomy">
              <option value="ask_all" ${draft.autonomy === 'ask_all' ? 'selected' : ''}>Ask for everything</option>
              <option value="ask_risky" ${draft.autonomy === 'ask_risky' ? 'selected' : ''}>Ask for risky (sends, payments, deletes)</option>
              <option value="just_do_it" ${draft.autonomy === 'just_do_it' ? 'selected' : ''}>Just do it (still asks before paying or deleting)</option>
            </select></label>
            <label>Monthly AI budget ($)<input name="monthly_cap_usd" type="number" min="0" max="10000" step="1" value="${esc(draft.monthly_cap_usd)}"></label>
          </div>
          <fieldset><legend>Who can chat with it</legend><div class="checks">${ROLES.map(([r, l]) => `<label class="check"><input type="checkbox" name="role_${r}" ${draft.allowed_roles.includes(r) ? 'checked' : ''} ${r === 'owner' ? 'disabled checked' : ''}> ${l}</label>`).join('')}</div></fieldset>
        </div>
      </div>
      <div class="modal-actions">
        ${existing && ['owner', 'admin'].includes(state.user.role) ? '<button type="button" class="btn btn-ghost danger-text" data-delete>Delete bot</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn btn-primary" type="submit">${existing ? 'Save' : 'Create bot'}</button>
      </div>`;
  };

  const readFields = () => {
    const fd = new FormData(form);
    for (const k of ['name', 'role_title', 'description', 'instructions', 'autonomy']) draft[k] = fd.get(k) ?? draft[k];
    draft.monthly_cap_usd = Number(fd.get('monthly_cap_usd') || 0);
    draft.allowed_roles = ['owner', ...ROLES.slice(1).map(([r]) => r).filter((r) => fd.get(`role_${r}`)), 'admin'];
    draft.avatar.eyeStyle = fd.get('eyeStyle') || undefined;
  };

  draw();
  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.variant) { readFields(); draft.avatar.variant = b.dataset.variant; draft.avatar.eyeStyle = undefined; draw(); }
    if (b.dataset.color) { readFields(); draft.avatar[b.dataset.color] = b.dataset.hex; draw(); }
    if (b.hasAttribute('data-cancel')) m.close();
    if (b.hasAttribute('data-delete')) {
      if (!confirmDelete(existing)) return;
      try { await api('DELETE', `/api/bots/${existing.id}`); m.close(); toast(`${existing.name} deleted`); go({ view: 'tasks' }); } catch (err) { toast(err.message, 'danger'); }
    }
  });
  form.addEventListener('input', (e) => {
    if (e.target.dataset.custom) { readFields(); draft.avatar[e.target.dataset.custom] = e.target.value; draw(); }
    else if (e.target.name === 'name') { draft.name = e.target.value; form.querySelector('.be-name-preview').textContent = draft.name || 'Your bot'; }
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'eyeStyle') { readFields(); draw(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readFields();
    const body = {
      name: draft.name.trim(), role_title: draft.role_title, description: draft.description, instructions: draft.instructions,
      autonomy: draft.autonomy, monthly_cap_usd: draft.monthly_cap_usd, allowed_roles: draft.allowed_roles, avatar: draft.avatar,
    };
    try {
      const bot = existing ? await api('PATCH', `/api/bots/${existing.id}`, body) : await api('POST', '/api/bots', body);
      m.close();
      toast(existing ? 'Saved' : `${bot.name} joined the team`, 'success');
      if (!existing) go({ view: 'chat', botId: bot.id });
    } catch (err) { toast(err.message, 'danger'); }
  });
}

// Deleting removes the bot's chat history too, so ask with the real name.
function confirmDelete(bot) {
  return window.confirm(`Delete ${bot.name}? Its chat history goes with it. Tasks, files and artifacts are kept.`);
}

function pickUnusedVariant() {
  const used = new Set(state.bots.map((b) => b.avatar?.variant));
  return Object.keys(VARIANTS).find((k) => !used.has(k)) || 'bean';
}

function toSixHex(hex) {
  const h = String(hex || '#000000').replace('#', '');
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`.toLowerCase();
}
