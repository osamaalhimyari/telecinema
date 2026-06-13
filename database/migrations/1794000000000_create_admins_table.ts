import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Creates the `admins` table — the credentials for the version-management
 * dashboard. Kept separate from `users` (the website's account-less catalogue
 * has no real users yet) so the admin panel has its own auth guard and an
 * accidental website signup can never reach the dashboard.
 *
 * The first row is seeded from `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`
 * by `database/seeders/admin_seeder.ts`.
 */
export default class extends BaseSchema {
  protected tableName = 'admins'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
