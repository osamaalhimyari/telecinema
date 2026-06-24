import type { HttpContext } from '@adonisjs/core/http'
import Room from '#models/room'

/**
 * Server-side HLS relay for live-TV (`tv`) rooms.
 *
 * The channel stream hosts are blocked by some ISPs (the device gets an HTML
 * block page instead of an m3u8) and require per-channel `User-Agent`/`Referer`
 * headers. This relay fetches the playlist + segments **from the server** (whose
 * network can reach them) with those headers, rewrites every sub-URL to point
 * back through here, and serves it to the app — so the device only ever talks to
 * this server, which the ISP allows.
 *
 *   GET /livetv/:slug         → the room's playlist (master or media), rewritten
 *   GET /livetv/:slug/p?u=…   → any sub-resource (variant playlist / segment / key)
 *
 * The room's packed `externalUrl` (stream URL + headers + channel path) is read
 * fresh on every request, so when a client re-resolves an expired token and
 * pushes it via `POST /api/rooms/:slug/stream`, the relay immediately uses it.
 */
export default class LiveTvController {
  /** A desktop UA fallback when a channel carries none. */
  private static readonly FALLBACK_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

  private static readonly FETCH_TIMEOUT_MS = 20000

  /** Unpacks a `tv` room's `externalUrl` (`<url>#tv=<base64url(json{h,p})>`). */
  private unpack(externalUrl: string | null): { url: string; headers: Record<string, string> } | null {
    if (!externalUrl) return null
    const i = externalUrl.indexOf('#tv=')
    if (i < 0) return { url: externalUrl, headers: {} }
    const url = externalUrl.slice(0, i)
    try {
      const meta = JSON.parse(Buffer.from(externalUrl.slice(i + 4), 'base64url').toString('utf8'))
      const headers: Record<string, string> = {}
      if (meta?.h && typeof meta.h === 'object') {
        for (const [k, v] of Object.entries(meta.h)) headers[k] = String(v)
      }
      return { url, headers }
    } catch {
      return { url, headers: {} }
    }
  }

  /** Resolves the room + its current stream headers, or null. */
  private async live(slug: string) {
    const room = await Room.findBy('slug', slug)
    if (!room || room.roomType !== 'tv') return null
    return this.unpack(room.externalUrl)
  }

  /** GET /livetv/:slug — entry playlist for the room. */
  async index({ params, response }: HttpContext) {
    const live = await this.live(params.slug)
    if (!live) return response.status(404).json({ success: false, message: 'not_a_tv_room' })
    return this.proxy(response, params.slug, live.url, live.headers, null)
  }

  /** GET /livetv/:slug/p?u=<base64url> — a proxied sub-resource. */
  async part({ params, request, response }: HttpContext) {
    const live = await this.live(params.slug)
    if (!live) return response.status(404).json({ success: false, message: 'not_a_tv_room' })

    const u = String(request.input('u') ?? '')
    let target: string
    try {
      target = Buffer.from(u, 'base64url').toString('utf8')
    } catch {
      return response.status(400).json({ success: false, message: 'bad_url' })
    }
    if (!/^https?:\/\//i.test(target)) {
      return response.status(400).json({ success: false, message: 'bad_url' })
    }
    return this.proxy(response, params.slug, target, live.headers, request.header('range') ?? null)
  }

  /**
   * Fetches [target] with the channel headers. If it's a playlist, rewrites all
   * sub-URLs back through this relay; otherwise streams the bytes (segment/key).
   */
  private async proxy(
    response: HttpContext['response'],
    slug: string,
    target: string,
    headers: Record<string, string>,
    range: string | null
  ) {
    const reqHeaders: Record<string, string> = { 'User-Agent': LiveTvController.FALLBACK_UA, ...headers }
    if (range) reqHeaders['Range'] = range

    let upstream: Response
    try {
      upstream = await fetch(target, {
        headers: reqHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(LiveTvController.FETCH_TIMEOUT_MS),
      })
    } catch {
      return response.status(502).json({ success: false, message: 'upstream_unreachable' })
    }

    const contentType = upstream.headers.get('content-type') ?? ''
    const looksLikePlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(target)

    if (looksLikePlaylist) {
      const text = await upstream.text()
      // A block page / error returns HTML, not a playlist — surface it so the
      // client treats it as a failure (and triggers an on-device token refresh).
      if (!text.trimStart().startsWith('#EXTM3U')) {
        return response.status(502).json({ success: false, message: 'not_a_playlist' })
      }
      response.header('content-type', 'application/vnd.apple.mpegurl')
      response.header('cache-control', 'no-cache, no-store')
      return response.send(this.rewrite(text, target, slug))
    }

    // Binary (segment / encryption key / init segment): relay the bytes through.
    const body = Buffer.from(await upstream.arrayBuffer())
    response.status(upstream.status)
    if (contentType) response.header('content-type', contentType)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) response.header('content-range', contentRange)
    const acceptRanges = upstream.headers.get('accept-ranges')
    if (acceptRanges) response.header('accept-ranges', acceptRanges)
    response.header('cache-control', 'no-cache, no-store')
    return response.send(body)
  }

  /**
   * Rewrites every URL in an m3u8 — segment lines, sub-playlist lines, and the
   * `URI="…"` of `#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` — to route back
   * through `/livetv/:slug/p`. Relative URLs are resolved against [baseUrl].
   */
  private rewrite(playlist: string, baseUrl: string, slug: string): string {
    const enc = (abs: string) => `/livetv/${slug}/p?u=${Buffer.from(abs, 'utf8').toString('base64url')}`
    const resolve = (ref: string) => {
      try {
        return new URL(ref, baseUrl).toString()
      } catch {
        return ref
      }
    }
    return playlist
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim()
        if (t.length === 0) return line
        if (t.startsWith('#')) {
          // Rewrite any embedded URI="…" (keys, init segments, alt renditions).
          return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${enc(resolve(uri))}"`)
        }
        // A bare URL line: a segment or a sub-playlist.
        return enc(resolve(t))
      })
      .join('\n')
  }
}
