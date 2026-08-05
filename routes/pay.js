// Public routes behind the customer-facing /pay/:id page — deliberately NOT behind
// requireAdminAuth, since customers paying an invoice don't have (and shouldn't need) any
// kind of login. Only exposes the minimum an invoice-payment page needs.
const express = require('express');
const store = require('../lib/store');
const stripe = require('../lib/stripeClient');
const { invoiceDescription } = require('../lib/invoiceDescription');
const router = express.Router();

router.get('/:id', (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // customerId is set for every invoice that bills a specific property — including a
  // per-property monthly bundle (see lib/monthlyInvoice.js), which also carries an
  // ownerId just so payment/emailing resolves to the owner. Only a true owner-wide
  // combined invoice (every property lumped together) has no customerId at all, so
  // that's the only case that falls back to the owner's name here.
  const customer = invoice.customerId ? store.getById('customers', invoice.customerId) : null;
  const owner = invoice.ownerId ? store.getById('owners', invoice.ownerId) : null;
  const customerName = customer ? customer.name : (owner ? owner.name : '');

  res.json({
    id: invoice.id,
    amount: invoice.amount,
    status: invoice.status,
    dueDate: invoice.dueDate || '',
    customerName,
    description: invoiceDescription(invoice),
    lineItems: invoice.lineItems || [],
    bundledIntoInvoiceId: invoice.bundledIntoInvoiceId || null,
    stripeConfigured: stripe.isConfigured(),
    // Wave's own hosted invoice page (see lib/waveSync.js) — if the business
    // has Wave Payments turned on, a customer can pay right there. Preferred
    // over Stripe checkout when both happen to be present, since Stripe isn't
    // actually configured/used on High Desert.
    waveViewUrl: invoice.waveViewUrl || null,
  });
});

router.post('/:id/checkout', async (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') {
    return res.status(400).json({ error: 'This invoice has already been paid.' });
  }
  // Bundled invoices were rolled into a combined monthly invoice — that's the one that
  // should actually get paid now. Block checkout here so an old/bookmarked pay link
  // can't collect the same charge twice.
  if (invoice.status === 'bundled') {
    return res.status(400).json({ error: 'This invoice has been combined into a monthly invoice. Please use the payment link for that invoice instead.' });
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const session = await stripe.createCheckoutSession({
      invoiceId: invoice.id,
      amountCents: Math.round(Number(invoice.amount) * 100),
      description: `High Desert Spa Service — Invoice #${invoice.id}`,
      successUrl: `${origin}/pay/${invoice.id}?paid=1`,
      cancelUrl: `${origin}/pay/${invoice.id}`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
