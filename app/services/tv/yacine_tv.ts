/*
|--------------------------------------------------------------------------
| YacineTV live-TV catalogue
|--------------------------------------------------------------------------
|
| Fetches the YacineTV channel tree server-side so the app never talks to the
| provider directly — the device only ever talks to this server (the same rule
| the catalogue, streams and topcinema sources already follow). The fetched tree
| is cached in memory for a short window and shared across every client, so one
| upstream request serves the whole fleet instead of each device hammering the
| provider.
|
| The tree is returned in the provider's own shape (`{ categories: [...] }`) so
| the Flutter client's existing parser is unchanged — only the transport moved
| from a direct provider call to this endpoint. The per-channel stream URLs carry
| short-lived signed tokens, so a `forceRefresh` (the client's token-refresh
| path) bypasses the cache to pull fresh, playable links.
|
| The provider gates the request on a fixed `User-Agent` only (no token/API key).
*/

/** Where the YacineTV tree lives, and the UA the provider requires. */
const TREE_URL = 'https://ostoraapptv.com/yacine_tree.json'
const HEADERS = { 'User-Agent': 'FlutterApp/1.0 (YacineTV)' }
const REQUEST_TIMEOUT_MS = 25_000

/**
 * How long a fetched tree is reused for ordinary browsing. Short enough that a
 * client rarely lands on an already-expired token; the token-refresh path forces
 * a fresh fetch regardless.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

/** A YacineTV tree document — the provider's native `{ categories: [...] }`. */
export type YacineTree = Record<string, unknown>

/** Raised when the provider can't be reached or returns something unusable. */
export class YacineTvError extends Error {}

let cache: { at: number; data: YacineTree } | null = null

/**
 * Returns the YacineTV channel tree, from the in-memory cache when fresh.
 * [forceRefresh] bypasses the cache to renew the short-lived per-channel stream
 * tokens (used by the client's token-refresh path). Throws [YacineTvError] on a
 * provider failure.
 */
export async function fetchYacineTree(forceRefresh = false): Promise<YacineTree> {
  const now = Date.now()
  const cached = cache
  if (!forceRefresh && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.data
  }

  let res: Response
  try {
    res = await fetch(TREE_URL, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new YacineTvError('tv_unavailable')
  }
  if (!res.ok) throw new YacineTvError('tv_unavailable')

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new YacineTvError('tv_unavailable')
  }

  if (!json || typeof json !== 'object' || !Array.isArray((json as YacineTree).categories)) {
    throw new YacineTvError('tv_unavailable')
  }

  const data = json as YacineTree
  cache = { at: now, data }
  return data
}
