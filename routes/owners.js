const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeOwner } = require('../lib/auth');
const { generateMonthlyInvoiceForOwner } = require('../lib/monthlyInvoice');
const { makeCustomerMatcher } = require('../lib/customerMatch');
const { buildAgreementPdf } = require('../lib/agreementPdf');
const router = express.Router();

// Owners aren't tagged with a type of their own — they're organized into vacation
// rental vs. residential vs. repair the same way the Homes tab is, just derived from
// whatever their linked homes actually are. An owner with only vacation-rental homes
// shows as "Vacation rental," only residential shows as "Residential," only repair
// shows as "Repair," and one with a mix (e.g. one vacation rental + one residential)
// shows every badge that applies and matches any of those filters — there's no
// separate field to keep in sync by hand.
function normalizePropertyType(type) {
  if (type === 'vacation' || type === 'repair') return type;
  return 'residential';
}
function withPropertyCount(owner) {
  const properties = store.getAll('customers').filter((c) => c.ownerId === owner.id);
  const propertyTypes = [...new Set(properties.map((c) => normalizePropertyType(c.type)))];
  return { ...sanitizeOwner(owner), propertyCount: properties.length, propertyTypes };
}

router.get('/', (req, res) => {
  const owners = store.getAll('owners')
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(withPropertyCount);
  res.json(owners);
});

