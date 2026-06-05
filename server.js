import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pg from 'pg'
import crypto from 'crypto'

import { ARCHETYPE_SYSTEM_PROMPT, buildArchetypeUserPrompt } from './src/lib/archetypePrompt.js'
import { renderProfileCard } from './server/render.js'

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

app.use(express.json({ limit: '12mb' }))

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidate_summaries (
      candidate_name TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

const WIKI_USER_AGENT = '28match/1.0 (candidate-summary; contact: hello@28match.app)'

function normalizeCandidateName(name) {
  return String(name || '').trim()
}

async function fetchWikipediaExtract(name) {
  const params = new URLSearchParams({
    action: 'query',
    titles: name,
    redirects: '1',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    format: 'json',
  })

  try {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': WIKI_USER_AGENT },
    })
    if (!res.ok) return null
    const data = await res.json()
    const pages = Object.values(data?.query?.pages || {})
    const page = pages.find((p) => !p?.missing && p?.extract)
    return page?.extract?.trim() || null
  } catch {
    return null
  }
}

async function getStoredCandidateSummary(candidateName) {
  const result = await pool.query(
    `SELECT summary, created_at FROM candidate_summaries WHERE candidate_name = $1`,
    [candidateName]
  )
  return result.rows[0] || null
}

function isBulletSummaryFormat(summary) {
  return /background\s*:/i.test(summary) && /views\s*:/i.test(summary)
}

async function storeCandidateSummary(candidateName, summary) {
  const insertResult = await pool.query(
    `INSERT INTO candidate_summaries (candidate_name, summary)
     VALUES ($1, $2)
     ON CONFLICT (candidate_name) DO UPDATE
       SET summary = EXCLUDED.summary, created_at = NOW()
     RETURNING summary, created_at`,
    [candidateName, summary]
  )
  return insertResult.rows[0] || getStoredCandidateSummary(candidateName)
}

async function generateCandidateSummary(candidateName) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing on the server.')
  }

  const wikiExtract = await fetchWikipediaExtract(candidateName)
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
  const systemPrompt = [
    'You write ultra-concise, neutral candidate blurbs for a 2028 U.S. presidential primary matchup app.',
    'Be factual and non-partisan. Do not predict who will win.',
    'Return exactly two lines in this format (no other text):',
    '• Background: [1 medium sentence — who they are, current role, and why they matter in 2028]',
    '• Views: [1 medium sentence — signature policy positions and political lane]',
    'Max 55 words total. No filler, hedging, or repetition. Plain text only.',
  ].join(' ')

  const userPrompt = [
    `Candidate: ${candidateName}`,
    wikiExtract ? `Wikipedia intro (for grounding): ${wikiExtract.slice(0, 2500)}` : null,
    'Cover only the essentials: career background in line 1, key views in line 2.',
  ].filter(Boolean).join('\n\n')

  const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  const aiData = await aiRes.json().catch(() => ({}))
  if (!aiRes.ok) {
    throw new Error(aiData?.error?.message || `OpenRouter request failed (${aiRes.status}).`)
  }

  const summary = aiData?.choices?.[0]?.message?.content?.trim()
  if (!summary) {
    throw new Error('OpenRouter returned an empty response.')
  }

  return summary
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

  const { votes, skips = [], format = 'text', recommendationFeedback = null, insightsPayload = null } = req.body || {}
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
    strength: vote?.strength || 'normal',
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
    `Here is structured data about a user's voting behavior in 2028 presidential nominee matchups:`,
    insightsPayload
      ? `Rich analysis data: ${JSON.stringify(insightsPayload)}`
      : `Basic votes: ${JSON.stringify(trimmedVotes.slice(-100))}`,
    !insightsPayload && trimmedSkips.length ? `Recent skips: ${JSON.stringify(trimmedSkips.slice(-60))}` : null,
    recommendationFeedback ? `Engagement with recommendations: ${JSON.stringify(recommendationFeedback)}` : null,
    '',
    'IMPORTANT RULES FOR ANALYSIS:',
    '- Be extremely conservative when describing negative feelings like "aversion", "dislike", or "opposition". Only mention these if the user had multiple clear opportunities to support a candidate and consistently chose not to.',
    '- Skips are often just navigation behavior. Do NOT treat most skips as evidence of dislike unless the user repeatedly skipped a candidate even when a strong prediction favored them.',
    '- Strong votes (when available) are more meaningful signals than normal votes.',
    '- Focus first on what the user positively supports, second on genuine surprises, and only mention aversion when the data is unambiguous.',
    '- When writing summary_text or bias_signals, include at least one real-world political factor (governing record, coalition fit, media narrative, etc.) when relevant.',
    '- Do not invent patterns. If the data is thin or ambiguous, say so clearly in confidence_notes.',
    '',
    'Return JSON with exactly these fields:',
    'bias_signals: array of 2-4 short, evidence-based observations (be cautious with negative claims).',
    'surprising_votes: array of 1-3 specific votes that stand out from the user\'s general pattern.',
    'confidence_notes: array of 1-2 honest caveats about data limitations or uncertainty.',
    'summary_text: one short paragraph (max 120 words).',
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

app.get('/api/candidate/summary', async (req, res) => {
  const candidateName = normalizeCandidateName(req.query?.name)
  if (!candidateName) {
    return res.status(400).json({ error: 'Candidate name is required.' })
  }

  try {
    const existing = await getStoredCandidateSummary(candidateName)
    if (existing?.summary && isBulletSummaryFormat(existing.summary)) {
      return res.json({
        name: candidateName,
        summary: existing.summary,
        cached: true,
        createdAt: existing.created_at,
      })
    }

    const summary = await generateCandidateSummary(candidateName)
    const stored = await storeCandidateSummary(candidateName, summary)

    res.json({
      name: candidateName,
      summary: stored?.summary || summary,
      cached: false,
      createdAt: stored?.created_at || new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load candidate summary.' })
  }
})

// --- Shareable card archetype generation ---
app.post('/api/share/archetype', async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY is missing on the server.' })
  }

  const { votes = [], lean = null, bubbles = [] } = req.body || {}

  if (!Array.isArray(votes) || votes.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty votes array.' })
  }

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
  const systemPrompt = ARCHETYPE_SYSTEM_PROMPT
  const userPrompt = buildArchetypeUserPrompt({ votes, lean, bubbles })

  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
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
      return res.status(502).json({ error: 'OpenRouter returned an empty response.' })
    }

    // Try to parse JSON, with fallback extraction
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

    if (!parsed?.name || !parsed?.description) {
      return res.status(502).json({ error: 'Failed to parse archetype from model.' })
    }

    res.json({
      name: parsed.name.trim(),
      description: parsed.description.trim(),
      model,
    })
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate archetype.' })
  }
})

// --- Profile card image generation (with aggressive caching) ---
app.post('/api/share/profile', async (req, res) => {
  try {
    const { votes = [], archetype = null, lean = null, bubbles = [] } = req.body || {}

    if (!Array.isArray(votes) || votes.length === 0) {
      return res.status(400).json({ error: 'votes array is required' })
    }

    const payload = {
      archetype,
      lean,
      bubbles: Array.isArray(bubbles) ? bubbles : [],
      totalVotes: votes.length,
    }

    const { buffer, cached } = await renderProfileCard(payload)

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('X-Cache', cached ? 'HIT' : 'MISS')
    res.send(buffer)
  } catch (error) {
    console.error('[share/profile] render error:', error)
    res.status(500).json({ 
      error: 'Failed to render profile card',
      details: error.message || String(error),
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    })
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
