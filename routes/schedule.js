const express = require('express');
const store = require('../lib/store');
const { sanitizeCustomer, sanitizeTechnician } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { sendEmail } = require('../lib/mailer');
const router = express.Router();

function dayAppointments(date) {
  return store.getAll('appointments')
    // A cancelled appointment (an admin/owner cancellation, or the turnover-conflict
    // safety net auto-cancelling a checkout cleaning that turned out to land on a day
    // a guest is actually still there — see lib/turnoverSchedule.js) should never show
    // up as a job to actually do. Every other appointment listing in this app already
    // excludes cancelled (tech portal, owner portal) — this was the one place that
    // didn't, so a cancelled auto-scheduled cleaning could still appear on the Daily
    // Schedule and in the technician's route text as if it were a real job.
    .filter((a) => a.date === date && a.status !== 'cancelled')
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((a) => {
      const customer = store.getById('customers', a.customerId);
      const technician = a.technicianId ? store.getById('technicians', a.technicianId) : null;
      return { ...a, customer: sanitizeCustomer(customer), technician: sanitizeTechnician(technician) };
    });
}

// JSON view of a day's schedule, grouped by technician
router.get('/:date', (req, res) => {
  const appts = dayAppointments(req.params.date);
  const byTech = {};
  appts.forEach((a) => {
    const key = a.technician ? a.technician.name : 'Unassigned';
    if (!byTech[key]) byTech[key] = [];
    byTech[key].push(a);
  });
  res.json({ date: req.params.date, count: appts.length, byTechnician: byTech });
});

// Orders a day's appointments into an efficient driving route from the depot,
// falling back to time order for any stop we don't have coordinates for yet.
function routeOrder(appts) {
  const settings = store.getSettings();
  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;

  const stops = appts.map((a) => ({
    appt: a,
    lat: a.customer ? a.customer.lat : undefined,
    lng: a.customer ? a.customer.lng : undefined,
  }));

  if (!depot) {
    return { ordered: appts, routed: false, missingCount: appts.length };
  }

  const { ordered, unroutable } = orderStopsByRoute(depot, stops);
  return {
    ordered: [...ordered, ...unroutable].map((s) => s.appt),
    routed: true,
    missingCount: unroutable.length,
  };
}

// Plain-text message ready to copy/paste or send via email/SMS to a technician
router.get('/:date/technician/:technicianId/text', (req, res) => {
  const appts = dayAppointments(req.params.date).filter(
    (a) => a.technician && a.technician.id === Number(req.params.technicianId)
  );
  const tech = store.getById('technicians', req.params.technicianId);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  const { ordered, routed, missingCount } = routeOrder(appts);

  // No specific time is ever quoted here — jobs aren't scheduled to a time slot, just a
  // day, so the numbered order (route order when we have one) is the only ordering
  // information that means anything.
  let text = `Hi ${tech.name}, here's your High Desert schedule for ${req.params.date}`;
  text += routed ? ' (in efficient route order from the shop):\n\n' : ':\n\n';
  if (ordered.length === 0) {
    text += 'No appointments scheduled today.';
  } else {
    ordered.forEach((a, i) => {
      text += `${i + 1}. ${a.customer ? a.customer.name : 'Unknown'} (${a.serviceType})\n`;
      if (a.customer && a.customer.address) text += `   ${a.customer.address}\n`;
      if (a.customer && a.customer.phone) text += `   ${a.customer.phone}\n`;
      if (a.customer && a.customer.notes) text += `   Property note: ${a.customer.notes}\n`;
      if (a.notes) text += `   Note: ${a.notes}\n`;
    });
    if (routed && missingCount > 0) {
      text += `\n(${missingCount} stop${missingCount === 1 ? '' : 's'} listed last — no map location on file yet; use "Geocode all addresses" in the admin Customers tab.)`;
    }
    if (!routed) {
      text += `\n(Set a shop address and geocode customer addresses in Settings to get route-ordered stops.)`;
    }
  }
  res.json({ technician: sanitizeTechnician(tech), text });
});

// Builds the plain-text confirmation message for a customer — shared by the
// copy-to-clipboard and email-it endpoints below so they always say exactly the same
// thing. No time is quoted (jobs are scheduled to a day, not a time slot).
function customerConfirmationText(appt, customer, technician) {
  return `Hi ${customer ? customer.name : ''}, this is High Desert Spa Service confirming your ${appt.serviceType} appointment on ${appt.date}${technician ? ' with ' + technician.name : ''}. Reply if you need to reschedule. Thank you!`;
}

// Plain-text confirmation message ready to send to a customer for a specific appointment
router.get('/appointment/:appointmentId/customer-text', (req, res) => {
  const appt = store.getById('appointments', req.params.appointmentId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const customer = store.getById('customers', appt.customerId);
  const technician = appt.technicianId ? store.getById('technicians', appt.technicianId) : null;
  const text = customerConfirmationText(appt, customer, technician);
  res.json({ customer: sanitizeCustomer(customer), appointment: appt, text });
});

// Same message as above, but emailed straight to the customer instead of copied to the
// clipboard — same dry-run fallback as every other email in the app if no email
// provider is configured yet (see lib/mailer.js).
router.post('/appointment/:appointmentId/email-customer-text', async (req, res) => {
  const appt = store.getById('appointments', req.params.appointmentId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const customer = store.getById('customers', appt.customerId);
  if (!customer || !customer.email) {
    return res.status(400).json({ error: 'No email on file for this home yet.' });
  }
  const technician = appt.technicianId ? store.getById('technicians', appt.technicianId) : null;
  const text = customerConfirmationText(appt, customer, technician);
  try {
    const result = await sendEmail({ to: customer.email, subject: 'Your High Desert Spa Service appointment', text });
    res.json({ sent: true, dryRun: !!result.dryRun });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
