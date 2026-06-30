import { unlink, readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import Room from '#models/room'
import { createRoomValidator } from '#validators/room'
import { getViewerCount, dropRoom, io, broadcastVoiceMessage } from '#start/socket'
import {
  startUrlDownload,
  getJob,
  listDownloadJobs,
  cancelDownloadJob,
} from '#services/video_downloader'
import {
  startTorrentRoom,
  startMagnetDownload,
  getTorrentJob,
  removeRoomTorrent,
  listTorrentJobs,
  cancelTorrentJob,
} from '#services/torrent_streamer'
import {
  startYoutubeDownload,
  getYoutubeJob,
  listYoutubeJobs,
  cancelYoutubeJob,
  isYoutubeUrl,
} from '#services/youtube_downloader'
import { resolveYoutubeStream, dropYoutubeStream } from '#services/youtube_stream'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import type { HttpContext } from '@adonisjs/core/http'

/** Accepted extensions for subtitle uploads. */
const SUBTITLE_EXTENSIONS = ['srt', 'vtt']
const MAX_SUBTITLE_SIZE = '2mb'

/** Accepted extensions for chat voice clips (the app records AAC-LC `.m4a`; the
 *  rest cover other recorder backends). */
const VOICE_EXTENSIONS = ['m4a', 'aac', 'mp4', 'mp3', 'ogg', 'oga', 'opus', 'webm', 'wav', '3gp', 'caf']
const MAX_VOICE_SIZE = '10mb'

/**
 * Re-encodes a subtitle file's bytes to UTF-8 so non-Latin text (notably
 * Arabic) renders correctly on every client instead of showing as garbled
 * symbols. Many `.srt` files in the wild — Arabic ones especially — are saved
 * in the legacy Windows-1256 codepage; both render paths (libmpv tracks and the
 * embed overlay) expect UTF-8.
 *
 * Strategy: keep the bytes if they already decode as valid UTF-8 (the common
 * case, including plain ASCII); otherwise decode them as Windows-1256 and
 * return UTF-8. Node ships full-ICU, so the `windows-1256` decoder is built in
 * — no extra dependency. A leading UTF-8 BOM, if present, is stripped.
 */
function normalizeSubtitleToUtf8(input: Buffer): Buffer {
  let buf = input
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return Buffer.from(text, 'utf-8')
  } catch {
    try {
      const text = new TextDecoder('windows-1256').decode(buf)
      return Buffer.from(text, 'utf-8')
    } catch {
      /* Unknown decoder on this build — leave the bytes untouched. */
      return buf
    }
  }
}

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
    const rooms = await Room.query().orderBy('id', 'desc')
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
    const {
      name,
      password,
      roomType,
      videoUrl,
      magnet,
      reactions,
      category,
      imdbId,
      maxHeight,
      thumbnail,
    } = await request.validateUsing(createRoomValidator)

    // Stable per-install id sent by the mobile client, so a long-running
    // download/torrent it kicks off can be listed and cancelled later — even
    // after a socket reconnect changes its realtime token.
    const deviceId = request.header('x-device-id') ?? null

    const fail = (message: string, status = 422) =>
      response.status(status).json({ success: false, message })

    // ---- youtube stream (no download) ----------------------------------
    // A pasted YouTube link is played by streaming: the watch URL is stored and
    // resolved on demand to a direct googlevideo stream, proxied over
    // `/youtube/:slug`. Created synchronously (nothing to download), but we
    // resolve once up front to validate the link and warm the cache; a link
    // that can't be resolved never leaves a dead room behind.
    if (roomType === 'youtube') {
      if (!videoUrl || !isYoutubeUrl(videoUrl)) return fail('Please paste a YouTube link.')
      const slug = await this.uniqueSlug(name)
      const room = await Room.create({
        name,
        slug,
        videoFilename: '',
        externalUrl: videoUrl,
        thumbnailFilename: thumbnail ?? '',
        roomType: 'youtube',
        isUserCreated: true,
        passwordHash: password ? await hash.make(password) : null,
        reactions: reactions ?? null,
        category: category ?? null,
        imdbId: imdbId ?? null,
      })
      try {
        await resolveYoutubeStream(slug, videoUrl)
      } catch {
        await room.delete()
        return fail('That YouTube link could not be used.')
      }
      return response.json({ success: true, data: { room: this.serialize(room) } })
    }

    // ---- live TV (on-device playback) ----------------------------------
    // The packed stream (origin URL + per-channel headers + tree path) rides in
    // `videoUrl` and is stored verbatim as the room's externalUrl. Clients
    // unpack it and play the origin on-device with its headers, re-resolving a
    // fresh token via the tree path when it expires — so the server only stores
    // it (no download, no relay). Created synchronously.
    if (roomType === 'tv') {
      if (!videoUrl) return fail('Please choose a channel.')
      const slug = await this.uniqueSlug(name)
      const room = await Room.create({
        name,
        slug,
        videoFilename: '',
        externalUrl: videoUrl,
        thumbnailFilename: thumbnail ?? '',
        roomType: 'tv',
        isUserCreated: true,
        passwordHash: password ? await hash.make(password) : null,
        reactions: reactions ?? null,
        category: category ?? null,
        imdbId: imdbId ?? null,
      })
      return response.json({ success: true, data: { room: this.serialize(room) } })
    }

    // ---- download from a link OR a magnet ------------------------------
    // The server fetches the video to disk either way; a magnet is downloaded
    // fully (then served as a normal file room) instead of streamed on demand.
    if (roomType === 'download') {
      if (magnet) {
        try {
          const jobId = startMagnetDownload({
            name,
            password: password ?? null,
            magnet,
            reactions: reactions ?? null,
            category: category ?? null,
            imdbId: imdbId ?? null,
            thumbnail: thumbnail ?? null,
            deviceId,
          })
          return response.json({ success: true, data: { jobId } })
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'torrent_invalid_magnet')
        }
      }
      if (!videoUrl) return fail('Please paste a link or a magnet.')
      // A YouTube link is not a plain file the URL downloader can stream, so it
      // is handed to yt-dlp (which fetches it into a normal `download` room).
      if (isYoutubeUrl(videoUrl)) {
        try {
          const jobId = startYoutubeDownload({
            name,
            password: password ?? null,
            url: videoUrl,
            reactions: reactions ?? null,
            category: category ?? null,
            imdbId: imdbId ?? null,
            maxHeight: maxHeight ?? null,
            thumbnail: thumbnail ?? null,
            deviceId,
          })
          return response.json({ success: true, data: { jobId } })
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'That YouTube link could not be used.')
        }
      }
      try {
        const jobId = startUrlDownload({
          name,
          password: password ?? null,
          url: videoUrl,
          reactions: reactions ?? null,
          category: category ?? null,
          imdbId: imdbId ?? null,
          thumbnail: thumbnail ?? null,
          deviceId,
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
          category: category ?? null,
          imdbId: imdbId ?? null,
          thumbnail: thumbnail ?? null,
          deviceId,
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
      // A real poster if one was passed; otherwise the model's beforeCreate hook
      // assigns a random placeholder.
      thumbnailFilename: thumbnail ?? '',
      roomType: 'upload',
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
      reactions: reactions ?? null,
      category: category ?? null,
      imdbId: imdbId ?? null,
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

    /** A YouTube room shares this poll too: it reaches `done` (with its slug)
     * once yt-dlp finishes and the room row exists. */
    const ytJob = getYoutubeJob(jobId)
    if (ytJob) {
      return response.json({
        success: true,
        data: {
          status: ytJob.status,
          percent: ytJob.percent,
          bytesDownloaded: ytJob.bytesDownloaded,
          totalBytes: ytJob.totalBytes,
          error: ytJob.error,
          slug: ytJob.slug,
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
   * GET /api/operations — every in-flight (and recently finished) server
   * transfer this device started: URL downloads, magnet downloads, and torrent
   * room creations. Identified by the `x-device-id` header (or `?deviceId=`),
   * so the mobile client can show + cancel its operations even after a socket
   * reconnect. Newest first.
   */
  async operations({ request, response }: HttpContext) {
    const deviceId = request.header('x-device-id') ?? (String(request.input('deviceId') ?? '') || null)

    const all = [
      ...listDownloadJobs(deviceId),
      ...listTorrentJobs(deviceId),
      ...listYoutubeJobs(deviceId),
    ].sort((a, b) => b.createdAt - a.createdAt)
    return response.json({ success: true, data: { operations: all } })
  }

  /**
   * POST /api/rooms/download/:jobId/cancel — cancel a running transfer the
   * device owns. Dispatches to whichever service holds the job; a job already
   * finished or owned by another device returns 404.
   */
  async cancelOperation({ params, request, response }: HttpContext) {
    const jobId = String(params.jobId)
    const deviceId = request.header('x-device-id') ?? (String(request.input('deviceId') ?? '') || null)

    const canceled =
      cancelDownloadJob(jobId, deviceId) ||
      cancelTorrentJob(jobId, deviceId) ||
      cancelYoutubeJob(jobId, deviceId)
    if (!canceled) {
      return response
        .status(404)
        .json({ success: false, message: 'That operation is no longer available.' })
    }
    return response.json({ success: true })
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

    if (room.roomType === 'youtube') {
      /** Just an in-memory resolved-URL cache to forget — no files on disk. */
      dropYoutubeStream(room.slug)
    } else if (room.roomType === 'torrent') {
      /** Tear down the swarm and delete its cached pieces under storage/torrents. */
      await removeRoomTorrent(room)
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
   * POST /api/rooms/:slug/subtitle — upload an SRT/VTT for a room. Works for
   * every room type: file rooms load it as an external subtitle track, legacy
   * external rooms render it as an overlay. Replaces any previous subtitle and
   * notifies the room over the socket.
   */
  async uploadSubtitle({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
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
    const destPath = app.makePath('storage/subtitles', filename)
    try {
      await subtitle.move(app.makePath('storage/subtitles'), { name: filename, overwrite: true })
    } catch {
      return response.status(500).json({ success: false, message: 'subtitle_save_failed' })
    }

    /* Normalize the stored bytes to UTF-8 so Arabic (and other non-Latin)
       subtitles aren't shown as symbols. Best-effort: a read/write hiccup must
       not fail the upload — the original file is still usable. */
    try {
      const original = await readFile(destPath)
      const normalized = normalizeSubtitleToUtf8(original)
      if (!normalized.equals(original)) await writeFile(destPath, normalized)
    } catch {
      /* leave the file as uploaded */
    }

    room.subtitleFilename = filename
    /* A new subtitle is a fresh sync baseline — drop any prior timing offset. */
    room.subtitleOffset = 0
    await room.save()
    io?.to(room.slug).emit('subtitle_changed', { filename })
    io?.to(room.slug).emit('subtitle_settings_changed', {
      offset: 0,
      weight: room.subtitleWeight ?? 500,
      size: room.subtitleSize ?? 28,
    })

    return response.json({ success: true, data: { filename } })
  }

  /**
   * POST /api/rooms/:slug/voice — upload a recorded chat voice clip.
   *
   * The clip rides the multipart body (field `voice`); its metadata (sender
   * `name`, `durationMs`, client `clientId`) comes on the query string so it is
   * parsed independently of the multipart stream. The clip is stored under
   * `public/voice/` (served statically at `/voice/:filename`) and the same call
   * broadcasts the voice chat message to the room over the socket — so the
   * upload is the whole delivery (the client does no separate socket send).
   * Returns the stored filename.
   */
  async voice({ params, request, response }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.status(404).json({ success: false, message: 'room_not_found' })
    }

    const clip = request.file('voice', { size: MAX_VOICE_SIZE, extnames: VOICE_EXTENSIONS })
    if (!clip) return response.status(400).json({ success: false, message: 'no_voice_file' })
    if (!clip.isValid) {
      return response
        .status(400)
        .json({ success: false, message: clip.errors[0]?.message ?? 'voice_rejected' })
    }

    const ext = (clip.extname || 'm4a').toLowerCase()
    const filename = `${room.slug}-${randomUUID()}.${ext}`
    const dir = app.makePath('public/voice')
    try {
      await mkdir(dir, { recursive: true })
      await clip.move(dir, { name: filename, overwrite: true })
    } catch {
      return response.status(500).json({ success: false, message: 'voice_save_failed' })
    }

    const durationRaw = Number(request.input('durationMs'))
    const durationMs = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null
    const clientId = String(request.input('clientId') ?? '').trim() || undefined
    const name = String(request.input('name') ?? '').trim()

    broadcastVoiceMessage(room.slug, { name, audioUrl: filename, durationMs, clientId })

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