// A durable, downloadable record of a signed Service Agreement — same wording the owner
// checked "I agree" against in their portal, plus who they are and exactly when they
// agreed. Available any time the record exists (agreedToTerms doesn't have to still be
// true going forward — this is a historical signature, not a live status check), so a
// signature is never lost even if terms get re-versioned down the line.
router.get('/:id/agreement.pdf', (req, res) => {
  const owner = store.getById('owners', req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  if (!owner.agreedToTermsAt) {
    return res.status(400).json({ error: 'This owner has not agreed to the Service Agreement yet.' });
  }
  const properties = store.getAll('customers').filter((c) => c.ownerId === owner.id);
  const filename = `service-agreement-${(owner.name || 'owner').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = buildAgreementPdf(owner, properties);
  doc.pipe(res);
  doc.end();
});

router.post('/', (req, res) => {
  const { name, email, phone, username, password, customPricing, billingMode, newsletterSubscribed } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (username) {
    const existing = store.getAll('owners').find((o) => (o.username || '').toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: 'That username is already taken' });
  }
  const cleanedPricing = {};
  Object.entries(customPricing || {}).forEach(([serviceId, price]) => {
    if (price !== '' && price !== null && price !== undefined && !Number.isNaN(Number(price))) {
      cleanedPricing[serviceId] = Number(price);
    }
  });
  const owner = store.create('owners', {
    name,
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
    customPricing: cleanedPricing,
    billingMode: billingMode === 'monthly' ? 'monthly' : 'perJob',
    // Defaults to subscribed since the plan is to collect this consent as part of the
    // owner's signed waiver going forward. Admin can flip it off per-owner (or right
    // here at creation), and owners can also unsubscribe themselves from their portal.
    newsletterSubscribed: newsletterSubscribed === undefined ? true : !!newsletterSubscribed,
    // Every owner has to click through the Terms of Service gate on their first login
    // (see routes/ownerPortal.js#/agree-to-terms) — including existing owners, since
    // this field is simply absent/false until they do.
    agreedToTerms: false,
    agreedToTermsAt: null,
  });
  res.status(201).json(withPropertyCount(owner));
});

router.put('/:id', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (req.body.newsletterSubscribed !== undefined) updates.newsletterSubscribed = !!req.body.newsletterSubscribed;
  if (username !== undefined) {
    if (username) {
      const existing = store.getAll('owners').find(
        (o) => o.id !== Number(req.params.id) && (o.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }
  if (password) updates.passwordHash = hashPassword(password);
  if (req.body.billingMode !== undefined) {
    updates.billingMode = req.body.billingMode === 'monthly' ? 'monthly' : 'perJob';
  }
  // customPricing: { [serviceId]: price } — per-owner price overrides, covering every
  // property linked to this owner. A missing/blank entry falls back to that service's
  // catalog default price (see lib/autoInvoice.js).
  if (req.body.customPricing !== undefined) {
    const cleaned = {};
    Object.entries(req.body.customPricing || {}).forEach(([serviceId, price]) => {
      if (price !== '' && price !== null && price !== undefined && !Number.isNaN(Number(price))) {
        cleaned[serviceId] = Number(price);
      }
    });
    updates.customPricing = cleaned;
  }
  const updated = store.update('owners', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Owner not found' });
  res.json(withPropertyCount(updated));
});

// Bulk-creates owner accounts for every customer that doesn't already have one linked.
// Customers sharing the same email or phone number are grouped onto a single owner
// account (so one person managing several rental properties gets one login, not several).
// Accounts are created with no password set — nobody can log in until a password is added
// later (Owners tab or the owner's own portal), so this is safe to run any time.
router.post('/bulk-create-from-customers', (req, res) => {
  const customers = store.getAll('customers');
  const unlinked = customers.filter((c) => !c.ownerId);

  const normEmail = (v) => (v || '').trim().toLowerCase();
  const normPhone = (v) => (v || '').replace(/\D/g, '');

  // Group unlinked customers by shared email, then by shared phone. A customer with
  // neither gets its own group (key is unique to that customer).
  const groups = new Map();
  unlinked.forEach((c) => {
    const key = (c.email && normEmail(c.email)) ? `email:${normEmail(c.email)}`
      : (c.phone && normPhone(c.phone)) ? `phone:${normPhone(c.phone)}`
      : `solo:${c.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });

  const existingUsernames = new Set(
    store.getAll('owners').map((o) => (o.username || '').toLowerCase()).filter(Boolean)
  );

  function slugify(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  }

  function uniqueUsername(base) {
    const cleanBase = base || 'owner';
    let candidate = cleanBase;
    let n = 2;
    while (!candidate || existingUsernames.has(candidate)) {
      candidate = `${cleanBase}${n}`;
      n += 1;
    }
    existingUsernames.add(candidate);
    return candidate;
  }

  let ownersCreated = 0;
  let customersLinked = 0;

  groups.forEach((groupCustomers) => {
    const rep = groupCustomers[0]; // representative record for the owner's contact info
    const usernameBase = rep.email ? slugify(rep.email.split('@')[0]) : slugify(rep.name);
    const owner = store.create('owners', {
      name: rep.name,
      email: rep.email || '',
      phone: rep.phone || '',
      username: uniqueUsername(usernameBase),
      passwordHash: '', // intentionally no password — set later if/when this owner needs to log in
      newsletterSubscribed: true,
    });
    ownersCreated += 1;
    groupCustomers.forEach((c) => {
      store.update('customers', c.id, { ownerId: owner.id });
      customersLinked += 1;
    });
  });

  res.json({
    ownersCreated,
    customersLinked,
    alreadyLinked: customers.length - unlinked.length,
  });
});

const EMAIL_RE = /.+@.+\..+/;

