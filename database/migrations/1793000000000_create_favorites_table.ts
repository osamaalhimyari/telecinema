import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Creates the `favorites` table — a single, account-less global list of the
 * movies/series saved from the Browse catalogue in the Flutter client.
 *
 * There are no user accounts yet, so favorites are shared by everyone: the
 * client saves the raw Cinemeta catalogue JSON of a title and the server keeps
 * it verbatim in `payload`. `media_id` (the IMDB id) is unique so saving the
 * same title twice upserts instead of duplicating.
 */
export default class extends BaseSchema {
  protected tableName = 'favorites'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('media_id').notNullable().unique() // IMDB id, e.g. tt1375666
      table.string('media_type').notNullable() // 'movie' | 'series'
      table.text('payload').notNullable() // raw catalogue JSON of the title
      table.timestamp('created_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
