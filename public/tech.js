async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

const loginView = document.getElementById('loginView');
const jobsView = document.getElementById('jobsView');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

async function checkSession() {
  try {
    const tech = await api('/api/tech-auth/me');
    showJobs(tech);
  } catch (e) {
    loginView.classList.remove('hidden');
    jobsView.classList.add('hidden');
    logoutBtn.style.display = 'none';
  }
}

let addonsCatalog = [];
let currentTech = null;

async function showJobs(tech) {
  currentTech = tech;
  loginView.classList.add('hidden');
  jobsView.classList.remove('hidden');
  logoutBtn.style.display = '';
  document.getElementById('welcomeMsg').textContent = `Hi ${tech.name}`;
  document.getElementById('startAddressInput').value = tech.lastStartAddress || '';
  document.getElementById('todayDateLabel').textContent = niceDate(todayStr());
  try {
    addonsCatalog = await api('/api/tech/addons');
  } catch (e) {
    addonsCatalog = [];
  }
  await loadJobs();
}

// ---- Tabs ----
let activeTechTab = 'jobs';

function switchTechTab(tab) {
  activeTechTab = tab;
  document.querySelectorAll('#techTabs .owner-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#jobsView .owner-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
  });
  if (tab === 'calendar') loadTechCalendar();
  if (tab === 'timesheet') loadTimesheet();
  if (tab === 'timeoff') loadTimeOff();
  if (tab === 'account') renderAccountSettings();
}

// ---- Account settings: let the tech correct their own name/email/phone/username,
// or set/change their password. A current password is only demanded when one is
// already set (tech.hasPassword) — matches the same pattern used in owner.js's
// PUT /api/owner/account, since a tech with no password yet has nothing to verify
// against there either.
function renderAccountSettings() {
  const metaEl = document.getElementById('accountSettingsMeta');
  metaEl.textContent = `${currentTech.username || 'no username set'} · ${currentTech.email || 'no email on file'}`;
}

document.getElementById('editAccountBtn').addEventListener('click', () => {
  document.getElementById('acctName').value = currentTech.name || '';
  document.getElementById('acctEmail').value = currentTech.email || '';
  document.getElementById('acctPhone').value = currentTech.phone || '';
  document.getElementById('acctUsername').value = currentTech.username || '';
  document.getElementById('acctNewPassword').value = '';
  document.getElementById('acctCurrentPassword').value = '';
  document.getElementById('acctCurrentPasswordRow').classList.toggle('hidden', !currentTech.hasPassword);
  document.getElementById('editAccountError').classList.add('hidden');
  document.getElementById('editAccountForm').classList.remove('hidden');
});

document.getElementById('cancelEditAccountBtn').addEventListener('click', () => {
  document.getElementById('editAccountForm').classList.add('hidden');
});

document.getElementById('saveAccountBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('editAccountError');
  errEl.classList.add('hidden');
  const body = {
    name: document.getElementById('acctName').value.trim(),
    email: document.getElementById('acctEmail').value.trim(),
    phone: document.getElementById('acctPhone').value.trim(),
    username: document.getElementById('acctUsername').value.trim(),
  };
  const newPassword = document.getElementById('acctNewPassword').value;
  if (newPassword) {
    body.password = newPassword;
    body.currentPassword = document.getElementById('acctCurrentPassword').value;
  }
  const btn = document.getElementById('saveAccountBtn');
  btn.disabled = true;
  try {
    const updated = await api('/api/tech/account', { method: 'PUT', body: JSON.stringify(body) });
    currentTech = updated;
    document.getElementById('welcomeMsg').textContent = `Hi ${updated.name}`;
    renderAccountSettings();
    document.getElementById('editAccountForm').classList.add('hidden');
  } catch (e) {
    errEl.textContent = e.message || 'Could not save your changes.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('techTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.owner-tab-btn');
  if (btn) switchTechTab(btn.dataset.tab);
});

