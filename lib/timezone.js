// The server (Render) runs in UTC, but appointment dates/times are entered and shown
// as the business's own local wall-clock time — High Desert Spa Service operates out
// of Oregon, so that's always Pacific time. Naively doing `new Date(dateStr + 'T' +
// timeStr)` interprets that string using whatever timezone the CODE happens to be
// running in, which is UTC on the server but the owner's own local time in their
// browser — for two people in different timezones (or a UTC server and a Pacific
// customer), that's two different real moments in time from the exact same string.
// That mismatch is exactly what caused the cancellation-fee bug: the browser's
// confirm-dialog warning and the server's actual fee decision disagreed about whether
// a visit was within the 24-hour window.
//
// These helpers pin every appointment date/time to this one fixed timezone, so "24
// hours before a 9am Tuesday visit" means the same real instant every time it's
// evaluated. This is the server-side (Node/CommonJS) copy — public/owner.js has an
// equivalent plain-JS version of businessTimeToUtc for the browser side, since the
// owner portal is a plain <script> include with no module bundler.
const BUSINESS_TIMEZONE = 'America/Los_Angeles';

// Given a UTC instant, returns how many minutes ahead of UTC the business's timezone's
// wall clock reads at that same instant (negative for timezones behind UTC — Pacific
// is -420 or -480 depending on daylight saving). Handles DST automatically since it's
// computed fresh for the specific instant rather than being a fixed offset.
function offsetMinutesAt(utcInstant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcInstant).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asIfUtc - utcInstant.getTime()) / 60000;
}

// Converts an appointment's date ("YYYY-MM-DD") + time ("HH:MM") — wall-clock time in
// the business's own timezone — into the real UTC Date instant it represents.
function businessTimeToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = (timeStr || '09:00').split(':').map(Number);
  // First guess treating the wall-clock numbers as UTC, then correct by the business
  // timezone's actual offset at that moment (one pass is exact except in the
  // vanishingly rare case of a visit scheduled inside a DST "spring forward" gap).
  const utcGuess = new Date(Date.UTC(y, m - 1, d, h, min || 0, 0));
  const offset = offsetMinutesAt(utcGuess);
  return new Date(utcGuess.getTime() - offset * 60000);
}

module.exports = { BUSINESS_TIMEZONE, businessTimeToUtc };
