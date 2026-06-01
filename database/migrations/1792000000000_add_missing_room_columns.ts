import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Catch-up migration for the room columns that were folded into
 * create_rooms_table after that migration had already run on some databases.
 *
 * The rooms schema lives in one place (create_rooms_table), so a FRESH database
 * already has these columns and this migration finds nothing to do. But a
 * database migrated under the old, incremental migrations never received them —
 * create_rooms_table won't re-run there — which is why inserting a torrent room
 * (it writes `torrent_dir`) was failing. Each column is added only if missing,
 * so this is safe to run on both fresh and existing databases.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  /** Columns that belong on `rooms` but may be absent on older databases. */
  private columns = ['subtitle_offset', 'subtitle_weight', 'subtitle_size', 'torrent_dir']

  async up() {
    // hasColumn is checked through `this.db.schema` (not the tracked `this.schema`
    // getter) so it runs once here instead of being replayed when the deferred
    // alterTable executes.
    const missing: string[] = []
    for (const col of this.columns) {
      if (!(await this.db.schema.hasColumn(this.tableName, col))) missing.push(col)
    }
    if (missing.length === 0) return

    this.schema.alterTable(this.tableName, (table) => {
      if (missing.includes('subtitle_offset')) table.float('subtitle_offset').notNullable().defaultTo(0)
      if (missing.includes('subtitle_weight')) table.integer('subtitle_weight').notNullable().defaultTo(500)
      if (missing.includes('subtitle_size')) table.integer('subtitle_size').notNullable().defaultTo(28)
      if (missing.includes('torrent_dir')) table.string('torrent_dir').nullable()
    })
  }

  async down() {
    const present: string[] = []
    for (const col of this.columns) {
      if (await this.db.schema.hasColumn(this.tableName, col)) present.push(col)
    }
    if (present.length === 0) return

    this.schema.alterTable(this.tableName, (table) => {
      for (const col of present) table.dropColumn(col)
    })
  }
}
