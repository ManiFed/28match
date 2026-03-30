import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pg from 'pg'

const { Pool } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000

const dbConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : undefined,
    }
  : {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
    }

const pool = new Pool(dbConfig)

app.use(express.json())

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matchup_vote_totals (
      key TEXT PRIMARY KEY,
      dem_candidate_id TEXT NOT NULL,
      dem_candidate_name TEXT NOT NULL,
      rep_candidate_id TEXT NOT NULL,
      rep_candidate_name TEXT NOT NULL,
      dem_votes INTEGER NOT NULL DEFAULT 0,
      rep_votes INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function getPollSummary(key) {
  const result = await pool.query(
    `SELECT key, dem_votes, rep_votes
     FROM matchup_vote_totals
     WHERE key = $1`,
    [key]
  )

  const row = result.rows[0]
  const demVotes = row ? Number(row.dem_votes) : 0
  const repVotes = row ? Number(row.rep_votes) : 0

  return {
    key,
    demVotes,
    repVotes,
    totalVotes: demVotes + repVotes,
    hasVoted: false,
    userVote: null,
  }
}

function applyCandidateVoteDelta(side, candidate, delta) {
  if (!candidate?.id || !candidate?.name || !delta) return

  const candidateKey = `${side}:${candidate.id}`
  const existing = candidateVoteTotals.get(candidateKey) || {
    id: candidate.id,
    name: candidate.name,
    party: side,
    votes: 0,
  }

  existing.votes = Math.max(0, existing.votes + delta)
  candidateVoteTotals.set(candidateKey, existing)
}

function getVoterVoteHistory(voterId) {
  const history = []
  for (const [key, votes] of matchupVotes.entries()) {
    const side = votes.get(voterId)
    if (!side) continue

    const meta = matchupMeta.get(key)
    if (!meta?.dem?.name || !meta?.rep?.name) continue

    history.push({
      key,
      side,
      chosenCandidate: side === 'dem' ? meta.dem.name : meta.rep.name,
      opposingCandidate: side === 'dem' ? meta.rep.name : meta.dem.name,
      matchup: `${meta.dem.name} vs ${meta.rep.name}`,
app.get('/api/poll/leaderboard', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT candidate_id AS id, candidate_name AS name, party, SUM(votes)::INT AS votes
      FROM (
        SELECT dem_candidate_id AS candidate_id,
               dem_candidate_name AS candidate_name,
               'dem'::TEXT AS party,
               dem_votes AS votes
        FROM matchup_vote_totals
        UNION ALL
        SELECT rep_candidate_id AS candidate_id,
               rep_candidate_name AS candidate_name,
               'rep'::TEXT AS party,
               rep_votes AS votes
        FROM matchup_vote_totals
      ) candidate_totals
      GROUP BY candidate_id, candidate_name, party
      ORDER BY votes DESC, name ASC
    `)

    const leaderboard = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      party: row.party,
      votes: Number(row.votes),
    }))

    res.json({
      totalVotes: leaderboard.reduce((sum, entry) => sum + entry.votes, 0),
      leaderboard,
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load leaderboard.' })
  }
})

app.get('/api/poll/:key', async (req, res) => {
  try {
    const key = req.params.key
    res.json(await getPollSummary(key))
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load poll.' })
  }
})

app.post('/api/poll/vote', async (req, res) => {
  const { key, side, dem, rep } = req.body || {}
  if (!key || (side !== 'dem' && side !== 'rep')) {
    return res.status(400).json({ error: 'Invalid vote payload.' })
  }

  const voterId = getVoterId(req, res)
  const votes = matchupVotes.get(key) || new Map()
  const priorVote = votes.get(voterId)

  if (priorVote === side) {
    const poll = getPollSummary(key, voterId)
    return res.json({ key, ...poll, totalVotes: poll.demVotes + poll.repVotes })
  }

  if (priorVote) {
    const priorCandidate = priorVote === 'dem' ? dem : rep
    applyCandidateVoteDelta(priorVote, priorCandidate, -1)
  }

  if (dem?.id && dem?.name && rep?.id && rep?.name) {
    matchupMeta.set(key, {
      dem: { id: dem.id, name: dem.name },
      rep: { id: rep.id, name: rep.name },
    })
  }

  votes.set(voterId, side)
  matchupVotes.set(key, votes)

  const votedCandidate = side === 'dem' ? dem : rep
  applyCandidateVoteDelta(side, votedCandidate, 1)

  const poll = getPollSummary(key, voterId)
  res.json({ key, ...poll, totalVotes: poll.demVotes + poll.repVotes })
})


app.post('/api/insights', async (req, res) => {
  const voterId = getVoterId(req, res)
  const history = getVoterVoteHistory(voterId)

  if (history.length === 0) {
    return res.json({ summary: '' })
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is not configured on the server.',
    })
  }
  if (!dem?.id || !dem?.name || !rep?.id || !rep?.name) {
    return res.status(400).json({ error: 'Both matchup candidates are required.' })
  }

  const incrementDem = side === 'dem' ? 1 : 0
  const incrementRep = side === 'rep' ? 1 : 0

  try {
    const result = await pool.query(
      `INSERT INTO matchup_vote_totals (
         key,
         dem_candidate_id,
         dem_candidate_name,
         rep_candidate_id,
         rep_candidate_name,
         dem_votes,
         rep_votes,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (key) DO UPDATE
       SET dem_candidate_id = EXCLUDED.dem_candidate_id,
           dem_candidate_name = EXCLUDED.dem_candidate_name,
           rep_candidate_id = EXCLUDED.rep_candidate_id,
           rep_candidate_name = EXCLUDED.rep_candidate_name,
           dem_votes = matchup_vote_totals.dem_votes + EXCLUDED.dem_votes,
           rep_votes = matchup_vote_totals.rep_votes + EXCLUDED.rep_votes,
           updated_at = NOW()
       RETURNING key, dem_votes, rep_votes`,
      [key, dem.id, dem.name, rep.id, rep.name, incrementDem, incrementRep]
    )

    const row = result.rows[0]
    const demVotes = Number(row.dem_votes)
    const repVotes = Number(row.rep_votes)

    res.json({
      key: row.key,
      demVotes,
      repVotes,
      totalVotes: demVotes + repVotes,
      hasVoted: false,
      userVote: null,
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to record vote.' })
  }
})

app.post('/api/insights', async (_req, res) => {
  res.status(501).json({
    error: 'Insights are unavailable because individual vote histories are not stored.',
  })
})

app.use(
  '/api/polymarket',
  createProxyMiddleware({
    target: 'https://gamma-api.polymarket.com',
    changeOrigin: true,
    pathRewrite: { '^/api/polymarket': '' },
  })
)

app.use(express.static(join(__dirname, 'dist')))

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`)
    })
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error)
    process.exit(1)
  })
