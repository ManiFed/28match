import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000
const matchupPolls = new Map()

app.use(express.json())

app.get('/api/poll/:key', (req, res) => {
  const key = req.params.key
  const poll = matchupPolls.get(key) || { demVotes: 0, repVotes: 0 }
  res.json({ key, ...poll, totalVotes: poll.demVotes + poll.repVotes })
})

app.post('/api/poll/vote', (req, res) => {
  const { key, side } = req.body || {}
  if (!key || (side !== 'dem' && side !== 'rep')) {
    return res.status(400).json({ error: 'Invalid vote payload.' })
  }

  const poll = matchupPolls.get(key) || { demVotes: 0, repVotes: 0 }
  if (side === 'dem') poll.demVotes += 1
  if (side === 'rep') poll.repVotes += 1
  matchupPolls.set(key, poll)

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
