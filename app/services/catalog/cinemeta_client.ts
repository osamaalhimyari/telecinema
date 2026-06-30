/*
|--------------------------------------------------------------------------
| Cinemeta catalogue — live fetchers
|--------------------------------------------------------------------------
|
| Reads the Stremio Cinemeta addon (`CINEMETA_BASE`) straight from the source on
| every request — nothing is mirrored into the DB. Each function returns the raw
| meta JSON in the exact shape `normalize.ts` already maps.
|
|   listing  — `/catalog/{type}/top.json` (paged by `skip`)   → `{ metas: [meta…] }`
|   search   — `/catalog/{type}/top/search=<q>.json`          → `{ metas: [meta…] }`
|   detail   — `/meta/{type}/{id}.json`                        → `{ meta: {…} }`
|
| `/catalog/...` 307-redirects to `cinemeta-catalogs.strem.io`; we follow it.
*/

import env from '#start/env'

const REQUEST_TIMEOUT_MS = 20_000

/** Cinemeta returns up to 100 metas per catalogue page; skip advances by page. */
export const CINEMETA_PAGE_SIZE = 100

function base(): string {
  return env.get('CINEMETA_BASE')
}

/**
 * Builds a catalogue URL for a type, optionally filtered by a `search` extra or
 * paged by `skip`. Extras live in one path segment, e.g.
 * `/catalog/movie/top/search=inception.json` or `/catalog/movie/top/skip=100.json`.
 * With no extras it collapses to `/catalog/movie/top.json`.
 */
function catalogUrl(type: string, opts: { skip?: number; search?: string }): string {
  const search = opts.search?.trim()
  const extra = search
    ? `search=${encodeURIComponent(search)}`
    : opts.skip && opts.skip > 0
      ? `skip=${opts.skip}`
      : ''
  return extra
    ? `${base()}/catalog/${type}/top/${extra}.json`
    : `${base()}/catalog/${type}/top.json`
}

/** Fetches + parses a Cinemeta JSON document, or null on any failure. */
async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (json && typeof json === 'object') return json as Record<string, unknown>
  } catch {
    /* network/timeout/parse error — treated as "no data" */
  }
  return null
}

export interface CinemetaCatalogQuery {
  /** Offset into the listing (provider-native; advances by ~100). */
  skip?: number
  /** Free-text search — uses the search endpoint instead of the listing. */
  search?: string
}

/**
 * Fetches one page of Cinemeta metas: the "top" listing for the type, or a title
 * search when `search` is set. Returns the raw metas (best-effort — [] on any
 * failure), to be normalized by the caller.
 */
export async function fetchCinemetaCatalog(
  type: string,
  query: CinemetaCatalogQuery = {}
): Promise<Record<string, unknown>[]> {
  const normalizedType = type === 'series' ? 'series' : 'movie'
  const json = await fetchJson(catalogUrl(normalizedType, query))
  return Array.isArray(json?.metas) ? (json!.metas as Record<string, unknown>[]) : []
}

/**
 * Fetches a single title's full detail (`/meta/{type}/{id}.json`). Returns the
 * raw `meta` object (which includes `videos[]` for series episodes), or null if
 * missing.
 */
export async function fetchCinemetaDetail(
  type: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const normalizedType = type === 'series' ? 'series' : 'movie'
  const json = await fetchJson(`${base()}/meta/${normalizedType}/${encodeURIComponent(id)}.json`)
  const meta = json?.meta
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
}
