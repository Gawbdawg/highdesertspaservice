// Triggers the app's iCal sync-all endpoint — re-fetches every vacation property's
// Airbnb/VRBO calendar and refreshes their booking dates. Meant to be run on a
// schedule (e.g. a Render Cron Job) since the admin/owner portals only sync on demand.
//
// Env vars:
//   APP_BASE_URL     Base URL of the deployed app, e.g. https://highdesertspaservice.onrender.com
//                    (defaults to http://localhost:3000 for local testing)
//   ADMIN_USERNAME   Username of an admin account (Settings tab) this script logs in as
//   ADMIN_PASSWORD   That admin account's password

const { authedFetch, APP_BASE_URL } = require('../lib/cronClient');

async function main() {
  console.log(`Syncing all property calendars via ${APP_BASE_URL} ...`);
  const res = await authedFetch('/api/bookings/sync-all', { method: 'POST' });
  if (!res.ok) throw new Error(`Sync request failed: ${res.status}`);
  const { results } = await res.json();
  if (results.length === 0) {
    console.log('No properties have an iCal URL set yet — nothing to sync.');
    return;
  }
  results.forEach((r) => {
    if (r.ok) console.log(`✓ ${r.customerName}: ${r.count} booked date range(s)`);
    else console.log(`✗ ${r.customerName}: ${r.error}`);
  });
}

main().catch((err) => {
  console.error('Failed to sync calendars:', err);
  process.exit(1);
});
