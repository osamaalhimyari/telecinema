import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import Room from '#models/room'
import { createRoomValidator } from '#validators/room'
import { getViewerCount, dropRoom, io } from '#start/socket'
import { startUrlDownload, getJob } from '#services/video_downloader'
import { startTorrentRoom, getTorrentJob, removeRoomTorrent } from '#services/torrent_streamer'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import type { HttpContext } from '@adonisjs/core/http'

/** Accepted extensions for subtitle uploads. */
const SUBTITLE_EXTENSIONS = ['srt', 'vtt']
const MAX_SUBTITLE_SIZE = '2mb'

/** Accepted video container extensions for uploaded room videos. */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov']
const MAX_VIDEO_SIZE = '15gb'

/**
 * URL-safe slug from a free-text room name — a twin of the helper in
 * RoomsController so the JSON API derives slugs identically.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * JSON API for the watch-party rooms, consumed by the Flutter client.
 *
 * It is a thin, **stateless** mirror of the server-rendered RoomsController:
 * the web app gates a protected room through a session flag, but a mobile
 * client has no session — so `unlock` here only *verifies* the password and
 * the app remembers the success locally. The realtime sync, chat, presence
 * and voice all run over the same Socket.io protocol the web client uses; this
 * controller only owns the room catalogue and lifecycle over HTTP.
 *
 * Every response follows the `{ success, message?, data? }` envelope the
 * Flutter `ApiResponse`/`DioApiClient` expects.
 */
export default class RoomsApiController {
  /** Serializes a room into the JSON the app consumes (filenames + computed). */
  private serialize(room: Room) {
    return {
      ...room.serialize(),
      viewerCount: getViewerCount(room.slug),
    }
  }

  /** GET /api/rooms — every available room, oldest first (matches the web grid). */
  async index({ response }: HttpContext) {
    const rooms = await Room.query().orderBy('id', 'asc')
    return response.json({
      success: true,
      data: { rooms: rooms.map((r) => this.serialize(r)) },
    })
  }

  /** GET /api/rooms/:slug — a single room, or 404. */
  async show({ params, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
    }
    return response.json({ success: true, data: { room: this.serialize(room) } })
  }

  /**
   * POST /api/rooms/:slug/unlock — verify a room password. Stateless: returns
   * `{ success: true }` when the password matches so the client can proceed;
   * 403 otherwise. Open rooms always succeed.
   */
  async unlock({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
    }
    if (!room.hasPassword) {
      return response.json({ success: true })
    }

    const password = String(request.input('password') ?? '')
    if (room.passwordHash && (await hash.verify(room.passwordHash, password))) {
      return response.json({ success: true })
    }
    return response.status(403).json({ success: false, message: 'incorrect_password' })
  }

  /**
   * POST /api/rooms — create a room. Mirrors the three web flows:
   *   - `download` → starts a background fetch; returns a `jobId` to poll.
   *   - `torrent`  → starts a background swarm add; returns a `jobId` to poll.
   *   - `upload`   → multipart video file; returns the created room.
   */
  async store({ request, response }: HttpContext) {
    const { name, password, roomType, videoUrl, magnet, reactions } =
      await request.validateUsing(createRoomValidator)

    const fail = (message: string, status = 422) =>
      response.status(status).json({ success: false, message })

    // ---- download from a link ------------------------------------------
    if (roomType === 'download') {
      if (!videoUrl) return fail('Please paste a link to the video file.')
      try {
        const jobId = startUrlDownload({
          name,
          password: password ?? null,
          url: videoUrl,
          reactions: reactions ?? null,
        })
        return response.json({ success: true, data: { jobId } })
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'That link could not be used.')
      }
    }

