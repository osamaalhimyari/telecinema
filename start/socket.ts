/*
|--------------------------------------------------------------------------
| Socket.io — real-time watch-party synchronization
|--------------------------------------------------------------------------
|
| This module owns all of the real-time logic. It keeps an in-memory map of
| per-room "master" playback state and relays control events between every
| client currently watching the same room.
|
| The Socket.io server is attached to the existing AdonisJS Node HTTP server
| by `providers/socket_provider.ts` once the server is listening.
|
*/

import { unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { Server, type Socket } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import app from '@adonisjs/core/services/app'
import Room from '#models/room'

/**
 * The authoritative playback state for a single room.
 */
interface RoomState {
  isPlaying: boolean
  currentTime: number
  /** Date.now() of the last state change — used to extrapolate drift. */
  lastUpdated: number
  viewerCount: number
  /** Playback rate (0.5..2). Synchronized across the room. */
  playbackRate: number
  /**
   * True iff the buffer-watchdog (not a user) caused the current pause.
   * Used so manual play/pause overrides the watchdog and auto-resume
   * only fires when we're the ones who paused.
   */
  autoPausedForBuffering: boolean
}

/**
 * A single chat message inside a room. We keep only a small ring buffer
 * per-room so new joiners can see recent context — full history is not
 * persisted to the database.
 */
interface ChatMessage {
  id: string
  name: string
  text: string
  /** ms since epoch — for relative rendering on each client. */
  ts: number
  /**
   * Client-generated nonce, echoed back unchanged. Lets the sender reconcile
   * its optimistic bubble with the delivered copy, and lets us drop a duplicate
   * if a flaky client re-sends the same message after a reconnect.
   */
  clientId?: string
}

const CHAT_HISTORY_LIMIT = 80
const CHAT_MAX_LENGTH = 500
const CHAT_RATE_WINDOW_MS = 6000
const CHAT_RATE_MAX = 6

/**
 * Payloads exchanged with clients.
 */
interface JoinRoomPayload {
  roomSlug?: unknown
}

interface ControlPayload {
  action?: unknown
  currentTime?: unknown
  rate?: unknown
}

interface ChatPayload {
  text?: unknown
  clientId?: unknown
}

interface BufferStatePayload {
  buffering?: unknown
}

/**
 * In-memory master state for every room, keyed by room slug.
 */
const rooms = new Map<string, RoomState>()

/**
 * Name of the Socket.io room that home-page clients join so they can receive
 * live viewer-count updates for every room.
 */
const HOME_CHANNEL = 'home'

/**
 * Tracks connected users per room: socketId -> { name, slug }
 */
const roomUsers = new Map<string, Map<string, { name: string }>>()

/**
 * In-memory per-room chat history. Ephemeral on purpose — a watch-party
 * room exists to enjoy "the moment together", not as a long-term archive.
 */
const roomChats = new Map<string, ChatMessage[]>()

/** Per-socket sliding window for chat rate limiting (timestamps in ms). */
const chatRateState = new Map<string, number[]>()

/**
 * Per-room map of currently-buffering sockets → display name. Drives the
 * "wait for slow viewers" auto-pause: while this map has any entries for
 * a room, that room is held paused so nobody gets out of sync.
 */
const roomBuffering = new Map<string, Map<string, string>>()

function markBuffering(slug: string, socketId: string, name: string): void {
  let inner = roomBuffering.get(slug)
  if (!inner) {
    inner = new Map()
    roomBuffering.set(slug, inner)
  }
  inner.set(socketId, name)
}

function clearBuffering(slug: string, socketId: string): void {
  const inner = roomBuffering.get(slug)
  if (!inner) return
  inner.delete(socketId)
  if (inner.size === 0) roomBuffering.delete(slug)
}

function bufferingList(slug: string): { id: string; name: string }[] {
  const inner = roomBuffering.get(slug)
  if (!inner) return []
  return Array.from(inner.entries()).map(([id, name]) => ({ id, name }))
}

function pushChatMessage(slug: string, msg: ChatMessage): void {
  let log = roomChats.get(slug)
  if (!log) {
    log = []
    roomChats.set(slug, log)
  }
  log.push(msg)
  if (log.length > CHAT_HISTORY_LIMIT) {
    log.splice(0, log.length - CHAT_HISTORY_LIMIT)
  }
}

function getChatHistory(slug: string): ChatMessage[] {
  return roomChats.get(slug) ?? []
}

function withinChatRate(socketId: string): boolean {
  const now = Date.now()
  let stamps = chatRateState.get(socketId)
  if (!stamps) {
    stamps = []
    chatRateState.set(socketId, stamps)
  }
  while (stamps.length > 0 && now - stamps[0] > CHAT_RATE_WINDOW_MS) {
    stamps.shift()
  }
  if (stamps.length >= CHAT_RATE_MAX) return false
  stamps.push(now)
  return true
}

function addRoomUser(slug: string, socketId: string, name: string): void {
  let users = roomUsers.get(slug)
  if (!users) {
    users = new Map()
    roomUsers.set(slug, users)
  }
  users.set(socketId, { name })
}

function removeRoomUser(slug: string, socketId: string): void {
  const users = roomUsers.get(slug)
  if (!users) return
  users.delete(socketId)
  if (users.size === 0) roomUsers.delete(slug)
}

function getRoomUsers(slug: string): { id: string; name: string }[] {
  const users = roomUsers.get(slug)
  if (!users) return []
  return Array.from(users.entries()).map(([id, u]) => ({ id, name: u.name }))
}

function broadcastRoomUsers(server: Server, slug: string): void {
  server.to(slug).emit('room_users', { users: getRoomUsers(slug) })
}

/**
 * The Socket.io server instance. Exported so controllers (or any other part
 * of the app) can reach into it if needed.
 */
export let io: Server | undefined

/**
 * Returns the master state for a room, creating a fresh one on first access.
 */
function getRoomState(slug: string): RoomState {
  let state = rooms.get(slug)
  if (!state) {
    state = {
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now(),
      viewerCount: 0,
      playbackRate: 1,
      autoPausedForBuffering: false,
    }
    rooms.set(slug, state)
  }
  return state
}

/**
 * Computes the playback position "now". When the room is playing, the stored
 * `currentTime` is extrapolated forward by the elapsed wall-clock time so a
 * client that joins late lands at the correct spot.
 */
function effectiveTime(state: RoomState): number {
  if (!state.isPlaying) return state.currentTime
  const elapsed = (Date.now() - state.lastUpdated) / 1000
  return state.currentTime + elapsed * (state.playbackRate || 1)
}

/**
 * Current number of viewers inside a room. Used by the HTTP layer to refuse
 * a room deletion while other people are still watching.
 */
export function getViewerCount(slug: string): number {
  return rooms.get(slug)?.viewerCount ?? 0
}

/**
 * Forgets a room's in-memory state and tells any still-connected client that
 * the room no longer exists. Called when a room is deleted over HTTP.
 */
export function dropRoom(slug: string): void {
  cancelRoomCleanup(slug)
  rooms.delete(slug)
  roomChats.delete(slug)
  roomUsers.delete(slug)
  roomBuffering.delete(slug)
  io?.to(slug).emit('room_deleted')
}

/**
 * How long a room with no viewers keeps its place before it is fully reset.
 * Long enough to cover a brief network drop or a quick room re-entry, short
 * enough never to strand an abandoned room in memory.
 */
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000

/**
 * After a join, a control that would move the room significantly *backward* is
 * treated as a fresh client's stale autoplay/seek echo and ignored — a new
 * client's player fires play/seek at ~0 before it has applied the room's
 * position, which would otherwise yank everyone back to the start.
 */
const JOIN_CONTROL_GRACE_MS = 2500
const JOIN_BACKWARD_TOLERANCE = 3

/** Pending "reset an empty room" timers, keyed by slug. */
const roomCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Cancels a scheduled empty-room reset — called when someone (re)joins. */
function cancelRoomCleanup(slug: string): void {
  const timer = roomCleanupTimers.get(slug)
  if (timer) {
    clearTimeout(timer)
    roomCleanupTimers.delete(slug)
  }
}

/**
 * Freezes an emptied room at its current position instead of zeroing it, so a
 * viewer who returns shortly after a disconnect resumes exactly where they
 * were. A full reset is scheduled for [EMPTY_ROOM_TTL_MS] later in case nobody
 * comes back.
 */
function parkRoom(slug: string, state: RoomState): void {
  state.currentTime = effectiveTime(state)
  state.isPlaying = false
  state.lastUpdated = Date.now()
  state.autoPausedForBuffering = false

  cancelRoomCleanup(slug)
  roomCleanupTimers.set(
    slug,
    setTimeout(() => {
      roomCleanupTimers.delete(slug)
      const current = rooms.get(slug)
      if (current && current.viewerCount === 0) {
        rooms.delete(slug)
        roomChats.delete(slug)
        roomBuffering.delete(slug)
        roomUsers.delete(slug)
      }
    }, EMPTY_ROOM_TTL_MS)
  )
}

/**
 * A `{ slug: viewerCount }` snapshot of every known room.
 */
function viewerCountSnapshot(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [slug, state] of rooms) {
    counts[slug] = state.viewerCount
  }
  return counts
}

