// Turns a street address into lat/lng coordinates using OpenStreetMap's free
// Nominatim service — no API key needed. Nominatim's usage policy caps requests
// at 1/second and requires a descriptive User-Agent, which is why callers that
// geocode many addresses (see routes/customers.js geocode-all) space requests out
// rather than firing them all at once. Results should always be cached (we save
// lat/lng back onto the customer record) so we rarely need to call this again.
async function geocodeAddress(address) {
  if (!address || !address.trim()) throw new Error('No address given');
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'HighDesertSpaService-Ops/1.0 (contact: highdesertspaservice@gmail.com)',
    },
  });
  if (!res.ok) throw new Error(`Geocoding request failed (HTTP ${res.status})`);
  const results = await res.json();
  if (!results || results.length === 0) throw new Error('Address not found');
  // display_name is Nominatim's full standardized match (e.g. "123 Main St, Lincoln
  // City, Lincoln County, Oregon, 97367, United States") — shown back to whoever typed
  // the address in so they can visually confirm it found the right place, not just
  // "some" place that happened to match.
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), displayName: results[0].display_name || '' };
}

module.exports = { geocodeAddress };
