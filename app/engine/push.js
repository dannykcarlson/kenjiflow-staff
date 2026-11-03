// Phone notifications (Web Push) for things that need a person: approvals and bot questions.
// Each person turns them on from the phone page (/m) on their own phone. The server's
// signing keys (VAPID) are made once and stored encrypted with the other secrets.
const { newId } = require('./util');

// Feed kinds that should reach someone's phone, and who gets them.
const NOTIFY = {
  approval_requested: { title: 'Approval needed', who: (task) => (user) => user.role === 'owner' || ((task.approval && task.approval.roles) || []).includes(user.role) },
  feedback_requested: { title: 'A bot has a question', who: (task) => (user) => ['owner', 'manager'].includes(user.role) || user.id === task.created_by },
};

function createPush({ db, store, secrets, sender }) {
  let webpush = sender || null; // tests pass a fake sender
  let keys = null;

  async function vapidKeys() {
    if (keys) return keys;
    keys = await secrets.get('vapid_keys');
    if (!keys) {
      keys = require('web-push').generateVAPIDKeys();
      await secrets.set('vapid_keys', keys);
    }
    return keys;
  }

  async function client() {
    if (webpush) return webpush;
    const { publicKey, privateKey } = await vapidKeys();
    webpush = require('web-push');
    // Push services want a way to reach whoever runs the server.
    const subject = process.env.KF_PUSH_CONTACT || (/^https:/.test(process.env.KF_PUBLIC_URL || '') ? process.env.KF_PUBLIC_URL : 'mailto:support@kenjiflow.com');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return webpush;
  }

  async function publicKey() { return (await vapidKeys()).publicKey; }

  async function subscribe(user, sub, label) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      const err = new Error('That browser did not give a usable push subscription');
      err.status = 400;
      throw err;
    }
    await db.run('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
    await db.run('INSERT INTO push_subscriptions (id, user_id, endpoint, keys, label) VALUES ($1,$2,$3,$4,$5)',
      [newId('psh'), user.id, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), String(label || '').slice(0, 80)]);
    await store.audit('user', user.id, 'push.subscribe', { label: label || '' });
  }

  async function unsubscribe(user, endpoint) {
    await db.run('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [user.id, String(endpoint || '')]);
  }

  async function devices(user) {
    return db.all('SELECT id, label, created_at, last_ok_at FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at', [user.id]);
  }

  // Sends to every device of every matching person. Dead subscriptions are removed.
  async function notify(match, payload) {
    const users = (await store.listUsers()).filter(match);
    if (!users.length) return 0;
    const subs = await db.all(`SELECT * FROM push_subscriptions WHERE user_id IN (${users.map((_, i) => `$${i + 1}`).join(',')})`, users.map((u) => u.id));
    if (!subs.length) return 0;
    const wp = await client();
    let sent = 0;
    for (const s of subs) {
      try {
        await wp.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'high' });
        await db.run('UPDATE push_subscriptions SET last_ok_at=now() WHERE id=$1', [s.id]);
        sent++;
      } catch (err) {
        if ([404, 410].includes(err.statusCode)) await db.run('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        else console.error('[push]', err.statusCode || '', err.message);
      }
    }
    return sent;
  }

  async function onFeed(item) {
    const rule = NOTIFY[item.kind];
    if (!rule || !item.task_id) return;
    const task = await store.getTask(item.task_id);
    if (!task) return;
    const bot = task.bot_id ? await store.getBot(task.bot_id) : null;
    await notify(rule.who(task), {
      title: `${rule.title}${bot ? ` · ${bot.name}` : ''}`,
      body: item.summary.replace(/^(Approval requested|Needs your input): /, ''),
      url: `/m/#${task.id}`,
      tag: task.id,
    });
  }

  function start() {
    store.bus.on('event', ({ type, data }) => {
      if (type === 'feed') onFeed(data).catch((err) => console.error('[push]', err.message));
    });
  }

  return { publicKey, subscribe, unsubscribe, devices, notify, start };
}

module.exports = { createPush };
