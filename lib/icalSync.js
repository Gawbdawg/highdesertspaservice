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

// Fetches and parses one customer's iCal feed, replacing their previously
// auto-synced bookings (source: 'ical') with the fresh set. Manually-entered
// bookings (source: 'manual', or missing — i.e. older data) are left alone.
async function syncCustomerCalendar(customerId) {
  const customer = store.getById('customers', customerId);
  if (!customer) throw new Error('Customer not found');
  if (!customer.icalUrl) throw new Error('No iCal URL set for this customer');

  const res = await fetch(customer.icalUrl);
  if (!res.ok) throw new Error(`Could not fetch calendar (HTTP ${res.status})`);
  const text = await res.text();

  const parsed = ical.sync.parseICS(text);
  const events = Object.values(parsed).filter((e) => e.type === 'VEVENT' && e.start && e.end);

  // Remove this customer's previous auto-synced bookings before adding the fresh set
  const existing = store.getAll('bookings').filter((b) => b.customerId === customerId && b.source === 'ical');
  existing.forEach((b) => store.remove('bookings', b.id));

  let created = 0;
  events.forEach((e) => {
    const endDate = toDateStr(e.end);
    store.create('bookings', {
      customerId,
      startDate: toDateStr(e.start),
      endDate,
      notes: e.summary || '',
      source: 'ical',
    });
    created += 1;
    maybeCreateCheckoutAppointment(customerId, endDate);
  });

  store.update('customers', customerId, { icalLastSyncedAt: new Date().toISOString() });

  return { customerId, count: created };
}

// Syncs every vacation-rental customer that has an iCal URL set. Used by the
// admin "Sync all calendars" button and by the scheduled sync job.
async function syncAllCalendars() {
  const customers = store.getAll('customers').filter((c) => c.icalUrl);
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

module.exports = { syncCustomerCalendar, syncAllCalendars };
