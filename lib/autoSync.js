// Runs the same iCal sync that the admin's "Sync all calendars" button and the
// scripts/sync-calendars.js cron script trigger, but on an in-process timer inside the
// web app itself — so calendars refresh automatically every few hours without anyone
// needing to set up a separate scheduled job (e.g. Render's paid Cron Jobs feature) or
// remember to click sync by hand.
//
// Caveat: this only runs while the app process itself is awake. On Render's free plan
// the service spins down after ~15 minutes with no web traffic, which pauses the timer;
// it simply runs an immediate catch-up sync as soon as the next request wakes it back
// up. On a paid/always-on plan (or any host that doesn't idle the process) this keeps
// calendars in sync continuously, every SYNC_INTERVAL_MS.
const { syncAllCalendars } = require('./icalSync');
const { scheduleAllUpcomingCheckouts } = require('./turnoverSchedule');

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let started = false;

async function runSyncCycle() {
  try {
    const results = await syncAllCalendars();
    const scheduled = scheduleAllUpcomingCheckouts();
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    console.log(
      `[auto-sync] Synced ${ok}/${results.length} property calendar(s)` +
      (failed ? ` (${failed} failed)` : '') +
      `; scheduled ${scheduled.created} new checkout appointment(s).`
    );
  } catch (err) {
    console.error('[auto-sync] Calendar sync cycle failed:', err.message);
  }
}

// Starts the recurring sync. Safe to call more than once — only the first call does
// anything, so importing/requiring this module never accidentally doubles up timers.
function startAutoCalendarSync() {
  if (started) return;
  started = true;
  console.log(`[auto-sync] Automatic iCal sync enabled — every ${SYNC_INTERVAL_MS / (60 * 60 * 1000)} hours.`);
  // Run once shortly after startup (rather than immediately) so it doesn't compete
  // with the burst of requests a fresh deploy/restart tends to get.
  setTimeout(runSyncCycle, 60 * 1000);
  setInterval(runSyncCycle, SYNC_INTERVAL_MS);
}

module.exports = { startAutoCalendarSync };
