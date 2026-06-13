/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  // Node
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  // App
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  // Session
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'database'] as const),

  // Database — DB_CONNECTION switches sqlite (local/Render) vs mysql (MonsterASP)
  DB_CONNECTION: Env.schema.enum.optional(['sqlite', 'mysql'] as const),
  DB_HOST: Env.schema.string.optional(),
  DB_PORT: Env.schema.number.optional(),
  DB_USER: Env.schema.string.optional(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string.optional(),

  // Admin dashboard — first admin seeded by `node ace db:seed` when both are set.
  ADMIN_BOOTSTRAP_EMAIL: Env.schema.string.optional(),
  ADMIN_BOOTSTRAP_PASSWORD: Env.schema.string.optional(),

  // In-app updates — expected Android applicationId; uploaded APKs must match it
  // so a wrong-app build can't be published. Optional: skips the check if unset.
  APP_ANDROID_PACKAGE: Env.schema.string.optional(),
})
