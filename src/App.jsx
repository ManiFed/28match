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
  const [showList, setShowList] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboardData, setLeaderboardData] = useState([])
  const [leaderboardTotalVotes, setLeaderboardTotalVotes] = useState(0)
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState(null)
  const [pollData, setPollData] = useState(null)
  const [pollLoading, setPollLoading] = useState(false)
  const [pollError, setPollError] = useState(null)

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
      if (!res.ok) throw new Error(`Poll vote failed (${res.status})`)
      const data = await res.json()
      setPollData(data)
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

  const randomWeighted = useCallback(() => {
    const total = matchups.reduce((s, m) => s + m.prob, 0)
    let r = Math.random() * total
    for (let i = 0; i < matchups.length; i++) {
      r -= matchups[i].prob
      if (r <= 0) { setIdx(i); return }
    }
    setIdx(matchups.length - 1)
  }, [matchups])

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

  useEffect(() => {
    if (!current) return
    fetchPoll(current)
  }, [current, fetchPoll])

  useEffect(() => {
    if (!showLeaderboard) return
    fetchLeaderboard()
  }, [showLeaderboard, fetchLeaderboard, pollData?.totalVotes])

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
        <div className="header-actions">
          <button
            type="button"
            className="header-btn"
            onClick={() => setShowLeaderboard(s => !s)}
          >
            {showLeaderboard ? 'Hide leaderboard' : 'Leaderboard'}
          </button>
          <span className="header-sub">Live odds from Polymarket · {total} matchups ranked by probability</span>
        </div>
      </header>

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
          onVote={() => vote('dem')}
        />

        <div className="vs-column">
          <div className="vs-text">VS</div>

          <div className="controls-card">
            <div className="controls-title">Controls</div>
            <div className="controls-row"><kbd>←</kbd> vote {current.dem.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>→</kbd> vote {current.rep.name.split(' ')[0]}</div>
            <div className="controls-row"><kbd>Space</kbd> next matchup</div>
          </div>

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

          <button className="dice-btn" onClick={randomWeighted} title="Weighted random matchup">
            &#9646; Random
          </button>

          <button className="list-toggle" onClick={() => setShowList(s => !s)}>
            {showList ? 'Hide list' : 'All matchups'}
          </button>

          <div className="poll-card">
            <div className="poll-title">Who wins this matchup?</div>
            <div className="poll-actions">
              <button className="poll-btn poll-dem" onClick={() => vote('dem')} disabled={pollLoading}>
                Vote {current.dem.name.split(' ')[0]}
              </button>
              <button className="poll-btn poll-rep" onClick={() => vote('rep')} disabled={pollLoading}>
                Vote {current.rep.name.split(' ')[0]}
              </button>
            </div>
            <div className="poll-results">
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

      {/* Matchup list drawer */}
      {showList && (
        <div className="list-drawer">
          <div className="list-header">
            <span>Rank</span>
            <span>Democrat</span>
            <span>Republican</span>
            <span>Probability</span>
          </div>
          <div className="list-body">
            {matchups.slice(0, 60).map((m, i) => (
              <div
                key={i}
                className={`list-row ${i === idx ? 'list-row-active' : ''}`}
                onClick={() => { setIdx(i); setShowList(false) }}
              >
                <span className="lr-rank">#{i + 1}</span>
                <span className="lr-dem">{m.dem.name}</span>
                <span className="lr-rep">{m.rep.name}</span>
                <span className="lr-prob">{(m.prob * 100).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
