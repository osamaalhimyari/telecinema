/*
|--------------------------------------------------------------------------
| Video downloader — server-side "create a room from a link"
|--------------------------------------------------------------------------
|
| Instead of uploading a video, a visitor can paste a direct link to one.
| The server fetches that file into `storage/videos/` itself, and only once
| the bytes are safely on disk is the room row created.
|
| A download runs detached from the HTTP request that started it: the request
| returns a `jobId` straight away, and the browser then polls `getJob` for the
| live byte count. Job state lives in this in-memory map — good enough for a
| single-process app, and it disappears (along with any half-written file) if
| the server restarts mid-download.
|
*/

import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { extname } from 'node:path'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import Room from '#models/room'

/**
 * Container extensions a downloaded video may end up with — kept in step with
 * `VIDEO_EXTENSIONS` in RoomsController so uploads and links behave alike.
 */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov']

/**
 * Hard ceiling on a downloaded file, matching `MAX_VIDEO_SIZE` in
 * RoomsController. Enforced both from the `Content-Length` header and again
 * from the running byte count, since a server may omit or understate it.
 */
const MAX_VIDEO_BYTES = 15 * 1024 ** 3

/**
 * Maps a response `Content-Type` to a file extension, used when the URL
 * itself carries no recognizable one.
 */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
}

/**
 * Finished jobs linger this long so the browser's final poll can still read
 * the outcome, then evict themselves.
 */
const JOB_TTL_MS = 5 * 60 * 1000

/**
 * Lifecycle of a single download. `downloading` is the only non-terminal
 * state; both `done` and `error` are final.
 */
export type DownloadStatus = 'downloading' | 'done' | 'error'

/**
 * The observable state of one download job. The browser reads this — never
 * the file itself — to drive its progress bar.
 */
export interface DownloadJob {
  status: DownloadStatus
  /** 0–100 once the total size is known; null while it is not (chunked responses). */
  percent: number | null
  bytesDownloaded: number
  /** Total size from `Content-Length`, or null when the server did not send it. */
  totalBytes: number | null
  /** Human-readable failure reason, set only when `status` is `error`. */
  error: string | null
  /** Room URL to redirect the creator to, set only when `status` is `done`. */
  redirectTo: string | null
  /** Id of the created room, so the poll endpoint can unlock it in session. */
  roomId: number | null
  roomHasPassword: boolean
  /** `Date.now()` of the last change — used to time out the job's eviction. */
  updatedAt: number
}

/**
 * Every known download job, keyed by an opaque id handed to the browser.
 */
const jobs = new Map<string, DownloadJob>()

/**
 * Returns a job's current state, or `undefined` once it has been evicted.
 */
export function getJob(jobId: string): DownloadJob | undefined {
  return jobs.get(jobId)
}

/**
 * Builds a URL-safe slug from a free-text room name. A deliberate twin of the
 * helper in RoomsController: a trivial pure function is clearer duplicated
 * here than shared through a controller import.
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
 * Parses a user-supplied link, rejecting anything that is not a well-formed
 * http(s) URL. Runs synchronously so an obviously bad link fails the request
 * outright instead of through a polled job.
 */
function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('That does not look like a valid link.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links can be downloaded.')
  }
  return url
}

/**
 * True for addresses the server must never be tricked into fetching —
 * loopback, link-local, and the private IPv4/IPv6 ranges. This blocks the
 * obvious SSRF: a link aimed at the server's own network.
 */
function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase()

  /** IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is judged by its IPv4 part. */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (mapped) addr = mapped[1]

  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }

  return (
    addr === '::1' ||
    addr === '::' ||
    addr.startsWith('fe80:') ||
    addr.startsWith('fc') ||
    addr.startsWith('fd')
  )
}

/**
 * Resolves the URL's host and refuses the download if it points anywhere
 * private. DNS names are looked up so a public name cannot alias a private
 * address.
 */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address)
    } catch {
      throw new Error('The host in that link could not be found.')
    }
  }

  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new Error('That link points to a private or unreachable address.')
  }
}

/**
 * Picks the saved file's extension: the URL's own extension when it is a
 * known video container, otherwise the response `Content-Type`. Returns an
 * empty string when neither names a video, so the caller can reject the link.
 */
function resolveExtension(url: URL, contentType: string | null): string {
  const urlExt = extname(url.pathname).replace(/^\./, '').toLowerCase()
  if (VIDEO_EXTENSIONS.includes(urlExt)) return urlExt

  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (CONTENT_TYPE_EXTENSIONS[type]) return CONTENT_TYPE_EXTENSIONS[type]
  if (type.startsWith('video/')) return 'mp4'

  return ''
}

