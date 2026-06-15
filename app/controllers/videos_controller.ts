import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import app from '@adonisjs/core/services/app'
import Room from '#models/room'
import { ensureRoomTorrent } from '#services/torrent_streamer'
import { resolveYoutubeStream } from '#services/youtube_stream'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Maps a file extension to the matching video MIME type. `.mkv`/`.avi` are
 * served for torrent rooms (the Flutter libmpv player handles them); browsers
 * may not, which is fine since torrent rooms target the app.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
}

/**
 * Parses a single `bytes=START-END` range against a known file size. Returns
 * the clamped, inclusive bounds, or null when the header is absent/malformed
 * (caller then sends the whole file).
 */
function parseRange(rangeHeader: string | undefined, fileSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!match) return null

  let start = match[1] ? Number.parseInt(match[1], 10) : 0
  let end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1
  if (Number.isNaN(start)) start = 0
  if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1
  return { start, end }
}

/**
 * VideosController streams video files out of `storage/videos/` with full
 * HTTP range-request support, so the browser can seek into any part of the
 * file without downloading it from the start.
 */
export default class VideosController {
  async stream({ params, request, response }: HttpContext) {
    /**
     * `basename` strips any directory component, which prevents path
     * traversal (e.g. `../../config/database.ts`) via the filename param.
     */
    const filename = basename(String(params.filename))

    /**
     * In-progress download artifacts are written as dotfiles (e.g.
     * `.yt-<id>.mp4`, `.download-<id>.part`); a finished room video never is.
     * Refuse any dotfile outright so a half-written file can never be streamed,
     * even if its (unguessable) temp name were somehow known.
     */
    if (filename.startsWith('.')) {
      return response.status(404).send('Video file not found')
    }

    const filePath = app.makePath('storage/videos', filename)

    /**
     * Resolve the file size up-front. A missing file results in a 404.
     */
    let fileSize: number
    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) throw new Error('Not a file')
      fileSize = stats.size
    } catch {
      return response.status(404).send('Video file not found')
    }

    const contentType = CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'video/mp4'
    response.header('Content-Type', contentType)
    response.header('Accept-Ranges', 'bytes')
    /**
     * Video data never changes for a given filename, so let the browser
     * cache it aggressively.
     */
    response.header('Cache-Control', 'public, max-age=3600')

    const rangeHeader = request.header('range')

    /**
     * No Range header — send the whole file with a 200 response.
     */
    if (!rangeHeader) {
      response.status(200)
      response.header('Content-Length', String(fileSize))
      return response.stream(createReadStream(filePath))
    }

    /**
     * Parse a single-range request of the form `bytes=START-END`. Either
     * bound may be omitted ("bytes=500-" or "bytes=-1024" style requests).
     */
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (!match) {
      response.status(200)
      response.header('Content-Length', String(fileSize))
      return response.stream(createReadStream(filePath))
    }

    let start = match[1] ? Number.parseInt(match[1], 10) : 0
    let end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1

    if (Number.isNaN(start)) start = 0
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1

    /**
     * An unsatisfiable range gets a 416 response, as required by the spec.
     */
    if (start > end || start < 0 || start >= fileSize) {
      response.status(416)
      response.header('Content-Range', `bytes */${fileSize}`)
      return response.send('Requested range not satisfiable')
    }

    /**
     * 206 Partial Content — stream only the requested byte slice.
     */
    response.status(206)
    response.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    response.header('Content-Length', String(end - start + 1))
    return response.stream(createReadStream(filePath, { start, end }))
  }

  /**
   * GET /stream/:slug — streams a `torrent` room's video straight out of the
   * BitTorrent swarm with HTTP range support, identical in shape to `stream`
   * above but sourced from a live WebTorrent file rather than disk. Pieces are
   * fetched on demand, so playback starts before the download finishes.
   */
  async streamTorrent({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', String(params.slug))
    if (!room || room.roomType !== 'torrent' || !room.magnet) {
      return response.status(404).send('Torrent room not found')
    }

    /**
     * (Re)adds the magnet if needed and waits for metadata. A swarm with no
     * reachable peers can take a while — surface that as 503 so the player can
     * retry rather than treating it as a permanent error.
     */
    let file: Awaited<ReturnType<typeof ensureRoomTorrent>>['file']
    try {
      file = (await ensureRoomTorrent(room)).file
    } catch {
      return response.status(503).send('Torrent is not ready yet')
    }

    const fileSize = file.length
    const contentType = CONTENT_TYPES[extname(file.name).toLowerCase()] ?? 'video/mp4'
    response.header('Content-Type', contentType)
    response.header('Accept-Ranges', 'bytes')
    /** Pieces arrive progressively — never let a proxy cache a partial body. */
    response.header('Cache-Control', 'no-store')

    const range = parseRange(request.header('range'), fileSize)

    /** No (or unparseable) Range header — stream the whole file with a 200. */
    if (!range) {
      response.status(200)
      response.header('Content-Length', String(fileSize))
      return response.stream(file.createReadStream())
    }

    const { start, end } = range
    if (start > end || start < 0 || start >= fileSize) {
      response.status(416)
      response.header('Content-Range', `bytes */${fileSize}`)
      return response.send('Requested range not satisfiable')
    }

    response.status(206)
    response.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    response.header('Content-Length', String(end - start + 1))
    return response.stream(file.createReadStream({ start, end }))
  }

  /**
   * GET /youtube/:slug — proxies a `youtube` room's stream. The room stores the
   * YouTube watch URL; we resolve it to a direct googlevideo URL (yt-dlp -g,
   * cached) and pipe the bytes through, forwarding the client's `Range` header
   * so the player can seek. googlevideo URLs are short-lived and locked to this
   * server's IP, so they are never exposed to clients — only proxied here. A
   * rejected upstream request (expired URL) triggers one re-resolve + retry.
   */
  async streamYoutube({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', String(params.slug))
    if (!room || room.roomType !== 'youtube' || !room.externalUrl) {
      return response.status(404).send('YouTube room not found')
    }
    const watchUrl = room.externalUrl
    const range = request.header('range')

    const fetchUpstream = (direct: string, signal: AbortSignal) =>
      fetch(direct, {
        // googlevideo honours Range; forwarding it lets the player seek. A
        // browser-like UA avoids the odd format that 403s a bare client.
        headers: {
          ...(range ? { Range: range } : {}),
          'User-Agent': 'Mozilla/5.0',
        },
        signal,
      })

    // Abort the upstream fetch if the client goes away mid-stream.
    const controller = new AbortController()
    request.request.on('close', () => controller.abort())

    let direct: string
    try {
      direct = await resolveYoutubeStream(room.slug, watchUrl)
    } catch {
      return response.status(502).send('Could not resolve the YouTube stream')
    }

    let upstream: Response
    try {
      upstream = await fetchUpstream(direct, controller.signal)
      // 403/404/410 ⇒ the cached URL expired or its IP-lock rotated: re-resolve once.
      if (upstream.status === 403 || upstream.status === 404 || upstream.status === 410) {
        direct = await resolveYoutubeStream(room.slug, watchUrl, true)
        upstream = await fetchUpstream(direct, controller.signal)
      }
    } catch {
      return response.status(502).send('YouTube stream is unavailable')
    }

    if (!upstream.ok && upstream.status !== 206) {
      return response.status(502).send('YouTube stream is unavailable')
    }
    if (!upstream.body) {
      return response.status(502).send('YouTube stream returned no data')
    }

    // Relay the upstream's own status (200/206) and range headers verbatim.
    response.status(upstream.status)
    response.header('Content-Type', upstream.headers.get('content-type') ?? 'video/mp4')
    response.header('Accept-Ranges', 'bytes')
    response.header('Cache-Control', 'no-store')
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) response.header('Content-Length', contentLength)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) response.header('Content-Range', contentRange)

    return response.stream(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]))
  }
}
