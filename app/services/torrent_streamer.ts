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

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, unlink } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
// Type-only imports — fully erased at build, so they never load the webtorrent
// runtime. The actual module is pulled in lazily via `await import()` below.
import type WebTorrent from 'webtorrent'
import type { Torrent, TorrentFile } from 'webtorrent'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import logger from '@adonisjs/core/services/logger'
import Room from '#models/room'

/** Containers libmpv (the Flutter player) can stream — wider than browsers. */
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mkv', '.ogv', '.ogg', '.mov', '.avi']

/** How long to wait for swarm metadata before giving up on a magnet. */
const METADATA_TIMEOUT_MS = 90 * 1000

/** Hard ceiling on a fully-downloaded magnet file — matches the URL downloader. */
const MAX_VIDEO_BYTES = 15 * 1024 ** 3

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
  /** Device that started the job (from `x-device-id`), so the client can list
   * its own operations across a socket reconnect. */
  deviceId: string | null
  /** Room name being created — shown in the client's operations panel. */
  name: string
  /** `'torrent'` (stream) or `'magnet-download'` (full fetch to disk). */
  kind: string
  /** `Date.now()` the job started — for newest-first ordering. */
  createdAt: number
  /** Set true by `cancelTorrentJob`; the run aborts at its next checkpoint. */
  canceled: boolean
}

/** Transfer kinds reported to the client's operations panel. */
export const TORRENT_KIND = 'torrent'
export const MAGNET_DOWNLOAD_KIND = 'magnet-download'

/** A torrent job's public shape for the operations list (mirrors the URL
 * downloader's `OperationView`). */
export interface TorrentOperationView {
  id: string
  kind: string
  name: string
  status: 'downloading' | 'done' | 'error'
  percent: number | null
  bytesDownloaded: number
  totalBytes: number | null
  error: string | null
  slug: string | null
  createdAt: number
}

const torrentJobs = new Map<string, TorrentJob>()

/** Current state of a torrent room-creation job, or undefined once evicted. */
export function getTorrentJob(jobId: string): TorrentJob | undefined {
  return torrentJobs.get(jobId)
}

/** Every torrent/magnet job for [deviceId] (caller orders them). */
export function listTorrentJobs(deviceId: string | null): TorrentOperationView[] {
  if (!deviceId) return []
  const out: TorrentOperationView[] = []
  for (const [id, job] of torrentJobs) {
    if (job.deviceId !== deviceId) continue
    out.push({
      id,
      kind: job.kind,
      name: job.name,
      status: job.status,
      percent: job.percent,
      bytesDownloaded: job.bytesDownloaded,
      totalBytes: job.totalBytes,
      error: job.error,
      slug: job.slug,
      createdAt: job.createdAt,
    })
  }
  return out
}

/**
 * Flags a running torrent/magnet job (owned by [deviceId]) for cancellation.
 * The detached run checks the flag at its next checkpoint — after metadata and
 * on every streamed chunk — then aborts and cleans up. Returns true when a
 * matching, still-running job was found.
 */
export function cancelTorrentJob(jobId: string, deviceId: string | null): boolean {
  const job = torrentJobs.get(jobId)
  if (!job || (deviceId && job.deviceId !== deviceId)) return false
  if (job.status !== 'downloading') return false
  job.canceled = true
  return true
}

/**
 * One process-wide WebTorrent client, created lazily via a *dynamic* import.
 *
 * The room controllers import this module, so a static `import 'webtorrent'`
 * would load the whole BitTorrent runtime at boot — and if it failed to load on
 * a given host, it would take down *all* room routes with it. Importing it only
 * when a torrent is actually needed means a webtorrent problem can never break
 * normal (upload/download/external) rooms.
 */
let client: WebTorrent | null = null
async function getClient(): Promise<WebTorrent> {
  if (!client) {
    installCrashGuards()
    const { default: WebTorrentCtor } = await import('webtorrent')
    client = new WebTorrentCtor()
    client.on('error', () => {
      /* swallow client-level errors; per-torrent errors are handled inline */
    })
  }
  return client
}

