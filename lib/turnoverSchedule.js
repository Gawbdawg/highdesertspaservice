const store = require('./store');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// True if some OTHER booking on this property actually occupies `date` — i.e. a guest
// checked in before `date` and hasn't checked out by it yet (start strictly before,
// end strictly after). Deliberately does NOT count a booking that merely STARTS on
// `date` — a new guest arriving the same afternoon a previous one checks out is the
// normal, expected back-to-back turnover this whole feature exists for, not a
// conflict. This only catches a guest who is genuinely still there through `date`
// (e.g. two overlapping calendars describing the same stretch of dates), which is
// exactly the situation the iCal sync's `conflict` flag also exists to surface.
function guestPresentOn(customerId, date) {
  return store.getAll('bookings').some(
    (b) => b.customerId === customerId && b.startDate < date && date < b.endDate
  );
}

// Creates a "turnover cleaning" appointment on a guest's checkout day, so a booking
// (manually entered or auto-synced from Airbnb/VRBO) actually shows up on the service
// Calendar instead of just sitting in the read-only Property Calendar view. Skips past
// checkout dates, skips if a guest is genuinely still on the property that day per some
// other booking (see guestPresentOn) — a cleaning should never land on a day someone's
// actually staying, only on an actual checkout (or a normal same-day turnover between
// guests). A "block" booking is deliberately NOT treated as a reason to skip
// scheduling — every property still gets its regular service on schedule regardless
// of whether it's marked blocked, occupied, or empty; "block" is kept purely as a
// calendar label for the owner's own reference.
//
// "Already handled" is checked two ways: an appointment currently SITTING on that date
// (the common case), OR any appointment whose checkoutDate field says it was originally
// created to cover this checkout, even if it's since been moved to a different date
// (see the Daily Schedule's "move" and the owner portal's "Move" button). Without the
// second check, every periodic iCal re-sync (see lib/icalSync.js — runs every few
// hours) re-derives the same checkout dates from the same bookings and calls this
// again; since the moved appointment no longer occupies checkoutDate, it looked
// "unhandled" and a fresh duplicate got created right back on the original day — from
// the owner's side, a service they'd just moved would silently reappear on its old
// date the next time the calendar synced.
function maybeCreateCheckoutAppointment(customerId, checkoutDate) {
  if (!checkoutDate || checkoutDate < todayStr()) return null;
  const already = store.getAll('appointments').some(
    (a) => a.customerId === customerId && (a.date === checkoutDate || a.checkoutDate === checkoutDate)
  );
  if (already) return null;
  if (guestPresentOn(customerId, checkoutDate)) return null;
  return store.create('appointments', {
    customerId,
    technicianId: null,
    date: checkoutDate,
    // Stable marker of which checkout this appointment fulfills — deliberately
    // separate from `date` (which the admin/owner can freely move) so a later resync
    // can still recognize this checkout as already handled. See the "already" check
    // above.
    checkoutDate,
    startTime: '10:00',
    endTime: '',
    serviceId: null,
    serviceType: 'Hot Tub Service',
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

// If newer booking data reveals that a previously auto-scheduled turnover cleaning now
// falls on a day a guest is actually still there (see guestPresentOn) — e.g. a second
// calendar synced in later revealed an overlapping stay that didn't exist yet when the
// cleaning was first scheduled — cancel that cleaning rather than leave it sitting on
// the schedule for a day nobody should be cleaning. Only ever touches appointments
// this feature created itself (matched by its own fixed auto-scheduled note) and only
// while still 'scheduled' — a job a tech has already completed, or one the admin
// created/edited by hand, is never touched here. Called after every iCal sync (see
// lib/icalSync.js#syncCustomerCalendar), once that property's full, current set of
// bookings is known.
function cancelConflictingCheckoutAppointments(customerId) {
  const appts = store.getAll('appointments').filter((a) => (
    a.customerId === customerId
    && a.status === 'scheduled'
    && a.notes === 'Auto-scheduled: guest checkout day.'
  ));
  let cancelledCount = 0;
  appts.forEach((a) => {
    if (guestPresentOn(customerId, a.date)) {
      store.update('appointments', a.id, {
        status: 'cancelled',
        notes: 'Auto-cancelled: an updated calendar shows a guest is still on the property this day.',
      });
      cancelledCount += 1;
    }
  });
  return cancelledCount;
}

module.exports = {
  maybeCreateCheckoutAppointment,
  scheduleAllUpcomingCheckouts,
  cancelConflictingCheckoutAppointments,
};
