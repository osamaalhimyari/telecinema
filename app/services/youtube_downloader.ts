/*
|--------------------------------------------------------------------------
| YouTube downloader — "create a room from a YouTube link"
|--------------------------------------------------------------------------
|
| A visitor pastes a YouTube URL instead of a direct video link. YouTube is
| not a plain file the URL downloader can stream, so the server shells out to
| `yt-dlp` (with `ffmpeg` for muxing the separate video+audio streams YouTube
| serves above 720p) to fetch the video into `storage/videos/`. Once the file
| is on disk it becomes an ordinary `roomType: 'download'` room, served over
| `/video/:filename` — so every client plays it with full seek/sync and it
| shows up in the operations panel exactly like a magnet download.
|
| The whole flow is a deliberate twin of `torrent_streamer.ts`: room creation
| runs detached from the request (the request returns a `jobId`), job state
| lives in this in-memory map, and the same `/api/rooms/download/:jobId`,
| `/api/operations` and cancel endpoints serve it through small dispatch seams
| in RoomsApiController. Nothing here is loaded unless a YouTube link is used.
|
| Binaries are resolved from `YT_DLP_PATH` / `FFMPEG_PATH` (env), falling back
| to `yt-dlp` / the system `ffmpeg` on PATH. yt-dlp is only ever pointed at
| YouTube hosts (`isYoutubeUrl`), which doubles as the SSRF guard — it is never
| handed an arbitrary or internal URL.
|
*/

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rename, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import Room from '#models/room'

/** Hard ceiling on a downloaded file — matches the URL/magnet downloaders. */
const MAX_VIDEO_SIZE_ARG = '15G'

/**
 * yt-dlp format selector: prefer an mp4 video + m4a audio under 1080p (a fast,
 * lossless mux to mp4 — the most app-compatible result), then any codec under
 * 1080p, then the best single progressive stream. `<=?1080` is non-strict so a
 * stream of unknown height is not rejected outright.
 */
const FORMAT =
  'bv*[ext=mp4][height<=?1080]+ba[ext=m4a]/bv*[height<=?1080]+ba/b[height<=?1080]/b'

/** Finished jobs linger this long so the client's final poll can read them. */
const JOB_TTL_MS = 5 * 60 * 1000

/**
 * Reported to the client's operations panel as a plain `download` — a YouTube
 * room *is* a server-downloaded file room, so the unchanged client renders and
 * cancels it identically to a URL/magnet download.
 */
const OPERATION_KIND = 'download'

/** Hostnames a pasted link must end with to be treated as YouTube. */
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']

/**
 * Resolves the two binaries lazily and defensively, so the room routes can
 * never be broken by a missing optional package (the same reasoning that makes
 * torrent_streamer load webtorrent through a guarded dynamic import).
 *
 * Resolution order, for each binary:
 *   1. An explicit env override (`YT_DLP_PATH` / `FFMPEG_PATH`) — per-host escape hatch.
 *   2. The binary bundled by the npm package (`youtube-dl-exec` / `ffmpeg-static`),
 *      so a plain `npm ci` makes the feature work with no manual install.
 *   3. The system `PATH` (`yt-dlp`), as a last resort.
 *
 * Resolved once and cached; a `require` that throws (package not installed) just
 * falls through to the next option.
 */
const nodeRequire = createRequire(import.meta.url)

let ytDlpBinCache: string | undefined
function resolveYtDlpBin(): string {
  if (ytDlpBinCache) return ytDlpBinCache
  if (process.env.YT_DLP_PATH) return (ytDlpBinCache = process.env.YT_DLP_PATH)
  try {
    const pkgDir = dirname(nodeRequire.resolve('youtube-dl-exec/package.json'))
    const names = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']
    for (const name of names) {
      const candidate = join(pkgDir, 'bin', name)
      if (existsSync(candidate)) return (ytDlpBinCache = candidate)
    }
  } catch {
    /* youtube-dl-exec not installed — fall back to PATH */
  }
  return (ytDlpBinCache = 'yt-dlp')
}

let ffmpegBinCache: string | null | undefined
function resolveFfmpegBin(): string | null {
  if (ffmpegBinCache !== undefined) return ffmpegBinCache
  if (process.env.FFMPEG_PATH) return (ffmpegBinCache = process.env.FFMPEG_PATH)
  try {
    // ffmpeg-static's module export is the absolute path to its bundled binary.
    const p = nodeRequire('ffmpeg-static') as string | null
    if (p && existsSync(p)) return (ffmpegBinCache = p)
  } catch {
    /* ffmpeg-static not installed — let yt-dlp find ffmpeg on PATH */
  }
  return (ffmpegBinCache = null)
}

/**
 * Observable state of one YouTube → room job. Shaped like the torrent job so
 * the shared progress endpoint serves all three transparently.
 */
