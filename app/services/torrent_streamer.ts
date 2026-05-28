/*
|--------------------------------------------------------------------------
| Torrent streamer — "create a room from a magnet link"
|--------------------------------------------------------------------------
|
| A visitor pastes a magnet URI instead of uploading a file. The server adds
| it to a single shared WebTorrent client, waits only for the torrent
| *metadata* (not the whole download), picks the largest video file, and
| creates the room. Playback then streams that file over `/stream/:slug` with
| HTTP range support — pieces are fetched from the swarm on demand and cached
| under `storage/torrents/`, so nothing has to finish downloading first.
|
| Like the URL downloader, room creation runs detached from the request: the
| request returns a `jobId` straight away and the client polls
| `getTorrentJob` (surfaced through the same `/api/rooms/download/:jobId`
| endpoint) until the room exists.
|
*/

import { mkdir } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebTorrent, { type Torrent, type TorrentFile } from 'webtorrent'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import Room from '#models/room'

/** Containers libmpv (the Flutter player) can stream — wider than browsers. */
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mkv', '.ogv', '.ogg', '.mov', '.avi']

/** How long to wait for swarm metadata before giving up on a magnet. */
const METADATA_TIMEOUT_MS = 90 * 1000

/** Finished jobs linger this long so the client's final poll can read them. */
const JOB_TTL_MS = 5 * 60 * 1000

/** Error message keys the client can translate (see `lang/*.dart`). */
const ERR_INVALID = 'torrent_invalid_magnet'
const ERR_TIMEOUT = 'torrent_timeout'
const ERR_NO_VIDEO = 'torrent_no_video'
const ERR_FAILED = 'torrent_failed'
const KNOWN_ERRORS = new Set([ERR_INVALID, ERR_TIMEOUT, ERR_NO_VIDEO, ERR_FAILED])

/**
 * Observable state of one magnet → room job. Shaped like the URL downloader's
 * job so the shared progress endpoint serves both transparently. `percent`
 * stays null: the room is created as soon as metadata arrives, so there is no
 * meaningful download bar before playback.
 */
export interface TorrentJob {
  status: 'downloading' | 'done' | 'error'
  percent: number | null
  bytesDownloaded: number
  totalBytes: number | null
  error: string | null
  slug: string | null
  updatedAt: number
}

const torrentJobs = new Map<string, TorrentJob>()

/** Current state of a torrent room-creation job, or undefined once evicted. */
export function getTorrentJob(jobId: string): TorrentJob | undefined {
  return torrentJobs.get(jobId)
}

/**
 * One process-wide WebTorrent client, created lazily so importing this module
 * never spins up networking until a torrent is actually needed.
 */
let client: WebTorrent | null = null
function getClient(): WebTorrent {
  if (!client) {
    client = new WebTorrent()
    client.on('error', () => {
      /* swallow client-level errors; per-torrent errors are handled inline */
    })
  }
  return client
}

/** Added torrents, keyed by their (normalized) magnet — the swarm's identity. */
const active = new Map<string, Torrent>()
/** In-flight `add` calls, so concurrent requests for one magnet share a torrent. */
const pending = new Map<string, Promise<Torrent>>()

/**
 * Accepts a full `magnet:?…` URI or a bare info hash (hex or base32) and
 * returns a canonical magnet URI. Throws [ERR_INVALID] for anything else.
 */
function normalizeMagnet(raw: string): string {
  const value = (raw ?? '').trim()
  if (value.toLowerCase().startsWith('magnet:?')) return value
  if (/^[a-f0-9]{40}$/i.test(value)) return `magnet:?xt=urn:btih:${value.toLowerCase()}`
  if (/^[a-z2-7]{32}$/i.test(value)) return `magnet:?xt=urn:btih:${value.toUpperCase()}`
  throw new Error(ERR_INVALID)
}

/** Largest video file in the torrent (falls back to the largest file overall). */
function pickVideoFile(torrent: Torrent): TorrentFile | null {
  const videos = torrent.files.filter((f) => VIDEO_EXTENSIONS.includes(extname(f.name).toLowerCase()))
  const pool = videos.length > 0 ? videos : torrent.files
  if (pool.length === 0) return null
  return pool.reduce((largest, f) => (f.length > largest.length ? f : largest))
}

/**
 * Narrows the torrent's download to just the chosen video file, so sample
 * clips and `.nfo` files in the same swarm never waste bandwidth. Best-effort —
 * never lets a selection hiccup break streaming.
 */
function selectOnlyVideo(torrent: Torrent): void {
  try {
    const file = pickVideoFile(torrent)
    for (const f of torrent.files) f.deselect()
    file?.select()
  } catch {
    /* selection API drift across versions — fall back to downloading all */
  }
}

