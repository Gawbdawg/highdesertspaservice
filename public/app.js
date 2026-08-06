const state = { customers: [], owners: [], technicians: [], appointments: [], invoices: [], services: [], addons: [], serviceRequests: [], monthlyPending: [] };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Tabs ----------
// One shared toggle mechanism for every panel in the app — the 5 new top-level
// surfaces' own default views (today/peopledir/moneyqueue/teampulse) AND every
// original tab this redesign kept reachable as a "power view" (customers/owners/
// invoices/reports/technicians/timesheets/settings/newsletter/agreements/etc.) are
// all plain .tab-panel elements, switched by clicking any .tab-btn[data-tab] anywhere
// in the page — inner pill navs inside a surface, or JS calling activateTab() directly.
function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  loadTab(tab);
}
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn[data-tab]');
  if (!btn) return;
  activateTab(btn.dataset.tab);
});

function loadTab(tab) {
  if (tab === 'dashboard') loadTodaySurface();
  if (tab === 'calendar') loadAppointments();
  if (tab === 'customers') loadCustomers();
  if (tab === 'owners') loadOwners();
  if (tab === 'peopledir') loadPeopleDirectory();
  if (tab === 'technicians') loadTechnicians();
  if (tab === 'timesheets') loadTimesheets();
  if (tab === 'teampulse') loadTeamPulseSurface();
  if (tab === 'invoices') loadInvoices();
  if (tab === 'moneyqueue') loadMoneyQueue();
  if (tab === 'monthly') loadMonthlyPending();
  if (tab === 'schedule') loadSchedule();
  if (tab === 'propertycal') loadBookings();
  if (tab === 'requests') loadRequests();
  if (tab === 'reports') loadReports();
  if (tab === 'settings') loadSettingsTab();
  if (tab === 'newsletter') loadNewsletterTab();
  if (tab === 'agreements') loadAgreements();
}

// ---------- Surface nav (Today / Schedule / People / Money / Team) ----------
const SURFACE_DEFAULT_TAB = { today: 'dashboard', schedule: 'calendar', people: 'peopledir', money: 'moneyqueue', team: 'teampulse' };
function switchSurface(name) {
  document.querySelectorAll('.surface-btn').forEach((b) => b.classList.toggle('active', b.dataset.surface === name));
  document.querySelectorAll('.surface').forEach((s) => s.classList.toggle('active', s.id === 'surface-' + name));
  activateTab(SURFACE_DEFAULT_TAB[name]);
}
document.getElementById('surfaceNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.surface-btn');
  if (!btn) return;
  switchSurface(btn.dataset.surface);
});

// ---------- Settings slide-over (Settings / Newsletter / Agreements) ----------
const settingsDrawerOverlay = document.getElementById('settingsDrawerOverlay');
document.getElementById('settingsDrawerBtn').addEventListener('click', () => {
  settingsDrawerOverlay.classList.remove('hidden');
  activateTab('settings');
});
document.getElementById('settingsDrawerClose').addEventListener('click', () => settingsDrawerOverlay.classList.add('hidden'));
settingsDrawerOverlay.addEventListener('click', (e) => {
  if (e.target === settingsDrawerOverlay) settingsDrawerOverlay.classList.add('hidden');
});

// ---------- Dark mode ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('darkModeToggleLabel');
  if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}
applyTheme(localStorage.getItem('cw-theme') || 'light');
document.getElementById('darkModeToggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cw-theme', next);
  applyTheme(next);
});

// Portal links shown as hints on the Technicians/Customers/Owners tabs
document.getElementById('techPortalLink').textContent = window.location.origin + '/tech';
document.getElementById('ownerPortalLink').textContent = window.location.origin + '/owner';
document.getElementById('ownerPortalLink2').textContent = window.location.origin + '/owner';

// ---------- Modal ----------
const modalOverlay = document.getElementById('modalOverlay');
const modalBox = document.getElementById('modalBox');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
function openModal(title, bodyHtml, wide = false) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalBox.classList.toggle('wide', wide);
  modalOverlay.classList.remove('hidden');
}
function closeModal() { modalOverlay.classList.add('hidden'); modalBox.classList.remove('wide'); }
document.getElementById('modalClose').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

const textModalOverlay = document.getElementById('textModalOverlay');
const textModalTitle = document.getElementById('textModalTitle');
const textModalContent = document.getElementById('textModalContent');
function openTextModal(title, text) {
  textModalTitle.textContent = title;
  textModalContent.value = text;
  textModalOverlay.classList.remove('hidden');
}
document.getElementById('textModalClose').addEventListener('click', () => textModalOverlay.classList.add('hidden'));
textModalOverlay.addEventListener('click', (e) => { if (e.target === textModalOverlay) textModalOverlay.classList.add('hidden'); });
document.getElementById('copyTextBtn').addEventListener('click', () => {
  textModalContent.select();
  document.execCommand('copy');
});

// ---------- Today surface ----------
// Everything office staff need at a glance: a Ripple (AI)-authored briefing, who's
// clocked in and how their day's going, and a flat, priority-sorted list of things
// that need a human decision — overdue jobs, unpaid invoices, filter-change alerts,
// new owner sign-ups, pending service requests. All from one call to /api/today (see
// routes/today.js) instead of the old Dashboard's single "today's appointments" list.
let todayAttentionById = {};

async function loadTodaySurface() {
  document.getElementById('todayDate').textContent = todayStr();
  // Warm the shared state caches in the background so "View home"/"View owner"
  // actions triggered from an attention card never hit an empty state array.
  loadCustomers();
  loadOwners();

  let data;
  try {
    data = await api('/api/today');
  } catch (e) {
    document.getElementById('todayBriefingText').textContent = 'Could not load today\'s briefing: ' + e.message;
    return;
  }

  document.getElementById('todayBriefingText').textContent = data.briefing.text;

  const teamStrip = document.getElementById('todayTeamStrip');
  teamStrip.innerHTML = data.teamStatus.length
    ? data.teamStatus.map((t) => `
        <div class="team-chip ${t.clockedIn ? 'clocked-in' : ''}">
          <span class="dot"></span>
          <span class="name">${t.name}</span>
          <span class="meta">${t.jobsCompletedToday}/${t.jobsToday} jobs today${t.clockedIn ? ' · clocked in' : ''}</span>
        </div>
      `).join('')
    : '';

  todayAttentionById = {};
  data.attention.forEach((c) => { todayAttentionById[c.id] = c; });
  const attnEl = document.getElementById('todayAttention');
  attnEl.innerHTML = data.attention.length
    ? data.attention.map(renderAttentionCard).join('')
    : '<div class="attention-empty">Nothing needs attention right now — nice work.</div>';
}

function renderAttentionCard(card) {
  return `
    <div class="attention-card" data-kind="${card.kind}" id="attn-${card.id}">
      <div>
        <div class="attn-title">${card.title}</div>
        <div class="attn-subtitle">${card.subtitle}</div>
      </div>
      <button class="btn small primary" onclick="resolveAttentionCard('${card.id}')">${card.actionLabel}</button>
    </div>
  `;
}

// Handles every attention-card action from one place, branching on `kind`. The two
// "resolvable" kinds (an overdue job, an overdue invoice) perform the real action via
// the SAME endpoints the old tabs already used, then fade the card out and reload;
// the rest just navigate to where the full picture lives, since there's nothing to
// "complete" about a filter reminder or a new sign-up.
window.resolveAttentionCard = async (id) => {
  const card = todayAttentionById[id];
  if (!card) return;
  try {
    if (card.kind === 'overdue_job') {
      await api(`/api/appointments/${card.appointmentId}`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) });
    } else if (card.kind === 'unpaid_invoice') {
      const r = await api(`/api/invoices/${card.invoiceId}/send-nudge`, { method: 'POST' });
      alert((r.aiGenerated ? 'AI-drafted reminder sent' : 'Reminder sent') + ' to ' + r.to + '.' + (r.dryRun ? ' (dry run — email not configured)' : ''));
    } else if (card.kind === 'filter_due') {
      viewCustomerProfile(card.customerId);
      return;
    } else if (card.kind === 'new_signup') {
      openPersonDetail('owner', card.ownerId);
      return;
    } else if (card.kind === 'service_request') {
      switchSurface('schedule');
      activateTab('requests');
      return;
    }
  } catch (e) {
    alert('Could not do that: ' + e.message);
    return;
  }
  const el = document.getElementById('attn-' + id);
  if (el) el.classList.add('resolving');
  setTimeout(loadTodaySurface, 280);
};

// ---------- People surface ----------
// Unified directory joining owners + their linked homes, and standalone (ownerless)
// homes, into one card per real person — see routes/people.js. The old Homes/Owners
// tables are still one click away (inner pill nav) for bulk tools and power-user edits.
let peopleCache = [];

async function loadPeopleDirectory() {
  try {
    peopleCache = await api('/api/people');
  } catch (e) {
    document.getElementById('peopleList').innerHTML = `<div class="empty-state">Could not load People: ${e.message}</div>`;
    return;
  }
  renderPeopleList();
}

function renderPeopleList() {
  const search = (document.getElementById('peopleSearch').value || '').toLowerCase().trim();
  let rows = peopleCache;
  if (search) {
    rows = rows.filter((p) =>
      (p.name || '').toLowerCase().includes(search) ||
      (p.email || '').toLowerCase().includes(search) ||
      p.properties.some((pr) => (pr.address || '').toLowerCase().includes(search))
    );
  }
  const grid = document.getElementById('peopleList');
  grid.innerHTML = rows.length ? rows.map((p) => `
    <div class="person-card" onclick="openPersonDetail('${p.type}', ${p.type === 'owner' ? p.ownerId : p.customerId})">
      <div class="person-name">${p.name || 'Unnamed'}</div>
      <div class="person-meta">${p.properties.length} propert${p.properties.length === 1 ? 'y' : 'ies'}${p.email ? ' · ' + p.email : ''}</div>
      <div class="person-row">
        <span class="person-meta">${[...new Set(p.properties.map((pr) => typeLabel(pr.type)))].join(', ') || '—'}</span>
        ${p.balanceDue > 0 ? `<span class="balance-due-pill">${money(p.balanceDue)} due</span>` : ''}
      </div>
    </div>
  `).join('') : '<div class="empty-state">No people found.</div>';
}
document.getElementById('peopleSearch').addEventListener('input', renderPeopleList);
document.getElementById('newCustomerFromPeopleBtn').addEventListener('click', () => document.getElementById('newCustomerBtn').click());

function sentimentLabel(s) {
  if (s === 'warm') return 'Warm';
  if (s === 'cool') return 'Cool';
  return 'Neutral';
}

window.openPersonDetail = async (type, id) => {
  let data;
  try {
    data = await api(`/api/people/${type}/${id}`);
  } catch (e) {
    alert('Could not load this profile: ' + e.message);
    return;
  }
  const bodyHtml = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
      <div class="portal-sub" style="margin:0;">${type === 'owner' ? 'Owner account' : 'Home (no linked owner account)'}</div>
      <span class="sentiment-pill ${data.sentiment}">${sentimentLabel(data.sentiment)}${data.sentimentAiGenerated ? ' · AI' : ''}</span>
    </div>
    <div class="profile-grid">
      <div class="profile-section">
        <h3>Contact</h3>
        <div class="row"><span class="label">Email:</span> ${data.contact.email || '—'}</div>
        <div class="row"><span class="label">Phone:</span> ${data.contact.phone || '—'}</div>
        ${type === 'owner' ? `
          <div class="row"><span class="label">Agreement:</span> ${data.contact.agreedToTerms ? 'Signed' : 'Not signed'}</div>
          <div class="row"><span class="label">Autopay:</span> ${data.contact.autopayEnabled ? 'On' : 'Off'}</div>
        ` : ''}
        <div class="row"><span class="label">Balance due:</span> ${money(data.balanceDue)}</div>
        <div style="margin-top:10px;">
          <button class="btn small" onclick="${type === 'owner' ? `editOwnerFromPeople(${id})` : `editCustomerFromPeople(${id})`}">Edit</button>
        </div>
      </div>
      <div class="profile-section">
        <h3>Properties (${data.properties.length})</h3>
        ${data.properties.map((p) => `<div class="row">${p.name}${p.address ? ' — ' + p.address : ''}</div>`).join('') || '<div class="row" style="color:var(--text-faint);">None yet</div>'}
      </div>
    </div>
    ${data.dosageRecommendation.length ? `
      <div class="profile-section" style="margin-top:14px;">
        <h3><span class="ripple-tag">✨ Ripple suggests</span><br/>Dosage recommendation</h3>
        <div>${data.dosageRecommendation.map((r) => `<span class="dose-chip">${r.chemical}: ${r.amountOz} oz (~${r.amountTbsp} tbsp)</span>`).join('')}</div>
        <div class="portal-hint" style="margin:8px 0 0;">Estimated from the most recent reading (${data.dosageRecommendation.map((r) => r.reason).join('; ')}). Always confirm with a fresh test before dosing.</div>
      </div>
    ` : ''}
    ${data.equipment.length ? `
      <div class="profile-section" style="margin-top:14px;">
        <h3>Equipment</h3>
        ${data.equipment.map((e) => `<div class="row">${e.propertyName}: ${[e.brand, e.model].filter(Boolean).join(' ') || 'On file'}${e.filterLastChanged ? ` · Filter changed ${e.filterLastChanged}` : ''}</div>`).join('')}
      </div>
    ` : ''}
    <div class="profile-section" style="margin-top:14px;">
      <h3>Service history</h3>
      ${data.history.length ? data.history.map((v) => `
        <div class="visit-item">
          <div class="visit-head"><span>${v.date} — ${v.technician}</span><span>${v.serviceType || ''}</span></div>
          <div class="visit-summary">${v.summary}${v.summaryAiGenerated ? ' <span class="ripple-tag">✨</span>' : ''}</div>
        </div>
      `).join('') : '<div class="row" style="color:var(--text-faint);">No completed visits yet.</div>'}
    </div>
  `;
  openModal(data.contact.name || 'Profile', bodyHtml, true);
};

window.editCustomerFromPeople = async (id) => {
  if (!state.customers.length) state.customers = await api('/api/customers');
  if (!state.owners.length) state.owners = await api('/api/owners');
  if (!state.services.length) state.services = await api('/api/services');
  closeModal();
  editCustomer(Number(id));
};
window.editOwnerFromPeople = async (id) => {
  if (!state.owners.length) state.owners = await api('/api/owners');
  if (!state.services.length) state.services = await api('/api/services');
  closeModal();
  editOwner(Number(id));
};

// ---------- Team surface ----------
// Per-technician performance cards (jobs/hours/pay this week, clocked-in status) plus
// an AI/template weekly pulse sentence — see GET /api/technicians/pulse. The old
// Technicians/Timesheets tables are still reachable via the inner pill nav for editing
// logins, correcting a timesheet entry, etc.
async function loadTeamPulseSurface() {
  let data;
  try {
    data = await api('/api/technicians/pulse');
  } catch (e) {
    document.getElementById('teamPulseText').textContent = 'Could not load team pulse: ' + e.message;
    return;
  }
  document.getElementById('teamPulseText').textContent = data.pulse.text;

  const cardsEl = document.getElementById('teamCards');
  cardsEl.innerHTML = data.cards.length ? data.cards.map((c) => `
    <div class="tech-card" onclick="toggleTechCard(${c.technicianId})">
      <div class="tech-card-head">
        <div class="tech-avatar">${(c.name || '?')[0].toUpperCase()}</div>
        <div>
          <div class="tech-name">${c.name}</div>
          <div class="tech-meta">${c.jobsThisWeek} job${c.jobsThisWeek === 1 ? '' : 's'} this week</div>
        </div>
        <span class="tech-clock-badge ${c.clockedIn ? 'in' : 'out'}">${c.clockedIn ? 'Clocked in' : 'Clocked out'}</span>
      </div>
      <div class="tech-detail hidden" id="techDetail${c.technicianId}">
        <div><div class="label">Hours this week</div><div class="value">${c.hoursThisWeek}h</div></div>
        <div><div class="label">Pay this week</div><div class="value">${money(c.payThisWeek)}</div></div>
        <div><div class="label">Hourly rate</div><div class="value">${money(c.hourlyRate)}/hr</div></div>
        <div><div class="label">&nbsp;</div><button class="btn small" onclick="event.stopPropagation(); editTechFromTeam(${c.technicianId})">Edit</button></div>
      </div>
    </div>
  `).join('') : '<div class="empty-state">No technicians yet — add one to get started.</div>';
}
window.toggleTechCard = (id) => {
  const el = document.getElementById('techDetail' + id);
  if (el) el.classList.toggle('hidden');
};
window.editTechFromTeam = async (id) => {
  if (!state.technicians.length) state.technicians = await api('/api/technicians');
  editTech(Number(id));
};
document.getElementById('newTechFromTeamBtn').addEventListener('click', () => document.getElementById('newTechBtn').click());

// ---------- Money surface ----------
// A short "needs action" queue (draft invoices to send, overdue invoices to nudge)
// above a collapsed "recently settled" list, instead of one flat table of everything.
// Reuses the exact same send/email endpoints the old Invoices tab already used, plus
// the new AI-drafted /send-nudge endpoint for overdue reminders.
async function loadMoneyQueue() {
  let invoices;
  try {
    invoices = await api('/api/invoices');
  } catch (e) {
    document.getElementById('moneyQueue').innerHTML = `<div class="attention-empty">Could not load invoices: ${e.message}</div>`;
    return;
  }
  state.invoices = invoices;
  const today = todayStr();
  const isOverdue = (i) => i.status === 'sent' && !!i.dueDate && i.dueDate < today;
  const overdue = invoices.filter(isOverdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  // Monthly-billed/vacation-rental owners' per-job drafts accumulate for a combined
  // bill instead — they don't belong in a "needs action now" queue. See the Monthly
  // tab and routes/invoices.js#enrich's isMonthlyDeferred.
  const drafts = invoices.filter((i) => i.status === 'draft' && !i.isMonthlyDeferred);
  const paidRecent = invoices.filter((i) => i.status === 'paid')
    .sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''))
    .slice(0, 8);

  const totalOverdue = overdue.reduce((s, i) => s + Number(i.amount || 0), 0);
  document.getElementById('moneyStats').innerHTML = `
    <div class="stat-card ${overdue.length ? 'stat-overdue' : ''}"><div class="stat-label">Overdue</div><div class="stat-value">${money(totalOverdue)}</div></div>
    <div class="stat-card"><div class="stat-label">Drafts to send</div><div class="stat-value">${drafts.length}</div></div>
    <div class="stat-card"><div class="stat-label">Recently paid</div><div class="stat-value">${paidRecent.length}</div></div>
  `;

  const queueItems = [
    ...drafts.map((i) => ({ ...i, __kind: 'draft' })),
    ...overdue.map((i) => ({ ...i, __kind: 'overdue' })),
  ];
  document.getElementById('moneyQueue').innerHTML = queueItems.length ? queueItems.map((i) => `
    <div class="attention-card" data-kind="unpaid_invoice">
      <div>
        <div class="attn-title">${i.customerName} — ${money(i.amount)}</div>
        <div class="attn-subtitle">${i.__kind === 'draft' ? 'Draft — not sent yet' : `Overdue since ${i.dueDate}`}</div>
      </div>
      <div style="display:flex; gap:6px;">
        ${i.__kind === 'draft'
          ? `<button class="btn small primary" onclick="sendInvoiceFromQueue(${i.id})">Send</button>`
          : `<button class="btn small primary" onclick="sendNudgeFromQueue(${i.id})">Send AI nudge</button>`}
        <button class="btn small" onclick="viewInvoice(${i.id})">View</button>
      </div>
    </div>
  `).join('') : '<div class="attention-empty">Nothing needs action — every invoice is sent or paid.</div>';

  document.getElementById('moneySettled').innerHTML = paidRecent.length
    ? paidRecent.map((i) => `<div class="settled-row"><span>${i.customerName}</span><span>${money(i.amount)} · Paid ${i.issuedDate || ''}</span></div>`).join('')
    : '<div class="settled-row" style="justify-content:center; color:var(--text-faint);">No paid invoices yet.</div>';
}
window.sendInvoiceFromQueue = async (id) => {
  try {
    const r = await api(`/api/invoices/${id}/email`, { method: 'POST' });
    alert(r.dryRun ? `Email not configured — this was a dry run. Would have gone to ${r.to}.` : `Invoice sent to ${r.to}.`);
    loadMoneyQueue();
  } catch (e) {
    alert('Could not send invoice: ' + e.message);
  }
};
window.sendNudgeFromQueue = async (id) => {
  try {
    const r = await api(`/api/invoices/${id}/send-nudge`, { method: 'POST' });
    alert((r.aiGenerated ? 'AI-drafted reminder sent' : 'Reminder sent') + ` to ${r.to}.` + (r.dryRun ? ' (dry run — email not configured)' : ''));
    loadMoneyQueue();
  } catch (e) {
    alert('Could not send reminder: ' + e.message);
  }
};
document.getElementById('newInvoiceFromMoneyBtn').addEventListener('click', () => document.getElementById('newInvoiceBtn').click());

// ---------- Customers ----------
function typeLabel(t) {
  if (t === 'vacation') return 'Vacation rental';
  if (t === 'repair') return 'Repair';
  return 'Residential';
}

function typeBadgeClass(t) {
  if (t === 'vacation') return 'sent';
  if (t === 'repair') return 'draft';
  return 'completed';
}

// Days until a filter is "due" based on its interval — negative means overdue.
function filterDaysRemaining(equipment) {
  if (!equipment || !equipment.filterLastChanged || !equipment.filterIntervalDays) return null;
  const changed = new Date(equipment.filterLastChanged + 'T00:00:00');
  const due = new Date(changed.getTime() + Number(equipment.filterIntervalDays) * 24 * 60 * 60 * 1000);
  return Math.ceil((due - new Date()) / (24 * 60 * 60 * 1000));
}

function filterBadge(c) {
  const eq = c.equipment;
  if (!eq || (!eq.brand && !eq.model && !eq.filterType)) return '<span style="color:#9aa9ae;">—</span>';
  const label = [eq.brand, eq.model].filter(Boolean).join(' ') || eq.filterType || 'On file';
  const days = filterDaysRemaining(eq);
  if (days === null) return label;
  if (days < 0) return `${label} <span class="badge cancelled" title="Filter change overdue">Filter overdue</span>`;
  if (days <= 14) return `${label} <span class="badge scheduled" title="Filter due soon">Filter due soon</span>`;
  return label;
}

// Shows whether an address has been successfully located by the geocoder — the same
// lat/lng this depends on for route ordering (Settings → "Geocode all addresses" and
// the technician daily route). No badge at all for a blank address; that's not a
// verification failure, just nothing entered yet.
function addressStatusBadge(c) {
  if (!c.address) return '';
  if (c.lat != null && c.lng != null) {
    return `<span class="badge completed" title="${c.geocodedAddress || 'Located'}">✓ Located</span>`;
  }
  if (c.addressVerified === false) {
    return '<span class="badge cancelled" title="Could not find this address on the map — double check for typos, or open Edit and re-save">⚠ Not located</span>';
  }
  // Older record from before addresses were auto-verified, or never run through
  // "Geocode all addresses" — not a failure, just not checked yet.
  return '<span class="badge draft" title="Hasn\'t been checked against the map yet — see Settings → Geocode all addresses">Not yet located</span>';
}

function renderCustomerTable() {
  const typeFilter = document.getElementById('customerTypeFilter').value;
  const search = document.getElementById('customerSearch').value.toLowerCase().trim();
  let rows = state.customers;
  if (typeFilter) rows = rows.filter((c) => (c.type || 'residential') === typeFilter);
  if (search) {
    rows = rows.filter((c) =>
      (c.name || '').toLowerCase().includes(search) || (c.address || '').toLowerCase().includes(search)
    );
  }
  rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const tbody = document.querySelector('#customerTable tbody');
  tbody.innerHTML = rows.map((c) => `
    <tr>
      <td>${c.name}</td>
      <td><span class="badge ${typeBadgeClass(c.type)}">${typeLabel(c.type)}</span></td>
      <td>${c.phone || ''}</td>
      <td>${c.email || ''}</td>
      <td>${c.address || ''} ${addressStatusBadge(c)}</td>
      <td>${filterBadge(c)}</td>
      <td>${c.notes || ''}</td>
      <td>${c.ownerName || '—'}</td>
      <td>
        <button class="btn small" onclick="viewCustomerProfile(${c.id})">View</button>
        ${c.ownerId ? `<button class="btn small" onclick="viewOwnerPortal(${c.ownerId})">View portal</button>` : ''}
        <button class="btn small" onclick="editCustomer(${c.id})">Edit</button>
        <button class="btn small danger" onclick="deleteCustomer(${c.id})">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="9" class="empty-state">No homes found.</td></tr>';
}

