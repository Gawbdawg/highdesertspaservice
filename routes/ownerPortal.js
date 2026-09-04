const express = require('express');
const store = require('../lib/store');
const { requireOwnerAuth, hashPassword, checkPassword, sanitizeOwner } = require('../lib/auth');
const { syncCustomerCalendar, guessLabel } = require('../lib/icalSync');
const { maybeCreateCheckoutAppointment, cancelConflictingCheckoutAppointments } = require('../lib/turnoverSchedule');
const { geocodeAddress } = require('../lib/geocode');
const { previewFrequencyPricing, maybeCreateCancellationFeeInvoice } = require('../lib/autoInvoice');
const { notifyAdminNewServiceRequest } = require('../lib/notifications');
const { generateRecurringSeries } = require('../lib/scheduleFromFrequency');
const { businessTimeToUtc } = require('../lib/timezone');
const stripe = require('../lib/stripeClient');
const ai = require('../lib/ai');
const router = express.Router();

router.use(requireOwnerAuth);

// Only properties belonging to the logged-in owner may ever be touched below.
function myProperty(req, propertyId) {
  const property = store.getById('customers', propertyId);
  if (!property || property.ownerId !== req.session.ownerId) return null;
  return property;
}

// Three property types an owner can pick: 'vacation' and 'repair' are explicit
// choices, everything else (including a blank/unrecognized value) falls back to
// 'residential' — same normalization the admin side uses in routes/owners.js.
function normalizePropertyType(type) {
  if (type === 'vacation' || type === 'repair') return type;
  return 'residential';
}

