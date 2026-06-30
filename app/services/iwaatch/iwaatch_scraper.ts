/*
|------------------------------------------------------------------------------
| iwaatch scraper — ISOLATED, self-contained module (SERVER-SIDE)
|------------------------------------------------------------------------------
|
| A third "direct link" source, independent of the torrent/Cinemeta path and of
| the on-device topcinema scraper. Unlike topcinema (which the *phone* scrapes
| because the server's datacenter IP is blocked), iwaatch.com is the mirror
| image: the site is geo/DNS-blocked for the user but reachable from the server,
| so this scraper runs ON THE BACKEND and the client only ever calls our
| `/api/iwaatch/resolve` endpoint.
|
| iwaatch is a Next.js app. A movie lives at:
|   /movie/<slug-year>   — info page ("Watch Now" → /view, plus a Download button)
|   /view/<slug-year>    — the player page
| Because the page is server-rendered, the raw HTML the backend fetches embeds
| the player's data (Next `__NEXT_DATA__` / streamed RSC chunks), so the direct
| .mp4 / .m3u8 (and subtitle) links can be swept straight out of it — even though
| a browser only reveals them after client-side hydration.
|
| Series are "coming soon" on iwaatch, so only movies are supported here.
*/

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const BASE = 'https://iwaatch.com'

/** A site-shaped error so the controller can map it to a stable message key. */
export class IwaatchError extends Error {}

export interface IwaatchSource {
  /** `2160p` … `360p`, or `auto` when the url carries no resolution hint. */
  quality: string
  /** Human label shown in the picker (adds an `(HLS)` tag for m3u8). */
  label: string
  /** Direct, playable/downloadable url. */
  url: string
  /** `mp4` (a single downloadable file) or `hls` (an .m3u8 playlist). */
  kind: 'mp4' | 'hls'
  resolution: string | null
  /** A subtitle (.vtt/.srt) url found alongside the video, if any. */
  subtitle: string | null
}

export interface IwaatchResult {
  /** The resolved player/source page. */
  page: string
  sources: IwaatchSource[]
}

async function fetchText(
  url: string,
  referer?: string
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow',
    })
    return { status: res.status, body: await res.text() }
  } catch {
    return { status: 0, body: '' }
  }
}

/** Title/name → iwaatch url slug, e.g. `Back in Action 2025` → `back-in-action-2025`. */
function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Un-escapes JSON/RSC-encoded urls (`https:\/\/…`, `/`, `&`). */
function unescapeUrls(s: string): string {
  return s
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
}