window.viewOwnerPortal = async (ownerId) => {
  await api('/api/owner-auth/admin-view/' + ownerId, { method: 'POST' });
  window.open('/owner', '_blank');
};

async function loadCustomers() {
  const [customers, owners] = await Promise.all([api('/api/customers'), api('/api/owners')]);
  state.customers = customers;
  state.owners = owners;
  renderCustomerTable();
}

document.getElementById('customerTypeFilter').addEventListener('change', renderCustomerTable);
document.getElementById('customerSearch').addEventListener('input', renderCustomerTable);

function ownerSelectOptions(selectedId) {
  const options = state.owners.map((o) =>
    `<option value="${o.id}" ${o.id === selectedId ? 'selected' : ''}>${o.name}${o.username ? ' (' + o.username + ')' : ''}</option>`
  ).join('');
  return `<option value="">No owner account</option>${options}<option value="__new__">+ Create new owner account…</option>`;
}

function customerForm(c = {}) {
  const eq = c.equipment || {};
  const owner = c.ownerId ? state.owners.find((o) => o.id === c.ownerId) : null;
  const homePricing = c.customPricing || {};
  // Custom pricing here is a negotiated rate for the regular recurring "clean" — the
  // service priced by visit frequency (weekly/biweekly/monthly). Flat-priced catalog
  // entries like "Diagnostic Visit" always bill at their own listed price, so there's
  // no override field for them here (see lib/autoInvoice.js#resolvePrice).
  const frequencyServices = state.services.filter((s) => s.pricingMode === 'frequency');
  const pricingRows = frequencyServices.length
    ? frequencyServices.map((s) => {
        const ownerRate = owner && owner.customPricing ? owner.customPricing[s.id] : undefined;
        const context = [`catalog: ${serviceFreqSummary(s)}`];
        if (ownerRate !== undefined) context.push(`owner default: ${money(ownerRate)}`);
        return `
          <label style="flex-direction:row; align-items:center; justify-content:space-between; gap:10px;">
            <span>${s.name} <span style="color:var(--text-faint); font-weight:400;">(${context.join(' · ')})</span></span>
            <input type="number" step="0.01" style="width:110px;" id="f_hprice_${s.id}" value="${homePricing[s.id] !== undefined ? homePricing[s.id] : ''}" placeholder="default" />
          </label>
        `;
      }).join('')
    : '<div class="portal-hint" style="margin:0;">Add a frequency-priced service in Settings → Service catalog first, then come back here to set this home\'s custom price for it.</div>';
  return `
    <label>Name<input id="f_name" value="${c.name || ''}" /></label>
    <label>Type
      <select id="f_type">
        <option value="residential" ${(c.type || 'residential') === 'residential' ? 'selected' : ''}>Residential</option>
        <option value="vacation" ${c.type === 'vacation' ? 'selected' : ''}>Vacation rental</option>
        <option value="repair" ${c.type === 'repair' ? 'selected' : ''}>Repair</option>
      </select>
    </label>
    <label>Phone<input id="f_phone" value="${c.phone || ''}" /></label>
    <label>Email<input id="f_email" value="${c.email || ''}" /></label>
    <label>Address (required)<input id="f_address" value="${c.address || ''}" onblur="verifyAddressField()" /></label>
    <div id="addressVerifyStatus" class="portal-sub" style="margin:-6px 0 0;">${
      c.address && c.lat != null && c.lng != null
        ? (c.addressManuallyPinned ? `📍 Manually placed on the map: ${c.geocodedAddress || c.address}` : `✓ Located: ${c.geocodedAddress || c.address}`)
        : ''
    }</div>
    <div id="addressMap" class="hidden" style="height:200px; border-radius:8px; margin:0 0 4px; overflow:hidden;"></div>
    <label>Service frequency
      <select id="f_serviceFrequency" onchange="onServiceFrequencyChange()">
        <option value="" ${!c.serviceFrequency ? 'selected' : ''}>Not set</option>
        <option value="weekly" ${c.serviceFrequency === 'weekly' ? 'selected' : ''}>Weekly</option>
        <option value="biweekly" ${c.serviceFrequency === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
        <option value="every4weeks" ${c.serviceFrequency === 'every4weeks' ? 'selected' : ''}>Every 4 weeks</option>
        <option value="custom" ${c.serviceFrequency === 'custom' ? 'selected' : ''}>Custom</option>
      </select>
    </label>
    <label id="f_customFreqWrap" style="${c.serviceFrequency === 'custom' ? '' : 'display:none;'}">Custom — every N days
      <input type="number" min="1" id="f_customFrequencyDays" value="${c.customFrequencyDays || ''}" placeholder="e.g. 21" />
    </label>
    <label>Notes<textarea id="f_notes" rows="3">${c.notes || ''}</textarea></label>

    <div style="display:flex; flex-direction: column; gap: 12px; border-top: 1px solid #eef1f2; padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Hot tub equipment (optional)</div>
      <div style="display:flex; gap:10px;">
        <label style="flex:1;">Brand<input id="f_eqBrand" value="${eq.brand || ''}" placeholder="e.g. Jacuzzi" /></label>
        <label style="flex:1;">Model<input id="f_eqModel" value="${eq.model || ''}" /></label>
      </div>
      <div style="display:flex; gap:10px;">
        <label style="flex:1;">Serial number<input id="f_eqSerial" value="${eq.serialNumber || ''}" /></label>
        <label style="flex:1;">Capacity (gallons)<input id="f_eqCapacity" value="${eq.capacityGallons || ''}" /></label>
      </div>
      <label>Install date<input type="date" id="f_eqInstallDate" value="${eq.installDate || ''}" /></label>
      <div style="display:flex; gap:10px;">
        <label style="flex:1;">Filter type/size<input id="f_eqFilterType" value="${eq.filterType || ''}" placeholder="e.g. Pleatco PWW50" /></label>
        <label style="flex:1;">Filter last changed<input type="date" id="f_eqFilterChanged" value="${eq.filterLastChanged || ''}" /></label>
      </div>
      <label>Filter change reminder
        <select id="f_eqFilterInterval">
          <option value="">No reminder</option>
          <option value="30" ${String(eq.filterIntervalDays) === '30' ? 'selected' : ''}>Every month</option>
          <option value="90" ${String(eq.filterIntervalDays) === '90' ? 'selected' : ''}>Every 3 months</option>
          <option value="180" ${String(eq.filterIntervalDays) === '180' ? 'selected' : ''}>Every 6 months</option>
          <option value="365" ${String(eq.filterIntervalDays) === '365' ? 'selected' : ''}>Every year</option>
        </select>
      </label>
      <label>Equipment notes<textarea id="f_eqNotes" rows="2">${eq.notes || ''}</textarea></label>
    </div>

    <div style="display:flex; flex-direction: column; gap: 12px; border-top: 1px solid #eef1f2; padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Property owner (portal access)</div>
      <label>Owner account
        <select id="f_ownerSelect">${ownerSelectOptions(c.ownerId)}</select>
      </label>
      <div id="newOwnerFields" class="hidden" style="display:none; flex-direction: column; gap: 12px;">
        <label>Owner name<input id="f_newOwnerName" /></label>
        <label>Email<input id="f_newOwnerEmail" /></label>
        <label>Phone<input id="f_newOwnerPhone" /></label>
        <label>Username<input id="f_newOwnerUsername" autocomplete="off" /></label>
        <label>Password<input type="password" id="f_newOwnerPassword" autocomplete="new-password" /></label>
      </div>
    </div>

    <div style="display:flex; flex-direction: column; gap: 10px; border-top: 1px solid #eef1f2; padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Custom pricing for this home (optional)</div>
      <p class="portal-hint" style="margin:0;">Overrides the owner's default price (and the catalog price) for just this property — useful when the same owner is charged differently at different homes. Leave blank to use the owner's rate.</p>
      ${pricingRows}
    </div>

    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveCustomerBtn">Save</button>
    </div>
  `;
}

let lastVerifiedAddress = null; // avoids re-hitting the geocoder if the field didn't actually change

// Unlike the owner portal's map containers (static elements in owner.html, reused
// across checks), this modal's entire body gets replaced via innerHTML every time it
// opens (see openModal) — so any previous Leaflet instance is left pointing at a DOM
// node that's already gone. Simplest safe fix: always tear down and recreate rather
// than trying to reuse one across opens.
let addressMapInstance = null;

// Set (with { lat, lng, forAddress }) when the office manually clicks a spot on the
// map because the geocoder couldn't find what was typed — only actually used on save
// if the address text still matches what it was pinned for (see readCustomerForm).
let addressManualPin = null;

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

// Centered on this business's own service area — update this once you know Michael's shop location, it only affects where the manual-pin map first opens before an address is typed — so
// the manual-pin picker's first view already lands roughly in the right place when we
// have no coordinates at all to start from yet.
const DEFAULT_MAP_CENTER = { lat: 44.0582, lng: -121.3153 }; // placeholder: Bend, OR

function showAddressMap(lat, lng, label) {
  const container = document.getElementById('addressMap');
  if (!container) return;
  container.classList.remove('hidden');
  if (addressMapInstance) {
    try { addressMapInstance.remove(); } catch (e) { /* container already gone — fine */ }
    addressMapInstance = null;
  }
  addressMapInstance = L.map('addressMap').setView([lat, lng], 16);
  L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(addressMapInstance);
  L.marker([lat, lng]).addTo(addressMapInstance).bindPopup(label || '');
  setTimeout(() => addressMapInstance && addressMapInstance.invalidateSize(), 0);
}

// Fallback for when the text search can't find a real address (misspelling, a street
// too new/obscure for the free geocoder, etc.) — shows a map the office can click to
// mark the actual spot themselves instead of being stuck. Clicking again just moves
// the pin. Same always-tear-down-and-recreate approach as showAddressMap, for the same
// reason (the modal's DOM is fully replaced each time it opens).
function enableAddressManualPinPicker(center, onPick) {
  const container = document.getElementById('addressMap');
  if (!container) return;
  container.classList.remove('hidden');
  if (addressMapInstance) {
    try { addressMapInstance.remove(); } catch (e) { /* container already gone — fine */ }
    addressMapInstance = null;
  }
  addressMapInstance = L.map('addressMap').setView([center.lat, center.lng], 13);
  L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(addressMapInstance);
  let marker = null;
  addressMapInstance.on('click', (e) => {
    if (marker) marker.setLatLng(e.latlng);
    else marker = L.marker(e.latlng).addTo(addressMapInstance);
    onPick(e.latlng.lat, e.latlng.lng);
  });
  setTimeout(() => addressMapInstance && addressMapInstance.invalidateSize(), 0);
}

function hideAddressMap() {
  if (addressMapInstance) {
    try { addressMapInstance.remove(); } catch (e) { /* already gone */ }
    addressMapInstance = null;
  }
  const container = document.getElementById('addressMap');
  if (container) container.classList.add('hidden');
}

window.verifyAddressField = async () => {
  const input = document.getElementById('f_address');
  const statusEl = document.getElementById('addressVerifyStatus');
  const address = input.value.trim();
  if (!address) { statusEl.textContent = ''; lastVerifiedAddress = null; addressManualPin = null; hideAddressMap(); return; }
  if (address === lastVerifiedAddress) return;
  addressManualPin = null; // address text changed — any earlier manual pin no longer applies
  statusEl.textContent = 'Checking address…';
  try {
    const result = await api('/api/customers/verify-address', { method: 'POST', body: JSON.stringify({ address }) });
    lastVerifiedAddress = address;
    if (result.found) {
      statusEl.innerHTML = `<span style="color:#256b32;">✓ Found: ${result.displayName}</span>`;
      showAddressMap(result.lat, result.lng, result.displayName);
    } else {
      statusEl.innerHTML = `<span style="color:#a3382f;">⚠ Couldn't find this address automatically — click the map below to mark the exact spot, and we'll save that location instead.</span>`;
      enableAddressManualPinPicker(DEFAULT_MAP_CENTER, (lat, lng) => {
        addressManualPin = { lat, lng, forAddress: address };
        statusEl.innerHTML = `<span style="color:#256b32;">📍 Location set manually — ready to save.</span>`;
      });
    }
  } catch (e) {
    statusEl.textContent = '';
    hideAddressMap();
  }
};

window.onServiceFrequencyChange = () => {
  const wrap = document.getElementById('f_customFreqWrap');
  wrap.style.display = document.getElementById('f_serviceFrequency').value === 'custom' ? '' : 'none';
};

function wireOwnerSelectToggle() {
  const select = document.getElementById('f_ownerSelect');
  const newFields = document.getElementById('newOwnerFields');
  const sync = () => { newFields.style.display = select.value === '__new__' ? 'flex' : 'none'; };
  select.addEventListener('change', sync);
  sync();
}

document.getElementById('newCustomerBtn').addEventListener('click', async () => {
  if (state.services.length === 0) state.services = await api('/api/services');
  openModal('New Home', customerForm());
  addressMapInstance = null; // previous modal's map (if any) was on a DOM node that's now gone
  lastVerifiedAddress = null;
  addressManualPin = null;
  wireOwnerSelectToggle();
  document.getElementById('saveCustomerBtn').addEventListener('click', async () => {
    try {
      await api('/api/customers', { method: 'POST', body: JSON.stringify(readCustomerForm()) });
      closeModal(); loadCustomers();
    } catch (e) {
      alert('Could not save home: ' + e.message);
    }
  });
});