// Self-service account editing — name/email/phone/username, and optionally a new
// password. Most owner accounts start with no password at all (bulk-created from a
// contact list, logging in via emailed code instead — see routes/ownerAuth.js), so
// this doubles as "set a password for the first time" for those accounts. If a
// password is already set, changing it requires the current one: this endpoint is
// only reachable from an already-logged-in session, so without that check anyone at
// an owner's unattended, still-logged-in computer could lock them out by just
// setting a new password themselves.
router.put('/account', (req, res) => {
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) return res.status(404).json({ error: 'Account not found' });

  const { name, email, phone, username, password, currentPassword } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;

  if (username !== undefined && username !== owner.username) {
    if (username) {
      const existing = store.getAll('owners').find(
        (o) => o.id !== owner.id && (o.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }

  if (password) {
    if (owner.passwordHash) {
      if (!currentPassword || !checkPassword(currentPassword, owner.passwordHash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
    }
    updates.passwordHash = hashPassword(password);
  }

  const updated = store.update('owners', owner.id, updates);
  res.json(sanitizeOwner(updated));
});

// Lets an owner opt in/out of newsletter emails at any time, regardless of the default
// set when their account was created (e.g. from their signed waiver) — every send
// should be easy to back out of.
router.put('/newsletter-subscription', (req, res) => {
  const updated = store.update('owners', req.session.ownerId, { newsletterSubscribed: !!req.body.subscribed });
  res.json({ newsletterSubscribed: updated.newsletterSubscribed });
});

// Opt-in (default off — see owner.jobCompletionEmailsEnabled, never set true anywhere
// but here and on owner creation, which also defaults it false) toggle for a short
// email whenever one of this owner's properties gets a visit marked completed. Off by
// default because unlike the newsletter this fires per-visit, not occasionally, so an
// owner should choose it rather than start there and have to notice and turn it off.
router.put('/job-completion-emails', (req, res) => {
  const updated = store.update('owners', req.session.ownerId, { jobCompletionEmailsEnabled: !!req.body.enabled });
  res.json({ jobCompletionEmailsEnabled: updated.jobCompletionEmailsEnabled });
});

// Records that this owner has clicked through the Terms of Service gate shown on
// first login (see public/owner.js — checkSession() shows that screen instead of the
// dashboard until this has been recorded). Timestamped for a paper trail alongside
// any signed waiver collected outside the app. Agreeing also opts them into the
// newsletter — the agreement itself is the consent to receive updates, same as the
// signed paper/waiver version covers it, so this isn't a separate opt-in step. They
// can still unsubscribe afterward any time from their portal, same as anyone else.
router.post('/agree-to-terms', (req, res) => {
  const updated = store.update('owners', req.session.ownerId, {
    agreedToTerms: true,
    agreedToTermsAt: new Date().toISOString(),
    newsletterSubscribed: true,
  });
  res.json({
    agreedToTerms: updated.agreedToTerms,
    agreedToTermsAt: updated.agreedToTermsAt,
    newsletterSubscribed: updated.newsletterSubscribed,
  });
});

// Read-only catalog of upcharges an owner can ask to have included with a service
// request (e.g. grill cleaning, window spray) — managed by the admin in Settings, see
// routes/addons.js.
router.get('/addons', (req, res) => {
  res.json(store.getAll('addons').sort((a, b) => a.name.localeCompare(b.name)));
});

// Powers the "Home" tab's Ripple briefing card: next scheduled visit, pending request
// count, current balance (and whether autopay will handle it), and an AI/template
// visit summary of the most recently completed job — one call instead of the client
// piecing this together from three separate list endpoints itself. Read-only; doesn't
// touch any existing collection.
router.get('/briefing', async (req, res) => {
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  const today = new Date().toISOString().slice(0, 10);
  const appts = store.getAll('appointments').filter((a) => myPropertyIds.includes(a.customerId));

  const nextVisit = appts
    .filter((a) => a.status === 'scheduled' && a.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const lastCompleted = appts
    .filter((a) => a.status === 'completed')
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;

  const pendingRequests = store.getAll('serviceRequests')
    .filter((r) => myPropertyIds.includes(r.customerId) && r.status === 'pending').length;

  const balanceDue = store.getAll('invoices')
    // status:'bundled' invoices are excluded here — they've been rolled up into a
    // combined monthly invoice (see lib/monthlyInvoice.js) and would otherwise be
    // double-counted alongside that combined invoice's own amount.
    .filter((i) => (i.ownerId === owner.id || myPropertyIds.includes(i.customerId))
      && i.status !== 'paid' && i.status !== 'draft' && i.status !== 'bundled')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);

  let lastVisitSummary = null;
  if (lastCompleted) {
    const property = store.getById('customers', lastCompleted.customerId);
    // Owners only ever see the tech's plain notes, never the raw chemistry readings
    // (chlorine/pH/alkalinity) — those are operational numbers for office/tech use,
    // not something a property owner needs or wants a dashboard reading out to them.
    const summary = await ai.generateVisitSummary({
      notes: lastCompleted.notes || '',
    }, { forOwner: true });
    lastVisitSummary = {
      date: lastCompleted.date,
      propertyName: property ? property.name : '',
      text: summary.text,
      aiGenerated: summary.aiGenerated,
      // The tech's note verbatim, not run through AI paraphrasing — a specific
      // recommendation like "spa shocked, recommend drain and fill next service"
      // needs to reach the owner exactly as written, not softened or dropped by a
      // summarizer. Shown alongside the AI summary line in the owner portal, not
      // instead of it. Empty string (not omitted) when there's nothing on file.
      note: lastCompleted.notes || '',
    };
  }

  const briefing = await ai.generateOwnerBriefing({
    nextVisitDate: nextVisit ? nextVisit.date : null,
    pendingRequests,
    balanceDue: Math.round(balanceDue * 100) / 100,
    autopayEnabled: !!owner.autopayEnabled,
  });

  res.json({
    briefing,
    nextVisit: nextVisit ? { date: nextVisit.date, propertyName: (store.getById('customers', nextVisit.customerId) || {}).name } : null,
    pendingRequests,
    balanceDue: Math.round(balanceDue * 100) / 100,
    lastVisitSummary,
  });
});

// ---- This owner's properties ----
router.get('/properties', (req, res) => {
  const properties = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(properties);
});

// Same "can the map actually find this" pre-check the admin's Homes tab already has,
// exposed here so the owner portal's add/edit property forms can show a live status
// as the owner types, before they ever click Save. The real enforcement is in the
// create/update handlers below — this is just an early warning, same relationship as
// routes/customers.js's verify-address has to that form's actual save.
router.post('/verify-address', async (req, res) => {
  const { address } = req.body;
  if (!address || !address.trim()) return res.status(400).json({ error: 'No address given' });
  try {
    const { lat, lng, displayName } = await geocodeAddress(address);
    res.json({ found: true, lat, lng, displayName });
  } catch (err) {
    res.json({ found: false, error: err.message });
  }
});

// Nominatim (the free geocoder) doesn't have every real address indexed — a new
// street, an unofficial local spelling, or a rural address can be completely real
// and still not match. Rather than leaving an owner stuck, the portal's map lets them
// click the correct spot themselves when the automatic search fails; that sends
// manualLat/manualLng here instead. Trusted as-is and flagged with
// addressManuallyPinned so it stays distinguishable later from a geocoder-confirmed
// address (same helper the admin's routes/customers.js uses).
function isValidManualPin(manualLat, manualLng) {
  return manualLat != null && manualLng != null && !Number.isNaN(Number(manualLat)) && !Number.isNaN(Number(manualLng));
}
function applyManualPin(address, manualLat, manualLng, updates) {
  updates.lat = Number(manualLat);
  updates.lng = Number(manualLng);
  updates.geocodedAddress = address.trim();
  updates.addressVerified = true;
  updates.addressManuallyPinned = true;
}

// Lets an owner add their own property from the portal (e.g. on first login, or
// adding a second hot tub later) instead of waiting on the admin to create it —
// always attached to their own account; there's no way to pass a different ownerId
// here. An address is required and geocoded right away, same as the admin's Homes
// tab — a blank address, or one the map can't locate (and isn't manually pinned
// instead — see above), is never saved; the property only gets created once we have
// coordinates a tech can actually be routed to.
router.post('/properties', async (req, res) => {
  const { name, address, type, manualLat, manualLng } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'A property name is required' });
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'An address is required so we can find your property on the map.' });
  }

  const geo = {};
  if (isValidManualPin(manualLat, manualLng)) {
    applyManualPin(address, manualLat, manualLng, geo);
  } else {
    try {
      const { lat, lng, displayName } = await geocodeAddress(address);
      Object.assign(geo, { lat, lng, geocodedAddress: displayName, addressVerified: true, addressManuallyPinned: false });
    } catch (err) {
      return res.status(400).json({ error: `Couldn't find that address on the map (${err.message}) — double check it for typos and try again, or click the map to set the location manually.` });
    }
  }

  const property = store.create('customers', {
    name: name.trim(),
    address: address ? address.trim() : '',
    type: normalizePropertyType(type),
    ownerId: req.session.ownerId,
    email: '',
    phone: '',
    notes: '',
    icalUrl: '',
    equipment: null,
    serviceFrequency: null,
    customFrequencyDays: null,
    ...geo,
  });
  res.status(201).json(property);
});

