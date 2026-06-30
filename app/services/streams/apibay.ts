/*
|--------------------------------------------------------------------------
| apibay torrent search
|--------------------------------------------------------------------------
|
| Ported verbatim from the Flutter client's `torrent_datasource.dart` +
| `torrent_classifier.dart`. Finds *video* torrents for a title via The Pirate
| Bay's JSON API and assembles each magnet locally from the `info_hash` + public
| trackers, so no second lookup is needed. The server now does this instead of
| the app.
*/

import env from '#start/env'

const REQUEST_TIMEOUT_MS = 20_000

/** The Pirate Bay JSON search endpoint (base from env, `q.php` is its path). */
const APIBAY = `${env.get('APIBAY_BASE')}/q.php`

/** apibay's empty-result sentinel. */
const ZERO_HASH = '0000000000000000000000000000000000000000'

/** Public trackers appended to every built magnet (comma-separated in `.env`). */
const TRACKERS = env
  .get('TORRENT_TRACKERS')
  .split(',')
  .map((t) => t.trim())
  .filter((t) => t.length > 0)

/** Filename hints that mark a result as a watchable video. */
const VIDEO_HINTS = [
  'mkv', 'mp4', 'avi', 'x264', 'x265', 'h264', 'h265', 'hevc', 'xvid',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'webrip', 'web-dl', 'web dl',
  'hdtv', 'hdrip', 'dvdrip', '2160p', '1080p', '720p', '480p', 'yify', 'yts',
]

export interface TorrentOption {
  name: string
  infoHash: string
  magnet: string
  seeders: number
  leechers: number
  sizeBytes: number
  season: number | null
  episode: number | null
  quality: string
  isPack: boolean
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

function asInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

// ── classifier (ported from torrent_classifier.dart) ────────────────────────

const EPISODE_RE = /s(\d{1,2})[ ._-]?[ex](\d{1,2})/i
const SEASON_RE = /\bs(\d{1,2})\b/i
const SEASON_WORD_RE = /season[ ._-]?(\d{1,2})/i
const MULTI_FILM_RE = /\b\d\s*(?:-|to)\s*\d\b|\b\d+\s*(?:movies?|films?)\b/
const PACK_HINTS = [
  'trilogy', 'quadrilogy', 'duology', 'pentalogy', 'anthology', 'saga',
  'collection', 'complete', 'boxset', 'box set', 'box.set',
  'ultimate matrix', 'movie collection', 'all movies',
]

/** `S05E06` → `{season:5, episode:6}`; season-only for packs; nulls otherwise. */
function parseSeasonEpisode(name: string): { season: number | null; episode: number | null } {
  const ep = EPISODE_RE.exec(name)
  if (ep) return { season: asIntOrNull(ep[1]), episode: asIntOrNull(ep[2]) }
  const s = SEASON_RE.exec(name) ?? SEASON_WORD_RE.exec(name)
  if (s) return { season: asIntOrNull(s[1]), episode: null }
  return { season: null, episode: null }
}

function asIntOrNull(s: string): number | null {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

/** Coarse resolution bucket: `4K`, `1080p`, `720p`, `480p`, or `SD`. */
function parseQuality(name: string): string {
  const l = name.toLowerCase()
  if (l.includes('2160p') || l.includes('4k') || l.includes('uhd')) return '4K'
  if (l.includes('1080p')) return '1080p'
  if (l.includes('720p')) return '720p'
  if (l.includes('480p')) return '480p'
  return 'SD'
}

/** True when the release bundles more than one film. */
function isPackName(name: string): boolean {
  const l = name.toLowerCase()
  return PACK_HINTS.some((h) => l.includes(h)) || MULTI_FILM_RE.test(l)
}

/** apibay video categories are `2xx`; otherwise fall back to filename hints. */
function isVideo(name: string, category: string | null): boolean {
  if (category && category.startsWith('2')) return true
  const lower = name.toLowerCase()
  return VIDEO_HINTS.some((h) => lower.includes(h))
}

function buildMagnet(hash: string, name: string): string {
  const dn = encodeURIComponent(name)
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}${trackers}`
}

/**
 * Runs an apibay query and returns every video torrent, most-seeded first. Empty
 * on no results / failure (the streams endpoint treats torrents as best-effort).
 */
export async function searchTorrents(query: string): Promise<TorrentOption[]> {
  const q = query.trim()
  if (!q) return []
  let body: unknown
  try {
    const res = await fetch(`${APIBAY}?q=${encodeURIComponent(q)}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return []
    body = await res.json()
  } catch {
    return []
  }
  if (!Array.isArray(body)) return []

  const out: TorrentOption[] = []
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const hash = asString(m.info_hash)
    const name = asString(m.name)
    if (!hash || !name) continue
    if (hash.toLowerCase() === ZERO_HASH) continue
    if (!isVideo(name, asString(m.category))) continue

    const se = parseSeasonEpisode(name)
    out.push({
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      seeders: asInt(m.seeders),
      leechers: asInt(m.leechers),
      sizeBytes: asInt(m.size),
      season: se.season,
      episode: se.episode,
      quality: parseQuality(name),
      isPack: isPackName(name),
    })
  }
  out.sort((a, b) => b.seeders - a.seeders)
  return out
}