function readCustomerForm() {
  const data = {
    name: document.getElementById('f_name').value,
    type: document.getElementById('f_type').value,
    phone: document.getElementById('f_phone').value,
    email: document.getElementById('f_email').value,
    address: document.getElementById('f_address').value,
    serviceFrequency: document.getElementById('f_serviceFrequency').value || null,
    customFrequencyDays: document.getElementById('f_serviceFrequency').value === 'custom'
      ? (document.getElementById('f_customFrequencyDays').value || null) : null,
    notes: document.getElementById('f_notes').value,
    equipment: {
      brand: document.getElementById('f_eqBrand').value,
      model: document.getElementById('f_eqModel').value,
      serialNumber: document.getElementById('f_eqSerial').value,
      capacityGallons: document.getElementById('f_eqCapacity').value,
      installDate: document.getElementById('f_eqInstallDate').value,
      filterType: document.getElementById('f_eqFilterType').value,
      filterLastChanged: document.getElementById('f_eqFilterChanged').value,
      filterIntervalDays: document.getElementById('f_eqFilterInterval').value || null,
      notes: document.getElementById('f_eqNotes').value,
    },
  };
  const ownerSelectVal = document.getElementById('f_ownerSelect').value;
  if (ownerSelectVal === '__new__') {
    data.newOwner = {
      name: document.getElementById('f_newOwnerName').value,
      email: document.getElementById('f_newOwnerEmail').value,
      phone: document.getElementById('f_newOwnerPhone').value,
      username: document.getElementById('f_newOwnerUsername').value,
      password: document.getElementById('f_newOwnerPassword').value,
    };
  } else {
    data.ownerId = ownerSelectVal || null;
  }
  const customPricing = {};
  state.services.filter((s) => s.pricingMode === 'frequency').forEach((s) => {
    const el = document.getElementById(`f_hprice_${s.id}`);
    if (el && el.value !== '') customPricing[s.id] = el.value;
  });
  data.customPricing = customPricing;
  // Only actually attach the manually-placed pin if the address text hasn't changed
  // since it was set — editing the address after pinning should invalidate the old
  // pin rather than silently attaching it to different text.
  if (addressManualPin && addressManualPin.forAddress === data.address.trim()) {
    data.manualLat = addressManualPin.lat;
    data.manualLng = addressManualPin.lng;
  }
  return data;
}

window.editCustomer = async (id) => {
  if (state.services.length === 0) state.services = await api('/api/services');
  const c = state.customers.find((x) => x.id === id);
  openModal('Edit Home', customerForm(c));
  addressMapInstance = null; // previous modal's map (if any) was on a DOM node that's now gone
  addressManualPin = null;
  if (c.lat != null && c.lng != null) {
    lastVerifiedAddress = c.address || null;
    showAddressMap(c.lat, c.lng, c.geocodedAddress || c.address);
  } else {
    lastVerifiedAddress = null;
  }
  wireOwnerSelectToggle();
  document.getElementById('saveCustomerBtn').addEventListener('click', async () => {
    try {
      await api('/api/customers/' + id, { method: 'PUT', body: JSON.stringify(readCustomerForm()) });
      closeModal(); loadCustomers();
    } catch (e) {
      alert('Could not save home: ' + e.message);
    }
  });
};

window.deleteCustomer = async (id) => {
  if (!confirm('Delete this home? This does not delete their appointments/invoices.')) return;
  try {
    await api('/api/customers/' + id, { method: 'DELETE' });
    loadCustomers();
  } catch (e) {
    alert('Could not delete home: ' + e.message);
  }
};

window.viewCustomerProfile = async (id) => {
  let c;
  try {
    c = await api('/api/customers/' + id);
  } catch (e) {
    alert('Could not load this home: ' + e.message);
    return;
  }
  const eq = c.equipment || {};
  const hasEquipment = eq.brand || eq.model || eq.filterType;

  const apptRows = (c.appointments || []).map((a) => {
    const chem = [a.chlorine && `Cl ${a.chlorine}`, a.ph && `pH ${a.ph}`, a.alkalinity && `Alk ${a.alkalinity}`].filter(Boolean).join(' · ');
    const photoCount = (a.photos || []).length;
    return `
      <div class="profile-history-item">
        <div style="display:flex; justify-content:space-between; gap:8px;">
          <strong>${niceDateShort(a.date)}</strong>
          <span class="badge ${a.status}">${a.status}</span>
        </div>
        <div style="color:#5a7078;">${a.serviceType || ''}${a.technicianName ? ' · ' + a.technicianName : ''}</div>
        ${chem ? `<div style="color:#5a7078;">${chem}</div>` : ''}
        ${photoCount ? `<div style="color:#5a7078;">${photoCount} photo(s)</div>` : ''}
      </div>
    `;
  }).join('') || '<div class="empty-state">No appointments yet.</div>';

  const invRows = (c.invoices || []).map((i) => `
    <div class="profile-history-item">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <strong>${money(i.amount)}</strong>
        <span class="badge ${i.status}">${i.status}</span>
      </div>
      <div style="color:#5a7078;">${i.issuedDate || ''}${i.dueDate ? ' · due ' + i.dueDate : ''}</div>
    </div>
  `).join('') || '<div class="empty-state">No invoices yet.</div>';

  const html = `
    <div class="profile-grid">
      <div class="profile-section">
        <h3>Contact</h3>
        <div class="row"><span class="label">Type:</span> ${typeLabel(c.type)}</div>
        <div class="row"><span class="label">Phone:</span> ${c.phone || '—'}</div>
        <div class="row"><span class="label">Email:</span> ${c.email || '—'}</div>
        <div class="row"><span class="label">Address:</span> ${c.address || '—'} ${addressStatusBadge(c)}</div>
        <div class="row"><span class="label">Service frequency:</span> ${frequencyLabel(c)}</div>
        <div class="row"><span class="label">Owner:</span> ${c.ownerName || '—'}</div>
        ${c.notes ? `<div class="row"><span class="label">Notes:</span> ${c.notes}</div>` : ''}
      </div>
      <div class="profile-section">
        <h3>Equipment</h3>
        ${hasEquipment ? `
          <div class="row"><span class="label">Model:</span> ${[eq.brand, eq.model].filter(Boolean).join(' ') || '—'}</div>
          <div class="row"><span class="label">Serial:</span> ${eq.serialNumber || '—'}</div>
          <div class="row"><span class="label">Capacity:</span> ${eq.capacityGallons ? eq.capacityGallons + ' gal' : '—'}</div>
          <div class="row"><span class="label">Filter:</span> ${eq.filterType || '—'}</div>
          <div class="row"><span class="label">Filter status:</span> ${filterBadge(c)}</div>
        ` : '<div class="row" style="color:#7a8f97;">No equipment on file yet.</div>'}
      </div>
    </div>
    <div class="profile-grid">
      <div class="profile-section">
        <h3>Appointment history</h3>
        <div style="max-height:260px; overflow-y:auto;">${apptRows}</div>
      </div>
      <div class="profile-section">
        <h3>Invoice history</h3>
        <div style="max-height:260px; overflow-y:auto;">${invRows}</div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      ${c.serviceFrequency ? `<button class="btn" onclick="openScheduleRecurringModal(${c.id}, '${c.name.replace(/'/g, "\\'")}')">Schedule recurring visits</button>` : ''}
      <button class="btn primary" onclick="closeModal(); editCustomer(${c.id});">Edit home</button>
    </div>
  `;
  openModal(c.name, html, true);
};

function frequencyLabel(c) {
  const labels = { weekly: 'Weekly', biweekly: 'Every 2 weeks', every4weeks: 'Every 4 weeks', custom: `Every ${c.customFrequencyDays || '?'} days` };
  return c.serviceFrequency ? (labels[c.serviceFrequency] || c.serviceFrequency) : 'Not set';
}

window.openScheduleRecurringModal = async (customerId, customerName) => {
  if (state.technicians.length === 0) state.technicians = await api('/api/technicians');
  if (state.services.length === 0) state.services = await api('/api/services');
  if (state.appointments.length === 0) state.appointments = await api('/api/appointments');
  // Defaults to this customer's most recently-used service (or the catalog's only
  // service, if there's just one) so this whole recurring series is billable from the
  // start — leaving it on "Custom / none" here is the single biggest source of
  // completed-but-unbilled jobs, since one click here creates a long run of visits.
  const priorAppt = state.appointments
    .filter((a) => a.customerId === customerId && a.serviceId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const defaultServiceId = priorAppt ? priorAppt.serviceId : (state.services.length === 1 ? state.services[0].id : '');
  const html = `
    <p class="portal-sub" style="margin:0 0 8px;">Generates the actual recurring visits on the calendar from this customer's saved service frequency (${frequencyLabel(state.customers.find((x) => x.id === customerId) || {})}), starting from a date you pick below.</p>
    <label>First visit date<input type="date" id="f_srDate" value="${todayStr()}" /></label>
    <!-- Jobs aren't scheduled to a time slot, just a day (see the main appointment form
         for the same pattern) — this hidden field just keeps older sort-by-time
         fallback code elsewhere working with a consistent placeholder. -->
    <input type="hidden" id="f_srTime" value="09:00" />
    <label>Technician<select id="f_srTech">${techOptions(null)}</select></label>
    <label>Service <span style="font-weight:400; color:#7a8f97;">(picks a price for auto-invoicing — leaving this on "Custom / none" means these visits won't invoice automatically when completed)</span>
      <select id="f_srService">
        <option value="">Custom / none</option>
        ${state.services.map((s) => `<option value="${s.id}" ${String(s.id) === String(defaultServiceId) ? 'selected' : ''}>${s.name}</option>`).join('')}
      </select>
    </label>
    <div id="scheduleRecurringError" class="portal-error hidden"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="scheduleRecurringRunBtn">Schedule visits</button>
    </div>
  `;
  openModal(`Schedule recurring visits — ${customerName}`, html);
  document.getElementById('scheduleRecurringRunBtn').addEventListener('click', async () => {
    const btn = document.getElementById('scheduleRecurringRunBtn');
    const errEl = document.getElementById('scheduleRecurringError');
    errEl.classList.add('hidden');
    btn.disabled = true;
    try {
      const result = await api(`/api/customers/${customerId}/schedule-recurring`, {
        method: 'POST',
        body: JSON.stringify({
          startDate: document.getElementById('f_srDate').value,
          startTime: document.getElementById('f_srTime').value,
          technicianId: document.getElementById('f_srTech').value || null,
          serviceId: document.getElementById('f_srService').value || null,
        }),
      });
      alert(`Scheduled ${result.created} visit(s) on the calendar.`);
      closeModal();
      loadAppointments();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
};

function niceDateShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// A "New sign-up" badge for owners who created their OWN account through the owner
// portal's sign-up page in the last 3 days (see signupSource in routes/ownerAuth.js) —
// owners the admin created themselves (Owners tab, bulk-link tool) never get this,
// since the admin already knows about those.
function recentSelfSignupBadge(o) {
  if (o.signupSource !== 'self' || !o.createdAt) return '';
  const ageMs = Date.now() - new Date(o.createdAt).getTime();
  if (ageMs > 3 * 24 * 60 * 60 * 1000) return '';
  return '<span class="badge sent" title="Created their own account via the owner portal sign-up page">New sign-up</span>';
}

// ---------- Owners ----------
async function loadOwners() {
  state.owners = await api('/api/owners');
  renderOwnerTable();
}

function renderOwnerTable() {
  const filterEl = document.getElementById('ownerTypeFilter');
  const filter = filterEl ? filterEl.value : '';
  let owners = filter
    ? state.owners.filter((o) => (o.propertyTypes || []).includes(filter))
    : state.owners;
  const searchEl = document.getElementById('ownerSearchInput');
  const search = searchEl ? searchEl.value.trim().toLowerCase() : '';
  if (search) {
    owners = owners.filter((o) => (o.name || '').toLowerCase().includes(search));
  }
  const tbody = document.querySelector('#ownerTable tbody');
  tbody.innerHTML = owners.map((o) => `
    <tr>
      <td>${o.name} ${recentSelfSignupBadge(o)}</td>
      <td>${ownerTypeBadges(o.propertyTypes)}</td>
      <td>${o.phone || ''}</td>
      <td>${o.email || ''}</td>
      <td>${o.username || '—'}</td>
      <td>${o.propertyCount}</td>
      <td>${o.billingMode === 'monthly' ? `<span class="badge draft">Monthly${o.monthlyBundleScope === 'property' ? ' — per house' : ''}</span>` : '<span class="badge scheduled">Per job</span>'}</td>
      <td>${o.autopayEnabled
        ? `<span class="badge completed">On${o.autopayCardLast4 ? ` · ${(o.autopayCardBrand || 'card').replace(/^\w/, (c) => c.toUpperCase())} ${o.autopayCardLast4}` : ''}</span>`
        : '<span style="color:var(--text-faint); font-size:12px;">Off</span>'}</td>
      <td>${o.hasPassword ? '<span class="badge completed">Yes</span>' : '<span class="badge scheduled">Not set</span>'}</td>
      <td>
        ${o.billingMode === 'monthly' ? `<button class="btn small primary" onclick="generateMonthlyInvoice(${o.id}, '${o.name.replace(/'/g, "\\'")}')">Generate monthly invoice</button>` : ''}
        <button class="btn small" onclick="viewOwnerPortal(${o.id})">View portal</button>
        <button class="btn small" onclick="editOwner(${o.id})">Edit</button>
        <button class="btn small danger" onclick="deleteOwner(${o.id})">Delete</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="10" class="empty-state">${
    state.owners.length === 0
      ? 'No owner accounts yet. Create one from the Homes tab when editing a home.'
      : 'No owners match your search/filter.'
  }</td></tr>`;
}

document.getElementById('ownerTypeFilter').addEventListener('change', renderOwnerTable);
document.getElementById('ownerSearchInput').addEventListener('input', renderOwnerTable);

// Same badge language as the Homes tab's Vacation rental / Residential / Repair type
// — an owner can show more than one if their linked homes are a mix, or neither yet
// if they have no homes linked at all.
function ownerTypeBadges(propertyTypes) {
  const types = propertyTypes || [];
  if (types.length === 0) return '<span style="color:var(--text-faint); font-size:12px;">No homes yet</span>';
  return types.map((t) => `<span class="badge ${typeBadgeClass(t)}">${typeLabel(t)}</span>`).join(' ');
}

function ownerForm(o = {}) {
  const pricing = o.customPricing || {};
  // Same scope restriction as the home-level pricing panel: only the frequency-priced
  // "clean" service gets a custom-rate override here. Flat-priced entries like
  // Diagnostic Visit always bill at their catalog price.
  const frequencyServices = state.services.filter((s) => s.pricingMode === 'frequency');
  const pricingRows = frequencyServices.length
    ? frequencyServices.map((s) => `
        <label style="flex-direction:row; align-items:center; justify-content:space-between; gap:10px;">
          <span>${s.name} <span style="color:var(--text-faint); font-weight:400;">(catalog: ${money(s.defaultPrice)})</span></span>
          <input type="number" step="0.01" style="width:110px;" id="f_price_${s.id}" value="${pricing[s.id] !== undefined ? pricing[s.id] : ''}" placeholder="default" />
        </label>
      `).join('')
    : '<div class="portal-hint" style="margin:0;">Add a frequency-priced service in Settings → Service catalog first, then come back here to set this owner\'s custom price for it.</div>';
  return `
    <label>Name (required)<input id="f_oname" value="${o.name || ''}" /></label>
    <label>Phone<input id="f_ophone" value="${o.phone || ''}" /></label>
    <label>Email<input id="f_oemail" value="${o.email || ''}" /></label>
    <label>Username<input id="f_ousername" value="${o.username || ''}" autocomplete="off" /></label>
    <label>Password ${o.id ? '<span style="font-weight:400;">(leave blank to keep current)</span>' : ''}<input type="password" id="f_opassword" autocomplete="new-password" /></label>
    <label>Billing
      <select id="f_obillingMode" onchange="window.toggleOwnerBundleScope()">
        <option value="perJob" ${o.billingMode !== 'monthly' ? 'selected' : ''}>Per job (invoice as each visit is completed)</option>
        <option value="monthly" ${o.billingMode === 'monthly' ? 'selected' : ''}>Monthly combined (still invoices each visit individually — use "Generate monthly invoice" to bundle them into one bill at month end)</option>
      </select>
    </label>
    <label id="f_obundleScopeWrap" class="${o.billingMode === 'monthly' ? '' : 'hidden'}">
      Monthly billing — one invoice per…
      <select id="f_obundleScope">
        <option value="owner" ${o.monthlyBundleScope !== 'property' ? 'selected' : ''}>Owner (every property bundled into one combined bill)</option>
        <option value="property" ${o.monthlyBundleScope === 'property' ? 'selected' : ''}>Property (each house gets its own monthly bill)</option>
      </select>
    </label>
    <label style="flex-direction:row; align-items:center; gap:8px;">
      <input type="checkbox" id="f_onewsletter" ${o.newsletterSubscribed !== false ? 'checked' : ''} style="width:auto;" />
      <span>Subscribed to newsletter updates</span>
    </label>

    <div style="display:flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Custom pricing (optional)</div>
      <p class="portal-hint" style="margin:0;">Overrides the catalog price for every property linked to this owner. Leave blank to use the catalog default.</p>
      ${pricingRows}
    </div>

    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveOwnerBtn">Save</button>
    </div>
  `;
}

// Shows the "one invoice per owner / per property" choice only when Monthly combined
// billing is selected — it's meaningless under per-job billing, where there's no
// bundling step to scope in the first place.
window.toggleOwnerBundleScope = () => {
  const monthly = document.getElementById('f_obillingMode').value === 'monthly';
  document.getElementById('f_obundleScopeWrap').classList.toggle('hidden', !monthly);
};

function readOwnerForm() {
  const customPricing = {};
  state.services.filter((s) => s.pricingMode === 'frequency').forEach((s) => {
    const el = document.getElementById(`f_price_${s.id}`);
    if (el && el.value !== '') customPricing[s.id] = el.value;
  });
  return {
    name: document.getElementById('f_oname').value,
    phone: document.getElementById('f_ophone').value,
    email: document.getElementById('f_oemail').value,
    username: document.getElementById('f_ousername').value,
    password: document.getElementById('f_opassword').value,
    billingMode: document.getElementById('f_obillingMode').value,
    monthlyBundleScope: document.getElementById('f_obundleScope').value,
    newsletterSubscribed: document.getElementById('f_onewsletter').checked,
    customPricing,
  };
}

document.getElementById('newOwnerBtn').addEventListener('click', async () => {
  if (state.services.length === 0) state.services = await api('/api/services');
  openModal('New Owner', ownerForm(), true);
  document.getElementById('saveOwnerBtn').addEventListener('click', async () => {
    try {
      await api('/api/owners', { method: 'POST', body: JSON.stringify(readOwnerForm()) });
      closeModal(); loadOwners();
    } catch (e) {
      alert('Could not save owner: ' + e.message);
    }
  });
});

window.editOwner = async (id) => {
  if (state.services.length === 0) state.services = await api('/api/services');
  const o = state.owners.find((x) => x.id === id);
  openModal('Edit Owner', ownerForm(o), true);
  document.getElementById('saveOwnerBtn').addEventListener('click', async () => {
    try {
      await api('/api/owners/' + id, { method: 'PUT', body: JSON.stringify(readOwnerForm()) });
      closeModal(); loadOwners();
    } catch (e) {
      alert('Could not save owner: ' + e.message);
    }
  });
};

window.generateMonthlyInvoice = async (ownerId, ownerName) => {
  const defaultMonth = todayStr().slice(0, 7);
  const month = prompt(`Generate this month's invoice(s) for ${ownerName} — which month? (YYYY-MM)`, defaultMonth);
  if (!month) return;
  try {
    const result = await api(`/api/owners/${ownerId}/generate-monthly-invoice`, {
      method: 'POST', body: JSON.stringify({ month }),
    });
    if (result.created) {
      // Always an array now — 1 item for the normal "everything combined" scope, 0-N
      // for "one bill per property" (a property with nothing to bill that month is
      // just skipped, not billed $0), see lib/monthlyInvoice.js.
      const invoices = result.invoices;
      if (invoices.length === 1) {
        alert(`Created a combined invoice for ${money(invoices[0].amount)}.`);
      } else {
        const total = invoices.reduce((sum, inv) => sum + Number(inv.amount || 0), 0);
        alert(`Created ${invoices.length} invoices (one per property) totaling ${money(total)}.`);
      }
    } else {
      alert(result.message || 'Nothing to bill for that month.');
    }
  } catch (e) {
    alert('Could not generate invoice: ' + e.message);
  }
  // Refresh whichever of these panels is currently on screen — bundling changes
  // both the Monthly tab's pending totals and the classic Invoices table/queue.
  if (document.getElementById('monthlyPendingTable')) loadMonthlyPending();
  if (document.getElementById('invoiceTable') && document.getElementById('tab-invoices').classList.contains('active')) loadInvoices();
  if (document.getElementById('moneyQueue') && document.getElementById('tab-moneyqueue').classList.contains('active')) loadMoneyQueue();
};

