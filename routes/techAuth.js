const express = require('express');
const store = require('../lib/store');
const { checkPassword, hashPassword, sanitizeTechnician, requireAdminAuth } = require('../lib/auth');
const { requestLoginCode, verifyLoginCode } = require('../lib/emailLogin');
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

// ---- Forgot password: emailed one-time code, then set a brand-new password ----
// Techs only ever log in with username+password (no email-code login option, unlike
// the owner portal) — so unlike an owner who forgot their password and can fall back
// to logging in with a code, a tech with no way to prove identity except email would
// otherwise be fully locked out until an admin resets it for them from the Team tab.
// Reuses the exact same lib/emailLogin.js helpers as the owner portal (they're
// collection-agnostic), just pointed at 'technicians' — a verified code stands in for
// the current password an account-settings change would otherwise require.
router.post('/request-password-reset', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  try {
    await requestLoginCode('technicians', email, {
      subjectPrefix: 'High Desert Spa Service',
      greetingName: 'there',
      purpose: 'reset',
    });
  } catch (err) {
    console.error('Failed to send technician password reset code:', err.message);
  }
  res.json({ sent: true, message: "If that email is on file, we've sent a password reset code." });
});

router.post('/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'Email, code, and a new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Choose a password with at least 6 characters' });
  }
  const tech = verifyLoginCode('technicians', email, code);
  if (!tech) return res.status(401).json({ error: 'That code is incorrect or has expired — request a new one.' });
  const updated = store.update('technicians', tech.id, { passwordHash: hashPassword(newPassword) });
  req.session.technicianId = updated.id;
  res.json(sanitizeTechnician(updated));
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