/**
 * WebTorrent can throw from its own internal timers/microtasks (piece
 * bookkeeping races), which surface as `uncaughtException` and would otherwise
 * kill the whole Node process — taking every room down with it. Installed once,
 * only when a torrent is first used: swallow + log errors that originate inside
 * webtorrent, and let everything else crash the process as normal so real bugs
 * are never hidden.
 */
let crashGuardsInstalled = false
function installCrashGuards(): void {
  if (crashGuardsInstalled) return
  crashGuardsInstalled = true

  const fromWebtorrent = (e: unknown): boolean =>
    e instanceof Error && typeof e.stack === 'string' && e.stack.includes('webtorrent')

  process.on('uncaughtException', (err) => {
    if (fromWebtorrent(err)) {
      logger.error({ err }, '[torrent] swallowed WebTorrent uncaught exception')
      return
    }
    throw err
  })
  process.on('unhandledRejection', (reason) => {
    if (fromWebtorrent(reason)) {
      logger.error({ err: reason }, '[torrent] swallowed WebTorrent unhandled rejection')
      return
    }
    throw reason
  })
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
 * Adds a magnet to the client and resolves once metadata is ready. Concurrent
 * adds of the same magnet share one torrent, and ready torrents are reused.
 */
function ensureTorrent(magnet: string): Promise<Torrent> {
  const existing = active.get(magnet)
  if (existing) return Promise.resolve(existing)

  const inflight = pending.get(magnet)
  if (inflight) return inflight

  const promise = (async (): Promise<Torrent> => {
    const wt = await getClient()
    return new Promise<Torrent>((resolve, reject) => {
      let settled = false
      let torrent: Torrent | null = null

      // On any failure, destroy the half-added torrent. Otherwise a magnet that
      // times out stays registered in the client by its info hash, and every
      // later attempt at the same content fails instantly as a duplicate.
      const finish = (err: Error | null, ready?: Torrent) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          if (torrent) {
            try {
              torrent.destroy()
            } catch {
              /* already torn down */
            }
          }
          reject(err)
        } else {
          resolve(ready as Torrent)
        }
      }

      const timer = setTimeout(() => finish(new Error(ERR_TIMEOUT)), METADATA_TIMEOUT_MS)
      timer.unref()

      try {
        // NOTE: we deliberately do NOT deselect the other files. Calling
        // `file.deselect()` / `select()` here triggers a known WebTorrent crash
        // (`Cannot read properties of null (reading 'reserve')` thrown from a
        // microtask, which would take the whole process down). `createReadStream`
        // already prioritizes the requested byte range on its own.
        torrent = wt.add(magnet, { path: app.makePath('storage/torrents') }, (ready) => finish(null, ready))
        torrent.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
      } catch (err) {
        finish(err instanceof Error ? err : new Error(ERR_FAILED))
      }
    })
  })()

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
  reactions: string | null,
  category: string | null,
  imdbId: string | null,
  thumbnail: string | null
): Promise<void> {
  const job = torrentJobs.get(jobId)
  if (!job) return

  try {
    await mkdir(app.makePath('storage/torrents'), { recursive: true })

    const torrent = await ensureTorrent(magnet)
    if (job.canceled) throw new Error('operation_canceled')
    const file = pickVideoFile(torrent)
    if (!file) throw new Error(ERR_NO_VIDEO)

    job.totalBytes = file.length

    const slug = await uniqueSlug(name)
    // The slug lookup awaits the DB, so a cancel can land between the checkpoint
    // above and here — re-check so a canceled job never creates a room.
    if (job.canceled) throw new Error('operation_canceled')
    await Room.create({
      name,
      slug,
      videoFilename: basename(file.name),
      // The folder WebTorrent cached the pieces under (storage/torrents/<name>),
      // recorded so the room's files can be deleted by path on teardown.
      torrentDir: torrent.name,
      // A real poster if one was passed; otherwise a random placeholder (model hook).
      thumbnailFilename: thumbnail ?? '',
      roomType: 'torrent',
      externalUrl: null,
      magnet,
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
      reactions: reactions ?? null,
      category: category ?? null,
      imdbId: imdbId ?? null,
    })

    // Metadata is all the server needed: the room now exists, and from here the
    // clients stream the torrent themselves — the mobile app on-device, the web
    // peer-to-peer in the browser. So drop the swarm from the server instead of
    // letting WebTorrent download the entire movie in the background. If a web
    // client ever finds no peers, /stream/:slug re-adds the magnet on demand
    // (the only path that makes the server touch the swarm at all).
    try {
      active.delete(magnet)
      client?.remove(torrent, { destroyStore: true })
    } catch {
      /* already torn down */
    }

    job.status = 'done'
    job.slug = slug
    job.percent = 100
    job.updatedAt = Date.now()
  } catch (err) {
    job.status = 'error'
    job.error = job.canceled ? 'operation_canceled' : errorKey(err)
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
  category?: string | null
  imdbId?: string | null
  thumbnail?: string | null
  deviceId?: string | null
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
    deviceId: opts.deviceId ?? null,
    name: opts.name,
    kind: TORRENT_KIND,
    createdAt: Date.now(),
    canceled: false,
  })

  /** Detached on purpose: progress is observed via `getTorrentJob`. */
  void runTorrentRoom(
    jobId,
    magnet,
    opts.name,
    opts.password,
    opts.reactions ?? null,
    opts.category ?? null,
    opts.imdbId ?? null,
    opts.thumbnail ?? null
  )

  return jobId
}

