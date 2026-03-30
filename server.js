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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matchup_user_votes (
      key TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('dem', 'rep')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (key, voter_id)
    )
  `)
}

async function getPollSummary(key, voterId = null) {
  const totalsPromise = pool.query(
    `SELECT key, dem_votes, rep_votes
     FROM matchup_vote_totals
     WHERE key = $1`,
    [key]
  )
  const votePromise = voterId
    ? pool.query(
        `SELECT side
         FROM matchup_user_votes
         WHERE key = $1 AND voter_id = $2`,
        [key, voterId]
      )
    : Promise.resolve({ rows: [] })

  const [totalsResult, voteResult] = await Promise.all([totalsPromise, votePromise])
  const row = totalsResult.rows[0]
  const userVote = voteResult.rows[0]?.side || null
  const demVotes = row ? Number(row.dem_votes) : 0
  const repVotes = row ? Number(row.rep_votes) : 0

  return {
    key,
    demVotes,
    repVotes,
    totalVotes: demVotes + repVotes,
    hasVoted: userVote !== null,
    userVote,
  }
}

async function upsertVote({ key, voterId, side, dem, rep }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const previousVoteResult = await client.query(
      `SELECT side
       FROM matchup_user_votes
       WHERE key = $1 AND voter_id = $2
       FOR UPDATE`,
      [key, voterId]
    )
    const previousSide = previousVoteResult.rows[0]?.side || null

    let demDelta = 0
    let repDelta = 0
    if (previousSide === 'dem') demDelta -= 1
    if (previousSide === 'rep') repDelta -= 1
    if (side === 'dem') demDelta += 1
    if (side === 'rep') repDelta += 1

    const totalsResult = await client.query(
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
           dem_votes = GREATEST(0, matchup_vote_totals.dem_votes + $6),
           rep_votes = GREATEST(0, matchup_vote_totals.rep_votes + $7),
           updated_at = NOW()
       RETURNING key, dem_votes, rep_votes`,
      [key, dem.id, dem.name, rep.id, rep.name, demDelta, repDelta]
    )

    await client.query(
      `INSERT INTO matchup_user_votes (key, voter_id, side, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key, voter_id) DO UPDATE
       SET side = EXCLUDED.side,
           updated_at = NOW()`,
      [key, voterId, side]
    )

    await client.query('COMMIT')
    const row = totalsResult.rows[0]
    const demVotes = Number(row.dem_votes)
    const repVotes = Number(row.rep_votes)
    return {
      key: row.key,
      demVotes,
      repVotes,
      totalVotes: demVotes + repVotes,
      hasVoted: true,
      userVote: side,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

app.get('/api/poll/leaderboard', async (_req, res) => {
  try {
    const result = await pool.query(`
      WITH candidate_matchups AS (
        SELECT dem_candidate_id AS candidate_id,
               dem_candidate_name AS candidate_name,
               'dem'::TEXT AS party,
               dem_votes AS candidate_votes,
               rep_votes AS opponent_votes,
               dem_votes + rep_votes AS matchup_total_votes
        FROM matchup_vote_totals
        UNION ALL
        SELECT rep_candidate_id AS candidate_id,
               rep_candidate_name AS candidate_name,
               'rep'::TEXT AS party,
               rep_votes AS candidate_votes,
               dem_votes AS opponent_votes,
               dem_votes + rep_votes AS matchup_total_votes
        FROM matchup_vote_totals
      )
      SELECT
        candidate_id AS id,
        candidate_name AS name,
        party,
        SUM(candidate_votes)::INT AS votes,
        COUNT(*)::INT AS matchup_count,
        SUM(CASE WHEN candidate_votes > opponent_votes THEN 1 ELSE 0 END)::INT AS wins
      FROM candidate_matchups
      WHERE matchup_total_votes > 0
      GROUP BY candidate_id, candidate_name, party
      ORDER BY
        (SUM(CASE WHEN candidate_votes > opponent_votes THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0)) DESC,
        SUM(candidate_votes) DESC,
        candidate_name ASC
    `)

    const leaderboard = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      party: row.party,
      votes: Number(row.votes),
      wins: Number(row.wins),
      matchupCount: Number(row.matchup_count),
      winRate: Number(row.matchup_count) > 0 ? Number(row.wins) / Number(row.matchup_count) : 0,
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
    const voterId = req.get('x-voter-id') || null
    res.json(await getPollSummary(key, voterId))
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load poll.' })
  }
})

app.post('/api/poll/vote', async (req, res) => {
  const { key, side, voterId, dem, rep } = req.body || {}
  if (!key || (side !== 'dem' && side !== 'rep')) {
    return res.status(400).json({ error: 'Invalid vote payload.' })
  }
  if (!voterId) {
    return res.status(400).json({ error: 'A voter ID is required.' })
  }

  if (!dem?.id || !dem?.name || !rep?.id || !rep?.name) {
    return res.status(400).json({ error: 'Both matchup candidates are required.' })
  }

  try {
    res.json(await upsertVote({ key, voterId, side, dem, rep }))
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to record vote.' })
  }
})

app.post('/api/insights', async (_req, res) => {
  res.status(501).json({
    error: 'Insights are unavailable because vote history snapshots are not stored.',
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
