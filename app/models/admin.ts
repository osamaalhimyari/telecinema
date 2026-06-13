import { AdminSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'

/**
 * Admin model — credentials for the version-management dashboard. Mirrors the
 * User model's auth setup (`withAuthFinder` gives `Admin.verifyCredentials`),
 * but is backed by its own `admins` table and its own `admin` auth guard
 * (see `config/auth.ts`), so it is fully isolated from website users.
 */
export default class Admin extends compose(AdminSchema, withAuthFinder(hash)) {}