/**
 * Fully downloads a magnet's video to `storage/videos/` and creates a normal
 * **file** room (`roomType: 'download'`) from it — the swarm copy is then
 * dropped, so playback afterwards streams straight off disk via
 * `/video/:filename` with no live peers. This is the "let the *server* fetch
 * the magnet" path (the `torrent` room type instead streams on demand, and the
 * app streams that on-device); here every client just plays the server's file.
 *
 * Shares the same job map + poll endpoint as the swarm-stream flow, but reports
 * a real `percent` because there is a finite file to download. Never throws —
 * failures are recorded on the job, mirroring the URL downloader.
 */
async function runMagnetDownload(
  jobId: string,
  magnet: string,
  name: string,
  password: string | null,
  reactions: string | null,
  category: string | null,
  imdbId: string | null,
  thumbnail: string | null
): Promise<void> {
  const job = torrentJobs.get(jobId)
  if (!job) return

  const tmpPath = app.makePath('storage/videos', `.magnet-${jobId}.part`)

  try {
    await mkdir(app.makePath('storage/videos'), { recursive: true })

    const torrent = await ensureTorrent(magnet)
    if (job.canceled) throw new Error('operation_canceled')
    const file = pickVideoFile(torrent)
    if (!file) throw new Error(ERR_NO_VIDEO)
    if (file.length > MAX_VIDEO_BYTES) throw new Error(ERR_FAILED)

    job.totalBytes = file.length

    /** Tallies bytes for the progress bar as pieces stream in from the swarm,
     * and aborts the pipeline the moment the user cancels the operation. */
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (job.canceled) {
          callback(new Error('operation_canceled'))
          return
        }
        job.bytesDownloaded += chunk.length
        job.percent = job.totalBytes
          ? Math.min(99, Math.floor((job.bytesDownloaded / job.totalBytes) * 100))
          : null
        job.updatedAt = Date.now()
        callback(null, chunk)
      },
    })

    // Reading the file end-to-end pulls every piece from the swarm; the bytes
    // land on disk as a normal video file.
    await pipeline(file.createReadStream(), counter, createWriteStream(tmpPath))

    const ext = extname(file.name).replace(/^\./, '').toLowerCase() || 'mp4'
    const slug = await uniqueSlug(name)
    // Re-check before the rename so a late cancel leaves the partial at tmpPath
    // for the catch's unlink to clean up — never a stray renamed file or room.
    if (job.canceled) throw new Error('operation_canceled')
    const videoFilename = `${slug}.${ext}`
    await rename(tmpPath, app.makePath('storage/videos', videoFilename))

    await Room.create({
      name,
      slug,
      videoFilename,
      // A real poster if one was passed; otherwise a random placeholder (model hook).
      thumbnailFilename: thumbnail ?? '',
      roomType: 'download',
      externalUrl: null,
      magnet: null,
      isUserCreated: true,
      passwordHash: password ? await hash.make(password) : null,
      reactions: reactions ?? null,
      category: category ?? null,
      imdbId: imdbId ?? null,
    })

    // The file is on disk now — stop seeding and delete the swarm's piece cache
    // under storage/torrents so we are not keeping two copies.
    try {
      active.delete(magnet)
      client?.remove(torrent, { destroyStore: true })
    } catch {
      /* already torn down */
    }

    job.status = 'done'
    job.slug = slug
    job.percent = 100
    job.bytesDownloaded = file.length
    job.updatedAt = Date.now()
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    job.status = 'error'
    job.error = job.canceled ? 'operation_canceled' : errorKey(err)
    job.updatedAt = Date.now()
  }

  scheduleEviction(jobId)
}

