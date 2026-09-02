const express = require('express');
const store = require('../lib/store');
const { sendEmail } = require('../lib/mailer');
const ai = require('../lib/ai');
const { invoiceDescription } = require('../lib/invoiceDescription');
const waveSync = require('../lib/waveSync');
const { ownerQualifiesForMonthly } = require('../lib/monthlyInvoice');
const { attemptAutopay, resolveOwnerForInvoice } = require('../lib/autopay');
const { resyncAllDraftInvoices } = require('../lib/autoInvoice');
const stripe = require('../lib/stripeClient');
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
      // Used by the admin Invoices table to section invoices by owner instead of
      // listing every property flat — see public/app.js#renderInvoiceTable.
      ownerName: owner ? owner.name : null,
      isCombined: true,
      // A combined invoice IS the thing that needs sending/collecting — never deferred.
      isMonthlyDeferred: false,
      autopayReady: invoiceAutopayReady(inv),
    };
  }
  const customer = store.getById('customers', inv.customerId);
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  // A per-job draft invoice for a monthly-billed (or vacation-rental) owner isn't
  // something that needs office action the moment a tech completes the job — it's
  // meant to just sit and accumulate until "Generate monthly invoice" rolls it into
  // a combined bill (see lib/monthlyInvoice.js and the Monthly tab). Flagged here,
  // in one place, so both the Money queue and the classic Invoices table can hide
  // these without each re-implementing the same owner-qualifies check.
  let isMonthlyDeferred = false;
  if (inv.status === 'draft' && !hasLineItems && owner) {
    const properties = store.getAll('customers');
    isMonthlyDeferred = ownerQualifiesForMonthly(owner, properties);
  }
  return {
    ...inv,
    customerName: customer ? customer.name : 'Unknown customer',
    ownerName: owner ? owner.name : null,
    isCombined: hasLineItems,
    isMonthlyDeferred,
    autopayReady: invoiceAutopayReady(inv),
  };
}

// Whether this draft invoice can be charged on the spot with the "Process payment"
// button instead of needing "Email invoice" — true only when the owner it bills has
// autopay turned on AND already has a card on file (see routes/ownerPortal.js's
// autopay enable/disable endpoints and routes/stripeWebhook.js for how that card gets
// saved). Anything else — no owner, autopay off, no saved card, already
// sent/paid/bundled — falls back to the normal manual email flow.
function invoiceAutopayReady(inv) {
  if (inv.status !== 'draft' && inv.status !== 'sent') return false;
  if (!stripe.isConfigured()) return false;
  const owner = resolveOwnerForInvoice(inv);
  return !!(owner && owner.autopayEnabled && owner.stripeCustomerId && owner.stripePaymentMethodId);
}

router.get('/', (req, res) => {
  let invoices = store.getAll('invoices');
  if (req.query.status) invoices = invoices.filter((i) => i.status === req.query.status);
  if (req.query.customerId) invoices = invoices.filter((i) => i.customerId === Number(req.query.customerId));
  // Used by the Monthly tab's drill-down to show exactly which jobs are sitting
  // unbilled for one owner across every one of their properties (a plain
  // customerId filter only covers a single property at a time).
  if (req.query.ownerId) {
    const ownerPropertyIds = new Set(
      store.getAll('customers').filter((c) => c.ownerId === Number(req.query.ownerId)).map((c) => c.id)
    );
    invoices = invoices.filter((i) => i.customerId && ownerPropertyIds.has(i.customerId));
  }
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

// Manual "refresh" action for the Invoices tab — sweeps every draft invoice and
// re-resolves its price against whatever's currently set at the home/owner/catalog
// level (see lib/autoInvoice.js#resyncAllDraftInvoices). Sent/paid/bundled invoices
// are untouched — this only ever corrects invoices that haven't gone out yet.
router.post('/resync-all-prices', (req, res) => {
  const updatedCount = resyncAllDraftInvoices();
  res.json({ updatedCount });
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

// Admin-triggered charge against the owner's saved card — the "Process payment"
// button that replaces "Email invoice" for any owner with autopay + a card on file
// (see invoiceAutopayReady above). Autopay used to fire this automatically the
// moment a job's invoice was created; now every invoice always lands as a normal
// draft first so the admin can review it, and this is the one place that actually
// charges anything. Reuses lib/autopay.js#attemptAutopay — the exact same Stripe
// off-session charge logic autopay always used — just called on purpose instead of
// automatically.
router.post('/:id/process-payment', async (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status !== 'draft' && invoice.status !== 'sent') {
    return res.status(400).json({ error: 'This invoice is already paid or bundled into another invoice — nothing to charge.' });
  }
  if (!stripe.isConfigured()) {
    return res.status(400).json({ error: "Stripe isn't configured yet — see Settings/README." });
  }
  const owner = resolveOwnerForInvoice(invoice);
  if (!owner || !owner.autopayEnabled || !owner.stripeCustomerId || !owner.stripePaymentMethodId) {
    return res.status(400).json({ error: "This owner doesn't have autopay set up with a card on file — email the invoice instead, or have them turn on autopay from their portal." });
  }

  await attemptAutopay(invoice);
  const fresh = store.getById('invoices', req.params.id);
  if (fresh.status === 'paid') {
    waveSync.recordWavePayment(fresh.id).catch(() => {});
    return res.json({ processed: true, invoice: enrich(fresh) });
  }
  return res.status(400).json({ error: fresh.autopayLastError || 'The charge did not go through — see the server log for details.' });
});

// Pulls one job's charge back out of an already-generated combined monthly invoice —
// e.g. a cancellation fee that got swept in for a visit the admin ended up cancelling
// outright, and shouldn't actually be billed. Reverts that job's own original invoice
// back to a normal 'draft' (same as fully deleting a combined invoice does for every
// line item at once — see DELETE /:id below) so it's immediately visible/collectible
// again on its own, then recomputes the combined invoice's total from what's left. If
// that was the last line item, the now-empty combined invoice is removed outright
// rather than leaving a $0 invoice sitting in the list.
router.delete('/:id/line-items/:sourceInvoiceId', (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice || !(invoice.lineItems || []).length) {
    return res.status(404).json({ error: 'Combined invoice not found' });
  }
  const sourceInvoiceId = Number(req.params.sourceInvoiceId);
  const lineItem = invoice.lineItems.find((li) => li.sourceInvoiceId === sourceInvoiceId);
  if (!lineItem) return res.status(404).json({ error: 'That job is not on this invoice' });

  const source = store.getById('invoices', sourceInvoiceId);
  if (source && source.bundledIntoInvoiceId === invoice.id) {
    store.update('invoices', source.id, { status: 'draft', bundledIntoInvoiceId: null });
  }

  const remainingLineItems = invoice.lineItems.filter((li) => li.sourceInvoiceId !== sourceInvoiceId);
  if (remainingLineItems.length === 0) {
    store.remove('invoices', invoice.id);
    return res.json({ removed: true, invoiceDeleted: true });
  }
  const newTotal = remainingLineItems.reduce((sum, li) => sum + Number(li.amount), 0);
  const updated = store.update('invoices', invoice.id, { lineItems: remainingLineItems, amount: newTotal });
  res.json({ removed: true, invoiceDeleted: false, invoice: enrich(updated) });
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