/**
 * Broadcasts a room's viewer count both to the watchers inside that room and
 * to every client sitting on the home page.
 */
function broadcastViewerCount(server: Server, slug: string, count: number) {
  server.to(slug).emit('viewer_count', { slug, count })
  server.to(HOME_CHANNEL).emit('viewer_count', { slug, count })
}

/** Tells everyone in a room which viewers (if any) are currently buffering. */
function broadcastWaitState(server: Server, slug: string): void {
  server.to(slug).emit('wait_state', { users: bufferingList(slug) })
}

/** Allowed bounds for the shared subtitle settings (mirrored on the client). */
const SUBTITLE_OFFSET_MIN = -60
const SUBTITLE_OFFSET_MAX = 60
const SUBTITLE_WEIGHT_MIN = 100
const SUBTITLE_WEIGHT_MAX = 900
const SUBTITLE_SIZE_MIN = 14
const SUBTITLE_SIZE_MAX = 44

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Sends a room's shared subtitle settings (timing offset, weight, size) to a
 * single socket — used to seed a newcomer on join so their subtitles line up
 * with the rest of the room from the first frame.
 */
async function emitSubtitleSettings(socket: Socket, slug: string): Promise<void> {
  const room = await Room.findBy('slug', slug)
  if (!room) return
  socket.emit('subtitle_settings_changed', {
    offset: room.subtitleOffset ?? 0,
    weight: room.subtitleWeight ?? 500,
    size: room.subtitleSize ?? 28,
  })
}

