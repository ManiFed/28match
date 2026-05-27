/**
 * Server-side image rendering for shareable cards.
 * Focused on cost control: aggressive caching + fast heuristics.
 */

import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

// Font cache (loaded once at startup / first render)
let interFontBuffer = null

async function loadInterFont() {
  if (interFontBuffer) return interFontBuffer

  const fontUrls = [
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-400-normal.woff',
    'https://unpkg.com/@fontsource/inter@5.0.18/files/inter-latin-400-normal.woff',
  ]

  for (const url of fontUrls) {
    try {
      const res = await fetch(url, { timeout: 8000 })
      if (res.ok) {
        interFontBuffer = await res.arrayBuffer()
        console.log('[render] Successfully loaded Inter font from', url)
        return interFontBuffer
      }
    } catch (e) {
      console.warn('[render] Font fetch failed for', url, e.message)
    }
  }

  console.error('[render] Failed to load any fonts. Profile cards may fail to render.')
  return null
}

// Preload font on module load (best effort)
loadInterFont()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '../.share-cache')

// In-memory LRU cache (fast path)
const memoryCache = new LRUCache({
  max: 200,                    // Keep last 200 renders in RAM
  ttl: 1000 * 60 * 60 * 6,     // 6 hours
  allowStale: false,
})

// Ensure cache directory exists
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  } catch {}
}

function createCacheKey(payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
  return hash
}

async function getCachedImage(key) {
  const mem = memoryCache.get(key)
  if (mem) return mem

  try {
    const filePath = path.join(CACHE_DIR, `${key}.png`)
    const data = await fs.readFile(filePath)
    memoryCache.set(key, data)
    return data
  } catch {
    return null
  }
}

async function saveCachedImage(key, buffer) {
  memoryCache.set(key, buffer)
  try {
    await ensureCacheDir()
    const filePath = path.join(CACHE_DIR, `${key}.png`)
    await fs.writeFile(filePath, buffer)
  } catch (err) {
    console.warn('[render] Failed to write cache file:', err.message)
  }
}

/**
 * Version A — "Heavy free-floating bubbles" style
 * Red/blue split background proportional to lean + lots of sized bubbles.
 * Placement uses a fast heuristic (not heavy simulation) to stay cheap.
 */

// Deterministic placement for consistent results across renders
function seededRandom(seed) {
  let x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

function layoutBubbles(bubbles, width, height, margin = 70) {
  if (!bubbles?.length) return []

  const positions = []
  const maxR = Math.min(width, height) * 0.165
  const minR = Math.min(width, height) * 0.042

  const sorted = [...bubbles].sort((a, b) => b.size - a.size)

  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]
    const r = minR + (maxR - minR) * Math.min(1, b.size)

    let placed = false
    let x = 0, y = 0
    let attempts = 0

    const angleStep = 0.65 + seededRandom(i) * 0.55
    const radiusGrowth = 24 + seededRandom(i + 90) * 9

    let radius = 55 + seededRandom(i + 180) * 35
    let angle = seededRandom(i + 40) * Math.PI * 2

    while (attempts < 55 && !placed) {
      x = width / 2 + Math.cos(angle) * radius
      y = height / 2 + Math.sin(angle) * radius * 0.78

      const headerBuffer = 155

      if (
        x - r > margin &&
        x + r < width - margin &&
        y - r > margin + headerBuffer &&
        y + r < height - margin - 30
      ) {
        let collides = false
        for (const p of positions) {
          const dx = x - p.x
          const dy = y - p.y
          if (Math.sqrt(dx * dx + dy * dy) < p.r + r + 5) {
            collides = true
            break
          }
        }

        if (!collides) {
          positions.push({ x, y, r, name: b.name })
          placed = true
        }
      }

      angle += angleStep
      radius += radiusGrowth
      attempts++
    }

    if (!placed) {
      // Fallback grid-ish placement
      const col = i % 6
      const row = Math.floor(i / 6)
      positions.push({
        x: 140 + col * 165,
        y: 240 + row * 105,
        r: r * 0.82,
        name: b.name,
      })
    }
  }

  return positions
}

