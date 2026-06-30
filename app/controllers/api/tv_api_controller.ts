import { fetchYacineTree, YacineTvError } from '#services/tv/yacine_tv'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * GET /api/tv/tree — the YacineTV live-TV channel tree, fetched + cached
 * server-side so the app stops calling the provider directly. Returns the tree
 * in the provider's native `{ categories: [...] }` shape (the client parser is
 * unchanged) under the standard `{ success, data }` envelope.
 *
 *   GET /api/tv/tree            — cached tree (fast; shared across clients)
 *   GET /api/tv/tree?refresh=1  — force a fresh fetch to renew expired stream
 *                                 tokens (the client's token-refresh path)
 */
export default class TvApiController {
  async tree({ request, response }: HttpContext) {
    const forceRefresh = isTruthy(request.input('refresh'))
    try {
      const data = await fetchYacineTree(forceRefresh)
      return response.json({ success: true, data })
    } catch (error) {
      if (error instanceof YacineTvError) {
        return response.status(502).json({ success: false, message: error.message })
      }
      return response.status(502).json({ success: false, message: 'tv_unavailable' })
    }
  }
}

/** Treats `1`/`true`/`yes` (any case) as true; everything else as false. */
function isTruthy(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}
