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
  headerBottom: 228,
  stageMarginX: 24,
  stageMarginBottom: 20,
  partyGutter: 18,
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

function getPartisanSplitX(demPct) {
  const split = Math.max(14, Math.min(86, demPct))
  return CARD.width * (split / 100)
}

function getPartyZones(stage, demPct) {
  const splitX = getPartisanSplitX(demPct)
  const halfGutter = LAYOUT.partyGutter / 2

  const dem = {
    x: stage.x,
    y: stage.y,
    width: splitX - stage.x - halfGutter,
    height: stage.height,
    cx: stage.x + (splitX - stage.x - halfGutter) / 2,
    cy: stage.cy,
  }

  const repX = splitX + halfGutter
  const rep = {
    x: repX,
    y: stage.y,
    width: stage.x + stage.width - repX,
    height: stage.height,
    cx: repX + (stage.x + stage.width - repX) / 2,
    cy: stage.cy,
  }

  return { dem, rep }
}

const BUBBLE_GAP = 14

function collides(x, y, r, placed, gap = BUBBLE_GAP) {
  for (const p of placed) {
    if (Math.hypot(x - p.x, y - p.y) < p.r + r + gap) return true
  }
  return false
}

function fitsZone(x, y, r, zone, inset = 10) {
  return (
    x - r >= zone.x + inset &&
    x + r <= zone.x + zone.width - inset &&
    y - r >= zone.y + inset &&
    y + r <= zone.y + zone.height - inset
  )
}

function clampBubbleToZone(p, zone, inset = 10) {
  const minX = zone.x + inset + p.r
  const maxX = zone.x + zone.width - inset - p.r
  const minY = zone.y + inset + p.r
  const maxY = zone.y + zone.height - inset - p.r
  return {
    ...p,
    x: Math.min(maxX, Math.max(minX, p.x)),
    y: Math.min(maxY, Math.max(minY, p.y)),
  }
}

function hasOverlaps(placed, gap = BUBBLE_GAP) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + gap - 0.5) return true
    }
  }
  return false
}

/** Push overlapping circles apart while keeping them inside the zone. */
function resolveOverlaps(placed, zone, gap = BUBBLE_GAP) {
  if (placed.length < 2) return placed.map((p) => clampBubbleToZone(p, zone))

  let items = placed.map((p) => ({ ...p }))

  for (let iter = 0; iter < 100; iter++) {
    let moved = false

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 0.001
        const minDist = a.r + b.r + gap
        const overlap = minDist - dist

        if (overlap > 0) {
          const push = overlap / 2 + 0.5
          const ux = dx / dist
          const uy = dy / dist
          a.x -= ux * push
          a.y -= uy * push
          b.x += ux * push
          b.y += uy * push
          moved = true
        }
      }
    }

    items = items.map((p) => clampBubbleToZone(p, zone))

    if (!moved) break
  }

  return items
}

function fitClusterToZone(placed, zone) {
  if (!placed.length) return placed

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r)
    maxX = Math.max(maxX, p.x + p.r)
    minY = Math.min(minY, p.y - p.r)
    maxY = Math.max(maxY, p.y + p.r)
  }

  const boxW = Math.max(1, maxX - minX)
  const boxH = Math.max(1, maxY - minY)
  const pad = 16
  // Only scale down — upscaling was causing heavy overlap
  const scale = Math.min(
    (zone.width - pad * 2) / boxW,
    (zone.height - pad * 2) / boxH,
    1,
  )

  const boxCx = (minX + maxX) / 2
  const boxCy = (minY + maxY) / 2

  let scaled = placed.map((p) => ({
    ...p,
    r: p.r * scale,
    x: zone.cx + (p.x - boxCx) * scale,
    y: zone.cy + (p.y - boxCy) * scale,
  }))

  scaled = resolveOverlaps(scaled, zone)

  if (hasOverlaps(scaled)) {
    const shrink = 0.92
    scaled = scaled.map((p) => ({
      ...p,
      r: p.r * shrink,
      x: zone.cx + (p.x - zone.cx) * shrink,
      y: zone.cy + (p.y - zone.cy) * shrink,
    }))
    scaled = resolveOverlaps(scaled, zone)
  }

  return scaled
}

function tangentCandidates(placed, r, zone, gap = BUBBLE_GAP) {
  const candidates = [{ x: zone.cx, y: zone.cy }]

  for (const p of placed) {
    const orbit = p.r + r + gap
    for (let i = 0; i < 20; i++) {
      const angle = (i / 20) * Math.PI * 2
      candidates.push({
        x: p.x + Math.cos(angle) * orbit,
        y: p.y + Math.sin(angle) * orbit,
      })
    }
  }

  return candidates
}

