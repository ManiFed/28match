/**
 * Server-side image rendering for shareable profile cards.
 */

import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { LRUCache } from 'lru-cache'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  resolveCandidatePhotoUrl,
  loadImageAsDataUri,
  fallbackAvatarUrl,
} from '../src/lib/candidatePhoto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '../.share-cache')


const CARD = { width: 1200, height: 630 }

const COLORS = {
  dem: '#1e5a9e',
  demDeep: '#0f3468',
  rep: '#a83232',
  repDeep: '#6b1818',
  headerFade: 'linear-gradient(180deg, rgba(6,8,14,0.92) 0%, rgba(6,8,14,0.55) 55%, rgba(6,8,14,0) 100%)',
  bubbleDemBg: '#dce8ff',
  bubbleDemBorder: '#3d6eb8',
  bubbleDemText: '#0f2848',
  bubbleRepBg: '#ffe0e0',
  bubbleRepBorder: '#b84a4a',
  bubbleRepText: '#4a1010',
}

const LAYOUT = {
  paddingX: 48,
  logoWidth: 220,
  logoHeight: 44,
  headerTop: 22,
  titleSize: 52,
  descSize: 17,
  descMaxWidth: 900,
  headerBottom: 198,
  stageMarginX: 28,
  stageMarginBottom: 22,
}

let interFontBuffer = null
async function loadInterFont() {
  if (interFontBuffer) return interFontBuffer

  const fontUrls = [
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-400-normal.woff',
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-700-normal.woff',
    'https://unpkg.com/@fontsource/inter@5.0.18/files/inter-latin-400-normal.woff',
  ]

  for (const url of fontUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        interFontBuffer = await res.arrayBuffer()
        console.log('[render] Loaded Inter font from', url)
        return interFontBuffer
      }
    } catch (e) {
      console.warn('[render] Font fetch failed for', url, e.message)
    }
  }

  console.error('[render] Failed to load fonts; cards may fail to render.')
  return null
}

loadInterFont()

const memoryCache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 60 * 6,
  allowStale: false,
})

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true })
  } catch {}
}

function createCacheKey(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
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
    await fs.writeFile(path.join(CACHE_DIR, `${key}.png`), buffer)
  } catch (err) {
    console.warn('[render] Failed to write cache file:', err.message)
  }
}

function getStageBounds() {
  const x = LAYOUT.stageMarginX
  const y = LAYOUT.headerBottom
  const width = CARD.width - LAYOUT.stageMarginX * 2
  const height = CARD.height - y - LAYOUT.stageMarginBottom
  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 }
}

/**
 * Grid across the full bubble stage so portraits spread wide (not a diagonal chain).
 */
function layoutBubbles(bubbles, stage) {
  if (!bubbles?.length) return []

  const sorted = [...bubbles].sort((a, b) => b.size - a.size)
  const n = sorted.length
  const aspect = stage.width / Math.max(stage.height, 1)

  let cols = Math.ceil(Math.sqrt(n * aspect))
  cols = Math.max(2, Math.min(cols, n))
  const rows = Math.ceil(n / cols)

  const cellW = stage.width / cols
  const cellH = stage.height / rows
  const pad = 8
  const placed = []

  for (let i = 0; i < n; i++) {
    const b = sorted[i]
    const row = Math.floor(i / cols)
    const colInRow = i - row * cols
    const itemsInRow = Math.min(cols, n - row * cols)
    const rowOffset = (cols - itemsInRow) / 2

    const r = Math.min(cellW, cellH) * (0.24 + 0.68 * b.size) - pad
    const x = stage.x + cellW * (colInRow + rowOffset + 0.5)
    const y = stage.y + cellH * (row + 0.5)

    placed.push({
      x,
      y,
      r: Math.max(r, 28),
      name: b.name,
      party: b.party,
      size: b.size,
      photoDataUri: b.photoDataUri || null,
      photoUrl: b.photoUrl || null,
    })
  }

  return placed
}

function bubbleStyle(party) {
  if (party === 'rep') {
    return {
      background: COLORS.bubbleRepBg,
      border: `2.5px solid ${COLORS.bubbleRepBorder}`,
      color: COLORS.bubbleRepText,
    }
  }
  return {
    background: COLORS.bubbleDemBg,
    border: `2.5px solid ${COLORS.bubbleDemBorder}`,
    color: COLORS.bubbleDemText,
  }
}

function el(type, props, children) {
  if (children === undefined) {
    return { type, props: props || {} }
  }
  return { type, props: props || {}, children }
}

function buildPartisanBackground(demPct) {
  const split = Math.max(10, Math.min(90, demPct))
  return el('div', {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: CARD.width,
      height: CARD.height,
      background: `linear-gradient(90deg, ${COLORS.demDeep} 0%, ${COLORS.dem} ${split - 2}%, ${COLORS.rep} ${split + 2}%, ${COLORS.repDeep} 100%)`,
    },
  })
}

