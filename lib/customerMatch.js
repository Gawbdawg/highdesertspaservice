// Shared fuzzy name-matching used anywhere an admin pastes free-text names that need to
// be matched against existing customers (bulk appointment import, bulk contact-info
// update, etc). Deliberately conservative: anything that can't be confidently matched
// to exactly one customer is left unmatched and reported back, since silently attaching
// data to the wrong customer is worse than skipping one.
const normalize = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normalizeNoSpace = (s) => normalize(s).replace(/\s+/g, '');

// Classic Levenshtein edit distance — used for near-miss spellings (e.g. handwritten
// "Teresa" for a customer on file as "Theresa").
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Returns a matcher function bound to a given customer list (pass store.getAll('customers')).
function makeCustomerMatcher(customers) {
  return function findCustomer(name) {
    const n = normalize(name);
    const nNoSpace = normalizeNoSpace(name);
    let matches = customers.filter((c) => normalize(c.name) === n);
    if (matches.length === 1) return matches[0];
    matches = customers.filter((c) => normalizeNoSpace(c.name) === nNoSpace);
    if (matches.length === 1) return matches[0];
    if (nNoSpace.length >= 2) {
      matches = customers.filter((c) => normalizeNoSpace(c.name).startsWith(nNoSpace));
      if (matches.length === 1) return matches[0];
    }
    // Whole-word match — catches a last-name-only reference like "Hoffman" against a
    // customer on file as "Clayton Hoffman" (the prefix check above only looks at the
    // start of the name, so it wouldn't catch this).
    if (n.length >= 3) {
      matches = customers.filter((c) => normalize(c.name).split(' ').includes(n));
      if (matches.length === 1) return matches[0];
    }
    // Fuzzy fallback: only for longer names (short codes are too risky to fuzz), only
    // within a tight distance, and only when there's a single closest candidate —
    // picking the strict minimum (rather than "the only one under the threshold") avoids
    // false ambiguity when one unrelated name happens to also be within the same
    // threshold but further away than the real match.
    if (nNoSpace.length >= 4) {
      const maxDistance = nNoSpace.length <= 4 ? 1 : 2;
      const distances = customers
        .map((c) => ({ c, dist: editDistance(nNoSpace, normalizeNoSpace(c.name)) }))
        .filter((x) => x.dist <= maxDistance);
      if (distances.length > 0) {
        const minDist = Math.min(...distances.map((x) => x.dist));
        const closest = distances.filter((x) => x.dist === minDist);
        if (closest.length === 1) return closest[0].c;
      }
    }
    return null;
  };
}

module.exports = { makeCustomerMatcher, normalize, normalizeNoSpace, editDistance };
