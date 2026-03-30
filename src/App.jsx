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

  const candidates = markets
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

      return { id: market.id, name, prob }
    })
    .filter(Boolean)
    .sort((a, b) => b.prob - a.prob)

  return candidates
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

function buildMatchups(dems, reps) {
  const list = []
  for (const dem of dems) {
    for (const rep of reps) {
      list.push({ dem, rep, prob: dem.prob * rep.prob })
    }
  }
  list.sort((a, b) => b.prob - a.prob)
  return list
}

function Initials({ name, party }) {
  const parts = name.trim().split(/\s+/)
  const initials = parts.length >= 2
    ? parts[0][0] + parts[parts.length - 1][0]
    : name.slice(0, 2)
  return (
    <div className={`initials-avatar initials-${party}`}>
      {initials.toUpperCase()}
    </div>
  )
}

function CandidatePanel({ candidate, photo, party, animKey, onVote }) {
  const isDem = party === 'dem'
  return (
    <button
      className={`candidate-panel ${isDem ? 'panel-dem' : 'panel-rep'}`}
      onClick={onVote}
      type="button"
    >
      <div className="party-tag">{isDem ? 'Democrat' : 'Republican'}</div>
      <div className="photo-wrapper" key={animKey}>
        {photo
          ? <img src={photo} alt={candidate.name} className="candidate-photo" />
          : <Initials name={candidate.name} party={party} />
        }
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
  const [pollData, setPollData] = useState(null)
  const [pollLoading, setPollLoading] = useState(false)
  const [pollError, setPollError] = useState(null)
  const [votedKeys, setVotedKeys] = useState({})

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
        body: JSON.stringify({ key, side }),
      })
      if (!res.ok) throw new Error(`Poll vote failed (${res.status})`)
      const data = await res.json()
      setPollData(data)
      setVotedKeys(prev => ({ ...prev, [key]: true }))
    } catch (err) {
      setPollError(err.message)
    } finally {
      setPollLoading(false)
    }
  }, [idx, matchups])

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

  const prev = useCallback(() => setIdx(i => Math.max(0, i - 1)), [])
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

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!matchups.length) return <ErrorScreen message="No matchups found in market data." />

  const total = matchups.length
  const demVotePct = pollData?.totalVotes ? (pollData.demVotes / pollData.totalVotes) * 100 : 0
  const repVotePct = pollData?.totalVotes ? (pollData.repVotes / pollData.totalVotes) * 100 : 0

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <span className="header-title">2028 Presidential Matchups</span>
        <span className="header-sub">Live odds from Polymarket · {total} matchups ranked by probability</span>
      </header>

      {/* Main arena */}
      <main className="arena">
        <CandidatePanel
          candidate={current.dem}
          photo={photos[current.dem.name]}
          party="dem"
          animKey={`dem-${idx}`}
          onVote={() => vote('dem')}
        />

        <div className="vs-column">
          <div className="vs-text">VS</div>

          <div className="combined-prob">
            <span className="cp-pct">{(current.prob * 100).toFixed(2)}%</span>
            <span className="cp-label">matchup probability</span>
          </div>

          <div className="rank-badge">
            #{idx + 1} most likely
          </div>

          <div className="nav-row">
            <button className="nav-btn" onClick={prev} disabled={idx === 0} aria-label="Previous">
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
          onVote={() => vote('rep')}
        />
      </main>
    </div>
  )
}
