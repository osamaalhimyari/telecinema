import { fetchCinemetaCatalog, fetchCinemetaDetail, CINEMETA_PAGE_SIZE } from '#services/catalog/cinemeta_client'
import {
  fetchEgybestCatalog,
  fetchEgybestDetail,
  fetchEgybestSeason,
  EGYBEST_PER_PAGE,
} from '#services/catalog/egybest_catalog'
import { normalizeTile, normalizeDetail, normalizeEgybestSeasonEpisodes } from '#services/catalog/normalize'
import type { HttpContext } from '@adonisjs/core/http'

/** Default / max page size for catalogue listings. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

/** Known catalogue sources. */
const SOURCES = ['cinemeta', 'egybest'] as const
type Source = (typeof SOURCES)[number]

/**
 * JSON API for the catalogue, consumed by the Flutter client.
 *
 *   GET /api/catalog                            — list/search titles
 *   GET /api/catalog/:source/:mediaId           — one title's full detail
 *   GET /api/catalog/egybest/season/:seasonId   — one EgyBest season's episodes
 *
 * Every request is served LIVE: the server calls the source's own API directly
 * (Cinemeta / EgyBest) and normalizes the response into one unified shape (see
 * `normalize.ts`), so the client has a single `CatalogItem`/`CatalogDetail`
 * entity regardless of source. Nothing is stored — there is no DB mirror.
 * Envelope is the usual `{ success, message?, data? }`.
 */
export default class CatalogApiController {
  /**
   * GET /api/catalog?source=cinemeta&type=movie&page=1&limit=100&q=<search>
   *
   * Returns `{ items: [tile…] }` of normalized tiles for ONE upstream page.
   * Paging is provider-native: pass `page` (1-based). `skip` is still accepted
   * for back-compat and converted to the source's page. With `q` it searches.
   */
  async index({ request, response }: HttpContext) {
    const source = normalizeSource(request.input('source', 'cinemeta'))
    const type = normalizeType(request.input('type'))
    const q = String(request.input('q', '')).trim()
    const limit = clampLimit(request.input('limit'))
    const skip = Math.max(0, Number.parseInt(String(request.input('skip', '0')), 10) || 0)
    const pageInput = Number.parseInt(String(request.input('page', '0')), 10)
    const page = Number.isFinite(pageInput) && pageInput > 0 ? pageInput : 0

    const search = q.length > 0 ? q : undefined
    const listType = type ?? 'movie'

    let raw: Record<string, unknown>[]
    if (source === 'egybest') {
      const egPage = page > 0 ? page : Math.floor(skip / EGYBEST_PER_PAGE) + 1
      raw = await fetchEgybestCatalog(listType, { page: egPage, search })
    } else {
      const egSkip = page > 0 ? (page - 1) * CINEMETA_PAGE_SIZE : skip
      raw = await fetchCinemetaCatalog(listType, { skip: egSkip, search })
    }

    let items = raw.map((m) => normalizeTile(source, m)).filter((t) => t !== null)
    // Search endpoints can return mixed types — keep only the requested one.
    if (type) items = items.filter((t) => t!.type === type)

    return response.json({ success: true, data: { items: items.slice(0, limit) } })
  }

  /**
   * GET /api/catalog/:source/:mediaId?type=movie
   *
   * Fetches the title's full detail from the source live and returns it as a
   * normalized `{ detail }`, or 404 when the source has no such title.
   */
  async show({ params, request, response }: HttpContext) {
    const source = normalizeSource(params.source)
    const mediaId = String(params.mediaId).trim()
    const type = normalizeType(request.input('type')) ?? 'movie'

    const meta =
      source === 'egybest'
        ? await fetchEgybestDetail(type, mediaId)
        : await fetchCinemetaDetail(type, mediaId)

    if (!meta) {
      return response.status(404).json({ success: false, message: 'catalog_item_not_found' })
    }
    return response.json({ success: true, data: { detail: normalizeDetail(source, meta) } })
  }

  /**
   * GET /api/catalog/egybest/season/:seasonId — one EgyBest season's episodes,
   * fetched live and normalized to `{ episodes: [...] }`.
   */
  async egybestSeason({ params, response }: HttpContext) {
    const seasonId = String(params.seasonId).trim()
    const json = await fetchEgybestSeason(seasonId)
    if (!json) {
      return response.status(502).json({ success: false, message: 'egybest_unavailable' })
    }
    return response.json({ success: true, data: { episodes: normalizeEgybestSeasonEpisodes(json) } })
  }
}

/** Normalizes a requested source to a known one, defaulting to 'cinemeta'. */
function normalizeSource(raw: unknown): Source {
  const s = String(raw ?? '').trim().toLowerCase()
  return (SOURCES as readonly string[]).includes(s) ? (s as Source) : 'cinemeta'
}

/** Normalizes a requested media type to 'movie'/'series', or null for "any". */
function normalizeType(raw: unknown): 'movie' | 'series' | null {
  const t = String(raw ?? '').trim().toLowerCase()
  if (t === 'movie' || t === 'series') return t
  return null
}

/** Clamps a requested page size into [1, MAX_LIMIT], defaulting when unset. */
function clampLimit(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}
