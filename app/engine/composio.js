// App connections through Composio, run on KenjiFlow's Composio account.
// Each client gets its own Composio project (its own API key), so a client's server
// can only reach that client's connections. Clients never sign up for anything:
// they click Connect, sign in to the app (Gmail, HubSpot, QuickBooks…) and that's it.
const crypto = require('crypto');

// Apps offered in Settings. Any other Composio toolkit slug can be added by a KenjiFlow Admin.
const APP_CATALOG = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'quickbooks', name: 'QuickBooks' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'googledrive', name: 'Google Drive' },
  { slug: 'googlesheets', name: 'Google Sheets' },
  { slug: 'outlook', name: 'Outlook' },
  { slug: 'xero', name: 'Xero' },
  { slug: 'calendly', name: 'Calendly' },
  { slug: 'notion', name: 'Notion' },
];

// Risk tag from the action name (e.g. GMAIL_SEND_EMAIL -> send). Unclear = write, which
// still needs approval under "Ask for everything".
function riskOf(slug) {
  const action = String(slug).toUpperCase().split('_').slice(1).join('_');
  if (/(^|_)(DELETE|REMOVE|TRASH|PURGE|VOID|ARCHIVE|CANCEL|DEACTIVATE)(_|$)/.test(action)) return 'delete';
  if (/(^|_)(PAY|PAYMENT|PAYMENTS|CHARGE|REFUND|TRANSFER|PAYOUT|BILL_PAYMENT)(_|$)/.test(action)) return 'pay';
  if (/(^|_)(SEND|REPLY|FORWARD|POST|PUBLISH|INVITE|SHARE|BROADCAST|NOTIFY)(_|$)/.test(action)) return 'send';
  if (/^(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|DOWNLOAD|EXPORT|COUNT|CHECK)(_|$)/.test(action)) return 'read';
  return 'write';
}

