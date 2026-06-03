import vine from '@vinejs/vine'

/**
 * Validator for saving a favorite from the Browse catalogue. The client sends
 * the title's id and type plus `media` — the raw catalogue JSON of the poster
 * tile, which the controller stringifies into the `payload` column verbatim.
 *
 * `media` mirrors the Flutter `CatalogItem`; unknown keys are allowed so the
 * catalogue can grow fields without breaking saves.
 */
export const createFavoriteValidator = vine.create({
  mediaId: vine.string().trim().minLength(1).maxLength(32),
  mediaType: vine.enum(['movie', 'series']),
  media: vine
    .object({
      id: vine.string(),
      name: vine.string(),
      type: vine.string(),
      poster: vine.string().nullable().optional(),
      imdbRating: vine.string().nullable().optional(),
      releaseInfo: vine.string().nullable().optional(),
      genres: vine.array(vine.string()).optional(),
    })
    .allowUnknownProperties(),
})
