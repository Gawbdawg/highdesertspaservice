// Emails an owner when one of their properties' scheduled visits gets marked
// completed — opt-in per owner (owner.jobCompletionEmailsEnabled, default false; see
// PUT /api/owner/job-completion-emails in routes/ownerPortal.js), unlike the
// newsletter opt-out default, since this is closer to a transactional notification
// some owners will find noisy rather than a marketing send everyone should start on.
const store = require('./store');
const { sendEmail } = require('./mailer');

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// Fire-and-forget on purpose, same as lib/notifications.js — a mail hiccup should
// never block or fail the actual "mark complete" request the tech or admin is
// waiting on. Call this only once you've confirmed the appointment just transitioned
// INTO 'completed' (not on every subsequent edit to an already-completed job) — see
// the callers in routes/techPortal.js and routes/appointments.js.
async function notifyOwnerJobCompleted(appt, businessName) {
  if (!appt || appt.status !== 'completed') return;
  const customer = store.getById('customers', appt.customerId);
  if (!customer || !customer.ownerId) return; // not a property linked to an owner account
  const owner = store.getById('owners', customer.ownerId);
  if (!owner || !owner.jobCompletionEmailsEnabled || !owner.email) return;

  try {
    await sendEmail({
      to: owner.email,
      subject: `${customer.name} — your hot tub service is complete`,
      text: `Hi ${owner.name || 'there'},\n\nJust a quick note that your service at ${customer.name} on ${niceDate(appt.date)} has been completed.\n\nYou can see visit details, photos, and any notes from your technician any time in your owner portal.\n\nThanks for choosing ${businessName}!`,
    });
  } catch (err) {
    console.error('Failed to send job-completion email:', err.message);
  }
}

module.exports = { notifyOwnerJobCompleted };