function createComposio({ store, secrets, clientFactory }) {
  let client = null;
  let clientKey = null;
  let toolkitsCache = { at: 0, list: [] };
  const toolCache = new Map(); // slug -> tool (schema + version)

  async function apiKey() {
    const saved = await secrets.get('composio_api_key');
    return (saved && saved.key) || process.env.COMPOSIO_API_KEY || null;
  }

  async function getClient() {
    const key = await apiKey();
    if (!key) throw httpError(409, 'App connections are not switched on for this workspace yet');
    if (client && clientKey === key) return client;
    if (clientFactory) client = clientFactory(key);
    else {
      const { Composio } = await import('@composio/core'); // ESM-only package
      client = new Composio({ apiKey: key });
    }
    clientKey = key;
    return client;
  }

  // One Composio user per workspace: connections belong to the business, not one person.
  async function userId() {
    let id = await store.getSetting('workspace_id', null);
    if (!id) { id = `ws_${crypto.randomBytes(8).toString('hex')}`; await store.setSetting('workspace_id', id, { silent: true }); }
    return `${id}:workspace`;
  }

  async function connections({ fresh = false } = {}) {
    if (!(await apiKey())) return [];
    if (!fresh && Date.now() - toolkitsCache.at < 60000) return toolkitsCache.list;
    const c = await getClient();
    const res = await c.connectedAccounts.list({ userIds: [await userId()] });
    const list = (res.items || []).map((a) => ({ id: a.id, toolkit: a.toolkit && a.toolkit.slug, status: a.status, created_at: a.createdAt }));
    toolkitsCache = { at: Date.now(), list };
    return list;
  }

  async function activeToolkits() {
    return [...new Set((await connections()).filter((a) => a.status === 'ACTIVE').map((a) => a.toolkit))];
  }

  async function status() {
    const key = await secrets.get('composio_api_key');
    const enabled = !!(key || process.env.COMPOSIO_API_KEY);
    let conns = [];
    let error = null;
    if (enabled) {
      try { conns = await connections({ fresh: true }); } catch (err) { error = err.message; }
      if (!error) warmAuthConfigs().catch(() => { /* Connect looks it up itself */ });
    }
    const custom = await store.getSetting('composio_extra_apps', []);
    const apps = [...APP_CATALOG, ...custom.filter((s) => !APP_CATALOG.some((a) => a.slug === s)).map((s) => ({ slug: s, name: s }))]
      .map((app) => {
        const acct = conns.find((x) => x.toolkit === app.slug && x.status === 'ACTIVE') || conns.find((x) => x.toolkit === app.slug);
        return { ...app, status: acct ? acct.status : null, connected_at: acct ? acct.created_at : null };
      });
    return { enabled, key_source: key ? 'settings' : enabled ? 'environment' : null, key_hint: key ? key.hint : null, apps, error };
  }

  async function setKey(key) {
    const probe = clientFactory ? clientFactory(key) : new (await import('@composio/core')).Composio({ apiKey: key });
    try {
      await probe.connectedAccounts.list({ limit: 1 });
    } catch (err) {
      throw httpError(400, `Composio rejected that key (${err.message})`);
    }
    await secrets.set('composio_api_key', { key, hint: key.slice(-4) });
    client = null;
    toolkitsCache = { at: 0, list: [] };
  }

  async function removeKey() {
    await secrets.remove('composio_api_key');
    client = null;
    toolkitsCache = { at: 0, list: [] };
  }

  // The project's login setup for an app: the one already there, else Composio's own
  // (Composio-managed OAuth). Apps without a Composio-managed login need one made in the dashboard.
  // IDs are remembered per key, so Connect costs one Composio call instead of three.
  let authConfigIds = { key: null, map: {} };
  async function authConfigFor(c, toolkit) {
    if (authConfigIds.key !== clientKey) authConfigIds = { key: clientKey, map: {} };
    if (authConfigIds.map[toolkit]) return authConfigIds.map[toolkit];
    const found = (await c.authConfigs.list({ toolkit })).items || [];
    let id = found[0] && found[0].id;
    if (!id) {
      try {
        id = (await c.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: `${appName(toolkit)} (KenjiFlow)` })).id;
      } catch (err) {
        throw httpError(409, `${appName(toolkit)} needs a login setup in Composio first (dashboard > Auth configs > ${appName(toolkit)}). ${err.message}`);
      }
    }
    authConfigIds.map[toolkit] = id;
    return id;
  }

  // Looks up every app's login setup in one call while Settings is open, before anyone clicks.
  async function warmAuthConfigs() {
    const c = await getClient();
    if (authConfigIds.key === clientKey && Object.keys(authConfigIds.map).length) return;
    const res = await c.authConfigs.list({});
    const map = {};
    for (const a of res.items || []) {
      const slug = a.toolkit && a.toolkit.slug;
      if (slug && !map[slug]) map[slug] = a.id;
    }
    authConfigIds = { key: clientKey, map };
  }

  // Returns a sign-in link for the app. When the person finishes, Composio marks the
  // connection ACTIVE; we wait in the background and tell the apps.
  async function connect(toolkit, user) {
    const c = await getClient();
    // The raw link call: the SDK's link() first lists existing accounts, which only adds a round trip.
    const req = await c.client.link.create({ auth_config_id: await authConfigFor(c, toolkit), user_id: await userId() });
    if (!req || !req.redirect_url) throw httpError(502, 'Composio did not return a sign-in link');
    store.audit('user', user.id, 'connector.app.connect_started', { toolkit });
    if (req.connected_account_id) {
      c.connectedAccounts.waitForConnection(req.connected_account_id, 10 * 60 * 1000).then(async () => {
        toolkitsCache = { at: 0, list: [] };
        await store.audit('user', user.id, 'connector.app.connected', { toolkit });
        await store.postFeed({ kind: 'connector', importance: 'important', summary: `${appName(toolkit)} connected` });
        store.emit('settings', { key: 'composio_connections', value: { toolkit, status: 'ACTIVE' } });
      }).catch(() => { /* person closed the tab or it timed out */ });
    }
    return req.redirect_url;
  }

  async function disconnect(toolkit, user) {
    const c = await getClient();
    for (const acct of (await connections({ fresh: true })).filter((a) => a.toolkit === toolkit)) {
      await c.connectedAccounts.delete(acct.id);
    }
    toolkitsCache = { at: 0, list: [] };
    await store.audit('user', user.id, 'connector.app.disconnect', { toolkit });
    store.emit('settings', { key: 'composio_connections', value: { toolkit, status: null } });
  }

  // Actions the bot can take in a connected app, matched to what it wants to do.
  async function searchActions({ toolkit, query, limit = 8 }) {
    const active = await activeToolkits();
    const kits = toolkit ? [toolkit.toLowerCase()] : active;
    if (toolkit && !active.includes(toolkit.toLowerCase())) throw httpError(409, `${appName(toolkit)} is not connected. Ask an Owner to connect it in Settings.`);
    if (!kits.length) throw httpError(409, 'No apps are connected yet');
    const c = await getClient();
    const tools = await c.tools.getRawComposioTools({ toolkits: kits, search: query || undefined, limit: Math.min(15, limit) });
    for (const t of tools) toolCache.set(t.slug, t);
    return tools.map((t) => ({
      slug: t.slug, app: t.toolkit ? t.toolkit.slug : null, description: String(t.description || t.name || '').slice(0, 400),
      risk: riskOf(t.slug), input_schema: t.inputParameters || { type: 'object', properties: {} },
    }));
  }

  async function describe(slug) {
    if (toolCache.has(slug)) return toolCache.get(slug);
    const c = await getClient();
    const [tool] = await c.tools.getRawComposioTools({ tools: [slug] });
    if (!tool) throw httpError(404, `No app action called ${slug}`);
    toolCache.set(slug, tool);
    return tool;
  }

  // Runs one action and records it on the usage meter (this is what Composio bills).
  async function run(slug, args, { botId = null, taskId = null } = {}) {
    const tool = await describe(slug);
    const app = tool.toolkit ? tool.toolkit.slug : slug.split('_')[0].toLowerCase();
    if (!(await activeToolkits()).includes(app)) throw httpError(409, `${appName(app)} is not connected`);
    await store.checkAppActionAllowance();
    const c = await getClient();
    const res = await c.tools.execute(slug, {
      userId: await userId(),
      arguments: args || {},
      ...(tool.version ? { version: tool.version } : { dangerouslySkipVersionCheck: true }),
    });
    await store.recordAppAction({ botId, taskId, toolkit: app, slug, ok: !!res.successful, logId: res.logId || null });
    if (!res.successful) throw httpError(502, `${appName(app)} said: ${res.error || 'the action failed'}${res.logId ? ` (Composio log ${res.logId})` : ''}`);
    return res.data;
  }

  // ---------- triggers (events from connected apps) ----------
  async function listTriggerTypes(toolkit) {
    if (!(await activeToolkits()).includes(toolkit)) throw httpError(409, `${appName(toolkit)} is not connected`);
    const c = await getClient();
    const res = await c.triggers.listTypes({ toolkits: [toolkit], limit: 50 });
    return (res.items || []).map((t) => ({ slug: t.slug, name: t.name, description: t.description, config: t.config || {} }));
  }

  async function createTrigger(slug, config) {
    const c = await getClient();
    const res = await c.triggers.create(await userId(), slug, { triggerConfig: config || {} });
    if (!res || !res.triggerId) throw httpError(502, 'Composio did not create the trigger');
    return { triggerId: res.triggerId };
  }

  async function deleteTrigger(triggerId) {
    if (triggerId) await (await getClient()).triggers.delete(triggerId);
  }

  async function setTriggerEnabled(triggerId, on) {
    const c = await getClient();
    await (on ? c.triggers.enable(triggerId) : c.triggers.disable(triggerId));
  }

  // Realtime event stream for this workspace's triggers; works without a public URL.
  async function subscribeTriggers(fn, onError) {
    const c = await getClient();
    await c.triggers.subscribe((evt) => { Promise.resolve(fn(evt)).catch((err) => console.error('[trigger event]', err)); }, { userId: await userId() }, onError);
  }

  return {
    status, setKey, removeKey, connect, disconnect, activeToolkits, searchActions, describe, run, riskOf,
    listTriggerTypes, createTrigger, deleteTrigger, setTriggerEnabled, subscribeTriggers, currentKey: apiKey,
  };
}

function appName(slug) {
  const hit = APP_CATALOG.find((a) => a.slug === String(slug).toLowerCase());
  return hit ? hit.name : slug;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { createComposio, riskOf, APP_CATALOG, appName };
