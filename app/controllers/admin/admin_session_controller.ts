import Admin from '#models/admin'
import { clearAttempts, recordFailure, retryAfter } from '#services/login_throttle'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Handles dashboard login/logout against the `admin` auth guard. Mirrors the
 * website's SessionController but is wired to the `admins` table, so the two
 * sign-in flows never cross.
 */
export default class AdminSessionController {
  /** Show the login page (or skip straight to the dashboard if already in). */
  async create({ view, auth, response }: HttpContext) {
    if (await auth.use('admin').check()) {
      return response.redirect('/admin')
    }
    return view.render('admin/login')
  }

  /** Verify credentials and open an admin session. */
  async store({ request, auth, response, session }: HttpContext) {
    // Brute-force guard: refuse early while this IP is locked out.
    const ip = request.ip()
    const wait = retryAfter(ip)
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60)
      session.flash('error', `Too many attempts. Try again in ${minutes} minute(s).`)
      return response.redirect().back()
    }

    const { email, password } = request.only(['email', 'password'])
    try {
      const admin = await Admin.verifyCredentials(email, password)
      await auth.use('admin').login(admin)
    } catch {
      recordFailure(ip)
      session.flash('error', 'Invalid email or password.')
      return response.redirect().back()
    }
    clearAttempts(ip)
    return response.redirect('/admin')
  }

  /** Destroy the admin session. */
  async destroy({ auth, response }: HttpContext) {
    await auth.use('admin').logout()
    return response.redirect('/admin/login')
  }
}
