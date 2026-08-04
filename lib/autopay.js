// Shared "charge this freshly-created draft invoice right now, if the owner it belongs
// to has autopay turned on" logic — called from every place a new invoice gets created
// (lib/autoInvoice.js, lib/monthlyInvoice.js) so an autopay owner never sees a manual
// "please pay" step. See routes/stripeWebhook.js for how an owner's card gets saved in
// the first place (Checkout Session in mode:'setup'), and routes/ownerPortal.js for the
// owner-facing enable/disable endpoints.
const store = require('./store');
const stripe = require('./stripeClient');

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

// Attempts to immediately charge a freshly-created draft invoice against the owner's
// saved card, if they have autopay enabled. Only ever acts on a status:'draft' invoice
// belonging to an owner with autopayEnabled + a saved Stripe customer/payment method —
// anything else is left completely alone for the normal manual send/view/email flow.
//
// On success the invoice is marked 'paid' immediately, the same shape the Stripe
// webhook's normal one-time-payment path already produces. On failure (declined card,
// requires authentication, Stripe not configured, network hiccup, whatever) the invoice
// is just left as a normal draft — no retries, no aggressive dunning — so the admin
// still sees it in the Invoices tab and can follow up by hand exactly like before
// autopay existed. This never throws: a billing hiccup should never block whatever
// invoice-creating flow (appointment completion, monthly bundling, the bulk unbilled-
// jobs fixer) called it.
async function attemptAutopay(invoice) {
  if (!invoice || invoice.status !== 'draft') return invoice;
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
      return updated || invoice;
    }
    console.warn(`Autopay charge for invoice #${invoice.id} did not succeed (status: ${pi.status}) — leaving it as a normal draft invoice.`);
    store.update('invoices', invoice.id, { autopayLastError: `Charge did not complete (status: ${pi.status})` });
  } catch (err) {
    console.warn(`Autopay charge failed for invoice #${invoice.id}: ${err.message} — leaving it as a normal draft invoice.`);
    store.update('invoices', invoice.id, { autopayLastError: err.message });
  }
  return invoice;
}

module.exports = { attemptAutopay, shouldSkipPerJobAutopay, resolveOwnerForInvoice };
