import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000
const matchupPolls = new Map()
const candidateVoteTotals = new Map()
const matchupVotes = new Map()

app.use(express.json())

function getVoterId(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown-ip'
  const ua = req.get('user-agent') || 'unknown-ua'
  return `${ip}::${ua}`
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

app.get('/api/poll/:key', (req, res) => {
  const key = req.params.key
  const voterId = getVoterId(req)
  res.json(getPollSummary(key, voterId))
})

app.post('/api/poll/vote', (req, res) => {
  const { key, side, dem, rep } = req.body || {}
  if (!key || (side !== 'dem' && side !== 'rep')) {
    return res.status(400).json({ error: 'Invalid vote payload.' })
  }

  const voterId = getVoterId(req)
  const votes = matchupVotes.get(key) || new Map()

  if (votes.has(voterId)) {
    return res.status(409).json({
      error: 'You already voted on this matchup.',
      ...getPollSummary(key, voterId),
    })
  }

  votes.set(voterId, side)
  matchupVotes.set(key, votes)

  const votedCandidate = side === 'dem' ? dem : rep
  if (votedCandidate?.id && votedCandidate?.name) {
    const candidateKey = `${side}:${votedCandidate.id}`
    const existing = candidateVoteTotals.get(candidateKey) || {
      id: votedCandidate.id,
      name: votedCandidate.name,
      party: side,
      votes: 0,
    }
    existing.votes += 1
    candidateVoteTotals.set(candidateKey, existing)
  }

  res.json({ key, ...poll, totalVotes: poll.demVotes + poll.repVotes })
})

app.get('/api/poll/leaderboard', (_req, res) => {
  const leaderboard = [...candidateVoteTotals.values()]
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))

  res.json({
    totalVotes: leaderboard.reduce((sum, entry) => sum + entry.votes, 0),
    leaderboard,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
