const store = require('./store');
const { sendEmail } = require('./mailer');
const { invoiceDescription } = require('./invoiceDescription');

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

// Same recipient-resolution rule used everywhere else an invoice needs to reach
// someone — an explicit owner-wide invoice's owner, else the property's owner (if
// it has one), else the standalone customer themselves. Kept as its own small copy
// rather than importing routes/invoices.js's resolveInvoiceRecipient, since this
// needs to be callable from lib/autopay.js and routes/stripeWebhook.js too, and a
// lib importing a route file would be backwards.
function resolveReceiptRecipient(invoice) {
  if (invoice.ownerId) {
    const owner = store.getById('owners', invoice.ownerId);
    return owner && owner.email ? { email: owner.email, name: owner.name } : null;
  }
  const customer = invoice.customerId ? store.getById('customers', invoice.customerId) : null;
  if (!customer) return null;
  if (customer.ownerId) {
    const owner = store.getById('owners', customer.ownerId);
    if (owner && owner.email) return { email: owner.email, name: owner.name };
  }
  return customer.email ? { email: customer.email, name: customer.name } : null;
}

// Which property/home this payment was for, in plain language — the whole point of
// this receipt is so an owner with several properties can tell at a glance which one
// a given payment covers, instead of just seeing a bare dollar amount and an invoice
// number.
function propertyReference(invoice) {
  if (invoice.customerId) {
    const customer = store.getById('customers', invoice.customerId);
    return customer ? customer.name : 'your property';
  }
  const names = [...new Set((invoice.lineItems || []).map((li) => li.customerName).filter(Boolean))];
  if (!names.length) return 'your properties';
  if (names.length <= 4) return names.join(', ');
  return `${names.length} properties`;
}

// Fires the moment ANY invoice actually gets marked paid — an online checkout
// payment (see routes/stripeWebhook.js), an autopay charge (see
// lib/autopay.js#attemptAutopay, which covers both the admin's manual "Process
// payment" button and the automatic catch-up sweep), or an admin recording an
// offline payment by hand (see routes/invoices.js PUT /:id). Best-effort and
// non-throwing — a receipt failing to send should never be allowed to undo or block
// a payment that already went through.
async function sendPaymentReceipt(invoice) {
  try {
    const recipient = resolveReceiptRecipient(invoice);
    if (!recipient) return { sent: false, reason: 'No email on file for this invoice.' };

    const property = propertyReference(invoice);
    const paidDate = invoice.paidAt ? invoice.paidAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const text = `Hi ${recipient.name},

This confirms we received your payment of ${money(invoice.amount)} for ${property}.

${invoiceDescription(invoice)}

Paid: ${paidDate}
Invoice #${invoice.id}

Thanks for your business —
High Desert Spa Service`;

    const result = await sendEmail({
      to: recipient.email,
      subject: `Receipt — ${money(invoice.amount)} paid for ${property}`,
      text,
    });
    return { sent: true, to: recipient.email, dryRun: !!(result && result.dryRun) };
  } catch (err) {
    console.error(`Could not send payment receipt for invoice #${invoice.id}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendPaymentReceipt };
