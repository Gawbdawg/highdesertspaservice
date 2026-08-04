// Texts a "please leave us a review" message to every customer whose appointment was
// completed yesterday — giving the visit a day to settle before asking, without anyone
// having to remember to do it by hand. Meant to run once a day (e.g. a Render Cron Job).
//
// Each appointment is only asked once (tracked via reviewRequestSentAt), so re-running
// the same day won't double-text anyone.
//
// Env vars: same as scripts/send-sms-reminders.js — APP_BASE_URL, ADMIN_USERNAME,
// ADMIN_PASSWORD, and the TWILIO_* vars (falls back to a console dry-run without them).
// Also requires a Google review link set in the Settings tab, or this has nothing to send.

const { fetchJson, authedFetch } = require('../lib/cronClient');
const { sendSms } = require('../lib/sms');

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = fmt(yesterday);

  console.log(`Sending review requests for appointments completed on ${dateStr} ...`);

  const [appts, settings] = await Promise.all([
    fetchJson(`/api/appointments?date=${dateStr}`),
    fetchJson('/api/settings'),
  ]);

  if (!settings.googleReviewUrl) {
    console.log('No Google review link set (Settings tab) — nothing to send.');
    return;
  }

  const todo = appts.filter((a) => a.status === 'completed' && a.customerPhone && !a.reviewRequestSentAt);
  if (todo.length === 0) {
    console.log('Nothing to send — either no completed jobs yesterday, or already asked.');
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const a of todo) {
    const body = `Hi ${a.customerName}, thanks for choosing High Desert Spa Service! If you have a minute, ` +
      `we'd really appreciate a quick review: ${settings.googleReviewUrl}`;
    try {
      await sendSms({ to: a.customerPhone, body });
      await authedFetch(`/api/appointments/${a.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewRequestSentAt: new Date().toISOString() }),
      });
      console.log(`✓ Texted ${a.customerName} (${a.customerPhone})`);
      sent += 1;
    } catch (err) {
      console.log(`✗ ${a.customerName} (${a.customerPhone}): ${err.message}`);
      failed += 1;
    }
  }
  console.log(`Done — ${sent} sent${failed ? `, ${failed} failed` : ''}.`);
}

main().catch((err) => {
  console.error('Failed to send review requests:', err);
  process.exit(1);
});
