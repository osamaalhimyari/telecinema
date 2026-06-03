import Favorite from '#models/favorite'
import { createFavoriteValidator } from '#validators/favorite'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * JSON API for the catalogue favorites, consumed by the Flutter client.
 *
 * Account-less for now: every favorite is global, so the list the app shows is
 * the same for everyone. A favorite stores the raw catalogue JSON of a title
 * (movie or series) so the app can rebuild its poster without re-querying the
 * catalogue. Every response follows the `{ success, message?, data? }` envelope
 * the Flutter `ApiResponse`/`DioApiClient` expects.
 */
export default class FavoritesApiController {
  /** GET /api/favorites — every saved title, most-recently saved first. */
  async index({ response }: HttpContext) {
    const favorites = await Favorite.query().orderBy('id', 'desc')
    return response.json({
      success: true,
      data: { favorites: favorites.map((f) => f.serialize()) },
    })
  }

  /**
   * POST /api/favorites — save a title. Idempotent: saving one already in the
   * list refreshes its stored JSON instead of duplicating (the `media_id`
   * column is unique).
   */
  async store({ request, response }: HttpContext) {
    const { mediaId, mediaType, media } = await request.validateUsing(createFavoriteValidator)

    const payload = JSON.stringify(media)
    const favorite = await Favorite.updateOrCreate({ mediaId }, { mediaId, mediaType, payload })

    return response.json({ success: true, data: { favorite: favorite.serialize() } })
  }

  /** DELETE /api/favorites/:mediaId — remove a saved title. Idempotent. */
  async destroy({ params, response }: HttpContext) {
    const favorite = await Favorite.findBy('media_id', params.mediaId)
    if (favorite) await favorite.delete()
    return response.json({ success: true })
  }
}
