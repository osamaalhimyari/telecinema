import vine from '@vinejs/vine'

/**
 * Validator for the "Create room" form. A room's video arrives one of three
 * ways, picked through `roomType`:
 *
 *   - `upload`   — an uploaded file (validated separately in the controller
 *                  via `request.file()`, since file rules live outside Vine)
 *   - `download` — a `videoUrl` the server downloads itself
 *   - `torrent`  — a `magnet` URI the server streams from a BitTorrent swarm
 *
 * The "matching field is present" rule is enforced in the controller — Vine
 * cannot see the uploaded file, so all source-related fields stay optional
 * here and the controller decides which one each `roomType` requires.
 *
 * `password` is optional — an empty field is converted to `null` by the
 * bodyparser and leaves the room open to everyone.
 */
export const createRoomValidator = vine.create({
  name: vine.string().minLength(2).maxLength(80),
  password: vine.string().minLength(4).maxLength(64).nullable().optional(),
  roomType: vine.enum(['upload', 'download', 'torrent', 'youtube']),
  // Up to 8192: usually a short link, but a YouTube `download` resolved
  // on-device puts a long signed googlevideo (video-only) URL here.
  videoUrl: vine.string().trim().maxLength(8192).nullable().optional(),
  // Companion audio stream URL for a YouTube `download` whose video+audio were
  // resolved on-device: when present, `videoUrl` is a video-only googlevideo URL
  // and the server downloads both and muxes them with ffmpeg. Long because
  // googlevideo URLs carry a large signed query string.
  audioUrl: vine.string().trim().maxLength(8192).nullable().optional(),
  magnet: vine.string().trim().maxLength(8192).nullable().optional(),
  reactions: vine.string().nullable().optional(),
  category: vine.string().trim().maxLength(40).nullable().optional(),
  imdbId: vine.string().trim().maxLength(20).nullable().optional(),
  // Max video height for a server-side YouTube download (e.g. 1080). Ignored by
  // the other source types; the downloader picks the best format <= this height.
  maxHeight: vine.number().min(144).max(4320).nullable().optional(),
  // Poster image URL of the movie/series this room plays, captured from the
  // catalogue. Stored as the room's thumbnail; when absent, a random built-in
  // placeholder is assigned instead.
  thumbnail: vine.string().trim().url().maxLength(2048).nullable().optional(),
})
