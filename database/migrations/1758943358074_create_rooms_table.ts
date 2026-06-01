import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Creates the `rooms` table — the full schema in a single migration.
 *
 * A room is one watch-party: a single video source (an uploaded/downloaded
 * file, a torrent swarm, or a legacy external embed), an optional password,
 * a shared subtitle with display settings, and some catalogue metadata. The
 * `slug` is both the public URL (/room/:slug) and the Socket.io room id.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('name').notNullable()
      table.string('slug').notNullable().unique()

      // --- video source -------------------------------------------------
      // room_type: `upload` | `download` (both files under storage/videos/),
      // `torrent` (streamed from a swarm), or `external` (legacy iframe embed).
      table.string('room_type').notNullable().defaultTo('upload')
      table.string('video_filename').notNullable()
      table.string('thumbnail_filename').notNullable()
      table.string('external_url', 2048).nullable() // external rooms only
      table.text('magnet').nullable() // torrent rooms only
      table.string('torrent_dir').nullable() // torrent on-disk cache dir (storage/torrents/<name>)

      // --- subtitles + shared display settings --------------------------
      table.string('subtitle_filename').nullable()
      table.float('subtitle_offset').notNullable().defaultTo(0) // seconds [-60, 60]
      table.integer('subtitle_weight').notNullable().defaultTo(500) // font weight 100..900
      table.integer('subtitle_size').notNullable().defaultTo(28) // px

      // --- access -------------------------------------------------------
      table.string('password_hash').nullable() // scrypt hash; null = open room
      table.boolean('is_user_created').notNullable().defaultTo(false)

      // --- catalogue / metadata -----------------------------------------
      table.integer('view_count').notNullable().defaultTo(0)
      table.string('category').nullable()
      table.text('reactions').nullable() // JSON array of emoji
      table.string('imdb_id').nullable() // e.g. tt1190634 — for OpenSubtitles lookup

      table.timestamp('created_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
