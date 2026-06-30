/*
|------------------------------------------------------------------------------
| TopCinema scraper — ISOLATED, self-contained module
|------------------------------------------------------------------------------
|
| A completely separate "second way" of sourcing a title, independent of the
| torrent/Cinemeta path. It walks the TopCinema site exactly as a browser would
| and returns direct, downloadable MP4 links resolved from its vidtube file host.
|
| The site base(s) and the vidtube file-host base(s) come from `.env`
| (`TOPCINEMA_BASE`/`TOPCINEMA_VIDTUBE_BASE`) — no link is hard-coded here. The
| site moves constantly, BOTH across subdomains (web4 → web5 → …) AND across whole
| registrable domains (topcinema.fan ↔ topcinemaa.com ↔ …), so each is a
| COMMA-SEPARATED list of mirrors: entry points are tried on each mirror until one
| answers, and every link regex matches any subdomain of any configured domain.
|
| Series are driven by the SITE'S OWN html (not Cinemeta), because episode urls
| are irregular (e.g. the finale is `…الحلقة-10-والاخيرة-مترجمة`) and can't be
| safely constructed:
|
|   /series/مسلسل-<slug>-الموسم-الاول-مترجم/   → seasons list + that season's episodes
|   <episode page>/download/                   → the vidtube `/d/<id>.html` host link
|   vidtube /d/<id>.html                       → quality variants (_x _h _n _l)
|   vidtube /d/<id>_<q>                        → the final tokenized CDN .mp4 url
|
| The CDN links are open (HTTP 206 range, no auth/referer) and valid ~24h, so
| they drop straight into the existing `download` room flow. Nothing here
| imports or mutates any existing service — it is intentionally standalone.
|
| NOTE: TopCinema blocks the server's datacentre IP. An outbound proxy is meant
| for exactly this (`TOPCINEMA_PROXY_URL`); wiring it into `fetch` needs the
| `undici` package (`setGlobalDispatcher(new ProxyAgent(url))`), which is not yet
| a dependency — until it is, scraping only works from an allowed IP.
*/

import env from '#start/env'

/** A browser User-Agent — the site 403s the default Node/bot agent. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Bound every request so a hung host can't block the resolver indefinitely. */
const REQUEST_TIMEOUT_MS = 25_000

/** Splits a comma-separated env list of base URLs into trimmed, slash-stripped origins. */
function parseBases(value: string): string[] {
  return value
    .split(',')
    .map((b) => b.trim().replace(/\/+$/, ''))
    .filter((b) => b.length > 0)
}

/** Registrable domain of a base URL's host (drops the leading subdomain label). */
function domainOf(baseUrl: string): string {
  const labels = new URL(baseUrl).host.split('.')
  return labels.length > 2 ? labels.slice(1).join('.') : labels.join('.')
}

/** Origin of a url, or null if it can't be parsed. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A regex fragment matching ANY configured domain plus any subdomain of each. */
function hostAlternation(bases: string[]): string {
  const domains = [...new Set(bases.map(domainOf))]
  const alt = domains.map((d) => d.replace(/\./g, '\\.')).join('|')
  return `(?:[a-z0-9-]+\\.)*(?:${alt})`
}

/** TopCinema mirror bases (primary first) + the vidtube file-host bases. */
const BASES = parseBases(env.get('TOPCINEMA_BASE'))
const PRIMARY_BASE = BASES[0]
const VIDTUBE_BASES = parseBases(env.get('TOPCINEMA_VIDTUBE_BASE'))

/** All site links on a page (any subdomain of any configured TopCinema domain). */
const SITE_LINK_RE = new RegExp(`href="(https?://${hostAlternation(BASES)}/[^"]+)"`, 'g')
/** A vidtube `/d/<id>.html` link, optionally tagged as the recommended proServer. */
const VIDTUBE_HTML_RE = new RegExp(`href="(https?://${hostAlternation(VIDTUBE_BASES)}/d/[^"]+\\.html)"`, 'i')
const VIDTUBE_PRO_RE = new RegExp(
  `href="(https?://${hostAlternation(VIDTUBE_BASES)}/d/[^"]+\\.html)"[^>]*class="[^"]*proServer`,
  'i'
)

