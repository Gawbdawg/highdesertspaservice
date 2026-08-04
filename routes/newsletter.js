const express = require('express');
const store = require('../lib/store');
const { sendEmail } = require('../lib/mailer');
const router = express.Router();

// Owners who've consented to receive updates (via their signed waiver at signup, or by
// opting in themselves from the portal) and actually have an email on file to send to.
function subscribedOwners() {
  return store.getAll('owners').filter((o) => o.newsletterSubscribed && o.email && o.email.trim());
}

router.get('/subscriber-count', (req, res) => {
  res.json({ count: subscribedOwners().length });
});

// Sends a one-off email blast to every subscribed owner. Sends one at a time (rather
// than a single multi-recipient email) so nobody's address is exposed to the other
// recipients, and so one bad address doesn't block everyone else's copy — failures are
// counted and reported back rather than aborting the whole send.
router.post('/send', async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !subject.trim()) return res.status(400).json({ error: 'A subject is required' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'A message is required' });

  const subscribers = subscribedOwners();
  if (subscribers.length === 0) {
    return res.status(400).json({ error: 'No subscribers to send to yet.' });
  }

  let sent = 0;
  const failed = [];
  for (const owner of subscribers) {
    try {
      await sendEmail({ to: owner.email, subject: subject.trim(), text: message });
      sent += 1;
    } catch (err) {
      failed.push({ name: owner.name, email: owner.email, error: err.message });
    }
  }

  res.json({ total: subscribers.length, sent, failed });
});

module.exports = router;
