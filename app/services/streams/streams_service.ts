/*
|--------------------------------------------------------------------------
| Unified streams service
|--------------------------------------------------------------------------
|
| The single on-demand resolver behind `GET /api/streams`. Given a title, it
| gathers in parallel:
|   * torrents     — apibay (by imdb id, or an explicit episode query)
|   * direct_links — EgyBest servers, resolved via the embed resolver
| and returns `{ torrents, direct_links }`. Every source is best-effort: a
| failure yields [] and never blocks the others. Nothing is cached (links expire).
|
| TopCinema is intentionally NOT here: its host blocks the server's IP, so the
| client keeps resolving it on-device as a separate "second way" feature.
*/

import { searchTorrents, type TorrentOption } from '#services/streams/apibay'
import {
  resolveServers,
  type CinemaServerInput,
  type ResolvedStream,
} from '#services/streams/egybest_resolver'
import { fetchEgybestDetail, fetchEgybestSeason } from '#services/catalog/egybest_catalog'

export interface StreamsQuery {
  /** IMDB id (`tt…`) — apibay torrents. */
  imdbId?: string
  /** Explicit apibay query (e.g. `The Boys S01E06`) — overrides imdbId for torrents. */
  query?: string
  /** Title — TopCinema lookup + apibay fallback. */
  title?: string
  /** `movie` | `series`. */
  type?: string
  /** EgyBest internal id — direct links from its servers. */
  egybestId?: string
  /** EgyBest season id (series) — needed with `episode`. */
  seasonId?: string
  /** 1-based episode number within the season. */
  episode?: number
}

/**
 * One playable source in the unified list — a torrent (streamed on-device from
 * its magnet) or a direct link (an mp4/m3u8 url). The client renders both kinds
 * in one picker and creates the matching room type.
 */
export interface StreamSource {
  kind: 'torrent' | 'direct'
  label: string
  quality: string
  /** torrent only */
  magnet?: string
  seeders?: number
  sizeBytes?: number
  season?: number | null
  episode?: number | null
  isPack?: boolean
  /** direct only */
  url?: string
  isHls?: boolean
}

export interface StreamsResult {
  sources: StreamSource[]
}

/** Reads a `videos[]` array off a raw detail/episode object as resolver inputs. */
function serversFrom(obj: Record<string, unknown> | null): CinemaServerInput[] {
  if (!obj) return []
  const videos = obj.videos
  if (!Array.isArray(videos)) return []
  return videos.filter((v): v is CinemaServerInput => !!v && typeof v === 'object')
}

/** EgyBest direct links for the requested movie or specific episode. */
async function egybestLinks(q: StreamsQuery): Promise<ResolvedStream[]> {
  if (!q.egybestId) return []
  try {
    if (q.type === 'series' && q.seasonId) {
      const season = await fetchEgybestSeason(q.seasonId)
      const episodes = season && Array.isArray(season.episodes) ? season.episodes : []
      const match = episodes.find((e) => {
        const ep = e as Record<string, unknown>
        return q.episode != null && Number(ep.number) === q.episode
      }) as Record<string, unknown> | undefined
      return resolveServers(serversFrom(match ?? null))
    }
    const detail = await fetchEgybestDetail('movie', q.egybestId)
    return resolveServers(serversFrom(detail))
  } catch {
    return []
  }
}

/** Resolves a title's playable sources (torrents + direct links) as one list. */
export async function resolveStreams(q: StreamsQuery): Promise<StreamsResult> {
  const torrentQuery = (q.query && q.query.trim()) || q.imdbId || q.title || ''

  const [torrents, direct] = await Promise.all([
    torrentQuery ? searchTorrents(torrentQuery) : Promise.resolve([]),
    egybestLinks(q),
  ])

  // Direct links first (instant playback, no swarm), then torrents by seeders.
  const sources: StreamSource[] = [
    ...direct.map(directSource),
    ...torrents.map(torrentSource),
  ]
  return { sources }
}

function torrentSource(t: TorrentOption): StreamSource {
  return {
    kind: 'torrent',
    label: t.name,
    quality: t.quality,
    magnet: t.magnet,
    seeders: t.seeders,
    sizeBytes: t.sizeBytes,
    season: t.season,
    episode: t.episode,
    isPack: t.isPack,
  }
}

function directSource(s: ResolvedStream): StreamSource {
  return {
    kind: 'direct',
    label: s.qualityLabel,
    quality: s.qualityLabel,
    url: s.url,
    isHls: s.isHls,
  }
}