/**
 * Starts a full server-side download of `magnet` into a file room and returns
 * the id the client polls (same `getTorrentJob` endpoint as the stream flow).
 * Throws synchronously for a malformed magnet; later failures surface on the job.
 */
export function startMagnetDownload(opts: {
  name: string
  password: string | null
  magnet: string
  reactions?: string | null
  category?: string | null
  imdbId?: string | null
  thumbnail?: string | null
  deviceId?: string | null
}): string {
  const magnet = normalizeMagnet(opts.magnet)
  const jobId = randomUUID()

  torrentJobs.set(jobId, {
    status: 'downloading',
    percent: 0,
    bytesDownloaded: 0,
    totalBytes: null,
    error: null,
    slug: null,
    updatedAt: Date.now(),
    deviceId: opts.deviceId ?? null,
    name: opts.name,
    kind: MAGNET_DOWNLOAD_KIND,
    createdAt: Date.now(),
    canceled: false,
  })

  /** Detached on purpose: progress is observed via `getTorrentJob`. */
  void runMagnetDownload(
    jobId,
    magnet,
    opts.name,
    opts.password,
    opts.reactions ?? null,
    opts.category ?? null,
    opts.imdbId ?? null,
    opts.thumbnail ?? null
  )

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
 *
 * Two cleanup paths, since either may apply:
 *   - If the swarm is still live in this process, removing it from the client
 *     with `destroyStore` tears down the peers *and* deletes the cached files.
 *   - Otherwise — e.g. the server restarted since the room was last streamed,
 *     so the torrent was never re-added — there is nothing in memory to remove,
 *     so the cached directory is deleted straight off disk by the name recorded
 *     when the room was created.
 */
export async function removeRoomTorrent(room: Room): Promise<void> {
  if (room.magnet && client) {
    try {
      const magnet = normalizeMagnet(room.magnet)
      const torrent = active.get(magnet)
      if (torrent) {
        active.delete(magnet)
        client.remove(torrent, { destroyStore: true })
        return
      }
    } catch {
      /* malformed magnet / already torn down — fall through to the disk sweep */
    }
  }

  // No live swarm to destroy: delete the cached directory by path. `basename`
  // keeps the delete confined to storage/torrents (no traversal via a crafted
  // torrent name); recursive+force makes a missing directory a no-op.
  if (room.torrentDir) {
    try {
      await rm(app.makePath('storage/torrents', basename(room.torrentDir)), {
        recursive: true,
        force: true,
      })
    } catch {
      /* already gone */
    }
  }
}