// Lets an owner fix up a property's own name/address/type after the fact — added
// because there used to be no way to edit a property once created, only add new ones.
// That mattered in practice for exactly the type field: an owner who added a property
// as "Residential" by mistake (or whose vacation rental needs were only clear later)
// had no way to switch it to "Vacation rental" themselves — and since the iCal/booking
// calendar tab only appears for type:'vacation' properties (see onPropertyChange in
// public/owner.js), that also meant no way to ever paste in their iCal link, since the
// tab that holds that field was permanently hidden for that property.
// An address is required here too — clearing a property's address back out to blank
// is no longer allowed. Re-geocodes only if the address text actually changed (an
// unrelated name/type edit shouldn't re-run it) — and same as creation, rejects the
// save outright if the new address can't be found rather than saving it unlocated.
router.put('/properties/:id', async (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const { name, address, type, manualLat, manualLng } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'A property name is required' });
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'An address is required so we can find your property on the map.' });
  }

  const updates = {
    name: name.trim(),
    address: address.trim(),
    type: normalizePropertyType(type),
  };

  if (updates.address !== (property.address || '')) {
    if (isValidManualPin(manualLat, manualLng)) {
      applyManualPin(updates.address, manualLat, manualLng, updates);
    } else {
      try {
        const { lat, lng, displayName } = await geocodeAddress(updates.address);
        Object.assign(updates, { lat, lng, geocodedAddress: displayName, addressVerified: true, addressManuallyPinned: false });
      } catch (err) {
        return res.status(400).json({ error: `Couldn't find that address on the map (${err.message}) — double check it for typos and try again, or click the map to set the location manually.` });
      }
    }
  }

  const updated = store.update('customers', property.id, updates);
  res.json(updated);
});

