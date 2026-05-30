import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds the IMDB id column to rooms.
 *
 * When a room is created from the Browse catalogue, the title's IMDB id (e.g.
 * `tt1190634`) is stored here so the in-room "Download subtitle" feature can
 * query OpenSubtitles by IMDB id. Null for rooms created manually (pasted
 * magnet / link / upload), which fall back to a title search instead.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('imdb_id').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('imdb_id')
    })
  }
}
