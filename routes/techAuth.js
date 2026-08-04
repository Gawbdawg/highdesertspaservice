const express = require('express');
const store = require('../lib/store');
const { checkPassword, sanitizeTechnician, requireAdminAuth } = require('../lib/auth');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const tech = store.getAll('technicians').find(
    (t) => (t.username || '').toLowerCase() === String(username).toLowerCase()
  );
  if (!tech || !checkPassword(password, tech.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  req.session.technicianId = tech.id;
  res.json(sanitizeTechnician(tech));
});

// Lets a logged-in admin jump straight into a technician's portal view without
// needing that technician's password.
router.post('/admin-view/:id', requireAdminAuth, (req, res) => {
  const tech = store.getById('technicians', req.params.id);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  req.session.technicianId = tech.id;
  res.json(sanitizeTechnician(tech));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.technicianId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const tech = store.getById('technicians', req.session.technicianId);
  if (!tech) {
    req.session = null;
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json(sanitizeTechnician(tech));
});

module.exports = router;
