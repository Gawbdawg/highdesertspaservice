const store = require('./store');

// Whether an owner's completed jobs should accumulate toward a monthly combined
// bill rather than needing individual action (send/collect) the moment each one
// is created. True for two different reasons:
//   - the owner explicitly picked Monthly billing (owner.billingMode === 'monthly')
//   - the owner has at least one vacation-rental property — vacation billing is
//     effectively always monthly in practice (guests rotate constantly; nobody
//     wants a separate bill per turnover clean), regardless of whether billingMode
//     was ever explicitly set to match that.
// Used both to decide which draft invoices should stay out of the main Invoices
// tab/Money queue (see routes/invoices.js#enrich's isMonthlyDeferred) and to build
// the Monthly tab's owner list (see routes/owners.js's /monthly-pending).
function ownerQualifiesForMonthly(owner, properties) {
  if (!owner) return false;
  if (owner.billingMode === 'monthly') return true;
  return properties.some((p) => p.ownerId === owner.id && p.type === 'vacation');
}

// Rolls up a set of already-created individual draft invoices for a given month
// (YYYY-MM) into one combined invoice. This does NOT compute pricing itself — every
// completed job already got its own normal draft invoice, correctly priced (custom
// owner/home rate, frequency tier, addons, whatever applies) — see
// lib/autoInvoice.js#computeBillFor. Bundling just changes how that same set of
// charges gets collected: instead of recomputing anything, it takes the existing
// invoices as line items exactly as billed, sums them, and files them under one
// combined invoice.
//
// Only status:'draft' invoices are eligible — anything already sent or paid has moved
// past the "about to bill" stage and shouldn't quietly get folded into a bill the
// owner never saw. Matched by issuedDate (when the individual invoice was created)
// rather than the underlying appointment's date, since issuedDate is what's actually
// visible in the Invoices tab.
//
// The rolled-up invoices are marked status:'bundled' (not deleted) and tagged with
// bundledIntoInvoiceId — so they keep showing up in that property's own invoice
// history (an owner might reasonably want to see what each visit cost), just excluded
// from outstanding/paid totals and the main Invoices list going forward, since the
// combined invoice is now the one that actually gets sent and collected. Safe to
// re-run: already-bundled invoices are skipped, so nothing ever gets billed twice.
//
// `invoiceFields` lets the two callers below (owner-wide vs. per-property) decide
// what the resulting combined invoice's customerId/ownerId/notes should be — that's
// the only thing that actually differs between the two bundling scopes.
function bundleDraftInvoices(customerIds, monthStr, invoiceFields) {
  if (!/^\d{4}-\d{2}$/.test(monthStr || '')) throw new Error('month must be in YYYY-MM format');
  if (!customerIds.length) return null;

  const sourceInvoices = store.getAll('invoices').filter((i) => (
    i.customerId
    && customerIds.includes(i.customerId)
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

  const combined = store.create('invoices', {
    ...invoiceFields,
    appointmentId: null,
    amount: total,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    lineItems,
  });

  sourceInvoices.forEach((inv) => {
    store.update('invoices', inv.id, { status: 'bundled', bundledIntoInvoiceId: combined.id });
  });

  // Combined invoices no longer autocharge the moment they're generated either — they
  // land as a normal draft, same as every other invoice now, so the admin can review
  // this month's bundle (and, if a cancellation fee or anything else needs pulling out
  // — see routes/invoices.js's line-item removal — do that) before charging it on
  // purpose with the admin-triggered "Process payment" button.
  return combined;
}

// Bundles every one of an owner's properties' draft invoices for the month into a
// single combined bill — customerId is deliberately left null since this invoice
// isn't any one property's, it's the owner's whole month across every home.
function generateOwnerWideMonthlyInvoice(owner, propertyIds, monthStr) {
  const propertyCount = propertyIds.length;
  return bundleDraftInvoices(propertyIds, monthStr, {
    customerId: null,
    ownerId: owner.id,
    notes: `Combined monthly invoice for ${owner.name} — ${monthStr} (across ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}).`,
  });
}

// Bundles each property's draft invoices separately — one combined bill per house,
// same month. customerId IS set (this is that property's own invoice, same shape as
// any normal single-property invoice) with ownerId also set alongside it purely so
// payment/emailing/autopay still resolve to the owner, who's the one actually billed.
// Properties with nothing to bill that month are silently skipped (bundleDraftInvoices
// returns null for them) rather than creating an empty $0 invoice.
function generatePerPropertyMonthlyInvoices(owner, propertyIds, monthStr) {
  const customers = store.getAll('customers');
  return propertyIds
    .map((propertyId) => {
      const property = customers.find((c) => c.id === propertyId);
      const propertyName = property ? property.name : 'this property';
      return bundleDraftInvoices([propertyId], monthStr, {
        customerId: propertyId,
        ownerId: owner.id,
        notes: `Monthly invoice for ${propertyName} — ${monthStr}.`,
      });
    })
    .filter(Boolean);
}

// Entry point used by the admin's "Generate monthly invoice" button. Always returns an
// array (possibly empty) — one combined invoice per property if the owner's
// monthlyBundleScope is 'property' (see routes/owners.js), otherwise a single combined
// invoice across every property, same as this always worked before that option
// existed.
function generateMonthlyInvoiceForOwner(ownerId, monthStr) {
  const owner = store.getById('owners', ownerId);
  if (!owner) throw new Error('Owner not found');

  const propertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === Number(ownerId))
    .map((c) => c.id);
  if (propertyIds.length === 0) throw new Error('This owner has no linked properties');

  if (owner.monthlyBundleScope === 'property') {
    return generatePerPropertyMonthlyInvoices(owner, propertyIds, monthStr);
  }
  const invoice = generateOwnerWideMonthlyInvoice(owner, propertyIds, monthStr);
  return invoice ? [invoice] : [];
}

module.exports = { generateMonthlyInvoiceForOwner, ownerQualifiesForMonthly };
