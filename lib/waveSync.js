// Bridges High Desert's own invoices/customers to Wave Accounting via
// lib/waveClient.js. Every function here is best-effort and non-blocking — a
// Wave failure is logged and recorded on the invoice (waveSyncError) but never
// stops the underlying app action (marking an invoice sent/paid, etc.) from
// completing, same pattern as lib/autopay.js's Stripe calls.
//
// Sync only kicks in once an invoice actually gets billed (status moves to
// 'sent') rather than the moment it's auto-created as a draft — a draft
// invoice may never actually go out (a job gets re-priced, an addon removed,
// etc.), and Wave's own books shouldn't see charges that were never really
// billed. Once sent, the same invoice is pushed to Wave exactly once
// (tracked via invoice.waveInvoiceId) and later payment just records a
// payment against that same Wave invoice — it's never recreated.
const store = require('./store');
const wave = require('./waveClient');

function log(msg, err) {
  console.error(`[wave-sync] ${msg}${err ? `: ${err.message}` : ''}`);
}

// Finds (or creates, once) the Wave customer for whoever this invoice actually
// bills — the linked owner if there is one (covers both per-property and
// owner-wide combined invoices, which always carry ownerId), otherwise the
// property/customer itself. Mirrors routes/invoices.js's own resolveInvoiceRecipient.
async function ensureWaveCustomerForInvoice(invoice) {
  let collection, record;
  if (invoice.ownerId) {
    collection = 'owners';
    record = store.getById('owners', invoice.ownerId);
  } else {
    collection = 'customers';
    record = store.getById('customers', invoice.customerId);
  }
  if (!record) throw new Error('No customer/owner on file for this invoice');
  if (record.waveCustomerId) return record.waveCustomerId;

  const waveCustomerId = await wave.createCustomer({ name: record.name, email: record.email || '' });
  store.update(collection, record.id, { waveCustomerId });
  return waveCustomerId;
}

// Finds (or creates, once) a Wave product to represent one line item's service
// — cached by name so repeat services (e.g. every "Diagnostic Visit") reuse the
// same Wave product instead of piling up duplicates. Catalog services cache the
// id directly on their own record; anything else (a one-off description, a
// cancellation fee) caches by name in settings.waveProductCache.
async function ensureWaveProduct(name) {
  const services = store.getAll('services');
  const service = services.find((s) => s.name === name);
  if (service && service.waveProductId) return service.waveProductId;

  const settings = store.getSettings();
  const cache = settings.waveProductCache || {};
  if (cache[name]) return cache[name];

  const waveProductId = await wave.createProduct({ name });
  if (service) {
    store.update('services', service.id, { waveProductId });
  } else {
    store.updateSettings({ waveProductCache: { ...cache, [name]: waveProductId } });
  }
  return waveProductId;
}

// Turns one invoice into the { productId, quantity, unitPrice } line items Wave's
// invoiceCreate expects — one per bundled job for a combined invoice, or a
// single line derived from the linked appointment (or, failing that, the
// invoice's own notes) for a normal one-job invoice.
async function buildWaveLineItems(invoice) {
  const rawItems = (invoice.lineItems && invoice.lineItems.length)
    ? invoice.lineItems.map((li) => ({ name: li.serviceType || 'Service', amount: Number(li.amount) || 0 }))
    : [{
      name: (() => {
        if (invoice.appointmentId) {
          const appt = store.getById('appointments', invoice.appointmentId);
          if (appt) return appt.serviceType || 'Service';
        }
        return invoice.notes ? invoice.notes.slice(0, 60) : 'Spa service';
      })(),
      amount: Number(invoice.amount) || 0,
    }];

  const items = [];
  for (const item of rawItems) {
    const productId = await ensureWaveProduct(item.name);
    items.push({ productId, quantity: 1, unitPrice: item.amount });
  }
  return items;
}

// Creates this invoice in Wave (as a real, approved-and-sent invoice, matching
// its status in our own app at the moment it's pushed) if it hasn't been
// pushed yet. Safe to call more than once — a second call on an
// already-pushed invoice is a no-op.
async function pushInvoiceToWave(invoiceId) {
  if (!wave.isConfigured()) return;
  const invoice = store.getById('invoices', invoiceId);
  if (!invoice || invoice.waveInvoiceId) return;

  try {
    const customerId = await ensureWaveCustomerForInvoice(invoice);
    const items = await buildWaveLineItems(invoice);
    const waveInvoiceId = await wave.createInvoice({ customerId, items });
    await wave.approveInvoice(waveInvoiceId);
    await wave.markInvoiceSent(waveInvoiceId);
    store.update('invoices', invoice.id, {
      waveInvoiceId,
      waveSyncedAt: new Date().toISOString(),
      waveSyncError: null,
    });
  } catch (err) {
    log(`Failed to push invoice #${invoiceId} to Wave`, err);
    store.update('invoices', invoice.id, { waveSyncError: err.message });
  }
}

// Records this invoice as paid in Wave. Pushes it to Wave first if that
// hasn't happened yet (e.g. an invoice paid online the same moment it's sent —
// autopay especially can go straight from draft to paid with no separate
// "sent" step in between).
async function recordWavePayment(invoiceId) {
  if (!wave.isConfigured()) return;
  const invoice = store.getById('invoices', invoiceId);
  if (!invoice) return;
  if (!invoice.waveInvoiceId) await pushInvoiceToWave(invoiceId);

  const updated = store.getById('invoices', invoiceId);
  if (!updated || !updated.waveInvoiceId) return; // push above failed; error already logged/stored

  try {
    await wave.recordManualPayment({
      invoiceId: updated.waveInvoiceId,
      amount: Number(updated.amount) || 0,
      date: (updated.issuedDate || new Date().toISOString().slice(0, 10)),
    });
    store.update('invoices', invoice.id, { waveSyncedAt: new Date().toISOString(), waveSyncError: null });
  } catch (err) {
    log(`Failed to record Wave payment for invoice #${invoiceId}`, err);
    store.update('invoices', invoice.id, { waveSyncError: err.message });
  }
}

module.exports = { pushInvoiceToWave, recordWavePayment };
