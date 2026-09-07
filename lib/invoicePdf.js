const PDFDocument = require('pdfkit');
const { invoiceDescription } = require('./invoiceDescription');

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

// Builds a PDF copy of an actual invoice — the bill itself, sent before payment (see
// lib/receiptPdf.js for the after-payment counterpart, which this deliberately mirrors
// so the two look like a matched pair). Owners who bill the vacation-rental homeowners
// they work for need a real invoice document to attach to their own bills, not just a
// plain-text email. A combined/monthly invoice (has lineItems) gets the same itemized
// table as the receipt; a single-job invoice just states what it was for. Returns a
// PDFDocument the caller pipes to a response or reads into a Buffer (see
// pdfDocToBuffer below) and then calls .end() on.
function buildInvoicePdf({ invoice, recipient, property, payLink, businessName }) {
  const doc = new PDFDocument({ margin: 54, size: 'LETTER' });

  doc.fontSize(16).font('Helvetica-Bold').text(businessName, { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(13).font('Helvetica-Bold').text('Invoice', { align: 'center' });
  doc.moveDown(1);

  doc.fontSize(10).font('Helvetica');
  doc.text(`Billed to: ${recipient.name || '—'}`);
  doc.text(`Property: ${property}`);
  doc.text(`Invoice #${invoice.id}`);
  doc.text(`Issued: ${invoice.issuedDate || '—'}`);
  if (invoice.dueDate) doc.text(`Due: ${invoice.dueDate}`);
  doc.moveDown(1);

  doc.fontSize(12).font('Helvetica-Bold').text(`Amount due: ${money(invoice.amount)}`);
  doc.moveDown(1);

  const lineItems = [...(invoice.lineItems || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (lineItems.length) {
    const colDate = 54;
    const colProperty = 130;
    const colService = 300;
    const colAmount = 470;
    const rowWidth = { property: colService - colProperty - 8, service: colAmount - colService - 8 };

    doc.fontSize(9).font('Helvetica-Bold');
    let y = doc.y;
    doc.text('Date', colDate, y);
    doc.text('Property', colProperty, y, { width: rowWidth.property });
    doc.text('Service', colService, y, { width: rowWidth.service });
    doc.text('Amount', colAmount, y);
    doc.moveDown(0.4);
    doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(9);
    lineItems.forEach((li) => {
      y = doc.y;
      doc.text(li.date || '', colDate, y);
      doc.text(li.customerName || 'Unknown property', colProperty, y, { width: rowWidth.property });
      doc.text(li.serviceType || 'Service', colService, y, { width: rowWidth.service });
      doc.text(money(li.amount), colAmount, y);
      doc.moveDown(0.5);
    });

    doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).text(`Total due: ${money(invoice.amount)}`, colDate, doc.y, { width: 504, align: 'right' });
  } else {
    doc.fontSize(10).font('Helvetica').text(invoiceDescription(invoice));
  }

  if (payLink) {
    doc.moveDown(1.5);
    doc.fontSize(9).font('Helvetica').fillColor('#1a5276').text(`Pay online: ${payLink}`, { link: payLink, underline: true });
    doc.fillColor('#000');
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#666').text(`Thank you for your business — ${businessName}`);

  return doc;
}

// pdfkit's PDFDocument is a readable stream — this collects it into a Buffer for
// attaching to an email (nodemailer wants a Buffer/string/path, not a live stream tied
// to this request). Caller does NOT need to call doc.end() separately; this does it.
function pdfDocToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { buildInvoicePdf, pdfDocToBuffer };
