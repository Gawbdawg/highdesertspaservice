// Orders a list of stops into an efficient driving route using a nearest-neighbor
// heuristic over straight-line (haversine) distance from geocoded coordinates.
// This isn't true turn-by-turn optimization (no road network or drive-time data —
// that needs a paid API like Google Directions), but for a small town it gets you
// a solidly ordered "closest thing next" route instead of an arbitrary list order.

function haversineMiles(a, b) {
  const R = 3958.8; // Earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// stops: array of any objects that may have .lat/.lng. Returns { ordered, unroutable }
// where `ordered` is the routable stops in nearest-neighbor order from depot, and
// `unroutable` is any stops missing coordinates (appended separately, original order).
function orderStopsByRoute(depot, stops) {
  const routable = stops.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  const unroutable = stops.filter((s) => !(typeof s.lat === 'number' && typeof s.lng === 'number'));

  if (!depot || typeof depot.lat !== 'number' || typeof depot.lng !== 'number' || routable.length === 0) {
    return { ordered: routable, unroutable };
  }

  const remaining = [...routable];
  const ordered = [];
  let current = depot;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineMiles(current, s);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    current = next;
  }
  return { ordered, unroutable };
}

module.exports = { haversineMiles, orderStopsByRoute };
