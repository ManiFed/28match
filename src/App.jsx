import { useState, useEffect, useCallback } from 'react'
import './App.css'

const DEM_SLUG = 'democratic-presidential-nominee-2028'
const REP_SLUG = 'republican-presidential-nominee-2028'

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
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: name,
      prop: 'pageimages',
      pithumbsize: '500',
      format: 'json',
      origin: '*',
    })
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`)
    const data = await res.json()
    const pages = Object.values(data?.query?.pages || {})
    return pages[0]?.thumbnail?.source ?? null
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

function buildMatchups(dems, reps) {
  const list = []
  for (const dem of dems) {
    for (const rep of reps) {
      list.push({ dem, rep, prob: dem.prob * rep.prob })
    }
  }
  return weightedShuffle(list)
}

function fallbackAvatarUrl(name) {
  const params = new URLSearchParams({
    seed: name,
    backgroundType: 'gradientLinear',
    size: '256',
  })
  return `https://api.dicebear.com/9.x/initials/svg?${params.toString()}`
}

function CandidatePanel({ candidate, photo, party, animKey, onVote, canVote, flashTick }) {
  const isDem = party === 'dem'
  const imageUrl = photo || fallbackAvatarUrl(candidate.name)
  return (
    <button
      className={`candidate-panel ${isDem ? 'panel-dem' : 'panel-rep'} ${flashTick ? 'vote-flash' : ''}`}
      onClick={onVote}
      type="button"
      disabled={!canVote}
    >
      <div className="party-tag">{isDem ? 'Democrat' : 'Republican'}</div>
      <div className="vote-sparkle" aria-hidden="true" />
      <div className="photo-wrapper" key={animKey}>
        <img src={imageUrl} alt={candidate.name} className="candidate-photo" />
      </div>
      <div className="candidate-info" key={`info-${animKey}`}>
        <h2 className="candidate-name">{candidate.name}</h2>
        <div className="prob-pill">
          <span className="prob-pct">{(candidate.prob * 100).toFixed(1)}%</span>
          <span className="prob-label">nomination odds</span>
        </div>
        <div className="vote-hint">Click to vote</div>
      </div>
    </button>
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
  const [showList, setShowList] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboardData, setLeaderboardData] = useState([])
  const [leaderboardTotalVotes, setLeaderboardTotalVotes] = useState(0)
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState(null)
  const [pollData, setPollData] = useState(null)
  const [pollLoading, setPollLoading] = useState(false)
  const [pollError, setPollError] = useState(null)
  const [votedKeys, setVotedKeys] = useState({})
  const [showInsights, setShowInsights] = useState(false)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState(null)
  const [insightsSummary, setInsightsSummary] = useState('')
  const [voteFx, setVoteFx] = useState({ side: null, tick: 0 })

  useEffect(() => {
    if (!voteFx.side) return
    const timer = window.setTimeout(() => {
      setVoteFx(prev => ({ ...prev, side: null }))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [voteFx.side, voteFx.tick])

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
      setVotedKeys(prev => ({ ...prev, [key]: true }))
    } catch (err) {
      setPollError(err.message)
    } finally {
      setPollLoading(false)
    }
  }, [idx, matchups])

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

  const fetchInsights = useCallback(async () => {
    setInsightsLoading(true)
    setInsightsError(null)
    try {
      const res = await fetch('/api/insights', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Insights API returned ${res.status}`)
      setInsightsSummary(data.summary || '')
    } catch (err) {
      setInsightsError(err.message)
      setInsightsSummary('')
    } finally {
      setInsightsLoading(false)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const [dems, reps] = await Promise.all([
          fetchCandidates(DEM_SLUG, 'Democratic'),
          fetchCandidates(REP_SLUG, 'Republican'),
        ])
        setMatchups(buildMatchups(dems, reps))

        // Prefetch photos for top candidates on each side
        const topNames = [
          ...dems.slice(0, 10).map(c => c.name),
          ...reps.slice(0, 10).map(c => c.name),
        ]
        const results = await Promise.all(
          topNames.map(name => fetchWikiPhoto(name).then(url => [name, url]))
        )
        setPhotos(Object.fromEntries(results.filter(([, url]) => url)))
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const prev = useCallback(() => {
    setIdx(i => (i === 0 ? Math.max(0, matchups.length - 1) : i - 1))
  }, [matchups.length])
  const next = useCallback(() => setIdx(i => Math.min(matchups.length - 1, i + 1)), [matchups.length])

  useEffect(() => {
    const handler = (e) => {
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
  const currentKey = current ? `${current.dem.id}-${current.rep.id}` : null
  const hasVotedCurrent = !!(currentKey && votedKeys[currentKey])

  useEffect(() => {
    if (!current) return
    if (!hasVotedCurrent) {
      setPollData(null)
      setPollError(null)
      setPollLoading(false)
      return
    }
    fetchPoll(current)
  }, [current, hasVotedCurrent, fetchPoll])

  useEffect(() => {
    if (!showLeaderboard) return
    fetchLeaderboard()
  }, [showLeaderboard, fetchLeaderboard, pollData?.totalVotes])

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!matchups.length) return <ErrorScreen message="No matchups found in market data." />

  const total = matchups.length
  const hasVoted = Boolean(pollData?.hasVoted)
  const selectedSide = pollData?.userVote || null
  const demVotePct = pollData?.totalVotes ? (pollData.demVotes / pollData.totalVotes) * 100 : 0
  const repVotePct = pollData?.totalVotes ? (pollData.repVotes / pollData.totalVotes) * 100 : 0

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <span className="header-title">2028 Presidential Matchups</span>
        <div className="header-actions">
          <button
            type="button"
            className="header-btn"
            onClick={() => setShowLeaderboard(s => !s)}
          >
            {showLeaderboard ? 'Hide leaderboard' : 'Leaderboard'}
          </button>
          <button
            type="button"
            className="header-btn"
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
          <div className="insights-title">AI Political Insights</div>
          {insightsLoading && <div className="insights-status">Generating your political summary…</div>}
          {!insightsLoading && insightsError && (
            <div className="insights-status insights-error">{insightsError}</div>
          )}
          {!insightsLoading && !insightsError && insightsSummary && (
            <p className="insights-body">{insightsSummary}</p>
          )}
          {!insightsLoading && !insightsError && !insightsSummary && (
            <div className="insights-status">Vote on a few matchups first to generate insights.</div>
          )}
        </section>
      )}

      {showLeaderboard && (
        <section className="leaderboard-drawer">
          <div className="leaderboard-header">
            <span>Rank</span>
            <span>Name</span>
            <span>Party</span>
            <span>Votes</span>
          </div>
          <div className="leaderboard-body">
            {leaderboardLoading && <div className="leaderboard-status">Loading leaderboard…</div>}
            {!leaderboardLoading && leaderboardError && (
              <div className="leaderboard-status leaderboard-error">{leaderboardError}</div>
            )}
            {!leaderboardLoading && !leaderboardError && leaderboardData.length === 0 && (
              <div className="leaderboard-status">No votes yet.</div>
            )}
            {!leaderboardLoading && !leaderboardError && leaderboardData.map((entry, i) => (
              <div className="leaderboard-row" key={`${entry.party}-${entry.id}`}>
                <span>#{i + 1}</span>
                <span className="lb-name">{entry.name}</span>
                <span className={entry.party === 'dem' ? 'lb-party lb-dem' : 'lb-party lb-rep'}>
                  {entry.party === 'dem' ? 'Democrat' : 'Republican'}
                </span>
                <span>{entry.votes}</span>
              </div>
            ))}
          </div>
          <div className="leaderboard-footer">{leaderboardTotalVotes} total votes cast</div>
        </section>
      )}

      {/* Main arena */}
      <main className="arena">
        <CandidatePanel
          candidate={current.dem}
          photo={photos[current.dem.name]}
          party="dem"
          animKey={`dem-${idx}`}
          onVote={() => { if (!hasVoted) vote('dem') }}
          canVote={!hasVoted && !pollLoading}
          flashTick={voteFx.side === 'dem' ? voteFx.tick : 0}
        />

        <div className="vs-column">
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
            {hasVotedCurrent ? (
              <div className="poll-results poll-results-visible">
                <div className="poll-row">
                  <span>{current.dem.name}</span>
                  <span>{demVotePct.toFixed(0)}%</span>
                </div>
                <div className="poll-row">
                  <span>{current.rep.name}</span>
                  <span>{repVotePct.toFixed(0)}%</span>
                </div>
                <div className="poll-meta">
                  {pollLoading ? 'Updating poll…' : `${pollData?.totalVotes || 0} total votes`}
                </div>
                {pollError && <div className="poll-error">{pollError}</div>}
              </div>
            ) : (
              <div className="poll-locked">
                Vote for a candidate to see polling results.
              </div>
            )}
          </div>

          <div className="controls-card">
            <div className="controls-title">Who would you vote for?</div>
            <div className="controls-row"><kbd>←</kbd> vote {current.dem.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>→</kbd> vote {current.rep.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>Space</kbd> next matchup</div>
          </div>
        </div>

        <CandidatePanel
          candidate={current.rep}
          photo={photos[current.rep.name]}
          party="rep"
          animKey={`rep-${idx}`}
          onVote={() => { if (!hasVoted) vote('rep') }}
          canVote={!hasVoted && !pollLoading}
          flashTick={voteFx.side === 'rep' ? voteFx.tick : 0}
        />
      </main>
    </div>
  )
}
