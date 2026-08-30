const invoiceId = window.location.pathname.split('/').filter(Boolean).pop();
const params = new URLSearchParams(window.location.search);
const card = document.getElementById('payCard');

async function load() {
  try {
    const res = await fetch(`/api/pay/${invoiceId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invoice not found');
    render(data);
  } catch (e) {
    card.innerHTML = `<h1>Invoice not found</h1><p class="portal-sub">${e.message}</p>`;
  }
}

// A monthly bundle can easily hold a dozen-plus jobs, and most of them are the exact
// same recurring service repeated week after week — listing each one on its own line
// (same service name over and over, just a different date) reads as clutter rather
// than as useful detail. Grouped by property + service type instead, so what shows is
// "Weekly Maintenance × 4 — $400" rather than four near-identical rows; the property
// name is only shown when this bundle actually spans more than one (an owner-wide
// combined invoice), since a single-property bill has nothing to disambiguate.
function groupLineItems(lineItems) {
  const groups = [];
  const byKey = new Map();
  lineItems.forEach((li) => {
    const key = `${li.customerName}||${li.serviceType}`;
    let g = byKey.get(key);
    if (!g) {
      g = { customerName: li.customerName, serviceType: li.serviceType || 'Service', count: 0, total: 0 };
      byKey.set(key, g);
      groups.push(g);
    }
    g.count += 1;
    g.total += Number(li.amount) || 0;
  });
  return groups;
}

function lineItemsHtml(invoice) {
  if (!invoice.lineItems || invoice.lineItems.length === 0) return '';
  const groups = groupLineItems(invoice.lineItems);
  const spansMultipleProperties = new Set(invoice.lineItems.map((li) => li.customerName)).size > 1;
  return `
    <div style="text-align:left; border-top:1px solid #eef1f2; border-bottom:1px solid #eef1f2; margin:12px 0; padding:8px 0;">
      ${groups.map((g) => `
        <div style="display:flex; justify-content:space-between; font-size:13px; padding:3px 0; color:#46606b;">
          <span>${spansMultipleProperties ? g.customerName + ' — ' : ''}${g.serviceType}${g.count > 1 ? ` × ${g.count}` : ''}</span>
          <span>$${g.total.toFixed(2)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// What this invoice is for — service name + date for a single job, or a summary of
// the batch for a combined (owner-wide or per-property monthly) invoice. Shown right
// under the amount so it's the first thing anyone paying (or an owner glancing at it)
// sees, instead of just a bare dollar figure with no context.
function descriptionHtml(invoice) {
  if (!invoice.description) return '';
  return `<p class="portal-sub" style="margin:2px 0 0;">${invoice.description}</p>`;
}

function render(invoice) {
  const amount = Number(invoice.amount).toFixed(2);

  if (invoice.status === 'paid' || params.get('paid') === '1') {
    card.innerHTML = `
      <h1>Thanks!</h1>
      <p class="portal-sub">This invoice for $${amount}${invoice.description ? ` (${invoice.description})` : ''} has been paid. We appreciate your business.</p>
    `;
    return;
  }

  if (invoice.status === 'bundled') {
    const combinedLink = invoice.bundledIntoInvoiceId ? `${window.location.origin}/pay/${invoice.bundledIntoInvoiceId}` : null;
    card.innerHTML = `
      <h1>Invoice #${invoice.id}</h1>
      <p class="portal-sub">This charge has been combined into a monthly invoice.${combinedLink ? ' Please use the link below to view and pay it.' : ' Please contact High Desert Spa Service for your current invoice link.'}</p>
      ${combinedLink ? `<a class="btn primary" href="${combinedLink}">View combined invoice</a>` : ''}
    `;
    return;
  }

  // High Desert doesn't use Stripe — Wave is the actual payment path here. If this
  // invoice has synced to Wave and Wave Payments is turned on for that business,
  // waveViewUrl (see lib/waveSync.js) is a real page a customer can pay on. If it
  // hasn't synced yet (or Wave isn't configured at all), fall back to a plain
  // "contact us" message rather than implying something's broken.
  if (!invoice.stripeConfigured) {
    const payAction = invoice.waveViewUrl
      ? `<a class="btn primary" href="${invoice.waveViewUrl}" target="_blank" rel="noopener noreferrer">Pay online</a>`
      : `<p class="portal-sub">Please contact High Desert Spa Service to arrange payment.</p>`;
    card.innerHTML = `
      <h1>Invoice #${invoice.id}</h1>
      <p class="portal-sub">${invoice.customerName ? invoice.customerName + ' — ' : ''}Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
      ${descriptionHtml(invoice)}
      ${lineItemsHtml(invoice)}
      ${payAction}
    `;
    return;
  }

  card.innerHTML = `
    <h1>Invoice #${invoice.id}</h1>
    <p class="portal-sub">${invoice.customerName ? invoice.customerName + ' — ' : ''}Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
    ${descriptionHtml(invoice)}
    ${lineItemsHtml(invoice)}
    <div id="payError" class="portal-error hidden"></div>
    <button class="btn primary" id="payBtn">Pay $${amount} now</button>
  `;

  document.getElementById('payBtn').addEventListener('click', async () => {
    const btn = document.getElementById('payBtn');
    const errEl = document.getElementById('payError');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Redirecting to secure checkout…';
    try {
      const res = await fetch(`/api/pay/${invoiceId}/checkout`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');
      window.location.href = data.url;
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = `Pay $${amount} now`;
    }
  });
}

load();
