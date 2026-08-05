// Thin wrapper around Wave Accounting's public GraphQL API
// (https://developer.waveapps.com) — used to push High Desert's invoices and
// customers into Wave for bookkeeping. Uses a Full Access Token (personal-use
// token, tied to one specific Wave business) rather than the OAuth flow, since
// this app only ever talks to its own owner's Wave business, not third parties'.
//
// SETUP: on Render (or wherever this is hosted), set:
//   WAVE_ACCESS_TOKEN — a Full Access Token from developer.waveapps.com →
//     Manage Applications → (your app) → Full Access Tokens. Grants full access
//     to the Wave business that generated it — treat it like a password.
//   WAVE_BUSINESS_ID — the Wave business id to push into (see fetchBusinessId()
//     below, or run the `businesses` query in Wave's API Playground).
// Without both set, every function here is a safe no-op — the rest of the app
// runs exactly as it did before this integration existed, same pattern already
// used for ANTHROPIC_API_KEY/STRIPE_SECRET_KEY/TWILIO_*.
const GRAPHQL_ENDPOINT = 'https://gql.waveapps.com/graphql/public';

function isConfigured() {
  return !!(process.env.WAVE_ACCESS_TOKEN && process.env.WAVE_BUSINESS_ID);
}

// Wave's GraphQL API expects a base64-encoded global "Node" id, like
// base64("Business:<uuid>") — e.g. "QnVzaW5lc3M6NmVmZTk0MmUt...". It does NOT
// accept the plain uuid shown in the browser's URL bar when logged into Wave
// (next.waveapps.com/<uuid>/dashboard) — that raw uuid gets rejected with
// "Node '<uuid>' could not be found." Auto-encoding a raw uuid here means
// WAVE_BUSINESS_ID can just be pasted straight from that URL; if it's already
// base64-encoded (e.g. from the businesses{} query in Wave's API Playground),
// it's passed through unchanged.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function businessId() {
  const raw = process.env.WAVE_BUSINESS_ID || '';
  if (UUID_RE.test(raw)) {
    return Buffer.from(`Business:${raw}`).toString('base64');
  }
  return raw;
}

// Low-level GraphQL call. Throws on network failure, top-level GraphQL `errors`,
// or (for mutations following Wave's didSucceed/inputErrors convention) when the
// mutation itself reports failure — callers pass `resultPath` (e.g.
// 'customerCreate') so this can check that convention automatically.
async function request(query, variables, resultPath) {
  if (!isConfigured()) {
    throw new Error('Wave is not configured (WAVE_ACCESS_TOKEN/WAVE_BUSINESS_ID not set)');
  }
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WAVE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Wave API HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors && json.errors.length) {
    throw new Error(`Wave API error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (resultPath) {
    const result = resultPath.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), json.data);
    if (!result) throw new Error(`Wave API: no data returned for ${resultPath}`);
    if (result.didSucceed === false) {
      const errs = (result.inputErrors || []).map((e) => `${(e.path || []).join('.')}: ${e.message}`).join('; ');
      throw new Error(`Wave rejected ${resultPath}: ${errs || 'unknown error'}`);
    }
  }
  return json.data;
}

async function createCustomer({ name, email }) {
  const data = await request(
    `mutation ($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        customer { id }
      }
    }`,
    { input: { businessId: businessId(), name, email: email || undefined } },
    'customerCreate',
  );
  return data.customerCreate.customer.id;
}

async function createProduct({ name }) {
  const data = await request(
    `mutation ($input: ProductCreateInput!) {
      productCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        product { id }
      }
    }`,
    { input: { businessId: businessId(), name, incomeAccountId: null } },
    'productCreate',
  );
  return data.productCreate.product.id;
}

// items: [{ productId, quantity, unitPrice }]
async function createInvoice({ customerId, items }) {
  const data = await request(
    `mutation ($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice { id }
      }
    }`,
    { input: { businessId: businessId(), customerId, items } },
    'invoiceCreate',
  );
  return data.invoiceCreate.invoice.id;
}

async function approveInvoice(invoiceId) {
  await request(
    `mutation ($input: InvoiceApproveInput!) {
      invoiceApprove(input: $input) { didSucceed inputErrors { path message code } }
    }`,
    { input: { invoiceId } },
    'invoiceApprove',
  );
}

async function markInvoiceSent(invoiceId) {
  await request(
    `mutation ($input: InvoiceMarkSentInput!) {
      invoiceMarkSent(input: $input) { didSucceed inputErrors { path message code } }
    }`,
    { input: { invoiceId } },
    'invoiceMarkSent',
  );
}

async function recordManualPayment({ invoiceId, amount, date }) {
  await request(
    `mutation ($input: InvoicePaymentCreateManualInput!) {
      invoicePaymentCreateManual(input: $input) { didSucceed inputErrors { path message code } }
    }`,
    { input: { invoiceId, amount, paymentDate: date } },
    'invoicePaymentCreateManual',
  );
}

// Convenience for one-time setup — lists the Wave businesses this token can see,
// so whoever's connecting this can find their WAVE_BUSINESS_ID. Not called
// anywhere in the app's normal request flow.
async function listBusinesses() {
  const data = await request(
    `{ businesses(page: 1, pageSize: 20) { edges { node { id name } } } }`,
  );
  return data.businesses.edges.map((e) => e.node);
}

module.exports = {
  isConfigured,
  createCustomer,
  createProduct,
  createInvoice,
  approveInvoice,
  markInvoiceSent,
  recordManualPayment,
  listBusinesses,
};
