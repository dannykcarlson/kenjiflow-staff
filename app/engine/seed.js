// First-run setup: the Owner account, the business profile and the industry pack's bots.
// Dev/demo logins (change these for a real client install, via KF_OWNER_* env vars):
//   owner@northwind.test / kenjiflow-demo   (Owner)
//   sam@northwind.test   / kenjiflow-demo   (Staff)
const path = require('path');
const fs = require('fs');

async function seedIfEmpty(store, db) {
  const existing = await db.one('SELECT COUNT(*)::int AS n FROM users');
  if (existing.n > 0) return false;

  // A server on the internet must never start with the demo password.
  if (process.env.NODE_ENV === 'production' && !(process.env.KF_OWNER_EMAIL && process.env.KF_OWNER_PASSWORD && process.env.KF_OWNER_PASSWORD.length >= 12)) {
    throw new Error('First start on a server: set KF_OWNER_EMAIL and KF_OWNER_PASSWORD (12+ characters) for the Owner login.');
  }
  const password = process.env.KF_OWNER_PASSWORD || 'kenjiflow-demo';
  await store.createUser({
    email: process.env.KF_OWNER_EMAIL || 'owner@northwind.test',
    name: process.env.KF_OWNER_NAME || 'Maya Ruiz',
    role: 'owner',
    password,
  });
  if (!process.env.KF_OWNER_PASSWORD) {
    await store.createUser({ email: 'sam@northwind.test', name: 'Sam Patel', role: 'staff', password });
  }

  await store.setSetting('business', {
    name: process.env.KF_BUSINESS_NAME || 'Northwind Studio',
    about: 'A 9-person brand and web design studio serving B2B software companies.',
    voice: 'Warm, direct and brief. First names. No jargon.',
  });
  await store.setSetting('test_mode', true);

  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs', process.env.KF_PACK || 'b2b-services.json'), 'utf8'));
  await store.setSetting('pack', { id: pack.id, name: pack.name, task_templates: pack.task_templates });
  await store.setSetting('approval_rules', pack.approval_rules);
  for (const bot of pack.bots) await store.createBot(bot);

  await store.postFeed({ kind: 'setup', importance: 'info', summary: `Workspace set up with the ${pack.name} pack: ${pack.bots.map((b) => b.name).join(', ')}` });
  return true;
}

module.exports = { seedIfEmpty };