window.deleteOwner = async (id) => {
  if (!confirm('Delete this owner account? Any linked properties will be unlinked, not deleted.')) return;
  try {
    await api('/api/owners/' + id, { method: 'DELETE' });
    loadOwners();
  } catch (e) {
    alert('Could not delete owner: ' + e.message);
  }
};

document.getElementById('bulkCreateOwnersBtn').addEventListener('click', async () => {
  if (!confirm(
    "Create an owner account for every home that doesn't have one yet? " +
    'Homes sharing an email or phone number will be grouped onto one account. ' +
    'No passwords are set — accounts can\'t log in until you add one.'
  )) return;
  const btn = document.getElementById('bulkCreateOwnersBtn');
  btn.disabled = true;
  try {
    const result = await api('/api/owners/bulk-create-from-customers', { method: 'POST' });
    alert(
      `Created ${result.ownersCreated} owner account(s) and linked ${result.customersLinked} home(s).` +
      (result.alreadyLinked ? `\n${result.alreadyLinked} home(s) already had an owner and were left alone.` : '')
    );
    await loadOwners();
    await loadCustomers();
  } catch (e) {
    alert('Could not auto-link owners: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Technicians ----------
async function loadTechnicians() {
  state.technicians = await api('/api/technicians');
  const tbody = document.querySelector('#techTable tbody');
  tbody.innerHTML = state.technicians.map((t) => `
    <tr>
      <td>${t.name}</td>
      <td>${t.phone || ''}</td>
      <td>${t.email || ''}</td>
      <td>${t.hourlyRate ? money(t.hourlyRate) + '/hr' : '<span style="color:var(--text-faint);">Not set</span>'}</td>
      <td>${t.username || '—'}</td>
      <td>${t.hasPassword ? '<span class="badge completed">Yes</span>' : '<span class="badge scheduled">Not set</span>'}</td>
      <td>${renderTechTimeOff(t)}</td>
      <td>
        <button class="btn small" onclick="viewTechPortal(${t.id})">View portal</button>
        <button class="btn small" onclick="editTech(${t.id})">Edit</button>
        <button class="btn small danger" onclick="deleteTech(${t.id})">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty-state">No technicians yet.</td></tr>';
}

// Self-blocked days the tech set from their own portal (see routes/techPortal.js
// #/time-off) — today-forward only. Nothing here prevents scheduling that tech that
// day; it's purely visibility so a conflict can be worked out, with a quick way to
// clear an entry if it's no longer needed.
function renderTechTimeOff(t) {
  const timeOff = t.timeOff || [];
  if (timeOff.length === 0) return '<span style="color:var(--text-faint); font-size:12px;">None</span>';
  return timeOff.map((entry) => `
    <span class="badge draft" style="margin:0 4px 4px 0; display:inline-flex; align-items:center; gap:5px;">
      ${niceDateShort(entry.date)}
      <a href="#" onclick="removeTechTimeOff(${t.id}, ${entry.id}); return false;" style="color:inherit; text-decoration:none; font-weight:700;" title="Remove">×</a>
    </span>
  `).join('');
}

window.removeTechTimeOff = async (techId, timeOffId) => {
  await api(`/api/technicians/${techId}/time-off/${timeOffId}`, { method: 'DELETE' });
  loadTechnicians();
};

window.viewTechPortal = async (id) => {
  await api('/api/tech-auth/admin-view/' + id, { method: 'POST' });
  window.open('/tech', '_blank');
};

function techForm(t = {}) {
  return `
    <label>Name<input id="f_tname" value="${t.name || ''}" /></label>
    <label>Phone<input id="f_tphone" value="${t.phone || ''}" /></label>
    <label>Email<input id="f_temail" value="${t.email || ''}" /></label>
    <label>Hourly rate <span style="font-weight:400; color:var(--text-faint);">(used to compute pay from clocked hours)</span><input type="number" step="0.01" min="0" id="f_thourlyrate" value="${t.hourlyRate || ''}" placeholder="e.g. 22.00" /></label>
    <div style="display:flex; flex-direction: column; gap: 12px; border-top: 1px solid #eef1f2; padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Technician portal login</div>
      <label>Username<input id="f_tusername" value="${t.username || ''}" autocomplete="off" /></label>
      <label>Password ${t.id ? '<span style="font-weight:400;">(leave blank to keep current)</span>' : ''}<input type="password" id="f_tpassword" autocomplete="new-password" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveTechBtn">Save</button>
    </div>
  `;
}

document.getElementById('newTechBtn').addEventListener('click', () => {
  openModal('New Technician', techForm());
  document.getElementById('saveTechBtn').addEventListener('click', async () => {
    try {
      await api('/api/technicians', { method: 'POST', body: JSON.stringify(readTechForm()) });
      closeModal(); loadTechnicians();
    } catch (e) {
      alert('Could not save technician: ' + e.message);
    }
  });
});

function readTechForm() {
  return {
    name: document.getElementById('f_tname').value,
    phone: document.getElementById('f_tphone').value,
    email: document.getElementById('f_temail').value,
    hourlyRate: document.getElementById('f_thourlyrate').value,
    username: document.getElementById('f_tusername').value,
    password: document.getElementById('f_tpassword').value,
  };
}

window.editTech = (id) => {
  const t = state.technicians.find((x) => x.id === id);
  openModal('Edit Technician', techForm(t));
  document.getElementById('saveTechBtn').addEventListener('click', async () => {
    try {
      await api('/api/technicians/' + id, { method: 'PUT', body: JSON.stringify(readTechForm()) });
      closeModal(); loadTechnicians();
    } catch (e) {
      alert('Could not save technician: ' + e.message);
    }
  });
};

window.deleteTech = async (id) => {
  if (!confirm('Delete this technician?')) return;
  try {
    await api('/api/technicians/' + id, { method: 'DELETE' });
    loadTechnicians();
  } catch (e) {
    alert('Could not delete technician: ' + e.message);
  }
};

// ---------- Timesheets / Payroll ----------
// Each row is one technician's total hours + pay for one day, computed server-side
// (lib/timesheet.js) from every clock-in/out session the tech recorded in their own
// portal that day, plus the $10 gas stipend when it applies. Filterable by technician
// and date range for running an actual payroll period.
let timesheetDays = [];

async function loadTimesheets() {
  const techSelect = document.getElementById('timesheetTechFilter');
  if (techSelect.options.length <= 1) {
    techSelect.innerHTML = '<option value="">All technicians</option>' +
      state.technicians.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  }

  const params = new URLSearchParams();
  const techId = document.getElementById('timesheetTechFilter').value;
  const from = document.getElementById('timesheetFromFilter').value;
  const to = document.getElementById('timesheetToFilter').value;
  if (techId) params.set('technicianId', techId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const result = await api('/api/timesheets?' + params.toString());
  timesheetDays = result.days;

  document.getElementById('timesheetStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total hours</div>
      <div class="stat-value">${result.totals.hours}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Gas stipends</div>
      <div class="stat-value">${money(result.totals.gasStipend)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Wages</div>
      <div class="stat-value">${money(result.totals.wages)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total pay</div>
      <div class="stat-value">${money(result.totals.pay)}</div>
    </div>
  `;

  const tbody = document.querySelector('#timesheetTable tbody');
  tbody.innerHTML = timesheetDays.map((d) => `
    <tr>
      <td>${d.technicianName}</td>
      <td>${niceDateShort(d.date)}${d.stillClockedIn ? ' <span class="badge scheduled">Clocked in</span>' : ''}</td>
      <td>${d.hours}</td>
      <td>${money(d.gasStipend)}</td>
      <td>${money(d.wages)}</td>
      <td><strong>${money(d.pay)}</strong></td>
      <td>
        <button class="btn small" onclick="editTimesheetDay('${d.technicianId}', '${d.date}')">Edit</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty-state">No time entries yet.</td></tr>';
}

document.getElementById('timesheetTechFilter').addEventListener('change', loadTimesheets);
document.getElementById('timesheetFromFilter').addEventListener('change', loadTimesheets);
document.getElementById('timesheetToFilter').addEventListener('change', loadTimesheets);

// Edits (or deletes) every clock-in/out session that made up one technician's one day
// — a tech portal day can have more than one session (e.g. a lunch break), so this
// lists each one with its own time fields rather than a single combined pair.
window.editTimesheetDay = (technicianId, date) => {
  const day = timesheetDays.find((d) => String(d.technicianId) === String(technicianId) && d.date === date);
  if (!day) return;
  const rowsHtml = day.entries.map((e, i) => `
    <div id="tsEntryRow${e.id}" style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; border-bottom:1px solid #eef1f2; padding-bottom:10px; margin-bottom:10px;">
      <label style="flex:1; min-width:160px;">Clock in<input type="datetime-local" id="tsIn${e.id}" value="${toLocalInputValue(e.clockInAt)}" /></label>
      <label style="flex:1; min-width:160px;">Clock out<input type="datetime-local" id="tsOut${e.id}" value="${e.clockOutAt ? toLocalInputValue(e.clockOutAt) : ''}" /></label>
      <label style="display:flex; align-items:center; gap:6px; margin-bottom:8px;"><input type="checkbox" id="tsGas${e.id}" ${e.gasStipendAdded ? 'checked' : ''} /> Gas stipend</label>
      <button class="btn small danger" onclick="deleteTimesheetEntry(${e.id}, '${technicianId}', '${date}')">Delete session</button>
    </div>
  `).join('');
  openModal(`Edit hours — ${day.technicianName}, ${niceDateShort(date)}`, `
    ${rowsHtml}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveTimesheetDayBtn">Save</button>
    </div>
  `);
  document.getElementById('saveTimesheetDayBtn').addEventListener('click', async () => {
    try {
      for (const e of day.entries) {
        const clockInAt = document.getElementById(`tsIn${e.id}`).value;
        const clockOutAt = document.getElementById(`tsOut${e.id}`).value;
        const gasStipendAdded = document.getElementById(`tsGas${e.id}`).checked;
        await api(`/api/timesheets/${e.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            clockInAt: clockInAt ? new Date(clockInAt).toISOString() : e.clockInAt,
            clockOutAt: clockOutAt ? new Date(clockOutAt).toISOString() : null,
            gasStipendAdded,
          }),
        });
      }
      closeModal();
      loadTimesheets();
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
  });
};

window.deleteTimesheetEntry = async (entryId, technicianId, date) => {
  if (!confirm('Delete this clock-in session?')) return;
  try {
    await api(`/api/timesheets/${entryId}`, { method: 'DELETE' });
    closeModal();
    loadTimesheets();
  } catch (e) {
    alert('Could not delete: ' + e.message);
  }
};

document.getElementById('newTimeEntryBtn').addEventListener('click', () => {
  openModal('Add time entry', `
    <label>Technician<select id="ntTech">${state.technicians.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></label>
    <label>Clock in<input type="datetime-local" id="ntIn" /></label>
    <label>Clock out <span style="font-weight:400; color:var(--text-faint);">(leave blank if still clocked in)</span><input type="datetime-local" id="ntOut" /></label>
    <label style="display:flex; align-items:center; gap:6px;"><input type="checkbox" id="ntGas" /> Gas stipend for this day</label>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveNewTimeEntryBtn">Save</button>
    </div>
  `);
  document.getElementById('saveNewTimeEntryBtn').addEventListener('click', async () => {
    const clockInVal = document.getElementById('ntIn').value;
    if (!clockInVal) { alert('Pick a clock-in time.'); return; }
    const clockOutVal = document.getElementById('ntOut').value;
    try {
      await api('/api/timesheets', {
        method: 'POST',
        body: JSON.stringify({
          technicianId: document.getElementById('ntTech').value,
          date: clockInVal.slice(0, 10),
          clockInAt: new Date(clockInVal).toISOString(),
          clockOutAt: clockOutVal ? new Date(clockOutVal).toISOString() : null,
          gasStipendAdded: document.getElementById('ntGas').checked,
        }),
      });
      closeModal();
      loadTimesheets();
    } catch (e) {
      alert('Could not add entry: ' + e.message);
    }
  });
});

// datetime-local inputs need "YYYY-MM-DDTHH:MM" in LOCAL time, not the ISO/UTC string
// the API stores — this converts using the browser's own timezone.
function toLocalInputValue(isoStr) {
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Appointments / Calendar ----------
// state.calendarMonth: first-of-month Date representing the month currently shown
state.calendarMonth = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
})();

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadAppointments() {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  if (state.technicians.length === 0) state.technicians = await api('/api/technicians');
  state.appointments = await api('/api/appointments');
  renderCalendarGrid();
}

function renderCalendarGrid() {
  const monthStart = state.calendarMonth;
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  document.getElementById('calMonthLabel').textContent =
    monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstDayOfWeek);

  const apptsByDate = {};
  state.appointments.forEach((a) => {
    if (!apptsByDate[a.date]) apptsByDate[a.date] = [];
    apptsByDate[a.date].push(a);
  });
  Object.values(apptsByDate).forEach((list) => list.sort((a, b) => a.startTime.localeCompare(b.startTime)));

  const today = todayStr();
  const grid = document.getElementById('calGrid');
  let html = DAY_LABELS.map((d) => `<div class="cal-daylabel">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const dateStr = fmtDate(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const appts = apptsByDate[dateStr] || [];
    const chips = appts.slice(0, 3).map((a) =>
      `<div class="cal-appt-chip ${a.status}">${a.customerName}</div>`
    ).join('');
    const more = appts.length > 3 ? `<div class="cal-more">+${appts.length - 3} more</div>` : '';
    html += `
      <div class="cal-cell ${inMonth ? '' : 'other-month'} ${dateStr === today ? 'is-today' : ''}" onclick="openDayDetail('${dateStr}')">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${chips}${more}
      </div>
    `;
    // Stop after the row that finishes the month, to avoid a trailing all-other-month row
    if (i >= firstDayOfWeek + daysInMonth - 1 && (i + 1) % 7 === 0) break;
  }

  grid.innerHTML = html;
}

document.getElementById('calPrevBtn').addEventListener('click', () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
  renderCalendarGrid();
});
document.getElementById('calNextBtn').addEventListener('click', () => {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
  renderCalendarGrid();
});
document.getElementById('calTodayBtn').addEventListener('click', () => {
  const d = new Date();
  state.calendarMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendarGrid();
});

window.openDayDetail = (dateStr) => {
  const appts = (state.appointments.filter((a) => a.date === dateStr))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const niceDate = new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  // Each job gets its own checkbox so a handful of them can be picked out and assigned
  // to a tech together — e.g. splitting one day's jobs across two techs — instead of it
  // being all-or-nothing. Leaving everything unchecked and hitting Assign still assigns
  // the whole day, same as before.
  const list = appts.length
    ? appts.map((a) => `
        <div class="appt-card">
          <div style="display:flex; align-items:flex-start; gap:10px;">
            <input type="checkbox" class="day-detail-check" value="${a.id}" onchange="updateDayAssignBar()" style="margin-top:3px;" />
            <div>
              <strong>${a.customerName}</strong>
              <div class="meta">${a.serviceType} · Tech: ${a.technicianName}</div>
              ${(a.chlorine || a.ph || a.alkalinity) ? `<div class="meta">Chemistry: ${[a.chlorine && 'Cl ' + a.chlorine, a.ph && 'pH ' + a.ph, a.alkalinity && 'Alk ' + a.alkalinity].filter(Boolean).join(' · ')}</div>` : ''}
              ${a.reminderSentAt ? `<div class="meta">Reminder texted ✓</div>` : ''}
              ${a.reviewRequestSentAt ? `<div class="meta">Review requested ✓</div>` : ''}
              ${apptPhotosThumbs(a)}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span class="badge ${a.status}">${a.status}</span>
            ${a.customerPhone && a.status !== 'completed' ? `<button class="btn small" onclick="sendReminder(${a.id})">${a.reminderSentAt ? 'Re-send text' : 'Text reminder'}</button>` : ''}
            ${a.customerPhone && a.status === 'completed' ? `<button class="btn small" onclick="sendReviewRequest(${a.id})">${a.reviewRequestSentAt ? 'Re-send review request' : 'Send review request'}</button>` : ''}
            <button class="btn small" onclick="editAppt(${a.id})">Edit</button>
            <button class="btn small danger" onclick="deleteAppt(${a.id})">Delete</button>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state">No appointments this day.</div>';
  const techOptions = state.technicians.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  openModal(niceDate, `
    ${appts.length > 1 ? `
      <div style="margin-bottom:6px;">
        <label style="flex-direction:row; align-items:center; gap:6px; font-size:12.5px; color:#46606b;">
          <input type="checkbox" id="dayDetailSelectAll" onchange="toggleAllDayDetail(this)" /> Select all
        </label>
      </div>
    ` : ''}
    <div class="day-detail-list">${list}</div>
    ${appts.length ? `
      <div style="display:flex; align-items:center; gap:8px; border-top:1px solid #eef1f2; padding-top:12px; flex-wrap:wrap;">
        <span id="dayAssignLabel" style="font-size:13px; color:#46606b;">Assign this whole day to:</span>
        <select id="dayAssignTechSelect" style="flex:1;">
          <option value="">Unassigned</option>
          ${techOptions}
        </select>
        <button class="btn small" onclick="assignDayToTechnician('${dateStr}')">Assign</button>
      </div>
    ` : ''}
    <div class="modal-actions">
      <button class="btn primary" onclick="closeModal(); openNewApptModal('${dateStr}');">+ Add appointment</button>
    </div>
  `);
};

