const bcrypt = require('bcryptjs');
const store = require('./store');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

// Strip sensitive fields before sending a technician/customer object out over the API
// — including the one-time email login code, which should never round-trip to the client.
function sanitizePerson(p) {
  if (!p) return p;
  const { passwordHash, loginCode, loginCodeExpiresAt, loginCodeAttempts, ...rest } = p;
  return { ...rest, hasPassword: !!passwordHash };
}

// Each of these checks not just that the session cookie has the relevant id, but that
// the record it points to still exists — otherwise a deleted technician/owner/admin
// would stay "logged in" on any device that already had a valid signed cookie until
// it naturally expired (30 days), even though their account was removed.
function sessionGuard(sessionKey, collection) {
  return function requireAuth(req, res, next) {
    const id = req.session && req.session[sessionKey];
    if (!id || !store.getById(collection, id)) {
      if (req.session) req.session = null;
      return res.status(401).json({ error: 'Not logged in' });
    }
    return next();
  };
}

// Express middleware: require a logged-in technician session
const requireTechAuth = sessionGuard('technicianId', 'technicians');

// Express middleware: require a logged-in owner session
const requireOwnerAuth = sessionGuard('ownerId', 'owners');

// Express middleware: require a logged-in admin session (gates the main office dashboard)
const requireAdminAuth = sessionGuard('adminId', 'admins');

module.exports = {
  hashPassword,
  checkPassword,
  sanitizeTechnician: sanitizePerson,
  sanitizeCustomer: sanitizePerson,
  sanitizeOwner: sanitizePerson,
  sanitizeAdmin: sanitizePerson,
  requireTechAuth,
  requireOwnerAuth,
  requireAdminAuth,
};
