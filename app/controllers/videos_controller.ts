import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Maps a file extension to the matching video MIME type.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
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
}