// Today tab always shows just today — set to true once the tech taps "Optimize
// route" successfully, so the list stays in that order (with stop numbers) until they
// reload the page or re-optimize; false means the plain shop-depot order from the API.
let routeOptimized = false;

async function loadJobs() {
  const jobs = await api(`/api/tech/appointments?date=${todayStr()}`);
  renderJobsList(jobs);
}

// directions: Google/Apple-agnostic universal Maps link — opens whatever the phone's
// default Maps app is, with turn-by-turn directions to that stop already loaded, so
// the tech's own GPS location is used as the starting point automatically.
function directionsUrl(j) {
  const dest = (typeof j.lat === 'number' && typeof j.lng === 'number')
    ? `${j.lat},${j.lng}`
    : encodeURIComponent(j.customerAddress || '');
  if (!dest) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

function renderJobsList(jobs, opts = {}) {
  updateTodayStrip(jobs);
  const list = document.getElementById('jobsList');
  if (jobs.length === 0) {
    list.innerHTML = '<div class="empty-state">No jobs scheduled today.</div>';
    return;
  }
  list.innerHTML = jobs.map((j, i) => `
    <div class="job-card">
      <div class="job-top">
        <div>
          ${opts.numbered ? `<div class="job-meta" style="font-weight:700;">Stop ${i + 1}</div>` : ''}
          <div class="job-date">${niceDate(j.date)}</div>
          <div class="job-customer">${j.customerName}</div>
          <div class="job-meta">${j.serviceType}${j.customerAddress ? ' · ' + j.customerAddress : ''}</div>
          ${j.customerPhone ? `<div class="job-meta">${j.customerPhone}</div>` : ''}
          ${j.customerNotes ? `<div class="job-meta job-property-note">Property note: ${j.customerNotes}</div>` : ''}
          ${j.notes ? `<div class="job-meta">Note: ${j.notes}</div>` : ''}
          ${renderEquipmentMeta(j.customerEquipment)}
          ${renderChemSummary(j)}
        </div>
        <span class="badge ${j.status}">${j.status}</span>
      </div>
      ${renderPhotos(j)}
      ${renderAddons(j)}
      <div class="job-actions">
        ${directionsUrl(j) ? `<a class="btn small" href="${directionsUrl(j)}" target="_blank" rel="noopener">Get directions</a>` : ''}
        <button class="btn small" onclick="choosePhoto(${j.id}, 'after')">Add photo</button>
        <button class="btn small" onclick="toggleChemForm(${j.id})">${(j.chlorine || j.ph || j.alkalinity) ? 'Edit water test' : 'Log water test'}</button>
        ${j.status === 'scheduled' ? `<button class="btn small primary" onclick="markComplete(${j.id})">Mark complete</button>` : ''}
        ${j.status === 'completed' ? `<button class="btn small" onclick="markIncomplete(${j.id})">Undo — mark not complete</button>` : ''}
      </div>
      ${chemFormHtml(j)}
    </div>
  `).join('');
}

// ---- Today status strip (deterministic, no AI needed for a plain job count) ----
function updateTodayStrip(jobs) {
  const el = document.getElementById('techTodayStripText');
  if (!el) return;
  if (jobs.length === 0) {
    el.textContent = 'No jobs scheduled today — enjoy the day off.';
    return;
  }
  const completed = jobs.filter((j) => j.status === 'completed').length;
  const remaining = jobs.length - completed;
  const next = jobs.find((j) => j.status === 'scheduled');
  el.textContent = remaining === 0
    ? `All ${jobs.length} job${jobs.length === 1 ? '' : 's'} done for today — nice work.`
    : `${jobs.length} job${jobs.length === 1 ? '' : 's'} today, ${completed} done so far.${next ? ` Next: ${next.customerName}.` : ''}`;
}

// ---- Water test / dosage (real spa-chemistry math, not AI — see lib/chemistry.js) ----
function renderChemSummary(j) {
  if (!j.chlorine && !j.ph && !j.alkalinity) return '';
  const parts = [j.chlorine && `Cl ${j.chlorine}`, j.ph && `pH ${j.ph}`, j.alkalinity && `TA ${j.alkalinity}`].filter(Boolean).join(' · ');
  return `<div class="job-meta">Water test on file: ${parts}</div>`;
}

function chemFormHtml(j) {
  return `
    <div class="chem-form hidden" id="chemForm${j.id}" style="margin-top:10px; padding-top:10px; border-top:1px solid #eef1f2;">
      <div class="calendar-form-row" style="margin-bottom:8px;">
        <label style="flex:1; min-width:90px;">Chlorine (ppm)<input type="number" step="0.1" min="0" id="chem_cl_${j.id}" value="${j.chlorine || ''}" /></label>
        <label style="flex:1; min-width:90px;">pH<input type="number" step="0.1" min="0" id="chem_ph_${j.id}" value="${j.ph || ''}" /></label>
        <label style="flex:1; min-width:90px;">Alkalinity (ppm)<input type="number" step="1" min="0" id="chem_ta_${j.id}" value="${j.alkalinity || ''}" /></label>
      </div>
      <label>Service note <span style="font-weight:400; color:#7a8f97;">(the owner sees this exact text — good place for a recommendation)</span><textarea id="chem_notes_${j.id}" rows="2" placeholder="e.g. Spa shocked, recommend drain and fill next service">${j.notes || ''}</textarea></label>
      <div style="display:flex; gap:8px; margin-top:6px;">
        <button class="btn primary small" onclick="saveChemistry(${j.id})">Save water test</button>
        <button class="btn small" onclick="toggleChemForm(${j.id})">Close</button>
      </div>
      <div id="chemDoseResult${j.id}"></div>
    </div>
  `;
}

window.toggleChemForm = (id) => {
  const el = document.getElementById('chemForm' + id);
  if (el) el.classList.toggle('hidden');
};

window.saveChemistry = async (id) => {
  const chlorine = document.getElementById(`chem_cl_${id}`).value;
  const ph = document.getElementById(`chem_ph_${id}`).value;
  const alkalinity = document.getElementById(`chem_ta_${id}`).value;
  const notes = document.getElementById(`chem_notes_${id}`).value;
  const doseEl = document.getElementById(`chemDoseResult${id}`);
  try {
    const result = await api(`/api/tech/appointments/${id}/chemistry`, {
      method: 'PUT',
      body: JSON.stringify({ chlorine, ph, alkalinity, notes }),
    });
    if (doseEl) {
      doseEl.innerHTML = result.dosageRecommendation.length
        ? `<div class="portal-sub" style="margin:10px 0 4px; font-weight:600;">✓ Saved — suggested dosage</div>` +
          result.dosageRecommendation.map((r) => `<span class="dose-chip">${r.chemical}: ${r.amountOz} oz (~${r.amountTbsp} tbsp)</span>`).join('') +
          `<div class="portal-sub" style="margin:6px 0 0;">Estimate — confirm with a fresh test after dosing.</div>`
        : `<div class="portal-sub" style="margin:10px 0 0; color:#256b32;">✓ Saved — everything's already in range, no dosage needed.</div>`;
    }
  } catch (e) {
    if (doseEl) doseEl.innerHTML = `<div class="portal-error" style="margin-top:8px;">${(e.message || 'Could not save water test')}</div>`;
  }
};

function renderAddons(j) {
  const attached = j.addons || [];
  const attachedIds = attached.map((a) => a.id);
  const customAttached = attached.filter((a) => String(a.id).startsWith('custom-'));
  return `
    <div class="job-addons">
      <div class="job-meta" style="margin-bottom:4px;">Upcharges</div>
      <div class="job-addon-chips">
        ${addonsCatalog.map((a) => `
          <button class="addon-chip ${attachedIds.includes(a.id) ? 'added' : ''}" onclick="toggleAddon(${j.id}, ${a.id}, ${attachedIds.includes(a.id)})">
            ${attachedIds.includes(a.id) ? '✓ ' : '+ '}${a.name}
          </button>
        `).join('')}
        ${customAttached.map((a) => `
          <button class="addon-chip added" onclick="removeCustomAddon(${j.id}, '${a.id}')">
            ✓ ${a.name}
          </button>
        `).join('')}
        <button class="addon-chip" onclick="addCustomAddon(${j.id})">+ Other…</button>
      </div>
    </div>
  `;
}

window.toggleAddon = async (apptId, addonId, currentlyAttached) => {
  try {
    if (currentlyAttached) {
      await api(`/api/tech/appointments/${apptId}/addons/${addonId}`, { method: 'DELETE' });
    } else {
      await api(`/api/tech/appointments/${apptId}/addons`, { method: 'POST', body: JSON.stringify({ addonId }) });
    }
    await refreshTodayList();
  } catch (e) {
    alert(e.message || 'Could not update upcharge');
  }
};

window.addCustomAddon = async (apptId) => {
  const name = prompt('What was the upcharge for? (e.g. "Replaced filter")');
  if (!name) return;
  const priceStr = prompt(`How much for "${name}"?`, '10');
  if (!priceStr) return;
  const price = Number(priceStr);
  if (!price || price <= 0) { alert('Enter a price greater than $0.'); return; }
  try {
    await api(`/api/tech/appointments/${apptId}/addons/custom`, { method: 'POST', body: JSON.stringify({ name, price }) });
    await refreshTodayList();
  } catch (e) {
    alert(e.message || 'Could not add upcharge');
  }
};

window.removeCustomAddon = async (apptId, addonId) => {
  try {
    await api(`/api/tech/appointments/${apptId}/addons/${addonId}`, { method: 'DELETE' });
    await refreshTodayList();
  } catch (e) {
    alert(e.message || 'Could not remove upcharge');
  }
};

function renderEquipmentMeta(eq) {
  if (!eq || (!eq.brand && !eq.model && !eq.filterType)) return '';
  const parts = [];
  if (eq.brand || eq.model) parts.push([eq.brand, eq.model].filter(Boolean).join(' '));
  if (eq.filterType) parts.push('Filter: ' + eq.filterType);
  if (parts.length === 0) return '';
  return `<div class="job-meta">${parts.join(' · ')}</div>`;
}

function renderPhotos(j) {
  const photos = j.photos || [];
  if (photos.length === 0) return '';
  return `<div class="job-photos">
    ${photos.map((p) => `
      <div class="job-photo">
        <img src="${p.url}" alt="${p.type} photo" />
        <div class="job-photo-label">${p.type}</div>
        <button class="btn small" onclick="removePhoto(${j.id}, ${p.id})">Delete</button>
      </div>
    `).join('')}
  </div>`;
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Re-loads the Today list after any change — re-runs the route optimization instead
// of falling back to shop-depot order if the tech had already optimized from their own
// starting address, so marking a job complete doesn't silently reshuffle the list.
async function refreshTodayList() {
  const address = document.getElementById('startAddressInput').value.trim();
  if (routeOptimized && address) {
    try {
      const result = await api('/api/tech/optimize-route', { method: 'POST', body: JSON.stringify({ date: todayStr(), address }) });
      renderJobsList([...result.ordered, ...result.unroutable], { numbered: true });
      return;
    } catch (e) {
      // fall through to the plain list if re-optimizing fails for any reason
    }
  }
  loadJobs();
}

window.markComplete = async (id) => {
  try {
    await api(`/api/tech/appointments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) });
    refreshTodayList();
  } catch (e) {
    alert('Could not mark complete: ' + e.message);
  }
};

window.markIncomplete = async (id) => {
  try {
    await api(`/api/tech/appointments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'scheduled' }) });
    refreshTodayList();
  } catch (e) {
    alert('Could not undo: ' + e.message);
  }
};

