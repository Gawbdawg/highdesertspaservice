const express = require('express');
const store = require('../lib/store');
const { sendEmail } = require('../lib/mailer');
const ai = require('../lib/ai');
const { invoiceDescription } = require('../lib/invoiceDescription');
const waveSync = require('../lib/waveSync');
const router = express.Router();

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

// A combined invoice is any invoice with bundled-in lineItems (see
// lib/monthlyInvoice.js) — that covers two different bundling scopes:
//   - owner-wide: every property an owner has, rolled into one bill. No single
//     customerId (it isn't any one property's invoice), so it's named after the owner
//     plus a property count.
//   - per-property: one property's jobs for the month, rolled into that property's own
//     bill. customerId IS set (it's this property's invoice, same as any normal
//     invoice) — an ownerId may also be set alongside it just so billing/autopay still
//     resolves to the owner, but display-wise this should read as "this property's
//     invoice," not "this owner's invoice."
function enrich(inv) {
  const hasLineItems = Array.isArray(inv.lineItems) && inv.lineItems.length > 0;
  if (!inv.customerId && inv.ownerId) {
    const owner = store.getById('owners', inv.ownerId);
    const propertyCount = new Set((inv.lineItems || []).map((li) => li.customerId)).size;
    return {
      ...inv,
      customerName: `${owner ? owner.name : 'Unknown owner'} — ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`,
      isCombined: true,
    };
  }
  const customer = store.getById('customers', inv.customerId);
  return { ...inv, customerName: customer ? customer.name : 'Unknown customer', isCombined: hasLineItems };
}

router.get('/', (req, res) => {
  let invoices = store.getAll('invoices');
  if (req.query.status) invoices = invoices.filter((i) => i.status === req.query.status);
  if (req.query.customerId) invoices = invoices.filter((i) => i.customerId === Number(req.query.customerId));
  invoices = invoices.sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''));
  res.json(invoices.map(enrich));
});

router.post('/', (req, res) => {
  const { customerId, appointmentId, amount, issuedDate, dueDate, notes, status } = req.body;
  if (!customerId || amount === undefined) {
    return res.status(400).json({ error: 'customerId and amount are required' });
  }
  const invoice = store.create('invoices', {
    customerId: Number(customerId),
    appointmentId: appointmentId ? Number(appointmentId) : null,
    amount: Number(amount),
    issuedDate: issuedDate || new Date().toISOString().slice(0, 10),
    dueDate: dueDate || '',
    status: status || 'draft',
    notes: notes || '',
  });
  res.status(201).json(enrich(invoice));
});

