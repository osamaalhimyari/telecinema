import Admin from '#models/admin'
import env from '#start/env'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

/**
 * Bootstraps the first dashboard admin from `ADMIN_BOOTSTRAP_EMAIL` /
 * `ADMIN_BOOTSTRAP_PASSWORD`. Idempotent — keyed on the email, so re-running it
 * resets that admin's password to whatever the env currently holds rather than
 * creating duplicates. Does nothing when either var is unset.
 *
 * Run with: `node ace db:seed --files=./database/seeders/admin_seeder.ts --force`
 */
export default class extends BaseSeeder {
  async run() {
    const email = env.get('ADMIN_BOOTSTRAP_EMAIL')
    const password = env.get('ADMIN_BOOTSTRAP_PASSWORD')
    if (!email || !password) return

    // updateOrCreate hashes `password` via the model's auth-finder hook.
    await Admin.updateOrCreate({ email }, { email, password })
  }
}
