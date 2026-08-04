const store = require('./store');
const { attemptAutopay, shouldSkipPerJobAutopay } = require('./autopay');

// Fires off an autopay attempt without making the caller (appointment-completion,
// monthly-bundling, the bulk unbilled-jobs fixer) wait on a Stripe round-trip — these
// invoice-creation functions have always been synchronous and every call site already
// uses their return value (the invoice as just-created, status:'draft') directly, so
// this deliberately doesn't change that shape. If autopay succeeds, the invoice flips
// to 'paid' moments later — the same "starts as draft, catches up to paid shortly
// after" pattern already true of the existing Stripe webhook for one-time payments.
// Any error is already caught and logged inside attemptAutopay itself; this .catch is
// just a backstop against an unexpected throw so it can never become an unhandled
// rejection.
function fireAutopay(invoice) {
  if (!invoice) return;
  attemptAutopay(invoice).catch((err) => {
    console.error(`Unexpected error attempting autopay for invoice #${invoice.id}:`, err.message);
  });
}

// Maps a customer's saved service frequency to a frequency-priced service's rate card.
// "every4weeks" is what customers call "monthly" service — the label shown throughout
// the UI is "Monthly" even though the field name stuck with the original wording.
const FREQUENCY_TIER_KEY = { weekly: 'weekly', biweekly: 'biweekly', every4weeks: 'every4weeks' };
const FREQUENCY_TIER_LABEL = { weekly: 'weekly rate', biweekly: 'biweekly rate', every4weeks: 'monthly rate' };

// Resolves what a given service should cost for a given customer, checked in order:
//   1. This specific home's own custom price for that service, if one is set — the
//      most specific override, since some owners charge different rates at different
//      properties (e.g. a bigger hot tub, a harder-to-reach home).
//   2. The customer's owner's custom price for that specific service, if one is set —
//      applies to every property linked to that owner unless a home overrides it above.
//   3. If the service is priced "by frequency," the rate for the customer's saved
//      service frequency (weekly/biweekly/monthly), or the flat vacation-rental rate
//      for vacation-type customers — falling back to the service's flat default price
//      if no matching tier rate has been set.
//   4. The service's flat catalog default price.
function resolvePrice(service, customerId) {
  const customer = customerId ? store.getById('customers', customerId) : null;
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;

  const homeCustom = customer && customer.customPricing ? customer.customPricing[String(service.id)] : undefined;
  if (homeCustom !== undefined) {
    return { price: homeCustom, isCustom: true, customSource: 'home', tierLabel: null };
  }

  const custom = owner && owner.customPricing ? owner.customPricing[String(service.id)] : undefined;
  if (custom !== undefined) {
    return { price: custom, isCustom: true, customSource: 'owner', tierLabel: null };
  }

  if (service.pricingMode === 'frequency' && customer) {
    const rates = service.frequencyPrices || {};
    if (customer.type === 'vacation') {
      if (rates.vacationFlat !== undefined) {
        return { price: rates.vacationFlat, isCustom: false, tierLabel: 'vacation rental rate' };
      }
    } else {
      const tierKey = FREQUENCY_TIER_KEY[customer.serviceFrequency];
      if (tierKey && rates[tierKey] !== undefined) {
        return { price: rates[tierKey], isCustom: false, tierLabel: FREQUENCY_TIER_LABEL[tierKey] };
      }
    }
  }

  return { price: service.defaultPrice, isCustom: false, tierLabel: null };
}

// Previews what each frequency tier would cost for a given owner, without needing an
// actual customer/serviceFrequency set yet — used by the owner portal's self-service
// "set up my regular service" flow so someone can see the price before picking a
// frequency. If the owner has a custom price set for this service, that single flat
// rate applies no matter which frequency they pick (frequency then just controls how
// often visits happen, not what they cost).
function previewFrequencyPricing(service, ownerId) {
  const owner = ownerId ? store.getById('owners', ownerId) : null;
  const custom = owner && owner.customPricing ? owner.customPricing[String(service.id)] : undefined;
  if (custom !== undefined) {
    return { isCustom: true, customPrice: custom };
  }
  const rates = service.frequencyPrices || {};
  return {
    isCustom: false,
    weekly: rates.weekly !== undefined ? rates.weekly : service.defaultPrice,
    biweekly: rates.biweekly !== undefined ? rates.biweekly : service.defaultPrice,
    every4weeks: rates.every4weeks !== undefined ? rates.every4weeks : service.defaultPrice,
  };
}

// Sums up any technician-added upcharges (e.g. grill cleaning, window spray) attached
// to an appointment. Each entry is a price snapshot taken when the tech added it, so
// later catalog price changes never retroactively change an already-billed job.
function addonsTotal(appt) {
  return (appt.addons || []).reduce((sum, a) => sum + (Number(a.price) || 0), 0);
}