// Bulk-links owners to customers/properties from pasted text — one line per pairing in
// the form "CustomerName: OwnerName, value1, value2" where each value can be a phone
// number or an email (detected automatically, order doesn't matter). The customer/
// property side is matched the same conservative way as the other bulk-paste tools
// (bulk appointment import, bulk contact-info update) — anything ambiguous (more than
// one possible match) is skipped and reported back rather than guessed at. If a name
// doesn't match any existing customer at all, a new one is created (type "vacation,"
// since that's what having an owner account is normally for) rather than just
// reporting a miss — this is the same tool that would otherwise force a separate
// manual "Add customer" step for every new property. The owner side is matched by
// exact name (case-insensitive) so the same owner mentioned on multiple lines (e.g.
// one person who owns two properties) only gets created once and both properties get
// linked to it.
//
// If a property is already linked to an owner, this never re-links it or changes
// which owner it belongs to — but it DOES fill in any phone/email that owner is
// still missing from the new line's data, regardless of whether the name on this line
// matches exactly what the owner is saved as (e.g. "Chad" vs a fuller "Chad Ruhoff"
// from a different contact list — same person, same property, so still safe to
// enrich). Only ever fills blanks, never overwrites a phone/email already on file.
router.post('/bulk-link-from-text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  let customers = store.getAll('customers');
  let findCustomer = makeCustomerMatcher(customers);
  let owners = store.getAll('owners');
  const findOwnerByName = (name) => owners.find((o) => (o.name || '').trim().toLowerCase() === name.trim().toLowerCase());

  const linked = [];
  const created = [];
  const enriched = [];
  const alreadyLinked = [];
  const skippedLines = [];
  let ownersCreated = 0;

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { skippedLines.push(line); return; }
    const customerName = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
    const ownerName = parts[0] || '';
    const values = parts.slice(1);
    const email = values.find((v) => EMAIL_RE.test(v)) || '';
    const phone = values.find((v) => v && !EMAIL_RE.test(v)) || '';
    if (!customerName || !ownerName) { skippedLines.push(line); return; }

    let customer = findCustomer(customerName);
    let isNewCustomer = false;
    if (!customer) {
      customer = store.create('customers', { name: customerName, type: 'vacation', ownerId: null });
      customers = [...customers, customer];
      findCustomer = makeCustomerMatcher(customers); // keep the matcher in sync so later lines can't create a duplicate
      isNewCustomer = true;
    }

    if (customer.ownerId) {
      const existingOwner = store.getById('owners', customer.ownerId);
      if (!existingOwner) { alreadyLinked.push(`${customer.name} (linked owner account no longer exists)`); return; }
      const fill = {};
      if (phone && !existingOwner.phone) fill.phone = phone;
      if (email && !existingOwner.email) fill.email = email;
      if (Object.keys(fill).length > 0) {
        const updated = store.update('owners', existingOwner.id, fill);
        owners = owners.map((o) => (o.id === updated.id ? updated : o));
        enriched.push(`${customer.name} -> ${existingOwner.name}: added ${Object.keys(fill).join(' & ')}`);
      } else {
        alreadyLinked.push(`${customer.name} (already linked to ${existingOwner.name})`);
      }
      return;
    }

    let owner = findOwnerByName(ownerName);
    if (!owner) {
      owner = store.create('owners', {
        name: ownerName,
        email: email || '',
        phone: phone || '',
        username: '',
        passwordHash: '',
        newsletterSubscribed: true,
      });
      owners = [...owners, owner];
      ownersCreated += 1;
    } else {
      // Fill in contact info we now have for an owner that didn't have it yet —
      // never overwrites anything already on file.
      const fill = {};
      if (phone && !owner.phone) fill.phone = phone;
      if (email && !owner.email) fill.email = email;
      if (Object.keys(fill).length > 0) {
        owner = store.update('owners', owner.id, fill);
        owners = owners.map((o) => (o.id === owner.id ? owner : o));
      }
    }

    store.update('customers', customer.id, { ownerId: owner.id });
    if (isNewCustomer) {
      created.push(`${customer.name} (new property) -> ${owner.name}`);
    } else {
      linked.push(`${customer.name} -> ${owner.name}`);
    }
  });

  res.json({
    linked,
    created,
    enriched,
    linkedCount: linked.length + created.length,
    customersCreated: created.length,
    ownersCreated,
    enrichedCount: enriched.length,
    alreadyLinked,
    skippedLines,
  });
});

// Bundles this owner's already-created individual draft invoices for the given month
// (YYYY-MM, in req.body) into one combined invoice — see lib/monthlyInvoice.js. Safe to
// re-run — an invoice already bundled never gets included twice.
router.post('/:id/generate-monthly-invoice', (req, res) => {
  try {
    const invoice = generateMonthlyInvoiceForOwner(req.params.id, req.body.month);
    if (!invoice) return res.json({ created: false, message: 'Nothing to bill for that month.' });
    res.status(201).json({ created: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const linkedProperties = store.getAll('customers').filter((c) => c.ownerId === Number(req.params.id));
  linkedProperties.forEach((p) => store.update('customers', p.id, { ownerId: null }));
  const ok = store.remove('owners', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Owner not found' });
  res.status(204).end();
});

module.exports = router;
