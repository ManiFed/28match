import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pg from 'pg'
import crypto from 'crypto'

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

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err)
      resolve(`${salt}:${derived.toString('hex')}`)
    })
  })
}

async function verifyPassword(password, hash) {
  const [salt, key] = hash.split(':')
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err)
      resolve(derived.toString('hex') === key)
    })
  })
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

async function getUserFromToken(token) {
  if (!token) return null
  const result = await pool.query(
    `SELECT id, username, created_at FROM users WHERE token = $1`,
    [token]
  )
  return result.rows[0] || null
}

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
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      token TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_votes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      key TEXT NOT NULL,
      side TEXT NOT NULL,
      dem_name TEXT NOT NULL,
      rep_name TEXT NOT NULL,
      dem_prob REAL NOT NULL DEFAULT 0,
      rep_prob REAL NOT NULL DEFAULT 0,
      picked_tags JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, key)
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

async function upsertVote({ key, side, dem, rep, weight = 1 }) {
  const normalizedWeight = Number.isFinite(weight) ? Math.max(1, Math.min(2, Math.round(weight))) : 1
  const demDelta = side === 'dem' ? normalizedWeight : 0
  const repDelta = side === 'rep' ? normalizedWeight : 0

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
        SUM(CASE WHEN candidate_votes > opponent_votes THEN 1 ELSE 0 END)::INT AS wins,
        AVG(candidate_votes::FLOAT / NULLIF(matchup_total_votes, 0)) AS avg_vote_share,
        AVG(opponent_votes::FLOAT / NULLIF(matchup_total_votes, 0)) AS avg_opponent_share
      FROM candidate_matchups
      WHERE matchup_total_votes > 0
      GROUP BY candidate_id, candidate_name, party
      ORDER BY candidate_name ASC
    `)

    const leaderboard = result.rows.map(row => {
      const votes = Number(row.votes)
      const wins = Number(row.wins)
      const matchupCount = Number(row.matchup_count)
      const winRate = matchupCount > 0 ? wins / matchupCount : 0
      const avgVoteShare = Number(row.avg_vote_share) || 0
      const avgOpponentShare = Number(row.avg_opponent_share) || 0

      const sampleSizeWeight = matchupCount / (matchupCount + 4)
      const confidenceVoteShare = sampleSizeWeight * avgVoteShare + (1 - sampleSizeWeight) * 0.5
      const difficultyMultiplier = 0.7 + (avgOpponentShare * 0.6)
      const compositeScore = confidenceVoteShare * difficultyMultiplier

      return {
        id: row.id,
        name: row.name,
        party: row.party,
        votes,
        wins,
        matchupCount,
        winRate,
        avgVoteShare,
        avgOpponentShare,
        compositeScore,
      }
    }).sort((a, b) => (
      b.compositeScore - a.compositeScore
      || b.winRate - a.winRate
      || b.votes - a.votes
      || a.name.localeCompare(b.name)
    ))

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
  const { key, side, dem, rep, weight } = req.body || {}
  if (!key || (side !== 'dem' && side !== 'rep')) {
    return res.status(400).json({ error: 'Invalid vote payload.' })
  }

  if (!dem?.id || !dem?.name || !rep?.id || !rep?.name) {
    return res.status(400).json({ error: 'Both matchup candidates are required.' })
  }

  try {
    res.json(await upsertVote({ key, side, dem, rep, weight }))
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to record vote.' })
  }
})

// --- Auth endpoints ---

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' })
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' })
  }
  const trimmedUsername = username.trim().toLowerCase()
  if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores.' })
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [trimmedUsername])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken.' })
    }
    const passwordHash = await hashPassword(password)
    const token = generateToken()
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, token) VALUES ($1, $2, $3) RETURNING id, username, created_at`,
      [trimmedUsername, passwordHash, token]
    )
    const user = result.rows[0]
    res.json({ user: { id: user.id, username: user.username, createdAt: user.created_at }, token })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Registration failed.' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' })
  }
  const trimmedUsername = username.trim().toLowerCase()
  try {
    const result = await pool.query('SELECT id, username, password_hash, created_at FROM users WHERE username = $1', [trimmedUsername])
    const user = result.rows[0]
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' })
    }
    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password.' })
    }
    const token = generateToken()
    await pool.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id])
    res.json({ user: { id: user.id, username: user.username, createdAt: user.created_at }, token })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Login failed.' })
  }
})

app.get('/api/auth/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  try {
    const user = await getUserFromToken(token)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })
    res.json({ user: { id: user.id, username: user.username, createdAt: user.created_at } })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Auth check failed.' })
  }
})

