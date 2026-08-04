// Admin-managed catalog of technician upcharges (e.g. "Grill cleaning $10", "Window
// spray $5") — small flat-fee add-ons a technician can attach to a job on the spot from
// the tech portal, on top of the job's regular service price. See routes/techPortal.js
// for where technicians attach these to their own appointments, and lib/autoInvoice.js /
// lib/monthlyInvoice.js for how the amounts get folded into invoices.
const express = require('express');
const store = require('../lib/store');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getAll('addons').sort((a, b) => a.name.localeCompare(b.name)));
});

router.post('/', (req, res) => {
  const { name, price } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const addon = store.create('addons', {
    name,
    price: price ? Number(price) : 0,
  });
  res.status(201).json(addon);
});

router.put('/:id', (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.price !== undefined) updates.price = Number(req.body.price) || 0;
  const updated = store.update('addons', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Add-on not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('addons', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Add-on not found' });
  res.status(204).end();
});

module.exports = router;
