/*
|--------------------------------------------------------------------------
| OpenSubtitles service
|--------------------------------------------------------------------------
|
| A thin server-side client for the legacy OpenSubtitles REST API
| (https://rest.opensubtitles.org). It exists so the *web* room client can
| search for and attach subtitles the same way the Flutter app does — but
| from the browser a direct call is blocked by CORS, and the download links
| serve gzipped bytes a browser cannot transparently un-gzip for us. So the
| server proxies both steps: search returns trimmed JSON, and download fetches
| + gunzips + UTF-8-normalizes the chosen file ready to store on the room.
|
| The legacy API is keyless but insists on a non-empty (X-)User-Agent header.
*/

import { gunzipSync } from 'node:zlib'
import env from '#start/env'

/** Base URL of the keyless legacy REST API (from `.env`; same one the app uses). */
const OPEN_SUBTITLES_BASE = env.get('OPENSUBTITLES_BASE')

/** The legacy API rejects requests without a User-Agent; any token works. */
const OPEN_SUBTITLES_HEADERS = {
  'User-Agent': 'TemporaryUserAgent',
  'X-User-Agent': 'TemporaryUserAgent',
}

/** How long to wait on a search/download before giving up. */
const REQUEST_TIMEOUT_MS = 20_000

/** A single subtitle candidate, trimmed to the fields the client renders. */
export interface OpenSubtitleResult {
  id: string
  fileName: string
  langId: string
  langName: string
  format: string
  downloadLink: string
  releaseName: string
  downloadsCount: number
  rating: number
}

export interface SubtitleSearchParams {
  imdbId?: string
  query?: string
  season?: number
  episode?: number
  lang: string
}

/** Keeps only the digits of an IMDB id (`tt0133093` → `133093`), or '' if none. */
function imdbDigits(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length === 0) return ''
  return String(Number.parseInt(digits, 10))
}

/**
 * Builds an OpenSubtitles search URL. Prefers an IMDB id when present (the most
 * accurate match), otherwise falls back to a free-text `query-...` segment.
 * Returns null when there is nothing to search on.
 */
export function buildSearchUrl(params: SubtitleSearchParams): string | null {
  const digits = params.imdbId ? imdbDigits(params.imdbId) : ''
  let segment: string
  if (digits.length > 0) {
    segment = `imdbid-${digits}`
  } else {
    const q = (params.query ?? '').trim()
    if (q.length === 0) return null
    segment = `query-${encodeURIComponent(q)}`
  }

  const parts = [
    'search',
    segment,
    ...(params.season != null ? [`season-${params.season}`] : []),
    ...(params.episode != null ? [`episode-${params.episode}`] : []),
    `sublanguageid-${params.lang}`,
  ]
  return `${OPEN_SUBTITLES_BASE}/${parts.join('/')}`
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

function asInt(value: unknown): number {
  const n = Number.parseInt(asString(value) ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Maps the raw OpenSubtitles JSON array into trimmed results: drops entries
 * without a download link or id, de-duplicates by file id, and sorts by
 * download count (most-downloaded first) — matching the mobile app's ranking.
 */
export function parseSubtitleResults(json: unknown): OpenSubtitleResult[] {
  if (!Array.isArray(json)) return []

  const seen = new Set<string>()
  const out: OpenSubtitleResult[] = []
  for (const raw of json) {
    if (raw == null || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const downloadLink = asString(m.SubDownloadLink)
    const id = asString(m.IDSubtitleFile) ?? asString(m.IDSubtitle)
    if (!downloadLink || !id || seen.has(id)) continue
    seen.add(id)

    out.push({
      id,
      fileName: asString(m.SubFileName) ?? id,
      langId: asString(m.SubLanguageID) ?? '',
      langName: asString(m.LanguageName) ?? '',
      format: (asString(m.SubFormat) ?? 'srt').toLowerCase(),
      downloadLink,
      releaseName: asString(m.MovieReleaseName) ?? '',
      downloadsCount: asInt(m.SubDownloadsCnt),
      rating: Number.parseFloat(asString(m.SubRating) ?? '') || 0,
    })
  }

  out.sort((a, b) => b.downloadsCount - a.downloadsCount)
  return out
}

/** Runs a search against the legacy API. Returns [] for empty/no-match. */
export async function searchOpenSubtitles(
  params: SubtitleSearchParams
): Promise<OpenSubtitleResult[]> {
  const url = buildSearchUrl(params)
  if (!url) return []

  const res = await fetch(url, {
    headers: OPEN_SUBTITLES_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`opensubtitles_search_failed_${res.status}`)
  }

  const body = (await res.text()).trim()
  if (body.length === 0) return []
  try {
    return parseSubtitleResults(JSON.parse(body))
  } catch {
    /* Non-JSON body (e.g. an HTML rate-limit notice) → treat as no results. */
    return []
  }
}

/**
 * True for a download link we are willing to fetch. Restricted to OpenSubtitles
 * hosts so this proxy can't be turned into an SSRF gadget; both http and https
 * are accepted because the legacy API still hands out http download links.
 */
export function isAllowedDownloadLink(link: string): boolean {
  try {
    const u = new URL(link)
    const httpish = u.protocol === 'https:' || u.protocol === 'http:'
    return httpish && /(^|\.)opensubtitles\.org$/.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * Re-encodes subtitle bytes to UTF-8 so non-Latin text (notably Arabic) renders
 * correctly. Keeps the bytes if they already decode as valid UTF-8; otherwise
 * decodes them as Windows-1256 (the common legacy Arabic codepage) and returns
 * UTF-8. A leading UTF-8 BOM, if present, is stripped. Mirrors the helper in the
 * API controller so an attached subtitle gets the same treatment as an uploaded
 * one.
 */
export function normalizeSubtitleToUtf8(input: Buffer): Buffer {
  let buf = input
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return Buffer.from(text, 'utf-8')
  } catch {
    try {
      const text = new TextDecoder('windows-1256').decode(buf)
      return Buffer.from(text, 'utf-8')
    } catch {
      return buf
    }
  }
}

/**
 * Downloads a chosen subtitle and returns ready-to-store UTF-8 bytes. The
 * legacy download links serve a gzipped file; we gunzip it (falling back to the
 * raw bytes if a mirror serves it uncompressed) and then normalize the encoding.
 */
export async function downloadOpenSubtitle(downloadLink: string): Promise<Buffer> {
  if (!isAllowedDownloadLink(downloadLink)) {
    throw new Error('opensubtitles_download_rejected')
  }

  const res = await fetch(downloadLink, {
    headers: OPEN_SUBTITLES_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`opensubtitles_download_failed_${res.status}`)
  }

  const raw = Buffer.from(await res.arrayBuffer())
  let bytes: Buffer
  try {
    bytes = gunzipSync(raw)
  } catch {
    bytes = raw
  }
  return normalizeSubtitleToUtf8(bytes)
}
