import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

const DEM_SLUG = 'democratic-presidential-nominee-2028'
const REP_SLUG = 'republican-presidential-nominee-2028'
const SESSION_VOTES_STORAGE_KEY = 'sessionVotes'
const RECOMMENDATION_ENGAGEMENT_KEY = 'recommendationEngagement'
const VOTE_CONFIRMATION_MS = 500
const SWIPE_THRESHOLD_PX = 52
const BADGE_MILESTONES = [5, 15, 30]

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

function loadRecommendationEngagement() {
  try {
    const raw = window.localStorage.getItem(RECOMMENDATION_ENGAGEMENT_KEY)
    if (!raw) return { exposures: {}, votes: {} }
    const parsed = JSON.parse(raw)
    return {
      exposures: parsed?.exposures || {},
      votes: parsed?.votes || {},
    }
  } catch {
    return { exposures: {}, votes: {} }
  }
}

function saveRecommendationEngagement(engagement) {
  try {
    window.localStorage.setItem(RECOMMENDATION_ENGAGEMENT_KEY, JSON.stringify(engagement))
  } catch {
    // Ignore storage failures.
  }
}

async function fetchCandidates(slug, partyLabel) {
  const res = await fetch(`/api/polymarket/events?slug=${slug}`)
  if (!res.ok) throw new Error(`Polymarket API returned ${res.status}`)
  const events = await res.json()

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

function classifyVote(vote) {
  const pickedProb = vote?.side === 'dem' ? Number(vote?.demProb) || 0 : Number(vote?.repProb) || 0
  const otherProb = vote?.side === 'dem' ? Number(vote?.repProb) || 0 : Number(vote?.demProb) || 0
  return pickedProb < otherProb ? 'underdog' : 'favorite'
}

function getVoteProfile(votes) {
  if (!votes.length) {
    return { preferredSide: 'dem', preferredTrait: 'underdog' }
  }
  const counts = votes.reduce((acc, vote) => {
    acc.side[vote.side] = (acc.side[vote.side] || 0) + 1
    const trait = classifyVote(vote)
    acc.trait[trait] = (acc.trait[trait] || 0) + 1
    return acc
  }, { side: { dem: 0, rep: 0 }, trait: { underdog: 0, favorite: 0 } })

  const preferredSide = counts.side.dem >= counts.side.rep ? 'dem' : 'rep'
  const preferredTrait = counts.trait.underdog >= counts.trait.favorite ? 'underdog' : 'favorite'
  return { preferredSide, preferredTrait }
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

function CandidatePanel({ candidate, photo, party, animKey, onVote, canVote, flashTick }) {
  const isDem = party === 'dem'
  const imageUrl = photo || fallbackAvatarUrl(candidate.name)
  return (
    <div className="candidate-shell">
      <button
        className={`candidate-panel ${isDem ? 'panel-dem' : 'panel-rep'} ${flashTick ? 'vote-flash' : ''}`}
        onClick={onVote}
        type="button"
        disabled={!canVote}
        aria-label={`Vote for ${candidate.name} (${isDem ? 'Democrat' : 'Republican'})`}
      >
        <div className="party-tag">{isDem ? 'Democrat' : 'Republican'}</div>
        <div className="vote-sparkle" aria-hidden="true" />
        <div className="photo-wrapper" key={animKey}>
          <img src={imageUrl} alt={candidate.name} className="candidate-photo" />
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
          <div className="vote-hint">Click to vote</div>
        </div>
      </button>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="centered-screen">
      <div className="spinner" />
      <p className="loading-text">Loading Polymarket data…</p>
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [matchups, setMatchups] = useState([])
  const [photos, setPhotos] = useState({})
  const [idx, setIdx] = useState(0)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboardSort, setLeaderboardSort] = useState('winRate')
  const [leaderboardData, setLeaderboardData] = useState([])
  const [leaderboardTotalVotes, setLeaderboardTotalVotes] = useState(0)
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState(null)
  const [pollData, setPollData] = useState(null)
  const [pollLoading, setPollLoading] = useState(false)
  const [pollError, setPollError] = useState(null)
  const [sessionVotes, setSessionVotes] = useState(() => loadSessionVotes())
  const [showInsights, setShowInsights] = useState(false)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState(null)
  const [insightsData, setInsightsData] = useState({
    bias_signals: [],
    surprising_votes: [],
    suggested_matchups: [],
    confidence_notes: [],
    summary: '',
  })
  const [recommendationEngagement, setRecommendationEngagement] = useState(() => loadRecommendationEngagement())
  const [recommendedMatchups, setRecommendedMatchups] = useState([])
  const [activeRecommendationType, setActiveRecommendationType] = useState(null)
  const [voteFx, setVoteFx] = useState({ side: null, tick: 0 })
  const [demCandidates, setDemCandidates] = useState([])
  const [repCandidates, setRepCandidates] = useState([])
  const [randomness, setRandomness] = useState(0.2)
  const [showSettings, setShowSettings] = useState(false)
  const [showProjectHelp, setShowProjectHelp] = useState(false)
  const [voteAdvancePending, setVoteAdvancePending] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')
  const [streak, setStreak] = useState(0)
  const [streakFxTick, setStreakFxTick] = useState(0)
  const [badgeMessage, setBadgeMessage] = useState('')
  const [badgeFxTick, setBadgeFxTick] = useState(0)
  const [modeShiftFx, setModeShiftFx] = useState(false)
  const requestedPhotosRef = useRef(new Set())
  const voteAdvanceTimerRef = useRef(null)
  const lastVotedSideRef = useRef(null)
  const touchStartRef = useRef({ x: null, y: null })

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

  const fetchPoll = useCallback(async (matchup) => {
    const key = `${matchup.dem.id}-${matchup.rep.id}`
    setPollLoading(true)
    setPollError(null)
    try {
      const res = await fetch(`/api/poll/${encodeURIComponent(key)}`)
      if (!res.ok) throw new Error(`Poll API returned ${res.status}`)
      const data = await res.json()
      setPollData(data)
    } catch (err) {
      setPollError(err.message)
    } finally {
      setPollLoading(false)
    }
  }, [])

  const vote = useCallback(async (side) => {
    if (voteAdvancePending) return
    const currentMatchup = matchups[idx]
    if (!currentMatchup) return
    const key = `${currentMatchup.dem.id}-${currentMatchup.rep.id}`

    setPollLoading(true)
    setPollError(null)
    try {
      const res = await fetch('/api/poll/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          side,
          dem: { id: currentMatchup.dem.id, name: currentMatchup.dem.name },
          rep: { id: currentMatchup.rep.id, name: currentMatchup.rep.name },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Poll vote failed (${res.status})`)
      setVoteFx({ side, tick: Date.now() })
      setPollData(data)
      setSessionVotes(prev => {
        const nextVotes = [
          ...prev,
          {
            key,
            side,
            demName: currentMatchup.dem.name,
            repName: currentMatchup.rep.name,
            demProb: currentMatchup.dem.prob,
            repProb: currentMatchup.rep.prob,
            createdAt: new Date().toISOString(),
          },
        ]
        saveSessionVotes(nextVotes)
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
          setLiveMessage(`Vote recorded for ${side === 'dem' ? currentMatchup.dem.name : currentMatchup.rep.name}.`)
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
        setIdx(i => Math.min(matchups.length - 1, i + 1))
        setVoteAdvancePending(false)
        voteAdvanceTimerRef.current = null
      }, VOTE_CONFIRMATION_MS)
    } catch (err) {
      setPollError(err.message)
    } finally {
      setPollLoading(false)
    }
  }, [activeRecommendationType, idx, matchups, voteAdvancePending])

  const fetchLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true)
    setLeaderboardError(null)
    try {
      const res = await fetch('/api/poll/leaderboard')
      if (!res.ok) throw new Error(`Leaderboard API returned ${res.status}`)
      const data = await res.json()
      setLeaderboardData(data.leaderboard || [])
      setLeaderboardTotalVotes(data.totalVotes || 0)
    } catch (err) {
      setLeaderboardError(err.message)
    } finally {
      setLeaderboardLoading(false)
    }
  }, [])

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
        suggested_matchups: [],
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
          format: 'both',
          recommendationFeedback: recommendationEngagement,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Insights API returned ${res.status}`)
      setInsightsData({
        bias_signals: data?.structured?.bias_signals || [],
        surprising_votes: data?.structured?.surprising_votes || [],
        suggested_matchups: data?.structured?.suggested_matchups || [],
        confidence_notes: data?.structured?.confidence_notes || [],
        summary: data?.summary || '',
      })
      setRecommendedMatchups(buildContrastingRecommendations())
    } catch (err) {
      setInsightsError(err.message)
      setInsightsData({
        bias_signals: [],
        surprising_votes: [],
        suggested_matchups: [],
        confidence_notes: [],
        summary: '',
      })
    } finally {
      setInsightsLoading(false)
    }
  }, [buildContrastingRecommendations, recommendationEngagement, sessionVotes])

  useEffect(() => {
    ;(async () => {
      try {
        const [dems, reps] = await Promise.all([
          fetchCandidates(DEM_SLUG, 'Democratic'),
          fetchCandidates(REP_SLUG, 'Republican'),
        ])
        setDemCandidates(dems)
        setRepCandidates(reps)
        setMatchups(buildMatchups(dems, reps, randomness))

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
        setError(err.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!demCandidates.length || !repCandidates.length) return
    setMatchups(buildMatchups(demCandidates, repCandidates, randomness))
    setIdx(0)
  }, [demCandidates, repCandidates, randomness])

  useEffect(() => {
    const activeMatchup = matchups[idx]
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
  }, [idx, matchups, photos])

  const prev = useCallback(() => {
    setIdx(i => (i === 0 ? Math.max(0, matchups.length - 1) : i - 1))
  }, [matchups.length])
  const next = useCallback(() => setIdx(i => Math.min(matchups.length - 1, i + 1)), [matchups.length])

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
      const tagName = document.activeElement?.tagName?.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        vote('dem')
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        vote('rep')
      }
      if (e.key === ' ') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [vote, next])

  const current = matchups[idx]

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
    fetchPoll(current)
  }, [current, fetchPoll])

  useEffect(() => {
    if (!showLeaderboard) return
    fetchLeaderboard()
  }, [showLeaderboard, fetchLeaderboard, pollData?.totalVotes])

  useEffect(() => {
    if (!showInsights) return
    setRecommendedMatchups(buildContrastingRecommendations())
  }, [buildContrastingRecommendations, sessionVotes.length, showInsights])

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!matchups.length) return <ErrorScreen message="No matchups found in market data." />

  const total = matchups.length
  const demVotePct = pollData?.totalVotes ? (pollData.demVotes / pollData.totalVotes) * 100 : 0
  const repVotePct = pollData?.totalVotes ? (pollData.repVotes / pollData.totalVotes) * 100 : 0
  const sortedLeaderboard = [...leaderboardData].sort((a, b) => {
    if (leaderboardSort === 'votes') {
      return b.votes - a.votes || b.winRate - a.winRate || a.name.localeCompare(b.name)
    }
    return b.winRate - a.winRate || b.votes - a.votes || a.name.localeCompare(b.name)
  })

  return (
    <div className={`app ${modeShiftFx ? 'mode-shift-fx' : ''}`}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      {/* Header */}
      <header className="app-header">
        <span className="header-title">2028 Presidential Matchups</span>
        <div className="header-actions">
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
                  show votes cast by users inside this app.
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
          <span className="header-sub">Live odds from Polymarket · {total} matchups ranked by probability</span>
        </div>
      </header>

      {showInsights && (
        <section className="insights-drawer">
          <div className="insights-title-row">
            <div className="insights-title">AI Political Insights</div>
            <button type="button" className="header-btn challenge-btn" onClick={challengeBias}>
              Challenge my bias
            </button>
          </div>
          {insightsLoading && <div className="insights-status">Generating your political summary…</div>}
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
                <h3>You often prefer X underdog profile</h3>
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
                {insightsData.suggested_matchups.length > 0 && (
                  <ul className="insights-list ai-suggestions">
                    {insightsData.suggested_matchups.slice(0, 3).map(item => <li key={item}>{item}</li>)}
                  </ul>
                )}
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
              {leaderboardLoading && <div className="leaderboard-status">Loading leaderboard…</div>}
              {!leaderboardLoading && leaderboardError && (
                <div className="leaderboard-status leaderboard-error">{leaderboardError}</div>
              )}
              {!leaderboardLoading && !leaderboardError && sortedLeaderboard.length === 0 && (
                <div className="leaderboard-status">No votes yet.</div>
              )}
              {!leaderboardLoading && !leaderboardError && sortedLeaderboard.map((entry, i) => (
                <div className="leaderboard-row" key={`${entry.party}-${entry.id}`}>
                  <span>#{i + 1}</span>
                  <span className="lb-name">{entry.name}</span>
                  <span className={entry.party === 'dem' ? 'lb-party lb-dem' : 'lb-party lb-rep'}>
                    {entry.party === 'dem' ? 'Democrat' : 'Republican'}
                  </span>
                  <span>{(entry.winRate * 100).toFixed(1)}%</span>
                  <span>{entry.votes}</span>
                </div>
              ))}
            </div>
            <div className="leaderboard-footer">{leaderboardTotalVotes} total votes cast</div>
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
          animKey={`dem-${idx}`}
          onVote={() => { vote('dem') }}
          canVote={!pollLoading && !voteAdvancePending}
          flashTick={voteFx.side === 'dem' ? voteFx.tick : 0}
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
            <span className="nav-count">{idx + 1} / {total}</span>
            <button className="nav-btn" onClick={next} disabled={idx === total - 1} aria-label="Next">
              &#8250;
            </button>
          </div>

          <div className="poll-card">
            <div className="poll-title">Polling results</div>
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
                {pollLoading ? 'Updating poll…' : `${pollData?.totalVotes || 0} total votes`}
              </div>
              {pollError && <div className="poll-error">{pollError}</div>}
            </div>
          </div>

          <div className="controls-card">
            <div className="controls-title">Who would you vote for?</div>
            <div className="controls-row"><kbd>←</kbd> vote {current.dem.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>→</kbd> vote {current.rep.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>Swipe</kbd> left/right to vote</div>
            <div className="controls-row"><kbd>Space</kbd> next matchup</div>
          </div>

          <div className={`streak-badge ${streakFxTick ? 'streak-fx' : ''}`} key={`streak-${streakFxTick}`}>
            Current streak: {streak}
          </div>
          {badgeMessage && (
            <div className={`unlock-badge ${badgeFxTick ? 'unlock-fx' : ''}`} key={`badge-${badgeFxTick}`}>
              {badgeMessage}
            </div>
          )}
        </div>

        <CandidatePanel
          candidate={current.rep}
          photo={photos[current.rep.name]}
          party="rep"
          animKey={`rep-${idx}`}
          onVote={() => { vote('rep') }}
          canVote={!pollLoading && !voteAdvancePending}
          flashTick={voteFx.side === 'rep' ? voteFx.tick : 0}
        />
      </main>
    </div>
  )
}
