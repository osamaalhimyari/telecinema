import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds the source-type column to rooms.
 *
 * `room_type` is one of:
 *   - `upload`   — a video file uploaded into `storage/videos/`
 *   - `download` — a video the server fetched from a link into `storage/videos/`
 *   - `external` — an embed URL (e.g. an iframe player) rendered as-is, with
 *                  no video file of our own
 *
 * `external_url` only holds a value when `room_type` is `external`.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('room_type').notNullable().defaultTo('upload')
      table.string('external_url', 2048).nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('room_type')
      table.dropColumn('external_url')
    })
  }
}
