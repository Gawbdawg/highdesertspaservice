const express = require('express');
const store = require('../lib/store');
const { summarizeByDay } = require('../lib/timesheet');
const router = express.Router();

// Actual money paid to a technician (cash, Venmo, a check, whatever) is separate
// from timesheets' computed "Pay" figure — that's what's OWED based on hours ×
// rate, but payment itself happens outside this app, so there was previously no
// record that a payment actually happened. This is that record.
//
// GET / returns the raw payout log (optionally filtered) PLUS a lifetime
// owed/paid/balance summary per technician, computed from the same timesheet math
// routes/timesheets.js already uses — so "did I actually pay him for that" has a
// real answer instead of just a stack of numbers to eyeball.
router.get('/', (req, res) => {
  let payouts = store.getAll('payouts');
  if (req.query.technicianId) {
    payouts = payouts.filter((p) => p.technicianId === Number(req.query.technicianId));
  }
  if (req.query.from) payouts = payouts.filter((p) => p.date >= req.query.from);
  if (req.query.to) payouts = payouts.filter((p) => p.date <= req.query.to);
  payouts = payouts.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const techsById = {};
  store.getAll('technicians').forEach((t) => { techsById[t.id] = t; });

  const withNames = payouts.map((p) => ({
    ...p,
    technicianName: techsById[p.technicianId] ? techsById[p.technicianId].name : 'Unknown',
  }));

  // Lifetime balances always cover full history regardless of the from/to filter
  // above — the filter is for browsing the log, not for deciding whether someone's
  // still owed money.
  const allTimeEntries = store.getAll('timeEntries');
  const allPayouts = store.getAll('payouts');
  const days = summarizeByDay(allTimeEntries, (id) => techsById[id]);

  const balances = Object.values(techsById).map((t) => {
    const totalOwed = Math.round(
      days.filter((d) => d.technicianId === t.id).reduce((sum, d) => sum + d.pay, 0) * 100
    ) / 100;
    const totalPaid = Math.round(
      allPayouts.filter((p) => p.technicianId === t.id).reduce((sum, p) => sum + Number(p.amount || 0), 0) * 100
    ) / 100;
    return {
      technicianId: t.id,
      technicianName: t.name,
      totalOwed,
      totalPaid,
      balance: Math.round((totalOwed - totalPaid) * 100) / 100,
    };
  });

  const totalPaidInView = withNames.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  res.json({ payouts: withNames, totalPaidInView: Math.round(totalPaidInView * 100) / 100, balances });
});

router.post('/', (req, res) => {
  const { technicianId, amount, date, note } = req.body;
  if (!technicianId || amount === undefined || !date) {
    return res.status(400).json({ error: 'technicianId, amount, and date are required' });
  }
  const payout = store.create('payouts', {
    technicianId: Number(technicianId),
    amount: Number(amount),
    date,
    note: note || '',
  });
  res.status(201).json(payout);
});

router.put('/:id', (req, res) => {
  const updates = {};
  if (req.body.amount !== undefined) updates.amount = Number(req.body.amount);
  if (req.body.date !== undefined) updates.date = req.body.date;
  if (req.body.note !== undefined) updates.note = req.body.note;
  const updated = store.update('payouts', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Payout not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('payouts', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Payout not found' });
  res.status(204).end();
});

module.exports = router;