router.put('/:id', (req, res) => {
  const before = store.getById('invoices', req.params.id);
  const updates = { ...req.body };
  if (updates.amount !== undefined) updates.amount = Number(updates.amount);
  const updated = store.update('invoices', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Invoice not found' });
  // Push to Wave (if configured — see lib/waveSync.js) the moment this invoice is
  // actually billed or paid, not on every edit. Fire-and-forget: a Wave hiccup
  // should never block saving the invoice itself.
  if (before && before.status !== 'sent' && updated.status === 'sent') {
    waveSync.pushInvoiceToWave(updated.id).catch(() => {});
  }
  if (before && before.status !== 'paid' && updated.status === 'paid') {
    waveSync.recordWavePayment(updated.id).catch(() => {});
  }
  res.json(enrich(updated));
});

// Friendly description of what an invoice is billing for — used only in the "Email
// invoice" note below, distinct from the raw line-item breakdown the admin sees in
// Who an invoice actually gets emailed to — the linked owner (if there is one) is
// preferred over the home's own email even for a single-home invoice, since owners
// are the billed party and a home often has no email on file at all (e.g. a vacation
// rental only the owner ever logs into). Falls back to the home's own email only
// when there's no linked owner account.
function resolveInvoiceRecipient(invoice) {
  if (invoice.ownerId) {
    const owner = store.getById('owners', invoice.ownerId);
    return owner && owner.email ? { email: owner.email, name: owner.name } : null;
  }
  const customer = store.getById('customers', invoice.customerId);
  if (!customer) return null;
  if (customer.ownerId) {
    const owner = store.getById('owners', customer.ownerId);
    if (owner && owner.email) return { email: owner.email, name: owner.name };
  }
  return customer.email ? { email: customer.email, name: customer.name } : null;
}

// Emails the invoice straight to whoever's billed for it, with a short thank-you note
// and a link to view/pay it online (the same public /pay/:id page "Copy pay link"
// used to point at) — replaces the old copy-the-link-and-text-it-yourself workflow.
// Marks a still-draft invoice as sent, since emailing it IS sending it; never
// downgrades an invoice that's already sent or paid.
router.post('/:id/email', async (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const recipient = resolveInvoiceRecipient(invoice);
  if (!recipient) {
    return res.status(400).json({ error: 'No email on file to send this invoice to yet — add one on the home or owner account first.' });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const payLink = `${origin}/pay/${invoice.id}`;
  const description = invoiceDescription(invoice);
  const dueLine = invoice.dueDate ? ` It's due ${invoice.dueDate}.` : '';

  const text = `Hi ${recipient.name},

Thank you for continuing to trust High Desert Spa Service with your hot tub care — we really appreciate the partnership.

Here's your invoice for ${description}: ${money(invoice.amount)}.${dueLine}

You can view it and pay online any time here:
${payLink}

If you have any questions about this invoice, just reply to this email.

Thanks again for being a valued customer!
High Desert Spa Service`;

  try {
    const result = await sendEmail({
      to: recipient.email,
      subject: `Your High Desert Spa Service invoice — ${money(invoice.amount)}`,
      text,
    });
    if (invoice.status === 'draft') {
      store.update('invoices', invoice.id, { status: 'sent' });
      waveSync.pushInvoiceToWave(invoice.id).catch(() => {});
    }
    res.json({ sent: true, dryRun: !!result.dryRun, to: recipient.email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// AI (Ripple)-drafted payment reminder — same delivery mechanism as /:id/email (still
// marks a draft invoice as sent, still points at the same /pay/:id link) but the body
// text is generated per-invoice from lib/ai.js instead of the fixed template, tuned by
// how many days overdue this specific invoice is. Falls back to a template automatically
// if no ANTHROPIC_API_KEY is set — see lib/ai.js.
router.post('/:id/send-nudge', async (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const recipient = resolveInvoiceRecipient(invoice);
  if (!recipient) {
    return res.status(400).json({ error: 'No email on file to send this invoice to yet — add one on the home or owner account first.' });
  }

  const daysOverdue = invoice.dueDate
    ? Math.max(0, Math.round((Date.now() - new Date(invoice.dueDate + 'T00:00:00').getTime()) / 86400000))
    : 0;

  const nudge = await ai.generatePaymentNudge({
    customerName: recipient.name,
    amount: money(invoice.amount).replace('$', ''),
    daysOverdue,
  });

  const origin = `${req.protocol}://${req.get('host')}`;
  const payLink = `${origin}/pay/${invoice.id}`;
  const text = `${nudge.text}\n\nView and pay online any time here: ${payLink}\n\nHigh Desert Spa Service`;

  try {
    const result = await sendEmail({
      to: recipient.email,
      subject: `Payment reminder — ${money(invoice.amount)} due, High Desert Spa Service`,
      text,
    });
    if (invoice.status === 'draft') {
      store.update('invoices', invoice.id, { status: 'sent' });
    }
    res.json({ sent: true, dryRun: !!result.dryRun, to: recipient.email, aiGenerated: nudge.aiGenerated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manual retry for an invoice that previously failed to sync to Wave (see
// waveBadge()/waveSyncError in the admin UI) — e.g. after fixing a config issue
// like a wrong WAVE_BUSINESS_ID, there'd otherwise be no way to re-trigger the
// sync short of bouncing the invoice's status back and forth. Safe to call on
// any invoice; a no-op if Wave isn't configured or the invoice already synced.
router.post('/:id/retry-wave-sync', async (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  await waveSync.pushInvoiceToWave(invoice.id);
  if (invoice.status === 'paid') await waveSync.recordWavePayment(invoice.id);
  const updated = store.getById('invoices', invoice.id);
  res.json(enrich(updated));
});

router.delete('/:id', (req, res) => {
  // Deleting a combined monthly invoice shouldn't strand the individual invoices it
  // bundled — un-bundle them back to 'draft' so they're immediately visible and
  // collectible again in the main Invoices list, instead of sitting permanently stuck at
  // status:'bundled' pointing at an invoice that no longer exists.
  const invoice = store.getById('invoices', req.params.id);
  if (invoice && (invoice.lineItems || []).length) {
    invoice.lineItems.forEach((li) => {
      if (li.sourceInvoiceId) {
        const source = store.getById('invoices', li.sourceInvoiceId);
        if (source && source.bundledIntoInvoiceId === invoice.id) {
          store.update('invoices', source.id, { status: 'draft', bundledIntoInvoiceId: null });
        }
      }
    });
  }
  const ok = store.remove('invoices', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Invoice not found' });
  res.status(204).end();
});

module.exports = router;
