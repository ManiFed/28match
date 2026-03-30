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
  }

  votes.set(voterId, side)
  matchupVotes.set(key, votes)

  const votedCandidate = side === 'dem' ? dem : rep
  applyCandidateVoteDelta(side, votedCandidate, 1)

  const poll = getPollSummary(key, voterId)
  res.json({ key, ...poll, totalVotes: poll.demVotes + poll.repVotes })
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
