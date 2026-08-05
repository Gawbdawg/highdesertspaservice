const store = require('./store');

// Friendly, customer-facing description of what an invoice is billing for. Shared by
// the "Email invoice" text (routes/invoices.js), the payment reminder text, and the
// public /pay/:id page (routes/pay.js + public/pay.js) — anywhere a customer or owner
// might see an invoice and reasonably ask "what's this for?"
//
// A combined invoice (multiple jobs bundled into one bill — either every property an
// owner has, or just one property's jobs for the month, see lib/monthlyInvoice.js)
// summarizes the whole batch by date range. A single invoice linked to a specific
// appointment names that job's service type and date. Anything else (a cancellation
// fee, a manually-created invoice) falls back to the invoice's own notes, or just says
// when it was issued.
function invoiceDescription(invoice) {
  if ((invoice.lineItems || []).length) {
    const count = invoice.lineItems.length;
    const dates = invoice.lineItems.map((li) => li.date).sort();
    return `${count} service${count === 1 ? '' : 's'} completed between ${dates[0]} and ${dates[dates.length - 1]}`;
  }
  if (invoice.appointmentId) {
    const appt = store.getById('appointments', invoice.appointmentId);
    if (appt) return `${appt.serviceType || 'service'} on ${appt.date}`;
  }
  return invoice.notes ? invoice.notes : `service billed on ${invoice.issuedDate || 'file'}`;
}

module.exports = { invoiceDescription };
