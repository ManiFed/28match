/**
 * Candidate portrait URLs (Wikipedia + fallback). Used in-app and on share cards.
 */

const WIKI_USER_AGENT = '28match/1.0 (share-card; contact: hello@28match.app)'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function fallbackAvatarUrl(name) {
  const params = new URLSearchParams({
    seed: name,
    backgroundType: 'gradientLinear',
    size: '256',
  })
  return `https://api.dicebear.com/9.x/initials/png?${params.toString()}`
}

export async function fetchWikiPhoto(name) {
  const fetchImageFromParams = async (params) => {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': WIKI_USER_AGENT },
    })
    if (!res.ok) return null
    const data = await res.json()
    const pages = Object.values(data?.query?.pages || {})
    const page = pages.find(
      (p) => !p?.missing && !p?.pageprops?.disambiguation && p?.thumbnail?.source,
    )
    return page?.thumbnail?.source ?? null
  }

  try {
    const exactMatchParams = new URLSearchParams({
      action: 'query',
      titles: name,
      redirects: '1',
      prop: 'pageimages|pageprops',
      pithumbsize: '320',
      format: 'json',
      origin: '*',
    })
    const exactImage = await fetchImageFromParams(exactMatchParams)
    if (exactImage) return exactImage

    const searchParams = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `${name} politician`,
      gsrlimit: '5',
      gsrenablerewrites: '1',
      prop: 'pageimages|pageprops',
      pithumbsize: '320',
      format: 'json',
      origin: '*',
    })
    return await fetchImageFromParams(searchParams)
  } catch {
    return null
  }
}

export async function urlToDataUri(url) {
  if (!url) return null

  const res = await fetch(url, {
    headers: url.includes('wikimedia') ? { 'User-Agent': WIKI_USER_AGENT } : {},
  })
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`)

  const blob = await res.blob()
  const type = blob.type || 'image/jpeg'

  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  const buffer = Buffer.from(await blob.arrayBuffer())
  return `data:${type};base64,${buffer.toString('base64')}`
}

/** Embed portrait as base64 for share-card render (avoids server-side Wikimedia rate limits). */
export async function embedPhotoDataUri(name, hintUrl = null) {
  let url = hintUrl || (await fetchWikiPhoto(name))
  if (!url) url = fallbackAvatarUrl(name)

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await urlToDataUri(url)
    } catch {
      if (url.includes('wikimedia')) {
        await sleep(180 * (attempt + 1))
        continue
      }
      if (!url.includes('dicebear')) {
        url = fallbackAvatarUrl(name)
        continue
      }
      return null
    }
  }
  return null
}

export async function embedShareBubblePhotos(bubbles, photoHints = {}) {
  if (!bubbles.length) return []

  const concurrency = 4
  const results = new Array(bubbles.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < bubbles.length) {
      const i = nextIndex++
      const bubble = bubbles[i]
      const photoDataUri = await embedPhotoDataUri(
        bubble.name,
        photoHints[bubble.name] || null,
      )
      results[i] = { ...bubble, photoDataUri: photoDataUri || null }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, bubbles.length) }, worker))
  return results
}

const dataUriCache = new Map()

export async function loadImageAsDataUri(url) {
  if (!url) return null
  if (url.startsWith('data:')) return url

  const cached = dataUriCache.get(url)
  if (cached) return cached

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: url.includes('wikimedia') ? { 'User-Agent': WIKI_USER_AGENT } : {},
      })
      if (res.status === 429) {
        await sleep(500 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new Error(`Image fetch failed (${res.status})`)

      const contentType = res.headers.get('content-type') || 'image/jpeg'
      const buffer = Buffer.from(await res.arrayBuffer())
      const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
      dataUriCache.set(url, dataUri)
      return dataUri
    } catch (err) {
      if (attempt === 3) throw err
      await sleep(400 * (attempt + 1))
    }
  }
  return null
}

export async function resolveCandidatePhotoUrl(name, hintUrl = null) {
  if (hintUrl) return hintUrl
  const wiki = await fetchWikiPhoto(name)
  if (wiki) return wiki
  return fallbackAvatarUrl(name)
}