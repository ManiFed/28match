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
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
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
  const totalsResult = await pool.query(
    `SELECT key, dem_votes, rep_votes
     FROM matchup_vote_totals
     WHERE key = $1`,
    [key]
  )
  const row = totalsResult.rows[0]
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

async function upsertVote({ key, side, dem, rep }) {
  const demDelta = side === 'dem' ? 1 : 0
  const repDelta = side === 'rep' ? 1 : 0

  const totalsResult = await pool.query(
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
         dem_votes = matchup_vote_totals.dem_votes + $6,
         rep_votes = matchup_vote_totals.rep_votes + $7,
         updated_at = NOW()
     RETURNING key, dem_votes, rep_votes`,
    [key, dem.id, dem.name, rep.id, rep.name, demDelta, repDelta]
  )

  const row = totalsResult.rows[0]
  const demVotes = Number(row.dem_votes)
  const repVotes = Number(row.rep_votes)
  return {
    key: row.key,
    demVotes,
    repVotes,
    totalVotes: demVotes + repVotes,
    hasVoted: false,
    userVote: null,
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

  if (!dem?.id || !dem?.name || !rep?.id || !rep?.name) {
    return res.status(400).json({ error: 'Both matchup candidates are required.' })
  }

  try {
    res.json(await upsertVote({ key, side, dem, rep }))
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to record vote.' })
  }
})

app.post('/api/insights', async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is missing on the server.',
    })
  }

  const { votes, format = 'text', recommendationFeedback = null } = req.body || {}
  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({
      error: 'Provide a non-empty votes array to generate insights.',
    })
  }

  const trimmedVotes = votes.slice(-200).map((vote) => ({
    side: vote?.side,
    demName: vote?.demName,
    repName: vote?.repName,
    demProb: Number(vote?.demProb) || 0,
    repProb: Number(vote?.repProb) || 0,
    createdAt: vote?.createdAt,
  }))

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
  const systemPrompt = [
    'You analyze informal political matchup voting behavior.',
    'Be concise and specific.',
    'Use neutral language, avoid moral judgment, and avoid claims about protected traits.',
    'If asked for JSON, return valid JSON only.',
  ].join(' ')

  const userPrompt = [
    `These are a single user session's matchup votes (JSON): ${JSON.stringify(trimmedVotes)}`,
    recommendationFeedback
      ? `Recommendation engagement feedback (JSON): ${JSON.stringify(recommendationFeedback)}`
      : null,
    'Return JSON with exactly these fields:',
    'bias_signals: array of 2-4 short bullet-like strings about noticeable patterns.',
    'surprising_votes: array of 1-3 specific unusual picks.',
    'suggested_matchups: array of 3 contrasting matchup ideas as short strings.',
    'confidence_notes: array of 1-2 caveats about uncertainty/sample size.',
    'Also include summary_text: one short paragraph (max 120 words) for quick reading.',
  ].join('\n')

  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    const aiData = await aiRes.json().catch(() => ({}))
    if (!aiRes.ok) {
      return res.status(502).json({
        error: aiData?.error?.message || `OpenRouter request failed (${aiRes.status}).`,
      })
    }

    const rawContent = aiData?.choices?.[0]?.message?.content?.trim()
    if (!rawContent) {
      return res.status(502).json({
        error: 'OpenRouter returned an empty response.',
      })
    }

    let parsed = null
    try {
      parsed = JSON.parse(rawContent)
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          parsed = JSON.parse(match[0])
        } catch {
          parsed = null
        }
      }
    }

    const summary = parsed?.summary_text || rawContent
    const structured = {
      bias_signals: Array.isArray(parsed?.bias_signals) ? parsed.bias_signals : [],
      surprising_votes: Array.isArray(parsed?.surprising_votes) ? parsed.surprising_votes : [],
      suggested_matchups: Array.isArray(parsed?.suggested_matchups) ? parsed.suggested_matchups : [],
      confidence_notes: Array.isArray(parsed?.confidence_notes) ? parsed.confidence_notes : [],
    }

    if (format === 'structured') {
      return res.json({ structured, model })
    }
    if (format === 'both') {
      return res.json({ summary, structured, model })
    }
    res.json({ summary, model, structured })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate insights.' })
  }
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  initDb().catch((error) => {
    console.error('Database initialization failed (API routes will not work):', error.message)
  })
})
