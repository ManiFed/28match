const PREDICTION_MODEL_STORAGE_KEY = 'predictionModel'
const PREDICTION_STATS_STORAGE_KEY = 'predictionStats'

const DEFAULT_MODEL = {
  sideBias: { dem: 0, rep: 0 },
  traitBias: { underdog: 0, favorite: 0 },
  tagBias: {},
}

const DEFAULT_STATS = { correct: 0, total: 0 }

/** Tags every candidate gets — too noisy for pairwise prediction. */
const GENERIC_TAG_PREFIXES = [
  'party-',
  'supports-',
  'issue-',
  'coalition-',
  'primary-lane-',
  'ideology-spectrum-',
  'temperament-coalitional',
  'policy-profile-',
  'generic-',
  'name-agnostic',
  'candidate-first-name-',
  'candidate-last-name-',
  'candidate-initials-',
  'candidate-name-length-',
  'matchup-pool-size-',
  'candidate-prob-bucket-',
  'dem-tier-rank-',
  'rep-tier-rank-',
  'electability-',
  'non-deep-longshot',
  'mid-odds',
  'high-odds',
  'low-odds',
  'very-high-odds',
  'lower-mid-odds',
]

export function isDiscriminativeTag(tag) {
  return !GENERIC_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))
}

export function classifyVoteTrait(vote) {
  const pickedProb = vote?.side === 'dem' ? Number(vote?.demProb) || 0 : Number(vote?.repProb) || 0
  const otherProb = vote?.side === 'dem' ? Number(vote?.repProb) || 0 : Number(vote?.demProb) || 0
  return pickedProb < otherProb ? 'underdog' : 'favorite'
}

function loadJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function saveJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota errors
  }
}

export function loadPredictionModel() {
  const stored = loadJson(PREDICTION_MODEL_STORAGE_KEY, DEFAULT_MODEL)
  return {
    sideBias: { dem: 0, rep: 0, ...(stored?.sideBias || {}) },
    traitBias: { underdog: 0, favorite: 0, ...(stored?.traitBias || {}) },
    tagBias: { ...(stored?.tagBias || {}) },
  }
}

export function savePredictionModel(model) {
  saveJson(PREDICTION_MODEL_STORAGE_KEY, model)
}

export function loadPredictionStats() {
  const stored = loadJson(PREDICTION_STATS_STORAGE_KEY, DEFAULT_STATS)
  return {
    correct: Number(stored?.correct) || 0,
    total: Number(stored?.total) || 0,
  }
}

export function savePredictionStats(stats) {
  saveJson(PREDICTION_STATS_STORAGE_KEY, stats)
}

export function recordPredictionOutcome(stats, { predictedSide, actualSide }) {
  if (!predictedSide || !actualSide) return stats
  const next = {
    correct: stats.correct + (predictedSide === actualSide ? 1 : 0),
    total: stats.total + 1,
  }
  savePredictionStats(next)
  return next
}

export function updatePredictionModel(model, { predictedSide, actualSide, pickedTags = [], missedTags = [], trait }) {
  const learningRate = predictedSide === actualSide ? 0.06 : 0.18
  const sideDelta = predictedSide === actualSide ? 0.08 : 0.22
  const traitDelta = predictedSide === actualSide ? 0.06 : 0.18
  const tagDelta = predictedSide === actualSide ? 0.04 : 0.1

  const nextSideBias = {
    dem: (model?.sideBias?.dem || 0) * (1 - learningRate),
    rep: (model?.sideBias?.rep || 0) * (1 - learningRate),
  }
  nextSideBias[actualSide] += sideDelta
  const oppositeSide = actualSide === 'dem' ? 'rep' : 'dem'
  nextSideBias[oppositeSide] -= sideDelta * 0.6

  const nextTraitBias = {
    underdog: (model?.traitBias?.underdog || 0) * (1 - learningRate),
    favorite: (model?.traitBias?.favorite || 0) * (1 - learningRate),
  }
  if (trait) {
    const oppositeTrait = trait === 'underdog' ? 'favorite' : 'underdog'
    nextTraitBias[trait] += traitDelta
    nextTraitBias[oppositeTrait] -= traitDelta * 0.45
  }

  const nextTagBias = { ...(model?.tagBias || {}) }
  pickedTags.filter(isDiscriminativeTag).forEach((tag) => {
    nextTagBias[tag] = (nextTagBias[tag] || 0) + tagDelta
  })
  missedTags.filter(isDiscriminativeTag).forEach((tag) => {
    nextTagBias[tag] = (nextTagBias[tag] || 0) - (tagDelta * 0.55)
  })

  const next = {
    sideBias: nextSideBias,
    traitBias: nextTraitBias,
    tagBias: nextTagBias,
  }
  savePredictionModel(next)
  return next
}