/** Arabic season ordinals as they appear in the url (الموسم الاول … العاشر). */
const ORDINALS = [
  '',
  'الاول',
  'الثاني',
  'الثالث',
  'الرابع',
  'الخامس',
  'السادس',
  'السابع',
  'الثامن',
  'التاسع',
  'العاشر',
]

/** Vidtube quality suffix → human label, best first. */
const QUALITY_ORDER = ['x', 'h', 'n', 'l'] as const
type QualityKey = (typeof QUALITY_ORDER)[number]

export interface TopCinemaSource {
  /** Vidtube quality key: x=1080p, h=720p, n=480p, l=240p. */
  quality: QualityKey
  /** Full label as shown on vidtube, e.g. `1080p FHD 1904x1024, 799.0 MB`. */
  label: string
  resolution: string | null
  sizeMb: number | null
  /** The direct, tokenized CDN .mp4 url (valid ~24h). */
  url: string
}

export interface TopCinemaSeason {
  /** Season number (0 when its ordinal isn't in the table). */
  number: number
  /** Display label, e.g. `الموسم الثاني`. */
  title: string
  /** Season page url (parse it for that season's episodes). */
  url: string
}

export interface TopCinemaEpisode {
  number: number
  title: string
  /** Episode page url — feed to {@link resolveEpisode}. */
  url: string
}

export interface TopCinemaSeries {
  /** The season page these lists were parsed from. */
  page: string
  seasons: TopCinemaSeason[]
  episodes: TopCinemaEpisode[]
}

export interface TopCinemaResult {
  page: string
  sources: TopCinemaSource[]
}

/** A site-shaped error so the controller can map it to a stable message key. */
export class TopCinemaError extends Error {}

async function fetchText(url: string, referer?: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: res.status, body: await res.text() }
}

/** Every topcinema link on a page, as {raw (encoded), dec (decoded)} pairs. */
function links(html: string): { raw: string; dec: string }[] {
  const out: { raw: string; dec: string }[] = []
  for (const m of html.matchAll(SITE_LINK_RE)) {
    let dec = m[1]
    try {
      dec = decodeURIComponent(m[1])
    } catch {
      /* keep raw */
    }
    out.push({ raw: m[1], dec })
  }
  return out
}

function ordinalToNumber(ord: string): number {
  const i = ORDINALS.indexOf(ord.trim())
  return i > 0 ? i : 0
}

/** The slug of a series url, e.g. `silo` from `…/مسلسل-silo-الموسم-الاول-مترجم/`. */
function slugOf(decodedUrl: string): string | null {
  return decodedUrl.match(/مسلسل-(.+?)-(?:الموسم|مترجم)/)?.[1] ?? null
}

function parseSeasons(html: string, slug: string): TopCinemaSeason[] {
  // Dedupe by the season's ordinal — the page links the same season several
  // times (breadcrumb, active marker, list) with slightly different encodings.
  const seen = new Set<string>()
  const out: TopCinemaSeason[] = []
  for (const { raw, dec } of links(html)) {
    if (!dec.includes('/series/') || !dec.includes('الموسم') || dec.includes('الحلقة')) continue
    if (slugOf(dec) !== slug) continue
    const ord = dec.match(/الموسم-(.+?)-مترجم/)?.[1] ?? ''
    if (!ord || seen.has(ord)) continue
    seen.add(ord)
    out.push({ number: ordinalToNumber(ord), title: `الموسم ${ord}`.trim(), url: raw })
  }
  out.sort((a, b) => a.number - b.number)
  return out
}

