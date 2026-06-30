/*
|------------------------------------------------------------------------------
| TopCinema scraper — ISOLATED, self-contained module
|------------------------------------------------------------------------------
|
| A completely separate "second way" of sourcing a title, independent of the
| torrent/Cinemeta path. It walks topcinema.fan exactly as a browser would and
| returns direct, downloadable MP4 links resolved from the site's "vidtube.one"
| file host.
|
| Series are driven by the SITE'S OWN html (not Cinemeta), because episode urls
| are irregular (e.g. the finale is `…الحلقة-10-والاخيرة-مترجمة`) and can't be
| safely constructed:
|
|   /series/مسلسل-<slug>-الموسم-الاول-مترجم/   → seasons list + that season's episodes
|   <episode page>/download/                   → the "vidtube.one/d/<id>.html" host link
|   vidtube /d/<id>.html                       → quality variants (_x _h _n _l)
|   vidtube /d/<id>_<q>                        → the final tokenized CDN .mp4 url
|
| The CDN links are open (HTTP 206 range, no auth/referer) and valid ~24h, so
| they drop straight into the existing `download` room flow. Nothing here
| imports or mutates any existing service — it is intentionally standalone.
*/

/** A browser User-Agent — the site 403s the default Node/bot agent. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * Interchangeable mirror domains, tried in order. Entry points (series/movie
 * lookup, search) walk each host until one answers, so a domain that is
 * down/blocked/rate-limited falls through to the next. Add more here if the
 * site rotates to another domain.
 */
const HOSTS = ['https://web4.topcinema.fan', 'https://topcinemaa.com']

/** `https://host/...` → `https://host/` (used as the vidtube referer). */
function originOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}/`
  } catch {
    return `${HOSTS[0]}/`
  }
}

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
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow',
    })
    return { status: res.status, body: await res.text() }
  } catch {
    // Network-level failure (DNS / TLS / refused) — report as "no page here" so
    // the caller can fall through to the next mirror instead of throwing.
    return { status: 0, body: '' }
  }
}

/** Every topcinema link on a page (any mirror), as {raw, dec} pairs. */
function links(html: string): { raw: string; dec: string }[] {
  const out: { raw: string; dec: string }[] = []
  for (const m of html.matchAll(
    /href="(https?:\/\/(?:[\w-]+\.)*(?:topcinema\.fan|topcinemaa\.com)\/[^"]+)"/g
  )) {
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

/** Parses a season page into its seasons list + that season's episodes. */
async function parseSeriesPage(url: string): Promise<TopCinemaSeries> {
  const { status, body } = await fetchText(url)
  if (status !== 200) throw new TopCinemaError('topcinema_not_found')
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

/** Parses a season page, swallowing a site-shaped miss so callers can fall on. */
async function tryParseSeriesPage(url: string): Promise<TopCinemaSeries | null> {
  try {
    return await parseSeriesPage(url)
  } catch (e) {
    if (e instanceof TopCinemaError) return null
    throw e
  }
}

/**
 * Opens a series by name. The name is the url slug the user can edit
 * (e.g. `silo`, `widows-bay`). For each mirror the canonical season-one page is
 * tried first, then a search fallback. Returns seasons + first season's episodes.
 */
export async function seriesByName(name: string): Promise<TopCinemaSeries> {
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  for (const base of HOSTS) {
    const entry = `${base}/series/${encodeURIComponent(`مسلسل-${slug}-الموسم-الاول-مترجم`)}/`
    const direct = await tryParseSeriesPage(entry)
    if (direct) return direct

    // Fallback: search (spaces, not hyphens) for any season page of this title.
    const { body } = await fetchText(`${base}/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}`)
    const series = links(body).find(
      (l) => l.dec.includes('/series/') && l.dec.includes('مسلسل-') && l.dec.includes('الموسم')
    )
    if (series) {
      const parsed = await tryParseSeriesPage(series.raw)
      if (parsed) return parsed
    }

    // Last resort: an episode result → its slug → reconstruct the season page.
    const ep = links(body).find((l) => l.dec.includes('الحلقة') && l.dec.includes('مسلسل-'))
    const epSlug = ep ? slugOf(ep.dec) : null
    if (epSlug) {
      const url = `${base}/series/${encodeURIComponent(`مسلسل-${epSlug}-الموسم-الاول-مترجم`)}/`
      const parsed = await tryParseSeriesPage(url)
      if (parsed) return parsed
    }
  }
  throw new TopCinemaError('topcinema_not_found')
}

/** Parses a season page url (used when the user switches seasons). */
export async function seasonEpisodes(url: string): Promise<TopCinemaSeries> {
  return parseSeriesPage(url)
}

/**
 * Finds the `vidtube.one/d/<id>.html` link on an episode/movie download page,
 * preferring the site's recommended "proServer".
 */
async function vidtubeLinkFor(pageUrl: string): Promise<string | null> {
  const dlUrl = pageUrl.endsWith('/') ? `${pageUrl}download/` : `${pageUrl}/download/`
  const { status, body } = await fetchText(dlUrl)
  if (status !== 200) return null
  const pro = body.match(
    /href="(https:\/\/vidtube\.one\/d\/[^"]+\.html)"[^>]*class="[^"]*proServer/i
  )
  if (pro) return pro[1]
  const any = body.match(/href="(https:\/\/vidtube\.one\/d\/[^"]+\.html)"/i)
  return any ? any[1] : null
}

/** Resolves every quality variant of a vidtube `/d/<id>.html` page in parallel. */
async function resolveVidtube(vidtubeHtmlUrl: string, referer: string): Promise<TopCinemaSource[]> {
  const id = vidtubeHtmlUrl.match(/\/d\/([^.]+)\.html/)?.[1]
  if (!id) return []
  const { body } = await fetchText(vidtubeHtmlUrl, referer)

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
        const { body: vb } = await fetchText(`https://vidtube.one/d/${id}_${q}`, vidtubeHtmlUrl)
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
  const sources = await resolveVidtube(vt, originOf(episodeUrl))
  if (sources.length === 0) throw new TopCinemaError('topcinema_not_found')
  return { page: episodeUrl, sources }
}

/** Resolves a movie (by editable name slug) to its sources, trying each mirror. */
export async function resolveMovie(name: string): Promise<TopCinemaResult> {
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  for (const base of HOSTS) {
    const candidates = [`${base}/${encodeURIComponent(`فيلم-${slug}-مترجم`)}/`]

    // Search fallback for the movie page on this mirror.
    const { body } = await fetchText(`${base}/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}`)
    const film = links(body).find((l) => l.dec.includes('فيلم-') && !l.dec.includes('الحلقة'))
    if (film && !candidates.includes(film.raw)) candidates.push(film.raw)

    for (const page of candidates) {
      const vt = await vidtubeLinkFor(page)
      if (!vt) continue
      const sources = await resolveVidtube(vt, originOf(page))
      if (sources.length > 0) return { page, sources }
    }
  }
  throw new TopCinemaError('topcinema_not_found')
}