/**
 * Central buffer-watchdog logic. Called whenever the buffer map for a
 * room changes — by a `buffer_state` event, or by a socket disconnect.
 *
 * - If any viewer is buffering and the room is playing → pause for
 *   everyone and flag this as our auto-pause.
 * - If the buffer is empty and we're the one who paused → auto-resume.
 *
 * Always re-broadcasts `wait_state` so the banner reflects reality.
 */
function evaluateBufferGate(server: Server, slug: string): void {
  const state = rooms.get(slug)
  if (!state) {
    broadcastWaitState(server, slug)
    return
  }

  const someoneBuffering = (roomBuffering.get(slug)?.size ?? 0) > 0

  if (someoneBuffering && state.isPlaying && !state.autoPausedForBuffering) {
    /* Freeze playback right where it is so nobody runs further ahead
       while the slow viewer is loading. */
    state.currentTime = effectiveTime(state)
    state.isPlaying = false
    state.autoPausedForBuffering = true
    state.lastUpdated = Date.now()

    server.to(slug).emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })
  } else if (!someoneBuffering && state.autoPausedForBuffering) {
    /* Everyone is ready again — release the auto-pause we set earlier. */
    state.isPlaying = true
    state.autoPausedForBuffering = false
    state.lastUpdated = Date.now()

    server.to(slug).emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })
  }

  broadcastWaitState(server, slug)
}

/**
 * Wires up all event handlers for a freshly connected socket.
 */
