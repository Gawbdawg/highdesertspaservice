const express = require('express');
const store = require('../lib/store');
const { requireTechAuth, sanitizeTechnician, hashPassword, checkPassword } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { geocodeAddress } = require('../lib/geocode');
const { summarizeByDay } = require('../lib/timesheet');
const { savePhoto, deletePhoto } = require('../lib/uploads');
const { syncInvoiceForCompletedAppointment } = require('../lib/autoInvoice');
const chemistry = require('../lib/chemistry');
const router = express.Router();

router.use(requireTechAuth);

// Lets a tech correct their own email/phone, and update their saved starting address
// (pre-filled next time they open Today so they don't have to retype it every
// morning, but editable any time — see POST /optimize-route below) — deliberately
// narrow, just these fields, so this can't be used to touch login credentials.
router.put('/me', (req, res) => {
  const updates = {};
  if (req.body.email !== undefined) updates.email = req.body.email;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  if (req.body.lastStartAddress !== undefined) updates.lastStartAddress = req.body.lastStartAddress;
  const updated = store.update('technicians', req.session.technicianId, updates);
  if (!updated) return res.status(404).json({ error: 'Technician not found' });
  res.json(sanitizeTechnician(updated));
});

// Self-service account editing — name/email/phone/username, and optionally a new
// password. Mirrors owners.js's PUT /account: current password is only required when
// one is already set (some techs are created by the admin with no password yet, or
// log in some other way), so this also works as "set your password for the first
// time." Kept separate from PUT /me above since /me is used by the Today screen for
// quick contact-info touch-ups and deliberately can't reach login credentials.
router.put('/account', (req, res) => {
  const tech = store.getById('technicians', req.session.technicianId);
  if (!tech) return res.status(404).json({ error: 'Account not found' });

  const { name, email, phone, username, password, currentPassword } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;

  if (username !== undefined && username !== tech.username) {
    if (username) {
      const existing = store.getAll('technicians').find(
        (t) => t.id !== tech.id && (t.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }

  if (password) {
    if (tech.passwordHash) {
      if (!currentPassword || !checkPassword(currentPassword, tech.passwordHash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
    }
    updates.passwordHash = hashPassword(password);
  }

  const updated = store.update('technicians', tech.id, updates);
  res.json(sanitizeTechnician(updated));
});

// Techs tap an upcharge on/off by name only — the price is a back-office detail set
// in Settings and stays hidden from the tech app everywhere (catalog, job list,
// add/remove responses). Only the admin dashboard and owner portal show prices.
function hideAddonPrices(addons) {
  return (addons || []).map((a) => ({ id: a.id, name: a.name }));
}
function hideApptAddonPrices(appt) {
  if (!appt) return appt;
  return { ...appt, addons: hideAddonPrices(appt.addons) };
}

// Read-only catalog of upcharges a tech can attach to a job (e.g. grill cleaning,
// window spray) — managed by the admin in Settings, see routes/addons.js.
router.get('/addons', (req, res) => {
  const catalog = store.getAll('addons').sort((a, b) => a.name.localeCompare(b.name));
  res.json(hideAddonPrices(catalog));
});

// Attaches customer/property details onto a raw appointment row — shared by every
// endpoint below that returns appointments to the tech, so the shape stays consistent.
function enrichAppt(a) {
  const customer = store.getById('customers', a.customerId);
  return {
    ...a,
    customerName: customer ? customer.name : 'Unknown customer',
    customerPhone: customer ? customer.phone : '',
    customerAddress: customer ? customer.address : '',
    customerNotes: customer ? customer.notes : '',
    customerEquipment: customer ? customer.equipment : null,
    lat: customer ? customer.lat : undefined,
    lng: customer ? customer.lng : undefined,
    addons: hideAddonPrices(a.addons),
  };
}

// Only this technician's appointments — today and upcoming by default, a specific date
// via ?date=, or every job regardless of date via ?all=1 (used by the Calendar tab,
// which needs to show past and future months, not just what's upcoming).
// Each day's stops are ordered into an efficient route from the shop when we have
// coordinates for them; days are still shown in date order.
router.get('/appointments', (req, res) => {
  const technicianId = req.session.technicianId;
  let appts = store.getAll('appointments').filter((a) => a.technicianId === technicianId);

  if (req.query.date) {
    appts = appts.filter((a) => a.date === req.query.date);
  } else if (req.query.all === '1') {
    // no date filter — the calendar paginates by month client-side
  } else {
    const today = new Date().toISOString().slice(0, 10);
    appts = appts.filter((a) => a.date >= today && a.status !== 'cancelled');
  }

  const enriched = appts.map(enrichAppt);

  const settings = store.getSettings();
  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;

  const byDate = {};
  enriched.forEach((a) => { (byDate[a.date] = byDate[a.date] || []).push(a); });

  let result = [];
  Object.keys(byDate).sort().forEach((date) => {
    const dayAppts = byDate[date];
    if (depot) {
      const { ordered, unroutable } = orderStopsByRoute(depot, dayAppts);
      result = result.concat(ordered, unroutable);
    } else {
      result = result.concat(dayAppts.sort((a, b) => a.startTime.localeCompare(b.startTime)));
    }
  });

  res.json(result);
});

// Let a technician mark their own job completed
router.put('/appointments/:id/status', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const { status } = req.body;
  if (!['scheduled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updated = store.update('appointments', req.params.id, { status });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Lets a tech log a quick water test (chlorine/pH/alkalinity) plus a short note when
// they're on site, and gets a real, deterministic dosage recommendation back in the
// same response — plain spa-chemistry math (lib/chemistry.js), not AI, so it works
// instantly with no dependency on an AI provider being configured. These are the same
// chlorine/ph/alkalinity/notes fields the admin's own appointment form has always had
// — this is just the first time a tech can write them from the field instead of an
// admin backfilling them later, which also means the admin People view's AI visit
// summaries and the owner portal's AI last-visit summary finally have real notes and
// readings to draw from instead of nothing. Deliberately separate from "mark complete"
// (below) so the fast, one-tap common case is never slowed down by this.
router.put('/appointments/:id/chemistry', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const { chlorine, ph, alkalinity, notes } = req.body;
  const updates = {};
  if (chlorine !== undefined) updates.chlorine = chlorine;
  if (ph !== undefined) updates.ph = ph;
  if (alkalinity !== undefined) updates.alkalinity = alkalinity;
  if (notes !== undefined) updates.notes = notes;
  const updated = store.update('appointments', req.params.id, updates);

  const customer = store.getById('customers', updated.customerId);
  const gallons = customer && customer.equipment ? Number(customer.equipment.capacityGallons) || undefined : undefined;
  const dosageRecommendation = chemistry.recommendDosage({
    gallons,
    freeChlorine: updated.chlorine !== '' ? updated.chlorine : undefined,
    ph: updated.ph !== '' ? updated.ph : undefined,
    alkalinity: updated.alkalinity !== '' ? updated.alkalinity : undefined,
  });

  res.json({ ...hideApptAddonPrices(updated), dosageRecommendation });
});

// Attach one upcharge/add-on to one of this technician's own jobs (e.g. tapping
// "+ Grill cleaning $10" while on site). Stores a price snapshot at add time so a later
// catalog price change never retroactively changes an already-billed job. A no-op if
// that add-on is already attached — tapping it twice doesn't double-charge.
router.post('/appointments/:id/addons', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const addon = store.getById('addons', req.body.addonId);
  if (!addon) return res.status(404).json({ error: 'Add-on not found' });
  const existing = appt.addons || [];
  if (existing.some((a) => a.id === addon.id)) return res.json(hideApptAddonPrices(appt));
  const addons = [...existing, { id: addon.id, name: addon.name, price: addon.price }];
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Attach a one-off upcharge that isn't in the catalog (e.g. "Replaced a filter, $15")
// — for whatever comes up on site that the admin hasn't pre-added to Settings. Gets a
// unique string id (rather than a catalog addon's numeric id) so it can still be
// removed individually and never collides with a real catalog entry.
router.post('/appointments/:id/addons/custom', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const name = (req.body.name || '').trim();
  const price = Number(req.body.price);
  if (!name) return res.status(400).json({ error: 'A name is required' });
  if (!price || price <= 0) return res.status(400).json({ error: 'A price greater than $0 is required' });
  const entry = { id: `custom-${Date.now()}`, name, price };
  const addons = [...(appt.addons || []), entry];
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Remove an upcharge that was added by mistake.
router.delete('/appointments/:id/addons/:addonId', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const addons = (appt.addons || []).filter((a) => String(a.id) !== req.params.addonId);
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Upload a before/after photo for one of this technician's own jobs.
// Body: { type: 'before'|'after', dataUrl: 'data:image/jpeg;base64,...' } —
// the browser resizes the image before sending, so this stays reasonably small.
router.post('/appointments/:id/photos', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const { type, dataUrl } = req.body;
  if (!['before', 'after'].includes(type)) return res.status(400).json({ error: 'type must be before or after' });
  try {
    const url = savePhoto(dataUrl);
    const photo = { id: Date.now(), type, url, uploadedAt: new Date().toISOString() };
    const photos = [...(appt.photos || []), photo];
    const updated = store.update('appointments', req.params.id, { photos });
    res.status(201).json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/appointments/:id/photos/:photoId', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const photo = (appt.photos || []).find((p) => String(p.id) === req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  deletePhoto(photo.url);
  const photos = (appt.photos || []).filter((p) => String(p.id) !== req.params.photoId);
  const updated = store.update('appointments', req.params.id, { photos });
  res.json(updated);
});

// Re-orders one day's stops (defaults to today) into an efficient route starting from
// wherever the tech is actually starting from that morning, instead of the fixed shop
// depot GET /appointments uses. Geocodes the given address fresh each time (addresses
// aren't saved/cached here since a starting point is often a home address or wherever
// last night's job ended, not a fixed place) and also saves it as this tech's
// lastStartAddress so it's pre-filled next time they open Today. Cancelled jobs are
// left out, same as the default schedule view.
router.post('/optimize-route', async (req, res) => {
  const technicianId = req.session.technicianId;
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const address = (req.body.address || '').trim();
  if (!address) return res.status(400).json({ error: 'Enter the address you\'re starting from.' });

  let start;
  try {
    start = await geocodeAddress(address);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not find that starting address.' });
  }

  const appts = store.getAll('appointments')
    .filter((a) => a.technicianId === technicianId && a.date === date && a.status !== 'cancelled')
    .map(enrichAppt);

  const { ordered, unroutable } = orderStopsByRoute({ lat: start.lat, lng: start.lng }, appts);

  store.update('technicians', technicianId, { lastStartAddress: address });

  res.json({
    date,
    start: { address, lat: start.lat, lng: start.lng, displayName: start.displayName || address },
    ordered,
    unroutable,
  });
});

// ---- Clock in / clock out + pay ----
// One row per clock-in "session" (see lib/store.js's timeEntries collection). A tech
// can clock in/out more than once in a day; hours for a day are the sum of every
// session's duration that day. The $10 gas stipend is added automatically the moment a
// tech clocks in for the day — it's tagged onto whichever entry happens to be the
// FIRST one created for that tech+date, so it's never duplicated across multiple
// clock-ins on the same day.
router.get('/time-entries', (req, res) => {
  const technicianId = req.session.technicianId;
  const days = Number(req.query.days) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const entries = store.getAll('timeEntries')
    .filter((e) => e.technicianId === technicianId && e.date >= cutoffStr)
    .sort((a, b) => (a.clockInAt < b.clockInAt ? 1 : -1));

  const openEntry = entries.find((e) => !e.clockOutAt) || null;
  const tech = store.getById('technicians', technicianId);
  const days_ = summarizeByDay(entries, () => tech);

  res.json({ entries, days: days_, openEntry, hourlyRate: tech ? (tech.hourlyRate || 0) : 0 });
});

router.post('/clock-in', (req, res) => {
  const technicianId = req.session.technicianId;
  const already = store.getAll('timeEntries').find((e) => e.technicianId === technicianId && !e.clockOutAt);
  if (already) return res.status(400).json({ error: "You're already clocked in — clock out first." });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const isFirstOfDay = !store.getAll('timeEntries').some((e) => e.technicianId === technicianId && e.date === date);

  const entry = store.create('timeEntries', {
    technicianId,
    date,
    clockInAt: now.toISOString(),
    clockOutAt: null,
    gasStipendAdded: isFirstOfDay,
  });
  res.status(201).json(entry);
});

router.post('/clock-out', (req, res) => {
  const technicianId = req.session.technicianId;
  const open = store.getAll('timeEntries').find((e) => e.technicianId === technicianId && !e.clockOutAt);
  if (!open) return res.status(400).json({ error: "You're not currently clocked in." });
  const updated = store.update('timeEntries', open.id, { clockOutAt: new Date().toISOString() });
  res.json(updated);
});

// ---- Time off (self-service day blocking) ----
// A tech can block off any number of days themselves — takes effect immediately, no
// approval step. The admin sees every technician's time off in the Technicians tab and
// can delete an entry if a conflict comes up, but nothing here prevents a job from
// being scheduled on a blocked day; it's informational, the same way an owner's booking
// calendar just shows what's occupied rather than hard-locking the admin out.
router.get('/time-off', (req, res) => {
  const technicianId = req.session.technicianId;
  const entries = store.getAll('techTimeOff')
    .filter((t) => t.technicianId === technicianId)
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json(entries);
});

router.post('/time-off', (req, res) => {
  const technicianId = req.session.technicianId;
  const { startDate, endDate, note } = req.body;
  if (!startDate) return res.status(400).json({ error: 'startDate is required' });
  const end = endDate || startDate;
  if (end < startDate) return res.status(400).json({ error: 'End date is before start date' });

  const existingDates = new Set(
    store.getAll('techTimeOff').filter((t) => t.technicianId === technicianId).map((t) => t.date)
  );

  const created = [];
  let cursor = new Date(startDate + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  // A generous cap, not a real-world limit — just stops a typo'd date range (e.g. the
  // wrong year) from silently creating thousands of rows.
  let guard = 0;
  while (cursor <= last && guard < 366) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    if (!existingDates.has(dateStr)) {
      created.push(store.create('techTimeOff', { technicianId, date: dateStr, note: note || '' }));
      existingDates.add(dateStr);
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  res.status(201).json(created);
});

router.delete('/time-off/:id', (req, res) => {
  const entry = store.getById('techTimeOff', req.params.id);
  if (!entry || entry.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Time off entry not found' });
  }
  store.remove('techTimeOff', req.params.id);
  res.status(204).end();
});

module.exports = router;
