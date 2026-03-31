import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import './App.css'

const DEM_SLUG = 'democratic-presidential-nominee-2028'
const REP_SLUG = 'republican-presidential-nominee-2028'
const SESSION_VOTES_STORAGE_KEY = 'sessionVotes'
const SESSION_SKIPS_STORAGE_KEY = 'sessionSkips'
const RECOMMENDATION_ENGAGEMENT_KEY = 'recommendationEngagement'
const MATCHUP_ORDER_STORAGE_KEY = 'matchupOrder'
const VOTE_CONFIRMATION_MS = 500
const STRONG_VOTE_CONFIRMATION_MS = 1000
const PANEL_DOUBLE_CLICK_MS = 230
const PANEL_LONG_PRESS_MS = 380
const PANEL_TAP_MOVE_THRESHOLD_PX = 12
const SWIPE_THRESHOLD_PX = 52
const REQUEST_TIMEOUT_MS = 12000
const INITIAL_RANDOMNESS = 0.2
const APP_BOOT_TIMEOUT_MS = 15000
const BADGE_MILESTONES = [5, 10, 25, 50]
const FALLBACK_DEMS = [
  { id: 'fallback-dem-1', name: 'Gavin Newsom', prob: 0.23 },
  { id: 'fallback-dem-2', name: 'Gretchen Whitmer', prob: 0.19 },
  { id: 'fallback-dem-3', name: 'Alexandria Ocasio-Cortez', prob: 0.12 },
]
const FALLBACK_REPS = [
  { id: 'fallback-rep-1', name: 'Donald Trump', prob: 0.41 },
  { id: 'fallback-rep-2', name: 'Ron DeSantis', prob: 0.22 },
  { id: 'fallback-rep-3', name: 'Nikki Haley', prob: 0.13 },
]
const BASE_POSITION_TAGS = {
  dem: [
    'party-democrat',
    'coalition-center-left',
    'supports-abortion-rights',
    'supports-climate-action',
    'supports-voting-rights',
    'supports-gun-safety-laws',
    'supports-lgbtq-rights',
    'supports-collective-bargaining',
    'supports-healthcare-expansion',
    'supports-immigration-reform',
    'supports-social-safety-net',
    'supports-antitrust-enforcement',
    'supports-public-education-spending',
    'supports-infrastructure-investment',
    'supports-renewable-energy',
    'supports-diplomatic-alliances',
    'supports-prescription-drug-negotiation',
    'supports-paid-family-leave',
    'supports-child-tax-credit-expansion',
    'supports-rich-tax-increases',
    'supports-civil-rights-enforcement',
    'supports-criminal-justice-reform',
    'supports-student-debt-relief',
    'supports-public-option',
    'supports-consumer-protections',
    'supports-pro-labor-nlrb',
    'supports-federal-election-standards',
    'supports-tech-regulation',
    'supports-housing-supply-incentives',
    'supports-asylum-process-modernization',
  ],
  rep: [
    'party-republican',
    'coalition-center-right',
    'supports-tax-cuts',
    'supports-deregulation',
    'supports-border-enforcement',
    'supports-domestic-energy-expansion',
    'supports-school-choice',
    'supports-second-amendment-rights',
    'supports-restrictive-abortion-policy',
    'supports-law-and-order',
    'supports-federal-spending-restraint',
    'supports-business-tax-relief',
    'supports-parental-rights',
    'supports-merit-based-immigration',
    'supports-us-industrial-reshoring',
    'supports-anti-woke-policy',
    'supports-judicial-originalism',
    'supports-strong-military',
    'supports-police-funding',
    'supports-fossil-fuel-permitting',
    'supports-regulatory-rollback',
    'supports-capital-gains-tax-relief',
    'supports-right-to-work',
    'supports-voter-id-laws',
    'supports-local-control-education',
    'supports-anti-crt-policy',
    'supports-free-market-healthcare',
    'supports-tough-on-china',
    'supports-tariff-leverage',
    'supports-balance-budget-priorities',
  ],
}

const POSITION_KEYWORD_RULES = [
  { pattern: /\b(kamala harris|harris)\b/, tags: ['abortion-rights-maximalist', 'gun-safety-priority', 'voting-rights-litigation', 'climate-regulation', 'criminal-justice-reform'] },
  { pattern: /\b(gavin newsom|newsom)\b/, tags: ['state-progressive-governance', 'gun-safety-priority', 'climate-transition-policy', 'abortion-rights-maximalist', 'pro-lgbtq-rights'] },
  { pattern: /\b(gretchen whitmer|whitmer)\b/, tags: ['midwest-pragmatist', 'infrastructure-delivery-focus', 'abortion-rights-maximalist', 'union-partnership', 'manufacturing-revival'] },
  { pattern: /\b(josh shapiro|shapiro)\b/, tags: ['centrist-executive', 'institutional-trust', 'public-safety-reformer', 'fiscal-pragmatism', 'infrastructure-delivery-focus'] },
  { pattern: /\b(wes moore|moore)\b/, tags: ['next-generation-democrat', 'anti-poverty-programs', 'workforce-training', 'public-safety-reformer', 'veterans-advocacy'] },
  { pattern: /\b(pete buttigieg|buttigieg)\b/, tags: ['technocratic-reform', 'infrastructure-delivery-focus', 'climate-transition-policy', 'alliance-forward-foreign-policy', 'housing-supply-focus'] },
  { pattern: /\b(cory booker|booker)\b/, tags: ['criminal-justice-reform', 'housing-reform', 'gun-safety-priority', 'urban-investment', 'faith-and-progressive-bridge'] },
  { pattern: /\b(amy klobuchar|klobuchar)\b/, tags: ['midwest-pragmatist', 'antitrust-enforcement', 'farm-state-sensitivity', 'bipartisan-dealmaker', 'incremental-healthcare-reform'] },
  { pattern: /\b(elizabeth warren|warren)\b/, tags: ['wealth-tax', 'anti-monopoly', 'consumer-protection-maximalist', 'student-debt-relief', 'anti-corruption-reforms'] },
  { pattern: /\b(bernie sanders|sanders)\b/, tags: ['medicare-for-all', 'wealth-tax', 'pro-labor-maximalist', 'green-new-deal', 'anti-corporate-influence'] },
  { pattern: /\b(alexandria ocasio-cortez|ocasio-cortez|aoc)\b/, tags: ['green-new-deal', 'wealth-tax', 'student-debt-relief', 'housing-as-human-right', 'ceasefire-diplomacy-priority'] },
  { pattern: /\b(jb pritzker|pritzker)\b/, tags: ['state-progressive-governance', 'abortion-rights-maximalist', 'labor-alliance', 'budget-management', 'gun-safety-priority'] },
  { pattern: /\b(raphael warnock|warnock)\b/, tags: ['voting-rights-litigation', 'medicaid-expansion', 'faith-based-progressive', 'anti-poverty-programs', 'public-safety-reformer'] },
  { pattern: /\b(andrew cuomo|cuomo)\b/, tags: ['executive-experience', 'infrastructure-delivery-focus', 'centrist-executive', 'law-and-order-moderate', 'establishment-network'] },
  { pattern: /\b(joe biden|biden)\b/, tags: ['alliance-forward-foreign-policy', 'industrial-policy', 'public-option-path', 'infrastructure-delivery-focus', 'incremental-progressivism'] },
  { pattern: /\b(john fetterman|fetterman)\b/, tags: ['pro-labor-maximalist', 'criminal-justice-reform', 'rust-belt-populist-left', 'marijuana-legalization', 'social-welfare-expansion'] },
  { pattern: /\b(donald trump|trump)\b/, tags: ['america-first-trade', 'border-enforcement-maximalist', 'tariff-forward', 'restrict-abortion-policy', 'executive-power-expansion'] },
  { pattern: /\b(ron desantis|desantis)\b/, tags: ['culture-war-maximalist', 'restrict-abortion-policy', 'border-enforcement-maximalist', 'anti-dei-governance', 'state-preemption-strategy'] },
  { pattern: /\b(nikki haley|haley)\b/, tags: ['hawkish-foreign-policy', 'pro-business-tax-cuts', 'border-enforcement', 'alliance-strengthening-right', 'executive-pragmatist-right'] },
  { pattern: /\b(jd vance|vance)\b/, tags: ['economic-nationalism', 'border-enforcement-maximalist', 'post-liberal-conservatism', 'industrial-reshoring', 'family-policy-conservatism'] },
  { pattern: /\b(marco rubio|rubio)\b/, tags: ['hawkish-foreign-policy', 'pro-family-tax-credit-right', 'china-hawk', 'values-conservatism', 'small-business-tax-cuts'] },
  { pattern: /\b(glenn youngkin|youngkin)\b/, tags: ['suburban-conservative-style', 'education-parental-rights', 'pro-business-tax-cuts', 'executive-pragmatist-right', 'culture-war-lite'] },
  { pattern: /\b(vivek ramaswamy|ramaswamy|vivek)\b/, tags: ['anti-regulation-maximalist', 'anti-dei-governance', 'agency-reduction', 'innovation-libertarian-right', 'outsider-executive-style'] },
  { pattern: /\b(chris christie|christie)\b/, tags: ['law-and-order-moderate-right', 'fiscal-conservative', 'institutional-republican', 'anti-trump-lane', 'executive-pragmatist-right'] },
  { pattern: /\b(tim scott|scott)\b/, tags: ['opportunity-zones', 'pro-family-tax-credit-right', 'faith-conservative', 'school-choice', 'soft-tone-conservatism'] },
  { pattern: /\b(tom cotton|cotton)\b/, tags: ['china-hawk', 'law-and-order-maximalist', 'military-expansion', 'immigration-restrictionist', 'national-security-right'] },
  { pattern: /\b(josh hawley|hawley)\b/, tags: ['post-liberal-conservatism', 'anti-big-tech-right', 'pro-labor-right-populism', 'culture-war-maximalist', 'industrial-reshoring'] },
  { pattern: /\b(kristi noem|noem)\b/, tags: ['small-government-rural-right', 'culture-war-maximalist', 'fossil-fuel-defense', 'anti-federal-mandates', 'agriculture-right'] },
  { pattern: /\b(tulsi gabbard|gabbard)\b/, tags: ['anti-intervention', 'civil-libertarian', 'anti-establishment', 'speech-maximalist', 'heterodox-populism'] },
  { pattern: /\b(ben carson|carson)\b/, tags: ['faith-conservative', 'healthcare-market-reform', 'urban-opportunity-zones', 'school-choice', 'soft-tone-conservatism'] },
]