function parseEpisodes(html: string, slug: string): TopCinemaEpisode[] {
  const seen = new Set<string>()
  const out: TopCinemaEpisode[] = []
  for (const { raw, dec } of links(html)) {
    if (!dec.includes('الحلقة') || !dec.includes('مترجمة')) continue
    if (slugOf(dec) !== slug) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    const n = Number(dec.match(/الحلقة-(\d+)/)?.[1] ?? '0')
    out.push({ number: n, title: `الحلقة ${n}`, url: raw })
  }
  out.sort((a, b) => a.number - b.number)
  return out
}

/** Fetches each url in order; returns the first that answers 200, else null. */
async function fetchFirstOk(urls: string[]): Promise<{ url: string; body: string } | null> {
  for (const url of urls) {
    try {
      const { status, body } = await fetchText(url)
      if (status === 200) return { url, body }
    } catch {
      /* mirror down/blocked/timed-out — try the next one */
    }
  }
  return null
}

/** Parses a season page into its seasons list + that season's episodes. */
async function parseSeriesPage(url: string, prefetched?: string): Promise<TopCinemaSeries> {
  let body = prefetched
  if (body === undefined) {
    const res = await fetchText(url)
    if (res.status !== 200) throw new TopCinemaError('topcinema_not_found')
    body = res.body
  }
  let dec = url
  try {
    dec = decodeURIComponent(url)
  } catch {
    /* keep */
  }
  const slug = slugOf(dec)
  if (!slug) throw new TopCinemaError('topcinema_not_found')

  const seasons = parseSeasons(body, slug)
  const episodes = parseEpisodes(body, slug)
  if (episodes.length === 0 && seasons.length === 0) {
    throw new TopCinemaError('topcinema_not_found')
  }
  return { page: url, seasons, episodes }
}

/**
 * Opens a series by name. The name is the url slug the user can edit
 * (e.g. `silo`, `widows-bay`); the canonical season-one page is tried first,
 * then a search fallback. Returns seasons + first season's episodes.
 */
export async function seriesByName(name: string): Promise<TopCinemaSeries> {
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  const seasonOnePath = `series/${encodeURIComponent(`مسلسل-${slug}-الموسم-الاول-مترجم`)}/`

  // 1) Canonical season-one page — tried on every mirror, first hit wins.
  const canonical = await fetchFirstOk(BASES.map((b) => `${b}/${seasonOnePath}`))
  if (canonical) return parseSeriesPage(canonical.url, canonical.body)

  // 2) Search each mirror (spaces, not hyphens) for any season page of the title.
  const query = encodeURIComponent(slug.replace(/-/g, ' '))
  for (const base of BASES) {
    let body: string
    try {
      body = (await fetchText(`${base}/?s=${query}`)).body
    } catch {
      continue // this mirror is down/blocked — try the next
    }

    const series = links(body).find(
      (l) => l.dec.includes('/series/') && l.dec.includes('مسلسل-') && l.dec.includes('الموسم')
    )
    if (series) return parseSeriesPage(series.raw)

    // 3) Last resort: an episode result → its slug → reconstruct the season page
    // on the SAME mirror it was found on (so we stay on a live domain).
    const ep = links(body).find((l) => l.dec.includes('الحلقة') && l.dec.includes('مسلسل-'))
    const epSlug = ep ? slugOf(ep.dec) : null
    if (epSlug) {
      return parseSeriesPage(`${base}/series/${encodeURIComponent(`مسلسل-${epSlug}-الموسم-الاول-مترجم`)}/`)
    }
  }
  throw new TopCinemaError('topcinema_not_found')
}

/** Parses a season page url (used when the user switches seasons). */
export async function seasonEpisodes(url: string): Promise<TopCinemaSeries> {
  return parseSeriesPage(url)
}

/**
 * Finds the vidtube `/d/<id>.html` link on an episode/movie download page,
 * preferring the site's recommended "proServer".
 */
async function vidtubeLinkFor(pageUrl: string): Promise<string | null> {
  const dlUrl = pageUrl.endsWith('/') ? `${pageUrl}download/` : `${pageUrl}/download/`
  let body: string
  try {
    const res = await fetchText(dlUrl)
    if (res.status !== 200) return null
    body = res.body
  } catch {
    return null // timeout/network — let the caller try the next candidate
  }
  const pro = body.match(VIDTUBE_PRO_RE)
  if (pro) return pro[1]
  const any = body.match(VIDTUBE_HTML_RE)
  return any ? any[1] : null
}

