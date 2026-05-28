import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds the magnet URI column to rooms.
 *
 * A `torrent` room streams a video straight out of a BitTorrent swarm: the
 * magnet is stored here, and the server adds it to a WebTorrent client and
 * serves the chosen file over `/stream/:slug` with HTTP range support — no
 * full download to disk is required before playback starts.
 *
 * `magnet` only holds a value when `room_type` is `torrent`.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('magnet').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('magnet')
    })
  }
}