    // ---- magnet / torrent stream ---------------------------------------
    if (roomType === 'torrent') {
      if (!magnet) return fail('Please paste a magnet link.')
      try {
        const jobId = startTorrentRoom({
          name,
          password: password ?? null,
          magnet,
          reactions: reactions ?? null,
        })
        return response.json({ success: true, data: { jobId } })
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'torrent_invalid_magnet')
      }
    }

    // ---- direct upload --------------------------------------------------
    const video = request.file('video', { size: MAX_VIDEO_SIZE, extnames: VIDEO_EXTENSIONS })
    if (!video) return fail('Please choose a video file to upload.')
    if (!video.isValid) {
      return fail(video.errors[0]?.message ?? 'The uploaded file is not a supported video.')
    }

    const slug = await this.uniqueSlug(name)
    const videoFilename = `${slug}.${(video.extname || 'mp4').toLowerCase()}`
    try {
      await video.move(app.makePath('storage/videos'), { name: videoFilename, overwrite: true })
    } catch {
      return fail('The video could not be saved. Please try again.', 500)
    }

    const room = await Room.create({
      name,
      slug,
      videoFilename,
      thumbnailFilename: '',
      roomType: 'upload',
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
      reactions: reactions ?? null,
    })
    return response.json({ success: true, data: { room: this.serialize(room) } })
  }

  /**
   * GET /api/rooms/download/:jobId — progress of a link-based room creation.
   * Once `status` is `done`, `slug` points at the finished room.
   */
  async downloadProgress({ params, response }: HttpContext) {
    const jobId = String(params.jobId)

    /**
     * A torrent room shares this poll: it reaches `done` (with its slug) once
     * the swarm metadata is in and the room row exists — playback streams from
     * there, so there is no download bar to wait on.
     */
    const torrentJob = getTorrentJob(jobId)
    if (torrentJob) {
      return response.json({
        success: true,
        data: {
          status: torrentJob.status,
          percent: torrentJob.percent,
          bytesDownloaded: torrentJob.bytesDownloaded,
          totalBytes: torrentJob.totalBytes,
          error: torrentJob.error,
          slug: torrentJob.slug,
        },
      })
    }

    const job = getJob(jobId)
    if (!job) {
      return response
        .status(404)
        .json({ success: false, message: 'That download is no longer available.' })
    }
    const slug =
      job.status === 'done' && job.redirectTo ? job.redirectTo.replace('/room/', '') : null
    return response.json({
      success: true,
      data: {
        status: job.status,
        percent: job.percent,
        bytesDownloaded: job.bytesDownloaded,
        totalBytes: job.totalBytes,
        error: job.error,
        slug,
      },
    })
  }

  /**
   * DELETE /api/rooms/:slug — delete a room and its files. Protected rooms
   * require the password in the body, and a room can only be torn down once
   * nobody else is watching (the requester counts as one viewer).
   */
  async destroy({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
    }

    if (room.passwordHash) {
      const password = String(request.input('password') ?? '')
      if (!(await hash.verify(room.passwordHash, password))) {
        return response.status(403).json({ success: false, message: 'incorrect_password' })
      }
    }

    if (getViewerCount(room.slug) > 1) {
      return response.status(409).json({ success: false, message: 'room_not_empty' })
    }

    if (room.roomType === 'torrent') {
      /** Tear down the swarm and delete its cached pieces under storage/torrents. */
      removeRoomTorrent(room)
    } else if (room.videoFilename) {
      try {
        await unlink(app.makePath('storage/videos', basename(room.videoFilename)))
      } catch {
        /* already gone */
      }
    }
    if (room.subtitleFilename) {
      try {
        await unlink(app.makePath('storage/subtitles', basename(room.subtitleFilename)))
      } catch {
        /* already gone */
      }
    }

    dropRoom(room.slug)
    await room.delete()
    return response.json({ success: true })
  }

  /**
   * POST /api/rooms/:slug/subtitle — upload an SRT/VTT for an external room.
   * Replaces any previous subtitle and notifies the room over the socket.
   */
  async uploadSubtitle({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
    }
    if (room.roomType !== 'external') {
      return response
        .status(400)
        .json({ success: false, message: 'subtitles_external_only' })
    }

    const subtitle = request.file('subtitle', {
      size: MAX_SUBTITLE_SIZE,
      extnames: SUBTITLE_EXTENSIONS,
    })
    if (!subtitle) return response.status(400).json({ success: false, message: 'no_subtitle_file' })
    if (!subtitle.isValid) {
      return response
        .status(400)
        .json({ success: false, message: subtitle.errors[0]?.message ?? 'subtitle_rejected' })
    }

    if (room.subtitleFilename) {
      try {
        await unlink(app.makePath('storage/subtitles', basename(room.subtitleFilename)))
      } catch {
        /* already gone */
      }
    }

    const ext = (subtitle.extname || 'srt').toLowerCase()
    const filename = `${room.slug}.${ext}`
    try {
      await subtitle.move(app.makePath('storage/subtitles'), { name: filename, overwrite: true })
    } catch {
      return response.status(500).json({ success: false, message: 'subtitle_save_failed' })
    }

    room.subtitleFilename = filename
    await room.save()
    io?.to(room.slug).emit('subtitle_changed', { filename })

    return response.json({ success: true, data: { filename } })
  }

  /** Derives a unique slug from a room name, mirroring the web controller. */
  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'room'
    let slug = base
    while (await Room.findBy('slug', slug)) {
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
    }
    return slug
  }
}
