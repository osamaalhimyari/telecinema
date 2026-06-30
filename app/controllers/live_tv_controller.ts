import type { HttpContext } from '@adonisjs/core/http'
import Room from '#models/room'

/**
 * Server-side HLS relay for live-TV (`tv`) rooms — and ad-hoc single-user
 * previews.
 *
 * The channel stream hosts are blocked by some ISPs (the device gets an HTML
 * block page instead of an m3u8) and require per-channel `User-Agent`/`Referer`
 * headers. This relay fetches the playlist + segments **from the server** (whose
 * network can reach them) with those headers, rewrites every sub-URL to point
 * back through here, and serves it to the app — so the device only ever talks to
 * this server, which the ISP allows.
 *
 *   GET /livetv/:slug          → a room's playlist (master or media), rewritten
 *   GET /livetv/:slug/p?u=…    → a room's sub-resource (variant / segment / key)
 *   GET /livetv/preview?u=…&h=…    → preview a channel before making a room
 *   GET /livetv/preview/p?u=…&h=…  → a preview's sub-resource
 *
 * The room's packed `externalUrl` (stream URL + headers + channel path) is read
 * fresh on every request, so when a client re-resolves an expired token and
 * pushes it via `POST /api/rooms/:slug/stream`, the relay immediately uses it.
 * Previews are stateless: the stream URL + headers ride in the query string
 * (`u` = base64url(url), `h` = base64url(json headers)) so no room is needed.
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

  /** Decodes a base64url-encoded query value to its UTF-8 string, or null. */
  private decode(raw: unknown): string | null {
    const s = String(raw ?? '')
    if (!s) return null
    try {
      return Buffer.from(s, 'base64url').toString('utf8')
    } catch {
      return null
    }
  }

  /** Decodes the `h` headers param (`base64url(json{...})`) into a header map. */
  private decodeHeaders(raw: unknown): Record<string, string> {
    const json = this.decode(raw)
    if (!json) return {}
    try {
      const meta = JSON.parse(json)
      const headers: Record<string, string> = {}
      if (meta && typeof meta === 'object') {
        for (const [k, v] of Object.entries(meta)) headers[k] = String(v)
      }
      return headers
    } catch {
      return {}
    }
  }

  // ── Room relay ─────────────────────────────────────────────────────────────

  /** GET /livetv/:slug — entry playlist for the room. */
  async index({ params, response }: HttpContext) {
    const live = await this.live(params.slug)
    if (!live) return response.status(404).json({ success: false, message: 'not_a_tv_room' })
    const slug = params.slug
    return this.proxy(response, live.url, live.headers, null, (abs) =>
      `/livetv/${slug}/p?u=${Buffer.from(abs, 'utf8').toString('base64url')}`
    )
  }

  /** GET /livetv/:slug/p?u=<base64url> — a proxied sub-resource. */
  async part({ params, request, response }: HttpContext) {
    const live = await this.live(params.slug)
    if (!live) return response.status(404).json({ success: false, message: 'not_a_tv_room' })

    const target = this.decode(request.input('u'))
    if (!target || !/^https?:\/\//i.test(target)) {
      return response.status(400).json({ success: false, message: 'bad_url' })
    }
    const slug = params.slug
    return this.proxy(response, target, live.headers, request.header('range') ?? null, (abs) =>
      `/livetv/${slug}/p?u=${Buffer.from(abs, 'utf8').toString('base64url')}`
    )
  }

  // ── Stateless preview relay ─────────────────────────────────────────────────

  /** GET /livetv/preview?u=<base64url(url)>&h=<base64url(json headers)>. */
  async preview({ request, response }: HttpContext) {
    const url = this.decode(request.input('u'))
    if (!url || !/^https?:\/\//i.test(url)) {
      return response.status(400).json({ success: false, message: 'bad_url' })
    }
    const headers = this.decodeHeaders(request.input('h'))
    const hParam = encodeURIComponent(String(request.input('h') ?? ''))
    return this.proxy(response, url, headers, request.header('range') ?? null, (abs) =>
      `/livetv/preview/p?u=${Buffer.from(abs, 'utf8').toString('base64url')}&h=${hParam}`
    )
  }

  /** GET /livetv/preview/p?u=<base64url(absUrl)>&h=<base64url(json headers)>. */
  async previewPart({ request, response }: HttpContext) {
    const target = this.decode(request.input('u'))
    if (!target || !/^https?:\/\//i.test(target)) {
      return response.status(400).json({ success: false, message: 'bad_url' })
    }
    const headers = this.decodeHeaders(request.input('h'))
    const hParam = encodeURIComponent(String(request.input('h') ?? ''))
    return this.proxy(response, target, headers, request.header('range') ?? null, (abs) =>
      `/livetv/preview/p?u=${Buffer.from(abs, 'utf8').toString('base64url')}&h=${hParam}`
    )
  }

  // ── Core proxy ──────────────────────────────────────────────────────────────

  /**
   * Fetches [target] with the channel headers. If it's a playlist, rewrites all
   * sub-URLs back through this relay (via [encSub]); otherwise streams the bytes
   * (segment/key).
   */
  private async proxy(
    response: HttpContext['response'],
    target: string,
    headers: Record<string, string>,
    range: string | null,
    encSub: (absoluteUrl: string) => string
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
      return response.send(this.rewrite(text, target, encSub))
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
   * `URI="…"` of `#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` — back through this
   * relay via [encSub]. Relative URLs are resolved against [baseUrl] first.
   */
  private rewrite(playlist: string, baseUrl: string, encSub: (absoluteUrl: string) => string): string {
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
          return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${encSub(resolve(uri))}"`)
        }
        // A bare URL line: a segment or a sub-playlist.
        return encSub(resolve(t))
      })
      .join('\n')
  }
}
