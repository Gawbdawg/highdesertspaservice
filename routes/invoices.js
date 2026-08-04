const express = require('express');
const store = require('../lib/store');
const { sendEmail } = require('../lib/mailer');
const ai = require('../lib/ai');
const router = express.Router();

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

function enrich(inv) {
  if (inv.ownerId) {
    const owner = store.getById('owners', inv.ownerId);
    const propertyCount = new Set((inv.lineItems || []).map((li) => li.customerId)).size;
    return {
      ...inv,
      customerName: `${owner ? owner.name : 'Unknown owner'} — ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`,
      isCombined: true,
    };
  }
  const customer = store.getById('customers', inv.customerId);
  return { ...inv, customerName: customer ? customer.name : 'Unknown customer' };
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
  const updates = { ...req.body };
  if (updates.amount !== undefined) updates.amount = Number(updates.amount);
  const updated = store.update('invoices', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Invoice not found' });
  res.json(enrich(updated));
});

// Friendly description of what an invoice is billing for — used only in the "Email
// invoice" note below, distinct from the raw line-item breakdown the admin sees in
// "View jobs". A combined (owner-level) invoice summarizes the whole batch by date
// range; a single invoice linked to a specific appointment names that job's service
// type and date; anything else falls back to the invoice's own notes, or just says
// when it was issued.
function invoiceDescription(invoice) {
  if (invoice.ownerId && (invoice.lineItems || []).length) {
    const count = invoice.lineItems.length;
    const dates = invoice.lineItems.map((li) => li.date).sort();
    return `${count} service${count === 1 ? '' : 's'} completed between ${dates[0]} and ${dates[dates.length - 1]}`;
  }
  if (invoice.appointmentId) {
    const appt = store.getById('appointments', invoice.appointmentId);
    if (appt) return `${appt.serviceType || 'service'} on ${appt.date}`;
  }
  return invoice.notes ? invoice.notes : `service billed on ${invoice.issuedDate || 'file'}`;
}

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
