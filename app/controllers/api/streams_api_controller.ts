import { resolveStreams } from '#services/streams/streams_service'
import { resolveServer } from '#services/streams/egybest_resolver'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * GET /api/streams — the single, on-demand source of playable streams for a
 * title. Replaces the client's on-device apibay + EgyBest/TopCinema resolvers.
 *
 * Params (provide what you have): `imdbId`, `query` (explicit apibay search),
 * `title`, `type` (movie|series), `egybestId`, `seasonId`, `episode`.
 *
 * Returns `{ torrents: [...], direct_links: [...] }`. Resolved live (no cache),
 * every source best-effort.
 */
export default class StreamsApiController {
  async index({ request, response }: HttpContext) {
    const imdbId = str(request.input('imdbId'))
    const query = str(request.input('query'))
    const title = str(request.input('title'))
    const type = str(request.input('type'))
    const egybestId = str(request.input('egybestId'))
    const seasonId = str(request.input('seasonId'))
    const episode = int(request.input('episode'))

    if (!imdbId && !query && !title && !egybestId) {
      return response.status(422).json({ success: false, message: 'streams_query_required' })
    }

    const data = await resolveStreams({
      imdbId,
      query,
      title,
      type,
      egybestId,
      seasonId,
      episode,
    })
    return response.json({ success: true, data })
  }

  /**
   * POST /api/streams/resolve — resolves ONE EgyBest server (the user picked it
   * in the server sheet) to its direct links. Body is the raw `videos[]` entry
   * (`link`/`tmp_link`/`header`/`server`/`youtubelink`/`drm`). Replaces the
   * client's on-device CinemaResolver. Returns `{ direct_links: [...] }`.
   */
  async resolve({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const link = str(body.link) ?? str(body.tmp_link)
    if (!link) {
      return response.status(422).json({ success: false, message: 'server_link_required' })
    }
    const direct_links = await resolveServer({
      server: body.server,
      link,
      tmp_link: body.tmp_link,
      header: body.header,
      youtubelink: body.youtubelink,
      drm: body.drm,
    })
    return response.json({ success: true, data: { direct_links } })
  }
}

/** Trimmed non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim()
  return s.length > 0 ? s : undefined
}

/** Parsed positive int, or undefined. */
function int(v: unknown): number | undefined {
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : undefined
}
