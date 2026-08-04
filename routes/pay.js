// Public routes behind the customer-facing /pay/:id page — deliberately NOT behind
// requireAdminAuth, since customers paying an invoice don't have (and shouldn't need) any
// kind of login. Only exposes the minimum an invoice-payment page needs.
const express = require('express');
const store = require('../lib/store');
const stripe = require('../lib/stripeClient');
const router = express.Router();

router.get('/:id', (req, res) => {
  const invoice = store.getById('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.ownerId) {
    const owner = store.getById('owners', invoice.ownerId);
    return res.json({
      id: invoice.id,
      amount: invoice.amount,
      status: invoice.status,
      dueDate: invoice.dueDate || '',
      customerName: owner ? owner.name : '',
      lineItems: invoice.lineItems || [],
      stripeConfigured: stripe.isConfigured(),
    });
  }
  const customer = store.getById('customers', invoice.customerId);
  res.json({
    id: invoice.id,
    amount: invoice.amount,
    status: invoice.status,
    dueDate: invoice.dueDate || '',
    customerName: customer ? customer.name : '',
    bundledIntoInvoiceId: invoice.bundledIntoInvoiceId || null,
    stripeConfigured: stripe.isConfigured(),
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