// Lets an owner remove a property themselves (e.g. they sold it, or added a
// duplicate by mistake) instead of having to call in and ask the admin to do it.
// Blocked in two cases where a silent delete would lose track of something real:
//   - an upcoming ('scheduled') visit still on the calendar — a tech could show up to
//     an address that's no longer in the system, and the 24hr cancellation-fee policy
//     (see /appointments/:id/cancel above) never got a chance to apply. The owner is
//     pointed at cancelling those visits first instead.
//   - an unpaid invoice with a real balance on it — deleting the property shouldn't
//     make an unpaid bill silently unreachable. A $0 'draft' invoice doesn't count
//     (nothing owed on it yet); everything else billed against this property does,
//     whether it's already been sent or is still sitting in draft.
// Any guest-booking calendar entries (vacation properties) are removed along with the
// property — they're meaningless without it and re-sync from the owner's iCal source
// anyway, nothing is lost.
router.delete('/properties/:id', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });

  const upcomingCount = store.getAll('appointments').filter(
    (a) => a.customerId === property.id && a.status === 'scheduled'
  ).length;
  if (upcomingCount > 0) {
    return res.status(400).json({
      error: `This property has ${upcomingCount} upcoming visit${upcomingCount === 1 ? '' : 's'} scheduled — cancel ${upcomingCount === 1 ? 'it' : 'them'} first from the Services tab, then delete the property.`,
    });
  }

  const unpaidInvoices = store.getAll('invoices').filter(
    (i) => i.customerId === property.id && i.status !== 'paid' && Number(i.amount || 0) > 0
  );
  if (unpaidInvoices.length > 0) {
    return res.status(400).json({
      error: `This property has ${unpaidInvoices.length} unpaid invoice${unpaidInvoices.length === 1 ? '' : 's'} — please contact us to resolve ${unpaidInvoices.length === 1 ? 'it' : 'them'} before deleting.`,
    });
  }

  store.getAll('bookings').filter((b) => b.customerId === property.id).forEach((b) => store.remove('bookings', b.id));
  store.remove('customers', property.id);
  res.status(204).end();
});

// Repair-type properties get the same recurring "set up my regular service" option
// residential properties have (unlike vacation, which is always fully blocked below) —
// but since ongoing maintenance isn't really the point of a repair account, they also
// get this explicit on/off switch to decline it if they'd rather just be called for
// one-off repairs. Checked by service-setup/schedule-service/service-frequency below
// so the block holds even if something bypasses the portal UI.
router.put('/properties/:id/maintenance-opt-out', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const updated = store.update('customers', property.id, { maintenanceOptOut: !!req.body.optOut });
  res.json({ maintenanceOptOut: updated.maintenanceOptOut });
});

// Pricing preview + current frequency for the "set up my regular service" flow —
// lets an owner see what weekly/biweekly/every-4-weeks actually costs before picking
// one, without needing to call and ask. Not offered for vacation rentals, which get
// cleaned around guest bookings instead (see /bookings above and lib/turnoverSchedule.js),
// not on a fixed calendar frequency, or for a repair property that's opted out of
// routine maintenance via the switch above.
router.get('/properties/:id/service-setup', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (property.type === 'vacation') {
    return res.json({ available: false, reason: 'vacation' });
  }
  if (property.maintenanceOptOut) {
    return res.json({ available: false, reason: 'optedOut' });
  }
  const service = store.getAll('services').find((s) => s.pricingMode === 'frequency');
  if (!service) {
    return res.json({ available: false, reason: 'no-service' });
  }
  const pricing = previewFrequencyPricing(service, req.session.ownerId);
  const today = new Date().toISOString().slice(0, 10);
  const hasUpcoming = store.getAll('appointments')
    .some((a) => a.customerId === property.id && a.status === 'scheduled' && a.date >= today);
  res.json({
    available: true,
    serviceName: service.name,
    currentFrequency: property.serviceFrequency || null,
    hasUpcomingVisits: hasUpcoming,
    ...pricing,
  });
});

