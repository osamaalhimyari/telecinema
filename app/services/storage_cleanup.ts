/*
|--------------------------------------------------------------------------
| Storage cleanup — sweep orphaned download temp files
|--------------------------------------------------------------------------
|
| The three downloaders write a partial file into `storage/videos/` while a
| transfer runs, then rename it to the final `<slug>.<ext>` on success or unlink
| it on failure/cancel:
|
|   - video_downloader.ts  → `.download-<jobId>.part`
|   - torrent_streamer.ts  → `.magnet-<jobId>.part`
|   - youtube_downloader.ts→ `.yt-<jobId>.<ext>` (and yt-dlp `.part` fragments)
|
| That cleanup lives inside the in-memory job, so a server stop/crash mid-
| transfer (or a Windows file-lock that makes the unlink fail silently) strands
| the temp file forever — nothing else ever removes it. This boot-time sweep
| reclaims that space: when the server (re)starts no transfer is running, so
| every temp file present is by definition an orphan.
|
*/

import { readdir, stat, unlink } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'

/** Filename prefixes the downloaders use for their in-progress temp files. */
const TEMP_PREFIXES = ['.download-', '.magnet-', '.yt-']

/**
 * Small grace window: skip files touched in the last couple of minutes, so a
 * process-manager restart that briefly overlaps a still-writing previous process
 * never deletes a live download. A genuine orphan is always older than this by
 * the next boot, and is swept then.
 */
const MIN_AGE_MS = 2 * 60 * 1000

/**
 * Deletes orphaned partial-download temp files from `storage/videos/`. Returns
 * the number removed. Never throws — a single locked/already-gone file is
 * skipped rather than aborting the sweep.
 */
export async function sweepOrphanTempFiles(): Promise<number> {
  const dir = app.makePath('storage/videos')

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0 // directory not created yet — nothing to sweep
  }

  const now = Date.now()
  let removed = 0

  for (const name of entries) {
    if (!TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const full = app.makePath('storage/videos', name)
    try {
      const info = await stat(full)
      if (!info.isFile() || now - info.mtimeMs < MIN_AGE_MS) continue
      await unlink(full)
      removed++
    } catch {
      /* already gone, locked, or vanished mid-sweep — leave it for next boot */
    }
  }

  return removed
}
