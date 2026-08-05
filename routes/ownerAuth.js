const express = require('express');
const store = require('../lib/store');
const { checkPassword, hashPassword, sanitizeOwner, requireAdminAuth } = require('../lib/auth');
const { requestLoginCode, verifyLoginCode } = require('../lib/emailLogin');
const { notifyAdminNewAccount } = require('../lib/notifications');
const router = express.Router();

// Lets a brand-new property owner create their own account instead of waiting on the
// admin to provision one — they land with no property linked yet (see the "no
// properties yet" state in showDash() in public/owner.js, which prompts them straight
// into the "Add a property" form), and go through the same first-login Terms of
// Service gate as anyone else since agreedToTerms starts false here too. Blocks
// signing up again with an email that's already on file — including accounts the
// admin bulk-created with no password yet — and points them at the email+code login
// instead, since that already works for a passwordless account.
router.post('/signup', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Choose a password with at least 6 characters' });
  }

  const normEmail = email.trim().toLowerCase();
  const existingByEmail = store.getAll('owners').find(
    (o) => (o.email || '').trim().toLowerCase() === normEmail
  );
  if (existingByEmail) {
    return res.status(400).json({
      error: 'An account already exists for that email. Log in instead, or use "Send me a code" if you don\'t have a password set yet.',
    });
  }

  let finalUsername = '';
  if (username && username.trim()) {
    const takenUsername = store.getAll('owners').find(
      (o) => (o.username || '').toLowerCase() === username.trim().toLowerCase()
    );
    if (takenUsername) return res.status(400).json({ error: 'That username is already taken' });
    finalUsername = username.trim();
  }

  const owner = store.create('owners', {
    name: name.trim(),
    email: normEmail,
    phone: phone ? phone.trim() : '',
    username: finalUsername,
    passwordHash: hashPassword(password),
    customPricing: {},
    billingMode: 'perJob',
    newsletterSubscribed: true,
    agreedToTerms: false,
    agreedToTermsAt: null,
    // Distinguishes this from an owner the admin created themselves (Owners tab,
    // bulk-link tool) — used to decide who gets a "New sign-up" badge and whether a
    // new-account notification fires. See lib/notifications.js.
    signupSource: 'self',
  });
  req.session.ownerId = owner.id;
  req.session.viaAdminView = false;
  notifyAdminNewAccount({ type: 'owner', name: owner.name, email: owner.email, phone: owner.phone });
  res.status(201).json({ ...sanitizeOwner(owner), viaAdminView: false });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const owner = store.getAll('owners').find(
    (o) => (o.username || '').toLowerCase() === String(username).toLowerCase()
  );
  if (!owner || !checkPassword(password, owner.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  req.session.ownerId = owner.id;
  req.session.viaAdminView = false;
  res.json({ ...sanitizeOwner(owner), viaAdminView: false });
});

// ---- Email + code login (no password needed — most owner accounts are bulk-created
// from a contact list and never had one set) ----

router.post('/request-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  try {
    await requestLoginCode('owners', email, { subjectPrefix: 'High Desert Spa Service', greetingName: 'there' });
  } catch (err) {
    // Swallow send failures into the same generic response — see note below — but log
    // server-side so a broken email config (e.g. GMAIL_APP_PASSWORD not set) is visible.
    console.error('Failed to send owner login code:', err.message);
  }
  // Always the same response whether or not the email matched an account, and whether
  // or not sending actually succeeded — never reveals which emails are registered.
  res.json({ sent: true, message: "If that email is on file, we've sent a login code to it." });
});

router.post('/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const owner = verifyLoginCode('owners', email, code);
  if (!owner) return res.status(401).json({ error: 'That code is incorrect or has expired — request a new one.' });
  req.session.ownerId = owner.id;
  req.session.viaAdminView = false;
  res.json({ ...sanitizeOwner(owner), viaAdminView: false });
});

// Lets a logged-in admin jump straight into an owner's portal view without needing
// that owner's password. Sets viaAdminView on the session so the frontend skips the
// first-login Terms of Service gate for this visit (see enterPortal() in owner.js) —
// without that, an admin peeking into an owner who hasn't agreed yet would get stuck
// at the gate, and clicking through it would falsely record the OWNER as having
// agreed to the rental agreement when really it was staff just looking around. The
// owner's own agreedToTerms field is never touched here.
router.post('/admin-view/:id', requireAdminAuth, (req, res) => {
  const owner = store.getById('owners', req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  req.session.ownerId = owner.id;
  req.session.viaAdminView = true;
  res.json({ ...sanitizeOwner(owner), viaAdminView: true });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.ownerId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) {
    req.session = null;
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({ ...sanitizeOwner(owner), viaAdminView: !!req.session.viaAdminView });
});

module.exports = router;
