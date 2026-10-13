const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeCustomer } = require('../lib/auth');
const { geocodeAddress } = require('../lib/geocode');
const { makeCustomerMatcher } = require('../lib/customerMatch');
const { generateRecurringSeries } = require('../lib/scheduleFromFrequency');
const { resyncDraftInvoicesForCustomer } = require('../lib/autoInvoice');
const { syncCustomerCalendar } = require('../lib/icalSync');
const router = express.Router();

// Creates a brand-new owner account and returns its id — used when an admin links
// a property to an owner that doesn't exist yet, all in one save.
function createOwnerAccount({ name, email, phone, username, password }) {
  if (username) {
    const existing = store.getAll('owners').find((o) => (o.username || '').toLowerCase() === username.toLowerCase());
    if (existing) throw new Error('That username is already taken');
  }
  const owner = store.create('owners', {
    name: name || '',
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
    newsletterSubscribed: true,
  });
  return owner.id;
}

function withOwnerName(customer) {
  const owner = customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  return { ...sanitizeCustomer(customer), ownerName: owner ? owner.name : null };
}

// For the Homes list: how much recurring service each home has on the books. "Recurring"
// means appointments that belong to a series (seriesId set — made by "Schedule recurring
// visits", an owner setting their frequency, or a recurring booking). Counts only what is
// still ahead: scheduled (not cancelled/completed) visits dated today or later, in the
// business's own timezone. seriesCount = how many separate recurring series are still
// running; upcomingCount = total remaining visits across them.
function recurringSummaryByCustomer() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const byCustomer = {};
  store.getAll('appointments').forEach((a) => {
    if (!a.seriesId || a.status !== 'scheduled' || !a.date || a.date < today) return;
    const s = byCustomer[a.customerId] || (byCustomer[a.customerId] = { series: new Set(), upcomingCount: 0, nextDate: null });
    s.series.add(a.seriesId);
    s.upcomingCount += 1;
    if (!s.nextDate || a.date < s.nextDate) s.nextDate = a.date;
  });
  return byCustomer;
}

router.get('/', (req, res) => {
  const recurring = recurringSummaryByCustomer();
  res.json(store.getAll('customers').map((c) => {
    const r = recurring[c.id];
    return {
      ...withOwnerName(c),
      recurring: { seriesCount: r ? r.series.size : 0, upcomingCount: r ? r.upcomingCount : 0, nextDate: r ? r.nextDate : null },
    };
  }));
});

// One-click recovery if the live customer list ever comes back empty (e.g. a hosting
// disk got reset) — restores the built-in backup roster. No-ops if customers already exist.
router.post('/restore-seed-backup', (req, res) => {
  const result = store.restoreSeedCustomersIfEmpty();
  res.json(result);
});

// Bulk-fills in phone/email for existing customers from pasted text — one line per
// customer in the form "Name: value, value" where each value is either a phone number
// or an email (detected automatically, order doesn't matter — "555-1234, a@b.com" and
// "a@b.com, 555-1234" both work). Only fills in blank fields; never overwrites a phone
// or email that's already on file, so it's safe to paste an updated/partial list later
// without clobbering anything entered by hand since. Names are matched the same
// conservative way as the bulk appointment import — anything ambiguous is skipped and
// reported back instead of guessed at.
router.post('/bulk-update-contact', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const customers = store.getAll('customers');
  const findCustomer = makeCustomerMatcher(customers);
  const EMAIL_RE = /.+@.+\..+/;

  const updated = [];
  const unmatched = [];
  const skippedLines = [];

  text.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { skippedLines.push(line); return; }
    const name = line.slice(0, colonIdx).trim();
    const values = line.slice(colonIdx + 1).split(',').map((v) => v.trim()).filter(Boolean);
    if (!name || values.length === 0) { skippedLines.push(line); return; }

    const customer = findCustomer(name);
    if (!customer) { unmatched.push({ name }); return; }

    let phone = '';
    let email = '';
    values.forEach((v) => {
      if (EMAIL_RE.test(v)) email = v;
      else if (!phone) phone = v;
    });

    const changes = {};
    if (phone && !customer.phone) changes.phone = phone;
    if (email && !customer.email) changes.email = email;

    if (Object.keys(changes).length === 0) {
      updated.push({ name, customerName: customer.name, changed: false });
      return;
    }
    store.update('customers', customer.id, changes);
    updated.push({ name, customerName: customer.name, changed: true, ...changes });
  });

  res.json({
    updatedCount: updated.filter((u) => u.changed).length,
    unchangedCount: updated.filter((u) => !u.changed).length,
    unmatchedCount: unmatched.length,
    updated,
    unmatched,
    skippedLines,
  });
});

