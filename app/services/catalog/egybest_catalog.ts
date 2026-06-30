/*
|--------------------------------------------------------------------------
| EgyBest catalogue — live fetchers
|--------------------------------------------------------------------------
|
| Reads the EgyBest / EasyPlex catalogue straight from the provider on every
| request — nothing is mirrored into the DB. Each function returns the raw
| tile/detail JSON in the exact shape `normalize.ts` already maps, so the client
| renders the same entities it did when these came from the app directly.
|
|   listing  — `{movies|series}/byviews/<code>?page=N`   → `{ data: [tile…] }`
|   search   — `search/<query>/<code>?page=N`            → `{ search: [tile…] }`
|   movie    — `media/detail/<id>/<code>`                → servers inline (videos[])
|   series   — `series/show/<id>/<code>`                 → seasons[]
|   season   — `series/season/<id>/<code>`               → episodes[] (servers inline)
*/

import { egybestGet, EGYBEST_CODE } from '#services/catalog/egybest_client'

/** EgyBest serves 12 tiles per listing page. */
export const EGYBEST_PER_PAGE = 12

/** Coerces a value to a positive int, or 0. */
function asInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

export interface EgybestCatalogQuery {
  /** 1-based listing page (provider-native, 12 tiles each). */
  page?: number
  /** Free-text search — uses the search endpoint instead of the listing. */
  search?: string
}

/**
 * Fetches one page of EgyBest tiles: the most-watched listing for the type, or a
 * title search when `search` is set. Returns the raw tiles (best-effort — [] on
 * any failure), to be normalized by the caller.
 */
export async function fetchEgybestCatalog(
  type: string,
  query: EgybestCatalogQuery = {}
): Promise<Record<string, unknown>[]> {
  const page = Math.max(1, query.page ?? 1)
  const search = query.search?.trim()

  if (search) {
    const json = await egybestGet(`search/${encodeURIComponent(search)}/${EGYBEST_CODE}?page=${page}`)
    return Array.isArray(json?.search) ? (json!.search as Record<string, unknown>[]) : []
  }

  const listing = type === 'series' ? 'series' : 'movies'
  const json = await egybestGet(`${listing}/byviews/${EGYBEST_CODE}?page=${page}`)
  return Array.isArray(json?.data) ? (json!.data as Record<string, unknown>[]) : []
}

/**
 * Fetches a title's full detail: movie → `media/detail/{id}` (servers inline as
 * `videos[]`); series → `series/show/{id}` (seasons; per-season episodes+servers
 * are fetched on demand by {@link fetchEgybestSeason}). Returns the raw object,
 * or null if missing.
 */
export async function fetchEgybestDetail(
  mediaType: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const path =
    mediaType === 'series'
      ? `series/show/${encodeURIComponent(id)}/${EGYBEST_CODE}`
      : `media/detail/${encodeURIComponent(id)}/${EGYBEST_CODE}`
  const json = await egybestGet(path)
  if (!json) return null
  // EgyBest puts the title id at the top level; 0 means an error envelope.
  if (asInt(json.id) === 0) return null
  return json
}

/** Fetches one EgyBest season's episodes (servers inline) — used on demand. */
export async function fetchEgybestSeason(seasonId: string): Promise<Record<string, unknown> | null> {
  return egybestGet(`series/season/${encodeURIComponent(seasonId)}/${EGYBEST_CODE}`)
}
