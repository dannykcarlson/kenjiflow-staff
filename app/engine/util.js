const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Strip anything a client shouldn't see.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

module.exports = { newId, hashPassword, verifyPassword, newToken, publicUser };
