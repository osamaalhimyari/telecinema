/*
|--------------------------------------------------------------------------
| YouTube stream resolver — for the `youtube` room type
|--------------------------------------------------------------------------
|
| A `youtube` room stores the watch URL and is played by streaming, NOT by
| downloading the whole file (that is the separate `download`/YouTube flow in
| youtube_downloader.ts). This service resolves the watch URL to a direct
| googlevideo stream URL with `yt-dlp -g`, picking a pre-muxed video+audio
| format (<= 720p) so the result is a single URL the app's own player can play
| with full sync/seek — no ffmpeg muxing.
|
| The resolved URL is short-lived and locked to THIS server's IP, so the room
| is never handed the googlevideo URL directly — the `/youtube/:slug` proxy in
| VideosController streams the bytes through, calling resolve() (and re-resolve
| on expiry). Results are cached per slug until shortly before their `expire`.
|
| Isolated by design: self-contained yt-dlp resolution + URL cache, loaded only
| when a youtube room is streamed. Binaries resolve from `YT_DLP_PATH` (env) or
| the bundled `youtube-dl-exec`, then `yt-dlp` on PATH — mirroring
| youtube_downloader.ts.
|
*/

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Hostnames a pasted link must end with to be treated as YouTube. */
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']

/** True when [raw] is a well-formed http(s) URL on a YouTube host. */
export function isYoutubeUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * Pre-muxed (single-file) video+audio, capped at 720p — YouTube only pre-muxes
 * up to 720p, and a muxed stream needs no ffmpeg. Falls back to itag 18 (360p
 * mp4) and finally any progressive stream.
 */
const FORMAT =
  'b[height<=?720][ext=mp4][acodec!=none][vcodec!=none]/b[height<=?720][acodec!=none][vcodec!=none]/18/b'

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

/** Reads the googlevideo `expire` (unix seconds) to know when to re-resolve. */
function parseExpiry(url: string): number | null {
  try {
    const u = new URL(url)
    const e = u.searchParams.get('expire')
    if (e && /^\d+$/.test(e)) return Number(e) * 1000
  } catch {
    /* fall through */
  }
  const m = /[/&?]expire[/=](\d+)/.exec(url)
  return m ? Number(m[1]) * 1000 : null
}

/** Runs `yt-dlp -g` and returns the first direct stream URL it prints. */
function ytDlpGetUrl(watchUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveYtDlpBin(),
      ['-g', '-f', FORMAT, '--no-playlist', '--no-warnings', watchUrl],
      { env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' } }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(err.trim() || `yt-dlp exited with code ${code}`))
      }
      // `-g` prints one URL per selected stream; a muxed selector yields one.
      const url = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^https?:\/\//.test(l))
      if (!url) return reject(new Error('yt-dlp returned no stream URL'))
      resolve(url)
    })
  })
}

interface Resolved {
  url: string
  expiresAt: number
}

const cache = new Map<string, Resolved>()
/** De-dupes concurrent resolves for the same slug into one yt-dlp run. */
const inflight = new Map<string, Promise<string>>()

/**
 * Resolves [watchUrl] to a direct stream URL for [slug], caching it until just
 * before it expires. Pass `force` to bypass the cache (used by the proxy when an
 * upstream request is rejected, i.e. the URL expired or the IP rotated).
 */
export async function resolveYoutubeStream(
  slug: string,
  watchUrl: string,
  force = false
): Promise<string> {
  const cached = cache.get(slug)
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.url

  const pending = inflight.get(slug)
  if (pending && !force) return pending

  const run = ytDlpGetUrl(watchUrl)
    .then((url) => {
      cache.set(slug, {
        url,
        // Default to 3h if no `expire` is present in the URL.
        expiresAt: parseExpiry(url) ?? Date.now() + 3 * 60 * 60 * 1000,
      })
      return url
    })
    .finally(() => inflight.delete(slug))

  inflight.set(slug, run)
  return run
}

/** Forgets a room's cached stream URL — called when the room is deleted. */
export function dropYoutubeStream(slug: string): void {
  cache.delete(slug)
}
