import { resolveMovie, IwaatchError } from '#services/iwaatch/iwaatch_scraper'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * JSON API for the ISOLATED "iwaatch direct link" source.
 *
 *   GET /api/iwaatch/resolve?title=<name>   — resolve a movie (by editable
 *                                             name/slug) to direct video links
 *
 * iwaatch.com is geo/DNS-blocked for the client but reachable from the server,
 * so resolution runs here (the inverse of the on-device topcinema scraper). The
 * Flutter client feeds a chosen link into the normal Create Room flow. Responses
 * follow the `{ success, message?, data? }` envelope.
 *
 * Series are not yet available on iwaatch ("coming soon"), so only movies are
 * supported.
 */
export default class IwaatchApiController {
  /**
   * GET /api/iwaatch/resolve?title=<name>
   *
   * Returns `{ page, sources: [{ quality, label, url, kind, resolution, subtitle }] }`,
   * highest quality first.
   */
  async resolve({ request, response }: HttpContext) {
    const title = String(request.input('title') ?? '').trim()
    if (!title) {
      return response.status(422).json({ success: false, message: 'title_required' })
    }
    try {
      const data = await resolveMovie(title)
      return response.json({ success: true, data })
    } catch (error) {
      if (error instanceof IwaatchError) {
        return response.status(404).json({ success: false, message: error.message })
      }
      return response.status(502).json({ success: false, message: 'iwaatch_unavailable' })
    }
  }
}
