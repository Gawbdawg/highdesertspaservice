const PDFDocument = require('pdfkit');
const { BUSINESS_TIMEZONE } = require('./timezone');
const { AGREEMENT_TITLE, AGREEMENT_INTRO, AGREEMENT_SECTIONS, AGREEMENT_ACKNOWLEDGMENT } = require('./agreementText');

function formatAgreedAt(isoString) {
  if (!isoString) return 'Not yet agreed';
  const d = new Date(isoString);
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);
  return `${formatted} (Pacific time)`;
}

// Builds a PDF copy of the signed Service Agreement for one owner — a durable record of
// who agreed and when, matching exactly what they saw and checked the box against in
// their portal (see public/owner.html#termsText / lib/agreementText.js). Returns a
// PDFDocument that the caller pipes to a response (or a file) and then calls .end() on.
function buildAgreementPdf(owner, properties) {
  const doc = new PDFDocument({ margin: 54, size: 'LETTER' });

  doc.fontSize(16).font('Helvetica-Bold').text('High Desert Spa Service', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(13).font('Helvetica-Bold').text(AGREEMENT_TITLE, { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Oblique').fillColor('#666')
    .text('Signed copy — electronically agreed via the owner portal', { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(1);

  // Signer summary box
  const boxTop = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text('Agreed by:', 54, boxTop);
  doc.font('Helvetica').text(owner.name || 'Unknown', 160, boxTop);
  let row = boxTop + 16;
  doc.font('Helvetica-Bold').text('Email:', 54, row);
  doc.font('Helvetica').text(owner.email || '—', 160, row);
  row += 16;
  doc.font('Helvetica-Bold').text('Phone:', 54, row);
  doc.font('Helvetica').text(owner.phone || '—', 160, row);
  row += 16;
  doc.font('Helvetica-Bold').text('Properties:', 54, row);
  doc.font('Helvetica').text(properties.length ? properties.map((p) => p.name || p.address || `#${p.id}`).join(', ') : '—', 160, row, { width: 380 });
  row = doc.y + 4;
  doc.font('Helvetica-Bold').text('Agreed on:', 54, row);
  doc.font('Helvetica').fillColor(owner.agreedToTerms ? '#000' : '#b00020')
    .text(formatAgreedAt(owner.agreedToTermsAt), 160, row);
  doc.fillColor('#000');
  doc.moveDown(2);

  doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(1);

  doc.fontSize(9).font('Helvetica');
  AGREEMENT_INTRO.forEach((p) => {
    doc.font(p === AGREEMENT_INTRO[0] ? 'Helvetica-Bold' : 'Helvetica').text(p, { align: 'left' });
    doc.moveDown(0.5);
  });

  AGREEMENT_SECTIONS.forEach((section) => {
    doc.font('Helvetica-Bold').fontSize(10).text(section.heading);
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(9).text(section.body, { align: 'left' });
    doc.moveDown(0.6);
  });

  doc.font('Helvetica-Bold').fontSize(10).text(AGREEMENT_ACKNOWLEDGMENT.heading);
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(9).text(AGREEMENT_ACKNOWLEDGMENT.body);
  doc.moveDown(1.5);

  doc.fontSize(8).fillColor('#666').text(
    `This record reflects an electronic agreement captured by High Desert Spa Service's owner portal. Generated ${new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date())} (Pacific time).`,
  );

  return doc;
}

module.exports = { buildAgreementPdf, formatAgreedAt };