export interface YoutubeJob {
  status: 'downloading' | 'done' | 'error'
  /** 0–99 while downloading (100 only once the room exists); null when unknown. */
  percent: number | null
  bytesDownloaded: number
  totalBytes: number | null
  error: string | null
  slug: string | null
  updatedAt: number
  /** Device that started the job (from `x-device-id`), for the operations list. */
  deviceId: string | null
  /** Room name being created — shown in the client's operations panel. */
  name: string
  /** `Date.now()` the job started — for newest-first ordering. */
  createdAt: number
  /** Set true by `cancelYoutubeJob`; kills the child and aborts room creation. */
  canceled: boolean
  /** The running yt-dlp process, so a cancel can terminate it. */
  child: ChildProcess | null
}

/** A YouTube job's public shape for the operations list (mirrors the others). */
export interface YoutubeOperationView {
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

const youtubeJobs = new Map<string, YoutubeJob>()

/** Current state of a YouTube room-creation job, or undefined once evicted. */
export function getYoutubeJob(jobId: string): YoutubeJob | undefined {
  return youtubeJobs.get(jobId)
}

/** Every YouTube job for [deviceId] (caller orders them). */
export function listYoutubeJobs(deviceId: string | null): YoutubeOperationView[] {
  if (!deviceId) return []
  const out: YoutubeOperationView[] = []
  for (const [id, job] of youtubeJobs) {
    if (job.deviceId !== deviceId) continue
    out.push({
      id,
      kind: OPERATION_KIND,
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
 * Flags a running YouTube job (owned by [deviceId]) for cancellation and kills
 * its yt-dlp process; the detached run then aborts and cleans up its temp
 * files. Returns true when a matching, still-running job was found.
 */
export function cancelYoutubeJob(jobId: string, deviceId: string | null): boolean {
  const job = youtubeJobs.get(jobId)
  if (!job || (deviceId && job.deviceId !== deviceId)) return false
  if (job.status !== 'downloading') return false
  job.canceled = true
  try {
    job.child?.kill()
  } catch {
    /* already exited */
  }
  return true
}

/**
 * True when [raw] is a well-formed http(s) URL on a YouTube host. Used by the
 * controller to route a pasted download link to this service, and as the only
 * gate on what yt-dlp is allowed to fetch.
 */
export function isYoutubeUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
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
  setTimeout(() => youtubeJobs.delete(jobId), JOB_TTL_MS).unref()
}

/** Parses a yt-dlp byte field; its `NA` placeholder becomes null. */
function parseBytes(value: string): number | null {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Updates the job's byte/percent fields from yt-dlp's machine-readable progress
 * lines (emitted by the `--progress-template` below as `YTPROG <down> <total>
 * <estimate>`). yt-dlp downloads the video then the audio as two phases, so the
 * byte count resets once between them — cosmetic, since the audio stream is a
 * small tail of the total.
 */
function parseProgress(job: YoutubeJob, chunk: string): void {
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = /YTPROG\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line)
    if (!m) continue
    const downloaded = parseBytes(m[1])
    const total = parseBytes(m[2]) ?? parseBytes(m[3])
    if (downloaded != null) job.bytesDownloaded = downloaded
    if (total != null) job.totalBytes = total
    job.percent =
      downloaded != null && total ? Math.min(99, Math.floor((downloaded / total) * 100)) : null
    job.updatedAt = Date.now()
  }
}

/**
 * Spawns yt-dlp for [url], writing into [outTemplate], and resolves on a clean
 * exit. Rejects with a human-readable message on a non-zero exit (the last line
 * of stderr), a missing binary, or a user cancel. Stores the child on the job
 * so a cancel can kill it.
 */
function runYtDlp(job: YoutubeJob, url: string, outTemplate: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpegBin = resolveFfmpegBin()
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-color',
      '-f',
      FORMAT,
      '--merge-output-format',
      'mp4',
      '--max-filesize',
      MAX_VIDEO_SIZE_ARG,
      '--newline',
      '--progress-template',
      'download:YTPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      ...(ffmpegBin ? ['--ffmpeg-location', ffmpegBin] : []),
      '-o',
      outTemplate,
      '--',
      url,
    ]

    const child = spawn(resolveYtDlpBin(), args, { windowsHide: true })
    job.child = child

    let stderrTail = ''
    child.stdout.on('data', (buf: Buffer) => parseProgress(job, buf.toString()))
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      parseProgress(job, text)
      // yt-dlp prints the real failure reason to stderr; keep only the tail.
      stderrTail = (stderrTail + text).slice(-2000)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      job.child = null
      reject(
        err.code === 'ENOENT'
          ? new Error('yt-dlp is not installed on the server.')
          : err
      )
    })