function registerHandlers(server: Server, socket: Socket) {
  /**
   * A home-page client subscribing to live viewer counts.
   */
  socket.on('set_name', (payload: { name?: unknown }) => {
    const name =
      typeof payload?.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim().slice(0, 30)
        : 'Anonymous'
    socket.data.displayName = name
    const slug = socket.data.roomSlug
    if (typeof slug === 'string' && slug.length > 0) {
      addRoomUser(slug, socket.id, name)
      broadcastRoomUsers(server, slug)
    }
  })

  socket.on('join_home', () => {
    socket.join(HOME_CHANNEL)
    socket.emit('viewer_counts', { counts: viewerCountSnapshot() })
  })

  /**
   * A client entering a room. We add the socket to the Socket.io room, send
   * it the current master state, and broadcast the bumped viewer count.
   */
  socket.on('join_room', (payload: JoinRoomPayload) => {
    const slug = payload?.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    /**
     * Guard against double-counting: a client may re-emit `join_room` (for
     * example after clearing the autoplay gate) and must not be counted
     * twice for the same socket.
     */
    const alreadyInRoom = socket.rooms.has(slug)
    socket.join(slug)
    socket.data.roomSlug = slug
    socket.data.joinedAt = Date.now()
    /* A viewer (re)joined — keep the room's frozen position alive. */
    cancelRoomCleanup(slug)

    const state = getRoomState(slug)
    if (!alreadyInRoom) {
      state.viewerCount += 1
    }

    socket.emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: effectiveTime(state),
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })

    /* Hand the newcomer the recent chat backlog. */
    socket.emit('chat_history', { messages: getChatHistory(slug) })

    /* Show them who (if anyone) is currently holding the room paused. */
    socket.emit('wait_state', { users: bufferingList(slug) })

    /* Seed the newcomer with the room's shared subtitle settings so their
       timing offset / weight / size match everyone else immediately. */
    void emitSubtitleSettings(socket, slug)

    if (!alreadyInRoom) {
      broadcastViewerCount(server, slug, state.viewerCount)
    }

    /* Register user in presence tracking and broadcast list. */
    const displayName: string =
      typeof socket.data.displayName === 'string' && socket.data.displayName.length > 0
        ? socket.data.displayName
        : 'Anonymous'
    addRoomUser(slug, socket.id, displayName)
    broadcastRoomUsers(server, slug)
  })

  /**
   * A playback control action. We update the master state and relay a `sync`
   * to every *other* client in the room (never back to the sender).
   */
  socket.on('control', (payload: ControlPayload) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const action = payload?.action
    if (action !== 'play' && action !== 'pause' && action !== 'seek' && action !== 'rate') {
      return
    }

    const state = getRoomState(slug)

    if (action === 'rate') {
      const rate = Number(payload?.rate)
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) return
      /**
       * Bring `currentTime` up to date *before* changing the rate, so the
       * stretch of time played at the old rate isn't retroactively measured
       * at the new one.
       */
      state.currentTime = effectiveTime(state)
      state.lastUpdated = Date.now()
      state.playbackRate = Math.round(rate * 100) / 100

      server.to(slug).emit('rate_changed', {
        playbackRate: state.playbackRate,
        currentTime: state.currentTime,
        isPlaying: state.isPlaying,
        serverTime: Date.now(),
      })
      return
    }

    const currentTime = Number(payload?.currentTime)
    if (!Number.isFinite(currentTime)) return

    /**
     * Ignore a just-joined client's stale autoplay/seek echo. A fresh client's
     * player fires play/seek at ~0 before it has applied the room's position,
     * which would otherwise drag everyone back to the start. Within a short
     * grace window after join, reject any control that moves the room
     * significantly backward; genuine controls (and anything after the window)
     * pass through untouched.
     */
    const joinedAt = typeof socket.data.joinedAt === 'number' ? socket.data.joinedAt : 0
    if (
      Date.now() - joinedAt < JOIN_CONTROL_GRACE_MS &&
      effectiveTime(state) - Math.max(0, currentTime) > JOIN_BACKWARD_TOLERANCE
    ) {
      return
    }

    state.currentTime = Math.max(0, currentTime)
    state.lastUpdated = Date.now()
    if (action === 'play') state.isPlaying = true
    else if (action === 'pause') state.isPlaying = false
    // `seek` keeps the existing play/pause status.

    /**
     * Any explicit user control beats the buffer-watchdog — clear the
     * flag so a subsequent buffer-clear doesn't auto-resume on top of
     * the user's choice (e.g. they manually paused while loading).
     */
    state.autoPausedForBuffering = false

    socket.to(slug).emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })
  })

  /**
   * Buffer-state report from a client. Drives the "wait for slow
   * viewers" auto-pause. Clients should send `{ buffering: true }`
   * after a stall persists for ~1.5s, and `{ buffering: false }` the
   * moment playback recovers (or the user manually pauses).
   */
  socket.on('buffer_state', (payload: BufferStatePayload) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const name =
      typeof socket.data.displayName === 'string' && socket.data.displayName.length > 0
        ? socket.data.displayName
        : 'Anonymous'

    if (payload?.buffering === true) {
      markBuffering(slug, socket.id, name)
    } else {
      clearBuffering(slug, socket.id)
    }

    evaluateBufferGate(server, slug)
  })

  /**
   * A chat message inside a room. Trimmed, capped, and rate-limited per
   * socket so a runaway client cannot flood everyone else. The message is
   * appended to the room's ring buffer and broadcast to every participant
   * — including the sender, so all clients render messages through the
   * same code path and see the server-stamped id and timestamp.
   */
  socket.on('chat', (payload: ChatPayload) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const raw = typeof payload?.text === 'string' ? payload.text : ''
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH)
    if (!text) return

    const clientId =
      typeof payload?.clientId === 'string' && payload.clientId.length > 0
        ? payload.clientId.slice(0, 64)
        : undefined

    /**
     * Idempotency: a client on a flaky connection re-sends queued messages
     * after it reconnects. If we've already stored this nonce, the first send
     * got through and only the sender's echo was lost — re-broadcast the stored
     * copy so it can confirm, and never store a duplicate. This also means a
     * retry is *not* charged against the rate limit.
     */
    if (clientId) {
      const existing = roomChats.get(slug)?.find((m) => m.clientId === clientId)
      if (existing) {
        server.to(slug).emit('chat', existing)
        return
      }
    }

    if (!withinChatRate(socket.id)) {
      socket.emit('chat_throttled', { retryAfter: CHAT_RATE_WINDOW_MS, clientId })
      return
    }

    const name =
      typeof socket.data.displayName === 'string' && socket.data.displayName.length > 0
        ? socket.data.displayName
        : 'Anonymous'

    const message: ChatMessage = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      text,
      ts: Date.now(),
      clientId,
    }
    pushChatMessage(slug, message)
    server.to(slug).emit('chat', message)
  })

  /**
   * Change the embed URL of an `external` room — used for things like
   * jumping to the next episode of a series. Persists the new URL on the
   * room row, resets the master playback state (the next episode always
   * starts fresh from 0, paused), and broadcasts the change to everyone in
   * the room so each iframe is reloaded against the new source.
   */
  socket.on('change_source', async (payload: { url?: unknown }) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const raw = payload?.url
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return

    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return

    const room = await Room.findBy('slug', slug)
    if (!room || room.roomType !== 'external') return

    /**
     * Switching source clears any previous subtitle — the cues no longer
     * match the content. Remove the file from disk first, then null the
     * column so the controller's `uploadSubtitle` cleanup sees it empty.
     */
    if (room.subtitleFilename) {
      try {
        await unlink(app.makePath('storage/subtitles', basename(room.subtitleFilename)))
      } catch {
        /* file already gone — nothing to clean up */
      }
    }
    room.externalUrl = raw
    room.subtitleFilename = null
    /* The previous timing offset belonged to the old subtitle/content. */
    room.subtitleOffset = 0
    await room.save()

    const state = getRoomState(slug)
    state.isPlaying = false
    state.currentTime = 0
    state.lastUpdated = Date.now()
    state.playbackRate = 1
    /* Switching source wipes chat — context no longer applies. */
    roomChats.delete(slug)

    server.to(slug).emit('source_changed', {
      url: raw,
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1,
      serverTime: Date.now(),
    })
    server.to(slug).emit('chat_history', { messages: [] })
    server.to(slug).emit('subtitle_settings_changed', {
      offset: 0,
      weight: room.subtitleWeight ?? 500,
      size: room.subtitleSize ?? 28,
    })
  })

  /**
   * Update the room's shared subtitle settings — the timing offset (to fix a
   * subtitle that runs ahead of or behind the scene), the text weight and the
   * size. Any client may change them (like playback control, there is no host);
   * the values are clamped, persisted on the room row so late joiners inherit
   * them, and broadcast to everyone (including the sender) so all clients
   * converge on the same look. Only the provided fields are touched.
   */
  socket.on(
    'set_subtitle_settings',
    async (payload: { offset?: unknown; weight?: unknown; size?: unknown }) => {
      const slug = socket.data.roomSlug
      if (typeof slug !== 'string' || slug.length === 0) return

      const room = await Room.findBy('slug', slug)
      if (!room) return

      if (Number.isFinite(Number(payload?.offset))) {
        room.subtitleOffset =
          Math.round(clamp(Number(payload.offset), SUBTITLE_OFFSET_MIN, SUBTITLE_OFFSET_MAX) * 10) /
          10
      }
      if (Number.isFinite(Number(payload?.weight))) {
        room.subtitleWeight = Math.round(
          clamp(Number(payload.weight), SUBTITLE_WEIGHT_MIN, SUBTITLE_WEIGHT_MAX)
        )
      }
      if (Number.isFinite(Number(payload?.size))) {
        room.subtitleSize = Math.round(
          clamp(Number(payload.size), SUBTITLE_SIZE_MIN, SUBTITLE_SIZE_MAX)
        )
      }
      await room.save()

      server.to(slug).emit('subtitle_settings_changed', {
        offset: room.subtitleOffset,
        weight: room.subtitleWeight,
        size: room.subtitleSize,
      })
    }
  )

  /**
   * Manual realignment for external (iframe) rooms. Cross-origin embeds
   * play autonomously, so the room clock and the actual frame on screen
   * drift over time and there is no way to read the embed's real position
   * from outside its origin. Pressing the "Resync" button asks every
   * client in the room (including the sender) to reload its iframe at the
   * authoritative time, bringing everyone back in lockstep at the cost of
   * one short reload each.
   */
  socket.on('force_resync', () => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const state = getRoomState(slug)
    server.to(slug).emit('force_resync', {
      isPlaying: state.isPlaying,
      currentTime: effectiveTime(state),
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })
  })

  /*
   * --------------------------------------------------------------------
   * Push-to-talk voice relay
   * --------------------------------------------------------------------
   * The server performs no audio mixing: it simply forwards a speaker's
   * encoded microphone audio to everyone else in the same room. A talk
   * burst is bracketed by `voice_start` / `voice_end`, with `voice_chunk`
   * carrying the binary audio in between. Every relayed event is tagged
   * with the speaker's socket id so listeners can keep concurrent
   * speakers apart.
   */
  socket.on('voice_start', (payload: { mimeType?: unknown }) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const mimeType = typeof payload?.mimeType === 'string' ? payload.mimeType : ''
    const name = typeof socket.data.displayName === 'string' ? socket.data.displayName : ''
    socket.to(slug).emit('voice_start', { id: socket.id, mimeType, name })
  })

  socket.on('voice_chunk', (chunk: unknown) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    // Audio is already codec-compressed — deflating it again just burns CPU.
    socket.to(slug).compress(false).emit('voice_chunk', { id: socket.id, chunk })
  })

  socket.on('voice_end', () => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    socket.to(slug).emit('voice_end', { id: socket.id })
  })

  socket.on('reaction', (payload: { emoji?: unknown }) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return
    const emoji = typeof payload?.emoji === 'string' ? payload.emoji : ''
    if (!emoji) return
    const name = typeof socket.data.displayName === 'string' ? socket.data.displayName : 'Anonymous'
    socket.to(slug).emit('reaction', { emoji, id: socket.id, name })
  })

  /**
   * Ephemeral collaborative drawing over the video. The server performs no
   * persistence — it forwards each stroke segment to everyone else in the room
   * so the line appears as it's drawn and then fades on their side. Points are
   * normalized (0..1) against the sender's player box; a stroke is identified by
   * `strokeId` so a segment appends to the right line, and `done` marks its end.
   * Tagged with the sender's socket id + name (mirrors the `reaction` relay).
   */
  socket.on(
    'draw',
    (payload: { strokeId?: unknown; color?: unknown; points?: unknown; done?: unknown }) => {
      const slug = socket.data.roomSlug
      if (typeof slug !== 'string' || slug.length === 0) return

      const strokeId = typeof payload?.strokeId === 'string' ? payload.strokeId.slice(0, 64) : ''
      if (!strokeId) return
      const color = typeof payload?.color === 'string' ? payload.color.slice(0, 16) : '#ffffff'
      const done = payload?.done === true

      /* Accept a small batch of [x, y] pairs; clamp to the unit square and cap
         the count so a malicious client can't flood the room. */
      const raw = Array.isArray(payload?.points) ? payload.points : []
      const points: [number, number][] = []
      for (const p of raw.slice(0, 64)) {
        if (!Array.isArray(p) || p.length < 2) continue
        const x = Number(p[0])
        const y = Number(p[1])
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        points.push([clamp(x, 0, 1), clamp(y, 0, 1)])
      }
      if (points.length === 0 && !done) return

      const name = typeof socket.data.displayName === 'string' ? socket.data.displayName : 'Anonymous'
      socket.to(slug).emit('draw', { id: socket.id, name, strokeId, color, points, done })
    }
  )

  /**
   * "X is writing…" indicator. Relayed to everyone else in the room; each client
   * shows the name briefly and auto-expires it, so a lost `typing:false` can
   * never leave the bubble stuck. Cleared explicitly on send, leave and
   * disconnect below.
   */
  socket.on('typing', (payload: { typing?: unknown }) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return
    const typing = payload?.typing === true
    const name = typeof socket.data.displayName === 'string' ? socket.data.displayName : 'Anonymous'
    socket.to(slug).emit('typing', { id: socket.id, name, typing })
  })

  /**
   * Explicit room exit. The web client leaves a room by unloading the page
   * (which fires `disconnecting`), but a native client keeps one long-lived
   * socket across screens — so it emits `leave_room` to drop its viewer slot
   * without tearing the whole connection down. Additive: existing clients that
   * never emit this are unaffected.
   */
  socket.on('leave_room', () => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || !socket.rooms.has(slug)) return

    /* Close any in-flight voice burst for listeners. */
    socket.to(slug).emit('voice_end', { id: socket.id })
    /* Drop any lingering "is writing…" bubble this socket left behind. */
    socket.to(slug).emit('typing', { id: socket.id, name: '', typing: false })

    removeRoomUser(slug, socket.id)
    clearBuffering(slug, socket.id)
    socket.leave(slug)
    socket.data.roomSlug = undefined

    const state = rooms.get(slug)
    if (state) {
      state.viewerCount = Math.max(0, state.viewerCount - 1)
      if (state.viewerCount === 0) {
        /* Freeze the position instead of zeroing it, so re-opening the room
           within the grace window resumes where they left off. */
        parkRoom(slug, state)
      }
      broadcastViewerCount(server, slug, state.viewerCount)
    }
    if (rooms.has(slug)) broadcastRoomUsers(server, slug)
    evaluateBufferGate(server, slug)
  })

  /**
   * `disconnecting` fires while `socket.rooms` is still populated, so we can
   * tell which room the socket was watching and decrement its count.
   */
  socket.on('disconnecting', () => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || !socket.rooms.has(slug)) return

    /**
     * If the socket drops mid-broadcast, close its voice stream so every
     * listener can tear the playback pipeline down cleanly.
     */
    socket.to(slug).emit('voice_end', { id: socket.id })
    /* Clear any "is writing…" bubble so a disconnect mid-typing doesn't stick. */
    socket.to(slug).emit('typing', { id: socket.id, name: '', typing: false })

    /* Remove from presence tracking and broadcast updated list. */
    removeRoomUser(slug, socket.id)
    if (rooms.has(slug)) {
      broadcastRoomUsers(server, slug)
    }

    /**
     * Clear any pending buffering state this socket had and re-evaluate
     * the gate — if this was the last slow viewer, the room can resume.
     */
    clearBuffering(slug, socket.id)
    evaluateBufferGate(server, slug)

    const state = rooms.get(slug)
    if (!state) return

    state.viewerCount = Math.max(0, state.viewerCount - 1)

    /**
     * When the last viewer drops, *park* the room rather than zeroing it: its
     * position is frozen so a viewer who returns within the grace window (a
     * brief network drop, a reopened tab) resumes exactly where they were. A
     * full reset/cleanup runs only if the room stays empty past the window.
     */
    if (state.viewerCount === 0) {
      parkRoom(slug, state)
    }

    broadcastViewerCount(server, slug, state.viewerCount)
  })

  socket.on('disconnect', () => {
    chatRateState.delete(socket.id)
  })
}

/**
 * Attaches a Socket.io server to the given Node HTTP server and registers all
 * watch-party event handlers. Called once, from the Socket provider.
 */
export function boot(httpServer: HttpServer): Server {
  if (io) return io

  io = new Server(httpServer, {
    cors: { origin: '*' },
    /**
     * Compress frames at the WebSocket transport (permessage-deflate) rather
     * than per message in app code — short chat strings would only grow under
     * gzip-style headers, but the WS layer skips anything under `threshold` and
     * deflates the larger payloads (chat history backlog, long messages) for
     * free, transparently on both web and native clients. Binary voice audio is
     * already compressed, so its relay opts out below via `.compress(false)`.
     */
    perMessageDeflate: { threshold: 1024 },
  })

  io.on('connection', (socket) => registerHandlers(io as Server, socket))

  return io
}
