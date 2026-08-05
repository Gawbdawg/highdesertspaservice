const ical = require('node-ical');
const store = require('./store');
const { maybeCreateCheckoutAppointment } = require('./turnoverSchedule');

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

// A property can have any number of calendar links (Airbnb, VRBO, a third platform,
// whatever) — they're stored as customer.icalUrls: [{ id, url, label }]. Older
// properties only ever had the single customer.icalUrl string field; rather than
// force a data migration, we just treat that as a one-item list here so nothing
// about an existing single-calendar property changes until the owner adds a second
// link. See routes/ownerPortal.js's PUT /properties/:id/ical-urls, which is what
// actually writes customer.icalUrls once an owner edits their calendar list.
function getIcalSources(customer) {
  if (Array.isArray(customer.icalUrls) && customer.icalUrls.length) {
    return customer.icalUrls.filter((s) => s && s.url);
  }
  if (customer.icalUrl) {
    return [{ id: 'legacy', url: customer.icalUrl, label: guessLabel(customer.icalUrl) }];
  }
  return [];
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
        conflict: false,
      });
      createdBookings.push(booking);
      maybeCreateCheckoutAppointment(customerId, endDate);
    });
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

  return {
    customerId,
    count: createdBookings.length,
    sources: bySource.map(({ source, events }) => ({ label: source.label, count: events.length })),
    failedSources: errors.map((e) => ({ label: e.source.label, error: e.error })),
    conflictCount,
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
