const express = require('express');
const store = require('../lib/store');
const ai = require('../lib/ai');
const chemistry = require('../lib/chemistry');
const router = express.Router();

// Read-only, non-destructive People view. The underlying `customers` and `owners`
// collections and every route that touches them (billing, autopay, Stripe, owner
// portal login, etc.) are untouched — this just JOINS them server-side into one
// profile per real-world person instead of making the office look in two tabs.
//
// A "person" is either:
//   - an owner account, with every customer/home row that links to it via ownerId, or
//   - a standalone customer with no ownerId at all (most residential one-off homes) —
//     shown as its own person using that home's own name/contact info.

function personIdFor(kind, id) {
  return `${kind}_${id}`;
}

function propertySummary(customer, invoices) {
  const balanceDue = invoices
    .filter((i) => i.customerId === customer.id && i.status !== 'paid' && i.status !== 'draft')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);
  return {
    id: customer.id,
    name: customer.name,
    address: customer.address,
    type: customer.type || 'residential',
    balanceDue: Math.round(balanceDue * 100) / 100,
    hasFilterAlert: !!(customer.equipment && customer.equipment.filterLastChanged),
  };
}

router.get('/', (req, res) => {
  const owners = store.getAll('owners');
  const customers = store.getAll('customers');
  const invoices = store.getAll('invoices');

  const people = [];

  owners.forEach((owner) => {
    const properties = customers.filter((c) => c.ownerId === owner.id);
    const balanceDue = properties.reduce((sum, c) => sum + propertySummary(c, invoices).balanceDue, 0)
      + invoices.filter((i) => i.ownerId === owner.id && i.status !== 'paid' && i.status !== 'draft')
        .reduce((sum, i) => sum + Number(i.amount || 0), 0);
    people.push({
      id: personIdFor('owner', owner.id),
      type: 'owner',
      ownerId: owner.id,
      name: owner.name,
      email: owner.email || '',
      phone: owner.phone || '',
      properties: properties.map((c) => propertySummary(c, invoices)),
      balanceDue: Math.round(balanceDue * 100) / 100,
      autopayEnabled: !!owner.autopayEnabled,
      agreedToTerms: !!owner.agreedToTermsAt,
      signupSource: owner.signupSource || 'admin',
    });
  });

  customers.filter((c) => !c.ownerId).forEach((customer) => {
    const summary = propertySummary(customer, invoices);
    people.push({
      id: personIdFor('customer', customer.id),
      type: 'customer',
      customerId: customer.id,
      name: customer.name,
      email: customer.email || '',
      phone: customer.phone || '',
      properties: [summary],
      balanceDue: summary.balanceDue,
      autopayEnabled: false,
      agreedToTerms: null,
      signupSource: null,
    });
  });

  people.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json(people);
});

// Full profile for one person: service history (with AI/template visit summaries),
// water chemistry readings pulled straight from completed appointments, a current
// dosage recommendation from the most recent reading, equipment/warranty-style info,
// and a best-effort sentiment read off whatever free-text they've left us (service
// request notes are the closest thing this app has to a customer's own words).
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['owner', 'customer'].includes(type)) return res.status(404).json({ error: 'Not found' });

  const invoices = store.getAll('invoices');
  const appointments = store.getAll('appointments');
  const technicians = store.getAll('technicians');
  const serviceRequests = store.getAll('serviceRequests');

  let properties;
  let contact;
  if (type === 'owner') {
    const owner = store.getById('owners', id);
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    properties = store.getAll('customers').filter((c) => c.ownerId === owner.id);
    contact = { name: owner.name, email: owner.email, phone: owner.phone, agreedToTerms: !!owner.agreedToTermsAt, autopayEnabled: !!owner.autopayEnabled };
  } else {
    const customer = store.getById('customers', id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    properties = [customer];
    contact = { name: customer.name, email: customer.email, phone: customer.phone, agreedToTerms: null, autopayEnabled: false };
  }

  const propertyIds = properties.map((c) => c.id);
  const techName = (tid) => (technicians.find((t) => t.id === tid) || {}).name || 'Unassigned';

  const history = appointments
    .filter((a) => propertyIds.includes(a.customerId) && a.status === 'completed')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 25)
    .map((a) => ({
      appointmentId: a.id,
      date: a.date,
      technician: techName(a.technicianId),
      serviceType: a.serviceType,
      notes: a.notes || '',
      chlorine: a.chlorine || '',
      ph: a.ph || '',
      alkalinity: a.alkalinity || '',
    }));

  // AI/template visit summaries are generated on read rather than stored, so this
  // never has to backfill old appointments or worry about a summary going stale if
  // notes are edited later — it's always derived fresh from whatever's on file now.
  const historyWithSummary = await Promise.all(history.map(async (visit) => {
    const summary = await ai.generateVisitSummary(visit);
    return { ...visit, summary: summary.text, summaryAiGenerated: summary.aiGenerated };
  }));

  const chemistryReadings = history
    .filter((h) => h.chlorine || h.ph || h.alkalinity)
    .map((h) => ({ date: h.date, chlorine: h.chlorine, ph: h.ph, alkalinity: h.alkalinity }));

  const latest = chemistryReadings[0];
  let dosageRecommendation = [];
  if (latest) {
    const gallons = properties[0] && properties[0].equipment ? Number(properties[0].equipment.capacityGallons) || undefined : undefined;
    dosageRecommendation = chemistry.recommendDosage({
      gallons,
      freeChlorine: latest.chlorine || undefined,
      ph: latest.ph || undefined,
      alkalinity: latest.alkalinity || undefined,
    });
  }

  const equipment = properties
    .filter((c) => c.equipment && (c.equipment.brand || c.equipment.model || c.equipment.filterType))
    .map((c) => ({
      propertyId: c.id,
      propertyName: c.name,
      brand: c.equipment.brand || '',
      model: c.equipment.model || '',
      serialNumber: c.equipment.serialNumber || '',
      installDate: c.equipment.installDate || '',
      filterType: c.equipment.filterType || '',
      filterLastChanged: c.equipment.filterLastChanged || '',
      filterIntervalDays: c.equipment.filterIntervalDays || '',
    }));

  const sentimentSourceText = [
    ...serviceRequests.filter((r) => propertyIds.includes(r.customerId)).map((r) => r.notes),
    ...properties.map((c) => c.notes),
  ].filter(Boolean).join('. ');
  const sentiment = await ai.generateSentiment(sentimentSourceText);

  const balanceDue = invoices
    .filter((i) => (propertyIds.includes(i.customerId) || (type === 'owner' && i.ownerId === Number(id)))
      && i.status !== 'paid' && i.status !== 'draft')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);

  res.json({
    id: personIdFor(type, id),
    type,
    contact,
    properties: properties.map((c) => ({
      id: c.id,
      name: c.name,
      address: c.address,
      type: c.type || 'residential',
      serviceFrequency: c.serviceFrequency || null,
    })),
    balanceDue: Math.round(balanceDue * 100) / 100,
    sentiment: sentiment.text,
    sentimentAiGenerated: sentiment.aiGenerated,
    history: historyWithSummary,
    chemistry: chemistryReadings,
    dosageRecommendation,
    equipment,
  });
});

module.exports = router;
