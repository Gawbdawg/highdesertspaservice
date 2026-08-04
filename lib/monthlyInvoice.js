const store = require('./store');
const { attemptAutopay } = require('./autopay');

// Rolls up an owner's already-created individual invoices for a given month (YYYY-MM)
// into one combined invoice. This does NOT compute pricing itself — every completed job
// (for monthly-billed owners same as everyone else, see lib/autoInvoice.js#computeBillFor)
// already got its own normal draft invoice, correctly priced (custom owner rate,
// frequency tier, addons, whatever applies). Bundling just changes how that same set of
// charges gets collected: instead of recomputing anything, it takes the existing
// invoices as line items exactly as billed, sums them, and files them under one combined
// invoice.
//
// Only status:'draft' invoices are eligible — anything already sent or paid has moved
// past the "about to bill" stage and shouldn't quietly get folded into a bill the owner
// never saw. Matched by issuedDate (when the individual invoice was created) rather than
// the underlying appointment's date, since issuedDate is what's actually visible in the
// Invoices tab.
//
// The rolled-up invoices are marked status:'bundled' (not deleted) and tagged with
// bundledIntoInvoiceId — so they keep showing up in that property's own invoice history
// (an owner might reasonably want to see what each visit cost), just excluded from
// outstanding/paid totals and the main Invoices list going forward, since the combined
// invoice is now the one that actually gets sent and collected. Safe to re-run: already-
// bundled invoices are skipped, so nothing ever gets billed twice.
function generateMonthlyInvoiceForOwner(ownerId, monthStr) {
  const owner = store.getById('owners', ownerId);
  if (!owner) throw new Error('Owner not found');
  if (!/^\d{4}-\d{2}$/.test(monthStr || '')) throw new Error('month must be in YYYY-MM format');

  const propertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === Number(ownerId))
    .map((c) => c.id);
  if (propertyIds.length === 0) throw new Error('This owner has no linked properties');

  const sourceInvoices = store.getAll('invoices').filter((i) => (
    i.customerId
    && propertyIds.includes(i.customerId)
    && i.status === 'draft'
    && !i.bundledIntoInvoiceId
    && (i.issuedDate || '').startsWith(monthStr)
  ));

  if (sourceInvoices.length === 0) return null;

  const services = store.getAll('services');
  const lineItems = sourceInvoices.map((inv) => {
    const customer = store.getById('customers', inv.customerId);
    const appt = inv.appointmentId ? store.getById('appointments', inv.appointmentId) : null;
    const service = appt && appt.serviceId ? services.find((s) => s.id === appt.serviceId) : null;
    return {
      sourceInvoiceId: inv.id,
      appointmentId: inv.appointmentId || null,
      customerId: inv.customerId,
      customerName: customer ? customer.name : 'Unknown property',
      serviceType: appt ? (appt.serviceType || (service ? service.name : '')) : (inv.notes || 'Invoice'),
      date: appt ? appt.date : inv.issuedDate,
      amount: Number(inv.amount) || 0,
    };
  });

  const total = lineItems.reduce((sum, li) => sum + Number(li.amount), 0);
  const propertyCount = new Set(lineItems.map((li) => li.customerId)).size;

  const combined = store.create('invoices', {
    customerId: null,
    ownerId: Number(ownerId),
    appointmentId: null,
    amount: total,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: `Combined monthly invoice for ${owner.name} — ${monthStr} (${lineItems.length} job${lineItems.length === 1 ? '' : 's'} across ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}).`,
    lineItems,
  });

  sourceInvoices.forEach((inv) => {
    store.update('invoices', inv.id, { status: 'bundled', bundledIntoInvoiceId: combined.id });
  });

  // This IS the moment a monthly-billing owner should get autocharged — their per-job
  // invoices deliberately skip autopay as they're created (see
  // lib/autoInvoice.js#fireAutopay + lib/autopay.js#shouldSkipPerJobAutopay) precisely
  // so the whole month lands in this one combined bill instead of being charged job by
  // job. Fired without awaiting so generating the monthly invoice doesn't hang on a
  // Stripe round-trip; any failure is already caught and logged inside attemptAutopay.
  attemptAutopay(combined).catch((err) => {
    console.error(`Unexpected error attempting autopay for combined invoice #${combined.id}:`, err.message);
  });

  return combined;
}

module.exports = { generateMonthlyInvoiceForOwner };
