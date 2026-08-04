// Deterministic hot-tub/spa dosage math — no AI involved, on purpose. Chemical amounts
// need to be precise and reproducible, not generated text, so this is plain arithmetic
// against published spa-dosing ratios (NOT swimming-pool ratios, which are ~20x the
// volume and use different products like cal-hypo).
//
// All formulas are scaled for typical spa volumes (200-600 gallons) and are estimates —
// every recommendation is labeled as such in the UI, and technicians should always
// confirm with a fresh test strip/reagent reading before and after dosing.

const DEFAULT_GALLONS = 400; // used when a customer has no waterVolumeGallons set

// ~0.13oz granular dichlor per 100 gallons raises free chlorine by 1ppm.
const OZ_DICHLOR_PER_GAL_PER_PPM_FC = 0.0013;

// ~0.5oz pH increaser (soda ash) per 500 gallons raises pH by ~0.2.
const OZ_PH_ADJUST_PER_GAL_PER_PH_POINT = 0.005;

// ~0.8oz alkalinity increaser (sodium bicarbonate) per 500 gallons raises TA by ~10ppm.
const OZ_TA_INCREASER_PER_GAL_PER_PPM = 0.00016;

const TARGETS = {
  freeChlorine: 5, // ppm, mid of the 3-5ppm spa range
  ph: 7.4, // mid of the 7.2-7.6 spa range
  alkalinity: 100, // ppm, mid of the 80-120 spa range
};

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Rough oz -> tablespoon conversion for granular pool/spa chemicals (~2 tbsp per oz).
// Only used to give techs a familiar kitchen-measure alongside the precise oz figure.
function ozToTbsp(oz) {
  return round(oz * 2, 1);
}

function recommendChlorine({ gallons = DEFAULT_GALLONS, currentFC, targetFC = TARGETS.freeChlorine }) {
  const delta = targetFC - currentFC;
  if (delta <= 0) return null;
  const oz = round(delta * gallons * OZ_DICHLOR_PER_GAL_PER_PPM_FC);
  if (oz <= 0) return null;
  return {
    chemical: 'Granular dichlor',
    amountOz: oz,
    amountTbsp: ozToTbsp(oz),
    reason: `Free chlorine at ${currentFC}ppm, target ${targetFC}ppm`,
  };
}

function recommendPh({ gallons = DEFAULT_GALLONS, currentPH, targetPH = TARGETS.ph }) {
  const delta = targetPH - currentPH;
  if (Math.abs(delta) < 0.05) return null;
  const oz = round(Math.abs(delta) * gallons * OZ_PH_ADJUST_PER_GAL_PER_PH_POINT);
  if (oz <= 0) return null;
  return {
    chemical: delta > 0 ? 'pH increaser (soda ash)' : 'pH decreaser (sodium bisulfate)',
    amountOz: oz,
    amountTbsp: ozToTbsp(oz),
    reason: `pH at ${currentPH}, target ${targetPH}`,
  };
}

function recommendAlkalinity({ gallons = DEFAULT_GALLONS, currentTA, targetTA = TARGETS.alkalinity }) {
  const delta = targetTA - currentTA;
  if (delta <= 4) return null; // only recommend a raise; TA decreases are usually handled via dilution, not chemical
  const oz = round(delta * gallons * OZ_TA_INCREASER_PER_GAL_PER_PPM);
  if (oz <= 0) return null;
  return {
    chemical: 'Alkalinity increaser (sodium bicarbonate)',
    amountOz: oz,
    amountTbsp: ozToTbsp(oz),
    reason: `Total alkalinity at ${currentTA}ppm, target ${targetTA}ppm`,
  };
}

// Takes a raw reading `{ gallons, freeChlorine, ph, alkalinity }` and returns an array of
// dosage recommendations (empty if everything's already in range). Each item is
// `{ chemical, amountOz, amountTbsp, reason }`. All estimates — always confirm by retest.
function recommendDosage({ gallons, freeChlorine, ph, alkalinity } = {}) {
  const g = gallons || DEFAULT_GALLONS;
  const recs = [];
  if (freeChlorine != null) {
    const r = recommendChlorine({ gallons: g, currentFC: Number(freeChlorine) });
    if (r) recs.push(r);
  }
  if (alkalinity != null) {
    const r = recommendAlkalinity({ gallons: g, currentTA: Number(alkalinity) });
    if (r) recs.push(r);
  }
  // Adjust alkalinity before pH — standard spa-care order — so pH recs are appended last.
  if (ph != null) {
    const r = recommendPh({ gallons: g, currentPH: Number(ph) });
    if (r) recs.push(r);
  }
  return recs;
}

module.exports = {
  DEFAULT_GALLONS,
  TARGETS,
  recommendChlorine,
  recommendPh,
  recommendAlkalinity,
  recommendDosage,
};
