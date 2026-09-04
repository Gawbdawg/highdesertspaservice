const ical = require('node-ical');
const store = require('./store');
const { maybeCreateCheckoutAppointment, cancelConflictingCheckoutAppointments, cancelAppointmentsInBlock } = require('./turnoverSchedule');

function toDateStr(d) {
  // node-ical gives JS Date objects (often UTC midnight for all-day events);
  // format using UTC getters so we don't shift a day depending on server timezone.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Best-effort label guess for a calendar URL the owner pastes in, so a freshly-added
// link shows up as "Airbnb" / "VRBO" right away instead of a blank "Calendar" — they
// can always rename it themselves.
function guessLabel(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('airbnb')) return 'Airbnb';
  if (u.includes('vrbo') || u.includes('homeaway')) return 'VRBO';
  if (u.includes('booking.com')) return 'Booking.com';
  return 'Calendar';
}

// Airbnb/VRBO iCal exports mark an owner-blocked or otherwise-unavailable stretch
// with a well-known SUMMARY ("Not available", "Blocked") rather than a guest
// reservation's "Reserved" — this is also how synced-in blocks from a property's
// OTHER platform show up (e.g. a VRBO booking blocking the Airbnb calendar).
// Treat anything matching that pattern as a 'block' booking rather than a normal
// 'guest' stay, so the existing block-dates logic (propertyBlockedOn /
// cancelAppointmentsInBlock in lib/turnoverSchedule.js) applies to it automatically:
// no turnover cleaning gets scheduled for it, and any cleaning already sitting
// inside it gets cancelled. Anything unrecognized stays a normal guest booking,
// same as before this existed — a missed block just means today's behavior, but
// a false positive would silently skip a real guest's cleaning, so this stays
// conservative rather than guessing.
function inferBookingType(summary) {
  const s = (summary || '').toLowerCase();
  if (/not available|unavailable|\bblocked?\b/.test(s)) return 'block';
  return 'guest';
}

