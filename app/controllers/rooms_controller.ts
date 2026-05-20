import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import Room from '#models/room'
import { createRoomValidator } from '#validators/room'
import { getViewerCount, dropRoom } from '#start/socket'
import { startUrlDownload, getJob } from '#services/video_downloader'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Accepted video container extensions for uploaded room videos.
 */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov']

/**
 * Per-file upload ceiling — comfortably covers a full-length movie. Kept in
 * step with the `multipart.limit` in `config/bodyparser.ts`.
 */
const MAX_VIDEO_SIZE = '15gb'

/**
 * Builds a URL-safe slug from a free-text room name. Dependency-free so the
 * exact transformation is obvious: lower-cased, non-alphanumerics collapsed
 * to single hyphens, trimmed, and capped in length.
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
 * RoomsController renders the public-facing pages of the watch party and
 * owns the lifecycle of a room: creating one (with an uploaded video and an
 * optional password), gating entry behind that password, and deleting the
 * room together with its video file once everyone has finished watching.
 */
export default class RoomsController {
  /**
   * Home page — list every available room as a grid of cards.
   */
  async index({ view }: HttpContext) {
    const rooms = await Room.query().orderBy('id', 'asc')
    return view.render('home', { rooms })
  }

  /**
   * Session key under which a successful password unlock is remembered, so a
   * visitor only has to enter a room's password once per session. Keyed by id
   * so it can also be set from a download job, where only the id is at hand.
   */
  private unlockKey(roomId: number): string {
    return `room_unlocked_${roomId}`
  }

  /**
   * Room page — the synchronized video player for a single room.
   * Password-protected rooms first render the unlock page until the visitor
   * has supplied the correct password during this session.
   */
  async show({ params, view, response, session }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)

    if (!room) {
      response.status(404)
      return view.render('not_found', { slug: params.slug })
    }

    if (room.hasPassword && session.get(this.unlockKey(room.id)) !== true) {
      return view.render('pages/room_locked', { room })
    }