app.post('/api/auth/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  try {
    if (token) {
      await pool.query('UPDATE users SET token = NULL WHERE token = $1', [token])
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Logout failed.' })
  }
})

// --- User vote storage ---

app.get('/api/user/votes', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  try {
    const user = await getUserFromToken(token)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })
    const result = await pool.query(
      `SELECT key, side, dem_name, rep_name, dem_prob, rep_prob, picked_tags, created_at
       FROM user_votes WHERE user_id = $1 ORDER BY created_at ASC`,
      [user.id]
    )
    const votes = result.rows.map(row => ({
      key: row.key,
      side: row.side,
      demName: row.dem_name,
      repName: row.rep_name,
      demProb: Number(row.dem_prob),
      repProb: Number(row.rep_prob),
      pickedTags: row.picked_tags || [],
      createdAt: row.created_at,
    }))
    res.json({ votes })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load votes.' })
  }
})

app.post('/api/user/votes/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  const { votes } = req.body || {}
  if (!Array.isArray(votes)) {
    return res.status(400).json({ error: 'Votes must be an array.' })
  }
  try {
    const user = await getUserFromToken(token)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })
    let synced = 0
    for (const vote of votes) {
      if (!vote?.key || !vote?.side) continue
      await pool.query(
        `INSERT INTO user_votes (user_id, key, side, dem_name, rep_name, dem_prob, rep_prob, picked_tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, key) DO NOTHING`,
        [
          user.id,
          vote.key,
          vote.side,
          vote.demName || '',
          vote.repName || '',
          Number(vote.demProb) || 0,
          Number(vote.repProb) || 0,
          JSON.stringify(vote.pickedTags || []),
          vote.createdAt || new Date().toISOString(),
        ]
      )
      synced++
    }
    res.json({ synced })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to sync votes.' })
  }
})

app.post('/api/user/votes/add', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  const vote = req.body || {}
  if (!vote?.key || !vote?.side) {
    return res.status(400).json({ error: 'Invalid vote data.' })
  }
  try {
    const user = await getUserFromToken(token)
    if (!user) return res.status(401).json({ error: 'Not authenticated.' })
    await pool.query(
      `INSERT INTO user_votes (user_id, key, side, dem_name, rep_name, dem_prob, rep_prob, picked_tags, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, key) DO UPDATE SET
         side = EXCLUDED.side,
         dem_name = EXCLUDED.dem_name,
         rep_name = EXCLUDED.rep_name,
         dem_prob = EXCLUDED.dem_prob,
         rep_prob = EXCLUDED.rep_prob,
         picked_tags = EXCLUDED.picked_tags,
         created_at = EXCLUDED.created_at`,
      [
        user.id,
        vote.key,
        vote.side,
        vote.demName || '',
        vote.repName || '',
        Number(vote.demProb) || 0,
        Number(vote.repProb) || 0,
        JSON.stringify(vote.pickedTags || []),
        vote.createdAt || new Date().toISOString(),
      ]
    )
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to save vote.' })
  }
})

app.post('/api/insights', async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is missing on the server.',
    })
  }

  const { votes, skips = [], format = 'text', recommendationFeedback = null } = req.body || {}
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
  const trimmedSkips = Array.isArray(skips)
    ? skips.slice(-200).map((skip) => ({
        key: skip?.key,
        demName: skip?.demName,
        repName: skip?.repName,
        predictedSide: skip?.predictedSide || null,
        reason: skip?.reason,
        createdAt: skip?.createdAt,
      }))
    : []

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
  const systemPrompt = [
    'You analyze informal political matchup voting behavior.',
    'Be concise and specific.',
    'Use neutral language, avoid moral judgment, and avoid claims about protected traits.',
    'If asked for JSON, return valid JSON only.',
  ].join(' ')

  const userPrompt = [
    `These are a single user session's matchup votes (JSON): ${JSON.stringify(trimmedVotes)}`,
    trimmedSkips.length
      ? `These are skipped matchups in this session (JSON): ${JSON.stringify(trimmedSkips)}`
      : null,
    recommendationFeedback
      ? `Recommendation engagement feedback (JSON): ${JSON.stringify(recommendationFeedback)}`
      : null,
    'Treat a skipped matchup as weak evidence the user disliked both candidates, especially when a prediction was shown and then skipped.',
    'When writing summary_text, include at least one real-world political factor beyond app voting data (for example public profile, governing record, coalition fit, media narrative, or current national issues).',
    'Do not invent precise facts. If uncertain, use cautious phrasing.',
    'Return JSON with exactly these fields:',
    'bias_signals: array of 2-4 short bullet-like strings about noticeable patterns.',
    'surprising_votes: array of 1-3 specific unusual picks.',
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