function buildVoteProfile(votes) {
  if (!votes.length) {
    return { preferredSide: 'dem', preferredTrait: 'underdog', demShare: 0.5 }
  }
  let demCount = 0
  let underdogCount = 0
  votes.forEach((vote) => {
    if (vote.side === 'dem') demCount += 1
    if (classifyVoteTrait(vote) === 'underdog') underdogCount += 1
  })
  const total = votes.length
  return {
    preferredSide: demCount >= total - demCount ? 'dem' : 'rep',
    preferredTrait: underdogCount >= total - underdogCount ? 'underdog' : 'favorite',
    demShare: demCount / total,
  }
}

function buildNameAffinity(votes) {
  const dem = {}
  const rep = {}
  votes.forEach((vote) => {
    if (vote.side === 'dem' && vote.demName) {
      dem[vote.demName] = (dem[vote.demName] || 0) + 1
    }
    if (vote.side === 'rep' && vote.repName) {
      rep[vote.repName] = (rep[vote.repName] || 0) + 1
    }
  })
  return { dem, rep }
}

function buildDiscriminativeTagWeights(votes, getCandidateTags, demCandidates, repCandidates) {
  const weights = {}
  votes.forEach((vote) => {
    const demCandidate = { name: vote.demName, prob: vote.demProb }
    const repCandidate = { name: vote.repName, prob: vote.repProb }
    const demTags = getCandidateTags(demCandidate, 'dem', demCandidates)
    const repTags = getCandidateTags(repCandidate, 'rep', repCandidates)
    const picked = vote.side === 'dem' ? demTags : repTags
    const skipped = vote.side === 'dem' ? repTags : demTags
    picked.filter(isDiscriminativeTag).forEach((tag) => {
      weights[tag] = (weights[tag] || 0) + 1
    })
    skipped.filter(isDiscriminativeTag).forEach((tag) => {
      weights[tag] = (weights[tag] || 0) - 0.45
    })
  })
  return weights
}

function traitScoreForSide(side, matchup, preferredTrait) {
  const demProb = Number(matchup.dem?.prob) || 0
  const repProb = Number(matchup.rep?.prob) || 0
  const demIsUnderdog = demProb < repProb
  const repIsUnderdog = repProb < demProb
  if (preferredTrait === 'underdog') {
    return side === 'dem' ? (demIsUnderdog ? 0.55 : -0.35) : (repIsUnderdog ? 0.55 : -0.35)
  }
  return side === 'dem' ? (demProb >= repProb ? 0.55 : -0.35) : (repProb >= demProb ? 0.55 : -0.35)
}

function tagScoreForSide(tags, tagWeights, model) {
  return tags.filter(isDiscriminativeTag).reduce((acc, tag) => {
    const history = tagWeights[tag] || 0
    const learned = model?.tagBias?.[tag] || 0
    if (history > 0) return acc + Math.min(0.9, history * 0.22) + learned * 0.35
    if (history < 0) return acc + Math.max(-0.35, history * 0.12) + learned * 0.35
    return acc + learned * 0.2
  }, 0)
}

