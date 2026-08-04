// Ripple — the app's AI layer. A thin wrapper around Anthropic's Messages API for every
// piece of AI-authored copy in the new dashboard (daily briefing, visit summaries,
// payment nudges, team pulse, sentiment reads).
//
// SETUP: set ANTHROPIC_API_KEY as an environment variable on your host (e.g. Render →
// your service → Environment). Get a key at https://console.anthropic.com. Nothing here
// ever asks for or stores the key anywhere but that environment variable — same as
// SMTP_PASS/GMAIL_APP_PASSWORD/TWILIO_AUTH_TOKEN elsewhere in this app.
//
// FALLBACK: if the key isn't set (or a request fails — rate limit, network blip, etc.)
// every function below falls back to a deterministic, template-built version of the same
// text instead of throwing, so the dashboard never breaks or blocks on this being
// configured. Each function's return value includes `aiGenerated: true/false` so the UI
// can show a subtle "not yet AI-configured" hint if useful. This mirrors lib/mailer.js's
// existing dry-run-when-unconfigured pattern.

const MODEL = 'claude-haiku-4-5-20251001'; // fast + inexpensive; these are all short, low-stakes generations

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callClaude(prompt, { maxTokens = 300, system } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

// Wraps a "try real AI, fall back to a template" call so every feature below reads the
// same way and never lets an AI outage take down the page that called it.
async function withFallback(templateFn, aiFn) {
  if (!isConfigured()) return { text: templateFn(), aiGenerated: false };
  try {
    const text = await aiFn();
    if (!text) throw new Error('Empty response');
    return { text, aiGenerated: true };
  } catch (err) {
    console.error('[Ripple] AI call failed, using template fallback:', err.message);
    return { text: templateFn(), aiGenerated: false };
  }
}

const RIPPLE_SYSTEM = 'You are Ripple, the AI assistant built into High Desert Spa Service\'s office dashboard, a small hot tub/spa maintenance business. Write plainly and briefly, like a sharp office manager, not a chatbot. No greetings, no "I hope this helps," no markdown formatting, no bullet points unless asked. Just the requested text.';

// Same assistant, customer-facing voice — talking directly to the homeowner in their
// portal rather than to office staff, so the tone is warmer and always second person.
const RIPPLE_OWNER_SYSTEM = 'You are Ripple, the assistant built into High Desert Spa Service\'s customer portal, a small hot tub/spa maintenance business. You are writing directly to the customer, second person ("you"/"your"). Warm, brief, plainspoken — like a friendly front-desk note, not a chatbot or a sales pitch. No greetings like "Hi there," no markdown, no bullet points unless asked. Just the requested text.';

// ---- Daily briefing (Today surface, §5.1) ----
function templateBriefing({ jobCount, overdueJobs, unpaidInvoices, predictiveFlags, newSignups }) {
  const parts = [];
  parts.push(`${jobCount} job${jobCount === 1 ? '' : 's'} scheduled today.`);
  if (overdueJobs.length) {
    parts.push(`${overdueJobs.length} overdue job${overdueJobs.length === 1 ? '' : 's'} still need${overdueJobs.length === 1 ? 's' : ''} attention, oldest is ${overdueJobs[0].customerName} (${overdueJobs[0].daysOverdue} days).`);
  }
  if (unpaidInvoices.length) {
    const total = unpaidInvoices.reduce((s, i) => s + Number(i.amount || 0), 0);
    parts.push(`${unpaidInvoices.length} invoice${unpaidInvoices.length === 1 ? '' : 's'} overdue, $${total.toFixed(0)} total.`);
  }
  if (predictiveFlags.length) {
    parts.push(`${predictiveFlags[0].customerName} ${predictiveFlags[0].reason}.`);
  }
  if (newSignups.length) {
    parts.push(`${newSignups.length} new owner sign-up${newSignups.length === 1 ? '' : 's'} this week.`);
  }
  if (parts.length === 1) parts.push('Nothing else needs attention right now.');
  return parts.join(' ');
}

async function generateDailyBriefing(data) {
  return withFallback(
    () => templateBriefing(data),
    () => callClaude(
      `Write a 2-4 sentence morning briefing for office staff from this data:\n${JSON.stringify(data, null, 2)}\n` +
      'Mention job count, name the most urgent overdue job/invoice by name if any exist, and skip anything with an empty list. Plain prose, no headers.',
      { maxTokens: 200, system: RIPPLE_SYSTEM }
    )
  );
}

// ---- Visit summary (written after a tech marks a job done, from raw notes/chemistry) ----
function templateVisitSummary({ notes, chlorine, ph, alkalinity }) {
  const bits = [];
  if (notes) bits.push(notes.trim().replace(/\.$/, ''));
  const chem = [chlorine && `chlorine ${chlorine}`, ph && `pH ${ph}`, alkalinity && `alkalinity ${alkalinity}`].filter(Boolean);
  if (chem.length) bits.push(`Readings: ${chem.join(', ')}`);
  return bits.length ? bits.join('. ') + '.' : 'Visit completed, no notes recorded.';
}

async function generateVisitSummary(raw) {
  return withFallback(
    () => templateVisitSummary(raw),
    () => callClaude(
      `Turn this technician's raw visit notes and chemistry readings into one clean, customer-facing summary sentence or two:\n${JSON.stringify(raw, null, 2)}`,
      { maxTokens: 150, system: RIPPLE_SYSTEM }
    )
  );
}

// ---- Payment nudge draft (Money surface, §5.4) ----
function templateNudge({ customerName, amount, daysOverdue }) {
  if (daysOverdue > 20) {
    return `Hi ${customerName}, this is a second notice — invoice for $${amount} is now ${daysOverdue} days past due. Please take care of this at your earliest convenience or reach out if there's an issue with the invoice.`;
  }
  return `Hi ${customerName}, just a friendly reminder that your $${amount} invoice is ${daysOverdue} days past due. Let us know if you have any questions!`;
}

async function generatePaymentNudge(data) {
  return withFallback(
    () => templateNudge(data),
    () => callClaude(
      `Draft a short payment reminder text message for this overdue invoice:\n${JSON.stringify(data, null, 2)}\n` +
      'Tone should be gentle under 15 days overdue, and firmer (but still polite) past 20 days. One short paragraph, no subject line.',
      { maxTokens: 150, system: RIPPLE_SYSTEM }
    )
  );
}

// ---- Weekly team pulse (Team surface, §7) ----
function templateTeamPulse({ techStats }) {
  if (!techStats.length) return 'Not enough completed jobs yet this week to compare the team.';
  const sorted = [...techStats].sort((a, b) => b.jobs - a.jobs);
  const top = sorted[0];
  const rest = sorted.length > 1 ? ` ${sorted[sorted.length - 1].name} completed ${sorted[sorted.length - 1].jobs} over ${sorted[sorted.length - 1].hours}h.` : '';
  return `${top.name} completed the most jobs this week (${top.jobs} over ${top.hours}h).${rest}`.trim();
}

async function generateTeamPulse(data) {
  return withFallback(
    () => templateTeamPulse(data),
    () => callClaude(
      `Write a 2-3 sentence weekly team performance summary from this data (jobs completed and hours worked, per technician, over the last 7 days):\n${JSON.stringify(data, null, 2)}\n` +
      'Call out who did the most/least by name, using the numbers given. Plain prose.',
      { maxTokens: 200, system: RIPPLE_SYSTEM }
    )
  );
}

// ---- Sentiment read from recent message/note text (People surface, §5.3) ----
// Always returns exactly one of: warm | neutral | cool
function templateSentiment(text) {
  const t = (text || '').toLowerCase();
  const negative = ['unhappy', 'upset', 'frustrated', 'angry', 'disappointed', 'cancel', 'refund', 'unacceptable', 'terrible', 'worst', 'never again'];
  const positive = ['thank', 'great', 'love', 'appreciate', 'awesome', 'perfect', 'happy', 'wonderful', 'excellent'];
  const negHit = negative.some((w) => t.includes(w));
  const posHit = positive.some((w) => t.includes(w));
  if (negHit && !posHit) return 'cool';
  if (posHit && !negHit) return 'warm';
  return 'neutral';
}

async function generateSentiment(text) {
  if (!text || !text.trim()) return { text: 'neutral', aiGenerated: false };
  const result = await withFallback(
    () => templateSentiment(text),
    async () => {
      const out = await callClaude(
        `Read this customer message and respond with exactly one word — warm, neutral, or cool — describing their tone toward the business:\n"${text}"`,
        { maxTokens: 5, system: RIPPLE_SYSTEM }
      );
      const cleaned = out.toLowerCase().replace(/[^a-z]/g, '');
      return ['warm', 'neutral', 'cool'].includes(cleaned) ? cleaned : null;
    }
  );
  if (!['warm', 'neutral', 'cool'].includes(result.text)) {
    return { text: templateSentiment(text), aiGenerated: false };
  }
  return result;
}

// ---- Owner portal "Home" briefing — a warm, short status line for the customer ----
function templateOwnerBriefing({ nextVisitDate, pendingRequests, balanceDue, autopayEnabled }) {
  const parts = [];
  parts.push(nextVisitDate ? `Your next service is scheduled for ${nextVisitDate}.` : "You don't have a visit scheduled yet.");
  if (pendingRequests) parts.push(`${pendingRequests} request${pendingRequests === 1 ? '' : 's'} awaiting confirmation.`);
  if (balanceDue > 0) {
    parts.push(autopayEnabled
      ? `$${balanceDue.toFixed(2)} will be charged automatically via autopay.`
      : `You have a balance of $${balanceDue.toFixed(2)}.`);
  }
  return parts.join(' ');
}

async function generateOwnerBriefing(data) {
  return withFallback(
    () => templateOwnerBriefing(data),
    () => callClaude(
      `Write a warm 1-2 sentence status update for this hot tub service customer from this data:\n${JSON.stringify(data, null, 2)}\n` +
      'Mention their next visit date if set, pending requests only if nonzero, and balance due only if nonzero (say whether autopay will handle it). Plain prose, second person, no headers.',
      { maxTokens: 120, system: RIPPLE_OWNER_SYSTEM }
    )
  );
}

module.exports = {
  isConfigured,
  generateDailyBriefing,
  generateVisitSummary,
  generatePaymentNudge,
  generateTeamPulse,
  generateSentiment,
  generateOwnerBriefing,
};
