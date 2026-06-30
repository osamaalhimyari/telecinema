import { searchOpenSubtitles, downloadOpenSubtitle } from '#services/opensubtitles'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * GET /api/subtitles/search — proxies OpenSubtitles search so the client stops
 * calling rest.opensubtitles.org directly. The result fields already match the
 * app's `SubtitleResult` (id, fileName, langId, langName, format, downloadLink,
 * releaseName, downloadsCount, rating), so the client mapper is unchanged.
 *
 * GET /api/subtitles/download — fetches a chosen result's (gzipped, http) file
 * host link server-side, gunzips + UTF-8-normalizes it, and returns the plain
 * subtitle text, so the device never fetches the external file host directly.
 *
 * Params (search): `imdbId`, `query`, `season`, `episode`, `lang` (ISO 639-2).
 * Attaching a chosen subtitle to a room keeps using the room-scoped routes.
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

  /**
   * GET /api/subtitles/download?url=<SubDownloadLink> — only OpenSubtitles hosts
   * are accepted (SSRF-guarded inside `downloadOpenSubtitle`). Returns the ready
   * UTF-8 subtitle text as `{ data: { content } }`.
   */
  async download({ request, response }: HttpContext) {
    const url = str(request.input('url'))
    if (!url) {
      return response.status(422).json({ success: false, message: 'subtitle_url_required' })
    }
    try {
      const bytes = await downloadOpenSubtitle(url)
      return response.json({ success: true, data: { content: bytes.toString('utf8') } })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'subtitle_download_failed'
      const rejected = message === 'opensubtitles_download_rejected'
      return response.status(rejected ? 400 : 502).json({ success: false, message })
    }
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
