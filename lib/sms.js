// Sends a text message via Twilio's REST API directly (no SDK dependency needed — it's
// just one HTTP call). Falls back to a console "dry run" preview if TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER aren't set, the same pattern as lib/mailer.js for
// email, so this works out of the box before a Twilio account exists.

// Converts a loosely-formatted US phone number ("555-123-4567", "(555) 123 4567", etc.)
// into the E.164 format Twilio requires ("+15551234567"). Returns null if it doesn't look
// like a valid 10-digit US number.
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendSms({ to, body }) {
  const toNumber = normalizePhone(to);
  if (!toNumber) {
    throw new Error(`"${to}" doesn't look like a valid US phone number`);
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.log(`\n[SMS DRY RUN — Twilio not configured] Would text ${toNumber}:\n${body}\n--- end of text ---\n`);
    return { dryRun: true };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: toNumber, From: TWILIO_FROM_NUMBER, Body: body });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Twilio request failed: ${res.status}`);
  }
  return { sid: data.sid };
}

module.exports = { sendSms, normalizePhone };
