// The canonical text of the Service Agreement & Terms of Service — kept as plain text
// here so it can be rendered into a PDF (see routes/owners.js#/agreement.pdf) without
// parsing HTML. This must be kept in sync by hand with the embedded copy owners see and
// check the box against in public/owner.html (#termsText) — the wording is identical,
// just without the inline HTML formatting.
const AGREEMENT_TITLE = 'Service Agreement & Terms of Service';
const AGREEMENT_INTRO = [
  'High Desert Spa Service',
  'By requesting, scheduling, or paying for services from High Desert Spa Service ("Company," "we," "us"), the customer ("Customer," "you") agrees to the following terms:',
];

const AGREEMENT_SECTIONS = [
  {
    heading: '1. Services',
    body: 'Company provides hot tub/spa maintenance and repair services, including but not limited to water testing and chemical balancing, filter cleaning or replacement, equipment inspection, jet and pump servicing, cover maintenance, and general repairs.',
  },
  {
    heading: '2. Assumption of Risk',
    body: 'Customer acknowledges that hot tubs and spas involve inherent risks, including electrical hazards, water damage, chemical exposure, mechanical failure, and slip hazards. Customer voluntarily assumes all such risks associated with the ownership, operation, and maintenance of their spa/hot tub.',
  },
  {
    heading: '3. Limitation of Liability',
    body: "To the fullest extent permitted under Oregon law, Company is not liable for any indirect, incidental, consequential, special, or punitive damages arising from Services provided, including property damage, personal injury, loss of use, or water/chemical damage to surrounding structures or landscaping — except to the extent caused by Company's gross negligence or willful misconduct.\n\nCompany's total liability for any claim arising from the Services shall not exceed the amount Customer paid for the specific service giving rise to the claim.",
  },
  {
    heading: '4. No Warranty on Pre-Existing Conditions',
    body: 'Company is not liable for pre-existing damage, defects, or conditions of the spa/hot tub or surrounding structures that were not caused by Company. Customer is responsible for disclosing known issues prior to service.',
  },
  {
    heading: '5. Indemnification',
    body: "Customer agrees to indemnify and hold harmless Company, its owners, employees, and agents from claims, damages, losses, or expenses (including reasonable attorney's fees) arising from Customer's misuse of the spa/hot tub, failure to follow Company's maintenance recommendations, or breach of this Agreement.",
  },
  {
    heading: '6. Third-Party Parts',
    body: 'Company is not responsible for defects in parts or components not manufactured by Company. Manufacturer warranties, where applicable, govern those parts instead.',
  },
  {
    heading: '7. Chemical and Water Balance Disclaimer',
    body: "Company uses reasonable industry standards when balancing water chemistry but is not responsible for damage resulting from Customer's alteration of water balance after service, or from pre-existing water quality issues.",
  },
  {
    heading: '8. Cancellation Policy',
    body: 'Customer may cancel or reschedule a scheduled service at no charge if notice is given more than 24 hours before the appointment. Cancellations or rescheduling requests made within 24 hours of the scheduled appointment will be charged 50% of the service price.',
  },
  {
    heading: '9. Governing Law',
    body: 'This Agreement is governed by the laws of the State of Oregon, without regard to conflict of law principles.',
  },
  {
    heading: '10. Severability',
    body: 'If any provision of this Agreement is found unenforceable, the remaining provisions remain in full force and effect.',
  },
  {
    heading: '11. Entire Agreement',
    body: 'This Agreement is the entire agreement between the parties regarding the Services and supersedes any prior discussions or agreements, written or oral.',
  },
  {
    heading: '12. Communications',
    body: 'By agreeing to this Agreement, Customer also consents to receive occasional email updates from Company (service announcements, seasonal information, and similar communications). Customer may unsubscribe from these updates at any time from their account, without affecting the rest of this Agreement.',
  },
];

const AGREEMENT_ACKNOWLEDGMENT = {
  heading: 'Acknowledgment',
  body: 'By signing below, checking "I agree," or proceeding with scheduled service, Customer confirms they have read, understood, and agree to these terms.',
};

module.exports = { AGREEMENT_TITLE, AGREEMENT_INTRO, AGREEMENT_SECTIONS, AGREEMENT_ACKNOWLEDGMENT };
