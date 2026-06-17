/*
|--------------------------------------------------------------------------
| Telegram resolver — "create a room from a public Telegram post link"
|--------------------------------------------------------------------------
|
| A visitor pastes a link to a public channel post that contains a video,
| e.g. `https://t.me/SomeChannel/12345`. Telegram's public web preview for
| such a post embeds the video as a direct, tokenized CDN URL
| (`https://cdnN.telesco.pe/file/<hash>.mp4?token=…`) that anyone can fetch —
| no account, no bot token — and, unlike YouTube, Telegram's CDN does not
| bot-block datacenter IPs. So we fetch the post's `?embed=1` page, scrape the
| direct `.mp4` URL out of it, and hand that URL to the ordinary
| `startUrlDownload` pipeline, which downloads it into a normal file room.
|
| This only works for web-playable videos in PUBLIC channels. Large files
| posted as documents show only a "VIEW IN TELEGRAM" button with no direct URL,
| and private channels expose nothing — both surface as a clear error so no dead
| room is ever created.
|
| Nothing here is loaded unless a Telegram link is used; the resolved URL still
| goes through `video_downloader`'s per-hop SSRF checks before any bytes flow.
|
*/

/** Hosts a pasted link must be on to be treated as a Telegram post. */
const TELEGRAM_HOSTS = ['t.me', 'telegram.me']

/** A browser-ish UA — the public web preview is served to any client, but a
 * realistic UA is the safest against future tightening. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) WatchParty/1.0'

/**
 * Pulls the `channel` and message `id` out of a Telegram post URL, or null when
 * it is not a public single-post link. Rejects the private-channel form
 * (`/c/<internal>/<id>`) and the channel feed (`/s/<channel>`), neither of which
 * exposes a scrapeable direct video URL.
 */
function parsePost(raw: string): { channel: string; id: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!TELEGRAM_HOSTS.includes(host)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const id = parts[parts.length - 1]
  const channel = parts[parts.length - 2]
  // Numeric trailing id is the message number; `c` (private) and `s` (feed)
  // prefixes never resolve to a direct video.
  if (!/^\d+$/.test(id)) return null
  if (channel === 'c' || channel === 's') return null
  if (!/^[A-Za-z0-9_]+$/.test(channel)) return null
  return { channel, id }
}

/**
 * True when [raw] is a public Telegram channel post link. Used by the controller
 * to route a pasted download link to this resolver.
 */
export function isTelegramUrl(raw: string): boolean {
  return parsePost(raw) !== null
}

/**
 * Resolves a public Telegram post link to the direct video CDN URL embedded in
 * its web preview. Throws a human-readable error when the post is not a
 * web-playable video (document/large file, private channel, or no media).
 */
export async function resolveTelegramVideoUrl(raw: string): Promise<string> {
  const post = parsePost(raw)
  if (!post) {
    throw new Error('Paste a link to a public Telegram channel post, e.g. https://t.me/channel/123.')
  }

  const embedUrl = `https://t.me/${post.channel}/${post.id}?embed=1&mode=tme`

  let html: string
  try {
    const res = await fetch(embedUrl, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch {
    throw new Error('That Telegram post could not be opened.')
  }

  // The embed renders the video as <video><source src="https://cdnN.telesco.pe/
  // file/<hash>.mp4?token=…">. Grab the first such URL; the token query is a
  // single param so no `&` un-escaping is needed beyond `&amp;`.
  const match =
    /https:\/\/cdn\d*\.(?:telesco\.pe|cdn-telegram\.org)\/file\/[^"'\\ )]+\.mp4\?[^"'\\ )]+/.exec(
      html
    )
  if (!match) {
    throw new Error(
      'That Telegram post has no downloadable video. Large files shown as "VIEW IN TELEGRAM" can\'t be fetched.'
    )
  }

  return match[0].replace(/&amp;/g, '&')
}