// Owner self-service version of the admin's "Schedule recurring visits" action: pick
// a frequency, see the price (via the endpoint above), pick a start date, and the
// actual recurring series gets created on the calendar right away — no back-and-forth
// needed to get set up. Blocks re-running this if the property already has upcoming
// scheduled visits, so an owner can't accidentally double-book their own calendar by
// submitting this more than once; changing an already-running schedule goes through
// the admin instead, since it may need to account for visits already in progress.
router.post('/properties/:id/schedule-service', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (property.type === 'vacation') {
    return res.status(400).json({ error: 'Vacation properties are scheduled automatically around your guest bookings instead.' });
  }
  if (property.maintenanceOptOut) {
    return res.status(400).json({ error: "This property has opted out of routine maintenance service — turn that off first if you'd like to set up a regular schedule." });
  }
  const { frequency, startDate } = req.body;
  if (!['weekly', 'biweekly', 'every4weeks'].includes(frequency)) {
    return res.status(400).json({ error: 'Choose a valid frequency.' });
  }
  if (!startDate) {
    return res.status(400).json({ error: 'Pick a start date.' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const hasUpcoming = store.getAll('appointments')
    .some((a) => a.customerId === property.id && a.status === 'scheduled' && a.date >= today);
  if (hasUpcoming) {
    return res.status(400).json({ error: 'This property already has upcoming visits scheduled — contact us if you need to change your schedule.' });
  }
  const service = store.getAll('services').find((s) => s.pricingMode === 'frequency');
  store.update('customers', property.id, { serviceFrequency: frequency });
  const updated = store.getById('customers', property.id);
  const result = generateRecurringSeries(updated, {
    startDate,
    startTime: '09:00',
    technicianId: null,
    serviceId: service ? service.id : null,
  });
  res.status(201).json(result);
});

// Lets an owner change a frequency they've already set, rather than having to contact
// the business — replaces this property's future, not-yet-completed visits with a
// freshly generated series at the new frequency/start date. Deliberately leaves alone
// anything already completed (so billing/photo history for past jobs is untouched) or
// already cancelled. Removes the old future appointments outright rather than routing
// through the cancellation-fee flow (see /appointments/:id/cancel) — this is the owner
// adjusting their own standing schedule, not backing out of a specific confirmed visit
// on short notice, so no fee applies.
router.put('/properties/:id/service-frequency', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (property.type === 'vacation') {
    return res.status(400).json({ error: 'Vacation properties are scheduled automatically around your guest bookings instead.' });
  }
  if (property.maintenanceOptOut) {
    return res.status(400).json({ error: "This property has opted out of routine maintenance service — turn that off first if you'd like to set up a regular schedule." });
  }
  const { frequency, startDate } = req.body;
  if (!['weekly', 'biweekly', 'every4weeks'].includes(frequency)) {
    return res.status(400).json({ error: 'Choose a valid frequency.' });
  }
  if (!startDate) {
    return res.status(400).json({ error: 'Pick a start date.' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const toRemove = store.getAll('appointments')
    .filter((a) => a.customerId === property.id && a.status === 'scheduled' && a.date >= today);
  toRemove.forEach((a) => store.remove('appointments', a.id));

  const service = store.getAll('services').find((s) => s.pricingMode === 'frequency');
  store.update('customers', property.id, { serviceFrequency: frequency });
  const updated = store.getById('customers', property.id);
  const result = generateRecurringSeries(updated, {
    startDate,
    startTime: '09:00',
    technicianId: null,
    serviceId: service ? service.id : null,
  });
  res.status(200).json({ ...result, removed: toRemove.length });
});

// Read-only view of scheduled/completed service visits across all of this owner's
// properties — the actual jobs the admin/tech has on the calendar, not the booking
// dates or requests the owner enters themselves. Defaults to upcoming + recent (last
// 30 days) so the list doesn't grow forever; ?all=1 returns full history.
router.get('/appointments', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  let appts = store.getAll('appointments').filter((a) => myPropertyIds.includes(a.customerId) && a.status !== 'cancelled');
  if (!req.query.all) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    appts = appts.filter((a) => a.date >= cutoffStr);
  }
  const enriched = appts
    .map((a) => {
      const property = store.getById('customers', a.customerId);
      return {
        id: a.id,
        date: a.date,
        startTime: a.startTime,
        status: a.status,
        serviceType: a.serviceType,
        propertyId: a.customerId,
        propertyName: property ? property.name : 'Unknown property',
        addons: a.addons || [],
        photos: (a.photos || []).map((p) => ({ id: p.id, type: p.type, url: p.url })),
        // The tech's own note for this visit, verbatim — e.g. "spa shocked,
        // recommend drain and fill next service." Only surfaced once a visit is
        // completed. Chemistry readings are deliberately never included here — same
        // office-only boundary as the Home tab's briefing card.
        note: a.status === 'completed' ? (a.notes || '') : '',
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  res.json(enriched);
});

// Only appointments on one of this owner's own properties, and only while the visit
// is still upcoming (not yet completed), can have extras added or removed.
function myUpcomingAppointment(req, apptId) {
  const appt = store.getById('appointments', apptId);
  if (!appt || !myProperty(req, appt.customerId)) return null;
  if (appt.status !== 'scheduled') return null;
  return appt;
}

router.post('/appointments/:id/addons', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });
  const addon = store.getById('addons', req.body.addonId);
  if (!addon) return res.status(404).json({ error: 'Upcharge not found' });
  const existing = appt.addons || [];
  if (existing.some((a) => a.id === addon.id)) return res.json({ addons: existing });
  const addons = [...existing, { id: addon.id, name: addon.name, price: addon.price }];
  const updated = store.update('appointments', req.params.id, { addons });
  res.json({ addons: updated.addons });
});

router.delete('/appointments/:id/addons/:addonId', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });
  const addons = (appt.addons || []).filter((a) => String(a.id) !== req.params.addonId);
  const updated = store.update('appointments', req.params.id, { addons });
  res.json({ addons: updated.addons });
});