/**
 * Inserts the room row once its video file is on disk. The temp file is
 * renamed to a slug-based name — a same-directory rename, so it is atomic and
 * the half-written `.part` file is never reachable through `/video/:filename`.
 */
async function createRoom(
  name: string,
  password: string | null,
  reactions: string | null,
  category: string | null,
  imdbId: string | null,
  tmpPath: string,
  ext: string
): Promise<Room> {
  const base = slugify(name) || 'room'
  let slug = base
  while (await Room.findBy('slug', slug)) {
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
  }

  const videoFilename = `${slug}.${ext}`
  await rename(tmpPath, app.makePath('storage/videos', videoFilename))

  return Room.create({
    name,
    slug,
    videoFilename,
    thumbnailFilename: '',
    roomType: 'download',
    externalUrl: null,
    isUserCreated: true,
    passwordHash: password ? await hash.make(password) : null,
    reactions: reactions ?? null,
    category: category ?? null,
    imdbId: imdbId ?? null,
  })
}

/**
 * Removes a finished job from memory after a grace period long enough for the
 * browser to read its final state. `unref` keeps the timer from holding the
 * process open.
 */
function scheduleEviction(jobId: string): void {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS).unref()
}

/**
 * Runs one download to completion: fetch the URL, stream it to a temp file
 * while updating the job's byte count, then create the room. Every failure
 * path deletes the partial file and records the reason on the job — it never
 * throws, since nothing awaits it.
 */
async function runDownload(
  jobId: string,
  url: URL,
  name: string,
  password: string | null,
  reactions: string | null,
  category: string | null,
  imdbId: string | null
): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return

  const tmpPath = app.makePath('storage/videos', `.download-${jobId}.part`)

  try {
    await mkdir(app.makePath('storage/videos'), { recursive: true })
    await assertPublicHost(url)

    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'WatchParty/1.0 (+room video downloader)' },
    })
    if (!response.ok || !response.body) {
      throw new Error(`The link could not be reached (HTTP ${response.status}).`)
    }

    const ext = resolveExtension(url, response.headers.get('content-type'))
    if (!ext) {
      throw new Error('That link does not point to a supported video file.')
    }

    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared)) {
      if (declared > MAX_VIDEO_BYTES) {
        throw new Error('That video is larger than the 15 GB limit.')
      }
      job.totalBytes = declared
    }

    /**
     * A pass-through that tallies bytes for the progress bar and trips the
     * size limit the moment it is crossed, even when no `Content-Length` was
     * advertised.
     */
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        job.bytesDownloaded += chunk.length
        if (job.bytesDownloaded > MAX_VIDEO_BYTES) {
          callback(new Error('That video is larger than the 15 GB limit.'))
          return
        }
        job.percent = job.totalBytes
          ? Math.min(99, Math.floor((job.bytesDownloaded / job.totalBytes) * 100))
          : null
        job.updatedAt = Date.now()
        callback(null, chunk)
      },
    })

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(tmpPath)
    )

    /** The bytes are on disk — only now does the room come into existence. */
    const room = await createRoom(name, password, reactions, category, imdbId, tmpPath, ext)

    job.status = 'done'
    job.percent = 100
    job.redirectTo = `/room/${room.slug}`
    job.roomId = room.id
    job.roomHasPassword = room.hasPassword
    job.updatedAt = Date.now()
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    job.status = 'error'
    job.error = error instanceof Error ? error.message : 'The video could not be downloaded.'
    job.updatedAt = Date.now()
  }

  scheduleEviction(jobId)
}

/**
 * Starts downloading `url` into a new room video and returns the id the
 * browser polls for progress. Throws synchronously for a malformed link so
 * the caller can answer the request with an immediate error; every later
 * failure surfaces through the job instead.
 */
export function startUrlDownload(opts: {
  name: string
  password: string | null
  url: string
  reactions?: string | null
  category?: string | null
  imdbId?: string | null
}): string {
  const url = parseHttpUrl(opts.url)
  const jobId = randomUUID()

  jobs.set(jobId, {
    status: 'downloading',
    percent: null,
    bytesDownloaded: 0,
    totalBytes: null,
    error: null,
    redirectTo: null,
    roomId: null,
    roomHasPassword: false,
    updatedAt: Date.now(),
  })

  /** Detached on purpose: progress is observed via `getJob`, never awaited. */
  void runDownload(
    jobId,
    url,
    opts.name,
    opts.password,
    opts.reactions ?? null,
    opts.category ?? null,
    opts.imdbId ?? null
  )

  return jobId
}
