/*
|--------------------------------------------------------------------------
| EgyBest embed-link resolver
|--------------------------------------------------------------------------
|
| Ported verbatim from the Flutter client's `cinema_resolver.dart`. Turns an
| EgyBest `videos[]` server entry into direct, playable `.mp4`/`.m3u8` links.
| Strategy: direct passthrough → fetch embed page (with the API-provided Referer)
| → unpack packed JS → regex the media url out. Hosts that need bespoke
| reverse-engineering simply yield [] ("try another server"). Best-effort: any
| failure returns [] rather than throwing, so the streams endpoint never 500s.
*/

import { unpackPackedJs } from '#services/streams/packed_js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 25_000

export interface ResolvedStream {
  url: string
  qualityLabel: string
  isHls: boolean
}

/** Raw EgyBest `videos[]` entry (only the fields the resolver reads). */
export interface CinemaServerInput {
  server?: unknown
  link?: unknown
  tmp_link?: unknown
  header?: unknown
  youtubelink?: unknown
  drm?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = asString(v).trim().toLowerCase()
  return s === '1' || s === 'true'
}

/** name (`server`), link (`link` ?? `tmp_link`), referer (`header`), flags. */
function readServer(raw: CinemaServerInput) {
  const name = asString(raw.server) || 'Server'
  const link = asString(raw.link) || asString(raw.tmp_link) || ''
  return {
    name,
    link,
    header: asString(raw.header),
    youtubeLink: asBool(raw.youtubelink),
    drm: asBool(raw.drm),
  }
}

/** True when the link is already a direct media file (no resolving needed). */
function isDirect(link: string): boolean {
  const l = link.toLowerCase()
  return l.includes('.mp4') || l.includes('.m3u8') || l.includes('.mkv')
}

/** A resolution badge from a server name (`1080p`, `4K`, …), or null. */
function serverQualityLabel(name: string, link: string): string | null {
  const m = /(\d{3,4})\s*[pP]/.exec(name) ?? /(\d{3,4})\s*[pP]/.exec(link)
  if (m) return `${m[1]}p`
  if (/\b4k\b/i.test(name)) return '4K'
  return null
}

// ── extraction (ported regexes) ─────────────────────────────────────────────

const DIRECT_URL = /https?:\/\/[^"'\s\\<>]+?\.(?:mp4|m3u8)(?:\?[^"'\s\\<>]*)?/gi
const FILE_FIELD =
  /["']?(?:file|src|source)["']?\s*[:=]\s*["']([^"']+?\.(?:mp4|m3u8)[^"']*)["']/gi

/** Every distinct `.mp4`/`.m3u8` url in `s` (raw or unpacked), order preserved. */
function extractMedia(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (u: string | undefined) => {
    if (!u) return
    const url = u.replace(/\\\//g, '/').trim()
    if (url.startsWith('http') && !seen.has(url)) {
      seen.add(url)
      out.push(url)
    }
  }
  for (const m of s.matchAll(DIRECT_URL)) add(m[0])
  for (const m of s.matchAll(FILE_FIELD)) add(m[1])
  return out
}

/** A height hint from a media url (`…_1080.mp4`, `/720/`, `1080p`), or null. */
function labelFromUrl(url: string): string | null {
  const m = /(\d{3,4})\s*[pP]\b/.exec(url) ?? /[_/-](\d{3,4})(?:[._/-]|\.mp4|\.m3u8)/.exec(url)
  const h = m ? Number.parseInt(m[1], 10) : NaN
  if (Number.isFinite(h) && h >= 144 && h <= 2160) return `${h}p`
  return null
}

/** mp4 before m3u8 (a file beats a playlist), de-duplicated by quality label. */
function toStreams(urls: string[], qualityLabel: string | null): ResolvedStream[] {
  const mp4 = urls.filter((u) => u.toLowerCase().includes('.mp4'))
  const hls = urls.filter((u) => u.toLowerCase().includes('.m3u8'))
  const ordered = [...mp4, ...hls]

  const byLabel = new Map<string, ResolvedStream>()
  for (const url of ordered) {
    const label = labelFromUrl(url) ?? qualityLabel ?? 'Auto'
    if (!byLabel.has(label)) {
      byLabel.set(label, { url, qualityLabel: label, isHls: url.toLowerCase().includes('.m3u8') })
    }
  }
  return [...byLabel.values()]
}

/** Fetches an embed page; sends Referer only when non-empty (some hosts block self-referer). */
async function getPage(url: string, referer: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' }
    if (referer) headers.Referer = referer
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/**
 * Resolves one EgyBest server to its playable streams. Returns [] for YouTube /
 * DRM / unresolvable hosts so the caller can offer another server.
 */
export async function resolveServer(raw: CinemaServerInput): Promise<ResolvedStream[]> {
  const server = readServer(raw)
  if (server.youtubeLink || server.drm || !server.link) return []

  const quality = serverQualityLabel(server.name, server.link)

  // 1) Direct file — nothing to parse.
  if (isDirect(server.link)) {
    return [
      {
        url: server.link,
        qualityLabel: quality ?? labelFromUrl(server.link) ?? 'SD',
        isHls: server.link.toLowerCase().includes('.m3u8'),
      },
    ]
  }

  // 2 + 3) Fetch the embed page and extract (raw, then unpacked).
  const body = await getPage(server.link, server.header)
  if (!body) return []

  let urls = extractMedia(body)
  if (urls.length === 0) {
    const unpacked = unpackPackedJs(body)
    if (unpacked) urls = extractMedia(unpacked)
  }
  if (urls.length === 0) return []

  return toStreams(urls, quality)
}

/** Resolves every server of a title in parallel, flattened + de-duplicated by url. */
export async function resolveServers(servers: CinemaServerInput[]): Promise<ResolvedStream[]> {
  const lists = await Promise.all(servers.map((s) => resolveServer(s)))
  const seen = new Set<string>()
  const out: ResolvedStream[] = []
  for (const list of lists) {
    for (const stream of list) {
      if (!seen.has(stream.url)) {
        seen.add(stream.url)
        out.push(stream)
      }
    }
  }
  return out
}
