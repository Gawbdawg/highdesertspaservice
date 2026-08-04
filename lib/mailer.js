const nodemailer = require('nodemailer');

// Works with any email provider, not just Gmail. Two ways to configure it:
//
//   1. Generic SMTP (any provider — Outlook/Office365, Yahoo, iCloud, a custom domain's
//      mailbox, Zoho, etc.): set SMTP_HOST, SMTP_USER, SMTP_PASS, and optionally
//      SMTP_PORT (default 587) and SMTP_SECURE ('true' for port 465). Common hosts:
//        Outlook/Office365 — smtp.office365.com, port 587
//        Yahoo Mail        — smtp.mail.yahoo.com, port 587 (needs an "app password" too)
//        iCloud Mail       — smtp.mail.me.com, port 587 (needs an app-specific password)
//        Zoho Mail         — smtp.zoho.com, port 587
//
//   2. Gmail shorthand (kept for backward compatibility with the original setup):
//      set GMAIL_USER and GMAIL_APP_PASSWORD — same as Google Workspace addresses too,
//      since Workspace mail runs on Gmail's infrastructure.
//
// If neither is configured, falls back to dry-run mode (logs what would have been sent
// to the console instead) so the app never crashes just because email isn't set up yet.
function getTransport() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return null; // dry-run mode — caller should just log instead of sending
}

function fromAddress() {
  return process.env.SMTP_USER || process.env.GMAIL_USER || '';
}

async function sendEmail({ to, subject, text }) {
  const transport = getTransport();
  if (!transport) {
    console.log('\n[DRY RUN — no email provider configured, see lib/mailer.js] Would send to: ' + to);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('--- end of email ---\n');
    return { dryRun: true };
  }
  return transport.sendMail({
    from: `"High Desert Spa Service" <${fromAddress()}>`,
    to,
    subject,
    text,
  });
}

module.exports = { sendEmail };
