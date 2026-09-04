const express = require('express');
const store = require('../lib/store');
const { sendSms } = require('../lib/sms');
const { syncInvoiceForCompletedAppointment, createOrSyncInvoiceWithTier } = require('../lib/autoInvoice');
const { notifyOwnerJobCompleted } = require('../lib/jobCompletionEmail');
const { makeCustomerMatcher } = require('../lib/customerMatch');
const { futureDates } = require('../lib/recurrence');
const router = express.Router();

function enrich(appt) {
  const customer = store.getById('customers', appt.customerId);
  const technician = appt.technicianId ? store.getById('technicians', appt.technicianId) : null;
  return {
    ...appt,
    customerName: customer ? customer.name : 'Unknown customer',
    customerPhone: customer ? customer.phone : '',
    customerAddress: customer ? customer.address : '',
    lat: customer ? customer.lat : undefined,
    lng: customer ? customer.lng : undefined,
    technicianName: technician ? technician.name : 'Unassigned',
  };
}

router.get('/', (req, res) => {
  let appts = store.getAll('appointments');
  if (req.query.date) appts = appts.filter((a) => a.date === req.query.date);
  if (req.query.technicianId) appts = appts.filter((a) => a.technicianId === Number(req.query.technicianId));
  if (req.query.customerId) appts = appts.filter((a) => a.customerId === Number(req.query.customerId));
  appts = appts.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  res.json(appts.map(enrich));
});

router.get('/:id', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  res.json(enrich(appt));
});

router.post('/', (req, res) => {
  const {
    customerId, technicianId, date, startTime, endTime, serviceType, serviceId, status, notes,
    chlorine, ph, alkalinity, recurrence, recurrenceEndDate, recurrenceCustomDays, addons,
  } = req.body;
  if (!customerId || !date || !startTime) {
    return res.status(400).json({ error: 'customerId, date, and startTime are required' });
  }
  const service = serviceId ? store.getById('services', serviceId) : null;
  const base = {
    customerId: Number(customerId),
    technicianId: technicianId ? Number(technicianId) : null,
    startTime,
    endTime: endTime || '',
    serviceId: service ? service.id : null,
    serviceType: serviceType || (service ? service.name : 'Hot Tub Service'),
    status: status || 'scheduled',
    notes: notes || '',
    chlorine: chlorine || '',
    ph: ph || '',
    alkalinity: alkalinity || '',
  };
  // Upcharges (e.g. a property owner requesting grill cleaning, or an admin adding one
  // while scheduling) only apply to this specific visit — a recurring series generated
  // below deliberately does NOT copy them onto every future occurrence.
  const cleanAddons = Array.isArray(addons)
    ? addons
      .filter((a) => a && a.name)
      .map((a) => ({ id: a.id, name: a.name, price: Number(a.price) || 0 }))
    : [];

  const first = store.create('appointments', { ...base, date, seriesId: null, addons: cleanAddons });
  syncInvoiceForCompletedAppointment(first);

  if (recurrence && recurrence !== 'none') {
    store.update('appointments', first.id, { seriesId: first.id });
    futureDates(date, recurrence, recurrenceEndDate, recurrenceCustomDays).forEach((d) => {
      store.create('appointments', { ...base, date: d, seriesId: first.id, status: 'scheduled' });
    });
  }

  res.status(201).json(enrich(store.getById('appointments', first.id)));
});

