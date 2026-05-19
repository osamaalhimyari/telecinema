import vine from '@vinejs/vine'

/**
 * Validator for the "Create room" form. The uploaded video file itself is
 * validated separately in the controller via `request.file()`, since file
 * rules (size, extension) are expressed through the bodyparser API.
 *
 * `password` is optional — an empty field is converted to `null` by the
 * bodyparser and leaves the room open to everyone.
 */
export const createRoomValidator = vine.create({
  name: vine.string().minLength(2).maxLength(80),
  password: vine.string().minLength(4).maxLength(64).nullable().optional(),
})