async function fetchJsonWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`Request failed (${res.status})`)
    return await res.json()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Request timed out. Please check your internet connection and try again.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function loadSessionVotes() {
  try {
    const raw = window.localStorage.getItem(SESSION_VOTES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveSessionVotes(votes) {
  try {
    window.localStorage.setItem(SESSION_VOTES_STORAGE_KEY, JSON.stringify(votes))
  } catch {
    // Ignore storage failures (private mode/full quota).
  }
}

function loadSessionSkips() {
  try {
    const raw = window.localStorage.getItem(SESSION_SKIPS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveSessionSkips(skips) {
  try {
    window.localStorage.setItem(SESSION_SKIPS_STORAGE_KEY, JSON.stringify(skips))
  } catch {
    // Ignore storage failures (private mode/full quota).
  }
}

function loadRecommendationEngagement() {
  try {
    const raw = window.localStorage.getItem(RECOMMENDATION_ENGAGEMENT_KEY)
    if (!raw) return { exposures: {}, votes: {}, skips: {} }
    const parsed = JSON.parse(raw)
    return {
      exposures: parsed?.exposures || {},
      votes: parsed?.votes || {},
      skips: parsed?.skips || {},
    }
  } catch {
    return { exposures: {}, votes: {}, skips: {} }
  }
}

function saveRecommendationEngagement(engagement) {
  try {
    window.localStorage.setItem(RECOMMENDATION_ENGAGEMENT_KEY, JSON.stringify(engagement))
  } catch {
    // Ignore storage failures.
  }
}

function getMatchupSignature(dems, reps, randomness) {
  return JSON.stringify({
    randomness: Number(randomness.toFixed(3)),
    dems: dems.map(candidate => ({ id: candidate.id, prob: Number(candidate.prob.toFixed(6)) })),
    reps: reps.map(candidate => ({ id: candidate.id, prob: Number(candidate.prob.toFixed(6)) })),
  })
}

function loadStoredMatchupOrder(signature) {
  try {
    const raw = window.localStorage.getItem(MATCHUP_ORDER_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.signature !== signature) return null
    return Array.isArray(parsed?.order) ? parsed.order : null
  } catch {
    return null
  }
}

function saveStoredMatchupOrder(signature, matchups) {
  try {
    const order = matchups.map(matchup => `${matchup.dem.id}-${matchup.rep.id}`)
    window.localStorage.setItem(MATCHUP_ORDER_STORAGE_KEY, JSON.stringify({ signature, order }))
  } catch {
    // Ignore storage failures.
  }
}

async function fetchCandidates(slug, partyLabel) {
  const events = await fetchJsonWithTimeout(`/api/polymarket/events?slug=${slug}`)

  const eventList = Array.isArray(events) ? events : [events]
  const event = eventList.find(e => e?.slug === slug) || eventList[0]
  if (!event) throw new Error(`No event found for slug: ${slug}`)

  const markets = event.markets || []

  const rawCandidates = markets
    .map(market => {
      let outcomes, prices
      try {
        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes)
          : (market.outcomes || [])
        prices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices)
          : (market.outcomePrices || [])
      } catch {
        return null
      }

      const question = market.question?.trim() || ''
      const nominationPattern = new RegExp(
        `^Will\\s+(.+?)\\s+win\\s+the\\s+2028\\s+${partyLabel}\\s+presidential\\s+nomination\\??$`,
        'i'
      )
      const nameMatch = question.match(nominationPattern)
      if (!nameMatch) return null

      // Binary market: find "Yes" outcome probability
      const yesIdx = outcomes.findIndex(o => o?.toLowerCase() === 'yes')
      if (yesIdx === -1) return null

      let prob = parseFloat(prices[yesIdx])
      if (prob > 1) prob /= 100
      if (isNaN(prob) || prob < 0.005) return null
      if (prob > 1) return null

      const name = nameMatch[1].trim()
      const active = market.active !== false
      const acceptingOrders = market.acceptingOrders !== false
      const closed = market.closed === true
      const archived = market.archived === true
      const liquidity = Number.parseFloat(market.liquidityNum ?? market.liquidity ?? 0) || 0
      const volume = Number.parseFloat(market.volumeNum ?? market.volume ?? 0) || 0

      return {
        id: market.id,
        name,
        prob,
        active,
        acceptingOrders,
        closed,
        archived,
        liquidity,
        volume,
      }
    })
    .filter(Boolean)

  // Some events can include duplicate nominee markets per candidate
  // (historical/archived + active). Prefer active, order-accepting, liquid markets.
  const byName = new Map()
  for (const candidate of rawCandidates) {
    const current = byName.get(candidate.name)
    if (!current) {
      byName.set(candidate.name, candidate)
      continue
    }

    const rank = (c) => [
      c.active && !c.closed && !c.archived ? 1 : 0,
      c.acceptingOrders ? 1 : 0,
      c.liquidity,
      c.volume,
    ]
    const [a1, a2, a3, a4] = rank(candidate)
    const [b1, b2, b3, b4] = rank(current)
    const candidateWins = (
      a1 > b1 ||
      (a1 === b1 && a2 > b2) ||
      (a1 === b1 && a2 === b2 && a3 > b3) ||
      (a1 === b1 && a2 === b2 && a3 === b3 && a4 > b4)
    )
    if (candidateWins) byName.set(candidate.name, candidate)
  }

  return [...byName.values()]
    .sort((a, b) => b.prob - a.prob)
    .map(({ id, name, prob }) => ({ id, name, prob }))
}

async function fetchWikiPhoto(name) {
  const fetchImageFromParams = async (params) => {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`)
    if (!res.ok) return null
    const data = await res.json()
    const pages = Object.values(data?.query?.pages || {})
    const page = pages.find(p => !p?.missing && !p?.pageprops?.disambiguation && p?.thumbnail?.source)
    return page?.thumbnail?.source ?? null
  }

  try {
    const exactMatchParams = new URLSearchParams({
      action: 'query',
      titles: name,
      redirects: '1',
      prop: 'pageimages|pageprops',
      pithumbsize: '500',
      format: 'json',
      origin: '*',
    })
    const exactImage = await fetchImageFromParams(exactMatchParams)
    if (exactImage) return exactImage

    const searchParams = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `${name} politician`,
      gsrlimit: '5',
      gsrenablerewrites: '1',
      prop: 'pageimages|pageprops',
      pithumbsize: '500',
      format: 'json',
      origin: '*',
    })
    return await fetchImageFromParams(searchParams)
  } catch {
    return null
  }
}

function weightedShuffle(matchups) {
  return matchups
    .map((matchup) => {
      const weight = Math.max(matchup.prob, Number.EPSILON)
      const priority = -Math.log(Math.random()) / weight
      return { matchup, priority }
    })
    .sort((a, b) => a.priority - b.priority)
    .map(({ matchup }) => matchup)
}

function buildMatchups(dems, reps, randomness = 0) {
  const clampedRandomness = Math.min(1, Math.max(0, randomness))
  const list = []
  for (const dem of dems) {
    for (const rep of reps) {
      const baseProb = dem.prob * rep.prob
      const adjustedProb = Math.pow(baseProb, 1 - clampedRandomness)
      list.push({ dem, rep, prob: baseProb, sortProb: adjustedProb })
    }
  }
  return weightedShuffle(list.map(matchup => ({ ...matchup, prob: matchup.sortProb })))
    .map(({ dem, rep }) => {
      const baseProb = dem.prob * rep.prob
      return { dem, rep, prob: baseProb }
    })
}

function buildStableMatchups(dems, reps, randomness = 0) {
  const generated = buildMatchups(dems, reps, randomness)
  const signature = getMatchupSignature(dems, reps, randomness)
  const storedOrder = loadStoredMatchupOrder(signature)

  if (!storedOrder) {
    saveStoredMatchupOrder(signature, generated)
    return generated
  }

  const byKey = new Map(generated.map(matchup => [`${matchup.dem.id}-${matchup.rep.id}`, matchup]))
  const ordered = storedOrder
    .map(key => byKey.get(key))
    .filter(Boolean)
  const missing = generated.filter(matchup => !storedOrder.includes(`${matchup.dem.id}-${matchup.rep.id}`))
  const merged = [...ordered, ...missing]

  saveStoredMatchupOrder(signature, merged)
  return merged
}

function classifyVote(vote) {
  const pickedProb = vote?.side === 'dem' ? Number(vote?.demProb) || 0 : Number(vote?.repProb) || 0
  const otherProb = vote?.side === 'dem' ? Number(vote?.repProb) || 0 : Number(vote?.demProb) || 0
  return pickedProb < otherProb ? 'underdog' : 'favorite'
}

function getVoteProfile(votes) {
  if (!votes.length) {
    return {
      preferredSide: 'dem',
      preferredTrait: 'underdog',
      topTags: ['mixed-ideology', 'cross-pressured-voter'],
    }
  }
  const counts = votes.reduce((acc, vote) => {
    acc.side[vote.side] = (acc.side[vote.side] || 0) + 1
    const trait = classifyVote(vote)
    acc.trait[trait] = (acc.trait[trait] || 0) + 1
    const tags = vote?.pickedTags || []
    tags.forEach((tag) => {
      acc.tags[tag] = (acc.tags[tag] || 0) + 1
    })
    return acc
  }, { side: { dem: 0, rep: 0 }, trait: { underdog: 0, favorite: 0 }, tags: {} })

  const preferredSide = counts.side.dem >= counts.side.rep ? 'dem' : 'rep'
  const preferredTrait = counts.trait.underdog >= counts.trait.favorite ? 'underdog' : 'favorite'
  const topTags = Object.entries(counts.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag)
  return {
    preferredSide,
    preferredTrait,
    topTags: topTags.length ? topTags : ['mixed-ideology'],
  }
}

function updatePredictionModel(model, { predictedSide, actualSide, pickedTags = [], missedTags = [], trait }) {
  const learningRate = predictedSide === actualSide ? 0.08 : 0.3
  const sideDelta = predictedSide === actualSide ? 0.12 : 0.45
  const traitDelta = predictedSide === actualSide ? 0.1 : 0.35
  const tagDelta = predictedSide === actualSide ? 0.06 : 0.16

  const nextSideBias = {
    dem: (model?.sideBias?.dem || 0) * (1 - learningRate),
    rep: (model?.sideBias?.rep || 0) * (1 - learningRate),
  }
  nextSideBias[actualSide] += sideDelta
  const oppositeSide = actualSide === 'dem' ? 'rep' : 'dem'
  nextSideBias[oppositeSide] -= sideDelta * 0.75

  const nextTraitBias = {
    underdog: (model?.traitBias?.underdog || 0) * (1 - learningRate),
    favorite: (model?.traitBias?.favorite || 0) * (1 - learningRate),
  }
  if (trait) {
    const oppositeTrait = trait === 'underdog' ? 'favorite' : 'underdog'
    nextTraitBias[trait] += traitDelta
    nextTraitBias[oppositeTrait] -= traitDelta * 0.55
  }

  const nextTagBias = { ...(model?.tagBias || {}) }
  pickedTags.forEach((tag) => {
    nextTagBias[tag] = (nextTagBias[tag] || 0) + tagDelta
  })
  missedTags.forEach((tag) => {
    nextTagBias[tag] = (nextTagBias[tag] || 0) - (tagDelta * 0.65)
  })

  return {
    sideBias: nextSideBias,
    traitBias: nextTraitBias,
    tagBias: nextTagBias,
  }
}

function getCandidateTags(candidate, side, allCandidates = []) {
  const normalized = candidate.name.toLowerCase()
  const nameParts = normalized.split(/\s+/).filter(Boolean)
  const firstName = nameParts[0] || 'candidate'
  const lastName = nameParts[nameParts.length - 1] || 'candidate'
  const initials = nameParts.map(part => part[0]).join('') || 'c'
  const rank = Math.max(1, allCandidates.findIndex(c => c.id === candidate.id) + 1)
  const topBand = Math.max(2, Math.ceil(allCandidates.length * 0.2))
  const upperMidBand = Math.max(3, Math.ceil(allCandidates.length * 0.4))
  const longshotBand = Math.max(2, Math.ceil(allCandidates.length * 0.65))
  const bottomBand = Math.max(2, Math.ceil(allCandidates.length * 0.85))
  const probabilityPct = (candidate.prob || 0) * 100
  const tags = new Set([
    ...BASE_POSITION_TAGS[side],
    side === 'dem' ? 'primary-lane-democratic' : 'primary-lane-republican',
    `candidate-first-name-${firstName}`,
    `candidate-last-name-${lastName}`,
    `candidate-initials-${initials}`,
    `candidate-name-length-${Math.min(normalized.replace(/\s+/g, '').length, 20)}`,
    `candidate-rank-${Math.min(rank, 25)}`,
    `candidate-prob-bucket-${Math.floor(probabilityPct / 5) * 5}-${Math.floor(probabilityPct / 5) * 5 + 4}`,
    rank <= topBand ? 'frontrunner' : 'outsider',
    rank <= topBand ? 'tier-alpha-frontrunner' : rank <= upperMidBand ? 'tier-beta-contender' : rank <= longshotBand ? 'tier-gamma-viable' : 'tier-delta-longshot',
    rank >= bottomBand ? 'deep-longshot' : 'non-deep-longshot',
    candidate.prob >= 0.35 ? 'very-high-odds' : candidate.prob >= 0.2 ? 'high-odds' : candidate.prob >= 0.1 ? 'mid-odds' : candidate.prob >= 0.05 ? 'lower-mid-odds' : 'low-odds',
    rank >= longshotBand ? 'longshot' : 'viable',
    probabilityPct >= 30 ? 'electability-top-stratum' : probabilityPct >= 20 ? 'electability-upper-stratum' : probabilityPct >= 10 ? 'electability-middle-stratum' : probabilityPct >= 5 ? 'electability-lower-stratum' : 'electability-tail-stratum',
    side === 'dem' ? 'ideology-spectrum-left-of-center' : 'ideology-spectrum-right-of-center',
    side === 'dem' ? 'coalition-urban-suburban' : 'coalition-suburban-rural',
    side === 'dem' ? `dem-tier-rank-${Math.min(rank, 12)}` : `rep-tier-rank-${Math.min(rank, 12)}`,
    `matchup-pool-size-${Math.min(allCandidates.length || 1, 30)}`,
  ])

  POSITION_KEYWORD_RULES.forEach((rule) => {
    if (rule.pattern.test(normalized)) {
      rule.tags.forEach(tag => tags.add(tag))
    }
  })

  const movementKeywordRules = [
    { pattern: /\b(progressive|aoc|sanders|fetterman|warren)\b/, tags: ['movement-progressive', 'economic-populist-left', 'grassroots-donor-model'] },
    { pattern: /\b(centrist|shapiro|klobuchar|buttigieg|biden)\b/, tags: ['movement-incrementalist', 'institutionalist-style', 'cross-partisan-appeal'] },
    { pattern: /\b(trump|desantis|vance|hawley|ramaswamy)\b/, tags: ['movement-right-populist', 'anti-establishment-right', 'media-combat-style'] },
    { pattern: /\b(haley|rubio|youngkin|christie)\b/, tags: ['movement-establishment-right', 'donor-network-compatible', 'governing-pragmatist-right'] },
  ]
  movementKeywordRules.forEach(({ pattern, tags: mappedTags }) => {
    if (pattern.test(normalized)) mappedTags.forEach(tag => tags.add(tag))
  })

  const officeTrackRules = [
    { pattern: /\b(governor|newsom|whitmer|desantis|haley|abbott|youngkin|pritzker|noem)\b/, tag: 'office-track-governor' },
    { pattern: /\b(senator|rubio|vance|warren|booker|klobuchar|warnock|fetterman|cotton|hawley|scott)\b/, tag: 'office-track-senator' },
    { pattern: /\b(mayor|buttigieg)\b/, tag: 'office-track-mayor' },
    { pattern: /\b(secretary|buttigieg|haley)\b/, tag: 'office-track-cabinet-or-diplomatic' },
    { pattern: /\b(trump|biden|harris)\b/, tag: 'office-track-white-house-experience' },
    { pattern: /\b(veteran|gabbard|moore)\b/, tag: 'office-track-veteran' },
  ]
  officeTrackRules.forEach(({ pattern, tag }) => {
    if (pattern.test(normalized)) tags.add(tag)
  })

  const issueDomainTags = side === 'dem'
    ? [
        'issue-abortion-rights', 'issue-climate-transition', 'issue-healthcare-access', 'issue-worker-power', 'issue-voting-access',
        'issue-gun-violence-prevention', 'issue-student-debt', 'issue-housing-affordability', 'issue-antitrust', 'issue-public-transit',
      ]
    : [
        'issue-tax-relief', 'issue-border-security', 'issue-energy-dominance', 'issue-regulation-reduction', 'issue-parental-rights',
        'issue-second-amendment', 'issue-federalism', 'issue-school-choice', 'issue-pro-life-policy', 'issue-law-order',
      ]
  issueDomainTags.forEach(tag => tags.add(tag))

  const temperamentTags = [
    rank <= topBand ? 'temperament-front-runner-pressure-tested' : 'temperament-challenger-hungry',
    side === 'dem' ? 'temperament-coalitional-left' : 'temperament-coalitional-right',
    candidate.prob >= 0.2 ? 'temperament-electability-message' : 'temperament-base-activation-message',
  ]
  temperamentTags.forEach(tag => tags.add(tag))

  if (!POSITION_KEYWORD_RULES.some(rule => rule.pattern.test(normalized))) {
    tags.add(side === 'dem' ? 'generic-dem-policy-profile' : 'generic-rep-policy-profile')
    tags.add('policy-profile-inferred-from-party')
    tags.add(rank <= topBand ? 'name-agnostic-frontrunner-profile' : 'name-agnostic-challenger-profile')
  }

  return [...tags]
}

function fallbackAvatarUrl(name) {
  const params = new URLSearchParams({
    seed: name,
    backgroundType: 'gradientLinear',
    size: '256',
  })
  return `https://api.dicebear.com/9.x/initials/svg?${params.toString()}`
}

function getWikiUrl(name) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, '_'))}`
}

function hasSessionVoteForKey(votes, key) {
  return votes.some(vote => vote?.key === key)
}

function findNextUnvotedIndex(matchups, votedKeys, startIndex = 0, direction = 1) {
  if (!matchups.length) return -1
  const step = direction >= 0 ? 1 : -1
  const normalizedStart = ((startIndex % matchups.length) + matchups.length) % matchups.length

  for (let offset = 0; offset < matchups.length; offset += 1) {
    const idx = (normalizedStart + (offset * step) + matchups.length) % matchups.length
    const matchup = matchups[idx]
    if (!matchup) continue
    const key = `${matchup.dem.id}-${matchup.rep.id}`
    if (!votedKeys.has(key)) return idx
  }

  return -1
}

function CandidatePanel({
  candidate,
  photo,
  party,
  animKey,
  onVote,
  canVote,
  flashTick,
  predictionChance = 0,
  isMobile = false,
  pollSharePct = null,
  totalVotes = 0,
}) {
  const isDem = party === 'dem'
  const imageUrl = photo || fallbackAvatarUrl(candidate.name)
  const clickTimerRef = useRef(null)
  const longPressTimerRef = useRef(null)
  const longPressTriggeredRef = useRef(false)
  const suppressClickUntilRef = useRef(0)
  const touchStartPosRef = useRef({ x: null, y: null })
  const touchMovedRef = useRef(false)
  const hasPrediction = predictionChance > 0

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current)
      }
      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  const handleClick = useCallback(() => {
    if (!canVote) return
    if (Date.now() < suppressClickUntilRef.current) return
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
    }
    clickTimerRef.current = window.setTimeout(() => {
      onVote('normal')
      clickTimerRef.current = null
    }, PANEL_DOUBLE_CLICK_MS)
  }, [canVote, onVote])

  const handleDoubleClick = useCallback(() => {
    if (!canVote) return
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    onVote('strong')
  }, [canVote, onVote])

  const handleTouchStart = useCallback((event) => {
    if (!canVote) return
    const touch = event.changedTouches[0]
    longPressTriggeredRef.current = false
    touchMovedRef.current = false
    touchStartPosRef.current = { x: touch?.clientX ?? null, y: touch?.clientY ?? null }
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
    }
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true
      suppressClickUntilRef.current = Date.now() + 600
      onVote('strong')
    }, PANEL_LONG_PRESS_MS)
  }, [canVote, onVote])

  const handleTouchMove = useCallback((event) => {
    const touch = event.changedTouches[0]
    const { x, y } = touchStartPosRef.current
    if (!touch || x === null || y === null) return
    const deltaX = Math.abs(touch.clientX - x)
    const deltaY = Math.abs(touch.clientY - y)
    if (deltaX > PANEL_TAP_MOVE_THRESHOLD_PX || deltaY > PANEL_TAP_MOVE_THRESHOLD_PX) {
      touchMovedRef.current = true
      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (!canVote) return
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    const blocked = longPressTriggeredRef.current || touchMovedRef.current
    touchStartPosRef.current = { x: null, y: null }
    touchMovedRef.current = false
    if (blocked) return
    suppressClickUntilRef.current = Date.now() + 600
    onVote('normal')
  }, [canVote, onVote])

  const handleTouchCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressTriggeredRef.current = false
    touchMovedRef.current = false
    touchStartPosRef.current = { x: null, y: null }
  }, [])

  return (
    <div className="candidate-shell">
      <button
        className={`candidate-panel ${isDem ? 'panel-dem' : 'panel-rep'} ${flashTick ? 'vote-flash' : ''}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        type="button"
        disabled={!canVote}
        aria-label={`Vote for ${candidate.name} (${isDem ? 'Democrat' : 'Republican'})`}
        style={{ '--prediction-strength': predictionChance }}
      >
        <div className="party-tag">{isDem ? 'Democrat' : 'Republican'}</div>
        <div className="vote-sparkle" aria-hidden="true" />
        {hasPrediction && (
          <div className="prediction-waves" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
        <div
          className={`photo-wrapper ${hasPrediction ? 'prediction-photo-ring' : ''}`}
          key={animKey}
        >
          <img
            src={imageUrl}
            alt={candidate.name}
            className={`candidate-photo ${hasPrediction ? 'prediction-photo-pulse' : ''}`}
            style={{ '--prediction-strength': predictionChance }}
          />
        </div>
        <div className="candidate-info" key={`info-${animKey}`}>
          <h2 className="candidate-name">
            {candidate.name}
            <a
              href={getWikiUrl(candidate.name)}
              target="_blank"
              rel="noopener noreferrer"
              className="candidate-wiki-link"
              aria-label={`${candidate.name} Wikipedia page`}
              onClick={(e) => e.stopPropagation()}
            >
              ?
            </a>
          </h2>
          <div className="prob-pill">
            <span className="prob-pct">{(candidate.prob * 100).toFixed(1)}%</span>
            <span className="prob-label">nomination odds</span>
          </div>
          {isMobile && typeof pollSharePct === 'number' && (
            <div className="candidate-poll-chip" role="status" aria-live="polite">
              <span className="candidate-poll-label">local poll</span>
              <span className="candidate-poll-value">{pollSharePct.toFixed(0)}% • {totalVotes} votes</span>
            </div>
          )}
          <div className="vote-hint">Tap/click to vote • Double-click or hold for strong vote</div>
        </div>
      </button>
    </div>
  )
}

function LoadingScreen({ timedOut }) {
  return (
    <div className="centered-screen">
      <div className="spinner" />
      <p className="loading-text">Loading Polymarket data…</p>
      {timedOut && (
        <p className="loading-help">
          This is taking longer than expected. If the page stays blank, refresh and make sure the API server is running.
        </p>
      )}
    </div>
  )
}

function ErrorScreen({ message }) {
  return (
    <div className="centered-screen">
      <div className="error-icon">!</div>
      <h2 className="error-title">Could not load market data</h2>
      <p className="error-msg">{message}</p>
      <p className="error-hint">
        Ensure the Polymarket API is accessible and CORS is enabled, then refresh.
      </p>
    </div>
  )
}

export default function App() {
  const [error, setError] = useState(null)
  const [matchups, setMatchups] = useState(() => buildStableMatchups(FALLBACK_DEMS, FALLBACK_REPS, INITIAL_RANDOMNESS))
  const [photos, setPhotos] = useState({})
  const [idx, setIdx] = useState(0)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboardSort, setLeaderboardSort] = useState('composite')
  const [pollData, setPollData] = useState(null)
  const [pollLoading, setPollLoading] = useState(false)
  const [sessionVotes, setSessionVotes] = useState(() => loadSessionVotes())
  const [sessionSkips, setSessionSkips] = useState(() => loadSessionSkips())
  const [showInsights, setShowInsights] = useState(false)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState(null)
  const [insightsData, setInsightsData] = useState({
    bias_signals: [],
    surprising_votes: [],
    confidence_notes: [],
    summary: '',
  })
  const [recommendationEngagement, setRecommendationEngagement] = useState(() => loadRecommendationEngagement())
  const [recommendedMatchups, setRecommendedMatchups] = useState([])
  const [activeRecommendationType, setActiveRecommendationType] = useState(null)
  const [voteFx, setVoteFx] = useState({ side: null, tick: 0, strength: 'normal' })
  const [demCandidates, setDemCandidates] = useState(FALLBACK_DEMS)
  const [repCandidates, setRepCandidates] = useState(FALLBACK_REPS)
  const [randomness, setRandomness] = useState(INITIAL_RANDOMNESS)
  const [showSettings, setShowSettings] = useState(false)
  const [showProjectHelp, setShowProjectHelp] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const [voteAdvancePending, setVoteAdvancePending] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')
  const [streak, setStreak] = useState(0)
  const [streakFxTick, setStreakFxTick] = useState(0)
  const [badgeMessage, setBadgeMessage] = useState('')
  const [badgeFxTick, setBadgeFxTick] = useState(0)
  const [predictionFx, setPredictionFx] = useState({
    side: null,
    key: null,
    demChance: 0,
    repChance: 0,
  })
  const [predictionModel, setPredictionModel] = useState({
    sideBias: { dem: 0, rep: 0 },
    traitBias: { underdog: 0, favorite: 0 },
    tagBias: {},
  })
  const [modeShiftFx, setModeShiftFx] = useState(false)
  const [bootTimedOut, setBootTimedOut] = useState(false)
  const [startupNotice, setStartupNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches)
  const requestedPhotosRef = useRef(new Set())
  const voteAdvanceTimerRef = useRef(null)
  const lastVotedSideRef = useRef(null)
  const touchStartRef = useRef({ x: null, y: null })

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 700px)')
    const syncIsMobile = (event) => setIsMobile(event.matches)
    setIsMobile(mediaQuery.matches)
    mediaQuery.addEventListener('change', syncIsMobile)
    return () => mediaQuery.removeEventListener('change', syncIsMobile)
  }, [])

  useEffect(() => {
    return () => {
      if (voteAdvanceTimerRef.current) {
        window.clearTimeout(voteAdvanceTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!voteFx.side) return
    const timer = window.setTimeout(() => {
      setVoteFx(prev => ({ ...prev, side: null }))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [voteFx.side, voteFx.tick])

  useEffect(() => {
    saveRecommendationEngagement(recommendationEngagement)
  }, [recommendationEngagement])

  const votedKeys = useMemo(() => new Set(sessionVotes.map(vote => vote.key)), [sessionVotes])
  const allMatchupsCompleted = matchups.length > 0 && votedKeys.size >= matchups.length

  const activeIdx = useMemo(() => {
    if (!matchups.length) return -1
    const normalizedIdx = ((idx % matchups.length) + matchups.length) % matchups.length
    const currentMatchup = matchups[normalizedIdx]
    const currentKey = currentMatchup ? `${currentMatchup.dem.id}-${currentMatchup.rep.id}` : null

    if (allMatchupsCompleted || (currentKey && !votedKeys.has(currentKey))) {
      return normalizedIdx
    }

    return findNextUnvotedIndex(matchups, votedKeys, normalizedIdx, 1)
  }, [allMatchupsCompleted, idx, matchups, votedKeys])

  const vote = useCallback(async (side, strength = 'normal') => {
    if (voteAdvancePending) return
    const currentMatchup = matchups[activeIdx]
    if (!currentMatchup) return
    const key = `${currentMatchup.dem.id}-${currentMatchup.rep.id}`
    if (votedKeys.has(key)) {
      const nextIdx = findNextUnvotedIndex(matchups, votedKeys, activeIdx + 1, 1)
      if (nextIdx !== -1) setIdx(nextIdx)
      setLiveMessage(nextIdx === -1 ? "You've already voted on every matchup." : 'Skipping a matchup you already voted on.')
      return
    }

    const isStrongVote = strength === 'strong'

    setPollLoading(true)
    try {
      setVoteFx({ side, tick: Date.now(), strength })
      setSessionVotes(prev => {
        const pickedCandidate = side === 'dem' ? currentMatchup.dem : currentMatchup.rep
        const pickedTags = getCandidateTags(
          pickedCandidate,
          side,
          side === 'dem' ? demCandidates : repCandidates,
        )
        const nextVotes = [
          ...prev,
          {
            key,
            side,
            demName: currentMatchup.dem.name,
            repName: currentMatchup.rep.name,
            demProb: currentMatchup.dem.prob,
            repProb: currentMatchup.rep.prob,
            pickedTags,
            createdAt: new Date().toISOString(),
          },
        ]
        saveSessionVotes(nextVotes)
        setLiveMessage(`Vote recorded for ${side === 'dem' ? currentMatchup.dem.name : currentMatchup.rep.name}.`)
        let nextStreak = 1
        setStreak(prevStreak => {
          nextStreak = lastVotedSideRef.current === side ? prevStreak + 1 : 1
          return nextStreak
        })
        lastVotedSideRef.current = side
        if (nextStreak >= 3) {
          setStreakFxTick(Date.now())
          setLiveMessage(`${nextStreak} vote streak for ${side === 'dem' ? 'Democrats' : 'Republicans'}.`)
        } else {
          const prefix = isStrongVote ? 'Strong vote recorded' : 'Vote recorded'
          setLiveMessage(`${prefix} for ${side === 'dem' ? currentMatchup.dem.name : currentMatchup.rep.name}.`)
        }
        const unlockedMilestone = BADGE_MILESTONES.find(
          threshold => nextVotes.length >= threshold && prev.length < threshold
        )
        if (unlockedMilestone) {
          const unlockedText = `Badge unlocked: ${unlockedMilestone} votes cast`
          setBadgeMessage(unlockedText)
          setBadgeFxTick(Date.now())
          setLiveMessage(unlockedText)
        }
        return nextVotes
      })
      if (predictionFx?.key === key && predictionFx?.side) {
        const pickedCandidate = side === 'dem' ? currentMatchup.dem : currentMatchup.rep
        const skippedCandidate = side === 'dem' ? currentMatchup.rep : currentMatchup.dem
        const pickedTags = getCandidateTags(
          pickedCandidate,
          side,
          side === 'dem' ? demCandidates : repCandidates,
        )
        const missedTags = getCandidateTags(
          skippedCandidate,
          side === 'dem' ? 'rep' : 'dem',
          side === 'dem' ? repCandidates : demCandidates,
        )
        const pickedTrait = side === 'dem'
          ? currentMatchup.dem.prob < currentMatchup.rep.prob ? 'underdog' : 'favorite'
          : currentMatchup.rep.prob < currentMatchup.dem.prob ? 'underdog' : 'favorite'
        setPredictionModel(prevModel => updatePredictionModel(prevModel, {
          predictedSide: predictionFx.side,
          actualSide: side,
          pickedTags,
          missedTags,
          trait: pickedTrait,
        }))
        if (predictionFx.side !== side) {
          setLiveMessage('Prediction missed — recalibrating to your latest vote pattern.')
        }
      }
      setPredictionFx(prev => (prev.key === key
        ? { side: null, key: null, demChance: 0, repChance: 0 }
        : prev))
      if (activeRecommendationType) {
        setRecommendationEngagement(prev => ({
          ...prev,
          votes: {
            ...prev.votes,
            [activeRecommendationType]: (prev.votes?.[activeRecommendationType] || 0) + 1,
          },
        }))
        setActiveRecommendationType(null)
      }
      setVoteAdvancePending(true)
      if (voteAdvanceTimerRef.current) {
        window.clearTimeout(voteAdvanceTimerRef.current)
      }
      voteAdvanceTimerRef.current = window.setTimeout(() => {
        setIdx(i => {
          const nextIdx = findNextUnvotedIndex(matchups, new Set([...votedKeys, key]), i + 1, 1)
          return nextIdx === -1 ? i : nextIdx
        })
        setVoteAdvancePending(false)
        voteAdvanceTimerRef.current = null
      }, isStrongVote ? STRONG_VOTE_CONFIRMATION_MS : VOTE_CONFIRMATION_MS)
    } finally {
      setPollLoading(false)
    }
  }, [activeIdx, activeRecommendationType, demCandidates, matchups, predictionFx, repCandidates, voteAdvancePending, votedKeys])

  const predictVote = useCallback(() => {
    if (!sessionVotes.length) {
      setLiveMessage('Vote on at least one matchup first so a prediction can be made.')
      return
    }
    const activeMatchup = matchups[activeIdx] ?? matchups[0]
    if (!activeMatchup) return
    const profile = getVoteProfile(sessionVotes)
    const demTags = getCandidateTags(activeMatchup.dem, 'dem', demCandidates)
    const repTags = getCandidateTags(activeMatchup.rep, 'rep', repCandidates)
    const demTagScore = demTags.reduce((acc, tag) => (
      acc + (profile.topTags.includes(tag) ? 1 : 0) + (predictionModel.tagBias?.[tag] || 0)
    ), 0)
    const repTagScore = repTags.reduce((acc, tag) => (
      acc + (profile.topTags.includes(tag) ? 1 : 0) + (predictionModel.tagBias?.[tag] || 0)
    ), 0)
    const favoredByTrait = profile.preferredTrait === 'underdog'
      ? activeMatchup.dem.prob <= activeMatchup.rep.prob
        ? 'dem'
        : 'rep'
      : activeMatchup.dem.prob >= activeMatchup.rep.prob
        ? 'dem'
        : 'rep'
    const favoredTraitScore = profile.preferredTrait === 'underdog'
      ? {
          dem: activeMatchup.dem.prob <= activeMatchup.rep.prob ? 1 : -1,
          rep: activeMatchup.rep.prob <= activeMatchup.dem.prob ? 1 : -1,
        }
      : {
          dem: activeMatchup.dem.prob >= activeMatchup.rep.prob ? 1 : -1,
          rep: activeMatchup.rep.prob >= activeMatchup.dem.prob ? 1 : -1,
        }
    const demScore = demTagScore + (predictionModel.sideBias?.dem || 0) + favoredTraitScore.dem + (predictionModel.traitBias?.[profile.preferredTrait] || 0)
    const repScore = repTagScore + (predictionModel.sideBias?.rep || 0) + favoredTraitScore.rep + (predictionModel.traitBias?.[profile.preferredTrait] || 0)
    const maxScore = Math.max(demScore, repScore)
    const demExp = Math.exp(demScore - maxScore)
    const repExp = Math.exp(repScore - maxScore)
    const totalExp = demExp + repExp || 1
    const demChance = demExp / totalExp
    const repChance = repExp / totalExp
    const preferredSide = demScore === repScore ? favoredByTrait : demScore > repScore ? 'dem' : 'rep'
    setPredictionFx({
      side: preferredSide,
      key: `${activeMatchup.dem.id}-${activeMatchup.rep.id}`,
      demChance,
      repChance,
    })
    setLiveMessage(
      `Predicted pick: ${preferredSide === 'dem' ? activeMatchup.dem.name : activeMatchup.rep.name} (${(Math.max(demChance, repChance) * 100).toFixed(1)}%).`
    )
  }, [activeIdx, demCandidates, matchups, predictionModel, repCandidates, sessionVotes])

  const buildContrastingRecommendations = useCallback(() => {
    if (!matchups.length) return []
    const voteProfile = getVoteProfile(sessionVotes.slice(-30))
    const oppositeSide = voteProfile.preferredSide === 'dem' ? 'rep' : 'dem'
    const oppositeTrait = voteProfile.preferredTrait === 'underdog' ? 'favorite' : 'underdog'
    const votedKeys = new Set(sessionVotes.map(v => v.key))
    const exposure = recommendationEngagement.exposures || {}
    const votes = recommendationEngagement.votes || {}

    const scored = matchups
      .filter(matchup => !votedKeys.has(`${matchup.dem.id}-${matchup.rep.id}`))
      .map(matchup => {
        const oppositeCandidate = oppositeSide === 'dem' ? matchup.dem : matchup.rep
        const otherCandidate = oppositeSide === 'dem' ? matchup.rep : matchup.dem
        const trait = oppositeCandidate.prob < otherCandidate.prob ? 'underdog' : 'favorite'
        const typeKey = `${oppositeSide}_${trait}`
        const typeExposure = exposure[typeKey] || 0
        const typeVotes = votes[typeKey] || 0
        const engagementRate = typeExposure ? typeVotes / typeExposure : 0.5
        const contrastScore = (trait === oppositeTrait ? 2 : 0) + (engagementRate * 0.8)

        return {
          ...matchup,
          recommendationType: typeKey,
          contrastScore: contrastScore + Math.random() * 0.2,
        }
      })
      .sort((a, b) => b.contrastScore - a.contrastScore)

    return scored.slice(0, 3)
  }, [matchups, recommendationEngagement.exposures, recommendationEngagement.votes, sessionVotes])

  const fetchInsights = useCallback(async () => {
    if (!sessionVotes.length) {
      setInsightsData({
        bias_signals: [],
        surprising_votes: [],
        confidence_notes: [],
        summary: '',
      })
      setInsightsError(null)
      return
    }
    setInsightsLoading(true)
    setInsightsError(null)
    try {
      const res = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          votes: sessionVotes,
          skips: sessionSkips,
          format: 'both',
          recommendationFeedback: recommendationEngagement,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Insights API returned ${res.status}`)
      setInsightsData({
        bias_signals: data?.structured?.bias_signals || [],
        surprising_votes: data?.structured?.surprising_votes || [],
        confidence_notes: data?.structured?.confidence_notes || [],
        summary: data?.summary || '',
      })
      setRecommendedMatchups(buildContrastingRecommendations())
    } catch (err) {
      setInsightsError(err.message)
      setInsightsData({
        bias_signals: [],
        surprising_votes: [],
        confidence_notes: [],
        summary: '',
      })
    } finally {
      setInsightsLoading(false)
    }
  }, [buildContrastingRecommendations, recommendationEngagement, sessionSkips, sessionVotes])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBootTimedOut(true)
    }, APP_BOOT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const [demsResponse, repsResponse] = await Promise.all([
          fetchCandidates(DEM_SLUG, 'Democratic'),
          fetchCandidates(REP_SLUG, 'Republican'),
        ])
        const dems = demsResponse.length ? demsResponse : FALLBACK_DEMS
        const reps = repsResponse.length ? repsResponse : FALLBACK_REPS
        setDemCandidates(dems)
        setRepCandidates(reps)
        setMatchups(buildStableMatchups(dems, reps, randomness))
        if (!demsResponse.length || !repsResponse.length) {
          setStartupNotice('Live market data is temporarily unavailable, so you are viewing fallback candidates.')
        } else {
          setStartupNotice('')
        }

        // Prefetch photos for candidates most likely to appear first.
        const topNames = [
          ...dems.slice(0, 25).map(c => c.name),
          ...reps.slice(0, 25).map(c => c.name),
        ]
        topNames.forEach(name => requestedPhotosRef.current.add(name))
        Promise.all(topNames.map(name => fetchWikiPhoto(name).then(url => [name, url])))
          .then((results) => {
            setPhotos(prev => ({
              ...prev,
              ...Object.fromEntries(results.filter(([, url]) => url)),
            }))
          })
      } catch (err) {
        setDemCandidates(FALLBACK_DEMS)
        setRepCandidates(FALLBACK_REPS)
        setMatchups(buildStableMatchups(FALLBACK_DEMS, FALLBACK_REPS, randomness))
        setStartupNotice('Could not reach live market data. Showing fallback candidates so the page still works.')
        setError(null)
      } finally {
        setLoading(false)
        setBootTimedOut(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!demCandidates.length || !repCandidates.length) return
    setMatchups(buildStableMatchups(demCandidates, repCandidates, randomness))
    setIdx(0)
  }, [demCandidates, repCandidates, randomness])

  useEffect(() => {
    const activeMatchup = matchups[activeIdx]
    const namesToLoad = []
    if (
      activeMatchup?.dem?.name &&
      !photos[activeMatchup.dem.name] &&
      !requestedPhotosRef.current.has(activeMatchup.dem.name)
    ) {
      namesToLoad.push(activeMatchup.dem.name)
    }
    if (
      activeMatchup?.rep?.name &&
      !photos[activeMatchup.rep.name] &&
      !requestedPhotosRef.current.has(activeMatchup.rep.name)
    ) {
      namesToLoad.push(activeMatchup.rep.name)
    }
    if (!namesToLoad.length) return

    namesToLoad.forEach(name => requestedPhotosRef.current.add(name))
    Promise.all(namesToLoad.map(name => fetchWikiPhoto(name).then(url => [name, url])))
      .then((results) => {
        const found = Object.fromEntries(results.filter(([, url]) => url))
        if (!Object.keys(found).length) return
        setPhotos(prev => ({ ...prev, ...found }))
      })
  }, [activeIdx, matchups, photos])

  const current = matchups[activeIdx] ?? matchups[0]
  const currentMatchupKey = current ? `${current.dem.id}-${current.rep.id}` : null
  const alreadyVotedCurrent = currentMatchupKey ? votedKeys.has(currentMatchupKey) : false
  const showPredictionForCurrent = predictionFx.key === currentMatchupKey && !alreadyVotedCurrent

  const recordSkip = useCallback((direction) => {
    if (!current || !currentMatchupKey || alreadyVotedCurrent) return
    const predictionForCurrent = predictionFx?.key === currentMatchupKey ? predictionFx.side : null
    const skipType = predictionForCurrent ? 'predicted-skip' : 'manual-skip'

    setSessionSkips(prevSkips => {
      const nextSkips = [
        ...prevSkips,
        {
          key: currentMatchupKey,
          demName: current.dem.name,
          repName: current.rep.name,
          predictedSide: predictionForCurrent,
          reason: direction,
          createdAt: new Date().toISOString(),
        },
      ]
      saveSessionSkips(nextSkips)
      return nextSkips
    })

    setRecommendationEngagement(prevEngagement => ({
      ...prevEngagement,
      skips: {
        ...prevEngagement.skips,
        [skipType]: (prevEngagement.skips?.[skipType] || 0) + 1,
      },
    }))

    if (predictionForCurrent) {
      setLiveMessage(`Skip noted for ${current.dem.name} vs ${current.rep.name}.`)
    }
    setPredictionFx(prevFx => (prevFx.key === currentMatchupKey ? { side: null, key: null } : prevFx))
  }, [alreadyVotedCurrent, current, currentMatchupKey, predictionFx])

  const prev = useCallback(() => {
    recordSkip('prev')
    setIdx(i => {
      const nextIdx = findNextUnvotedIndex(matchups, votedKeys, activeIdx - 1, -1)
      return nextIdx === -1 ? i : nextIdx
    })
  }, [activeIdx, matchups, recordSkip, votedKeys])

  const next = useCallback(() => {
    recordSkip('next')
    setIdx(i => {
      const nextIdx = findNextUnvotedIndex(matchups, votedKeys, activeIdx + 1, 1)
      return nextIdx === -1 ? i : nextIdx
    })
  }, [activeIdx, matchups, recordSkip, votedKeys])

  const queueRecommendedMatchup = useCallback((recommended) => {
    const targetKey = `${recommended.dem.id}-${recommended.rep.id}`
    const targetIdx = matchups.findIndex(m => `${m.dem.id}-${m.rep.id}` === targetKey)
    if (targetIdx === -1) return
    setRecommendationEngagement(prev => ({
      ...prev,
      exposures: {
        ...prev.exposures,
        [recommended.recommendationType]: (prev.exposures?.[recommended.recommendationType] || 0) + 1,
      },
    }))
    setActiveRecommendationType(recommended.recommendationType)
    setIdx(targetIdx)
  }, [matchups])

  const challengeBias = useCallback(() => {
    const refreshed = buildContrastingRecommendations()
    setRecommendedMatchups(refreshed)
    if (refreshed[0]) queueRecommendedMatchup(refreshed[0])
  }, [buildContrastingRecommendations, queueRecommendedMatchup])

  useEffect(() => {
    const handler = (e) => {
      const activeElement = document.activeElement
      const tagName = activeElement?.tagName?.toLowerCase()
      const inputType = activeElement instanceof HTMLInputElement
        ? activeElement.type?.toLowerCase()
        : ''
      const isTextInputType = [
        'text',
        'search',
        'email',
        'url',
        'tel',
        'password',
        'number',
        'date',
        'datetime-local',
        'month',
        'time',
        'week',
      ].includes(inputType)
      const isEditingControl = (
        tagName === 'textarea' ||
        tagName === 'select' ||
        (tagName === 'input' && isTextInputType) ||
        Boolean(activeElement?.isContentEditable)
      )
      if (isEditingControl) return
      if (e.key === 'Escape') {
        setShowHeaderMenu(false)
        setShowSettings(false)
        setShowProjectHelp(false)
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        vote('dem')
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        vote('rep')
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        next()
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        prev()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [vote, next, prev])

  const handleArenaTouchStart = useCallback((event) => {
    const touch = event.changedTouches[0]
    if (!touch) return
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }, [])

  const handleArenaTouchEnd = useCallback((event) => {
    const touch = event.changedTouches[0]
    const { x: startX, y: startY } = touchStartRef.current
    if (!touch || startX === null || startY === null) return
    const deltaX = touch.clientX - startX
    const deltaY = touch.clientY - startY
    touchStartRef.current = { x: null, y: null }
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return
    if (deltaX > 0) vote('rep')
    if (deltaX < 0) vote('dem')
  }, [vote])

  useEffect(() => {
    if (!current) return
    const key = `${current.dem.id}-${current.rep.id}`
    const currentVotes = sessionVotes.filter(vote => vote.key === key)
    const demVotes = currentVotes.filter(vote => vote.side === 'dem').length
    const repVotes = currentVotes.filter(vote => vote.side === 'rep').length
    setPollData({
      demVotes,
      repVotes,
      totalVotes: demVotes + repVotes,
    })
  }, [current, sessionVotes])

  useEffect(() => {
    if (!showInsights) return
    setRecommendedMatchups(buildContrastingRecommendations())
  }, [buildContrastingRecommendations, sessionVotes.length, showInsights])

  useEffect(() => {
    if (!matchups.length || voteAdvancePending) return
    if (activeIdx !== -1 && activeIdx !== idx) {
      setIdx(activeIdx)
    }
  }, [activeIdx, idx, matchups.length, voteAdvancePending])

  if (loading) return <LoadingScreen timedOut={bootTimedOut} />
  if (error) return <ErrorScreen message={error} />
  if (!matchups.length) return <ErrorScreen message="No matchups found in market data." />

  const total = matchups.length
  const demVotePct = pollData?.totalVotes ? (pollData.demVotes / pollData.totalVotes) * 100 : 0
  const repVotePct = pollData?.totalVotes ? (pollData.repVotes / pollData.totalVotes) * 100 : 0
  const sessionVoteTotals = sessionVotes.reduce((acc, vote) => {
    acc[vote.side] += 1
    const trait = classifyVote(vote)
    if (trait === 'underdog') acc.underdog += 1
    if (trait === 'favorite') acc.frontrunner += 1
    return acc
  }, { dem: 0, rep: 0, underdog: 0, frontrunner: 0 })
  const totalSessionVotes = sessionVoteTotals.dem + sessionVoteTotals.rep
  const demSessionPct = totalSessionVotes ? (sessionVoteTotals.dem / totalSessionVotes) * 100 : 50
  const repSessionPct = totalSessionVotes ? (sessionVoteTotals.rep / totalSessionVotes) * 100 : 50
  const underdogPct = totalSessionVotes ? (sessionVoteTotals.underdog / totalSessionVotes) * 100 : 50
  const frontrunnerPct = totalSessionVotes ? (sessionVoteTotals.frontrunner / totalSessionVotes) * 100 : 50
  const leaderboardData = (() => {
    const byCandidate = new Map()
    sessionVotes.forEach((vote) => {
      const winnerName = vote.side === 'dem' ? vote.demName : vote.repName
      const loserName = vote.side === 'dem' ? vote.repName : vote.demName
      const winnerParty = vote.side
      const loserParty = vote.side === 'dem' ? 'rep' : 'dem'
      const winnerId = vote.side === 'dem' ? `dem-${vote.demName}` : `rep-${vote.repName}`
      const loserId = vote.side === 'dem' ? `rep-${vote.repName}` : `dem-${vote.demName}`

      const winner = byCandidate.get(winnerId) || { id: winnerId, name: winnerName, party: winnerParty, votes: 0, wins: 0, appearances: 0 }
      winner.votes += 1
      winner.wins += 1
      winner.appearances += 1
      byCandidate.set(winnerId, winner)

      const loser = byCandidate.get(loserId) || { id: loserId, name: loserName, party: loserParty, votes: 0, wins: 0, appearances: 0 }
      loser.appearances += 1
      byCandidate.set(loserId, loser)
    })

    return [...byCandidate.values()].map((entry) => {
      const winRate = entry.appearances ? entry.wins / entry.appearances : 0
      const voteShare = totalSessionVotes ? entry.votes / totalSessionVotes : 0
      return {
        ...entry,
        winRate,
        compositeScore: (winRate * 0.6) + (voteShare * 0.4),
      }
    })
  })()
  const leaderboardTotalVotes = totalSessionVotes
  const voteProfile = getVoteProfile(sessionVotes)
  const sortedLeaderboard = [...leaderboardData].sort((a, b) => {
    if (leaderboardSort === 'votes') {
      return b.votes - a.votes || b.compositeScore - a.compositeScore || a.name.localeCompare(b.name)
    }
    if (leaderboardSort === 'winRate') {
      return b.winRate - a.winRate || b.compositeScore - a.compositeScore || a.name.localeCompare(b.name)
    }
    return b.compositeScore - a.compositeScore || b.winRate - a.winRate || a.name.localeCompare(b.name)
  })

  return (
    <div className={`app ${modeShiftFx ? 'mode-shift-fx' : ''}`}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      {/* Header */}
      <header className="app-header">
        <span className="header-title">2028 Presidential Matchups</span>
        <div className="header-actions">
          {isMobile ? (
            <div className="header-menu-wrap">
              <button
                type="button"
                className="header-btn menu-btn"
                aria-label="Open header menu"
                aria-expanded={showHeaderMenu}
                aria-controls="header-menu-panel"
                onClick={() => setShowHeaderMenu(s => !s)}
              >
                ☰
              </button>
              {showHeaderMenu && (
                <div className="header-menu-panel" id="header-menu-panel" role="menu" aria-label="Header menu">
                  <div className="settings-wrap">
                    <button
                      type="button"
                      className="header-btn settings-btn"
                      aria-label="Matchup randomness settings"
                      aria-expanded={showSettings}
                      aria-controls="settings-panel"
                      onClick={() => setShowSettings(s => !s)}
                    >
                      ⚙
                    </button>
                    {showSettings && (
                      <div className="settings-popover" id="settings-panel" role="region" aria-label="Matchup randomness settings">
                        <div className="settings-title">Matchup randomness</div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(randomness * 100)}
                          onChange={(e) => setRandomness(Number(e.target.value) / 100)}
                          className="settings-slider"
                        />
                        <div className="settings-scale">
                          <span>More likely</span>
                          <span>More random</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="settings-wrap">
                    <button
                      type="button"
                      className="header-btn settings-btn"
                      aria-label="About this project"
                      aria-expanded={showProjectHelp}
                      aria-controls="about-project-panel"
                      onClick={() => setShowProjectHelp(s => !s)}
                    >
                      ?
                    </button>
                    {showProjectHelp && (
                      <div className="settings-popover help-popover" id="about-project-panel" role="region" aria-label="About this project">
                        <div className="settings-title">About this project</div>
                        <p>
                          This app pairs Democratic and Republican 2028 nominee markets from Polymarket and
                          lets you vote on each matchup.
                        </p>
                        <p>
                          Candidate percentages come from live nomination odds, while the poll percentages
                          show votes stored locally on your device.
                        </p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="header-btn header-menu-action"
                    aria-pressed={showLeaderboard}
                    onClick={() => setShowLeaderboard(s => !s)}
                  >
                    {showLeaderboard ? 'Hide leaderboard' : 'Leaderboard'}
                  </button>
                  <button
                    type="button"
                    className="header-btn header-menu-action"
                    aria-pressed={showInsights}
                    onClick={() => {
                      setShowInsights(open => {
                        const nextOpen = !open
                        if (nextOpen) fetchInsights()
                        return nextOpen
                      })
                    }}
                  >
                    {showInsights ? 'Hide insights' : 'Insights'}
                  </button>
                  <button
                    type="button"
                    className="header-btn header-menu-action"
                    aria-pressed={showStats}
                    onClick={() => setShowStats(s => !s)}
                  >
                    {showStats ? 'Hide stats' : 'Stats'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="settings-wrap">
                <button
                  type="button"
                  className="header-btn settings-btn"
                  aria-label="Matchup randomness settings"
                  aria-expanded={showSettings}
                  aria-controls="settings-panel"
                  onClick={() => setShowSettings(s => !s)}
                >
                  ⚙
                </button>
                {showSettings && (
                  <div className="settings-popover" id="settings-panel" role="region" aria-label="Matchup randomness settings">
                    <div className="settings-title">Matchup randomness</div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(randomness * 100)}
                      onChange={(e) => setRandomness(Number(e.target.value) / 100)}
                      className="settings-slider"
                    />
                    <div className="settings-scale">
                      <span>More likely</span>
                      <span>More random</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="settings-wrap">
                <button
                  type="button"
                  className="header-btn settings-btn"
                  aria-label="About this project"
                  aria-expanded={showProjectHelp}
                  aria-controls="about-project-panel"
                  onClick={() => setShowProjectHelp(s => !s)}
                >
                  ?
                </button>
                {showProjectHelp && (
                  <div className="settings-popover help-popover" id="about-project-panel" role="region" aria-label="About this project">
                    <div className="settings-title">About this project</div>
                    <p>
                      This app pairs Democratic and Republican 2028 nominee markets from Polymarket and
                      lets you vote on each matchup.
                    </p>
                    <p>
                      Candidate percentages come from live nomination odds, while the poll percentages
                      show votes stored locally on your device.
                    </p>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="header-btn"
                aria-pressed={showLeaderboard}
                onClick={() => setShowLeaderboard(s => !s)}
              >
                {showLeaderboard ? 'Hide leaderboard' : 'Leaderboard'}
              </button>
              <button
                type="button"
                className="header-btn"
                aria-pressed={showInsights}
                onClick={() => {
                  setShowInsights(open => {
                    const nextOpen = !open
                    if (nextOpen) fetchInsights()
                    return nextOpen
                  })
                }}
              >
                {showInsights ? 'Hide insights' : 'Insights'}
              </button>
              <button
                type="button"
                className="header-btn"
                aria-pressed={showStats}
                onClick={() => setShowStats(s => !s)}
              >
                {showStats ? 'Hide stats' : 'Stats'}
              </button>
            </>
          )}
        </div>
      </header>
      {startupNotice && (
        <div className="startup-notice" role="status" aria-live="polite">
          {startupNotice}
        </div>
      )}

      {showStats && (
        <section className="stats-drawer" aria-label="Your vote distribution and classes">
          <div className="header-vote-stats">
            <div className="vote-split-row">
              <span className="vote-split-label">Dem vs Rep</span>
              <div className="vote-split-bar" role="img" aria-label={`${demSessionPct.toFixed(0)} percent Democrat and ${repSessionPct.toFixed(0)} percent Republican votes`}>
                <div className="vote-segment vote-segment-dem" style={{ width: `${demSessionPct}%` }} />
                <div className="vote-segment vote-segment-rep" style={{ width: `${repSessionPct}%` }} />
              </div>
            </div>
            <div className="vote-split-row">
              <span className="vote-split-label">Underdog vs Frontrunner</span>
              <div className="vote-split-bar" role="img" aria-label={`${underdogPct.toFixed(0)} percent underdog and ${frontrunnerPct.toFixed(0)} percent frontrunner votes`}>
                <div className="vote-segment vote-segment-underdog" style={{ width: `${underdogPct}%` }} />
                <div className="vote-segment vote-segment-frontrunner" style={{ width: `${frontrunnerPct}%` }} />
              </div>
            </div>
            <div className="stats-tags">
              <span className="stats-tags-label">Your position tags</span>
              <div className="stats-tag-list">
                {(voteProfile.topTags.length ? voteProfile.topTags : ['new-user']).map(tag => (
                  <span key={tag} className="stats-tag-chip">{tag.replace(/-/g, ' ')}</span>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {showInsights && (
        <section className="insights-drawer">
          <div className="insights-title-row">
            <div className="insights-title">AI Political Insights</div>
            <button type="button" className="header-btn challenge-btn" onClick={challengeBias}>
              Challenge my bias
            </button>
          </div>
          {insightsLoading && (
            <div className="insights-status insights-loading" role="status" aria-live="polite">
              <span className="insights-loading-text">Generating your political summary</span>
              <span className="insights-loading-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          {!insightsLoading && insightsError && (
            <div className="insights-status insights-error">{insightsError}</div>
          )}
          {!insightsLoading && !insightsError && (insightsData.summary || insightsData.bias_signals.length > 0) && (
            <div className="insights-grid">
              <div className="insight-block">
                <h3>Why this matchup is interesting</h3>
                <p className="insights-body">
                  {insightsData.summary || insightsData.bias_signals[0] || 'Gathering signal from your recent votes.'}
                </p>
                {insightsData.bias_signals.length > 1 && (
                  <ul className="insights-list">
                    {insightsData.bias_signals.slice(1).map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </div>
              <div className="insight-block">
                <h3>Your voter profile</h3>
                <ul className="insights-list">
                  {(insightsData.surprising_votes.length ? insightsData.surprising_votes : ['No strong pattern yet.']).map(item => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="insight-block">
                <h3>Try these 3 contrasting matchups next</h3>
                <div className="recommendation-list">
                  {recommendedMatchups.map((m) => (
                    <button
                      key={`${m.dem.id}-${m.rep.id}`}
                      className="recommendation-item"
                      type="button"
                      onClick={() => queueRecommendedMatchup(m)}
                    >
                      {m.dem.name} vs {m.rep.name}
                    </button>
                  ))}
                </div>
                {insightsData.confidence_notes.length > 0 && (
                  <p className="insights-footnote">{insightsData.confidence_notes.join(' ')}</p>
                )}
              </div>
            </div>
          )}
          {!insightsLoading && !insightsError && !insightsData.summary && insightsData.bias_signals.length === 0 && (
            <div className="insights-status">Vote on a few matchups first to generate insights.</div>
          )}
        </section>
      )}

      {showLeaderboard && (
        <div className="leaderboard-modal-backdrop" onClick={() => setShowLeaderboard(false)}>
          <section className="leaderboard-modal" role="dialog" aria-modal="true" aria-label="Leaderboard" onClick={(e) => e.stopPropagation()}>
            <div className="leaderboard-modal-top">
              <h2>Leaderboard</h2>
              <button
                type="button"
                className="header-btn leaderboard-close-btn"
                onClick={() => setShowLeaderboard(false)}
              >
                Close
              </button>
            </div>
            <div className="leaderboard-header">
              <span>Rank</span>
              <span>Name</span>
              <span>Party</span>
              <button
                type="button"
                className={`leaderboard-sort-btn ${leaderboardSort === 'composite' ? 'active' : ''}`}
                onClick={() => setLeaderboardSort('composite')}
              >
                Composite
              </button>
              <button
                type="button"
                className={`leaderboard-sort-btn ${leaderboardSort === 'winRate' ? 'active' : ''}`}
                onClick={() => setLeaderboardSort('winRate')}
              >
                Win %
              </button>
              <button
                type="button"
                className={`leaderboard-sort-btn ${leaderboardSort === 'votes' ? 'active' : ''}`}
                onClick={() => setLeaderboardSort('votes')}
              >
                Total votes
              </button>
            </div>
            <div className="leaderboard-body">
              {sortedLeaderboard.length === 0 && (
                <div className="leaderboard-status">No votes yet.</div>
              )}
              {sortedLeaderboard.map((entry, i) => (
                <div className="leaderboard-row" key={`${entry.party}-${entry.id}`}>
                  <span>#{i + 1}</span>
                  <span className="lb-name">{entry.name}</span>
                  <span className={entry.party === 'dem' ? 'lb-party lb-dem' : 'lb-party lb-rep'}>
                    {entry.party === 'dem' ? 'Democrat' : 'Republican'}
                  </span>
                  <span>{(entry.compositeScore * 100).toFixed(1)}</span>
                  <span>{(entry.winRate * 100).toFixed(1)}%</span>
                  <span>{entry.votes}</span>
                </div>
              ))}
            </div>
            <div className="leaderboard-footer">{leaderboardTotalVotes} total local votes cast</div>
          </section>
        </div>
      )}

      {/* Main arena */}
      <main
        className="arena"
        onTouchStart={handleArenaTouchStart}
        onTouchEnd={handleArenaTouchEnd}
        aria-label="Head-to-head voting arena"
      >
        <CandidatePanel
          candidate={current.dem}
          photo={photos[current.dem.name]}
          party="dem"
          animKey={`dem-${activeIdx}`}
          onVote={(strength) => { vote('dem', strength) }}
          canVote={!pollLoading && !voteAdvancePending && !alreadyVotedCurrent}
          flashTick={voteFx.side === 'dem' ? voteFx.tick : 0}
          predictionChance={showPredictionForCurrent ? predictionFx.demChance : 0}
          flashStrength={voteFx.side === 'dem' ? voteFx.strength : 'normal'}
          isMobile={isMobile}
          pollSharePct={demVotePct}
          totalVotes={pollData?.totalVotes || 0}
        />

        <div className="vs-column" role="region" aria-label="Matchup status">
          <div className="vs-text">VS</div>

          <div className="combined-prob">
            <span className="cp-pct">{(current.prob * 100).toFixed(2)}%</span>
            <span className="cp-label">matchup probability</span>
          </div>

          <div className="nav-row">
            <button className="nav-btn" onClick={prev} disabled={total <= 1} aria-label="Previous">
              &#8249;
            </button>
            <span className="nav-count">{activeIdx + 1} / {total}</span>
            <button className="nav-btn" onClick={next} disabled={total <= 1} aria-label="Next">
              &#8250;
            </button>
          </div>

          <div className="poll-card">
            <div className="poll-title">Your local results</div>
            <div className="poll-results poll-results-visible">
              <div className="poll-row">
                <span>{current.dem.name}</span>
                <span>{demVotePct.toFixed(0)}%</span>
              </div>
              <div className="poll-row">
                <span>{current.rep.name}</span>
                <span>{repVotePct.toFixed(0)}%</span>
              </div>
              <div className="poll-meta" role="status" aria-live="polite">
                {pollLoading ? 'Updating your local results…' : `${pollData?.totalVotes || 0} local votes`}
              </div>
            </div>
          </div>

          {!isMobile && (
            <div className="controls-card">
              <div className="controls-title">Who would you vote for?</div>
              <div className="controls-row"><kbd>←</kbd> vote {current.dem.name.split(' ')[0]}</div>
              <div className="controls-row"><kbd>→</kbd> vote {current.rep.name.split(' ')[0]}</div>
              <div className="controls-row"><kbd>Swipe</kbd> left/right to vote</div>
              <div className="controls-row"><kbd>↑</kbd>/<kbd>↓</kbd> prev/next matchup</div>
            </div>
          )}

          {showPredictionForCurrent && (
            <div className="prediction-prob-bar" role="status" aria-live="polite">
              <div className="prediction-prob-track">
                <div className="prediction-prob-segment prediction-prob-dem" style={{ width: `${predictionFx.demChance * 100}%` }} />
                <div className="prediction-prob-segment prediction-prob-rep" style={{ width: `${predictionFx.repChance * 100}%` }} />
              </div>
              <div className="prediction-prob-labels">
                <span>{current.dem.name.split(' ')[0]} {(predictionFx.demChance * 100).toFixed(1)}%</span>
                <span>{current.rep.name.split(' ')[0]} {(predictionFx.repChance * 100).toFixed(1)}%</span>
              </div>
            </div>
          )}
          <button type="button" className="header-btn predict-btn" onClick={predictVote}>
            Predict my vote
          </button>
        </div>

        <CandidatePanel
          candidate={current.rep}
          photo={photos[current.rep.name]}
          party="rep"
          animKey={`rep-${activeIdx}`}
          onVote={(strength) => { vote('rep', strength) }}
          canVote={!pollLoading && !voteAdvancePending && !alreadyVotedCurrent}
          flashTick={voteFx.side === 'rep' ? voteFx.tick : 0}
          predictionChance={showPredictionForCurrent ? predictionFx.repChance : 0}
          flashStrength={voteFx.side === 'rep' ? voteFx.strength : 'normal'}
          isMobile={isMobile}
          pollSharePct={repVotePct}
          totalVotes={pollData?.totalVotes || 0}
        />
      </main>
    </div>
  )
}
