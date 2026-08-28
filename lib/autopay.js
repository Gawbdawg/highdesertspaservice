// Shared "charge this freshly-created draft invoice right now, if the owner it belongs
// to has autopay turned on" logic — called from every place a new invoice gets created
// (lib/autoInvoice.js, lib/monthlyInvoice.js) so an autopay owner never sees a manual
// "please pay" step. See routes/stripeWebhook.js for how an owner's card gets saved in
// the first place (Checkout Session in mode:'setup'), and routes/ownerPortal.js for the
// owner-facing enable/disable endpoints.
const store = require('./store');
const stripe = require('./stripeClient');
const waveSync = require('./waveSync');

// Combined monthly invoices carry ownerId directly; per-job/cancellation-fee invoices
// carry customerId, which links to the owner through that property. Either shape
// resolves to the same owner record autopay state lives on.
function resolveOwnerForInvoice(invoice) {
  if (invoice.ownerId) return store.getById('owners', invoice.ownerId);
  if (invoice.customerId) {
    const customer = store.getById('customers', invoice.customerId);
    return customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  }
  return null;
}

// Owners on combined monthly billing (owner.billingMode === 'monthly') get one bundled
// invoice at month's end (see lib/monthlyInvoice.js) built out of that month's
// individual per-job draft invoices — that's the whole point of choosing monthly
// billing. If autopay charged each per-job draft the moment it was created, it would
// silently charge those owners per visit instead, defeating the one-bill-a-month
// cadence they're on. So per-job invoice-creation call sites check this first and skip
// the immediate autopay attempt for monthly-billing owners; the combined invoice (once
// lib/monthlyInvoice.js creates it) is what actually gets autocharged for them.
function shouldSkipPerJobAutopay(customerId) {
  if (!customerId) return false;
  const customer = store.getById('customers', customerId);
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  return !!(owner && owner.billingMode === 'monthly');
}

// Attempts to charge an outstanding invoice against the owner's saved card, if they
// have autopay enabled. Acts on a status:'draft' OR 'sent' invoice (an invoice that
// was already emailed to the owner before they turned autopay on is just as
// outstanding as a brand-new draft — see catchUpOwnerInvoices below) belonging to an
// owner with autopayEnabled + a saved Stripe customer/payment method; anything else
// (already paid, bundled into a combined invoice, no owner, autopay off) is left
// completely alone for the normal manual send/view/email/"Process payment" flow.
//
// On success the invoice is marked 'paid' immediately, the same shape the Stripe
// webhook's normal one-time-payment path already produces. On failure (declined card,
// requires authentication, Stripe not configured, network hiccup, whatever) the invoice
// is just left exactly as it was — no retries, no aggressive dunning — so the admin
// still sees it in the Invoices tab and can follow up by hand exactly like before
// autopay existed. This never throws: a billing hiccup should never block whatever
// caller (appointment completion, monthly bundling, an admin's "Process payment"
// click, an owner just turning autopay on) called it.
async function attemptAutopay(invoice) {
  if (!invoice || (invoice.status !== 'draft' && invoice.status !== 'sent')) return invoice;
  if (!stripe.isConfigured()) return invoice;

  const owner = resolveOwnerForInvoice(invoice);
  if (!owner || !owner.autopayEnabled || !owner.stripeCustomerId || !owner.stripePaymentMethodId) {
    return invoice;
  }

  const amountCents = Math.round(Number(invoice.amount) * 100);
  if (!amountCents || amountCents < 50) return invoice;

  try {
    const pi = await stripe.createOffSessionPaymentIntent({
      customerId: owner.stripeCustomerId,
      paymentMethodId: owner.stripePaymentMethodId,
      amountCents,
      description: `High Desert Spa Service — Invoice #${invoice.id}`,
      metadata: { invoiceId: String(invoice.id), ownerId: String(owner.id) },
    });
    if (pi.status === 'succeeded') {
      const updated = store.update('invoices', invoice.id, {
        status: 'paid',
        stripePaymentIntentId: pi.id,
        paidAt: new Date().toISOString(),
        autopayCharged: true,
        autopayLastError: null,
      });
      console.log(`Invoice #${invoice.id} auto-charged via autopay for owner #${owner.id} (${owner.name}).`);
      waveSync.recordWavePayment(invoice.id).catch(() => {});
      return updated || invoice;
    }
    console.warn(`Autopay charge for invoice #${invoice.id} did not succeed (status: ${pi.status}) — leaving it exactly as it was.`);
    store.update('invoices', invoice.id, { autopayLastError: `Charge did not complete (status: ${pi.status})` });
  } catch (err) {
    console.warn(`Autopay charge failed for invoice #${invoice.id}: ${err.message} — leaving it exactly as it was.`);
    store.update('invoices', invoice.id, { autopayLastError: err.message });
  }
  return invoice;
}

// Called the moment an owner finishes attaching a card and autopay flips on (see
// routes/stripeWebhook.js#handleAutopaySetupCompleted) — sweeps up every invoice
// already billed to them (across all their properties, plus any combined/monthly
// invoice billed directly to the owner) that's still outstanding (draft or sent, i.e.
// not yet paid or bundled into something else) and attempts to charge each one. Without
// this, an owner who turns autopay on AFTER an invoice was already created/emailed
// would otherwise never get caught up automatically — an admin would have to remember
// to click "Process payment" by hand for each one.
async function catchUpOwnerInvoices(ownerId) {
  const numericOwnerId = Number(ownerId);
  const propertyIds = new Set(
    store.getAll('customers').filter((c) => c.ownerId === numericOwnerId).map((c) => c.id)
  );
  const outstanding = store.getAll('invoices').filter((inv) => (
    (inv.status === 'draft' || inv.status === 'sent')
    && (inv.ownerId === numericOwnerId || (inv.customerId && propertyIds.has(inv.customerId)))
  ));
  for (const inv of outstanding) {
    try {
      await attemptAutopay(inv);
    } catch (err) {
      console.error(`Unexpected error catching up invoice #${inv.id} for owner #${numericOwnerId}:`, err.message);
    }
  }
  return outstanding.length;
}

module.exports = { attemptAutopay, shouldSkipPerJobAutopay, resolveOwnerForInvoice, catchUpOwnerInvoices };
