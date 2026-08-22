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
// email on file. Returns the same-shaped result whether or not the email matched —
// the caller (route) always sends back the same HTTP response either way, so the API
// response itself never reveals which email addresses are registered.
//
// If no record matches and the caller passed `signupUrl`, we still email the address
// — just a plain "no account yet, here's how to create one" message instead of a
// code. That's a deliberate, small trade of email-enumeration risk (whoever controls
// that inbox learns it has no account) for owners not being left wondering why their
// code never showed up. Only the owner portal passes `signupUrl` today; pass nothing
// there and this behaves exactly as before (silent no-op on no match).
// `purpose` ('login' | 'reset') only changes the email's wording — the code itself is
// generated, stored, expired, and verified identically either way (see
// verifyLoginCode below), since both are really the same thing underneath: proving
// you control this email address. Kept as one shared code/expiry/attempts trio on the
// record (not separate fields per purpose) so requesting one kind of code invalidates
// any other outstanding one instead of leaving two valid codes around at once.
async function requestLoginCode(collection, email, { subjectPrefix, greetingName, signupUrl, purpose = 'login' } = {}) {
  const record = findByEmail(collection, email);
  if (!record) {
    const normEmail = (email || '').trim();
    if (normEmail && signupUrl) {
      await sendEmail({
        to: normEmail,
        subject: `${subjectPrefix} — no account found`,
        text: `Hi,\n\nWe don't have an account on file for ${normEmail} yet, so we couldn't send a login code.\n\nYou can create an account here:\n${signupUrl}\n\nIf you weren't expecting this email, you can safely ignore it.`,
      });
    }
    return { matched: false };
  }

  const code = generateCode();
  store.update(collection, record.id, {
    loginCode: code,
    loginCodeExpiresAt: Date.now() + CODE_TTL_MS,
    loginCodeAttempts: 0,
  });

  const isReset = purpose === 'reset';
  await sendEmail({
    to: record.email,
    subject: isReset ? `${subjectPrefix} password reset code: ${code}` : `${subjectPrefix} login code: ${code}`,
    text: isReset
      ? `Hi ${record.name || greetingName || ''},\n\nYour password reset code is: ${code}\n\nEnter this code to set a new password. This code expires in 10 minutes. If you didn't request this, you can ignore this email — your password won't be changed.`
      : `Hi ${record.name || greetingName || ''},\n\nYour login code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
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