/** Every direct video url embedded in the html, mapped to its kind. */
function mediaUrls(html: string): Map<string, 'mp4' | 'hls'> {
  const text = unescapeUrls(html)
  const out = new Map<string, 'mp4' | 'hls'>()
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+\.m3u8(?:\?[^\s"'`<>\\)]*)?/gi)) {
    out.set(m[0], 'hls')
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+\.mp4(?:\?[^\s"'`<>\\)]*)?/gi)) {
    out.set(m[0], 'mp4')
  }
  return out
}

function subtitleUrl(html: string): string | null {
  const text = unescapeUrls(html)
  return text.match(/https?:\/\/[^\s"'`<>\\)]+\.(?:vtt|srt)(?:\?[^\s"'`<>\\)]*)?/i)?.[0] ?? null
}

function qualityOf(url: string): { quality: string; resolution: string | null } {
  const m = url.match(/(2160|1440|1080|720|480|360)\s*p?\b/i)
  if (m) return { quality: `${m[1]}p`, resolution: null }
  if (/\b4k\b/i.test(url)) return { quality: '2160p', resolution: null }
  return { quality: 'auto', resolution: null }
}

const QUALITY_ORDER = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto']

function buildSources(urls: Map<string, 'mp4' | 'hls'>, subtitle: string | null): IwaatchSource[] {
  const sources: IwaatchSource[] = [...urls.entries()].map(([url, kind]) => {
    const { quality, resolution } = qualityOf(url)
    return {
      quality,
      label: kind === 'hls' ? `${quality} · HLS` : quality,
      url,
      kind,
      resolution,
      subtitle,
    }
  })
  sources.sort((a, b) => {
    const qa = QUALITY_ORDER.indexOf(a.quality)
    const qb = QUALITY_ORDER.indexOf(b.quality)
    if (qa !== qb) return qa - qb
    // Prefer a single downloadable mp4 over an HLS playlist at the same quality.
    return (a.kind === 'mp4' ? 0 : 1) - (b.kind === 'mp4' ? 0 : 1)
  })
  return sources
}

/** Sweeps a page (player or info) for media; follows one embed iframe if needed. */
async function sourcesFromPage(url: string): Promise<IwaatchSource[]> {
  const { status, body } = await fetchText(url, `${BASE}/`)
  if (status !== 200 || !body) return []

  let urls = mediaUrls(body)
  if (urls.size === 0) {
    // The player may be an embedded iframe — follow it one hop and sweep again.
    const iframe = unescapeUrls(body).match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]
    if (iframe) {
      const abs = iframe.startsWith('http')
        ? iframe
        : iframe.startsWith('//')
          ? `https:${iframe}`
          : `${BASE}${iframe.startsWith('/') ? '' : '/'}${iframe}`
      const r = await fetchText(abs, url)
      if (r.status === 200) urls = mediaUrls(r.body)
    }
  }
  return buildSources(urls, subtitleUrl(body))
}

/** A `/download/<slug>` route that 30x-redirects straight to a media file. */
async function sourceFromDownload(slug: string): Promise<IwaatchSource | null> {
  try {
    const res = await fetch(`${BASE}/download/${slug}`, {
      headers: { 'User-Agent': UA, Referer: `${BASE}/movie/${slug}` },
      redirect: 'follow',
    })
    const finalUrl = res.url
    const type = res.headers.get('content-type') ?? ''
    if (/\.(mp4|m3u8)(\?|$)/i.test(finalUrl) || /^video\//i.test(type)) {
      const kind: 'mp4' | 'hls' = /\.m3u8/i.test(finalUrl) ? 'hls' : 'mp4'
      const { quality, resolution } = qualityOf(finalUrl)
      return {
        quality,
        label: kind === 'hls' ? `${quality} · HLS` : quality,
        url: finalUrl,
        kind,
        resolution,
        subtitle: null,
      }
    }
  } catch {
    /* no download route here */
  }
  return null
}

/** Last resort: scan /explore for the closest `/movie/<slug>` to a title. */
async function findSlugViaExplore(slug: string): Promise<string | null> {
  const { body } = await fetchText(`${BASE}/explore`)
  if (!body) return null
  const tokens = slug.split('-').filter((t) => t.length > 1 && !/^\d{4}$/.test(t))
  if (tokens.length === 0) return null

  const candidates = new Set<string>()
  for (const m of unescapeUrls(body).matchAll(/\/movie\/([a-z0-9-]+)/gi)) candidates.add(m[1])

  let best: string | null = null
  let bestScore = 0
  for (const cand of candidates) {
    const score = tokens.filter((t) => cand.includes(t)).length
    if (score > bestScore) {
      bestScore = score
      best = cand
    }
  }
  return best && bestScore >= Math.ceil(tokens.length / 2) ? best : null
}

/**
 * Resolves a movie (by editable name/slug) to its direct sources.
 * Tries the player page, then the info page's `/view/` link, then a
 * `/download/` route, then an /explore fuzzy match.
 */
export async function resolveMovie(query: string): Promise<IwaatchResult> {
  const slug = slugify(query)
  if (!slug) throw new IwaatchError('iwaatch_not_found')

  const tried = new Set<string>()
  const attemptSlug = async (s: string): Promise<IwaatchResult | null> => {
    if (tried.has(s)) return null
    tried.add(s)

    const view = `${BASE}/view/${s}`
    const direct = await sourcesFromPage(view)
    if (direct.length) return { page: view, sources: direct }

    // Info page → discover its real /view/<slug> (slug may differ), then sweep.
    const info = await fetchText(`${BASE}/movie/${s}`)
    if (info.status === 200) {
      const linked = info.body.match(/\/view\/([a-z0-9-]+)/i)?.[1]
      if (linked && linked !== s) {
        const sources = await sourcesFromPage(`${BASE}/view/${linked}`)
        if (sources.length) return { page: `${BASE}/view/${linked}`, sources }
      }
      const onInfo = mediaUrls(info.body)
      if (onInfo.size) {
        return { page: `${BASE}/movie/${s}`, sources: buildSources(onInfo, subtitleUrl(info.body)) }
      }
    }

    const dl = await sourceFromDownload(s)
    if (dl) return { page: `${BASE}/download/${s}`, sources: [dl] }

    return null
  }

  const hit = await attemptSlug(slug)
  if (hit) return hit

  const exploreSlug = await findSlugViaExplore(slug)
  if (exploreSlug) {
    const viaExplore = await attemptSlug(exploreSlug)
    if (viaExplore) return viaExplore
  }

  throw new IwaatchError('iwaatch_not_found')
}