router.put('/:id', (req, res) => {
  const before = store.getById('appointments', req.params.id);
  const updates = { ...req.body };
  delete updates.recurrence;
  delete updates.recurrenceEndDate;
  delete updates.recurrenceCustomDays;
  if (updates.customerId) updates.customerId = Number(updates.customerId);
  if (updates.technicianId) updates.technicianId = Number(updates.technicianId);
  if (updates.serviceId !== undefined) updates.serviceId = updates.serviceId ? Number(updates.serviceId) : null;
  // Appointments auto-scheduled BEFORE the checkoutDate field existed (see
  // lib/turnoverSchedule.js#maybeCreateCheckoutAppointment) never got tagged with it —
  // so moving one of those to a new date used to look, to the next iCal resync, exactly
  // like that checkout was never handled, and a duplicate got created right back on the
  // original day. Lazily backfilling checkoutDate here, at the moment of the FIRST
  // move, closes that gap for all pre-existing data without needing a one-time
  // migration: freeze in the date this appointment is being moved away FROM as its
  // checkoutDate, so a resync still recognizes that day as already covered. Harmless
  // to set on an appointment that was never tied to a booking checkout at all — it
  // just means a real checkout that happens to land on the same day won't get a
  // redundant second cleaning either.
  if (before && updates.date !== undefined && updates.date !== before.date && !before.checkoutDate) {
    updates.checkoutDate = before.date;
  }
  const updated = store.update('appointments', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Appointment not found' });
  syncInvoiceForCompletedAppointment(updated);
  // Only on the actual scheduled->completed transition (e.g. the admin marking a job
  // done from the Daily Dispatch board), not on every later edit to an already-
  // completed appointment.
  if (before && before.status !== 'completed' && updated.status === 'completed') {
    notifyOwnerJobCompleted(updated, 'High Desert Spa Service');
  }
  res.json(enrich(updated));
});

// Fixes a batch of already-completed jobs that never got invoiced because they were
// never linked to a catalog service (see the Reports tab's "Completed jobs missing an
// invoice" table) — picks one service for all of them at once and re-runs invoicing,
// rather than making the admin open and edit each appointment individually.
router.post('/bulk-assign-service', (req, res) => {
  const { appointmentIds, serviceId, tier } = req.body;
  if (!Array.isArray(appointmentIds) || !appointmentIds.length) {
    return res.status(400).json({ error: 'appointmentIds must be a non-empty array' });
  }
  const service = serviceId ? store.getById('services', serviceId) : null;
  if (!service) return res.status(400).json({ error: 'A valid serviceId is required' });

  // Frequency-priced services need to know WHICH rate to bill this batch at — the
  // normal per-customer resolution (via customer.serviceFrequency) is exactly what's
  // usually missing on jobs that ended up unbilled in the first place, so falling
  // through silently here would create $0 invoices (or none at all — see
  // maybeCreateInvoiceForCompletedAppointment's !bill.total guard) instead of the real
  // price. Require an explicit tier and validate it's actually a rate this service has.
  if (service.pricingMode === 'frequency') {
    const rates = service.frequencyPrices || {};
    if (!tier || rates[tier] === undefined || rates[tier] === null || rates[tier] === '') {
      return res.status(400).json({ error: 'This service has frequency-based pricing — pick which rate to bill these jobs at.' });
    }
  }

  let updatedCount = 0;
  let invoicesCreated = 0;
  appointmentIds.forEach((id) => {
    const appt = store.getById('appointments', id);
    if (!appt) return;
    const hadInvoice = store.getAll('invoices').some((i) => i.appointmentId === appt.id);
    const updated = store.update('appointments', id, { serviceId: service.id });
    updatedCount += 1;
    const invoice = service.pricingMode === 'frequency'
      ? createOrSyncInvoiceWithTier(updated, service, tier)
      : syncInvoiceForCompletedAppointment(updated);
    if (invoice && !hadInvoice) invoicesCreated += 1;
  });

  res.json({ updatedCount, invoicesCreated });
});

router.delete('/:id', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  if (req.query.scope === 'series' && appt.seriesId) {
    const toRemove = store.getAll('appointments')
      .filter((a) => a.seriesId === appt.seriesId && a.date >= appt.date);
    toRemove.forEach((a) => store.remove('appointments', a.id));
    return res.status(204).end();
  }

  store.remove('appointments', req.params.id);
  res.status(204).end();
});

// Bulk-imports appointments from pasted text — one line per day in the form
// "YYYY-MM-DD: Name One, Name Two, Name Three". Each name is matched against existing
// customers (exact match, then space-insensitive exact match, then a unique prefix match);
// anything that can't be confidently matched is reported back instead of guessed at, since
// silently creating an appointment for the wrong customer is worse than skipping one.
// Times are spread through the day in 30-minute steps starting at 8am purely so each
// appointment has a distinct time — actual visit order is handled by route optimization
// (Settings tab), not by these placeholder times.
router.post('/bulk-import-text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const customers = store.getAll('customers');
  const findCustomer = makeCustomerMatcher(customers);

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const created = [];
  const unmatched = [];
  const skippedLines = [];
  const alreadyScheduled = [];
  // Tracks (customerId + date) pairs already on the books — including ones this same
  // import just created — so pasting the same (or overlapping) text in twice, or a
  // customer appearing twice for one day, can't create duplicate appointments.
  const existingKeys = new Set(
    store.getAll('appointments').map((a) => `${a.customerId}|${a.date}`)
  );

  lines.forEach((line) => {
    const colonIdx = line.indexOf(':');
    const dateStr = colonIdx === -1 ? '' : line.slice(0, colonIdx).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { skippedLines.push(line); return; }
    const names = line.slice(colonIdx + 1).split(',').map((n) => n.trim()).filter(Boolean);
    let hour = 8;
    let minute = 0;
    names.forEach((name) => {
      const customer = findCustomer(name);
      if (!customer) { unmatched.push({ date: dateStr, name }); return; }
      const key = `${customer.id}|${dateStr}`;
      if (existingKeys.has(key)) {
        alreadyScheduled.push({ date: dateStr, name, customerName: customer.name });
        return;
      }
      const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      minute += 30;
      if (minute >= 60) { minute -= 60; hour += 1; }
      const appt = store.create('appointments', {
        customerId: customer.id,
        technicianId: null,
        date: dateStr,
        startTime,
        endTime: '',
        serviceId: null,
        serviceType: 'Hot Tub Service',
        status: 'scheduled',
        notes: '',
        chlorine: '',
        ph: '',
        alkalinity: '',
        seriesId: null,
      });
      existingKeys.add(key);
      created.push({ date: dateStr, name, customerId: customer.id, customerName: customer.name, appointmentId: appt.id });
    });
  });

  res.json({
    createdCount: created.length,
    unmatchedCount: unmatched.length,
    alreadyScheduledCount: alreadyScheduled.length,
    created,
    unmatched,
    alreadyScheduled,
    skippedLines,
  });
});

