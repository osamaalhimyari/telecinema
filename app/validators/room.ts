import vine from '@vinejs/vine'

/**
 * Validator for the "Create room" form. A room's video arrives one of two
 * ways — an uploaded file or a `videoUrl` the server downloads itself — and
 * exactly one is required; that "exactly one" rule is enforced in the
 * controller, since the uploaded file lives outside VineJS's reach.
 *
 * The uploaded file itself is validated separately in the controller via
 * `request.file()`, since file rules (size, extension) are expressed through
 * the bodyparser API.
 *
 * `password` is optional — an empty field is converted to `null` by the
 * bodyparser and leaves the room open to everyone. `videoUrl` is likewise
 * optional here; its shape (protocol, host) is checked when the download
 * starts.
 */
export const createRoomValidator = vine.create({
  name: vine.string().minLength(2).maxLength(80),
  password: vine.string().minLength(4).maxLength(64).nullable().optional(),
  videoUrl: vine.string().trim().maxLength(2048).nullable().optional(),
})