// Flips the "Assign this whole day to" label/behavior over to "Assign N selected to"
// as soon as one or more checkboxes are checked — no separate button/control needed,
// the same Assign button just acts on the selection instead of the whole day.
window.updateDayAssignBar = () => {
  const checked = document.querySelectorAll('.day-detail-check:checked');
  const label = document.getElementById('dayAssignLabel');
  if (!label) return;
  label.textContent = checked.length > 0
    ? `Assign ${checked.length} selected to:`
    : 'Assign this whole day to:';
  const selectAll = document.getElementById('dayDetailSelectAll');
  const all = document.querySelectorAll('.day-detail-check');
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length;
};

window.toggleAllDayDetail = (selectAllCheckbox) => {
  document.querySelectorAll('.day-detail-check').forEach((cb) => { cb.checked = selectAllCheckbox.checked; });
  updateDayAssignBar();
};

window.assignDayToTechnician = async (dateStr) => {
  const technicianId = document.getElementById('dayAssignTechSelect').value || null;
  const selectedIds = Array.from(document.querySelectorAll('.day-detail-check:checked')).map((cb) => Number(cb.value));
  try {
    const result = await api('/api/appointments/bulk-assign-technician', {
      method: 'POST',
      body: JSON.stringify(selectedIds.length ? { date: dateStr, technicianId, appointmentIds: selectedIds } : { date: dateStr, technicianId }),
    });
    await loadAppointments();
    openDayDetail(dateStr);
    alert(`Assigned ${result.count} appointment(s) on ${dateStr} to ${result.technicianName}.`);
  } catch (e) {
    alert('Could not assign: ' + e.message);
  }
};

function apptPhotosThumbs(a) {
  const photos = a.photos || [];
  if (photos.length === 0) return '';
  return `<div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
    ${photos.map((p) => `
      <a href="${p.url}" target="_blank" title="${p.type} photo">
        <img src="${p.url}" alt="${p.type}" style="width:48px; height:48px; object-fit:cover; border-radius:5px;" />
      </a>
    `).join('')}
  </div>`;
}

window.sendReminder = async (id) => {
  const a = state.appointments.find((x) => x.id === id);
  try {
    const result = await api(`/api/appointments/${id}/send-reminder`, { method: 'POST' });
    await loadAppointments();
    openDayDetail(a.date);
    if (result.smsDryRun) {
      alert('Twilio isn\'t configured yet, so no text was actually sent — check the server logs for a preview of what would have gone out.');
    }
  } catch (e) {
    alert('Could not send reminder: ' + e.message);
  }
};

window.sendReviewRequest = async (id) => {
  const a = state.appointments.find((x) => x.id === id);
  try {
    const result = await api(`/api/appointments/${id}/send-review-request`, { method: 'POST' });
    await loadAppointments();
    openDayDetail(a.date);
    if (result.smsDryRun) {
      alert('Twilio isn\'t configured yet, so no text was actually sent — check the server logs for a preview of what would have gone out.');
    }
  } catch (e) {
    alert('Could not send review request: ' + e.message);
  }
};

