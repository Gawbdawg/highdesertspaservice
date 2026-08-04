const express = require('express');
const store = require('../lib/store');
const router = express.Router();

// Admin view: all owners' requested service dates
router.get('/', (req, res) => {
  let requests = store.getAll('serviceRequests');
  if (req.query.status) requests = requests.filter((r) => r.status === req.query.status);
  requests = requests
    .map((r) => {
      const customer = store.getById('customers', r.customerId);
      return {
        ...r,
        customerName: customer ? customer.name : 'Unknown',
        customerAddress: customer ? customer.address : '',
      };
    })
    .sort((a, b) => a.requestedDate.localeCompare(b.requestedDate));
  res.json(requests);
});

router.put('/:id', (req, res) => {
  const { status } = req.body;
  if (!['pending', 'scheduled', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updated = store.update('serviceRequests', req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Request not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('serviceRequests', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Request not found' });
  res.status(204).end();
});

module.exports = router;
