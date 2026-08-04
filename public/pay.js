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

function lineItemsHtml(invoice) {
  if (!invoice.lineItems || invoice.lineItems.length === 0) return '';
  return `
    <div style="text-align:left; border-top:1px solid #eef1f2; border-bottom:1px solid #eef1f2; margin:12px 0; padding:8px 0;">
      ${invoice.lineItems.map((li) => `
        <div style="display:flex; justify-content:space-between; font-size:13px; padding:3px 0; color:#46606b;">
          <span>${li.date} — ${li.customerName} (${li.serviceType})</span>
          <span>$${Number(li.amount).toFixed(2)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function render(invoice) {
  const amount = Number(invoice.amount).toFixed(2);

  if (invoice.status === 'paid' || params.get('paid') === '1') {
    card.innerHTML = `
      <h1>Thanks!</h1>
      <p class="portal-sub">This invoice for $${amount} has been paid. We appreciate your business.</p>
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

  if (!invoice.stripeConfigured) {
    card.innerHTML = `
      <h1>Invoice #${invoice.id}</h1>
      <p class="portal-sub">${invoice.customerName ? invoice.customerName + ' — ' : ''}Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
      ${lineItemsHtml(invoice)}
      <p class="portal-sub">Online payment isn't turned on yet — please contact High Desert Spa Service to arrange payment.</p>
    `;
    return;
  }

  card.innerHTML = `
    <h1>Invoice #${invoice.id}</h1>
    <p class="portal-sub">${invoice.customerName ? invoice.customerName + ' — ' : ''}Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
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