    child.on('close', (code) => {
      job.child = null
      if (job.canceled) {
        reject(new Error('operation_canceled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      // yt-dlp prints the real failure as an `ERROR:` line, but with --newline
      // the *last* stderr line is often a trailing progress/status fragment
      // (e.g. our `YTPROG …` template or a `[download] …` line). Prefer the last
      // real `ERROR:` line; fall back to the last non-progress line.
      const lines = stderrTail
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const errLine =
        [...lines].reverse().find((l) => /^ERROR:/i.test(l)) ??
        [...lines].reverse().find((l) => !/^YTPROG\b/.test(l))
      const message = errLine?.replace(/^ERROR:\s*/i, '').trim()
      reject(new Error(message || 'The YouTube video could not be downloaded.'))
    })
  })
}

/** The file yt-dlp produced for [jobId] (`.yt-<jobId>.<ext>`), or null. */
async function findProducedFile(jobId: string): Promise<string | null> {
  const dir = app.makePath('storage/videos')
  const prefix = `.yt-${jobId}.`
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  // Skip any leftover `.part` fragment; prefer an .mp4 if several remain.
  const finished = entries.filter((e) => e.startsWith(prefix) && !e.endsWith('.part'))
  if (finished.length === 0) return null
  const mp4 = finished.find((e) => e.toLowerCase().endsWith('.mp4'))
  return join(dir, mp4 ?? finished[0])
}

/** Deletes any temp artefacts yt-dlp left behind for [jobId]. */
async function cleanupTemp(jobId: string): Promise<void> {
  const dir = app.makePath('storage/videos')
  const prefix = `.yt-${jobId}.`
  try {
    const entries = await readdir(dir)
    await Promise.all(
      entries.filter((e) => e.startsWith(prefix)).map((e) => unlink(join(dir, e)).catch(() => {}))
    )
  } catch {
    /* nothing to clean */
  }
}

/**
 * Runs one YouTube download to completion: shell out to yt-dlp, then rename the
 * finished file to a slug-based name and create the room. Never throws — every
 * failure is recorded on the job, mirroring the other downloaders.
 */
async function runYoutubeDownload(
  jobId: string,
  url: string,
  name: string,
  password: string | null,
  reactions: string | null,
  category: string | null,
  imdbId: string | null
): Promise<void> {
  const job = youtubeJobs.get(jobId)
  if (!job) return

  const outTemplate = app.makePath('storage/videos', `.yt-${jobId}.%(ext)s`)
  // Where the finished video is renamed to. Recorded so a failure *after* the
  // rename (e.g. Room.create throwing on a slug-unique race or a DB hiccup) can
  // delete it — cleanupTemp only knows the `.yt-<jobId>.*` temp names, not the
  // final `<slug>.<ext>`, so without this the renamed file would orphan on disk.
  let finalPath: string | null = null

  try {
    await mkdir(app.makePath('storage/videos'), { recursive: true })

    await runYtDlp(job, url, outTemplate)
    if (job.canceled) throw new Error('operation_canceled')

    const produced = await findProducedFile(jobId)
    if (!produced) throw new Error('The downloaded video could not be found.')

    const ext = extname(produced).replace(/^\./, '').toLowerCase() || 'mp4'
    const slug = await uniqueSlug(name)
    // A cancel can land while the slug lookup awaits the DB — re-check so a
    // canceled job never creates a room (its temp file is cleaned in the catch).
    if (job.canceled) throw new Error('operation_canceled')

    const videoFilename = `${slug}.${ext}`
    finalPath = app.makePath('storage/videos', videoFilename)
    await rename(produced, finalPath)

    await Room.create({
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

    job.status = 'done'
    job.slug = slug
    job.percent = 100
    job.updatedAt = Date.now()
  } catch (err) {
    await cleanupTemp(jobId)
    // If we failed after renaming into place (e.g. Room.create threw), the file
    // no longer matches the temp prefix — delete it explicitly so no orphan is
    // left without a room row pointing at it.
    if (finalPath) await unlink(finalPath).catch(() => {})
    job.status = 'error'
    job.error = job.canceled
      ? 'operation_canceled'
      : err instanceof Error
        ? err.message
        : 'The YouTube video could not be downloaded.'
    job.updatedAt = Date.now()
  }

  scheduleEviction(jobId)
}

/**
 * Starts creating a room from a YouTube `url` and returns the id the client
 * polls for progress. Throws synchronously for a non-YouTube link so the caller
 * can answer the request immediately; every later failure surfaces on the job.
 */
export function startYoutubeDownload(opts: {
  name: string
  password: string | null
  url: string
  reactions?: string | null
  category?: string | null
  imdbId?: string | null
  deviceId?: string | null
}): string {
  if (!isYoutubeUrl(opts.url)) {
    throw new Error('That does not look like a YouTube link.')
  }

  const jobId = randomUUID()
  youtubeJobs.set(jobId, {
    status: 'downloading',
    percent: null,
    bytesDownloaded: 0,
    totalBytes: null,
    error: null,
    slug: null,
    updatedAt: Date.now(),
    deviceId: opts.deviceId ?? null,
    name: opts.name,
    createdAt: Date.now(),
    canceled: false,
    child: null,
  })

  /** Detached on purpose: progress is observed via `getYoutubeJob`. */
  void runYoutubeDownload(
    jobId,
    opts.url.trim(),
    opts.name,
    opts.password,
    opts.reactions ?? null,
    opts.category ?? null,
    opts.imdbId ?? null
  )

  return jobId
}
