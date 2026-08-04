const express = require('express');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const path = require('path');

const customersRouter = require('./routes/customers');
const ownersRouter = require('./routes/owners');
const techniciansRouter = require('./routes/technicians');
const appointmentsRouter = require('./routes/appointments');
const invoicesRouter = require('./routes/invoices');
const scheduleRouter = require('./routes/schedule');
const techAuthRouter = require('./routes/techAuth');
const techPortalRouter = require('./routes/techPortal');
const ownerAuthRouter = require('./routes/ownerAuth');
const ownerPortalRouter = require('./routes/ownerPortal');
const bookingsRouter = require('./routes/bookings');
const serviceRequestsRouter = require('./routes/serviceRequests');
const settingsRouter = require('./routes/settings');
const servicesRouter = require('./routes/services');
const addonsRouter = require('./routes/addons');
const timesheetsRouter = require('./routes/timesheets');
const newsletterRouter = require('./routes/newsletter');
const exportRouter = require('./routes/export');
const adminAuthRouter = require('./routes/adminAuth');
const todayRouter = require('./routes/today');
const peopleRouter = require('./routes/people');
const payRouter = require('./routes/pay');
const stripeWebhookHandler = require('./routes/stripeWebhook');
const { requireAdminAuth } = require('./lib/auth');
const { startAutoCalendarSync } = require('./lib/autoSync');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn(
    'Warning: SESSION_SECRET is not set. Using a built-in fallback, which is fine for local ' +
    'testing but should NOT be used in production — set SESSION_SECRET as an environment ' +
    'variable on your host (e.g. Render) so login sessions are signed with a private key.'
  );
}

// Stripe webhook needs the exact raw request body to verify its signature, so it's
// registered here — before the global JSON body parser would consume/parse it.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(bodyParser.json({ limit: '10mb' })); // photo uploads are sent as base64 JSON
app.use(cookieSession({
  name: 'cw_session',
  secret: process.env.SESSION_SECRET || 'highdesert-dev-only-fallback-secret-change-me',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  sameSite: 'lax',
}));
// no-cache on the app's own JS/CSS/HTML so a fresh deploy is never masked by a
// browser (or an intermediate CDN) serving a stale cached copy of a page's script —
// each request still revalidates via ETag, so this doesn't meaningfully hurt speed.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// Admin login (public — the login/setup screen itself has to be reachable without a session)
app.use('/api/admin-auth', adminAuthRouter);

// Admin API — every route below requires a logged-in admin session
app.use('/api/customers', requireAdminAuth, customersRouter);
app.use('/api/owners', requireAdminAuth, ownersRouter);
app.use('/api/technicians', requireAdminAuth, techniciansRouter);
app.use('/api/appointments', requireAdminAuth, appointmentsRouter);
app.use('/api/invoices', requireAdminAuth, invoicesRouter);
app.use('/api/schedule', requireAdminAuth, scheduleRouter);
app.use('/api/bookings', requireAdminAuth, bookingsRouter);
app.use('/api/service-requests', requireAdminAuth, serviceRequestsRouter);
app.use('/api/settings', requireAdminAuth, settingsRouter);
app.use('/api/services', requireAdminAuth, servicesRouter);
app.use('/api/addons', requireAdminAuth, addonsRouter);
app.use('/api/timesheets', requireAdminAuth, timesheetsRouter);
app.use('/api/export', requireAdminAuth, exportRouter);
app.use('/api/newsletter', requireAdminAuth, newsletterRouter);
app.use('/api/today', requireAdminAuth, todayRouter);
app.use('/api/people', requireAdminAuth, peopleRouter);

// Technician portal
app.use('/api/tech-auth', techAuthRouter);
app.use('/api/tech', techPortalRouter);
app.get('/tech', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tech.html')));

// Vacation rental owner portal
app.use('/api/owner-auth', ownerAuthRouter);
app.use('/api/owner', ownerPortalRouter);
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner.html')));

// Public invoice payment page (no login — this is what customers use to pay online)
app.use('/api/pay', payRouter);
app.get('/pay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`High Desert Spa Service running at http://localhost:${PORT}`);
  // Make sure the repair-account feature's catalog entries (Diagnostic Visit service,
  // Emergency Service addon) exist without the admin having to add them by hand —
  // matches by name, so this is a no-op after the first run. See lib/store.js.
  const seedResult = store.ensureDefaultCatalogEntries();
  if (seedResult.diagnosticServiceAdded) console.log('Added default "Diagnostic Visit" service ($125) to the catalog.');
  if (seedResult.emergencyAddonAdded) console.log('Added default "Emergency Service (within 24 hrs)" add-on ($75) to the catalog.');
  // Keep vacation-rental booking calendars fresh without anyone having to remember to
  // click "Sync now" — see lib/autoSync.js for details/caveats (only runs while the
  // app itself is awake).
  startAutoCalendarSync();
});
