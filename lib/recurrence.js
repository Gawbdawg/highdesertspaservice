// Shared recurring-date generation — used both by the admin "New Appointment" form's
// Repeats option (routes/appointments.js) and by "Schedule recurring visits" off a
// customer's saved service frequency (routes/customers.js), so both places generate
// the same series the same way.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d;
}

// Adds n calendar months, clamping to the last day of the target month
// (e.g. Jan 31 + 1 month -> Feb 28, not a rollover into March).
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  const targetMonth = d.getMonth() + n;
  const candidate = new Date(d.getFullYear(), targetMonth, d.getDate());
  if (candidate.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    // Rolled over — clamp to the last day of the intended month
    return new Date(d.getFullYear(), targetMonth + 1, 0);
  }
  return candidate;
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MAX_OCCURRENCES = 52;

// Generates the future dates for a recurring series, starting from (and excluding)
// the first occurrence's date, up to recurrenceEndDate or 6 months out (whichever
// comes first), capped at MAX_OCCURRENCES total to avoid runaway generation.
function futureDates(startDate, frequency, recurrenceEndDate, customDays) {
  const defaultEnd = fmt(addMonths(startDate, 6));
  const endDate = recurrenceEndDate && recurrenceEndDate < defaultEnd ? recurrenceEndDate : defaultEnd;
  const dates = [];
  let cursor = startDate;
  while (dates.length < MAX_OCCURRENCES - 1) {
    const next = frequency === 'weekly' ? addDays(cursor, 7)
      : frequency === 'biweekly' ? addDays(cursor, 14)
      : frequency === 'every4weeks' ? addDays(cursor, 28)
      : frequency === 'custom' ? addDays(cursor, Math.max(1, Number(customDays) || 30))
      : addMonths(cursor, 1); // monthly
    const nextStr = fmt(next);
    if (nextStr > endDate) break;
    dates.push(nextStr);
    cursor = nextStr;
  }
  return dates;
}

module.exports = { addDays, addMonths, fmt, futureDates, MAX_OCCURRENCES };
