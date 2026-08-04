const store = require('./store');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Creates a "turnover cleaning" appointment on a guest's checkout day, so a booking
// (manually entered or auto-synced from Airbnb/VRBO) actually shows up on the service
// Calendar instead of just sitting in the read-only Property Calendar view. Skips past
// checkout dates, and skips if that property already has ANY appointment that day —
// safe to call repeatedly (e.g. on every calendar sync) without creating duplicates.
function maybeCreateCheckoutAppointment(customerId, checkoutDate) {
  if (!checkoutDate || checkoutDate < todayStr()) return null;
  const already = store.getAll('appointments').some(
    (a) => a.customerId === customerId && a.date === checkoutDate
  );
  if (already) return null;
  return store.create('appointments', {
    customerId,
    technicianId: null,
    date: checkoutDate,
    startTime: '10:00',
    endTime: '',
    serviceId: null,
    serviceType: 'Turnover cleaning',
    status: 'scheduled',
    notes: 'Auto-scheduled: guest checkout day.',
    chlorine: '',
    ph: '',
    alkalinity: '',
    seriesId: null,
  });
}

// Backfill: scans every current booking (manual or synced) and schedules a checkout
// appointment for any upcoming one that doesn't have one yet. Meant to be run once
// after this feature ships (to cover bookings that already existed), and safe to
// re-run any time — it's a no-op for anything already scheduled.
function scheduleAllUpcomingCheckouts() {
  const bookings = store.getAll('bookings');
  let created = 0;
  bookings.forEach((b) => {
    const appt = maybeCreateCheckoutAppointment(b.customerId, b.endDate);
    if (appt) created += 1;
  });
  return { created, checked: bookings.length };
}

module.exports = { maybeCreateCheckoutAppointment, scheduleAllUpcomingCheckouts };
