import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000
const candidateVoteTotals = new Map()
const matchupVotes = new Map()
const matchupMeta = new Map()
const VOTER_COOKIE = 'voter_id'

app.use(express.json())

function parseCookies(req) {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return {}

  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=')
      if (separator === -1) return cookies

      const key = decodeURIComponent(part.slice(0, separator).trim())
      const value = decodeURIComponent(part.slice(separator + 1).trim())
      cookies[key] = value
      return cookies
    }, {})
}

function getVoterId(req, res) {
  const cookies = parseCookies(req)
  const existing = cookies[VOTER_COOKIE]
  if (existing) return existing

  const voterId = randomUUID()
  const oneYearSeconds = 60 * 60 * 24 * 365
  res.setHeader(
    'Set-Cookie',
    `${VOTER_COOKIE}=${encodeURIComponent(voterId)}; Max-Age=${oneYearSeconds}; Path=/; HttpOnly; SameSite=Lax`
  )
  return voterId
}

function getPollSummary(key, voterId) {
  const votes = matchupVotes.get(key) || new Map()
  let demVotes = 0
  let repVotes = 0

  for (const side of votes.values()) {
    if (side === 'dem') demVotes += 1
    if (side === 'rep') repVotes += 1
  }

  const userVote = votes.get(voterId) || null
  return {
    key,
    demVotes,
    repVotes,
    totalVotes: demVotes + repVotes,
    hasVoted: userVote !== null,
    userVote,
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
    })
  }

  return history
}

function buildInsightsPrompt(history) {
  const demVotes = history.filter(v => v.side === 'dem').length
  const repVotes = history.filter(v => v.side === 'rep').length

  const voteLines = history
    .slice(0, 50)
    .map(v => `- Picked ${v.chosenCandidate} over ${v.opposingCandidate}`)
    .join('\n')

  return `You are a neutral political analyst.\n\nBased only on these matchup choices, write a concise 4-6 sentence summary of the user's political preferences.\n\nTotal democratic picks: ${demVotes}\nTotal republican picks: ${repVotes}\n\nVotes:\n${voteLines}\n\nRequirements:\n- Do not claim certainty; use phrases like \"suggests\" or \"may indicate\".\n- Mention ideological lean (if any), candidate-style preferences, and one caveat about limited data.\n- Keep it plain English and avoid partisan persuasion.`
}

app.get('/api/poll/leaderboard', (_req, res) => {
  const leaderboard = [...candidateVoteTotals.values()]
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))

  res.json({
    totalVotes: leaderboard.reduce((sum, entry) => sum + entry.votes, 0),
    leaderboard,
  })
})

app.get('/api/poll/:key', (req, res) => {
  const key = req.params.key
  const voterId = getVoterId(req, res)
  res.json(getPollSummary(key, voterId))
})

app.post('/api/poll/vote', (req, res) => {
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
  if (dem?.id && dem?.name && rep?.id && rep?.name) {
    matchupMeta.set(key, {
      dem: { id: dem.id, name: dem.name },
      rep: { id: rep.id, name: rep.name },
    })
  }

  if (votes.has(voterId)) {
    return res.status(409).json({
      error: 'You already voted on this matchup.',
      ...getPollSummary(key, voterId),
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

  try {
    const prompt = buildInsightsPrompt(history)
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You analyze voting-preference signals carefully and neutrally.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
      }),
    })

    const payload = await response.json()
    if (!response.ok) {
      const errMsg = payload?.error?.message || `OpenRouter error (${response.status})`
      return res.status(502).json({ error: errMsg })
    }

    const summary = payload?.choices?.[0]?.message?.content?.trim()
    if (!summary) {
      return res.status(502).json({ error: 'OpenRouter returned an empty response.' })
    }

    res.json({ summary })
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
})
