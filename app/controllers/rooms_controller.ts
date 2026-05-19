import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import Room from '#models/room'
import { createRoomValidator } from '#validators/room'
import { getViewerCount, dropRoom } from '#start/socket'
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
   * visitor only has to enter a room's password once per session.
   */
  private unlockKey(room: Room): string {
    return `room_unlocked_${room.id}`
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

    if (room.hasPassword && session.get(this.unlockKey(room)) !== true) {
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
   * Persists a new room: validates the form, stores the uploaded video under
   * `storage/videos/`, hashes the optional password and inserts the row.
   *
   * The create page submits over XHR, so failures are returned as JSON when
   * the request is an AJAX request and as a flash + redirect otherwise.
   */
  async store({ request, response, session }: HttpContext) {
    const { name, password } = await request.validateUsing(createRoomValidator)
    const wantsJson = request.ajax()

    /** Reports a failure through whichever channel the client expects. */
    const fail = (message: string) => {
      if (wantsJson) return response.status(422).json({ error: message })
      session.flash('error', message)
      return response.redirect().back()
    }

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
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
    })

    /**
     * The creator already knows the password — unlock the room for them so
     * they are not immediately challenged for it.
     */
    if (room.hasPassword) {
      session.put(this.unlockKey(room), true)
    }

    if (wantsJson) {
      return response.json({ redirectTo: `/room/${room.slug}` })
    }

    session.flash('success', `Room "${room.name}" is ready.`)
    return response.redirect(`/room/${room.slug}`)
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
      session.put(this.unlockKey(room), true)
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
     * simply that it no longer exists afterwards.
     */
    try {
      await unlink(app.makePath('storage/videos', basename(room.videoFilename)))
    } catch {
      /* file already gone — nothing to clean up */
    }

    dropRoom(room.slug)
    session.forget(this.unlockKey(room))
    await room.delete()

    session.flash('success', `Room "${room.name}" and its video were deleted.`)
    return response.redirect('/')
  }
}
