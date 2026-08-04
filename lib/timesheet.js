// Shared pay/hours math for the tech timesheet feature — used by both the tech
// portal's own "my pay" view (routes/techPortal.js) and the admin payroll view
// (routes/timesheets.js), so the two never drift out of sync on how a day's pay
// is calculated.

// Hours for a single clock-in/out session. An entry that hasn't been clocked out
// yet counts as still running — pass `now` (defaults to the real current time) as
// the effective end, so an open session shows live elapsed hours rather than zero.
function hoursForEntry(entry, now = new Date()) {
  const start = new Date(entry.clockInAt).getTime();
  const end = entry.clockOutAt ? new Date(entry.clockOutAt).getTime() : now.getTime();
  if (!Number.isFinite(start)) return 0;
  const ms = Math.max(0, end - start);
  return ms / 3600000;
}

// Groups a flat list of time entries (one or many technicians) into one row per
// technician+date: total hours worked that day (across every clock-in/out session
// that day), whether the $10 gas stipend applies, and computed wages/pay using each
// technician's hourly rate. `technicianOf(id)` should return that technician's record
// (needs an `hourlyRate` field) or null/undefined if unknown.
function summarizeByDay(entries, technicianOf) {
  const byKey = {};
  entries.forEach((e) => {
    const key = `${e.technicianId}|${e.date}`;
    if (!byKey[key]) {
      byKey[key] = { technicianId: e.technicianId, date: e.date, entries: [], hours: 0, gasStipend: 0, stillClockedIn: false };
    }
    const day = byKey[key];
    day.entries.push(e);
    day.hours += hoursForEntry(e);
    if (e.gasStipendAdded) day.gasStipend = 10;
    if (!e.clockOutAt) day.stillClockedIn = true;
  });
  return Object.values(byKey)
    .map((day) => {
      const tech = technicianOf ? technicianOf(day.technicianId) : null;
      const rate = tech && typeof tech.hourlyRate === 'number' ? tech.hourlyRate : 0;
      const hours = Math.round(day.hours * 100) / 100;
      const wages = Math.round(hours * rate * 100) / 100;
      const pay = Math.round((wages + day.gasStipend) * 100) / 100;
      return { ...day, hours, wages, pay };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

module.exports = { hoursForEntry, summarizeByDay };
