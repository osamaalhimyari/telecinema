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

import { Server, type Socket } from 'socket.io'
import type { Server as HttpServer } from 'node:http'

/**
 * The authoritative playback state for a single room.
 */
interface RoomState {
  isPlaying: boolean
  currentTime: number
  /** Date.now() of the last state change — used to extrapolate drift. */
  lastUpdated: number
  viewerCount: number
}

/**
 * Payloads exchanged with clients.
 */
interface JoinRoomPayload {
  roomSlug?: unknown
}

interface ControlPayload {
  action?: unknown
  currentTime?: unknown
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
    state = { isPlaying: false, currentTime: 0, lastUpdated: Date.now(), viewerCount: 0 }
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
  return state.currentTime + (Date.now() - state.lastUpdated) / 1000
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
  rooms.delete(slug)
  io?.to(slug).emit('room_deleted')
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

/**
 * Wires up all event handlers for a freshly connected socket.
 */
function registerHandlers(server: Server, socket: Socket) {
  /**
   * A home-page client subscribing to live viewer counts.
   */
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

    const state = getRoomState(slug)
    if (!alreadyInRoom) {
      state.viewerCount += 1
    }

    socket.emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: effectiveTime(state),
      serverTime: Date.now(),
    })

    if (!alreadyInRoom) {
      broadcastViewerCount(server, slug, state.viewerCount)
    }
  })

  /**
   * A playback control action. We update the master state and relay a `sync`
   * to every *other* client in the room (never back to the sender).
   */
  socket.on('control', (payload: ControlPayload) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    const action = payload?.action
    const currentTime = Number(payload?.currentTime)
    if (
      (action !== 'play' && action !== 'pause' && action !== 'seek') ||
      !Number.isFinite(currentTime)
    ) {
      return
    }

    const state = getRoomState(slug)
    state.currentTime = Math.max(0, currentTime)
    state.lastUpdated = Date.now()
    if (action === 'play') state.isPlaying = true
    else if (action === 'pause') state.isPlaying = false
    // `seek` keeps the existing play/pause status.

    socket.to(slug).emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
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
    socket.to(slug).emit('voice_start', { id: socket.id, mimeType })
  })

  socket.on('voice_chunk', (chunk: unknown) => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    socket.to(slug).emit('voice_chunk', { id: socket.id, chunk })
  })

  socket.on('voice_end', () => {
    const slug = socket.data.roomSlug
    if (typeof slug !== 'string' || slug.length === 0) return

    socket.to(slug).emit('voice_end', { id: socket.id })
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

    const state = rooms.get(slug)
    if (!state) return

    state.viewerCount = Math.max(0, state.viewerCount - 1)

    /**
     * When the last viewer leaves, reset the room so the next person to
     * arrive starts from a clean, paused state.
     */
    if (state.viewerCount === 0) {
      state.isPlaying = false
      state.currentTime = 0
      state.lastUpdated = Date.now()
    }

    broadcastViewerCount(server, slug, state.viewerCount)
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
  })

  io.on('connection', (socket) => registerHandlers(io as Server, socket))

  return io
}
