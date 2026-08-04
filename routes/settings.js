const express = require('express');
const store = require('../lib/store');
const { geocodeAddress } = require('../lib/geocode');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getSettings());
});

router.put('/', (req, res) => {
  const updates = {};
  if (req.body.depotAddress !== undefined) {
    updates.depotAddress = req.body.depotAddress;
    // Address changed — clear cached coordinates so it gets re-geocoded
    updates.depotLat = null;
    updates.depotLng = null;
  }
  if (req.body.googleReviewUrl !== undefined) {
    updates.googleReviewUrl = req.body.googleReviewUrl;
  }
  if (req.body.notificationEmail !== undefined) {
    updates.notificationEmail = req.body.notificationEmail;
  }
  // The service to bill against when a completed job was never linked to a specific
  // one and there's no prior job for that customer to infer it from — e.g. auto-
  // scheduled vacation-rental turnover cleanings (lib/turnoverSchedule.js) or bulk
  // text-imported appointments, neither of which has a "pick a service" step at all.
  // See lib/autoInvoice.js#ensureServiceId. '' clears it back to no default.
  if (req.body.defaultServiceId !== undefined) {
    updates.defaultServiceId = req.body.defaultServiceId ? Number(req.body.defaultServiceId) : null;
  }
  res.json(store.updateSettings(updates));
});

router.post('/geocode-depot', async (req, res) => {
  const settings = store.getSettings();
  try {
    const { lat, lng } = await geocodeAddress(settings.depotAddress);
    res.json(store.updateSettings({ depotLat: lat, depotLng: lng }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
