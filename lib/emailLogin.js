// Shared "log in with just your email" flow: request a 6-digit code, get it emailed,
// type it in to log in — no password needed. Built for the owner portal, where most
// accounts were bulk-created from a contact list and never had a password set, so
// password login simply wasn't usable for them yet.
const store = require('./store');
const { sendEmail } = require('./mailer');

const CODE_TTL_MS = 10 * 60 * 1000; // codes expire 10 minutes after being requested
const MAX_ATTEMPTS = 5; // guards against someone guessing a code before it expires

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, no leading-zero ambiguity
}

// Finds the record in `collection` whose `email` matches (case-insensitive, trimmed).
function findByEmail(collection, email) {
  const target = (email || '').trim().toLowerCase();
  if (!target) return null;
  return store.getAll(collection).find((r) => (r.email || '').trim().toLowerCase() === target);
}

// Generates and emails a login code for whichever record in `collection` has this
// email on file. Deliberately returns the same generic result whether or not the
// email matched anything — the caller (route) always responds with the same message
// either way, so this never reveals which email addresses are registered.
async function requestLoginCode(collection, email, { subjectPrefix, greetingName }) {
  const record = findByEmail(collection, email);
  if (!record) return { matched: false };

  const code = generateCode();
  store.update(collection, record.id, {
    loginCode: code,
    loginCodeExpiresAt: Date.now() + CODE_TTL_MS,
    loginCodeAttempts: 0,
  });

  await sendEmail({
    to: record.email,
    subject: `${subjectPrefix} login code: ${code}`,
    text: `Hi ${record.name || greetingName || ''},\n\nYour login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });

  return { matched: true };
}

// Verifies a submitted code against whichever record in `collection` has this email
// on file. On success, clears the code (single-use) and returns the record. On
// failure, returns null and (for a wrong-but-not-expired code) counts the attempt so
// a code can't be brute-forced within its 10-minute window.
function verifyLoginCode(collection, email, code) {
  const record = findByEmail(collection, email);
  if (!record || !record.loginCode) return null;
  if (!record.loginCodeExpiresAt || Date.now() > record.loginCodeExpiresAt) return null;
  if ((record.loginCodeAttempts || 0) >= MAX_ATTEMPTS) return null;

  if (String(code).trim() !== record.loginCode) {
    store.update(collection, record.id, { loginCodeAttempts: (record.loginCodeAttempts || 0) + 1 });
    return null;
  }

  // Single-use — clear it immediately so the same code can't be replayed.
  store.update(collection, record.id, { loginCode: null, loginCodeExpiresAt: null, loginCodeAttempts: 0 });
  return store.getById(collection, record.id);
}

module.exports = { requestLoginCode, verifyLoginCode, findByEmail };
