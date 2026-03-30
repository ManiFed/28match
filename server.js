import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000
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
  const { key, side } = req.body || {}
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

  res.json(getPollSummary(key, voterId))
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
