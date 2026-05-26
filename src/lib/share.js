/**
 * Shareable card data layer
 * Pure functions for computing partisan lean and candidate affinities from vote history.
 * These can run on both client and server.
 */

/**
 * @typedef {Object} Vote
 * @property {string} side - 'dem' | 'rep'
 * @property {string} demName
 * @property {string} repName
 * @property {number} demProb
 * @property {number} repProb
 * @property {string[]} [pickedTags]
 */

/**
 * Computes the user's overall partisan lean from their votes.
 * Returns percentages and a normalized lean value.
 */
export function computePartisanLean(votes = []) {
  if (!votes.length) {
    return {
      demPct: 50,
      repPct: 50,
      lean: 'dem',
      leanStrength: 0,
      totalVotes: 0,
    };
  }

  let demVotes = 0;
  let repVotes = 0;

  for (const vote of votes) {
    if (vote.side === 'dem') demVotes += 1;
    else if (vote.side === 'rep') repVotes += 1;
  }

  const total = demVotes + repVotes;
  const demPct = Math.round((demVotes / total) * 100);
  const repPct = 100 - demPct;

  const diff = Math.abs(demVotes - repVotes);
  const leanStrength = Math.min(1, diff / Math.max(8, total * 0.4));

  return {
    demPct,
    repPct,
    lean: demVotes >= repVotes ? 'dem' : 'rep',
    leanStrength: Number(leanStrength.toFixed(2)),
    totalVotes: total,
  };
}

/**
 * Computes affinity scores for every candidate the user has voted on.
 * Higher score = bigger bubble.
 *
 * Current simple model:
 * - Raw vote count for that candidate is the primary driver.
 * - We normalize lightly so one very active voter doesn't completely dominate.
 */
export function computeCandidateAffinities(votes = []) {
  if (!votes.length) return [];

  const counts = new Map();

  for (const vote of votes) {
    const demName = vote.demName;
    const repName = vote.repName;

    if (vote.side === 'dem') {
      counts.set(demName, (counts.get(demName) || 0) + 1);
    } else {
      counts.set(repName, (counts.get(repName) || 0) + 1);
    }
  }

  // Convert to array and compute normalized affinity
  const affinities = Array.from(counts.entries()).map(([name, voteCount]) => {
    // For now we treat all candidates equally regardless of party for sizing.
    // We can add party later if needed for coloring bubbles.
    const affinity = Math.sqrt(voteCount); // sqrt gives nice visual scaling for "a lot" of bubbles

    return {
      name,
      votes: voteCount,
      affinity: Number(affinity.toFixed(2)),
    };
  });

  // Sort by affinity descending
  affinities.sort((a, b) => b.affinity - a.affinity);

  return affinities;
}

/**
 * Returns the top N candidates by affinity, with normalized sizes
 * ready for bubble rendering.
 */
export function getTopCandidateBubbles(votes = [], maxBubbles = 18) {
  const affinities = computeCandidateAffinities(votes);
  const top = affinities.slice(0, maxBubbles);

  if (!top.length) return [];

  const maxAffinity = top[0].affinity;

  return top.map((item) => ({
    ...item,
    // Normalized size from ~0.35 to 1.0 for visual variety
    size: maxAffinity > 0 ? Math.max(0.35, item.affinity / maxAffinity) : 0.5,
  }));
}

/**
 * Lightweight summary used for the share payload.
 */
export function buildProfileSharePayload(votes = [], archetype = null) {
  const lean = computePartisanLean(votes);
  const bubbles = getTopCandidateBubbles(votes, 18);

  return {
    lean,
    bubbles,
    totalVotes: lean.totalVotes,
    archetype: archetype || null,
    generatedAt: new Date().toISOString(),
  };
}