// Cancellation policy: cancelling with 24+ hours' notice is free; cancelling less than
// 24 hours before the scheduled visit bills half of what that visit would have cost
// (see lib/autoInvoice.js#maybeCreateCancellationFeeInvoice). Only an upcoming
// ('scheduled') visit on one of the owner's own properties can be cancelled this way —
// already-completed or already-cancelled visits are untouched.
router.post('/appointments/:id/cancel', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });

  // businessTimeToUtc pins the appointment's date/time to the shop's own timezone
  // (Pacific) rather than whatever timezone this server process happens to be running
  // in (UTC on Render) — otherwise this decision can disagree with the browser's
  // own estimate of "is this within 24 hours," which runs in the owner's local time.
  const visitDateTime = businessTimeToUtc(appt.date, appt.startTime);
  const hoursUntilVisit = (visitDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
  const withinCancellationWindow = hoursUntilVisit < 24;

  const updated = store.update('appointments', req.params.id, { status: 'cancelled' });
  const feeInvoice = withinCancellationWindow ? maybeCreateCancellationFeeInvoice(updated) : null;

  res.json({
    cancelled: true,
    feeCharged: !!feeInvoice,
    feeAmount: feeInvoice ? feeInvoice.amount : 0,
  });
});

// Rescheduling follows the same 24-hour policy as cancelling: moving a visit with
// 24+ hours' notice is free, moving it less than 24 hours before its currently
// scheduled time bills half the service price. From the day's route perspective, a
// visit that gets pulled off today's schedule at the last minute is exactly as
// disruptive whether the owner cancelled it outright or just moved it to another day
// — so this reuses maybeCreateCancellationFeeInvoice with wording that matches what
// actually happened. Only an upcoming ('scheduled') visit on one of the owner's own
// properties can be moved this way.
router.post('/appointments/:id/move', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });

  const { date } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid new date is required' });
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  if (date < todayStr) {
    return res.status(400).json({ error: 'New date cannot be in the past' });
  }
  if (date === appt.date) {
    return res.status(400).json({ error: "That's already this visit's scheduled date" });
  }

  // Same timezone-safe hours-until-visit check as /appointments/:id/cancel above,
  // computed against the OLD date/time — that's the slot actually being given up.
  const visitDateTime = businessTimeToUtc(appt.date, appt.startTime);
  const hoursUntilVisit = (visitDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
  const withinCancellationWindow = hoursUntilVisit < 24;

  // See routes/appointments.js's PUT /:id for why this backfill exists — an
  // appointment auto-scheduled before the checkoutDate field existed has nothing
  // stopping the next iCal resync from recreating a duplicate right back on the date
  // it's about to be moved away from, unless this freezes that date in now.
  const moveUpdates = { date };
  if (!appt.checkoutDate) moveUpdates.checkoutDate = appt.date;
  const updated = store.update('appointments', req.params.id, moveUpdates);
  const feeInvoice = withinCancellationWindow
    ? maybeCreateCancellationFeeInvoice(
        updated,
        `Reschedule fee — visit moved to a new date within 24 hours of its original scheduled time (50% of the service price).`
      )
    : null;

  res.json({
    moved: true,
    newDate: updated.date,
    feeCharged: !!feeInvoice,
    feeAmount: feeInvoice ? feeInvoice.amount : 0,
  });
});

