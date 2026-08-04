// Admin-managed catalog of standard services with default prices — used to speed up
// picking a service on an appointment, and to auto-generate a draft invoice at the
// right price when a technician marks a job complete (see routes/appointments.js).
const express = require('express');
const store = require('../lib/store');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getAll('services').sort((a, b) => a.name.localeCompare(b.name)));
});

// Frequency-based services (e.g. "Routine cleaning") don't have one single price —
// instead the price depends on how often the customer's serviced (weekly/biweekly/
// every4weeks, labeled "Monthly" in the UI), or a flat rate for vacation rentals
// regardless of frequency. Pulls out just the valid, positive entries so a blank field
// simply means "no rate set for that tier" rather than a $0 charge.
function sanitizeFrequencyPrices(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  ['weekly', 'biweekly', 'every4weeks', 'vacationFlat'].forEach((key) => {
    const n = Number(input[key]);
    if (input[key] !== '' && input[key] !== undefined && input[key] !== null && !Number.isNaN(n)) {
      out[key] = n;
    }
  });
  return out;
}

router.post('/', (req, res) => {
  const { name, defaultPrice, pricingMode, frequencyPrices } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const service = store.create('services', {
    name,
    pricingMode: pricingMode === 'frequency' ? 'frequency' : 'flat',
    defaultPrice: defaultPrice ? Number(defaultPrice) : 0,
    frequencyPrices: sanitizeFrequencyPrices(frequencyPrices),
  });
  res.status(201).json(service);
});

router.put('/:id', (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.defaultPrice !== undefined) updates.defaultPrice = Number(req.body.defaultPrice) || 0;
  if (req.body.pricingMode !== undefined) updates.pricingMode = req.body.pricingMode === 'frequency' ? 'frequency' : 'flat';
  if (req.body.frequencyPrices !== undefined) updates.frequencyPrices = sanitizeFrequencyPrices(req.body.frequencyPrices);
  const updated = store.update('services', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Service not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('services', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Service not found' });
  res.status(204).end();
});

module.exports = router;
