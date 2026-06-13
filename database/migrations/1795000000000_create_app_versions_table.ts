import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Creates the `app_versions` table — the catalogue of published Android builds
 * the Flutter client checks against for in-app updates.
 *
 * `version_code` (Android's integer build number) is the comparator the update
 * check uses, not the human-readable `version_name`. The columns marked below
 * are extracted from the uploaded APK by `#services/apk_inspector`; the admin
 * only supplies release notes and the two flags:
 *
 *   - `is_mandatory` — when true, clients on an older build are *forced* to
 *     update (a blocking gate) before they can use the app.
 *   - `status` — `'published'` (offered to clients) or `'blocked'`. Blocking is
 *     a kill-switch: a client sitting on a blocked `version_code` is forced to
 *     update immediately, and a blocked row is never served for download.
 */
export default class extends BaseSchema {
  protected tableName = 'app_versions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('version_name').notNullable() // e.g. "1.0.5" (from the APK)
      table.integer('version_code').notNullable() // Android versionCode (from the APK)
      table.string('package_name').notNullable() // applicationId (from the APK)
      table.string('file_name').notNullable() // stored filename under storage/apks
      table.integer('file_size').notNullable() // bytes, for the client's progress bar
      table.text('release_notes').nullable()
      table.boolean('is_mandatory').notNullable().defaultTo(false)
      table.string('status').notNullable().defaultTo('published') // 'published' | 'blocked'
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['version_code'])
      table.index(['status'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
