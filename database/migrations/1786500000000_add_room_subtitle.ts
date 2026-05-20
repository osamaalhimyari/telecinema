import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds a subtitle file column to rooms.
 *
 * Only external (iframe) rooms use this today: since we cannot inject text
 * tracks into a cross-origin embed, the client renders its own subtitle
 * overlay on top of the iframe, driven by the room's virtual playhead. The
 * column stays nullable — rooms without subtitles are the common case.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('subtitle_filename').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('subtitle_filename')
    })
  }
}
