import { searchOpenSubtitles } from '#services/opensubtitles'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * GET /api/subtitles/search — proxies OpenSubtitles search so the client stops
 * calling rest.opensubtitles.org directly. The result fields already match the
 * app's `SubtitleResult` (id, fileName, langId, langName, format, downloadLink,
 * releaseName, downloadsCount, rating), so the client mapper is unchanged.
 *
 * Params: `imdbId`, `query`, `season`, `episode`, `lang` (ISO 639-2, e.g. `ara`).
 * Downloading/attaching a chosen subtitle keeps using the room-scoped routes.
 */
export default class SubtitlesApiController {
  async search({ request, response }: HttpContext) {
    const imdbId = str(request.input('imdbId'))
    const query = str(request.input('query'))
    const season = int(request.input('season'))
    const episode = int(request.input('episode'))
    const lang = str(request.input('lang')) ?? 'eng'

    if (!imdbId && !query) {
      return response.status(422).json({ success: false, message: 'subtitle_query_required' })
    }

    const results = await searchOpenSubtitles({ imdbId, query, season, episode, lang })
    return response.json({ success: true, data: { results } })
  }
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim()
  return s.length > 0 ? s : undefined
}

function int(v: unknown): number | undefined {
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : undefined
}
