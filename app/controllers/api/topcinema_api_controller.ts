import {
  seriesByName,
  seasonEpisodes,
  resolveEpisode,
  resolveMovie,
  TopCinemaError,
} from '#services/topcinema/topcinema_scraper'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * JSON API for the ISOLATED "topcinema direct download" second source.
 *
 *   GET /api/topcinema/series   — parse a title's seasons + a season's episodes
 *                                 from the site html (by editable name, or by a
 *                                 specific season page url when switching seasons)
 *   GET /api/topcinema/resolve  — resolve a parsed episode url (or a movie name)
 *                                 to direct, downloadable MP4 links
 *
 * The Flutter client feeds a chosen link into the normal `download` room flow —
 * this controller owns only discovery + resolution and reuses nothing from the
 * torrent/room path. Responses follow the `{ success, message?, data? }`
 * envelope.
 */
export default class TopcinemaApiController {
  /**
   * GET /api/topcinema/series?name=<slug>   (open a title)
   * GET /api/topcinema/series?url=<seasonPageUrl>   (switch season)
   *
   * Returns `{ page, seasons: [{number,title,url}], episodes: [{number,title,url}] }`.
   */
  async series({ request, response }: HttpContext) {
    const url = String(request.input('url') ?? '').trim()
    const name = String(request.input('name') ?? '').trim()
    if (!url && !name) {
      return response.status(422).json({ success: false, message: 'name_required' })
    }
    try {
      const data = url ? await seasonEpisodes(url) : await seriesByName(name)
      return response.json({ success: true, data })
    } catch (error) {
      return this.fail(response, error)
    }
  }

  /**
   * GET /api/topcinema/resolve?episodeUrl=<url>     (series episode)
   * GET /api/topcinema/resolve?title=<name>&type=movie   (movie)
   *
   * Returns `{ page, sources: [{ quality, label, resolution, sizeMb, url }] }`,
   * highest quality first.
   */
  async resolve({ request, response }: HttpContext) {
    const episodeUrl = String(request.input('episodeUrl') ?? '').trim()
    const type = String(request.input('type') ?? '').trim()
    const title = String(request.input('title') ?? '').trim()

    try {
      if (episodeUrl) {
        const data = await resolveEpisode(episodeUrl)
        return response.json({ success: true, data })
      }
      if (type === 'movie' && title) {
        const data = await resolveMovie(title)
        return response.json({ success: true, data })
      }
      return response.status(422).json({ success: false, message: 'episode_or_movie_required' })
    } catch (error) {
      return this.fail(response, error)
    }
  }

  private fail(response: HttpContext['response'], error: unknown) {
    if (error instanceof TopCinemaError) {
      return response.status(404).json({ success: false, message: error.message })
    }
    return response.status(502).json({ success: false, message: 'topcinema_unavailable' })
  }
}
