import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds optional password protection to rooms.
 *
 * `password_hash` is null for open rooms and holds a scrypt hash for
 * password-protected rooms. `is_user_created` distinguishes rooms uploaded
 * through the "Create room" flow from the seeded sample rooms.
 */
export default class extends BaseSchema {
  protected tableName = 'rooms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('password_hash').nullable()
      table.boolean('is_user_created').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('password_hash')
      table.dropColumn('is_user_created')
    })
  }
}