// A property can have any number of calendar links (Airbnb, VRBO, a third platform,
// whatever) — they're stored as customer.icalUrls: [{ id, url, label }]. Older
// properties only ever had the single customer.icalUrl string field; rather than
// force a data migration, we just treat that as a one-item list here so nothing
// about an existing single-calendar property changes until the owner adds a second
// link. See routes/ownerPortal.js's PUT /properties/:id/ical-urls, which is what
// actually writes customer.icalUrls once an owner edits their calendar list.
function getIcalSources(customer) {
  let sources;
  if (Array.isArray(customer.icalUrls) && customer.icalUrls.length) {
    sources = customer.icalUrls.filter((s) => s && s.url);
  } else if (customer.icalUrl) {
    sources = [{ id: 'legacy', url: customer.icalUrl, label: guessLabel(customer.icalUrl) }];
  } else {
    sources = [];
  }
  // The exact same calendar URL pasted under two different link entries (easy to do
  // by accident — e.g. re-adding the Airbnb link because the owner wasn't sure it was
  // already there) would otherwise double-sync every stay on it: two duplicate
  // bookings for the same real stay, each one incorrectly flagged as overlapping/
  // conflicting with the other even though there's no actual double-booking, just a
  // calendar link listed twice. Keep only the first entry for each distinct URL.
  const seenUrls = new Set();
  return sources.filter((s) => {
    const key = s.url.trim().toLowerCase();
    if (seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
}

// Two [start, end) date ranges overlap if each starts before the other ends.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Fetches and parses one customer's iCal feed(s), replacing their previously
// auto-synced bookings (source: 'ical') with the fresh merged set. Manually-entered
// bookings (source: 'manual', or missing — i.e. older data) are left alone.
//
// When a property has more than one calendar (e.g. Airbnb + VRBO, listed separately
// because the owner has no way to sync those platforms' calendars with each other),
// we pull all of them and flag any bookings whose dates overlap across two different
// sources as a likely double-booking — that's the actual risk of running unsynced
// calendars, and surfacing it here is the next best thing to true two-way sync
// (which would require a channel-manager integration or platform API access, not
// just a read-only iCal export link).
async function syncCustomerCalendar(customerId) {
  const customer = store.getById('customers', customerId);
  if (!customer) throw new Error('Customer not found');
  const sources = getIcalSources(customer);
  if (!sources.length) throw new Error('No iCal URL set for this customer');

  const bySource = [];
  const errors = [];
  for (const source of sources) {
    try {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const parsed = ical.sync.parseICS(text);
      const events = Object.values(parsed).filter((e) => e.type === 'VEVENT' && e.start && e.end);
      bySource.push({ source, events });
    } catch (err) {
      errors.push({ source, error: err.message });
    }
  }

  // If every single source failed (e.g. the one-and-only link is broken), surface
  // that as a real error same as before. If only some failed, sync what we got —
  // a stale VRBO link shouldn't block Airbnb dates from coming in.
  if (bySource.length === 0 && errors.length) {
    throw new Error(`Could not fetch calendar (${errors[0].error})`);
  }

  // Remove this customer's previous auto-synced bookings before adding the fresh set
  const existing = store.getAll('bookings').filter((b) => b.customerId === customerId && b.source === 'ical');
  existing.forEach((b) => store.remove('bookings', b.id));

  const createdBookings = [];
  bySource.forEach(({ source, events }) => {
    events.forEach((e) => {
      const endDate = toDateStr(e.end);
      const startDate = toDateStr(e.start);
      const booking = store.create('bookings', {
        customerId,
        startDate,
        endDate,
        notes: e.summary || '',
        source: 'ical',
        icalSourceId: source.id,
        icalSourceLabel: source.label || guessLabel(source.url),
        type: inferBookingType(e.summary),
        conflict: false,
      });
      createdBookings.push(booking);
    });
  });

  // Only now that every booking from every source this sync found is already saved
  // do we decide which checkout dates to schedule a cleaning for. guestPresentOn
  // (inside maybeCreateCheckoutAppointment) only sees bookings already in the store,
  // so deciding this per-event as each one was created — the previous behavior — meant
  // the answer depended on the order the calendar feed's events happened to parse in
  // (not guaranteed). If a short overlapping calendar entry got processed before the
  // real, longer stay it overlaps, guestPresentOn couldn't yet see that longer stay
  // and would wrongly schedule a cleaning near the guest's arrival — the retroactive
  // cancelConflictingCheckoutAppointments call below would clean it up a moment later,
  // but it's better not to create the spurious appointment (and the churn of
  // immediately cancelling it) in the first place.
  createdBookings.forEach((b) => {
    if (b.type === 'block') {
      // An owner-declared (or cross-platform-synced) block means nobody's there at
      // all — not a guest checkout to schedule a cleaning for, and any cleaning
      // that's already sitting inside this range shouldn't be either.
      cancelAppointmentsInBlock(customerId, b.startDate, b.endDate, b.notes);
    } else {
      maybeCreateCheckoutAppointment(customerId, b.endDate);
    }
  });

  // Flag pairs of bookings from *different* sources whose dates overlap — same
  // source overlapping itself just means one platform listed a stay twice, which
  // isn't a double-booking risk worth flagging.
  let conflictCount = 0;
  for (let i = 0; i < createdBookings.length; i++) {
    for (let j = i + 1; j < createdBookings.length; j++) {
      const a = createdBookings[i];
      const b = createdBookings[j];
      if (a.icalSourceId === b.icalSourceId) continue;
      if (rangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)) {
        if (!a.conflict) { store.update('bookings', a.id, { conflict: true }); a.conflict = true; conflictCount += 1; }
        if (!b.conflict) { store.update('bookings', b.id, { conflict: true }); b.conflict = true; conflictCount += 1; }
      }
    }
  }

  store.update('customers', customerId, { icalLastSyncedAt: new Date().toISOString() });

  // Now that this property's full, current set of bookings is in place, catch any
  // already-scheduled turnover cleaning that a newly-synced (or newly-conflicting)
  // booking reveals lands on a day a guest is actually still there.
  const cancelledConflictingCleanings = cancelConflictingCheckoutAppointments(customerId);

  return {
    customerId,
    count: createdBookings.length,
    sources: bySource.map(({ source, events }) => ({ label: source.label, count: events.length })),
    failedSources: errors.map((e) => ({ label: e.source.label, error: e.error })),
    conflictCount,
    cancelledConflictingCleanings,
  };
}

// Syncs every vacation-rental customer that has at least one iCal URL set. Used by
// the admin "Sync all calendars" button and by the scheduled sync job.
async function syncAllCalendars() {
  const customers = store.getAll('customers').filter((c) => getIcalSources(c).length > 0);
  const results = [];
  for (const c of customers) {
    try {
      const r = await syncCustomerCalendar(c.id);
      results.push({ ...r, customerName: c.name, ok: true });
    } catch (err) {
      results.push({ customerId: c.id, customerName: c.name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { syncCustomerCalendar, syncAllCalendars, getIcalSources, guessLabel };
