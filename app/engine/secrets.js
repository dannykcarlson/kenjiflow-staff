// Secrets at rest (Claude key, Google OAuth tokens): AES-256-GCM. The master key
// comes from KF_SECRET_KEY, or a key file created once in the data folder.
// Secrets are never sent to the app; the API only says whether one is set.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadMasterKey(dataDir) {
  if (process.env.KF_SECRET_KEY) return crypto.createHash('sha256').update(process.env.KF_SECRET_KEY).digest();
  const file = path.join(dataDir, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return key;
  }
}

function createSecrets(store, dataDir) {
  const key = loadMasterKey(dataDir);

  function seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  function open(box) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
  }

  return {
    async get(name) {
      const box = await store.getSetting(`secret:${name}`, null);
      if (!box) return null;
      try { return open(box); } catch { return null; } // wrong master key: treat as unset
    },
    async set(name, value) {
      await store.setSetting(`secret:${name}`, seal(value), { silent: true });
    },
    async remove(name) {
      await store.setSetting(`secret:${name}`, null, { silent: true });
    },
  };
}

module.exports = { createSecrets };