function softmaxPair(demScore, repScore, temperature = 2.8) {
  const maxScore = Math.max(demScore, repScore)
  const demExp = Math.exp((demScore - maxScore) / temperature)
  const repExp = Math.exp((repScore - maxScore) / temperature)
  const total = demExp + repExp || 1
  return { dem: demExp / total, rep: repExp / total }
}

function calibrationFromHistory(votes, stats) {
  const sampleConfidence = Math.min(0.45, Math.sqrt(votes.length / 48))
  const tracked = stats.total >= 4
    ? stats.correct / stats.total
    : null
  const accuracyScale = tracked === null
    ? 0.55
    : Math.max(0.25, Math.min(0.85, 0.35 + tracked * 0.65))
  return sampleConfidence * accuracyScale
}

function calibrateProbabilities(rawDem, rawRep, calibrationStrength) {
  const rawEdge = rawDem - 0.5
  const maxEdge = 0.1 + calibrationStrength * 0.12
  const edge = Math.max(-maxEdge, Math.min(maxEdge, rawEdge * (0.35 + calibrationStrength)))
  const demChance = 0.5 + edge
  return { demChance, repChance: 1 - demChance }
}

/**
 * Predict which side the user will pick in a Dem vs Rep matchup.
 * Designed to stay humble: capped edge, discriminative tags only, name memory.
 */
export function predictMatchupVote({
  matchup,
  votes,
  model = DEFAULT_MODEL,
  stats = DEFAULT_STATS,
  getCandidateTags,
  demCandidates,
  repCandidates,
}) {
  if (!matchup || !votes.length) {
    return null
  }

  const profile = buildVoteProfile(votes.slice(-80))
  const nameAffinity = buildNameAffinity(votes.slice(-80))
  const tagWeights = buildDiscriminativeTagWeights(
    votes.slice(-80),
    getCandidateTags,
    demCandidates,
    repCandidates,
  )

  const demTags = getCandidateTags(matchup.dem, 'dem', demCandidates)
  const repTags = getCandidateTags(matchup.rep, 'rep', repCandidates)

  const sidePriorDem = (profile.demShare - 0.5) * 1.1
  const sidePriorRep = (0.5 - profile.demShare) * 1.1

  const demNameBoost = nameAffinity.dem[matchup.dem.name]
    ? Math.min(1.2, 0.35 + Math.log1p(nameAffinity.dem[matchup.dem.name]) * 0.45)
    : 0
  const repNameBoost = nameAffinity.rep[matchup.rep.name]
    ? Math.min(1.2, 0.35 + Math.log1p(nameAffinity.rep[matchup.rep.name]) * 0.45)
    : 0

  const demScore = (
    sidePriorDem
    + (model?.sideBias?.dem || 0) * 0.45
    + traitScoreForSide('dem', matchup, profile.preferredTrait)
    + (model?.traitBias?.[profile.preferredTrait] || 0) * 0.35
    + tagScoreForSide(demTags, tagWeights, model)
    + demNameBoost
  )
  const repScore = (
    sidePriorRep
    + (model?.sideBias?.rep || 0) * 0.45
    + traitScoreForSide('rep', matchup, profile.preferredTrait)
    + (model?.traitBias?.[profile.preferredTrait] || 0) * 0.35
    + tagScoreForSide(repTags, tagWeights, model)
    + repNameBoost
  )

  const raw = softmaxPair(demScore, repScore)
  const calibrationStrength = calibrationFromHistory(votes, stats)
  const { demChance, repChance } = calibrateProbabilities(raw.dem, raw.rep, calibrationStrength)

  const preferredSide = demScore === repScore
    ? (profile.preferredSide === 'dem' ? 'dem' : 'rep')
    : demScore > repScore ? 'dem' : 'rep'

  return {
    side: preferredSide,
    demChance,
    repChance,
    topProbability: Math.max(demChance, repChance),
  }
}