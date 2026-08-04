const express = require('express');
const store = require('../lib/store');
const { hashPassword, checkPassword, sanitizeAdmin, requireAdminAuth } = require('../lib/auth');
const router = express.Router();

// Public — tells the login page whether to show "log in" or "create the first admin account."
router.get('/status', (req, res) => {
  res.json({ hasAdmin: store.getAll('admins').length > 0 });
});

// Public, but only works once: creates the very first admin account for this install.
// After that, admins are managed from Settings (see routes/admins.js).
router.post('/setup', (req, res) => {
  if (store.getAll('admins').length > 0) {
    return res.status(400).json({ error: 'An admin account already exists — log in instead.' });
  }
  const { name, username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const admin = store.create('admins', {
    name: name || '',
    username,
    passwordHash: hashPassword(password),
  });
  req.session.adminId = admin.id;
  res.status(201).json(sanitizeAdmin(admin));
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const admin = store.getAll('admins').find(
    (a) => (a.username || '').toLowerCase() === String(username).toLowerCase()
  );
  if (!admin || !checkPassword(password, admin.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  req.session.adminId = admin.id;
  res.json(sanitizeAdmin(admin));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.adminId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const admin = store.getById('admins', req.session.adminId);
  if (!admin) {
    req.session = null;
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json(sanitizeAdmin(admin));
});

// Manage additional admin accounts — requires an existing admin session.
router.get('/accounts', requireAdminAuth, (req, res) => {
  res.json(store.getAll('admins').map(sanitizeAdmin));
});

router.post('/accounts', requireAdminAuth, (req, res) => {
  const { name, username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = store.getAll('admins').find((a) => (a.username || '').toLowerCase() === username.toLowerCase());
  if (existing) return res.status(400).json({ error: 'That username is already taken' });
  const admin = store.create('admins', { name: name || '', username, passwordHash: hashPassword(password) });
  res.status(201).json(sanitizeAdmin(admin));
});

router.delete('/accounts/:id', requireAdminAuth, (req, res) => {
  const admins = store.getAll('admins');
  if (admins.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the only admin account' });
  }
  const ok = store.remove('admins', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Admin account not found' });
  if (Number(req.params.id) === req.session.adminId) req.session = null;
  res.status(204).end();
});

module.exports = router;
