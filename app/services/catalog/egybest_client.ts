/*
|--------------------------------------------------------------------------
| EgyBest / EasyPlex API client
|--------------------------------------------------------------------------
|
| One place that owns the EgyBest catalogue provider's base URL, code segment
| and auth headers — ported verbatim from the Flutter client's `cinema_api.dart`
| so the server now makes these calls instead of the app (which shipped the
| bearer token to every device). The base/code/token all come from `.env`
| (`EGYBEST_BASE`/`EGYBEST_CODE`/`EGYBEST_BEARER`), so they rotate without a code
| change and no link is hard-coded here.
|
| The `code` is a PATH segment appended to every endpoint, not a query/header.
*/

import env from '#start/env'

const BASE = env.get('EGYBEST_BASE')
export const EGYBEST_CODE = env.get('EGYBEST_CODE')

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  packagename: 'com.egyappwatch',
  Authorization: `Bearer ${env.get('EGYBEST_BEARER')}`,
  'User-Agent': 'EasyPlex',
}

const REQUEST_TIMEOUT_MS = 25_000

/**
 * GETs an EgyBest endpoint (path is everything after the base, e.g.
 * `movies/byviews/<code>?page=1`). Returns the parsed object, or null on any
 * non-200 / transport / parse failure (callers treat that as "no data").
 */
export async function egybestGet(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE}/${path}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  } catch {
    return null
  }
}
