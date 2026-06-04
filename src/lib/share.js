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

  /** @type {Map<string, { name: string, party: 'dem' | 'rep', votes: number }>} */
  const counts = new Map();

  for (const vote of votes) {
    if (vote.side === 'dem') {
      const name = vote.demName;
      const prev = counts.get(name);
      counts.set(name, {
        name,
        party: 'dem',
        votes: (prev?.votes || 0) + 1,
      });
    } else if (vote.side === 'rep') {
      const name = vote.repName;
      const prev = counts.get(name);
      counts.set(name, {
        name,
        party: 'rep',
        votes: (prev?.votes || 0) + 1,
      });
    }
  }

  const affinities = Array.from(counts.values()).map(({ name, party, votes: voteCount }) => ({
    name,
    party,
    votes: voteCount,
    affinity: voteCount,
  }));

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
  const minAffinity = top[top.length - 1].affinity;
  const spread = maxAffinity - minAffinity;

  return top.map((item) => ({
    name: item.name,
    party: item.party,
    votes: item.votes,
    affinity: item.affinity,
    photoUrl: item.photoUrl ?? null,
    // Linear scale so favorites read clearly larger on the card
    size:
      spread > 0
        ? 0.32 + 0.68 * ((item.affinity - minAffinity) / spread)
        : 1,
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

/**
 * Computes richer per-candidate support statistics.
 * This is much better signal for the LLM than raw votes alone.
 */
export function computeCandidateSupportStats(votes = []) {
  const stats = new Map();

  votes.forEach(vote => {
    const dem = vote.demName;
    const rep = vote.repName;

    // Dem candidate
    if (!stats.has(dem)) {
      stats.set(dem, { name: dem, party: 'dem', appearances: 0, votesFor: 0, strongSupport: 0 });
    }
    const demStats = stats.get(dem);
    demStats.appearances += 1;
    if (vote.side === 'dem') {
      demStats.votesFor += 1;
      if (vote.strength === 'strong') demStats.strongSupport += 1;
    }

    // Rep candidate
    if (!stats.has(rep)) {
      stats.set(rep, { name: rep, party: 'rep', appearances: 0, votesFor: 0, strongSupport: 0 });
    }
    const repStats = stats.get(rep);
    repStats.appearances += 1;
    if (vote.side === 'rep') {
      repStats.votesFor += 1;
      if (vote.strength === 'strong') repStats.strongSupport += 1;
    }
  });

  return Array.from(stats.values())
    .map(s => ({
      ...s,
      supportRate: s.appearances > 0 ? Math.round((s.votesFor / s.appearances) * 100) : 0,
    }))
    .sort((a, b) => b.votesFor - a.votesFor);
}

/**
 * Prepares a much richer payload for the AI insights endpoint.
 */
export function prepareInsightsPayload(votes = [], skips = []) {
  const lean = computePartisanLean(votes);
  const candidateStats = computeCandidateSupportStats(votes);

  // Separate high-signal skips (those where a prediction was shown)
  const highSignalSkips = skips.filter(s => s.predictedSide).slice(-50);

  return {
    totalVotes: votes.length,
    lean,
    candidateStats,                    // Very useful aggregate view
    recentVotes: votes.slice(-80),     // Raw recent votes for pattern detection
    highSignalSkips,
    hasStrongVotes: votes.some(v => v.strength === 'strong'),
  };
}
