import { DateTime } from 'luxon'
import { BaseModel, column, computed } from '@adonisjs/lucid/orm'

/**
 * Room model represents a single watch-party room. Each room is bound to
 * exactly one video file and one thumbnail image. The `slug` is used both
 * for the public URL (/room/:slug) and as the Socket.io room identifier.
 */
export default class Room extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare slug: string

  @column()
  declare videoFilename: string

  @column()
  declare thumbnailFilename: string

  /**
   * Source of the room's video. `upload` and `download` both end up as a
   * file under `storage/videos/`; `external` is an embed URL rendered as an
   * iframe and never touches our own storage.
   */
  @column()
  declare roomType: 'upload' | 'download' | 'external'

  /**
   * Embed URL for `external` rooms — the third-party player iframe shown in
   * place of our own `<video>` element. Null for upload/download rooms.
   */
  @column()
  declare externalUrl: string | null

  /**
   * Scrypt hash of the room password, or null for open rooms. Never
   * serialized so it cannot leak into a rendered page or JSON response.
   */
  @column({ serializeAs: null })
  declare passwordHash: string | null

  /**
   * True for rooms created through the upload flow, false for seeded rooms.
   */
  @column()
  declare isUserCreated: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  /**
   * Whether the room is password protected. Safe to expose to templates —
   * it reveals only that a password exists, never the hash itself.
   */
  @computed()
  get hasPassword(): boolean {
    return this.passwordHash !== null && this.passwordHash !== ''
  }
}