// ---- Optimize route from a custom starting address ----
// Re-orders today's jobs starting from wherever the tech types in (their home, or
// wherever they happen to be that morning) instead of the fixed shop-depot order the
// plain Today list uses. Saves the address on the technician record so it's pre-filled
// next time — still editable any day it's different.
document.getElementById('optimizeRouteBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('optimizeRouteStatus');
  const btn = document.getElementById('optimizeRouteBtn');
  const address = document.getElementById('startAddressInput').value.trim();
  if (!address) {
    statusEl.textContent = 'Enter a starting address first.';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Optimizing…';
  try {
    const result = await api('/api/tech/optimize-route', {
      method: 'POST',
      body: JSON.stringify({ date: todayStr(), address }),
    });
    const stops = [...result.ordered, ...result.unroutable];
    renderJobsList(stops, { numbered: true });
    routeOptimized = true;
    statusEl.textContent = result.unroutable.length
      ? `Routed from ${result.start.displayName} (${result.unroutable.length} stop${result.unroutable.length === 1 ? '' : 's'} listed last — no map location on file).`
      : `Routed from ${result.start.displayName}.`;
    if (currentTech) currentTech.lastStartAddress = address;
  } catch (e) {
    statusEl.textContent = '';
    alert('Could not optimize the route: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Photo upload ----
const photoFileInput = document.getElementById('photoFileInput');
let photoTarget = null; // { apptId, type }

window.choosePhoto = (apptId, type) => {
  photoTarget = { apptId, type };
  photoFileInput.value = '';
  photoFileInput.click();
};

// Resizes the chosen image down to a max dimension before base64-encoding it,
// so uploads stay small over a slow connection out in the field.
function resizeImageToDataUrl(file, maxDimension = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected image'));
    reader.onload = () => {
      img.onerror = () => reject(new Error('Could not load the selected image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round(height * (maxDimension / width));
            width = maxDimension;
          } else {
            width = Math.round(width * (maxDimension / height));
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

photoFileInput.addEventListener('change', async () => {
  const file = photoFileInput.files[0];
  if (!file || !photoTarget) return;
  const { apptId, type } = photoTarget;
  try {
    const dataUrl = await resizeImageToDataUrl(file);
    await api(`/api/tech/appointments/${apptId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ type, dataUrl }),
    });
    await refreshTodayList();
  } catch (e) {
    alert(e.message || 'Photo upload failed');
  }
});

window.removePhoto = async (apptId, photoId) => {
  if (!confirm('Delete this photo?')) return;
  await api(`/api/tech/appointments/${apptId}/photos/${photoId}`, { method: 'DELETE' });
  refreshTodayList();
};

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const tech = await api('/api/tech-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showJobs(tech);
  } catch (e) {
    showError(e.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/tech-auth/logout', { method: 'POST' });
  checkSession();
});

// ---- Calendar (month grid of this tech's own jobs, plus their own blocked days) ----
let techCalMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let techCalAppts = [];
let techCalTimeOff = [];

async function loadTechCalendar() {
  const [appts, timeOff] = await Promise.all([
    api('/api/tech/appointments?all=1'),
    api('/api/tech/time-off'),
  ]);
  techCalAppts = appts;
  techCalTimeOff = timeOff;
  renderTechCalendarGrid();
}

function renderTechCalendarGrid() {
  const year = techCalMonth.getFullYear();
  const month = techCalMonth.getMonth();
  document.getElementById('techCalMonthLabel').textContent =
    techCalMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstDayOfWeek);

  const apptsByDate = {};
  techCalAppts.forEach((a) => { (apptsByDate[a.date] = apptsByDate[a.date] || []).push(a); });
  const timeOffByDate = {};
  techCalTimeOff.forEach((t) => { timeOffByDate[t.date] = t; });

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = todayStr();
  let html = dayLabels.map((d) => `<div class="cal-daylabel">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const dateStr = fmtDate(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const dayAppts = apptsByDate[dateStr] || [];
    const blocked = timeOffByDate[dateStr];
    const apptChips = dayAppts.slice(0, 3).map((a) =>
      `<div class="cal-appt-chip ${a.status}">${a.customerName}</div>`
    ).join('');
    const blockedChip = blocked ? '<div class="cal-appt-chip" style="background:repeating-linear-gradient(45deg,#eceff1,#eceff1 6px,#dde3e6 6px,#dde3e6 12px); color:#5a6b73; border-left-color:#8a99a1;">Blocked off</div>' : '';
    html += `
      <div class="cal-cell ${inMonth ? '' : 'other-month'} ${dateStr === today ? 'is-today' : ''}" onclick="onTechCalDayClick('${dateStr}')">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${apptChips}${blockedChip}
      </div>
    `;
    if (i >= firstDayOfWeek + daysInMonth - 1 && (i + 1) % 7 === 0) break;
  }
  document.getElementById('techCalGrid').innerHTML = html;
}

window.onTechCalDayClick = (dateStr) => {
  const dayAppts = techCalAppts.filter((a) => a.date === dateStr);
  const blocked = techCalTimeOff.find((t) => t.date === dateStr);
  const panel = document.getElementById('techCalDayPanel');
  panel.classList.remove('hidden');

  let html = `<h3 style="margin:0 0 8px;">${niceDate(dateStr)}</h3>`;
  if (dayAppts.length === 0) {
    html += '<div class="empty-state">No jobs this day.</div>';
  } else {
    html += '<div class="day-detail-list">' + dayAppts.map((a) => `
      <div class="owner-list-item">
        <div>
          <strong>${a.customerName}</strong>
          <div class="job-meta">${a.serviceType || ''}</div>
          ${a.customerNotes ? `<div class="job-meta job-property-note">Property note: ${a.customerNotes}</div>` : ''}
        </div>
        <span class="badge ${a.status}">${a.status}</span>
      </div>
    `).join('') + '</div>';
  }
  if (blocked) {
    html += `<div class="portal-sub" style="margin-top:10px;">Blocked off${blocked.note ? ' — ' + blocked.note : ''}. <a href="#" onclick="deleteTimeOff(${blocked.id}); return false;">Remove block</a></div>`;
  }
  panel.innerHTML = html;
};

document.getElementById('techCalPrevBtn').addEventListener('click', () => {
  techCalMonth = new Date(techCalMonth.getFullYear(), techCalMonth.getMonth() - 1, 1);
  renderTechCalendarGrid();
});
document.getElementById('techCalNextBtn').addEventListener('click', () => {
  techCalMonth = new Date(techCalMonth.getFullYear(), techCalMonth.getMonth() + 1, 1);
  renderTechCalendarGrid();
});
document.getElementById('techCalTodayBtn').addEventListener('click', () => {
  const d = new Date();
  techCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderTechCalendarGrid();
});

// ---- Time off (self-service day blocking — takes effect immediately) ----
async function loadTimeOff() {
  const entries = await api('/api/tech/time-off');
  techCalTimeOff = entries;
  const today = todayStr();
  const upcoming = entries.filter((t) => t.date >= today);
  const past = entries.filter((t) => t.date < today);
  const el = document.getElementById('timeOffList');
  if (entries.length === 0) {
    el.innerHTML = '<div class="empty-state">No days blocked off.</div>';
    return;
  }
  const renderRow = (t) => `
    <div class="owner-list-item">
      <div>
        <strong>${niceDate(t.date)}</strong>
        ${t.note ? `<div class="job-meta">${t.note}</div>` : ''}
      </div>
      <button class="btn small danger" onclick="deleteTimeOff(${t.id})">Remove</button>
    </div>
  `;
  el.innerHTML = (upcoming.length ? upcoming.map(renderRow).join('') : '<div class="empty-state">No upcoming days blocked off.</div>')
    + (past.length ? `<div class="portal-sub" style="margin:14px 0 6px;">Past</div>${past.map(renderRow).join('')}` : '');
}

window.deleteTimeOff = async (id) => {
  await api(`/api/tech/time-off/${id}`, { method: 'DELETE' });
  await loadTimeOff();
  if (activeTechTab === 'calendar') loadTechCalendar();
};

document.getElementById('addTimeOffBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('timeOffError');
  errEl.classList.add('hidden');
  const startDate = document.getElementById('timeOffStart').value;
  const endDate = document.getElementById('timeOffEnd').value;
  const note = document.getElementById('timeOffNote').value;
  if (!startDate) {
    errEl.textContent = 'Pick at least a first day off.';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('addTimeOffBtn');
  btn.disabled = true;
  try {
    await api('/api/tech/time-off', { method: 'POST', body: JSON.stringify({ startDate, endDate, note }) });
    document.getElementById('timeOffStart').value = '';
    document.getElementById('timeOffEnd').value = '';
    document.getElementById('timeOffNote').value = '';
    await loadTimeOff();
  } catch (e) {
    errEl.textContent = e.message || 'Could not block those days';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ---- Timesheet (clock in/out, pay, gas stipend) ----
let clockTimerInterval = null;
let timesheetOpenEntry = null;

function fmtHM(hours) {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtElapsed(clockInAt) {
  const ms = Date.now() - new Date(clockInAt).getTime();
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function renderClockCard() {
  const statusEl = document.getElementById('clockStatusLabel');
  const elapsedEl = document.getElementById('clockElapsed');
  const btn = document.getElementById('clockToggleBtn');
  if (timesheetOpenEntry) {
    statusEl.textContent = "You're clocked in";
    elapsedEl.textContent = fmtElapsed(timesheetOpenEntry.clockInAt);
    btn.textContent = 'Clock out';
    btn.classList.remove('primary');
  } else {
    statusEl.textContent = "You're clocked out";
    elapsedEl.textContent = '';
    btn.textContent = 'Clock in';
    btn.classList.add('primary');
  }
}

async function loadTimesheet() {
  if (clockTimerInterval) clearInterval(clockTimerInterval);
  const data = await api('/api/tech/time-entries');
  timesheetOpenEntry = data.openEntry;
  renderClockCard();
  if (timesheetOpenEntry) {
    clockTimerInterval = setInterval(() => {
      document.getElementById('clockElapsed').textContent = fmtElapsed(timesheetOpenEntry.clockInAt);
    }, 1000);
  }

  const totalHours = data.days.reduce((sum, d) => sum + d.hours, 0);
  const totalGas = data.days.reduce((sum, d) => sum + d.gasStipend, 0);
  const totalPay = data.days.reduce((sum, d) => sum + d.pay, 0);
  document.getElementById('timesheetStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Hours (last 30 days)</div>
      <div class="stat-value">${fmtHM(totalHours)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Gas stipends</div>
      <div class="stat-value">$${totalGas.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total pay</div>
      <div class="stat-value">$${totalPay.toFixed(2)}</div>
    </div>
  `;

  const listEl = document.getElementById('timesheetList');
  if (data.days.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No hours logged yet — clock in above to start today.</div>';
    return;
  }
  listEl.innerHTML = data.days.map((d) => `
    <div class="owner-list-item">
      <div>
        <strong>${niceDate(d.date)}</strong>${d.stillClockedIn ? ' <span class="badge scheduled">Clocked in</span>' : ''}
        <div class="job-meta">${fmtHM(d.hours)} worked${d.gasStipend ? ' · $' + d.gasStipend.toFixed(2) + ' gas' : ''}</div>
      </div>
      <strong>$${d.pay.toFixed(2)}</strong>
    </div>
  `).join('');
}

document.getElementById('clockToggleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clockToggleBtn');
  const errEl = document.getElementById('clockError');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    if (timesheetOpenEntry) {
      await api('/api/tech/clock-out', { method: 'POST' });
    } else {
      await api('/api/tech/clock-in', { method: 'POST' });
    }
    await loadTimesheet();
  } catch (e) {
    errEl.textContent = e.message || 'Could not update your clock status';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

checkSession();
