// Talks to Stripe's REST API directly over fetch (no SDK dependency needed) to create
// Checkout Sessions for invoice payments, and to verify webhook signatures so we can trust
// "this invoice was actually paid" events. Same "gracefully do nothing if not configured"
// philosophy as lib/mailer.js and lib/sms.js — the app works fine before a Stripe account
// exists, it just won't offer online payment yet.

const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Shared low-level request helper — every function below is just a thin wrapper that
// builds the right params for one Stripe endpoint. GET requests carry no body; every
// other method sends params as a form-urlencoded body, which is how Stripe's REST API
// expects writes regardless of HTTP verb.
async function stripeRequest(method, path, params) {
  const auth = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const opts = {
    method,
    headers: { Authorization: `Basic ${auth}` },
  };
  let url = `${STRIPE_API}${path}`;
  if (params && method === 'GET') {
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  } else if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = params.toString();
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Stripe request failed: ${res.status}`);
  }
  return data;
}

async function createCheckoutSession({ invoiceId, amountCents, description, successUrl, cancelUrl }) {
  if (!isConfigured()) {
    throw new Error("Online payments aren't turned on yet.");
  }
  if (!amountCents || amountCents < 50) {
    // Stripe rejects charges below ~$0.50
    throw new Error('Invoice amount is too small to charge online (minimum $0.50).');
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('client_reference_id', String(invoiceId));
  params.append('metadata[invoiceId]', String(invoiceId));
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][unit_amount]', String(amountCents));
  params.append('line_items[0][price_data][product_data][name]', description);

  return stripeRequest('POST', '/checkout/sessions', params);
}

// ---- Autopay: save a card now (no charge), bill it automatically later ----
//
// The flow (Stripe's documented pattern for "charge a customer while they're not
// present"): (1) createCustomer to get a Stripe Customer object to attach a saved card
// to, (2) createSetupCheckoutSession — a Checkout Session in mode:'setup' that collects
// card details and saves them to that Customer WITHOUT charging anything, (3) once the
// owner completes that hosted page, Stripe fires checkout.session.completed same as a
// normal payment — routes/stripeWebhook.js reads the SetupIntent it produced (via
// retrieveSetupIntent) to find the saved PaymentMethod id, then retrievePaymentMethod
// for card brand/last4 to show the owner what's on file, (4) from then on,
// createOffSessionPaymentIntent charges that saved card directly — no redirect, no
// owner interaction — whenever a new invoice should be auto-paid (see lib/autopay.js).

async function createCustomer({ email, name, metadata = {} }) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  const params = new URLSearchParams();
  if (email) params.append('email', email);
  if (name) params.append('name', name);
  Object.entries(metadata).forEach(([k, v]) => params.append(`metadata[${k}]`, String(v)));
  return stripeRequest('POST', '/customers', params);
}

async function createSetupCheckoutSession({ customerId, successUrl, cancelUrl, metadata = {} }) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  const params = new URLSearchParams();
  params.append('mode', 'setup');
  params.append('customer', customerId);
  params.append('payment_method_types[0]', 'card');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  Object.entries(metadata).forEach(([k, v]) => params.append(`metadata[${k}]`, String(v)));
  return stripeRequest('POST', '/checkout/sessions', params);
}

async function retrieveSetupIntent(id) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  return stripeRequest('GET', `/setup_intents/${id}`, null);
}

async function retrievePaymentMethod(id) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  return stripeRequest('GET', `/payment_methods/${id}`, null);
}

async function detachPaymentMethod(id) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  return stripeRequest('POST', `/payment_methods/${id}/detach`, new URLSearchParams());
}

// off_session:true + confirm:true tells Stripe this is an unattended charge against a
// card already on file — no redirect, no owner present to approve a 3DS prompt. Stripe
// can still decline it (expired card, bank flags it, etc.); callers must be ready for
// this to reject and just leave the invoice as a normal draft when it does (see
// lib/autopay.js — there's no retry loop here on purpose).
async function createOffSessionPaymentIntent({ customerId, paymentMethodId, amountCents, description, metadata = {} }) {
  if (!isConfigured()) throw new Error("Online payments aren't turned on yet.");
  if (!amountCents || amountCents < 50) {
    throw new Error('Invoice amount is too small to charge online (minimum $0.50).');
  }
  const params = new URLSearchParams();
  params.append('amount', String(amountCents));
  params.append('currency', 'usd');
  params.append('customer', customerId);
  params.append('payment_method', paymentMethodId);
  params.append('off_session', 'true');
  params.append('confirm', 'true');
  if (description) params.append('description', description);
  Object.entries(metadata).forEach(([k, v]) => params.append(`metadata[${k}]`, String(v)));
  return stripeRequest('POST', '/payment_intents', params);
}

// Verifies the Stripe-Signature header against the raw request body using the endpoint's
// webhook signing secret — this is Stripe's documented scheme (HMAC-SHA256 over
// "{timestamp}.{rawBody}"), reimplemented here without the Stripe SDK. rawBody must be the
// unparsed request body (a Buffer or string), not the JSON-parsed object.
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');
  let timestamp = null;
  const signatures = [];
  signatureHeader.split(',').forEach((part) => {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  });
  if (!timestamp || signatures.length === 0) throw new Error('Malformed Stripe-Signature header');

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');

  const matches = signatures.some((sig) => {
    try {
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (e) {
      return false;
    }
  });
  if (!matches) throw new Error('Signature verification failed');

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) throw new Error('Webhook timestamp too old (possible replay)');
}

module.exports = {
  isConfigured,
  createCheckoutSession,
  verifyWebhookSignature,
  createCustomer,
  createSetupCheckoutSession,
  retrieveSetupIntent,
  retrievePaymentMethod,
  detachPaymentMethod,
  createOffSessionPaymentIntent,
};
