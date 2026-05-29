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
  roomType: vine.enum(['upload', 'download', 'torrent']),
  videoUrl: vine.string().trim().maxLength(2048).nullable().optional(),
  magnet: vine.string().trim().maxLength(8192).nullable().optional(),
  reactions: vine.string().nullable().optional(),
  category: vine.string().trim().maxLength(40).nullable().optional(),
})
