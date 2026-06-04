/**
 * Candidate portrait URLs (Wikipedia + fallback). Used in-app and on share cards.
 */

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
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`)
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
      pithumbsize: '500',
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
      pithumbsize: '500',
      format: 'json',
      origin: '*',
    })
    return await fetchImageFromParams(searchParams)
  } catch {
    return null
  }
}

/** Prefer client-cached URL, then Wikipedia, then generated avatar. */
export async function resolveCandidatePhotoUrl(name, hintUrl = null) {
  if (hintUrl) return hintUrl
  const wiki = await fetchWikiPhoto(name)
  if (wiki) return wiki
  return fallbackAvatarUrl(name)
}

const dataUriCache = new Map()

export async function loadImageAsDataUri(url) {
  if (!url) return null
  const cached = dataUriCache.get(url)
  if (cached) return cached

  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': '28match-share-card/1.0' },
  })
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`)

  const contentType = res.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())
  const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
  dataUriCache.set(url, dataUri)
  return dataUri
}