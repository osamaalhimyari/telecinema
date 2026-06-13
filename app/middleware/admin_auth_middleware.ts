import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Admin auth middleware — gates the version-management dashboard. Authenticates
 * against the `admin` guard only (never the website's `web` guard) and bounces
 * unauthenticated requests to the admin login. Mirrors `auth_middleware.ts`.
 */
export default class AdminAuthMiddleware {
  /**
   * The URL to redirect to, when authentication fails
   */
  redirectTo = '/admin/login'

  async handle(ctx: HttpContext, next: NextFn) {
    await ctx.auth.authenticateUsing(['admin'], { loginRoute: this.redirectTo })
    return next()
  }
}