function addonsNote(appt) {
  if (!appt.addons || appt.addons.length === 0) return '';
  return ' + ' + appt.addons.map((a) => `${a.name} ($${Number(a.price).toFixed(2)})`).join(', ');
}

// Some appointments reach completion without ever having been linked to a catalog
// service — bulk-imported from pasted text, or auto-scheduled turnover-cleaning jobs
// (see routes/appointments.js bulk-import-text and lib/turnoverSchedule.js) both create
// appointments with serviceId: null, and neither has a "pick a service" step at all.
// Left alone, that means computeBillFor can't price them and nothing ever gets
// invoiced — silently, since a tech marking a job complete gets no error either way.
// Two-step fallback: (1) this same customer's most recent OTHER appointment that DOES
// have a service linked, on the theory a customer's service rarely changes visit to
// visit; (2) if this customer has no such history either (e.g. every one of their jobs
// came from one of the gaps above), the Settings > Default service for auto-scheduled
// jobs, if the admin has set one. Backfills serviceId onto the appointment itself so
// it's consistently priceable (and visible/editable in the admin UI) from here on.
// Returns the appointment unchanged if neither fallback has anything to offer.
function ensureServiceId(appt) {
  if (!appt || appt.serviceId) return appt;
  const candidates = store.getAll('appointments')
    .filter((a) => a.customerId === appt.customerId && a.serviceId && a.id !== appt.id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const inferredServiceId = candidates.length
    ? candidates[0].serviceId
    : (store.getSettings().defaultServiceId || null);
  if (!inferredServiceId) return appt;
  return store.update('appointments', appt.id, { serviceId: inferredServiceId }) || appt;
}

// Shared by both the initial auto-invoice and the later re-sync below: works out what
// a completed appointment should bill for, or null if it can't be priced/shouldn't be
// auto-invoiced at all (no service, or no matching catalog entry).
//
// Owners on monthly combined billing (owner.billingMode === 'monthly') still get a
// normal individual draft invoice per completed job, same as everyone else — that used
// to be skipped here, which meant a monthly-billed owner's completed jobs never showed
// up in the Invoices tab at all until someone remembered to click "Generate monthly
// invoice," and any per-owner custom price never got applied until then either. Monthly
// billing now only changes what happens *after* the individual invoice exists: the admin
// can still send/collect it as-is, or use "Generate monthly invoice" (see
// lib/monthlyInvoice.js) to roll that month's individual invoices up into one combined
// bill — which marks them status:'bundled' rather than deleting them, so they stay
// visible in that property's invoice history.
function computeBillFor(rawAppt) {
  const appt = ensureServiceId(rawAppt);
  if (!appt || !appt.serviceId) return null;
  const service = store.getById('services', appt.serviceId);
  if (!service) return null;
  const { price, isCustom, customSource, tierLabel } = resolvePrice(service, appt.customerId);
  const extras = addonsTotal(appt);
  const total = (Number(price) || 0) + extras;
  const priceNote = isCustom ? (customSource === 'home' ? ', home price' : ', owner price') : (tierLabel ? `, ${tierLabel}` : '');
  const notes = `Auto-generated from completed appointment (${service.name}${priceNote})${addonsNote(appt)}.`;
  return { total, notes };
}

// If a completed appointment is linked to a catalog service with a resolvable price
// (custom owner price, frequency rate, or catalog default) — plus any technician-added
// upcharges — and doesn't already have an invoice, auto-creates a draft invoice at that
// total. Safe to call any time an appointment's status changes — it only acts when the
// conditions are met and never creates a duplicate (checked by appointmentId).
function maybeCreateInvoiceForCompletedAppointment(appt) {
  if (!appt || appt.status !== 'completed') return null;
  const bill = computeBillFor(appt);
  if (!bill || !bill.total) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (existing) return null;
  const created = store.create('invoices', {
    customerId: appt.customerId,
    appointmentId: appt.id,
    amount: bill.total,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: bill.notes,
  });
  if (!shouldSkipPerJobAutopay(appt.customerId)) fireAutopay(created);
  return created;
}

// A tech (or, pre-completion, an owner) can add or remove an upcharge on a job that's
// already been marked complete — e.g. remembering "oh, I also cleaned the grill" right
// after tapping complete. That auto-invoice was already created at the old total, and
// nothing else re-computes it. This brings a still-draft invoice's amount back in sync
// with the job's current addons. Invoices that have already been sent or paid are left
// alone on purpose — once an owner's seen a number, changing it silently would be
// confusing; the admin can adjust it by hand from here if that ever needs to happen.
function syncInvoiceForCompletedAppointment(appt) {
  if (!appt || appt.status !== 'completed') return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (!existing) return maybeCreateInvoiceForCompletedAppointment(appt);
  if (existing.status !== 'draft') return null;
  const bill = computeBillFor(appt);
  if (!bill) return null;
  if (bill.total === existing.amount) return null;
  return store.update('invoices', existing.id, { amount: bill.total, notes: bill.notes });
}

// Cancellation policy: cancelling a scheduled visit less than 24 hours out bills half
// of what that visit would have cost — same price resolution as a completed job
// (custom owner price, frequency tier, or catalog default), but not counting any
// upcharges since the tech never actually came out. No-ops if there's no priceable
// service on the appointment, or if an invoice already exists for it (so this is safe
// to call even if something upstream double-fires it).
function maybeCreateCancellationFeeInvoice(rawAppt) {
  const appt = ensureServiceId(rawAppt);
  if (!appt || !appt.serviceId) return null;
  const service = store.getById('services', appt.serviceId);
  if (!service) return null;
  const { price } = resolvePrice(service, appt.customerId);
  const fee = (Number(price) || 0) / 2;
  if (!fee) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (existing) return null;
  const created = store.create('invoices', {
    customerId: appt.customerId,
    appointmentId: appt.id,
    amount: fee,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: `Cancellation fee — visit cancelled within 24 hours of its scheduled time (50% of ${service.name}).`,
  });
  if (!shouldSkipPerJobAutopay(appt.customerId)) fireAutopay(created);
  return created;
}

// Used by the admin's bulk "fix unbilled jobs" tool (routes/appointments.js
// #bulk-assign-service) specifically when the chosen service is frequency-priced.
// resolvePrice() needs a matching customer.serviceFrequency to find a rate — but that's
// often exactly why these jobs were unbilled in the first place (bulk-imported/
// turnover-scheduled jobs never touch that field). Rather than silently landing on the
// service's likely-unset flat defaultPrice (which would create a $0 invoice, or worse,
// no invoice at all — see maybeCreateInvoiceForCompletedAppointment's !bill.total
// guard), this requires the admin to explicitly pick which tier's rate the whole batch
// should bill at. tier is one of 'weekly' | 'biweekly' | 'every4weeks' | 'vacationFlat'.
//
// Still checks the home's or owner's custom price FIRST, same priority order as
// resolvePrice() — this used to skip straight to the tier rate, which meant bulk-fixing
// a backlog of unbilled jobs would silently override a specific home's or owner's
// negotiated rate with the catalog's tier price picked for the batch. A custom rate set
// on the home (or, failing that, the owner) always bills at that rate regardless of
// which tier the admin picked for everyone else in the batch; the tier is only used as a
// fallback for customers with no custom price at either level.
function computeBillForWithTier(appt, service, tier) {
  if (!appt || !service) return null;
  const { price: resolvedPrice, isCustom, customSource } = resolvePrice(service, appt.customerId);
  let price;
  let priceNote;
  if (isCustom) {
    price = resolvedPrice;
    priceNote = customSource === 'home' ? ', home price' : ', owner price';
  } else {
    const rates = service.frequencyPrices || {};
    price = rates[tier];
    if (price === undefined || price === null || price === '') return null;
    const tierLabel = tier === 'vacationFlat' ? 'vacation rental rate' : (FREQUENCY_TIER_LABEL[tier] || tier);
    priceNote = `, ${tierLabel}`;
  }
  const extras = addonsTotal(appt);
  const total = Number(price) + extras;
  const notes = `Auto-generated from completed appointment (${service.name}${priceNote})${addonsNote(appt)}.`;
  return { total, notes };
}

// Same create-or-resync shape as maybeCreateInvoiceForCompletedAppointment /
// syncInvoiceForCompletedAppointment, but priced via computeBillForWithTier's explicit
// tier override instead of the normal customer-frequency lookup.
function createOrSyncInvoiceWithTier(appt, service, tier) {
  if (!appt || appt.status !== 'completed') return null;
  const bill = computeBillForWithTier(appt, service, tier);
  if (!bill || !bill.total) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (!existing) {
    const created = store.create('invoices', {
      customerId: appt.customerId,
      appointmentId: appt.id,
      amount: bill.total,
      issuedDate: new Date().toISOString().slice(0, 10),
      dueDate: '',
      status: 'draft',
      notes: bill.notes,
    });
    if (!shouldSkipPerJobAutopay(appt.customerId)) fireAutopay(created);
    return created;
  }
  if (existing.status !== 'draft') return null;
  if (bill.total === existing.amount) return null;
  return store.update('invoices', existing.id, { amount: bill.total, notes: bill.notes });
}

module.exports = {
  maybeCreateInvoiceForCompletedAppointment,
  maybeCreateCancellationFeeInvoice,
  syncInvoiceForCompletedAppointment,
  createOrSyncInvoiceWithTier,
  resolvePrice,
  previewFrequencyPricing,
  addonsTotal,
  addonsNote,
};