function buildHeader(archetype) {
  const children = []

  children.push(
    el('div', {
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'baseline',
        marginBottom: 14,
      },
      children: [
        el('div', {
          style: {
            fontSize: 34,
            fontWeight: 800,
            color: '#ffffff',
            letterSpacing: '-1px',
            marginRight: 6,
          },
          children: '28',
        }),
        el('div', {
          style: {
            fontSize: 34,
            fontWeight: 700,
            color: 'rgba(255,255,255,0.9)',
            letterSpacing: '4px',
          },
          children: 'MATCH',
        }),
      ],
    }),
  )

  children.push(
    el('div', {
      style: {
        fontSize: LAYOUT.titleSize,
        fontWeight: 800,
        color: '#ffffff',
        textAlign: 'center',
        lineHeight: 1.05,
        marginBottom: 10,
        maxWidth: LAYOUT.descMaxWidth,
        textShadow: '0 3px 16px rgba(0,0,0,0.55)',
      },
      children: archetype?.name || 'Your Voter Profile',
    }),
    el('div', {
      style: {
        fontSize: LAYOUT.descSize,
        fontWeight: 400,
        color: 'rgba(255,255,255,0.94)',
        textAlign: 'center',
        lineHeight: 1.35,
        maxWidth: LAYOUT.descMaxWidth,
        paddingLeft: 24,
        paddingRight: 24,
      },
      children: archetype?.description || 'Your matchup votes reveal how you see the 2028 field.',
    }),
  )

  return el('div', {
    style: {
      position: 'absolute',
      top: LAYOUT.headerTop,
      left: LAYOUT.paddingX,
      right: LAYOUT.paddingX,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    },
    children,
  })
}

async function resolveBubblePhotoDataUri(b) {
  if (b.photoDataUri) return b.photoDataUri
  try {
    const url = await resolveCandidatePhotoUrl(b.name, b.photoUrl || null)
    return await loadImageAsDataUri(url)
  } catch {
    try {
      return await loadImageAsDataUri(fallbackAvatarUrl(b.name))
    } catch {
      return null
    }
  }
}

async function buildBubbleElements(positioned) {
  const photoUris = []
  for (const b of positioned) {
    photoUris.push(await resolveBubblePhotoDataUri(b))
  }

  return positioned.map((b, i) => {
    const styles = bubbleStyle(b.party)
    const diameter = Math.round(b.r * 2)
    const photoSrc = photoUris[i]

    const face = photoSrc
      ? el('img', {
          src: photoSrc,
          width: diameter,
          height: diameter,
          style: {
            width: diameter,
            height: diameter,
            objectFit: 'cover',
          },
        })
      : el('div', {
          style: {
            width: diameter,
            height: diameter,
            background: styles.background,
          },
        })

    return el('div', {
      key: i,
      style: {
        position: 'absolute',
        left: b.x - b.r,
        top: b.y - b.r,
        width: diameter,
        height: diameter,
        borderRadius: 9999,
        overflow: 'hidden',
        border: styles.border,
        display: 'flex',
        boxShadow: '0 6px 22px rgba(0,0,0,0.35)',
      },
      children: face,
    })
  })
}

export async function renderProfileCard(payload) {
  const key = createCacheKey({ type: 'profile-v7', ...payload })

  const cached = await getCachedImage(key)
  if (cached) {
    return { buffer: cached, cached: true }
  }

  const { archetype, lean, bubbles = [] } = payload
  const demPct = Math.round(lean?.demPct ?? 50)

  if (!interFontBuffer) await loadInterFont()

  const stage = getStageBounds()
  const positioned = layoutBubbles(bubbles, stage)
  const bubbleEls = await buildBubbleElements(positioned)

  const tree = el('div', {
    style: {
      width: CARD.width,
      height: CARD.height,
      position: 'relative',
      display: 'flex',
      overflow: 'hidden',
      fontFamily: 'Inter',
    },
    children: [
      buildPartisanBackground(demPct),
      el('div', {
        style: {
          position: 'absolute',
          top: 0,
          left: 0,
          width: CARD.width,
          height: LAYOUT.headerBottom + 24,
          background: COLORS.headerFade,
        },
      }),
      el('div', {
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
        },
        children: bubbleEls,
      }),
      buildHeader(archetype),
    ],
  })

  const fonts = interFontBuffer
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
    : []

  const svg = await satori(tree, {
    width: CARD.width,
    height: CARD.height,
    fonts,
  })

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CARD.width } })
  const buffer = resvg.render().asPng()

  await saveCachedImage(key, buffer)

  return { buffer, cached: false }
}