/**
 * Adds a magnet to the client and resolves once metadata is ready. Concurrent
 * adds of the same magnet share one torrent, and ready torrents are reused.
 */
function ensureTorrent(magnet: string): Promise<Torrent> {
  const existing = active.get(magnet)
  if (existing) return Promise.resolve(existing)

  const inflight = pending.get(magnet)
  if (inflight) return inflight

  const promise = new Promise<Torrent>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(ERR_TIMEOUT))
    }, METADATA_TIMEOUT_MS)
    timer.unref()

    try {
      const torrent = getClient().add(magnet, { path: app.makePath('storage/torrents') }, (ready) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        selectOnlyVideo(ready)
        resolve(ready)
      })
      torrent.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(ERR_FAILED))
    }
  })

  const tracked = promise.then(
    (torrent) => {
      active.set(magnet, torrent)
      pending.delete(magnet)
      return torrent
    },
    (err) => {
      pending.delete(magnet)
      throw err
    }
  )

  pending.set(magnet, tracked)
  return tracked
}

/** Builds a URL-safe slug from a room name (twin of the controller helper). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'room'
  let slug = base
  while (await Room.findBy('slug', slug)) {
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
  }
  return slug
}

function scheduleEviction(jobId: string): void {
  setTimeout(() => torrentJobs.delete(jobId), JOB_TTL_MS).unref()
}

function errorKey(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return KNOWN_ERRORS.has(message) ? message : ERR_FAILED
}

/**
 * Adds the magnet, picks the video file, and creates the room row once metadata
 * is in hand. Never throws — every failure is recorded on the job instead.
 */
async function runTorrentRoom(
  jobId: string,
  magnet: string,
  name: string,
  password: string | null,
  reactions: string | null
): Promise<void> {
  const job = torrentJobs.get(jobId)
  if (!job) return

  try {
    await mkdir(app.makePath('storage/torrents'), { recursive: true })

    const torrent = await ensureTorrent(magnet)
    const file = pickVideoFile(torrent)
    if (!file) throw new Error(ERR_NO_VIDEO)

    job.totalBytes = file.length

    const slug = await uniqueSlug(name)
    await Room.create({
      name,
      slug,
      videoFilename: basename(file.name),
      thumbnailFilename: '',
      roomType: 'torrent',
      externalUrl: null,
      magnet,
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
      reactions: reactions ?? null,
    })

    job.status = 'done'
    job.slug = slug
    job.percent = 100
    job.updatedAt = Date.now()
  } catch (err) {
    job.status = 'error'
    job.error = errorKey(err)
    job.updatedAt = Date.now()
  }

  scheduleEviction(jobId)
}

/**
 * Starts creating a room from `magnet` and returns the id the client polls for
 * progress. Throws synchronously (with a translatable key) for a malformed
 * magnet; every later failure surfaces through the job.
 */
export function startTorrentRoom(opts: {
  name: string
  password: string | null
  magnet: string
  reactions?: string | null
}): string {
  const magnet = normalizeMagnet(opts.magnet)
  const jobId = randomUUID()

  torrentJobs.set(jobId, {
    status: 'downloading',
    percent: null,
    bytesDownloaded: 0,
    totalBytes: null,
    error: null,
    slug: null,
    updatedAt: Date.now(),
  })

  /** Detached on purpose: progress is observed via `getTorrentJob`. */
  void runTorrentRoom(jobId, magnet, opts.name, opts.password, opts.reactions ?? null)

  return jobId
}

/**
 * Ensures a torrent room's swarm is live and returns the streamable file. Used
 * by the `/stream/:slug` endpoint, so the torrent self-heals after a server
 * restart (the magnet is re-added on the first playback request).
 */
export async function ensureRoomTorrent(room: Room): Promise<{ torrent: Torrent; file: TorrentFile }> {
  if (!room.magnet) throw new Error(ERR_NO_VIDEO)
  const torrent = await ensureTorrent(normalizeMagnet(room.magnet))

  const wanted = room.videoFilename ? basename(room.videoFilename) : null
  const matched = wanted ? torrent.files.find((f) => basename(f.name) === wanted) : null
  const file = matched ?? pickVideoFile(torrent)
  if (!file) throw new Error(ERR_NO_VIDEO)

  return { torrent, file }
}

/**
 * Removes a torrent room's swarm and deletes its cached pieces from disk.
 * Called when the room is deleted.
 */
export function removeRoomTorrent(room: Room): void {
  if (!room.magnet) return
  let magnet: string
  try {
    magnet = normalizeMagnet(room.magnet)
  } catch {
    return
  }
  const torrent = active.get(magnet)
  if (!torrent) return
  active.delete(magnet)
  try {
    getClient().remove(torrent, { destroyStore: true })
  } catch {
    /* already gone */
  }
}
