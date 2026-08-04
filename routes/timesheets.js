const express = require('express');
const store = require('../lib/store');
const { summarizeByDay } = require('../lib/timesheet');
const router = express.Router();

// Admin-facing payroll view: every technician's clocked hours, gas stipends, and
// computed pay, one row per technician+date. Optional filters: ?technicianId=,
// ?from=YYYY-MM-DD, ?to=YYYY-MM-DD. This is the office's source of truth for actually
// running payroll — the tech portal's own /api/tech/time-entries is the same math but
// scoped to just that tech's own entries.
router.get('/', (req, res) => {
  let entries = store.getAll('timeEntries');
  if (req.query.technicianId) {
    entries = entries.filter((e) => e.technicianId === Number(req.query.technicianId));
  }
  if (req.query.from) entries = entries.filter((e) => e.date >= req.query.from);
  if (req.query.to) entries = entries.filter((e) => e.date <= req.query.to);

  const techsById = {};
  store.getAll('technicians').forEach((t) => { techsById[t.id] = t; });

  const days = summarizeByDay(entries, (id) => techsById[id]);
  const withNames = days.map((d) => ({
    ...d,
    technicianName: techsById[d.technicianId] ? techsById[d.technicianId].name : 'Unknown',
  }));

  const totals = withNames.reduce(
    (acc, d) => ({
      hours: Math.round((acc.hours + d.hours) * 100) / 100,
      gasStipend: acc.gasStipend + d.gasStipend,
      wages: Math.round((acc.wages + d.wages) * 100) / 100,
      pay: Math.round((acc.pay + d.pay) * 100) / 100,
    }),
    { hours: 0, gasStipend: 0, wages: 0, pay: 0 }
  );

  res.json({ days: withNames, totals });
});

// Manual correction for a forgotten clock-out or a typo'd time — the tech portal only
// ever lets a tech clock themselves in/out, so this is the office's way to fix mistakes.
router.put('/:id', (req, res) => {
  const entry = store.getById('timeEntries', req.params.id);
  if (!entry) return res.status(404).json({ error: 'Time entry not found' });
  const updates = {};
  if (req.body.clockInAt !== undefined) updates.clockInAt = req.body.clockInAt;
  if (req.body.clockOutAt !== undefined) updates.clockOutAt = req.body.clockOutAt;
  if (req.body.gasStipendAdded !== undefined) updates.gasStipendAdded = !!req.body.gasStipendAdded;
  const updated = store.update('timeEntries', req.params.id, updates);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('timeEntries', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Time entry not found' });
  res.status(204).end();
});

// Lets the admin add a missed session by hand (e.g. a tech forgot to clock in at all
// one day) rather than only ever correcting an existing row.
router.post('/', (req, res) => {
  const { technicianId, date, clockInAt, clockOutAt, gasStipendAdded } = req.body;
  if (!technicianId || !date || !clockInAt) {
    return res.status(400).json({ error: 'technicianId, date, and clockInAt are required' });
  }
  const entry = store.create('timeEntries', {
    technicianId: Number(technicianId),
    date,
    clockInAt,
    clockOutAt: clockOutAt || null,
    gasStipendAdded: !!gasStipendAdded,
  });
  res.status(201).json(entry);
});

module.exports = router;
