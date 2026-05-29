import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  /**
   * Default connection. Switchable via DB_CONNECTION (sqlite | mysql).
   * Defaults to sqlite for local dev; set DB_CONNECTION=mysql in production
   * (e.g. on MonsterASP, which provides a remotely-reachable MySQL server).
   */
  connection: env.get('DB_CONNECTION', 'sqlite'),

  /**
   * Pretty-print SQL debug output in development logs.
   */
  prettyPrintDebugQueries: true,

  connections: {
    /**
     * SQLite connection (better-sqlite3). The database is a single file at
     * tmp/db.sqlite3. Used for local dev / Render.
     */
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: app.tmpPath('db.sqlite3'),
      },
      useNullAsDefault: true,
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      /**
       * Emit SQL queries to the logger in development.
       */
      debug: app.inDev,
    },

    /**
     * MySQL connection (mysql2). Used on MonsterASP. No native binary, so it
     * avoids the better-sqlite3 ERR_DLOPEN_FAILED arch mismatch. Run migrations
     * locally against the remote DB — there is no CLI on the host.
     */
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST', '127.0.0.1'),
        port: env.get('DB_PORT', 3306),
        user: env.get('DB_USER', 'root'),
        password: env.get('DB_PASSWORD', ''),
        database: env.get('DB_DATABASE'),
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      debug: app.inDev,
    },
  },
})

export default dbConfig
