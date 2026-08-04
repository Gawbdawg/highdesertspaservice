const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeTechnician } = require('../lib/auth');
const { summarizeByDay } = require('../lib/timesheet');
const ai = require('../lib/ai');
const router = express.Router();

// Attaches this technician's own upcoming self-blocked days (see routes/techPortal.js
// #/time-off) so the admin can see requested time off right on the Technicians tab
// without a separate page — today-forward only, since past blocked days aren't
// actionable for anyone.
function withUpcomingTimeOff(tech) {
  const today = new Date().toISOString().slice(0, 10);
  const timeOff = store.getAll('techTimeOff')
    .filter((t) => t.technicianId === tech.id && t.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { ...sanitizeTechnician(tech), timeOff };
}

router.get('/', (req, res) => {
  res.json(store.getAll('technicians').map(withUpcomingTimeOff));
});

// Powers the Team surface: one card per technician (jobs completed + hours + pay over
// the last 7 days, and whether they're currently clocked in) plus an AI/template weekly
// pulse sentence up top. Registered before the /:id routes below but never collides —
// there's no GET /:id here, only PUT/DELETE, so this static path is unambiguous.
router.get('/pulse', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const technicians = store.getAll('technicians');
  const appointments = store.getAll('appointments');
  const timeEntries = store.getAll('timeEntries').filter((e) => e.date >= weekAgo && e.date <= today);

  const days = summarizeByDay(timeEntries, (id) => technicians.find((t) => t.id === id));

  const cards = technicians.map((t) => {
    const completedThisWeek = appointments.filter(
      (a) => a.technicianId === t.id && a.status === 'completed' && a.date >= weekAgo && a.date <= today
    ).length;
    const todaysEntries = store.getAll('timeEntries').filter((e) => e.technicianId === t.id && e.date === today);
    const clockedIn = todaysEntries.some((e) => e.clockInAt && !e.clockOutAt);
    const techDays = days.filter((d) => d.technicianId === t.id);
    const hours = Math.round(techDays.reduce((sum, d) => sum + d.hours, 0) * 100) / 100;
    const pay = Math.round(techDays.reduce((sum, d) => sum + d.pay, 0) * 100) / 100;
    return {
      technicianId: t.id,
      name: t.name,
      hourlyRate: t.hourlyRate || 0,
      jobsThisWeek: completedThisWeek,
      hoursThisWeek: hours,
      payThisWeek: pay,
      clockedIn,
    };
  });

  const pulse = await ai.generateTeamPulse({
    techStats: cards.map((c) => ({ name: c.name, jobs: c.jobsThisWeek, hours: c.hoursThisWeek })),
  });

  res.json({ cards, pulse });
});

router.post('/', (req, res) => {
  const { name, email, phone, username, password, hourlyRate } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  if (username) {
    const existing = store.getAll('technicians').find(
      (t) => (t.username || '').toLowerCase() === username.toLowerCase()
    );
    if (existing) return res.status(400).json({ error: 'That username is already taken' });
  }

  const tech = store.create('technicians', {
    name,
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
    hourlyRate: hourlyRate !== undefined && hourlyRate !== '' ? Number(hourlyRate) : 0,
  });
  res.status(201).json(sanitizeTechnician(tech));
});

router.put('/:id', (req, res) => {
  const { name, email, phone, username, password, hourlyRate } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (hourlyRate !== undefined) updates.hourlyRate = hourlyRate === '' ? 0 : Number(hourlyRate);

  if (username !== undefined) {
    if (username) {
      const existing = store.getAll('technicians').find(
        (t) => t.id !== Number(req.params.id) && (t.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }
  // Only overwrite the password if a new one was actually typed in
  if (password) updates.passwordHash = hashPassword(password);

  const updated = store.update('technicians', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Technician not found' });
  res.json(sanitizeTechnician(updated));
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('technicians', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Technician not found' });
  res.status(204).end();
});

// Lets the admin clear a technician's self-blocked day (e.g. a scheduling conflict
// came up and it needs to be worked out and removed) — the tech can also remove their
// own from the tech portal; this is just the admin-side override.
router.delete('/:id/time-off/:timeOffId', (req, res) => {
  const entry = store.getById('techTimeOff', req.params.timeOffId);
  if (!entry || entry.technicianId !== Number(req.params.id)) {
    return res.status(404).json({ error: 'Time off entry not found' });
  }
  store.remove('techTimeOff', req.params.timeOffId);
  res.status(204).end();
});

module.exports = router;
