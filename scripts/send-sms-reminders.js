// Texts every customer with a scheduled, un-reminded appointment tomorrow — meant to be
// run once a day (e.g. a Render Cron Job in the afternoon/evening) so customers get a
// heads-up the day before their visit.
//
// Reads/writes live data through the deployed app's own API (like the other scheduled
// scripts) rather than the local data file, since a Cron Job doesn't share disk with the
// web service.
//
// Env vars:
//   APP_BASE_URL             Base URL of the deployed app (defaults to http://localhost:3000)
//   ADMIN_USERNAME            Username of an admin account (Settings tab) this script logs in as
//   ADMIN_PASSWORD            That admin account's password
//   TWILIO_ACCOUNT_SID        From your Twilio console
//   TWILIO_AUTH_TOKEN         From your Twilio console
//   TWILIO_FROM_NUMBER        The Twilio phone number to text from, e.g. +15035551234
//
// Without the TWILIO_* vars set, this prints what it WOULD text instead of actually
// sending — safe to test with. Each appointment is only reminded once: after a successful
// send (real or dry-run) it's marked with reminderSentAt so re-running the script the same
// day doesn't double-text anyone.

const { fetchJson, authedFetch } = require('../lib/cronClient');
const { sendSms } = require('../lib/sms');

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

async function main() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = fmt(tomorrow);

  console.log(`Sending reminders for appointments on ${dateStr} ...`);
  const appts = await fetchJson(`/api/appointments?date=${dateStr}`);
  const todo = appts.filter((a) => a.status === 'scheduled' && a.customerPhone && !a.reminderSentAt);

  if (todo.length === 0) {
    console.log('Nothing to remind — either no jobs tomorrow, or reminders already sent.');
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const a of todo) {
    const body = `Hi ${a.customerName}, this is High Desert Spa Service — reminder that we have you scheduled for ` +
      `${a.serviceType || 'a visit'} on ${niceDate(a.date)} around ${a.startTime}. ` +
      `Reply to this number if you need to reschedule.`;
    try {
      await sendSms({ to: a.customerPhone, body });
      await authedFetch(`/api/appointments/${a.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderSentAt: new Date().toISOString() }),
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
  console.error('Failed to send SMS reminders:', err);
  process.exit(1);
});