// ---- Occupied / guest-booking date ranges (scoped to one of this owner's properties) ----
router.get('/bookings', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  let bookings = store.getAll('bookings').filter((b) => myPropertyIds.includes(b.customerId));
  if (req.query.propertyId) bookings = bookings.filter((b) => b.customerId === Number(req.query.propertyId));
  bookings = bookings.sort((a, b) => a.startDate.localeCompare(b.startDate));
  res.json(bookings);
});

router.post('/bookings', (req, res) => {
  const { propertyId, startDate, endDate, notes, type } = req.body;
  if (!propertyId || !startDate || !endDate) {
    return res.status(400).json({ error: 'propertyId, startDate and endDate are required' });
  }
  if (!myProperty(req, propertyId)) return res.status(404).json({ error: 'Property not found' });
  // 'block' is kept as a calendar label for the owner's own reference (e.g. a
  // renovation) — it no longer changes scheduling in any way: every property still
  // gets its regular service on schedule whether it's marked blocked, occupied, or
  // empty. (A block used to auto-cancel anything scheduled inside it; that's been
  // removed — service should never be skipped just because a property is blocked.)
  const bookingType = type === 'block' ? 'block' : 'guest';
  const booking = store.create('bookings', {
    customerId: Number(propertyId),
    startDate,
    endDate,
    notes: notes || '',
    source: 'manual',
    type: bookingType,
  });
  maybeCreateCheckoutAppointment(Number(propertyId), endDate);
  // This new booking might reveal that some OTHER already-scheduled turnover cleaning
  // for this property now falls on a day it turns out a guest is still there (e.g. this
  // manually-entered stay overlaps one already on the calendar) — see
  // lib/turnoverSchedule.js#cancelConflictingCheckoutAppointments.
  cancelConflictingCheckoutAppointments(Number(propertyId));
  res.status(201).json(booking);
});

router.delete('/bookings/:id', (req, res) => {
  const booking = store.getById('bookings', req.params.id);
  if (!booking || !myProperty(req, booking.customerId)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  store.remove('bookings', req.params.id);
  res.status(204).end();
});

// ---- Requested service dates (scoped to one of this owner's properties) ----
router.get('/service-requests', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  const requests = store.getAll('serviceRequests')
    .filter((r) => myPropertyIds.includes(r.customerId))
    .map((r) => {
      const property = store.getById('customers', r.customerId);
      return { ...r, propertyName: property ? property.name : 'Unknown property' };
    })
    .sort((a, b) => a.requestedDate.localeCompare(b.requestedDate));
  res.json(requests);
});