    return view.render('room', { room })
  }

  /**
   * Create-room page — the form for naming a room, uploading its video and
   * optionally protecting it with a password.
   */
  create({ view }: HttpContext) {
    return view.render('pages/create_room')
  }

  /**
   * Persists a new room. Its video arrives one of two ways:
   *
   * - an **uploaded file**, stored under `storage/videos/` and the room row
   *   inserted right away; or
   * - a **pasted link**, which is handed to a background download job — the
   *   room is created by that job once the bytes are on disk, and this
   *   request only returns the `jobId` the browser polls for progress.
   *
   * The create page submits over XHR, so failures are returned as JSON when
   * the request is an AJAX request and as a flash + redirect otherwise.
   */
  async store({ request, response, session }: HttpContext) {
    const { name, password, roomType, videoUrl, externalUrl } =
      await request.validateUsing(createRoomValidator)
    const wantsJson = request.ajax()

    /** Reports a failure through whichever channel the client expects. */
    const fail = (message: string) => {
      if (wantsJson) return response.status(422).json({ error: message })
      session.flash('error', message)
      return response.redirect().back()
    }

    /**
     * External flow — the room is just a label in front of someone else's
     * embed. Nothing to download, nothing to store; the room is ready the
     * instant the row exists.
     */
    if (roomType === 'external') {
      if (!externalUrl) {
        return fail('Please paste the embed link for the external stream.')
      }

      let parsed: URL
      try {
        parsed = new URL(externalUrl)
      } catch {
        return fail('That does not look like a valid embed link.')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail('Embed links must use http or https.')
      }

      const base = slugify(name) || 'room'
      let slug = base
      while (await Room.findBy('slug', slug)) {
        slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
      }

      const room = await Room.create({
        name,
        slug,
        videoFilename: '',
        thumbnailFilename: '',
        roomType: 'external',
        externalUrl,
        isUserCreated: true,
        passwordHash: password ? await hash.make(password) : null,
      })

      if (room.hasPassword) {
        session.put(this.unlockKey(room.id), true)
      }

      if (wantsJson) {
        return response.json({ redirectTo: `/room/${room.slug}` })
      }

      session.flash('success', `Room "${room.name}" is ready.`)
      return response.redirect(`/room/${room.slug}`)
    }

    /**
     * Download flow — the room is not created here; the background job
     * creates it once the video has finished downloading.
     */
    if (roomType === 'download') {
      if (!videoUrl) {
        return fail('Please paste a link to the video file.')
      }
      let jobId: string
      try {
        jobId = startUrlDownload({ name, password: password ?? null, url: videoUrl })
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'That link could not be used.')
      }

      if (wantsJson) {
        return response.json({ jobId })
      }
      return fail('Creating a room from a link requires JavaScript to be enabled.')
    }

    /**
     * Upload flow — the visitor supplied a file directly.
     */
    const video = request.file('video', { size: MAX_VIDEO_SIZE, extnames: VIDEO_EXTENSIONS })

    if (!video) {
      return fail('Please choose a video file to upload.')
    }
    if (!video.isValid) {
      return fail(video.errors[0]?.message ?? 'The uploaded file is not a supported video.')
    }

    /**
     * Derive a unique slug from the room name, appending a short random
     * suffix on the rare chance the base slug is already taken.
     */
    const base = slugify(name) || 'room'
    let slug = base
    while (await Room.findBy('slug', slug)) {
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
    }

    /**
     * The slug is unique, so a slug-based filename is unique too — which
     * keeps `storage/videos/` readable and collision-free.
     */
    const videoFilename = `${slug}.${(video.extname || 'mp4').toLowerCase()}`
    try {
      await video.move(app.makePath('storage/videos'), {
        name: videoFilename,
        overwrite: true,
      })
    } catch {
      return fail('The video could not be saved. Please try again.')
    }

    const room = await Room.create({
      name,
      slug,
      videoFilename,
      thumbnailFilename: '',
      roomType: 'upload',
      externalUrl: null,
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
    })

    /**
     * The creator already knows the password — unlock the room for them so
     * they are not immediately challenged for it.
     */
    if (room.hasPassword) {
      session.put(this.unlockKey(room.id), true)
    }

    if (wantsJson) {
      return response.json({ redirectTo: `/room/${room.slug}` })
    }

    session.flash('success', `Room "${room.name}" is ready.`)
    return response.redirect(`/room/${room.slug}`)
  }

  /**
   * Progress endpoint for a link-based room creation. The browser polls this
   * while the server downloads the video and reads the running byte count to
   * drive its progress bar. The room only exists once the job reports `done`,
   * at which point `redirectTo` points at it.
   */
  async downloadProgress({ params, response, session }: HttpContext) {
    const job = getJob(String(params.jobId))
    if (!job) {
      return response
        .status(404)
        .json({ status: 'error', error: 'That download is no longer available.' })
    }

    /**
     * The creator already knows any password they set, so unlock the finished
     * room for them in this session — exactly as the upload flow does.
     */
    if (job.status === 'done' && job.roomHasPassword && job.roomId !== null) {
      session.put(this.unlockKey(job.roomId), true)
    }

    return response.json({
      status: job.status,
      percent: job.percent,
      bytesDownloaded: job.bytesDownloaded,
      totalBytes: job.totalBytes,
      error: job.error,
      redirectTo: job.redirectTo,
    })
  }

  /**
   * Verifies a room password and, on success, remembers the unlock in the
   * session so the visitor can enter the room.
   */
  async unlock({ params, request, response, session }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      return response.redirect('/')
    }

    const password = String(request.input('password') ?? '')
    if (room.passwordHash && (await hash.verify(room.passwordHash, password))) {
      session.put(this.unlockKey(room.id), true)
      return response.redirect(`/room/${room.slug}`)
    }

    session.flash('error', 'Incorrect password — please try again.')
    return response.redirect().back()
  }

  /**
   * Deletes a room and its video file. Protected rooms require the correct
   * password, and any room can only be deleted once nobody else is watching.
   */
  async destroy({ params, request, response, session }: HttpContext) {
    const room = await Room.findBy('slug', params.slug)
    if (!room) {
      session.flash('error', 'That room no longer exists.')
      return response.redirect('/')
    }

    /**
     * A protected room can only be torn down by someone who knows its
     * password.
     */
    if (room.passwordHash) {
      const password = String(request.input('password') ?? '')
      if (!(await hash.verify(room.passwordHash, password))) {
        session.flash('error', 'Incorrect password — the room was not deleted.')
        return response.redirect().back()
      }
    }

    /**
     * Refuse the deletion while other people are still watching. The
     * requester counts as one viewer, so anything above one means others
     * are present.
     */
    if (getViewerCount(room.slug) > 1) {
      session.flash('error', 'Someone is still watching — wait until the room is empty.')
      return response.redirect().back()
    }

    /**
     * Remove the video file. A missing file is not an error: the goal is
     * simply that it no longer exists afterwards. External rooms own no
     * file at all, so the unlink is skipped for them.
     */
    if (room.videoFilename) {
      try {
        await unlink(app.makePath('storage/videos', basename(room.videoFilename)))
      } catch {
        /* file already gone — nothing to clean up */
      }
    }

    dropRoom(room.slug)
    session.forget(this.unlockKey(room.id))
    await room.delete()

    session.flash('success', `Room "${room.name}" and its video were deleted.`)
    return response.redirect('/')
  }
}
