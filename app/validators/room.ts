import vine from '@vinejs/vine'

/**
 * Validator for the "Create room" form. A room's video arrives one of three
 * ways, picked through `roomType`:
 *
 *   - `upload`   — an uploaded file (validated separately in the controller
 *                  via `request.file()`, since file rules live outside Vine)
 *   - `download` — a `videoUrl` the server downloads itself
 *   - `external` — an `externalUrl` rendered as an embed, with no video of
 *                  our own
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
  roomType: vine.enum(['upload', 'download', 'external']),
  videoUrl: vine.string().trim().maxLength(2048).nullable().optional(),
  externalUrl: vine.string().trim().url().maxLength(2048).nullable().optional(),
})
