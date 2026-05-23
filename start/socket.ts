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
  rooms.delete(slug)
  roomChats.delete(slug)
  roomUsers.delete(slug)
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

    state.currentTime = Math.max(0, currentTime)
    state.lastUpdated = Date.now()
    if (action === 'play') state.isPlaying = true
    else if (action === 'pause') state.isPlaying = false
    // `seek` keeps the existing play/pause status.

    socket.to(slug).emit('sync', {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      serverTime: Date.now(),
    })
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

    if (!withinChatRate(socket.id)) {
      socket.emit('chat_throttled', { retryAfter: CHAT_RATE_WINDOW_MS })
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
  })

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

    socket.to(slug).emit('voice_chunk', { id: socket.id, chunk })
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

    /* Remove from presence tracking and broadcast updated list. */
    removeRoomUser(slug, socket.id)
    if (rooms.has(slug)) {
      broadcastRoomUsers(server, slug)
    }

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
      state.playbackRate = 1
      /* No one is here — let chat fade with the rest of the room state. */
      roomChats.delete(slug)
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
  })

  io.on('connection', (socket) => registerHandlers(io as Server, socket))

  return io
}
