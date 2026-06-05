/**
 * Social share helpers for the voter profile card.
 */

export function buildProfileShareTweet(archetype, pageUrl) {
  const origin =
    pageUrl || (typeof window !== 'undefined' ? window.location.origin : 'https://28match.app')
  const name = archetype?.name || 'My 2028 voter profile'
  const description = archetype?.description || ''
  return `${name} — my 2028 voter profile on 28match.\n\n${description}\n\n${origin}`
}

export function openTwitterShareIntent(text) {
  const params = new URLSearchParams({ text })
  window.open(
    `https://twitter.com/intent/tweet?${params.toString()}`,
    '_blank',
    'noopener,noreferrer,width=600,height=720',
  )
}

/**
 * Share card on X/Twitter. Uses native share with image when available.
 */
export async function shareProfileOnTwitter(archetype, imageBlob) {
  const text = buildProfileShareTweet(archetype)
  const file = new File([imageBlob], '28match-profile.png', { type: 'image/png' })

  if (navigator.share) {
    try {
      if (!navigator.canShare || navigator.canShare({ files: [file], text })) {
        await navigator.share({ text, files: [file] })
        return { method: 'native' }
      }
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' }
    }
  }

  openTwitterShareIntent(
    `${text}\n\nTip: download your profile card image and attach it to the post.`,
  )
  return { method: 'intent' }
}