router.get('/:id', (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const technicians = store.getAll('technicians');
  const appointments = store.getAll('appointments')
    .filter((a) => a.customerId === customer.id)
    .map((a) => {
      const tech = a.technicianId ? technicians.find((t) => t.id === a.technicianId) : null;
      return { ...a, technicianName: tech ? tech.name : 'Unassigned' };
    })
    .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));
  const invoices = store.getAll('invoices')
    .filter((i) => i.customerId === customer.id)
    .sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''));
  res.json({ ...withOwnerName(customer), appointments, invoices });
});

// Geocodes an address without needing an existing customer record — used by the
// customer form to verify an address as it's typed, before the customer is even saved.
// Never throws a 500 for "address not found"; that's a normal, expected outcome the
// admin needs to see and act on (fix a typo, or save anyway if the address is real but
// just too new/rural for the geocoder), not a server error.
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

// Geocodes an address a home is being saved with (new home, or an existing home's
// address being changed) and requires it to actually be found — a home the geocoder
// can't locate never gets saved with that address at all, rather than being saved
// anyway with a "not located" badge for someone to notice later. An address is now
// required outright (a technician needs somewhere real to be routed to), so a blank
// address is rejected the same as an unfindable one — see the callers below, which
// check for a blank address before ever calling this. Throws on failure; callers turn
// that into a 400 rather than swallowing it. Sets the same
// lat/lng/geocodedAddress/addressVerified fields onto `updates` on success that the
// rest of the app already expects. Explicitly clears addressManuallyPinned (see
// below) since a successful automatic geocode supersedes any earlier manual pin.
async function geocodeOrThrow(address, updates) {
  const { lat, lng, displayName } = await geocodeAddress(address);
  updates.lat = lat;
  updates.lng = lng;
  updates.geocodedAddress = displayName;
  updates.addressVerified = true;
  updates.addressManuallyPinned = false;
}

// Nominatim (the free geocoder) is picky about exact spelling and doesn't have every
// real address indexed — a brand-new street, an unofficial/locally-known spelling, or
// a rural address can all be completely real and still come back "not found." Rather
// than leaving someone stuck unable to save a real home, the frontend's map lets them
// click the correct spot themselves when automatic search fails; that click sends
// manualLat/manualLng here instead of the geocoder ever running. Trusted as-is (no
// server-side verification of a human-placed pin) and flagged with
// addressManuallyPinned so it's visibly distinguishable later from a
// geocoder-confirmed address.
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

// Cleans a raw { [serviceId]: price } object the same way routes/owners.js does for
// owner-level custom pricing — drops blank/invalid entries so leaving a field empty
// means "no override at this level," not "$0."
function cleanCustomPricing(raw) {
  const cleaned = {};
  Object.entries(raw || {}).forEach(([serviceId, price]) => {
    if (price !== '' && price !== null && price !== undefined && !Number.isNaN(Number(price))) {
      cleaned[serviceId] = Number(price);
    }
  });
  return cleaned;
}

router.post('/', async (req, res) => {
  const {
    name, email, phone, address, notes, type, icalUrl, ownerId, newOwner, equipment,
    serviceFrequency, customFrequencyDays, customPricing, manualLat, manualLng, icalIgnoreBlocks,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'An address is required — every home needs a located address on file so a tech can actually be routed there.' });
  }

  let resolvedOwnerId = ownerId ? Number(ownerId) : null;
  if (newOwner && newOwner.username) {
    try {
      resolvedOwnerId = createOwnerAccount(newOwner);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const geo = {};
  if (isValidManualPin(manualLat, manualLng)) {
    applyManualPin(address, manualLat, manualLng, geo);
  } else {
    try {
      await geocodeOrThrow(address, geo);
    } catch (err) {
      return res.status(400).json({ error: `Couldn't find that address on the map (${err.message}) — double check it for typos and try again, or click the map to set the location manually.` });
    }
  }

  const customer = store.create('customers', {
    name,
    email: email || '',
    phone: phone || '',
    address: address || '',
    type: type || 'residential',
    notes: notes || '',
    icalUrl: icalUrl || '',
    icalIgnoreBlocks: !!icalIgnoreBlocks,
    ownerId: resolvedOwnerId,
    equipment: equipment || null,
    serviceFrequency: serviceFrequency || null,
    customFrequencyDays: customFrequencyDays ? Number(customFrequencyDays) : null,
    // This home's own per-service price overrides — take priority over the owner's
    // default custom pricing (see lib/autoInvoice.js#resolvePrice), for owners who
    // charge differently at different properties.
    customPricing: cleanCustomPricing(customPricing),
    ...geo,
  });
  res.status(201).json(withOwnerName(customer));
});

