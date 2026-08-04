// Handles Stripe's webhook callbacks — checkout.session.completed covers two different
// flows, told apart by session.mode:
//   - mode:'payment' — a customer paid a one-time invoice (see routes/pay.js). Flips
//     that invoice to 'paid'.
//   - mode:'setup' — an owner finished saving a card for autopay (see
//     routes/ownerPortal.js's /autopay/start). No money moved; this is where we look up
//     the resulting PaymentMethod and turn autopay on for that owner.
// Mounted in server.js with express.raw() (not the global JSON parser) because signature
// verification needs the exact, untouched request body bytes.
const store = require('../lib/store');
const stripe = require('../lib/stripeClient');

// Once an owner completes the hosted Checkout "save a card" page, this looks up the
// SetupIntent Stripe just finished (which the webhook payload only gives us the id
// for) to find the PaymentMethod it saved, then fetches that PaymentMethod's card
// brand/last4 purely so the owner portal can show "Visa ending 4242" instead of just
// "a card is on file." Turns autopay on for the owner tagged in the session's metadata
// (set when the setup Checkout Session was created — see routes/ownerPortal.js).
async function handleAutopaySetupCompleted(session) {
  const ownerId = session.metadata && session.metadata.ownerId;
  if (!ownerId) {
    console.warn('Stripe setup-mode checkout.session.completed had no ownerId metadata — ignoring.');
    return;
  }
  const owner = store.getById('owners', ownerId);
  if (!owner) {
    console.warn(`Stripe setup-mode session completed for unknown owner #${ownerId} — ignoring.`);
    return;
  }
  const setupIntentId = session.setup_intent;
  if (!setupIntentId) {
    console.warn(`Stripe setup-mode session ${session.id} completed with no setup_intent — ignoring.`);
    return;
  }

  const setupIntent = await stripe.retrieveSetupIntent(setupIntentId);
  const paymentMethodId = setupIntent.payment_method;
  if (!paymentMethodId) {
    console.warn(`Stripe setup intent ${setupIntentId} completed with no payment_method — ignoring.`);
    return;
  }

  let cardBrand = null;
  let cardLast4 = null;
  try {
    const pm = await stripe.retrievePaymentMethod(paymentMethodId);
    if (pm.card) {
      cardBrand = pm.card.brand;
      cardLast4 = pm.card.last4;
    }
  } catch (err) {
    // Autopay still works fine without the display details — this is only cosmetic
    // (what the owner portal shows for "card on file"), so don't let it block turning
    // autopay on.
    console.warn('Could not retrieve payment method details for autopay card display:', err.message);
  }

  store.update('owners', owner.id, {
    autopayEnabled: true,
    stripeCustomerId: session.customer,
    stripePaymentMethodId: paymentMethodId,
    autopayCardBrand: cardBrand,
    autopayCardLast4: cardLast4,
    autopayEnabledAt: new Date().toISOString(),
  });
  console.log(`Autopay enabled for owner #${owner.id} (${owner.name}) — card ending ${cardLast4 || '????'}.`);
}

function handleInvoicePaymentCompleted(session) {
  const invoiceId = session.client_reference_id || (session.metadata && session.metadata.invoiceId);
  if (invoiceId) {
    const invoice = store.getById('invoices', invoiceId);
    if (invoice && invoice.status !== 'paid') {
      store.update('invoices', invoiceId, {
        status: 'paid',
        stripeSessionId: session.id,
        paidAt: new Date().toISOString(),
      });
      console.log(`Invoice #${invoiceId} marked paid via Stripe (session ${session.id}).`);
    }
  } else {
    console.warn('Stripe checkout.session.completed had no invoice reference — ignoring.');
  }
}

module.exports = async function stripeWebhookHandler(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('Received a Stripe webhook but STRIPE_WEBHOOK_SECRET is not set — ignoring it.');
    return res.status(501).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    stripe.verifyWebhookSignature(req.body, req.headers['stripe-signature'], secret);
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'setup') {
        await handleAutopaySetupCompleted(session);
      } else {
        handleInvoicePaymentCompleted(session);
      }
    }
  } catch (err) {
    // Same lenient philosophy as the "no invoice reference" case above: log it and
    // still acknowledge the webhook rather than 500ing, which would just make Stripe
    // retry an event that's very unlikely to succeed on retry (e.g. a since-deleted
    // owner). Whatever needs following up is now visible in the server logs.
    console.error('Error processing Stripe webhook event:', err.message);
  }

  res.json({ received: true });
};
