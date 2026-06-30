/*
|--------------------------------------------------------------------------
| Catalogue normalization
|--------------------------------------------------------------------------
|
| Collapses the two source shapes (Cinemeta meta JSON, EgyBest tile/detail JSON)
| into ONE unified catalogue shape, so the client has a single `CatalogItem` /
| `CatalogDetail` entity and one detail flow regardless of source. The field
| mappings mirror the old per-source Dart mappers (CatalogItem/MetaDetail vs
| CinemaItem/CinemaDetail) exactly.
*/

export interface NormalizedTile {
  source: string // 'cinemeta' | 'egybest'
  id: string // the source's media id (imdb id for cinemeta, internal id for egybest)
  imdbId: string | null // tt… — for apibay torrents + subtitle search
  type: 'movie' | 'series'
  title: string
  poster: string | null
  rating: string | null
  year: string | null
  genres: string[]
}

export interface NormalizedEpisode {
  number: number
  name: string | null
  /** EgyBest episode id (for stream resolution); null for Cinemeta. */
  id: string | null
}

export interface NormalizedSeason {
  number: number
  /** EgyBest season id (fetch its episodes); null for Cinemeta (episodes inline). */
  id: string | null
  episodes: NormalizedEpisode[]
}

export interface NormalizedDetail extends NormalizedTile {
  background: string | null
  description: string | null
  runtime: string | null
  seasons: NormalizedSeason[]
}

// ── shared coercion ─────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim().length > 0 ? v.trim() : null
  if (typeof v === 'number') return String(v)
  return null
}

function int(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => str(x)).filter((s): s is string => s !== null)
}

/** `vote_average` → short rating text (`8`, `7.29` → `7.3`), or null at 0. */
function ratingText(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  if (!Number.isFinite(n) || n <= 0) return null
  const s = n.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

function httpsImage(url: string | null): string | null {
  if (!url) return null
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url
}

/** EgyBest `genres:[{name}]` + `genreslist:[string]` merged, de-duped. */
function egybestGenres(genres: unknown, genreslist: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (g: unknown) => {
    const s = str(g)
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  if (Array.isArray(genreslist)) genreslist.forEach(add)
  if (Array.isArray(genres)) {
    for (const g of genres) {
      if (g && typeof g === 'object') add((g as Record<string, unknown>).name)
      else add(g)
    }
  }
  return out
}

function normType(raw: unknown): 'movie' | 'series' {
  const t = (str(raw) ?? 'movie').toLowerCase()
  return t === 'serie' || t === 'series' || t === 'anime' ? 'series' : 'movie'
}

// ── tiles ───────────────────────────────────────────────────────────────────

export function normalizeTile(source: string, raw: Record<string, unknown>): NormalizedTile | null {
  return source === 'egybest' ? egybestTile(raw) : cinemetaTile(raw)
}

function cinemetaTile(m: Record<string, unknown>): NormalizedTile | null {
  const imdb = str(m.imdb_id) ?? str(m.id)
  const title = str(m.name)
  if (!imdb || !title) return null
  return {
    source: 'cinemeta',
    id: imdb,
    imdbId: imdb,
    type: normType(m.type),
    title,
    poster: str(m.poster),
    rating: str(m.imdbRating),
    year: str(m.releaseInfo) ?? str(m.year),
    genres: strList(m.genres ?? m.genre),
  }
}

function egybestTile(m: Record<string, unknown>): NormalizedTile | null {
  const id = int(m.id)
  const title = str(m.title ?? m.name)
  if (id === 0 || !title) return null
  return {
    source: 'egybest',
    id: String(id),
    imdbId: str(m.imdb_external_id),
    type: normType(m.type),
    title,
    poster: httpsImage(str(m.poster_path ?? m.poster)),
    rating: ratingText(m.vote_average),
    year: null,
    genres: egybestGenres(m.genres, m.genreslist),
  }
}

// ── detail ──────────────────────────────────────────────────────────────────

export function normalizeDetail(source: string, raw: Record<string, unknown>): NormalizedDetail | null {
  return source === 'egybest' ? egybestDetail(raw) : cinemetaDetail(raw)
}

function cinemetaDetail(m: Record<string, unknown>): NormalizedDetail | null {
  const tile = cinemetaTile(m)
  if (!tile) return null
  return {
    ...tile,
    background: str(m.background),
    description: str(m.description),
    runtime: str(m.runtime),
    seasons: cinemetaSeasons(m.videos, tile.imdbId ?? tile.id),
  }
}

/** Groups Cinemeta `videos[]` into seasons (skips specials = season 0). */
function cinemetaSeasons(videos: unknown, imdbId: string): NormalizedSeason[] {
  if (!Array.isArray(videos)) return []
  const bySeason = new Map<number, NormalizedEpisode[]>()
  const seen = new Set<string>()
  for (const raw of videos) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as Record<string, unknown>
    const season = int(v.season)
    const episode = int(v.episode ?? v.number)
    if (season < 1 || episode < 1) continue
    const key = `${season}x${episode}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = bySeason.get(season) ?? []
    list.push({ number: episode, name: str(v.name ?? v.title), id: `${imdbId}:${season}:${episode}` })
    bySeason.set(season, list)
  }
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, episodes]) => ({
      number,
      id: null,
      episodes: episodes.sort((a, b) => a.number - b.number),
    }))
}

function egybestDetail(m: Record<string, unknown>): NormalizedDetail | null {
  const id = int(m.id)
  const title = str(m.title ?? m.name)
  if (id === 0 || !title) return null
  const type = m.seasons || m.type === 'serie' || m.type === 'series' ? 'series' : 'movie'
  return {
    source: 'egybest',
    id: String(id),
    imdbId: str(m.imdb_external_id),
    type: type === 'series' ? 'series' : normType(m.type),
    title,
    poster: httpsImage(str(m.poster_path)),
    rating: ratingText(m.vote_average),
    year: yearFrom(m.release_date ?? m.first_air_date),
    genres: egybestGenres(m.genres, m.genreslist),
    background: httpsImage(str(m.backdrop_path)),
    description: str(m.overview),
    runtime: runtimeFrom(m.runtime),
    seasons: egybestSeasonStubs(m.seasons),
  }
}

/** EgyBest series/show seasons → season stubs (episodes fetched on demand). */
function egybestSeasonStubs(seasons: unknown): NormalizedSeason[] {
  if (!Array.isArray(seasons)) return []
  return seasons
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const obj = s as Record<string, unknown>
      return { number: int(obj.season_number ?? obj.number), id: String(int(obj.id)), episodes: [] }
    })
    .sort((a, b) => a.number - b.number)
}

/** Normalizes one EgyBest `series/season/{id}` response into episodes. */
export function normalizeEgybestSeasonEpisodes(raw: Record<string, unknown>): NormalizedEpisode[] {
  const eps = raw.episodes
  if (!Array.isArray(eps)) return []
  return eps
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const obj = e as Record<string, unknown>
      return {
        number: int(obj.episode_number ?? obj.number),
        name: str(obj.name),
        id: String(int(obj.id)),
      }
    })
    .sort((a, b) => a.number - b.number)
}

function yearFrom(date: unknown): string | null {
  const s = str(date)
  return s && s.length >= 4 ? s.slice(0, 4) : null
}

function runtimeFrom(minutes: unknown): string | null {
  const n = int(minutes)
  if (n <= 0) return null
  const h = Math.floor(n / 60)
  const m = n % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
