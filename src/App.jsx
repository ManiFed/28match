import { useState, useEffect, useCallback } from 'react'
import './App.css'

const DEM_SLUG = 'democratic-presidential-nominee-2028'
const REP_SLUG = 'republican-presidential-nominee-2028'

async function fetchCandidates(slug) {
  const res = await fetch(`/api/polymarket/events?slug=${slug}`)
  if (!res.ok) throw new Error(`Polymarket API returned ${res.status}`)
  const events = await res.json()

  const event = Array.isArray(events) ? events[0] : events
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

      // Binary market: find "Yes" outcome probability
      const yesIdx = outcomes.findIndex(o => o?.toLowerCase() === 'yes')
      if (yesIdx === -1) return null

      const prob = parseFloat(prices[yesIdx])
      if (isNaN(prob) || prob < 0.005) return null

      // Extract candidate name from question "Will X win the 2028..."
      const nameMatch = market.question?.match(/^Will\s+(.+?)\s+win\b/i)
      const name = nameMatch ? nameMatch[1].trim() : market.question?.trim() || 'Unknown'

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

function CandidatePanel({ candidate, photo, party, animKey }) {
  const isDem = party === 'dem'
  return (
    <div className={`candidate-panel ${isDem ? 'panel-dem' : 'panel-rep'}`}>
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
      </div>
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
  const [showList, setShowList] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const [dems, reps] = await Promise.all([
          fetchCandidates(DEM_SLUG),
          fetchCandidates(REP_SLUG),
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
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [prev, next])

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!matchups.length) return <ErrorScreen message="No matchups found in market data." />

  const current = matchups[idx]
  const total = matchups.length

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

          <button className="dice-btn" onClick={randomWeighted} title="Weighted random matchup">
            &#9646; Random
          </button>

          <button className="list-toggle" onClick={() => setShowList(s => !s)}>
            {showList ? 'Hide list' : 'All matchups'}
          </button>
        </div>

        <CandidatePanel
          candidate={current.rep}
          photo={photos[current.rep.name]}
          party="rep"
          animKey={`rep-${idx}`}
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
