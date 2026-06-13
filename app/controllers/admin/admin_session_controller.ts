import Admin from '#models/admin'
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
    const { email, password } = request.only(['email', 'password'])
    try {
      const admin = await Admin.verifyCredentials(email, password)
      await auth.use('admin').login(admin)
    } catch {
      session.flash('error', 'Invalid email or password.')
      return response.redirect().back()
    }
    return response.redirect('/admin')
  }

  /** Destroy the admin session. */
  async destroy({ auth, response }: HttpContext) {
    await auth.use('admin').logout()
    return response.redirect('/admin/login')
  }
}