export async function renderProfileCard(payload) {
  const key = createCacheKey({ type: 'profile-v1', ...payload })

  const cached = await getCachedImage(key)
  if (cached) {
    return { buffer: cached, cached: true }
  }

  const { archetype, lean, bubbles = [] } = payload
  const demPct = Math.round(lean?.demPct ?? 50)
  const repPct = Math.round(lean?.repPct ?? 50)

  const positioned = layoutBubbles(bubbles, 1200, 630)

  // Ensure font is loaded (in case first request is very fast)
  if (!interFontBuffer) {
    await loadInterFont()
  }

  const bubbleEls = positioned.map((b, i) => {
    const isBig = b.r > 52
    const fs = isBig ? 15.5 : b.r > 38 ? 13.5 : 11.5

    return {
      type: 'div',
      props: {
        key: i,
        style: {
          position: 'absolute',
          left: b.x - b.r,
          top: b.y - b.r,
          width: b.r * 2,
          height: b.r * 2,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.94)',
          border: '2.5px solid rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
          overflow: 'hidden',
        },
        children: {
          type: 'div',
          props: {
            style: {
              fontSize: fs,
              fontWeight: 700,
              color: '#111',
              textAlign: 'center',
              padding: '0 8px',
              lineHeight: 1.05,
              maxWidth: '94%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            children: b.name,
          },
        },
      },
    }
  })

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: 1200,
          height: 630,
          position: 'relative',
          background: '#0c0c0e',
          overflow: 'hidden',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        },
        children: [
          // Red / Blue split background
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                inset: 0,
                background: `linear-gradient(138deg, #0a274f 0%, #0a274f ${demPct * 0.78}%, #3a1616 ${demPct * 0.78 + 9}%, #3a1616 100%)`,
              },
            },
          },

          // Subtle vignette / texture
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                inset: 0,
                background: 'radial-gradient(circle at 28% 18%, rgba(255,255,255,0.04) 0%, transparent 55%)',
              },
            },
          },

          // Header block
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                padding: '28px 52px 0',
                zIndex: 20,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: 21,
                      fontWeight: 700,
                      letterSpacing: '4px',
                      color: 'rgba(255,255,255,0.7)',
                      marginBottom: 6,
                    },
                    children: '28MATCH',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: 56,
                      fontWeight: 800,
                      color: '#fff',
                      textAlign: 'center',
                      lineHeight: 1.02,
                      marginBottom: 8,
                      textShadow: '0 4px 14px rgba(0,0,0,0.5)',
                    },
                    children: archetype?.name || 'Your Voter Pattern',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: 18.5,
                      color: 'rgba(255,255,255,0.92)',
                      textAlign: 'center',
                      maxWidth: 820,
                      lineHeight: 1.28,
                    },
                    children: archetype?.description || 'Your votes tell a story.',
                  },
                },
              ],
            },
          },

          // Bubbles layer
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                inset: 0,
                zIndex: 10,
              },
              children: bubbleEls,
            },
          },

          // Bottom lean label
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute',
                bottom: 18,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 15,
                color: 'rgba(255,255,255,0.6)',
                zIndex: 30,
                letterSpacing: '0.5px',
              },
              children: `${demPct}% Democratic  •  ${repPct}% Republican`,
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: interFontBuffer
        ? [
            {
              name: 'Inter',
              data: new Uint8Array(interFontBuffer),
              weight: 400,
              style: 'normal',
            },
            {
              name: 'Inter',
              data: new Uint8Array(interFontBuffer),
              weight: 700,
              style: 'normal',
            },
          ]
        : [],
    }
  )

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
  const pngData = resvg.render()
  const buffer = pngData.asPng()

  await saveCachedImage(key, buffer)

  return { buffer, cached: false }
}
