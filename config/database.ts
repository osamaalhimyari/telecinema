import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  /**
   * Default connection used for all queries.
   */
  connection: 'mysql',

  /**
   * Pretty-print SQL debug output in development logs.
   */
  prettyPrintDebugQueries: true,

  connections: {
    /**
     * MySQL / MariaDB connection. Pure-JS driver (mysql2) — no native binary,
     * which is why it runs on shared Windows hosting (MonsterASP) where the
     * native better-sqlite3 addon failed to load.
     */
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      /**
       * Emit SQL queries to the logger in development.
       */
      debug: app.inDev,
    },
  },
})

export default dbConfig
