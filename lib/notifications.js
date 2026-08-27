// Lets the admin know when a new account was created WITHOUT them doing it — right
// now that's just an owner using the "sign up" link on the owner portal (see
// routes/ownerAuth.js POST /signup). Accounts the admin creates themselves (Owners,
// Technicians, Homes tabs) don't fire this — they already know, they just did it.
const store = require('./store');
const { sendEmail } = require('./mailer');

// Fire-and-forget on purpose: a notification failing (bad SMTP config, network hiccup)
// should never block or fail the actual signup request. Always logs to the server
// console too, so there's a record even if no notification email is configured yet.
async function notifyAdminNewAccount({ type, name, email, phone }) {
  const label = type === 'owner' ? 'owner' : type;
  console.log(`[notification] New ${label} account created: ${name}${email ? ' <' + email + '>' : ''}${phone ? ' (' + phone + ')' : ''}`);

  const settings = store.getSettings();
  const to = (settings.notificationEmail || '').trim();
  if (!to) return; // notifications not configured — console log above is the only record

  const lines = [
    `A new ${label} account was just created through the sign-up page — no action needed unless something looks off.`,
    '',
    `Name: ${name || '(none given)'}`,
  ];
  if (email) lines.push(`Email: ${email}`);
  if (phone) lines.push(`Phone: ${phone}`);

  try {
    await sendEmail({
      to,
      subject: `New ${label} account: ${name || 'unnamed'}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('Failed to send new-account notification email:', err.message);
  }
}

// Lets the admin know a customer requested a specific service date through their
// owner portal (see routes/ownerPortal.js POST /service-requests) — these sit as
// 'pending' until an admin schedules or declines them from the Schedule surface, so
// without this an admin would only find out by happening to check that list.
async function notifyAdminNewServiceRequest({ ownerName, propertyName, requestedDate, notes }) {
  console.log(`[notification] New service request: ${propertyName || 'a property'} (${ownerName || 'unknown owner'}) wants service on ${requestedDate}.`);

  const settings = store.getSettings();
  const to = (settings.notificationEmail || '').trim();
  if (!to) return; // notifications not configured — console log above is the only record

  const lines = [
    `${ownerName || 'A customer'} just requested a service date through their owner portal — no action needed unless you'd like to confirm it on the schedule.`,
    '',
    `Property: ${propertyName || '(unknown property)'}`,
    `Requested date: ${requestedDate}`,
  ];
  if (notes) lines.push(`Notes: ${notes}`);

  try {
    await sendEmail({
      to,
      subject: `New service request: ${propertyName || 'a property'} — ${requestedDate}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('Failed to send new-service-request notification email:', err.message);
  }
}

module.exports = { notifyAdminNewAccount, notifyAdminNewServiceRequest };
