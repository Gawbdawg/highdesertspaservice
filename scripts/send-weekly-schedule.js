// Sends the upcoming week's schedule by email: one full-week summary to the office,
// and one filtered-to-just-their-jobs email to each technician who has an email on file.
//
// Reads live data from the deployed app's API (APP_BASE_URL) rather than the local
// data file, so this works correctly whether it's run locally or as a separate
// scheduled job (e.g. a Render Cron Job) that doesn't share disk with the web service.
//
// Env vars:
//   APP_BASE_URL        Base URL of the deployed app, e.g. https://highdesertspaservice.onrender.com
//                        (defaults to http://localhost:3000 for local testing)
//   ADMIN_USERNAME       Username of an admin account (Settings tab) this script logs in as
//   ADMIN_PASSWORD       That admin account's password
//   OWNER_EMAIL          Where the full weekly schedule goes (defaults to highdesertspaservice@gmail.com)
//   GMAIL_USER            Gmail address to send FROM (App Password owner)
//   GMAIL_APP_PASSWORD    Gmail App Password (not your regular Gmail password — see README)
//
// If GMAIL_USER / GMAIL_APP_PASSWORD aren't set, this prints what it WOULD send instead
// of actually sending — handy for testing.

const { sendEmail } = require('../lib/mailer');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { fetchJson, APP_BASE_URL } = require('../lib/cronClient');

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'highdesertspaservice@gmail.com';

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function buildWeekText(appts, heading, depot) {
  if (appts.length === 0) return `${heading}\n\nNo appointments scheduled this week.`;
  const byDate = {};
  appts.forEach((a) => {
    if (!byDate[a.date]) byDate[a.date] = [];
    byDate[a.date].push(a);
  });
  const dates = Object.keys(byDate).sort();
  let text = `${heading}${depot ? ' (each day in efficient route order from the shop)' : ''}\n\n`;
  dates.forEach((date) => {
    text += `${niceDate(date)}\n`;
    let dayAppts = byDate[date];
    if (depot) {
      const { ordered, unroutable } = orderStopsByRoute(depot, dayAppts);
      dayAppts = [...ordered, ...unroutable];
    } else {
      dayAppts = [...dayAppts].sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    dayAppts.forEach((a) => {
        text += `  ${a.startTime}${a.endTime ? '-' + a.endTime : ''}  ${a.customerName}  (${a.serviceType})`;
        text += a.technicianName ? `  — ${a.technicianName}\n` : '\n';
        if (a.customerAddress) text += `      ${a.customerAddress}\n`;
      });
    text += '\n';
  });
  return text;
}

async function main() {
  const weekStart = mondayOf(new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const startStr = fmt(weekStart);
  const endStr = fmt(weekEnd);

  console.log(`Building weekly schedule for ${startStr} to ${endStr} from ${APP_BASE_URL} ...`);

  const [allAppts, technicians, settings] = await Promise.all([
    fetchJson('/api/appointments'),
    fetchJson('/api/technicians'),
    fetchJson('/api/settings'),
  ]);

  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;
  if (!depot) {
    console.log('No depot location set/geocoded yet (Settings tab) — schedules will be listed by time instead of route order.');
  }

  const weekAppts = allAppts.filter((a) => a.date >= startStr && a.date <= endStr && a.status !== 'cancelled');

  // Office/owner email — everything for the week, in time order (it covers every
  // technician at once, so a single route order across all of them isn't meaningful)
  const ownerText = buildWeekText(weekAppts, `High Desert Spa Service — Week of ${niceDate(startStr)}`, null);
  await sendEmail({
    to: OWNER_EMAIL,
    subject: `Weekly schedule — week of ${niceDate(startStr)}`,
    text: ownerText,
  });
  console.log(`Sent office schedule to ${OWNER_EMAIL}`);

  // One email per technician with an email on file — just their jobs, each day route-ordered
  for (const tech of technicians) {
    if (!tech.email) continue;
    const techAppts = weekAppts.filter((a) => a.technicianId === tech.id);
    const techText = buildWeekText(techAppts, `Hi ${tech.name}, here's your schedule for the week of ${niceDate(startStr)}`, depot);
    await sendEmail({
      to: tech.email,
      subject: `Your schedule — week of ${niceDate(startStr)}`,
      text: techText,
    });
    console.log(`Sent schedule to ${tech.name} <${tech.email}>`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed to send weekly schedule:', err);
  process.exit(1);
});