router.put('/:id', async (req, res) => {
  const updates = { ...req.body };
  const newOwner = updates.newOwner;
  const manualLat = updates.manualLat;
  const manualLng = updates.manualLng;
  delete updates.newOwner;
  delete updates.manualLat;
  delete updates.manualLng;

  if (newOwner && newOwner.username) {
    try {
      updates.ownerId = createOwnerAccount(newOwner);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else if (updates.ownerId !== undefined) {
    updates.ownerId = updates.ownerId ? Number(updates.ownerId) : null;
  }
  if (updates.customFrequencyDays !== undefined) {
    updates.customFrequencyDays = updates.customFrequencyDays ? Number(updates.customFrequencyDays) : null;
  }
  if (updates.customPricing !== undefined) {
    updates.customPricing = cleanCustomPricing(updates.customPricing);
  }

  // Address is required, and re-geocoded right away whenever it's actually being
  // changed here — rather than saving a typo/bad address with a "not located" badge
  // for someone to notice later (or worse, a tech getting routed to the wrong place).
  // A blank address is rejected outright now too, even on a home that already had one
  // (no more clearing it back out to blank). Only checked when the address field is
  // actually present in this edit — an existing home with an already-bad address on
  // file isn't retroactively blocked from an unrelated edit (phone number, notes,
  // etc.) that doesn't touch the address at all; that cleanup path is Settings →
  // "Geocode all addresses".
  const existing = store.getById('customers', req.params.id);
  if (updates.address !== undefined) {
    if (!updates.address || !updates.address.trim()) {
      return res.status(400).json({ error: 'An address is required — every home needs a located address on file so a tech can actually be routed there.' });
    }
    if (!existing || updates.address !== existing.address) {
      if (isValidManualPin(manualLat, manualLng)) {
        applyManualPin(updates.address, manualLat, manualLng, updates);
      } else {
        try {
          await geocodeOrThrow(updates.address, updates);
        } catch (err) {
          return res.status(400).json({ error: `Couldn't find that address on the map (${err.message}) — double check it for typos and try again, or click the map to set the location manually.` });
        }
      }
    }
  }

  if (updates.icalIgnoreBlocks !== undefined) updates.icalIgnoreBlocks = !!updates.icalIgnoreBlocks;
  const updated = store.update('customers', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Customer not found' });
  // Flipping "ignore blocked dates for cleanings" should show up right away (cancelling
  // cleanings that only came from blocks) instead of waiting for the next hourly sync.
  if (updates.icalIgnoreBlocks !== undefined && !!(existing && existing.icalIgnoreBlocks) !== updates.icalIgnoreBlocks
      && ((updated.icalUrls || []).length || updated.icalUrl)) {
    syncCustomerCalendar(updated.id).catch((err) => console.error('[ical] resync after block setting change failed:', err.message));
  }
  // A changed home-level price shouldn't leave already-completed-but-still-draft jobs
  // stuck showing the old number — see lib/autoInvoice.js#resyncDraftInvoicesForCustomer.
  if (updates.customPricing !== undefined) {
    resyncDraftInvoicesForCustomer(Number(req.params.id));
  }
  res.json(withOwnerName(updated));
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('customers', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Customer not found' });
  res.status(204).end();
});

// Geocode one property's address (used both individually and in a client-driven
// loop for "Geocode all addresses", which paces itself to respect Nominatim's
// 1-request/second usage policy rather than firing everything from the server at once).
router.post('/:id/geocode', async (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.address) return res.status(400).json({ error: 'No address on file' });
  try {
    const { lat, lng, displayName } = await geocodeAddress(customer.address);
    const updated = store.update('customers', req.params.id, { lat, lng, geocodedAddress: displayName, addressVerified: true });
    res.json(withOwnerName(updated));
  } catch (err) {
    store.update('customers', req.params.id, { addressVerified: false });
    res.status(400).json({ error: err.message });
  }
});

// Turns a customer's saved service frequency (Weekly / Every 2 weeks / Every 4 weeks /
// Custom) directly into an actual recurring appointment series on the calendar —
// otherwise that setting only pre-fills the "Repeats" dropdown the next time someone
// happens to manually schedule this customer, which is easy to forget to do. Body:
// { startDate, startTime, technicianId, serviceId } — startDate/startTime required,
// the rest optional (an unassigned/no-service starter visit is still useful on its own).
router.post('/:id/schedule-recurring', (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.serviceFrequency) {
    return res.status(400).json({ error: 'This home has no service frequency set — set one on the Edit Home form first.' });
  }
  const { startDate, startTime, technicianId, serviceId } = req.body;
  if (!startDate || !startTime) {
    return res.status(400).json({ error: 'startDate and startTime are required' });
  }

  const result = generateRecurringSeries(customer, { startDate, startTime, technicianId, serviceId });
  res.status(201).json(result);
});

module.exports = router;
