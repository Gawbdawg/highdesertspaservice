const store = require('./store');
const { futureDates } = require('./recurrence');

// Turns a customer's saved service frequency into an actual recurring appointment
// series on the calendar, starting from (and including) startDate. Shared by the
// admin "Schedule recurring visits" action (routes/customers.js) and an owner
// self-service "set up my regular service" flow (routes/ownerPortal.js) so both
// generate a series the exact same way.
// customer.serviceFrequency must already be set. Params: { startDate, startTime,
// technicianId, serviceId } — startDate/startTime required, the rest optional.
function generateRecurringSeries(customer, { startDate, startTime, technicianId, serviceId }) {
  const service = serviceId ? store.getById('services', serviceId) : null;
  const base = {
    customerId: customer.id,
    technicianId: technicianId ? Number(technicianId) : null,
    startTime,
    endTime: '',
    serviceId: service ? service.id : null,
    serviceType: service ? service.name : 'Hot Tub Service',
    status: 'scheduled',
    notes: '',
    chlorine: '',
    ph: '',
    alkalinity: '',
    addons: [],
  };

  const first = store.create('appointments', { ...base, date: startDate, seriesId: null });
  store.update('appointments', first.id, { seriesId: first.id });
  const dates = futureDates(startDate, customer.serviceFrequency, null, customer.customFrequencyDays);
  dates.forEach((d) => {
    store.create('appointments', { ...base, date: d, seriesId: first.id, status: 'scheduled' });
  });

  return { created: dates.length + 1, firstAppointmentId: first.id };
}

module.exports = { generateRecurringSeries };
