// Long-term memory through Honcho (honcho.dev), the memory layer Bops also uses.
// Every staff member and every bot is a Honcho peer, and each bot's chat is one
// Honcho session. Honcho reasons over the conversations in the background and
// builds up what it knows about each person; all bots in the business share it
// (one Honcho workspace per client). Without HONCHO_API_KEY (or HONCHO_URL for a
// self-hosted Honcho) the app runs as before, with no long-term memory.
const { Honcho } = require('@honcho-ai/sdk');

const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'x';
const userPeerId = (user) => safeId(`user-${user.id}`);
const botPeerId = (bot) => safeId(`bot-${bot.id}`);

function createMemory({
  store,
  apiKey = process.env.HONCHO_API_KEY,
  baseURL = process.env.HONCHO_URL,
  workspaceId = process.env.HONCHO_WORKSPACE_ID,
  clientFactory,
} = {}) {
  const enabled = Boolean(apiKey || baseURL || clientFactory);
  let client = null;
  const sessions = new Map(); // bot id -> Honcho session, peers already added

  async function honcho() {
    if (client) return client;
    let ws = workspaceId;
    if (!ws) {
      const biz = await store.getSetting('business', {});
      ws = safeId(`kf-${biz.name || 'business'}`);
    }
    const opts = { workspaceId: ws, timeout: 8000, maxRetries: 1 };
    if (apiKey) opts.apiKey = apiKey;
    if (baseURL) opts.baseURL = baseURL;
    client = clientFactory ? clientFactory(opts) : new Honcho(opts);
    return client;
  }

  // Bots don't build a picture of themselves; people do (observeMe defaults to true).
  async function sessionFor(bot, user) {
    const h = await honcho();
    let entry = sessions.get(bot.id);
    if (!entry) {
      entry = { session: await h.session(safeId(`chat-${bot.id}`)), peers: new Set() };
      await entry.session.addPeers({ [botPeerId(bot)]: { observeMe: false } });
      sessions.set(bot.id, entry);
    }
    if (user && !entry.peers.has(user.id)) {
      await entry.session.addPeers(userPeerId(user));
      entry.peers.add(user.id);
    }
    return entry.session;
  }

  // What the bot should know about this person for this message, as plain text ('' if nothing).
  async function recall({ user, query }) {
    if (!enabled || !user) return '';
    try {
      const h = await honcho();
      const peer = await h.peer(userPeerId(user));
      const ctx = await peer.context({ searchQuery: String(query || '').slice(0, 500), searchTopK: 8, maxConclusions: 25 });
      const parts = [];
      if (ctx.peerCard?.length) parts.push(ctx.peerCard.map((c) => `- ${c}`).join('\n'));
      if (ctx.representation) parts.push(ctx.representation.trim());
      return parts.join('\n\n').slice(0, 4000);
    } catch (err) {
      console.warn('[memory] recall failed:', err.message);
      return '';
    }
  }

  // Saves one exchange so Honcho can learn from it. Never blocks or fails the chat.
  async function record({ bot, user, userText, botText }) {
    if (!enabled || !user || (!userText && !botText)) return;
    try {
      const h = await honcho();
      const session = await sessionFor(bot, user);
      const [person, assistant] = await Promise.all([h.peer(userPeerId(user)), h.peer(botPeerId(bot))]);
      const msgs = [];
      if (userText) msgs.push(person.message(userText, { metadata: { name: user.name } }));
      if (botText) msgs.push(assistant.message(botText, { metadata: { name: bot.name } }));
      await session.addMessages(msgs);
    } catch (err) {
      console.warn('[memory] record failed:', err.message);
    }
  }

  return { enabled, recall, record };
}

module.exports = { createMemory };
