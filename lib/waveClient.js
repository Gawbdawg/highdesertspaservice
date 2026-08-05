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

// Wave requires every product to post to a real ledger account — incomeAccountId
// and expenseAccountId can't both be left unset. See getIncomeAccounts() below,
// used by lib/waveSync.js to look up (and cache) a real account id from this
// business's own chart of accounts rather than guessing one.
//
// unitPrice is also required on create, but isn't actually used by anything
// here — every invoice line item explicitly sets its own unitPrice when it's
// added to an invoice (see buildWaveLineItems in lib/waveSync.js), overriding
// whatever the product's own default is. This product only exists as a named
// anchor for the line item, so 0 is a safe, inert default.
async function createProduct({ name, incomeAccountId }) {
  const data = await request(
    `mutation ($input: ProductCreateInput!) {
      productCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        product { id }
      }
    }`,
    { input: { businessId: businessId(), name, unitPrice: 0, incomeAccountId } },
    'productCreate',
  );
  return data.productCreate.product.id;
}

// This business's own chart-of-accounts INCOME accounts (e.g. "Sales", "Service
// Revenue") — used to pick a real incomeAccountId for createProduct() above,
// since Wave requires products to post to an actual account rather than
// accepting a null/unset one. Excludes archived accounts, since those can't
// receive new transactions.
async function getIncomeAccounts() {
  const data = await request(
    `query ($businessId: ID!) {
      business(id: $businessId) {
        accounts(page: 1, pageSize: 50, types: [INCOME]) {
          edges { node { id name isArchived } }
        }
      }
    }`,
    { businessId: businessId() },
  );
  return (data.business.accounts.edges || [])
    .map((e) => e.node)
    .filter((n) => !n.isArchived);
}

// items: [{ productId, quantity, unitPrice }]. Returns both the invoice id (used
// for the later approve/markSent/payment calls) and Wave's own hosted viewUrl —
// a page on Wave's own site where a customer can view and, if the business has
// Wave Payments turned on, pay the invoice online directly through Wave. See
// lib/waveSync.js, which saves that url on our own invoice record so
// public/pay.js can offer it as a real "pay online" option.
async function createInvoice({ customerId, items }) {
  const data = await request(
    `mutation ($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) {
        didSucceed
        inputErrors { path message code }
        invoice { id viewUrl }
      }
    }`,
    { input: { businessId: businessId(), customerId, items } },
    'invoiceCreate',
  );
  return { id: data.invoiceCreate.invoice.id, viewUrl: data.invoiceCreate.invoice.viewUrl };
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

async function markInvoiceSent(invoiceId, sendMethod) {
  await request(
    `mutation ($input: InvoiceMarkSentInput!) {
      invoiceMarkSent(input: $input) { didSucceed inputErrors { path message code } }
    }`,
    { input: { invoiceId, sendMethod } },
    'invoiceMarkSent',
  );
}

// Generic enum introspection — used to look up valid values for an enum type
// (e.g. InvoiceSendMethod) directly from Wave's own live schema instead of
// hardcoding a guess that could be wrong/outdated. See lib/waveSync.js's
// resolveSendMethod(), which picks the best match from whatever comes back.
async function getEnumValues(typeName) {
  const data = await request(
    `query ($typeName: String!) { __type(name: $typeName) { enumValues { name } } }`,
    { typeName },
  );
  if (!data.__type) throw new Error(`Wave API: no such type "${typeName}"`);
  return data.__type.enumValues.map((v) => v.name);
}

// Looks up an already-created Wave invoice's hosted viewUrl by its (Relay
// global) id, using the standard `node(id:)` lookup every Relay-style API
// exposes for fetching any object by its global id. Used to backfill
// waveViewUrl onto invoices that synced to Wave before that field started
// being saved (see lib/waveSync.js#pushInvoiceToWave) — without needing to
// recreate the invoice in Wave, which would leave a duplicate behind.
async function getInvoiceViewUrl(waveInvoiceId) {
  const data = await request(
    `query ($id: ID!) { node(id: $id) { ... on Invoice { viewUrl } } }`,
    { id: waveInvoiceId },
  );
  return data.node ? data.node.viewUrl : null;
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
  getIncomeAccounts,
  getEnumValues,
  getInvoiceViewUrl,
};