router.post('/service-requests', (req, res) => {
  const { propertyId, requestedDate, notes, addonIds } = req.body;
  if (!propertyId || !requestedDate) {
    return res.status(400).json({ error: 'propertyId and requestedDate are required' });
  }
  const property = myProperty(req, propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  // Snapshot the chosen upcharges' name/price at request time, same as everywhere else
  // addons are attached — so a later catalog price change doesn't change what was asked
  // for. Carried onto the appointment automatically when an admin schedules this request
  // (see routes/appointments.js and public/app.js's scheduleRequest).
  const catalog = store.getAll('addons');
  const addons = (Array.isArray(addonIds) ? addonIds : [])
    .map((id) => catalog.find((a) => a.id === Number(id)))
    .filter(Boolean)
    .map((a) => ({ id: a.id, name: a.name, price: a.price }));
  const request = store.create('serviceRequests', {
    customerId: Number(propertyId),
    requestedDate,
    notes: notes || '',
    status: 'pending',
    addons,
  });
  const owner = store.getById('owners', req.session.ownerId);
  notifyAdminNewServiceRequest({
    ownerName: owner ? owner.name : null,
    propertyName: property.name,
    requestedDate,
    notes: notes || '',
  });
  res.status(201).json(request);
});

router.delete('/service-requests/:id', (req, res) => {
  const request = store.getById('serviceRequests', req.params.id);
  if (!request || !myProperty(req, request.customerId) || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found or already handled' });
  }
  store.remove('serviceRequests', req.params.id);
  res.status(204).end();
});

// ---- Autopay: save a card, get billed automatically instead of manually paying each
// invoice — for weekly/biweekly/monthly clients this means no more chasing invoices
// down each time a job's done. Off by default; the owner turns it on/off here any time.
// The actual charging happens elsewhere (lib/autopay.js, called from every place a new
// invoice gets created) — this file just handles saving/removing the card itself.

// Kicks off Stripe's hosted "save a card" flow: creates a Stripe Customer for this
// owner if they don't have one yet (reused on every future setup attempt, e.g. if they
// disable and re-enable autopay later, or the card on file expires), then a Checkout
// Session in mode:'setup' pointed at it. No charge happens on this page — it only
// collects and saves card details. ownerId travels in the session's metadata so
// routes/stripeWebhook.js knows whose account to turn autopay on for once it's done.
router.post('/autopay/start', async (req, res) => {
  if (!stripe.isConfigured()) {
    return res.status(400).json({ error: "Online payments aren't turned on yet — ask the office to set up Stripe first." });
  }
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });

  try {
    let stripeCustomerId = owner.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.createCustomer({
        email: owner.email,
        name: owner.name,
        metadata: { ownerId: String(owner.id) },
      });
      stripeCustomerId = customer.id;
      store.update('owners', owner.id, { stripeCustomerId });
    }

    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.createSetupCheckoutSession({
      customerId: stripeCustomerId,
      successUrl: `${origin}/owner?autopay=success`,
      cancelUrl: `${origin}/owner?autopay=cancelled`,
      metadata: { ownerId: String(owner.id) },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Turns autopay off and forgets the saved card. Detaching the PaymentMethod from
// Stripe (not just clearing our own fields) is a best-effort courtesy so it also drops
// off the owner's saved-cards list on Stripe's side — if that call fails for any reason
// (already detached, network hiccup) autopay still gets turned off locally either way,
// since that's the part that actually stops future charges.
router.post('/autopay/cancel', async (req, res) => {
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });

  if (owner.stripePaymentMethodId && stripe.isConfigured()) {
    try {
      await stripe.detachPaymentMethod(owner.stripePaymentMethodId);
    } catch (err) {
      console.warn(`Could not detach payment method for owner #${owner.id}: ${err.message}`);
    }
  }

  const updated = store.update('owners', owner.id, {
    autopayEnabled: false,
    stripePaymentMethodId: null,
    autopayCardBrand: null,
    autopayCardLast4: null,
  });
  res.json({ autopayEnabled: updated.autopayEnabled });
});

// ---- iCal calendar auto-sync (per property) ----

// Kept as-is for anything still calling it, but properties.icalUrls (below) is what
// the owner portal UI actually uses now — a property can have more than one calendar
// link (e.g. separate Airbnb and VRBO listings that don't sync with each other).
router.put('/properties/:id/ical-url', (req, res) => {
  if (!myProperty(req, req.params.id)) return res.status(404).json({ error: 'Property not found' });
  const { icalUrl } = req.body;
  const updated = store.update('customers', req.params.id, { icalUrl: icalUrl || '' });
  res.json({ icalUrl: updated.icalUrl });
});

// Replaces the whole calendar-link list for a property in one go (that's how the
// owner portal's "Save & sync now" button works — it always sends the full current
// list). Assigns a stable id to any row that doesn't already have one, so a booking
// synced from a given link can be traced back to it (and so overlap detection in
// lib/icalSync.js can tell "two different platforms" from "the same platform twice").
router.put('/properties/:id/ical-urls', (req, res) => {
  if (!myProperty(req, req.params.id)) return res.status(404).json({ error: 'Property not found' });
  const { icalUrls } = req.body;
  if (!Array.isArray(icalUrls)) return res.status(400).json({ error: 'icalUrls must be an array' });
  let nextId = Date.now();
  const cleaned = icalUrls
    .map((row) => ({
      id: row && row.id ? row.id : nextId++,
      url: row && row.url ? String(row.url).trim() : '',
      label: row && row.label && String(row.label).trim() ? String(row.label).trim() : guessLabel(row && row.url),
    }))
    .filter((row) => row.url);
  const updated = store.update('customers', req.params.id, { icalUrls: cleaned });
  res.json({ icalUrls: updated.icalUrls });
});

router.post('/properties/:id/sync-calendar', async (req, res) => {
  if (!myProperty(req, req.params.id)) return res.status(404).json({ error: 'Property not found' });
  try {
    const result = await syncCustomerCalendar(Number(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