function packFreeFormInZone(items, zone) {
  if (!items.length) return []

  const sorted = [...items].sort((a, b) => b.size - a.size)
  const countFactor = Math.max(0.72, 1 - Math.max(0, sorted.length - 4) * 0.045)
  const maxR = Math.min(zone.width, zone.height) * 0.3 * countFactor
  const minR = Math.min(zone.width, zone.height) * 0.09 * countFactor
  const placed = []

  for (let bi = 0; bi < sorted.length; bi++) {
    const b = sorted[bi]
    const r = minR + (maxR - minR) * b.size
    let best = null
    let bestScore = -Infinity

    const candidates = [
      ...tangentCandidates(placed, r, zone),
    ]

    const step = Math.max(20, Math.min(zone.width, zone.height) / 6)
    for (let y = zone.y + r; y <= zone.y + zone.height - r; y += step) {
      for (let x = zone.x + r; x <= zone.x + zone.width - r; x += step) {
        candidates.push({ x, y })
      }
    }

    for (const { x, y } of candidates) {
      if (!fitsZone(x, y, r, zone)) continue
      if (collides(x, y, r, placed)) continue

      let minGap = Infinity
      for (const p of placed) {
        minGap = Math.min(minGap, Math.hypot(x - p.x, y - p.y) - (r + p.r))
      }

      const centerPull = -Math.hypot(x - zone.cx, y - zone.cy) * 0.08
      const gapScore = placed.length ? minGap : BUBBLE_GAP + 20
      const score = gapScore + centerPull

      if (score > bestScore) {
        bestScore = score
        best = {
          x,
          y,
          r,
          name: b.name,
          party: b.party,
          size: b.size,
          photoDataUri: b.photoDataUri || null,
          photoUrl: b.photoUrl || null,
        }
      }
    }

    if (best) {
      placed.push(best)
      continue
    }

    for (let shrink = 0.88; shrink >= 0.55; shrink -= 0.06) {
      const rSmall = r * shrink
      const retry = tangentCandidates(placed, rSmall, zone)
      for (const { x, y } of retry) {
        if (!fitsZone(x, y, rSmall, zone)) continue
        if (collides(x, y, rSmall, placed)) continue
        placed.push({
          x,
          y,
          r: rSmall,
          name: b.name,
          party: b.party,
          size: b.size,
          photoDataUri: b.photoDataUri || null,
          photoUrl: b.photoUrl || null,
        })
        break
      }
      if (placed[placed.length - 1]?.name === b.name) break
    }
  }

  return fitClusterToZone(placed, zone)
}

/** Dem bubbles on blue (left), Rep bubbles on red (right); free-form pack per side. */
function layoutBubbles(bubbles, stage, demPct) {
  if (!bubbles?.length) return []

  const zones = getPartyZones(stage, demPct)
  const dems = bubbles.filter((b) => b.party === 'dem')
  const reps = bubbles.filter((b) => b.party === 'rep')
  const other = bubbles.filter((b) => b.party !== 'dem' && b.party !== 'rep')

  const placed = [
    ...packFreeFormInZone(dems, zones.dem),
    ...packFreeFormInZone(reps, zones.rep),
    ...packFreeFormInZone(other, stage),
  ]

  return enforcePartySide(placed, demPct)
}

function enforcePartySide(placed, demPct) {
  const splitX = getPartisanSplitX(demPct)
  const buffer = 10

  return placed.map((p) => {
    if (p.party === 'dem') {
      const maxCenter = splitX - buffer - p.r
      if (p.x > maxCenter) return { ...p, x: maxCenter }
    }
    if (p.party === 'rep') {
      const minCenter = splitX + buffer + p.r
      if (p.x < minCenter) return { ...p, x: minCenter }
    }
    return p
  })
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
  const split = Math.max(14, Math.min(86, demPct))
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
        boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
      },
      children: face,
    })
  })
}

export async function renderProfileCard(payload) {
  const key = createCacheKey({ type: 'profile-v9', ...payload })

  const cached = await getCachedImage(key)
  if (cached) {
    return { buffer: cached, cached: true }
  }

  const { archetype, lean, bubbles = [] } = payload
  const demPct = Math.round(lean?.demPct ?? 50)

  if (!interFontBuffer) await loadInterFont()

  const stage = getStageBounds()
  const positioned = layoutBubbles(bubbles, stage, demPct)
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
          height: LAYOUT.headerBottom + 32,
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