function customerOptions(selectedId) {
  return state.customers.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.name}</option>`).join('');
}
function techOptions(selectedId) {
  return '<option value="">Unassigned</option>' + state.technicians.map((t) => `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${t.name}</option>`).join('');
}

function apptForm(a = {}) {
  const isNew = !a.id;
  // No manual start/end time entry, anywhere — stop order for the day comes from the
  // route optimizer (nearest-neighbor from the shop, by address), not a clock time
  // someone has to invent when booking. A placeholder start time is still saved behind
  // the scenes (existing value when editing, 09:00 default when new) purely so older
  // sort-by-time fallback code and the day view keep working when a stop has no
  // coordinates yet to route by.
  return `
    <label>Home
      <select id="f_customerId" ${isNew ? 'onchange="onApptCustomerChange()"' : ''}>${customerOptions(a.customerId)}</select>
    </label>
    <label>Technician
      <select id="f_technicianId">${techOptions(a.technicianId)}</select>
    </label>
    <label>Date<input type="date" id="f_date" value="${a.date || todayStr()}" /></label>
    <input type="hidden" id="f_startTime" value="${a.startTime || '09:00'}" />
    <input type="hidden" id="f_endTime" value="${a.endTime || ''}" />
    <label>Service <span style="font-weight:400; color:#7a8f97;">(picks a price for auto-invoicing — leaving this on "Custom / none" means the job won't invoice automatically when completed)</span>
      <select id="f_serviceId" onchange="this.dataset.userTouched='1'; onApptServiceChange()">
        <option value="">Custom / none</option>
        ${state.services.map((s) => `<option value="${s.id}" ${s.id === a.serviceId ? 'selected' : ''}>${s.name} — ${money(s.defaultPrice)}</option>`).join('')}
      </select>
    </label>
    <label>Service type<input id="f_serviceType" value="${a.serviceType || ''}" placeholder="e.g. Routine cleaning, Repair" /></label>
    <label>Status
      <select id="f_status">
        <option value="scheduled" ${a.status === 'scheduled' ? 'selected' : ''}>Scheduled</option>
        <option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completed</option>
        <option value="cancelled" ${a.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
      </select>
    </label>
    <label>Notes<textarea id="f_apptNotes" rows="3">${a.notes || ''}</textarea></label>

    ${state.addons.length ? `
      <div style="display:flex; flex-direction: column; gap: 8px; border-top: 1px solid #eef1f2; padding-top: 12px;">
        <div style="font-size:13px; font-weight:600; color:#33505c;">Upcharges (optional)</div>
        <div class="job-addon-chips" id="f_addonChips">
          ${state.addons.map((ad) => `
            <button type="button" class="addon-chip ${(a.addons || []).some((x) => x.id === ad.id) ? 'added' : ''}" data-addon-id="${ad.id}" data-addon-name="${ad.name}" data-addon-price="${ad.price}" onclick="this.classList.toggle('added')">
              ${(a.addons || []).some((x) => x.id === ad.id) ? '✓ ' : '+ '}${ad.name} (${money(ad.price)})
            </button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div style="display:flex; flex-direction: column; gap: 12px; border-top: 1px solid #eef1f2; padding-top: 12px;">
      <div style="font-size:13px; font-weight:600; color:#33505c;">Water chemistry (optional)</div>
      <div style="display:flex; gap:10px;">
        <label style="flex:1;">Chlorine<input id="f_chlorine" value="${a.chlorine || ''}" placeholder="ppm" /></label>
        <label style="flex:1;">pH<input id="f_ph" value="${a.ph || ''}" /></label>
        <label style="flex:1;">Alkalinity<input id="f_alkalinity" value="${a.alkalinity || ''}" placeholder="ppm" /></label>
      </div>
    </div>

    ${isNew ? `
      <div style="display:flex; flex-direction: column; gap: 12px; border-top: 1px solid #eef1f2; padding-top: 12px;">
        <div style="font-size:13px; font-weight:600; color:#33505c;">Repeats</div>
        <label>Frequency
          <select id="f_recurrence" onchange="onApptRecurrenceChange()">
            <option value="none">Does not repeat</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="every4weeks">Every 4 weeks</option>
            <option value="monthly">Monthly</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label id="f_recurrenceCustomWrap" style="display:none;">Custom — every N days
          <input type="number" min="1" id="f_recurrenceCustomDays" placeholder="e.g. 21" />
        </label>
        <label>Repeat until <span style="font-weight:400;">(optional — defaults to 6 months out)</span>
          <input type="date" id="f_recurrenceEnd" />
        </label>
      </div>
    ` : (a.seriesId ? '<div class="portal-hint" style="margin:0;">Part of a recurring series — editing only changes this one visit.</div>' : '')}

    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveApptBtn">Save</button>
    </div>
  `;
}

window.onApptServiceChange = () => {
  const sel = document.getElementById('f_serviceId');
  const service = state.services.find((s) => String(s.id) === sel.value);
  if (service) document.getElementById('f_serviceType').value = service.name;
};

window.onApptRecurrenceChange = () => {
  const wrap = document.getElementById('f_recurrenceCustomWrap');
  if (wrap) wrap.style.display = document.getElementById('f_recurrence').value === 'custom' ? '' : 'none';
};

// Defaults the "Repeats" dropdown to whatever service frequency is saved on the
// selected customer, so scheduling their first visit doesn't require re-picking a
// frequency that's already on file. Only runs for new appointments (isNew). Also
// defaults the Service dropdown so a newly-scheduled job is billable from the start —
// leaving it on "Custom / none" is exactly how completed jobs end up with no invoice
// (see the Reports tab's "Completed jobs missing an invoice" table). Prefers this same
// customer's most recently-used service; if there's no history yet and the catalog
// only has one service, defaults to that (most small operations only have one).
window.onApptCustomerChange = () => {
  const recurrenceEl = document.getElementById('f_recurrence');
  if (!recurrenceEl) return;
  const customerId = Number(document.getElementById('f_customerId').value);
  const customer = state.customers.find((c) => c.id === customerId);
  if (customer && customer.serviceFrequency) {
    recurrenceEl.value = customer.serviceFrequency;
    if (customer.serviceFrequency === 'custom' && customer.customFrequencyDays) {
      document.getElementById('f_recurrenceCustomDays').value = customer.customFrequencyDays;
    }
  } else {
    recurrenceEl.value = 'none';
  }
  onApptRecurrenceChange();

  const serviceEl = document.getElementById('f_serviceId');
  if (serviceEl && !serviceEl.dataset.userTouched) {
    const priorAppt = (state.appointments || [])
      .filter((a) => a.customerId === customerId && a.serviceId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    const defaultServiceId = priorAppt ? priorAppt.serviceId : (state.services.length === 1 ? state.services[0].id : '');
    serviceEl.value = defaultServiceId || '';
    onApptServiceChange();
  }
};

function readApptForm() {
  const data = {
    customerId: document.getElementById('f_customerId').value,
    technicianId: document.getElementById('f_technicianId').value || null,
    date: document.getElementById('f_date').value,
    startTime: document.getElementById('f_startTime').value,
    endTime: document.getElementById('f_endTime').value,
    serviceId: document.getElementById('f_serviceId').value || null,
    serviceType: document.getElementById('f_serviceType').value,
    status: document.getElementById('f_status').value,
    notes: document.getElementById('f_apptNotes').value,
    chlorine: document.getElementById('f_chlorine').value,
    ph: document.getElementById('f_ph').value,
    alkalinity: document.getElementById('f_alkalinity').value,
  };
  const addonChips = document.querySelectorAll('#f_addonChips .addon-chip.added');
  if (addonChips.length) {
    data.addons = Array.from(addonChips).map((el) => ({
      id: Number(el.dataset.addonId),
      name: el.dataset.addonName,
      price: Number(el.dataset.addonPrice),
    }));
  }
  const recurrenceEl = document.getElementById('f_recurrence');
  if (recurrenceEl) {
    data.recurrence = recurrenceEl.value;
    data.recurrenceEndDate = document.getElementById('f_recurrenceEnd').value || null;
    if (recurrenceEl.value === 'custom') {
      data.recurrenceCustomDays = document.getElementById('f_recurrenceCustomDays').value || null;
    }
  }
  return data;
}

async function openNewApptModal(dateStr) {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  if (state.technicians.length === 0) state.technicians = await api('/api/technicians');
  if (state.services.length === 0) state.services = await api('/api/services');
  if (state.addons.length === 0) state.addons = await api('/api/addons');
  if (state.customers.length === 0) { alert('Add a home first.'); return; }
  openModal('New Appointment', apptForm(dateStr ? { date: dateStr } : {}));
  onApptCustomerChange();
  document.getElementById('saveApptBtn').addEventListener('click', async () => {
    try {
      await api('/api/appointments', { method: 'POST', body: JSON.stringify(readApptForm()) });
      closeModal(); loadAppointments();
    } catch (e) {
      alert('Could not save appointment: ' + e.message);
    }
  });
}
window.openNewApptModal = openNewApptModal;

document.getElementById('newApptBtn').addEventListener('click', () => openNewApptModal());

function openBulkImportModal() {
  const html = `
    <p class="portal-sub" style="margin:0 0 4px;">
      One line per day: <code>YYYY-MM-DD: Name One, Name Two, Name Three</code>.
      Each name is matched against your existing homes — anything that can't be
      matched confidently is listed afterward instead of guessed at. Times are just
      spread through the day as placeholders; actual visit order comes from route
      optimization (Settings tab).
    </p>
    <textarea id="bulkImportText" rows="14" style="width:100%; font-family:monospace; font-size:12px;" placeholder="2026-08-02: Chelsea, Chad, Mike, Josh C, Lo, Tim"></textarea>
    <div id="bulkImportResult"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn primary" id="bulkImportRunBtn">Import</button>
    </div>
  `;
  openModal('Bulk import appointments', html, true);
  document.getElementById('bulkImportRunBtn').addEventListener('click', async () => {
    const btn = document.getElementById('bulkImportRunBtn');
    const resultEl = document.getElementById('bulkImportResult');
    const text = document.getElementById('bulkImportText').value;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const result = await api('/api/appointments/bulk-import-text', { method: 'POST', body: JSON.stringify({ text }) });
      let html2 = `<div class="portal-hint" style="margin:10px 0;">Created ${result.createdCount} appointment(s).${result.unmatchedCount ? ` ${result.unmatchedCount} name(s) couldn't be matched.` : ''}${result.alreadyScheduledCount ? ` ${result.alreadyScheduledCount} were already on the books that day and were skipped (no duplicates created).` : ''}</div>`;
      if (result.unmatched.length) {
        html2 += `<div style="max-height:180px; overflow-y:auto; font-size:12px; background:#fef6f5; border-radius:6px; padding:8px;">
          ${result.unmatched.map((u) => `${u.date} — "${u.name}"`).join('<br>')}
        </div>`;
      }
      if (result.skippedLines && result.skippedLines.length) {
        html2 += `<div class="portal-hint" style="margin:8px 0 0;">${result.skippedLines.length} line(s) didn't match the expected format and were skipped.</div>`;
      }
      resultEl.innerHTML = html2;
      loadAppointments();
    } catch (e) {
      resultEl.innerHTML = `<div class="portal-error">${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}
document.getElementById('bulkImportBtn').addEventListener('click', openBulkImportModal);

window.editAppt = async (id) => {
  const a = state.appointments.find((x) => x.id === id);
  if (state.services.length === 0) state.services = await api('/api/services');
  if (state.addons.length === 0) state.addons = await api('/api/addons');
  openModal('Edit Appointment', apptForm(a));
  document.getElementById('saveApptBtn').addEventListener('click', async () => {
    try {
      await api('/api/appointments/' + id, { method: 'PUT', body: JSON.stringify(readApptForm()) });
      closeModal(); loadAppointments();
    } catch (e) {
      alert('Could not save appointment: ' + e.message);
    }
  });
};

// Quick one-click resolution for a row in Reports → Uncompleted tasks — skips opening
// the full edit modal for the common case (the job actually happened, it just never
// got marked). Falls back to "Edit" on the same row for anything less routine, e.g.
// re-dating a job that was actually missed and needs to be rescheduled instead.
window.markApptCompleteFromReport = async (id) => {
  try {
    await api('/api/appointments/' + id, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) });
    await loadReports();
  } catch (e) {
    alert('Could not mark complete: ' + e.message);
  }
};

window.deleteAppt = async (id) => {
  const a = state.appointments.find((x) => x.id === id);
  let scope = '';
  if (a && a.seriesId) {
    const deleteAll = confirm('This is part of a recurring series. Click OK to delete this AND all future visits in the series, or Cancel to delete just this one.');
    scope = deleteAll ? '?scope=series' : '';
    if (!deleteAll && !confirm('Delete just this one appointment?')) return;
  } else if (!confirm('Delete this appointment?')) {
    return;
  }
  try {
    await api('/api/appointments/' + id + scope, { method: 'DELETE' });
    closeModal();
    loadAppointments();
  } catch (e) {
    alert('Could not delete appointment: ' + e.message);
  }
};

// ---------- Invoices ----------
function isOverdue(i) {
  return i.status === 'sent' && !!i.dueDate && i.dueDate < todayStr();
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

function renderInvoiceStats() {
  const invoices = state.invoices;
  const thisMonth = todayStr().slice(0, 7); // YYYY-MM
  const totalPaid = invoices.filter((i) => i.status === 'paid').reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const paidThisMonth = invoices
    .filter((i) => i.status === 'paid' && (i.issuedDate || '').startsWith(thisMonth))
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const outstanding = invoices
    .filter((i) => i.status === 'sent')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const overdueInvoices = invoices.filter(isOverdue);
  const overdueTotal = overdueInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);

  document.getElementById('invoiceStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total revenue (paid)</div>
      <div class="stat-value">${money(totalPaid)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Revenue this month</div>
      <div class="stat-value">${money(paidThisMonth)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Outstanding (sent)</div>
      <div class="stat-value">${money(outstanding)}</div>
    </div>
    <div class="stat-card ${overdueInvoices.length ? 'stat-overdue' : ''}">
      <div class="stat-label">Overdue</div>
      <div class="stat-value">${money(overdueTotal)} <span style="font-size:14px; font-weight:400;">(${overdueInvoices.length})</span></div>
    </div>
  `;
}

// Small status badge showing whether this invoice made it into Wave (see
// lib/waveSync.js). Nothing shown for a still-draft invoice that was never
// eligible to sync yet. A failed sync shows the actual error in a tooltip —
// waveSyncError is set by waveSync.js whenever Wave rejects or can't be reached,
// so this is the one place in the admin UI you can tell the integration is
// actually working (or why it isn't) without checking Wave itself.
function waveBadge(i) {
  if (i.waveInvoiceId) return ' <span class="badge completed" title="Synced to Wave">Wave \u2713</span>';
  if (i.waveSyncError) {
    const msg = i.waveSyncError.replace(/</g, '&lt;');
    return ` <span class="badge cancelled" title="${i.waveSyncError.replace(/"/g, '&quot;')}">Wave sync failed</span><div style="font-size:11px; color:#a33; margin-top:2px; max-width:260px;">${msg} \u2014 <a href="#" onclick="retryWaveSync(${i.id}); return false;">Retry</a></div>`;
  }
  return '';
}

window.retryWaveSync = async (id) => {
  try {
    await api(`/api/invoices/${id}/retry-wave-sync`, { method: 'POST' });
    await loadInvoices();
  } catch (e) {
    alert('Retry failed: ' + e.message);
  }
};

function renderInvoiceTable() {
  const filter = document.getElementById('invoiceStatusFilter').value;
  // Monthly-billed/vacation-rental owners' per-job drafts belong on the Monthly tab,
  // not here — they're not something that needs action the moment a job is done. See
  // routes/invoices.js#enrich's isMonthlyDeferred.
  let rows = state.invoices.filter((i) => !i.isMonthlyDeferred);
  if (filter === 'overdue') rows = rows.filter(isOverdue);
  else if (filter) rows = rows.filter((i) => i.status === filter && !(filter === 'sent' && isOverdue(i)));

  const tbody = document.querySelector('#invoiceTable tbody');
  tbody.innerHTML = rows.map((i) => {
    const overdue = isOverdue(i);
    const bundled = i.status === 'bundled';
    return `
    <tr class="${overdue ? 'row-overdue' : ''}">
      <td>${i.customerName}</td>
      <td>${money(i.amount)}</td>
      <td>${i.issuedDate || ''}</td>
      <td>${i.dueDate || ''}</td>
      <td>${overdue ? '<span class="badge cancelled">Overdue</span>' : `<span class="badge ${i.status}">${i.status}</span>`}${i.stripeSessionId ? ' <span class="badge completed">Paid online</span>' : ''}${waveBadge(i)}</td>
      <td>
        ${bundled
          ? `<button class="btn small" onclick="viewInvoiceLineItems(${i.bundledIntoInvoiceId})">View combined invoice</button>`
          : `
            <button class="btn small" onclick="viewInvoice(${i.id})">View invoice</button>
            <button class="btn small" onclick="emailInvoice(${i.id})">Email invoice</button>
            ${i.isCombined
              ? `<button class="btn small" onclick="viewInvoiceLineItems(${i.id})">View jobs</button>
                 <button class="btn small" onclick="editCombinedInvoice(${i.id})">Edit</button>`
              : `<button class="btn small" onclick="editInvoice(${i.id})">Edit</button>`}
            <button class="btn small danger" onclick="deleteInvoice(${i.id})">Delete</button>
          `}
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="6" class="empty-state">No invoices found.</td></tr>';
}

window.viewInvoiceLineItems = (id) => {
  const i = state.invoices.find((x) => x.id === id);
  const rows = (i.lineItems || []).map((li) => `
    <div class="profile-history-item">
      <strong>${li.date} — ${li.customerName}</strong>
      <div class="meta">${li.serviceType} · ${money(li.amount)}</div>
    </div>
  `).join('') || '<div class="empty-state">No jobs on this invoice.</div>';
  openModal(`Jobs on invoice #${i.id}`, `
    ${rows}
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>
  `);
};

window.editCombinedInvoice = (id) => {
  const i = state.invoices.find((x) => x.id === id);
  openModal('Edit Combined Invoice', `
    <p class="portal-hint" style="margin:0;">${i.customerName} — total ${money(i.amount)}. The amount and included jobs come from "Generate monthly invoice"; only status/dates/notes can be edited here.</p>
    <label>Issued date<input type="date" id="f_ciIssuedDate" value="${i.issuedDate || todayStr()}" /></label>
    <label>Due date<input type="date" id="f_ciDueDate" value="${i.dueDate || ''}" /></label>
    <label>Status
      <select id="f_ciStatus">
        <option value="draft" ${i.status === 'draft' ? 'selected' : ''}>Draft</option>
        <option value="sent" ${i.status === 'sent' ? 'selected' : ''}>Sent</option>
        <option value="paid" ${i.status === 'paid' ? 'selected' : ''}>Paid</option>
      </select>
    </label>
    <label>Notes<textarea id="f_ciNotes" rows="3">${i.notes || ''}</textarea></label>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveCombinedInvoiceBtn">Save</button>
    </div>
  `);
  document.getElementById('saveCombinedInvoiceBtn').addEventListener('click', async () => {
    try {
      await api('/api/invoices/' + id, { method: 'PUT', body: JSON.stringify({
        issuedDate: document.getElementById('f_ciIssuedDate').value,
        dueDate: document.getElementById('f_ciDueDate').value,
        status: document.getElementById('f_ciStatus').value,
        notes: document.getElementById('f_ciNotes').value,
      }) });
      closeModal(); loadInvoices();
    } catch (e) {
      alert('Could not save invoice: ' + e.message);
    }
  });
};

// Opens the same public, no-login invoice page a customer/owner would see from a pay
// link — the invoice's amount, due date, and (if Stripe is configured) a way to pay it.
window.viewInvoice = (id) => {
  window.open(`${window.location.origin}/pay/${id}`, '_blank');
};

// Emails the invoice straight to whoever's billed for it — the owner's email if the
// home has one linked, otherwise the home's own email — with a short thank-you note
// and a link to view/pay it online. Replaces the old copy-the-link-and-text-it-
// yourself workflow entirely.
window.emailInvoice = async (id) => {
  try {
    const result = await api(`/api/invoices/${id}/email`, { method: 'POST' });
    alert(result.dryRun
      ? `Email logged (no email provider configured yet — see Settings/README). Would have gone to ${result.to}.`
      : `Invoice emailed to ${result.to}.`);
    await loadInvoices();
  } catch (e) {
    alert('Could not email this invoice: ' + e.message);
  }
};

async function loadInvoices() {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  state.invoices = await api('/api/invoices');
  renderInvoiceStats();
  renderInvoiceTable();
}

document.getElementById('invoiceStatusFilter').addEventListener('change', renderInvoiceTable);

// Monthly tab — owners on Monthly billing, or with at least one vacation-rental
// property, whose completed jobs accumulate toward one combined bill instead of
// needing individual action per job (see routes/owners.js's /monthly-pending, and
// lib/monthlyInvoice.js#ownerQualifiesForMonthly for exactly who qualifies and why).
async function loadMonthlyPending() {
  let owners;
  try {
    owners = await api('/api/owners/monthly-pending');
  } catch (e) {
    document.querySelector('#monthlyPendingTable tbody').innerHTML = `<tr><td colspan="6" class="empty-state">Could not load: ${e.message}</td></tr>`;
    return;
  }
  state.monthlyPending = owners;
  renderMonthlyPending();
}

function renderMonthlyPending() {
  const owners = state.monthlyPending || [];
  const tbody = document.querySelector('#monthlyPendingTable tbody');
  tbody.innerHTML = owners.map((o) => `
    <tr>
      <td>${o.ownerName}</td>
      <td>${o.propertyCount}${o.vacationPropertyCount ? ` <span class="badge sent">${o.vacationPropertyCount} vacation</span>` : ''}</td>
      <td>${o.billingMode === 'monthly' ? 'Monthly' : 'Per job (vacation)'}${o.monthlyBundleScope === 'property' ? ' · per property' : ''}</td>
      <td>${o.pendingCount}</td>
      <td>${money(o.pendingTotal)}</td>
      <td>
        <button class="btn small" onclick="viewMonthlyPendingJobs(${o.ownerId}, '${o.ownerName.replace(/'/g, "\'")}')" ${o.pendingCount ? '' : 'disabled'}>View jobs</button>
        <button class="btn small primary" onclick="generateMonthlyInvoice(${o.ownerId}, '${o.ownerName.replace(/'/g, "\'")}')" ${o.pendingCount ? '' : 'disabled'}>Generate monthly invoice</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty-state">No owners are on Monthly billing or have vacation-rental properties yet.</td></tr>';
}

// Drill-down for one owner's currently-unbilled jobs, across every one of their
// properties — reuses the same GET /api/invoices the main Invoices tab uses, just
// filtered by ownerId (see routes/invoices.js) instead of a single customerId.
window.viewMonthlyPendingJobs = async (ownerId, ownerName) => {
  let jobs;
  try {
    jobs = await api(`/api/invoices?ownerId=${ownerId}&status=draft`);
  } catch (e) {
    alert('Could not load pending jobs: ' + e.message);
    return;
  }
  jobs = jobs.filter((i) => i.isMonthlyDeferred);
  const rows = jobs.map((i) => `
    <div class="profile-history-item">
      <strong>${i.issuedDate || ''} — ${i.customerName}</strong>
      <div class="meta">${i.description || 'Service'} · ${money(i.amount)}</div>
    </div>
  `).join('') || '<div class="empty-state">Nothing pending right now.</div>';
  openModal(`Pending jobs — ${ownerName}`, `
    ${rows}
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Close</button></div>
  `);
};

function invoiceForm(i = {}) {
  return `
    <label>Home
      <select id="f_icustomerId">${customerOptions(i.customerId)}</select>
    </label>
    <label>Amount ($)<input type="number" step="0.01" id="f_amount" value="${i.amount || ''}" /></label>
    <label>Issued date<input type="date" id="f_issuedDate" value="${i.issuedDate || todayStr()}" /></label>
    <label>Due date<input type="date" id="f_dueDate" value="${i.dueDate || ''}" /></label>
    <label>Status
      <select id="f_istatus">
        <option value="draft" ${i.status === 'draft' ? 'selected' : ''}>Draft</option>
        <option value="sent" ${i.status === 'sent' ? 'selected' : ''}>Sent</option>
        <option value="paid" ${i.status === 'paid' ? 'selected' : ''}>Paid</option>
      </select>
    </label>
    <label>Notes<textarea id="f_invNotes" rows="3">${i.notes || ''}</textarea></label>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="saveInvoiceBtn">Save</button>
    </div>
  `;
}

function readInvoiceForm() {
  return {
    customerId: document.getElementById('f_icustomerId').value,
    amount: document.getElementById('f_amount').value,
    issuedDate: document.getElementById('f_issuedDate').value,
    dueDate: document.getElementById('f_dueDate').value,
    status: document.getElementById('f_istatus').value,
    notes: document.getElementById('f_invNotes').value,
  };
}

document.getElementById('newInvoiceBtn').addEventListener('click', async () => {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  if (state.customers.length === 0) { alert('Add a home first.'); return; }
  openModal('New Invoice', invoiceForm());
  document.getElementById('saveInvoiceBtn').addEventListener('click', async () => {
    try {
      await api('/api/invoices', { method: 'POST', body: JSON.stringify(readInvoiceForm()) });
      closeModal(); loadInvoices();
    } catch (e) {
      alert('Could not save invoice: ' + e.message);
    }
  });
});

window.editInvoice = (id) => {
  const i = state.invoices.find((x) => x.id === id);
  openModal('Edit Invoice', invoiceForm(i));
  document.getElementById('saveInvoiceBtn').addEventListener('click', async () => {
    try {
      await api('/api/invoices/' + id, { method: 'PUT', body: JSON.stringify(readInvoiceForm()) });
      closeModal(); loadInvoices();
    } catch (e) {
      alert('Could not save invoice: ' + e.message);
    }
  });
};

window.deleteInvoice = async (id) => {
  if (!confirm('Delete this invoice?')) return;
  try {
    await api('/api/invoices/' + id, { method: 'DELETE' });
    loadInvoices();
  } catch (e) {
    alert('Could not delete invoice: ' + e.message);
  }
};

// ---------- Daily Schedule ----------
// Jobs aren't scheduled to a specific time of day, just a day — so nothing on this tab
// shows or asks for a time, only the date (and reassigning which tech / which day).
async function loadSchedule() {
  const dateInput = document.getElementById('schedDate');
  if (!dateInput.value) dateInput.value = todayStr();
  const date = dateInput.value;
  if (state.technicians.length === 0) state.technicians = await api('/api/technicians');
  const data = await api('/api/schedule/' + date);
  const container = document.getElementById('schedByTech');
  const techNames = Object.keys(data.byTechnician);
  if (techNames.length === 0) {
    container.innerHTML = '<div class="empty-state">No appointments scheduled for this date.</div>';
    return;
  }
  const techOptions = (selectedId) => '<option value="">Unassigned</option>' + state.technicians.map((t) =>
    `<option value="${t.id}" ${selectedId === t.id ? 'selected' : ''}>${t.name}</option>`
  ).join('');
  container.innerHTML = techNames.map((techName) => {
    const appts = data.byTechnician[techName];
    const techId = appts[0].technician ? appts[0].technician.id : null;
    return `
      <div class="tech-group">
        <h3>${techName} ${techId ? `<button class="btn small" onclick="copyTechText('${date}', ${techId})">Copy schedule text</button>` : ''}</h3>
        ${appts.map((a) => `
          <div class="appt-card" style="flex-direction:column; align-items:stretch; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
              <div>
                <strong>${a.customer ? a.customer.name : 'Unknown'}</strong>
                <div class="meta">${a.serviceType} ${a.customer && a.customer.address ? '· ' + a.customer.address : ''}</div>
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn small" onclick="copyCustomerText(${a.id})">Copy home text</button>
                <button class="btn small" onclick="emailCustomerText(${a.id})">Email home text</button>
                <button class="btn small" onclick="toggleReassignForm(${a.id})">Reassign / move</button>
              </div>
            </div>
            <div id="reassignForm-${a.id}" class="hidden" style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; background:#f7fafb; border-radius:8px; padding:8px;">
              <label style="flex-direction:column; font-size:12px; color:#46606b; display:flex; gap:2px;">Technician
                <select id="reassignTech-${a.id}">${techOptions(a.technician ? a.technician.id : null)}</select>
              </label>
              <label style="flex-direction:column; font-size:12px; color:#46606b; display:flex; gap:2px;">Date
                <input type="date" id="reassignDate-${a.id}" value="${a.date}" />
              </label>
              <button class="btn small primary" onclick="saveReassign(${a.id})">Save</button>
              <button class="btn small" onclick="toggleReassignForm(${a.id})">Cancel</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

document.getElementById('schedDate').addEventListener('change', loadSchedule);

window.copyTechText = async (date, technicianId) => {
  const data = await api(`/api/schedule/${date}/technician/${technicianId}/text`);
  openTextModal(`Schedule for ${data.technician.name}`, data.text);
};

window.copyCustomerText = async (appointmentId) => {
  const data = await api(`/api/schedule/appointment/${appointmentId}/customer-text`);
  openTextModal(`Message to ${data.customer ? data.customer.name : 'the home'}`, data.text);
};

window.emailCustomerText = async (appointmentId) => {
  try {
    const result = await api(`/api/schedule/appointment/${appointmentId}/email-customer-text`, { method: 'POST' });
    alert(result.dryRun ? 'Email logged (no email provider configured yet — see Settings/README).' : 'Emailed!');
  } catch (e) {
    alert('Could not email: ' + e.message);
  }
};

window.toggleReassignForm = (appointmentId) => {
  document.getElementById(`reassignForm-${appointmentId}`).classList.toggle('hidden');
};

window.saveReassign = async (appointmentId) => {
  const techVal = document.getElementById(`reassignTech-${appointmentId}`).value;
  const dateVal = document.getElementById(`reassignDate-${appointmentId}`).value;
  if (!dateVal) { alert('Pick a date.'); return; }
  try {
    await api(`/api/appointments/${appointmentId}`, {
      method: 'PUT',
      body: JSON.stringify({ technicianId: techVal ? Number(techVal) : null, date: dateVal }),
    });
    loadSchedule();
  } catch (e) {
    alert('Could not save: ' + e.message);
  }
};

// ---------- Property Calendar (owner-submitted guest booking dates) ----------
async function loadBookings() {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  const bookings = await api('/api/bookings');
  state.bookings = bookings;

  const filterSelect = document.getElementById('bookingCustomerFilter');
  if (filterSelect.options.length <= 1) {
    const vacationCustomers = state.customers.filter((c) => c.type === 'vacation').sort((a, b) => a.name.localeCompare(b.name));
    filterSelect.innerHTML = '<option value="">All properties</option>' +
      vacationCustomers.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  renderBookingsTable();
}

function renderBookingsTable() {
  const filter = document.getElementById('bookingCustomerFilter').value;
  let rows = state.bookings || [];
  if (filter) rows = rows.filter((b) => b.customerId === Number(filter));
  const tbody = document.querySelector('#bookingsTable tbody');
  tbody.innerHTML = rows.map((b) => `
    <tr>
      <td>${b.customerName}</td>
      <td>${b.startDate}</td>
      <td>${b.endDate}</td>
      <td>${b.notes || ''}</td>
      <td><button class="btn small danger" onclick="deleteBooking(${b.id})">Remove</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty-state">No guest booking dates entered yet.</td></tr>';
}

document.getElementById('bookingCustomerFilter').addEventListener('change', renderBookingsTable);

document.getElementById('syncAllBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('syncAllStatus');
  const btn = document.getElementById('syncAllBtn');
  btn.disabled = true;
  statusEl.textContent = 'Syncing…';
  try {
    const { results, checkoutsScheduled } = await api('/api/bookings/sync-all', { method: 'POST' });
    const checkoutNote = checkoutsScheduled ? ` Scheduled ${checkoutsScheduled} new turnover-cleaning appointment(s) for upcoming checkouts.` : '';
    if (results.length === 0) {
      statusEl.textContent = 'No properties have an iCal link set yet.' + checkoutNote;
    } else {
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      statusEl.textContent = `Synced ${okCount}/${results.length} propert${results.length === 1 ? 'y' : 'ies'}.` +
        (failed.length ? ` Failed: ${failed.map((f) => f.customerName).join(', ')}.` : '') + checkoutNote;
    }
    loadBookings();
    loadAppointments();
  } catch (e) {
    statusEl.textContent = `Sync failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

window.deleteBooking = async (id) => {
  if (!confirm('Remove this booking date range?')) return;
  try {
    await api('/api/bookings/' + id, { method: 'DELETE' });
    loadBookings();
  } catch (e) {
    alert('Could not delete booking: ' + e.message);
  }
};

// ---------- Service Requests (from owner portal) ----------
async function loadRequests() {
  const status = document.getElementById('requestStatusFilter').value;
  const url = status ? '/api/service-requests?status=' + status : '/api/service-requests';
  const requests = await api(url);
  state.serviceRequests = requests;
  const tbody = document.querySelector('#requestsTable tbody');
  tbody.innerHTML = requests.map((r) => `
    <tr>
      <td>${r.customerName}</td>
      <td>${r.requestedDate}</td>
      <td>${r.notes || ''}${r.addons && r.addons.length ? `<div class="job-meta">Extras: ${r.addons.map((a) => `${a.name} (${money(a.price)})`).join(', ')}</div>` : ''}</td>
      <td><span class="badge ${r.status === 'pending' ? 'draft' : r.status === 'scheduled' ? 'completed' : 'cancelled'}">${r.status}</span></td>
      <td>
        ${r.status === 'pending' ? `
          <button class="btn small primary" onclick="scheduleRequest(${r.id}, ${r.customerId}, '${r.requestedDate}')">Schedule</button>
          <button class="btn small danger" onclick="declineRequest(${r.id})">Decline</button>
        ` : ''}
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty-state">No requests found.</td></tr>';
}

document.getElementById('requestStatusFilter').addEventListener('change', loadRequests);

window.declineRequest = async (id) => {
  try {
    await api('/api/service-requests/' + id, { method: 'PUT', body: JSON.stringify({ status: 'declined' }) });
    loadRequests();
  } catch (e) {
    alert('Could not decline request: ' + e.message);
  }
};

window.scheduleRequest = async (requestId, customerId, requestedDate) => {
  if (state.customers.length === 0) state.customers = await api('/api/customers');
  if (state.technicians.length === 0) state.technicians = await api('/api/technicians');
  if (state.services.length === 0) state.services = await api('/api/services');
  if (state.addons.length === 0) state.addons = await api('/api/addons');
  const request = state.serviceRequests.find((r) => r.id === requestId);
  openModal('New Appointment', apptForm({ customerId, date: requestedDate, addons: request ? request.addons : [] }));
  onApptCustomerChange();
  document.getElementById('saveApptBtn').addEventListener('click', async () => {
    try {
      await api('/api/appointments', { method: 'POST', body: JSON.stringify(readApptForm()) });
      await api('/api/service-requests/' + requestId, { method: 'PUT', body: JSON.stringify({ status: 'scheduled' }) });
      closeModal();
      loadRequests();
    } catch (e) {
      alert('Could not schedule this request: ' + e.message);
    }
  });
};

// ---------- Reports ----------
function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7); // "YYYY-MM"
}
function monthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
function lastNMonthKeys(n) {
  const keys = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
function renderBars(containerId, entries, formatValue) {
  const max = Math.max(1, ...entries.map((e) => e.value));
  document.getElementById(containerId).innerHTML = entries.map((e) => `
    <div class="bar-row">
      <div class="bar-label">${e.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((e.value / max) * 100)}%"></div></div>
      <div class="bar-value">${formatValue ? formatValue(e.value) : e.value}</div>
    </div>
  `).join('') || '<div class="empty-state">Not enough data yet.</div>';
}

async function loadReports() {
  const [appointments, invoices, technicians, owners, customers] = await Promise.all([
    api('/api/appointments'),
    api('/api/invoices'),
    api('/api/technicians'),
    api('/api/owners'),
    api('/api/customers'),
  ]);

  // Kept on state so the owner-drilldown select below can re-render without another
  // round-trip whenever the picked owner changes.
  state.reportAppointments = appointments;
  state.reportOwners = owners;
  state.reportCustomers = customers;
  // Also keep state.appointments/technicians fresh here (not just on the Calendar tab)
  // so editAppt()/markApptCompleteFromReport() below work correctly even if the admin
  // opens Reports first, before ever visiting Calendar this session.
  state.appointments = appointments;
  if (state.technicians.length === 0) state.technicians = technicians;
  if (state.customers.length === 0) state.customers = customers;
  populateReportOwnerSelect();

  const completed = appointments.filter((a) => a.status === 'completed');
  const paidInvoices = invoices.filter((i) => i.status === 'paid');
  const totalRevenue = paidInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);

  // Still "scheduled" (never marked completed OR cancelled) with a date that's already
  // passed — a missed visit, or one the tech forgot to close out in their portal.
  // Today's still-pending jobs don't count as overdue yet; they're not due until today
  // ends.
  const today = todayStr();
  const uncompleted = appointments
    .filter((a) => a.status === 'scheduled' && a.date < today)
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest/most-overdue first

  const techCounts = {};
  completed.forEach((a) => {
    const name = a.technicianName || 'Unassigned';
    techCounts[name] = (techCounts[name] || 0) + 1;
  });
  const busiestTech = Object.entries(techCounts).sort((a, b) => b[1] - a[1])[0];

  document.getElementById('reportStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Jobs completed (all time)</div>
      <div class="stat-value">${completed.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total revenue (paid)</div>
      <div class="stat-value">${money(totalRevenue)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Busiest technician</div>
      <div class="stat-value" style="font-size:16px;">${busiestTech ? `${busiestTech[0]} (${busiestTech[1]})` : '—'}</div>
    </div>
    <div class="stat-card ${uncompleted.length ? 'stat-overdue' : ''}">
      <div class="stat-label">Uncompleted tasks</div>
      <div class="stat-value">${uncompleted.length}</div>
    </div>
  `;

  const daysOverdue = (dateStr) => Math.round((new Date(today + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
  const uncompletedBody = document.getElementById('uncompletedTasksBody');
  uncompletedBody.innerHTML = uncompleted.length
    ? uncompleted.map((a) => `
        <tr class="row-overdue">
          <td>${a.date}</td>
          <td><span class="badge cancelled">${daysOverdue(a.date)} day${daysOverdue(a.date) === 1 ? '' : 's'}</span></td>
          <td>${a.customerName || 'Unknown'}</td>
          <td>${a.serviceType || ''}</td>
          <td>${a.technicianName || 'Unassigned'}</td>
          <td style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn small primary" onclick="markApptCompleteFromReport(${a.id})">Mark complete</button>
            <button class="btn small" onclick="editAppt(${a.id})">Edit</button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="6" class="empty-state">Nothing overdue — every past job has been marked complete or cancelled.</td></tr>';

  const months = lastNMonthKeys(6);

  const revenueByMonth = {};
  paidInvoices.forEach((i) => {
    const key = monthKey(i.issuedDate);
    revenueByMonth[key] = (revenueByMonth[key] || 0) + Number(i.amount || 0);
  });
  renderBars('reportRevenueBars', months.map((m) => ({ label: monthLabel(m), value: revenueByMonth[m] || 0 })), money);

  const jobsByMonth = {};
  completed.forEach((a) => {
    const key = monthKey(a.date);
    jobsByMonth[key] = (jobsByMonth[key] || 0) + 1;
  });
  renderBars('reportJobsBars', months.map((m) => ({ label: monthLabel(m), value: jobsByMonth[m] || 0 })));

  const techEntries = technicians
    .map((t) => ({ label: t.name, value: techCounts[t.name] || 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);
  renderBars('reportTechBars', techEntries);

  // A cancellation fee is just a draft/sent/paid invoice linked to a cancelled
  // appointment — completed-job invoices never exist on a cancelled one, so any match
  // here is the fee (see lib/autoInvoice.js#maybeCreateCancellationFeeInvoice).
  const cancelled = appointments
    .filter((a) => a.status === 'cancelled')
    .sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
  const cancelledBody = document.getElementById('cancelledVisitsBody');
  cancelledBody.innerHTML = cancelled.length
    ? cancelled.map((a) => {
        const feeInvoice = invoices.find((i) => i.appointmentId === a.id);
        return `
          <tr>
            <td>${a.date}</td>
            <td>${a.customerName || 'Unknown'}</td>
            <td>${a.serviceType || ''}</td>
            <td>${feeInvoice ? `${money(feeInvoice.amount)} <span class="badge ${feeInvoice.status}">${feeInvoice.status}</span>` : '<span class="portal-hint" style="margin:0;">No fee</span>'}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="4" class="empty-state">No cancelled visits.</td></tr>';

  // Completed jobs should always end up with an invoice (see lib/autoInvoice.js) — if
  // one's missing here, auto-pricing couldn't find a service to bill against (no
  // service selected on the appointment, and no prior job for this customer to infer
  // one from). Surfacing these so nothing quietly goes unbilled, with a bulk tool below
  // to fix a whole backlog of them in one action.
  state.missingInvoiceAppts = completed
    .filter((a) => !invoices.some((i) => i.appointmentId === a.id))
    .sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
  const missingInvoiceBody = document.getElementById('missingInvoiceBody');
  missingInvoiceBody.innerHTML = state.missingInvoiceAppts.length
    ? state.missingInvoiceAppts.map((a) => `
        <tr>
          <td><input type="checkbox" class="missing-invoice-check" value="${a.id}" onchange="updateMissingInvoiceToolbar()" /></td>
          <td>${a.date}</td>
          <td>${a.customerName || 'Unknown'}</td>
          <td>${a.technicianName || 'Unassigned'}</td>
          <td>${a.serviceType || ''}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5" class="empty-state">None — every completed job has an invoice.</td></tr>';

  const serviceSelect = document.getElementById('missingInvoiceServiceSelect');
  serviceSelect.innerHTML = state.services.length
    ? state.services.map((s) => `<option value="${s.id}">${s.name} — ${serviceFreqSummary(s)}</option>`).join('')
    : '<option value="">No services in your catalog yet — add one in Settings first</option>';
  renderMissingInvoiceTierSelect();
  document.getElementById('missingInvoiceSelectAll').checked = false;
  updateMissingInvoiceToolbar();
}

// Rebuilds the owner-drilldown dropdown after every reports refresh — owners already
// come back alphabetical from GET /api/owners, so no re-sort is needed here. Keeps
// whichever owner was already selected (if they still exist) selected across a
// refresh, e.g. right after bulk-assigning invoices above.
function populateReportOwnerSelect() {
  const select = document.getElementById('reportOwnerSelect');
  const prior = select.value;
  select.innerHTML = '<option value="">Choose an owner…</option>' +
    state.reportOwners.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  const stillExists = prior && state.reportOwners.some((o) => String(o.id) === prior);
  select.value = stillExists ? prior : '';
  renderOwnerReport(select.value);
}

// Shows each of the selected owner's homes with a breakdown of completed services by
// type/count at that home — the whole point being an admin can answer "how many
// cleanings has this owner's lake house had" without digging through the full
// appointment list by hand.
window.renderOwnerReport = (ownerId) => {
  const container = document.getElementById('reportOwnerDetail');
  if (!ownerId) {
    container.innerHTML = '<div class="empty-state">Pick an owner above to see their homes\' service history.</div>';
    return;
  }
  const homes = (state.reportCustomers || [])
    .filter((c) => String(c.ownerId) === String(ownerId))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!homes.length) {
    container.innerHTML = '<div class="empty-state">This owner has no homes on file yet.</div>';
    return;
  }
  container.innerHTML = homes.map((home) => {
    const homeAppts = (state.reportAppointments || []).filter(
      (a) => a.customerId === home.id && a.status === 'completed'
    );
    const byType = {};
    homeAppts.forEach((a) => {
      const type = a.serviceType || 'Service';
      byType[type] = (byType[type] || 0) + 1;
    });
    const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    return `
      <div class="profile-section" style="background:#f7fafb; margin-bottom:10px;">
        <h4 style="margin:0 0 6px;">${home.name} <span class="portal-hint">(${homeAppts.length} completed service${homeAppts.length === 1 ? '' : 's'})</span></h4>
        ${typeEntries.length ? `
          <table class="data-table">
            <thead><tr><th>Service</th><th>Times completed</th></tr></thead>
            <tbody>${typeEntries.map(([type, count]) => `<tr><td>${type}</td><td>${count}</td></tr>`).join('')}</tbody>
          </table>
        ` : '<div class="empty-state">No completed services yet.</div>'}
      </div>
    `;
  }).join('');
};

document.getElementById('reportOwnerSelect').addEventListener('change', (e) => renderOwnerReport(e.target.value));

// Frequency-priced services don't have one price — resolvePrice() normally figures out
// which tier applies from the CUSTOMER's on-file service frequency, but that's exactly
// what's usually missing on jobs that ended up unbilled in the first place. So when the
// picked service is frequency-priced, a second dropdown appears to explicitly choose
// which rate this whole batch should bill at (see lib/autoInvoice.js#
// computeBillForWithTier) — otherwise these would silently create $0 invoices, or none
// at all.
const TIER_OPTION_LABELS = { weekly: 'Weekly rate', biweekly: 'Biweekly rate', every4weeks: 'Monthly rate', vacationFlat: 'Vacation rental rate (flat)' };

function renderMissingInvoiceTierSelect() {
  const serviceSelect = document.getElementById('missingInvoiceServiceSelect');
  const tierSelect = document.getElementById('missingInvoiceTierSelect');
  const service = state.services.find((s) => String(s.id) === String(serviceSelect.value));
  if (!service || service.pricingMode !== 'frequency') {
    tierSelect.classList.add('hidden');
    tierSelect.innerHTML = '';
    return;
  }
  const rates = service.frequencyPrices || {};
  const options = ['weekly', 'biweekly', 'every4weeks', 'vacationFlat']
    .filter((t) => rates[t] !== undefined && rates[t] !== null && rates[t] !== '')
    .map((t) => `<option value="${t}">${TIER_OPTION_LABELS[t]} — ${money(rates[t])}</option>`);
  tierSelect.innerHTML = options.length
    ? options.join('')
    : '<option value="">No rates set for this service — add them in Settings first</option>';
  tierSelect.classList.remove('hidden');
}

document.getElementById('missingInvoiceServiceSelect').addEventListener('change', renderMissingInvoiceTierSelect);

window.toggleAllMissingInvoice = (checkbox) => {
  document.querySelectorAll('.missing-invoice-check').forEach((c) => { c.checked = checkbox.checked; });
  updateMissingInvoiceToolbar();
};

window.updateMissingInvoiceToolbar = () => {
  const checked = document.querySelectorAll('.missing-invoice-check:checked');
  const toolbar = document.getElementById('missingInvoiceToolbar');
  toolbar.classList.toggle('hidden', checked.length === 0);
  document.getElementById('missingInvoiceSelectedCount').textContent =
    `${checked.length} job${checked.length === 1 ? '' : 's'} selected`;
};

window.assignServiceToMissingInvoices = async () => {
  const checked = [...document.querySelectorAll('.missing-invoice-check:checked')].map((c) => Number(c.value));
  const serviceId = document.getElementById('missingInvoiceServiceSelect').value;
  if (!checked.length) return;
  if (!serviceId) { alert('Add a service in Settings first, or select one to bill these against.'); return; }
  const service = state.services.find((s) => String(s.id) === String(serviceId));
  let tier;
  if (service && service.pricingMode === 'frequency') {
    tier = document.getElementById('missingInvoiceTierSelect').value;
    if (!tier) { alert('This service has frequency-based pricing — pick which rate to bill these jobs at.'); return; }
  }
  const rateNote = tier ? ` at the ${TIER_OPTION_LABELS[tier].toLowerCase()}` : '';
  if (!confirm(`Bill ${checked.length} completed job(s) as "${service ? service.name : 'this service'}"${rateNote} and create their invoices?`)) return;
  try {
    const result = await api('/api/appointments/bulk-assign-service', {
      method: 'POST',
      body: JSON.stringify({ appointmentIds: checked, serviceId, tier }),
    });
    await loadReports();
    alert(`Done — ${result.invoicesCreated} new invoice(s) created for ${result.updatedCount} job(s). Check the Invoices tab.`);
  } catch (e) {
    alert('Could not assign a service: ' + e.message);
  }
};

// ---------- Settings (route optimization depot + geocoding) ----------
// ---------- Newsletter ----------
async function loadNewsletterTab() {
  document.getElementById('newsletterError').classList.add('hidden');
  document.getElementById('newsletterResult').classList.add('hidden');
  try {
    const { count } = await api('/api/newsletter/subscriber-count');
    document.getElementById('newsletterSubscriberCount').textContent = count;
  } catch (e) {
    document.getElementById('newsletterSubscriberCount').textContent = '?';
  }
}

document.getElementById('sendNewsletterBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('newsletterError');
  const resultEl = document.getElementById('newsletterResult');
  errEl.classList.add('hidden');
  resultEl.classList.add('hidden');
  const subject = document.getElementById('newsletterSubject').value.trim();
  const message = document.getElementById('newsletterMessage').value.trim();
  if (!subject || !message) {
    errEl.textContent = 'Please fill in both a subject and a message.';
    errEl.classList.remove('hidden');
    return;
  }
  const count = document.getElementById('newsletterSubscriberCount').textContent;
  if (!confirm(`Send this to ${count} subscribed owner(s)? This can't be undone.`)) return;
  const btn = document.getElementById('sendNewsletterBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const result = await api('/api/newsletter/send', { method: 'POST', body: JSON.stringify({ subject, message }) });
    resultEl.textContent = result.failed.length
      ? `Sent to ${result.sent} of ${result.total}. Failed: ${result.failed.map((f) => f.name).join(', ')}.`
      : `Sent to all ${result.sent} subscriber(s).`;
    resultEl.classList.remove('hidden');
    if (result.failed.length === 0) {
      document.getElementById('newsletterSubject').value = '';
      document.getElementById('newsletterMessage').value = '';
    }
  } catch (e) {
    errEl.textContent = e.message || 'Could not send the newsletter.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to subscribers';
  }
});

// ---------- Agreements ----------
function formatAgreedOn(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
  }) + ' PT';
}

async function loadAgreements() {
  const owners = await api('/api/owners');
  state.owners = owners;
  if (state.customers.length === 0) state.customers = await api('/api/customers');

  const agreedCount = owners.filter((o) => o.agreedToTerms).length;
  document.getElementById('agreementStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Agreed</div>
      <div class="stat-value">${agreedCount} / ${owners.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Not yet agreed</div>
      <div class="stat-value">${owners.length - agreedCount}</div>
    </div>
  `;
  renderAgreementsTable();
}

function renderAgreementsTable() {
  const filter = document.getElementById('agreementStatusFilter').value;
  let owners = state.owners || [];
  if (filter === 'agreed') owners = owners.filter((o) => o.agreedToTerms);
  if (filter === 'notAgreed') owners = owners.filter((o) => !o.agreedToTerms);
  owners = owners.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const body = document.getElementById('agreementsBody');
  body.innerHTML = owners.length ? owners.map((o) => {
    const properties = state.customers.filter((c) => c.ownerId === o.id);
    const propertyLabel = properties.length ? properties.map((p) => p.name || p.address).join(', ') : '—';
    return `
      <tr>
        <td>${o.name || ''}</td>
        <td>${o.email || '—'}</td>
        <td>${o.phone || '—'}</td>
        <td>${propertyLabel}</td>
        <td><span class="badge ${o.agreedToTerms ? 'paid' : 'draft'}">${o.agreedToTerms ? 'Agreed' : 'Not yet agreed'}</span></td>
        <td>${o.agreedToTerms ? formatAgreedOn(o.agreedToTermsAt) : '—'}</td>
        <td>${o.agreedToTerms ? `<button class="btn small" onclick="downloadAgreementPdf(${o.id})">Download PDF</button>` : ''}</td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="7" class="empty-state">No owners match this filter.</td></tr>';
}

document.getElementById('agreementStatusFilter').addEventListener('change', renderAgreementsTable);

window.downloadAgreementPdf = (ownerId) => {
  window.open(`/api/owners/${ownerId}/agreement.pdf`, '_blank');
};

async function loadSettingsTab() {
  const [settings] = await Promise.all([
    api('/api/settings'),
    state.services.length === 0 ? api('/api/services').then((s) => { state.services = s; }) : Promise.resolve(),
  ]);
  document.getElementById('googleReviewUrlInput').value = settings.googleReviewUrl || '';
  document.getElementById('notificationEmailInput').value = settings.notificationEmail || '';
  document.getElementById('depotAddressInput').value = settings.depotAddress || '';
  document.getElementById('depotStatus').textContent =
    typeof settings.depotLat === 'number'
      ? `Located ✓ (${settings.depotLat.toFixed(4)}, ${settings.depotLng.toFixed(4)})`
      : 'Not located yet — click "Save & locate."';
  document.getElementById('geocodeStatus').textContent = '';

  const defaultServiceSelect = document.getElementById('defaultServiceSelect');
  defaultServiceSelect.innerHTML = '<option value="">None set — these jobs won\'t auto-invoice</option>'
    + state.services.map((s) => `<option value="${s.id}" ${String(s.id) === String(settings.defaultServiceId) ? 'selected' : ''}>${s.name} — ${serviceFreqSummary(s)}</option>`).join('');
  document.getElementById('defaultServiceStatus').textContent = '';

  loadAdminAccounts();
  loadServicesList();
  loadAddonsList();
}

document.getElementById('saveDefaultServiceBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('defaultServiceStatus');
  const serviceId = document.getElementById('defaultServiceSelect').value;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ defaultServiceId: serviceId || '' }) });
    statusEl.textContent = serviceId ? 'Saved ✓' : 'Cleared — auto-scheduled jobs with no other service won\'t auto-invoice.';
  } catch (e) {
    statusEl.textContent = 'Could not save: ' + e.message;
  }
});

let editingServiceId = null;

function serviceFreqSummary(s) {
  if (s.pricingMode !== 'frequency') return money(s.defaultPrice);
  const fp = s.frequencyPrices || {};
  const parts = [];
  if (fp.weekly !== undefined) parts.push(`Weekly ${money(fp.weekly)}`);
  if (fp.biweekly !== undefined) parts.push(`Biweekly ${money(fp.biweekly)}`);
  if (fp.every4weeks !== undefined) parts.push(`Monthly ${money(fp.every4weeks)}`);
  if (fp.vacationFlat !== undefined) parts.push(`Vacation ${money(fp.vacationFlat)} flat`);
  return parts.length ? parts.join(' · ') : 'No rates set yet';
}

async function loadServicesList() {
  state.services = await api('/api/services');
  const list = document.getElementById('servicesList');
  list.innerHTML = state.services.map((s) => `
    <div class="owner-list-item">
      <span>${s.name} — <span style="color:var(--text-faint);">${serviceFreqSummary(s)}</span></span>
      <span style="display:flex; gap:6px;">
        <button class="btn small" onclick="editService(${s.id})">Edit</button>
        <button class="btn small danger" onclick="deleteService(${s.id})">Delete</button>
      </span>
    </div>
  `).join('') || '<div class="portal-sub" style="margin:0;">No services yet.</div>';
}

window.onServicePricingModeChange = () => {
  const isFrequency = document.getElementById('newServicePricingMode').value === 'frequency';
  document.getElementById('flatPriceWrap').classList.toggle('hidden', isFrequency);
  document.getElementById('frequencyPriceWrap').classList.toggle('hidden', !isFrequency);
};

function resetServiceForm() {
  editingServiceId = null;
  document.getElementById('newServiceName').value = '';
  document.getElementById('newServicePrice').value = '';
  document.getElementById('newServicePriceWeekly').value = '';
  document.getElementById('newServicePriceBiweekly').value = '';
  document.getElementById('newServicePriceMonthly').value = '';
  document.getElementById('newServicePriceVacation').value = '';
  document.getElementById('newServicePricingMode').value = 'flat';
  onServicePricingModeChange();
  document.getElementById('serviceFormLabel').style.display = 'none';
  document.getElementById('cancelServiceEditBtn').style.display = 'none';
  document.getElementById('addServiceBtn').textContent = '+ Add service';
}

window.editService = (id) => {
  const s = state.services.find((x) => x.id === id);
  if (!s) return;
  editingServiceId = id;
  document.getElementById('newServiceName').value = s.name;
  document.getElementById('newServicePrice').value = s.defaultPrice || '';
  const fp = s.frequencyPrices || {};
  document.getElementById('newServicePriceWeekly').value = fp.weekly !== undefined ? fp.weekly : '';
  document.getElementById('newServicePriceBiweekly').value = fp.biweekly !== undefined ? fp.biweekly : '';
  document.getElementById('newServicePriceMonthly').value = fp.every4weeks !== undefined ? fp.every4weeks : '';
  document.getElementById('newServicePriceVacation').value = fp.vacationFlat !== undefined ? fp.vacationFlat : '';
  document.getElementById('newServicePricingMode').value = s.pricingMode === 'frequency' ? 'frequency' : 'flat';
  onServicePricingModeChange();
  document.getElementById('serviceFormLabel').style.display = 'block';
  document.getElementById('cancelServiceEditBtn').style.display = 'inline-block';
  document.getElementById('addServiceBtn').textContent = 'Save changes';
  document.getElementById('newServiceName').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

document.getElementById('cancelServiceEditBtn').addEventListener('click', resetServiceForm);

document.getElementById('addServiceBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('servicesError');
  errEl.classList.add('hidden');
  const name = document.getElementById('newServiceName').value;
  const pricingMode = document.getElementById('newServicePricingMode').value;
  const payload = {
    name,
    pricingMode,
    defaultPrice: document.getElementById('newServicePrice').value,
    frequencyPrices: {
      weekly: document.getElementById('newServicePriceWeekly').value,
      biweekly: document.getElementById('newServicePriceBiweekly').value,
      every4weeks: document.getElementById('newServicePriceMonthly').value,
      vacationFlat: document.getElementById('newServicePriceVacation').value,
    },
  };
  try {
    if (editingServiceId) {
      await api('/api/services/' + editingServiceId, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/services', { method: 'POST', body: JSON.stringify(payload) });
    }
    resetServiceForm();
    loadServicesList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

window.deleteService = async (id) => {
  if (!confirm('Delete this service from the catalog? Appointments already using it are unaffected.')) return;
  if (editingServiceId === id) resetServiceForm();
  await api('/api/services/' + id, { method: 'DELETE' });
  loadServicesList();
};

// ---- Upcharges / add-ons catalog ----
async function loadAddonsList() {
  state.addons = await api('/api/addons');
  const list = document.getElementById('addonsList');
  list.innerHTML = state.addons.map((a) => `
    <div class="owner-list-item">
      <span>${a.name} — ${money(a.price)}</span>
      <button class="btn small danger" onclick="deleteAddon(${a.id})">Delete</button>
    </div>
  `).join('') || '<div class="portal-sub" style="margin:0;">No upcharges yet.</div>';
}

document.getElementById('addAddonBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('addonsError');
  errEl.classList.add('hidden');
  const name = document.getElementById('newAddonName').value;
  const price = document.getElementById('newAddonPrice').value;
  try {
    await api('/api/addons', { method: 'POST', body: JSON.stringify({ name, price }) });
    document.getElementById('newAddonName').value = '';
    document.getElementById('newAddonPrice').value = '';
    loadAddonsList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

window.deleteAddon = async (id) => {
  if (!confirm('Delete this upcharge from the catalog? Jobs that already have it attached are unaffected.')) return;
  try {
    await api('/api/addons/' + id, { method: 'DELETE' });
    loadAddonsList();
  } catch (e) {
    alert(e.message);
  }
};

async function loadAdminAccounts() {
  const accounts = await api('/api/admin-auth/accounts');
  const list = document.getElementById('adminAccountsList');
  list.innerHTML = accounts.map((a) => `
    <div class="owner-list-item">
      <span>${a.name || a.username} ${a.name ? `<span style="color:#7a8f97;">(${a.username})</span>` : ''}</span>
      ${accounts.length > 1 ? `<button class="btn small danger" onclick="deleteAdminAccount(${a.id})">Delete</button>` : ''}
    </div>
  `).join('');
}

document.getElementById('addAdminBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('adminAccountsError');
  errEl.classList.add('hidden');
  const name = document.getElementById('newAdminName').value;
  const username = document.getElementById('newAdminUsername').value;
  const password = document.getElementById('newAdminPassword').value;
  try {
    await api('/api/admin-auth/accounts', { method: 'POST', body: JSON.stringify({ name, username, password }) });
    document.getElementById('newAdminName').value = '';
    document.getElementById('newAdminUsername').value = '';
    document.getElementById('newAdminPassword').value = '';
    loadAdminAccounts();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

window.deleteAdminAccount = async (id) => {
  if (!confirm('Delete this admin account? They will no longer be able to log in.')) return;
  await api('/api/admin-auth/accounts/' + id, { method: 'DELETE' });
  loadAdminAccounts();
};

document.getElementById('restoreCustomersBtn').addEventListener('click', async () => {
  if (!confirm('Restore the home list from the built-in backup? This only adds homes if the list is currently empty — it will not touch or duplicate anything if homes already exist.')) return;
  const btn = document.getElementById('restoreCustomersBtn');
  btn.disabled = true;
  try {
    const result = await api('/api/customers/restore-seed-backup', { method: 'POST' });
    if (result.restored) {
      alert(`Restored ${result.count} homes from backup.`);
      loadCustomers();
    } else {
      alert(`No action taken — ${result.count} home(s) already exist.`);
    }
  } catch (e) {
    alert('Could not restore: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

function openBulkContactModal() {
  const html = `
    <p class="portal-sub" style="margin:0 0 4px;">
      One line per home: <code>Name: value, value</code> — each value can be a phone
      number or an email, in any order. Only blank fields get filled in; anything
      already on file is left alone.
    </p>
    <textarea id="bulkContactText" rows="14" style="width:100%; font-family:monospace; font-size:12px;" placeholder="Chelsea: 503-555-1234, chelsea@example.com"></textarea>
    <div id="bulkContactResult"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn primary" id="bulkContactRunBtn">Update</button>
    </div>
  `;
  openModal('Update home contact info', html, true);
  document.getElementById('bulkContactRunBtn').addEventListener('click', async () => {
    const btn = document.getElementById('bulkContactRunBtn');
    const resultEl = document.getElementById('bulkContactResult');
    const text = document.getElementById('bulkContactText').value;
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const result = await api('/api/customers/bulk-update-contact', { method: 'POST', body: JSON.stringify({ text }) });
      let html2 = `<div class="portal-hint" style="margin:10px 0;">Updated ${result.updatedCount} home(s).${result.unchangedCount ? ` ${result.unchangedCount} already had that info on file.` : ''}${result.unmatchedCount ? ` ${result.unmatchedCount} name(s) couldn't be matched.` : ''}</div>`;
      if (result.unmatched.length) {
        html2 += `<div style="max-height:180px; overflow-y:auto; font-size:12px; background:#fef6f5; border-radius:6px; padding:8px;">
          ${result.unmatched.map((u) => `"${u.name}"`).join('<br>')}
        </div>`;
      }
      if (result.skippedLines && result.skippedLines.length) {
        html2 += `<div class="portal-hint" style="margin:8px 0 0;">${result.skippedLines.length} line(s) didn't match the expected format and were skipped.</div>`;
      }
      resultEl.innerHTML = html2;
      loadCustomers();
    } catch (e) {
      resultEl.innerHTML = `<div class="portal-error">${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update';
    }
  });
}
document.getElementById('bulkContactBtn').addEventListener('click', openBulkContactModal);

function openBulkLinkOwnersModal() {
  const html = `
    <p class="portal-sub" style="margin:0 0 4px;">
      One line per home: <code>HomeName: OwnerName, value, value</code> —
      each value can be a phone number or an email, in any order. Creates the owner
      account if it doesn't exist yet (no password set, so nobody can log in until you
      add one), creates the home too if it doesn't exist yet (as a
      vacation rental), and links them. If a home is already linked to an owner,
      this fills in any phone/email that owner is still missing instead of skipping it
      — but never overwrites contact info already on file, and never changes which
      owner a home is linked to.
    </p>
    <textarea id="bulkLinkOwnersText" rows="14" style="width:100%; font-family:monospace; font-size:12px;" placeholder="Sea Salt Forest: Sam, (503) 481-1333, sam@example.com"></textarea>
    <div id="bulkLinkOwnersResult"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      <button class="btn primary" id="bulkLinkOwnersRunBtn">Link owners</button>
    </div>
  `;
  openModal('Bulk create/link owners', html, true);
  document.getElementById('bulkLinkOwnersRunBtn').addEventListener('click', async () => {
    const btn = document.getElementById('bulkLinkOwnersRunBtn');
    const resultEl = document.getElementById('bulkLinkOwnersResult');
    const text = document.getElementById('bulkLinkOwnersText').value;
    btn.disabled = true;
    btn.textContent = 'Linking…';
    try {
      const result = await api('/api/owners/bulk-link-from-text', { method: 'POST', body: JSON.stringify({ text }) });
      let html2 = `<div class="portal-hint" style="margin:10px 0;">Linked ${result.linkedCount} home(s) (${result.ownersCreated} new owner account(s), ${result.customersCreated} new home${result.customersCreated === 1 ? '' : 's'} created).${result.enrichedCount ? ` ${result.enrichedCount} existing owner(s) got contact info filled in.` : ''}${result.alreadyLinked.length ? ` ${result.alreadyLinked.length} already complete.` : ''}</div>`;
      if (result.created.length) {
        html2 += `<div style="max-height:140px; overflow-y:auto; font-size:12px; background:#f4f9fa; border-radius:6px; padding:8px; margin-bottom:8px;">${result.created.join('<br>')}</div>`;
      }
      if (result.linked.length) {
        html2 += `<div style="max-height:140px; overflow-y:auto; font-size:12px; background:#f4f9fa; border-radius:6px; padding:8px; margin-bottom:8px;">${result.linked.join('<br>')}</div>`;
      }
      if (result.enriched.length) {
        html2 += `<div class="portal-hint" style="margin:0 0 4px; font-weight:600;">Enriched existing owners:</div>
          <div style="max-height:140px; overflow-y:auto; font-size:12px; background:#f4f9fa; border-radius:6px; padding:8px; margin-bottom:8px;">${result.enriched.join('<br>')}</div>`;
      }
      if (result.skippedLines.length) {
        html2 += `<div class="portal-hint" style="margin:8px 0 0;">${result.skippedLines.length} line(s) didn't match the expected format and were skipped.</div>`;
      }
      resultEl.innerHTML = html2;
      loadOwners();
      loadCustomers();
    } catch (e) {
      resultEl.innerHTML = `<div class="portal-error">${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Link owners';
    }
  });
}
document.getElementById('bulkLinkOwnersBtn').addEventListener('click', openBulkLinkOwnersModal);

document.getElementById('dedupeAppointmentsBtn').addEventListener('click', async () => {
  if (!confirm('Remove duplicate appointments (same property, same day)? The first one created is kept; extras are deleted.')) return;
  const btn = document.getElementById('dedupeAppointmentsBtn');
  btn.disabled = true;
  try {
    const result = await api('/api/appointments/dedupe', { method: 'POST' });
    alert(result.removed > 0 ? `Removed ${result.removed} duplicate appointment(s).` : 'No duplicates found.');
    loadAppointments();
  } catch (e) {
    alert('Could not clean up: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveNotificationEmailBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('notificationEmailStatus');
  const btn = document.getElementById('saveNotificationEmailBtn');
  const notificationEmail = document.getElementById('notificationEmailInput').value.trim();
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ notificationEmail }) });
    statusEl.textContent = notificationEmail ? 'Saved ✓' : 'Cleared — new-account notifications are off.';
  } catch (e) {
    statusEl.textContent = `Could not save: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveReviewUrlBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('reviewUrlStatus');
  const btn = document.getElementById('saveReviewUrlBtn');
  const googleReviewUrl = document.getElementById('googleReviewUrlInput').value.trim();
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ googleReviewUrl }) });
    statusEl.textContent = 'Saved ✓';
  } catch (e) {
    statusEl.textContent = `Could not save: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('saveDepotBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('depotStatus');
  const btn = document.getElementById('saveDepotBtn');
  const depotAddress = document.getElementById('depotAddressInput').value.trim();
  btn.disabled = true;
  statusEl.textContent = 'Saving and locating…';
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ depotAddress }) });
    const result = await api('/api/settings/geocode-depot', { method: 'POST' });
    statusEl.textContent = `Located ✓ (${result.depotLat.toFixed(4)}, ${result.depotLng.toFixed(4)})`;
  } catch (e) {
    statusEl.textContent = `Couldn't locate that address: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('geocodeAllBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('geocodeStatus');
  const btn = document.getElementById('geocodeAllBtn');
  btn.disabled = true;
  const customers = await api('/api/customers');
  const todo = customers.filter((c) => c.address && typeof c.lat !== 'number');
  if (todo.length === 0) {
    statusEl.textContent = 'Every property with an address is already located.';
    btn.disabled = false;
    return;
  }
  let done = 0;
  let failed = 0;
  for (const c of todo) {
    statusEl.textContent = `Locating ${done + failed + 1}/${todo.length}: ${c.name}…`;
    try {
      await api(`/api/customers/${c.id}/geocode`, { method: 'POST' });
      done += 1;
    } catch (e) {
      failed += 1;
    }
    // Nominatim's usage policy caps requests at 1/second — pace ourselves
    await new Promise((r) => setTimeout(r, 1100));
  }
  statusEl.textContent = `Done — located ${done}/${todo.length}${failed ? `, ${failed} failed (couldn't find that address)` : ''}.`;
  btn.disabled = false;
});

// ---------- Admin login / first-time setup gate ----------
const adminAuthView = document.getElementById('adminAuthView');
const adminSetupView = document.getElementById('adminSetupView');
const adminLoginView = document.getElementById('adminLoginView');
const appRoot = document.getElementById('appRoot');

function showAdminApp() {
  adminAuthView.classList.add('hidden');
  appRoot.classList.remove('hidden');
  switchSurface('today');
}

async function checkAdminSession() {
  try {
    await api('/api/admin-auth/me');
    showAdminApp();
  } catch (e) {
    appRoot.classList.add('hidden');
    adminAuthView.classList.remove('hidden');
    const { hasAdmin } = await api('/api/admin-auth/status');
    if (hasAdmin) {
      adminLoginView.classList.remove('hidden');
      adminSetupView.classList.add('hidden');
    } else {
      adminSetupView.classList.remove('hidden');
      adminLoginView.classList.add('hidden');
    }
  }
}

document.getElementById('adminSetupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('adminSetupError');
  errEl.classList.add('hidden');
  const name = document.getElementById('adminSetupName').value;
  const username = document.getElementById('adminSetupUsername').value;
  const password = document.getElementById('adminSetupPassword').value;
  try {
    await api('/api/admin-auth/setup', { method: 'POST', body: JSON.stringify({ name, username, password }) });
    showAdminApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

// A real form submit (rather than a plain button click) is what makes the browser's
// password manager offer to save these credentials and autofill them next visit.
document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('adminLoginError');
  errEl.classList.add('hidden');
  const username = document.getElementById('adminLoginUsername').value;
  const password = document.getElementById('adminLoginPassword').value;
  try {
    await api('/api/admin-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showAdminApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('adminLogoutBtn').addEventListener('click', async () => {
  await api('/api/admin-auth/logout', { method: 'POST' });
  checkAdminSession();
});

// ---------- Init ----------
checkAdminSession();
