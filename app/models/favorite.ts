import { DateTime } from 'luxon'
import { BaseModel, column, computed } from '@adonisjs/lucid/orm'

/**
 * A favorited title (movie or series) saved from the Browse catalogue. There
 * are no user accounts yet, so the table is a single global list shared by
 * every client.
 *
 * `payload` is the raw catalogue JSON the client sent, stored verbatim as text
 * so the app can rebuild its poster tile without another catalogue lookup. It
 * is never serialized directly — the parsed object is exposed through the
 * {@link media} computed instead, so API responses carry real JSON, not a
 * string.
 */
export default class Favorite extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  /** IMDB id of the title (e.g. `tt1375666`); unique, so re-saving upserts. */
  @column()
  declare mediaId: string

  @column()
  declare mediaType: 'movie' | 'series'

  /** Raw catalogue JSON of the title, surfaced parsed via {@link media}. */
  @column({ serializeAs: null })
  declare payload: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  /** The stored catalogue JSON, parsed back into an object for API responses. */
  @computed()
  get media(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(this.payload)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* fall through to an empty object */
    }
    return {}
  }
}