// One-time cleanup: removes duplicate appointments (same customer + same date),
// keeping the earliest-created one. Safe to run any time — it's a no-op once there
// are no duplicates left. Meant to undo accidental double-imports/double-clicks.
router.post('/dedupe', (req, res) => {
  const appts = store.getAll('appointments').slice().sort((a, b) => a.id - b.id);
  const seen = new Set();
  let removed = 0;
  appts.forEach((a) => {
    const key = `${a.customerId}|${a.date}`;
    if (seen.has(key)) {
      store.remove('appointments', a.id);
      removed += 1;
    } else {
      seen.add(key);
    }
  });
  res.json({ removed });
});

// Assigns every appointment on a given date to one technician in one click — meant for
// days that were bulk-imported (or otherwise created) without a technician picked yet,
// so "who's working this day" can be decided later without editing each stop by hand.
// Reassigns either every appointment on a given day (the original behavior — just pass
// `date`), or a specific hand-picked subset of that day's appointments (pass
// `appointmentIds`, e.g. from checkboxes in the day-detail modal) — lets an admin split
// one day's jobs across two techs instead of it being all-or-nothing.
router.post('/bulk-assign-technician', (req, res) => {
  const { date, technicianId, appointmentIds } = req.body;
  if (!date && !(Array.isArray(appointmentIds) && appointmentIds.length)) {
    return res.status(400).json({ error: 'Date (or a list of appointmentIds) is required' });
  }
  const tech = technicianId ? store.getById('technicians', technicianId) : null;
  if (technicianId && !tech) return res.status(400).json({ error: 'Technician not found' });

  const appts = Array.isArray(appointmentIds) && appointmentIds.length
    ? appointmentIds.map((id) => store.getById('appointments', id)).filter(Boolean)
    : store.getAll('appointments').filter((a) => a.date === date);

  appts.forEach((a) => store.update('appointments', a.id, { technicianId: tech ? tech.id : null }));
  res.json({ date, count: appts.length, technicianName: tech ? tech.name : 'Unassigned' });
});

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// Manually send (or re-send) a text reminder for one appointment — mainly so this can be
// tested/used before a Twilio account is set up (see lib/sms.js DRY RUN mode) and so an
// admin can nudge one customer without waiting for the daily cron job.
router.post('/:id/send-reminder', async (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const customer = store.getById('customers', appt.customerId);
  if (!customer || !customer.phone) {
    return res.status(400).json({ error: 'This customer has no phone number on file' });
  }
  const body = `Hi ${customer.name}, this is High Desert Spa Service — reminder that we have you scheduled for ` +
    `${appt.serviceType || 'a visit'} on ${niceDate(appt.date)} around ${appt.startTime}. ` +
    `Reply to this number if you need to reschedule.`;
  try {
    const result = await sendSms({ to: customer.phone, body });
    const updated = store.update('appointments', req.params.id, { reminderSentAt: new Date().toISOString() });
    res.json({ ...enrich(updated), smsDryRun: !!result.dryRun });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manually send (or re-send) a "please leave us a review" text after a completed visit.
router.post('/:id/send-review-request', async (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (appt.status !== 'completed') {
    return res.status(400).json({ error: 'Only completed appointments can get a review request' });
  }
  const customer = store.getById('customers', appt.customerId);
  if (!customer || !customer.phone) {
    return res.status(400).json({ error: 'This customer has no phone number on file' });
  }
  const settings = store.getSettings();
  if (!settings.googleReviewUrl) {
    return res.status(400).json({ error: "Add your Google review link in Settings first." });
  }
  const body = `Hi ${customer.name}, thanks for choosing High Desert Spa Service! If you have a minute, ` +
    `we'd really appreciate a quick review: ${settings.googleReviewUrl}`;
  try {
    const result = await sendSms({ to: customer.phone, body });
    const updated = store.update('appointments', req.params.id, { reviewRequestSentAt: new Date().toISOString() });
    res.json({ ...enrich(updated), smsDryRun: !!result.dryRun });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/backfill-checkout-dates', (req, res) => {
  let updated = 0;
  store.getAll('appointments').forEach((a) => {
    if (a.notes === 'Auto-scheduled: guest checkout day.' && !a.checkoutDate) {
      store.update('appointments', a.id, { checkoutDate: a.date });
      updated += 1;
    }
  });
  res.json({ updated });
});

module.exports = router;