/** Resolves every quality variant of a vidtube `/d/<id>.html` page in parallel. */
async function resolveVidtube(vidtubeHtmlUrl: string): Promise<TopCinemaSource[]> {
  const id = vidtubeHtmlUrl.match(/\/d\/([^.]+)\.html/)?.[1]
  if (!id) return []
  // Follow whatever vidtube origin the page actually used (it rotates too),
  // not a configured one; fall back to the first configured base if unparsable.
  const vidtubeOrigin = originOf(vidtubeHtmlUrl) ?? VIDTUBE_BASES[0]
  let body: string
  try {
    body = (await fetchText(vidtubeHtmlUrl, `${PRIMARY_BASE}/`)).body
  } catch {
    return [] // timeout/network — best-effort, caller treats as "no sources"
  }

  const variants = new Map<QualityKey, string>()
  for (const m of body.matchAll(
    new RegExp(`href="/d/(${id}_([xhnl]))"[^>]*>(.*?)</a>`, 'gs')
  )) {
    const q = m[2] as QualityKey
    const label = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    variants.set(q, label)
  }
  if (variants.size === 0) return []

  const resolved = await Promise.all(
    QUALITY_ORDER.filter((q) => variants.has(q)).map(async (q) => {
      const label = variants.get(q)!
      try {
        const { body: vb } = await fetchText(`${vidtubeOrigin}/d/${id}_${q}`, vidtubeHtmlUrl)
        const url = vb.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/)?.[0]
        if (!url) return null
        return {
          quality: q,
          label,
          resolution: label.match(/(\d{3,4}x\d{3,4})/)?.[1] ?? null,
          sizeMb: label.match(/([\d.]+)\s*MB/) ? Number(label.match(/([\d.]+)\s*MB/)![1]) : null,
          url,
        } satisfies TopCinemaSource
      } catch {
        return null
      }
    })
  )
  return resolved.filter((s): s is TopCinemaSource => s !== null)
}

/** Resolves a single (already-parsed) episode page url to its sources. */
export async function resolveEpisode(episodeUrl: string): Promise<TopCinemaResult> {
  const vt = await vidtubeLinkFor(episodeUrl)
  if (!vt) throw new TopCinemaError('topcinema_not_found')
  const sources = await resolveVidtube(vt)
  if (sources.length === 0) throw new TopCinemaError('topcinema_not_found')
  return { page: episodeUrl, sources }
}

/** Resolves a movie page url to its sources, or null if it yields none. */
async function tryResolveMoviePage(page: string): Promise<TopCinemaResult | null> {
  const vt = await vidtubeLinkFor(page)
  if (!vt) return null
  const sources = await resolveVidtube(vt)
  return sources.length > 0 ? { page, sources } : null
}

/** Resolves a movie (by editable name slug) to its sources. */
export async function resolveMovie(name: string): Promise<TopCinemaResult> {
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')

  // 1) Canonical movie page on each mirror.
  for (const base of BASES) {
    const result = await tryResolveMoviePage(`${base}/${encodeURIComponent(`فيلم-${slug}-مترجم`)}/`)
    if (result) return result
  }

  // 2) Search each mirror (spaces, not hyphens) for the movie page.
  const query = encodeURIComponent(slug.replace(/-/g, ' '))
  for (const base of BASES) {
    let body: string
    try {
      body = (await fetchText(`${base}/?s=${query}`)).body
    } catch {
      continue
    }
    const film = links(body).find((l) => l.dec.includes('فيلم-') && !l.dec.includes('الحلقة'))
    if (film) {
      const result = await tryResolveMoviePage(film.raw)
      if (result) return result
    }
  }
  throw new TopCinemaError('topcinema_not_found')
}
