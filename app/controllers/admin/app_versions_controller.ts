import AppVersion from '#models/app_version'
import { inspectApk } from '#services/apk_inspector'
import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { unlink } from 'node:fs/promises'
import type { HttpContext } from '@adonisjs/core/http'

/** Largest APK we accept. Generous — release builds with assets can be big. */
const MAX_APK_SIZE = '500mb'

/** Coerces an HTML checkbox / form value to a boolean (absent → false). */
function toBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === '1' || value === 1
}

/** Trims a textarea value to a non-empty string, or null when blank. */
function cleanNotes(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text.length ? text.slice(0, 5000) : null
}

/**
 * The version-management dashboard. Listing, uploading (with on-server APK
 * scanning), editing the release notes + Force flag, blocking/unblocking, and
 * deleting builds. All actions are behind the `adminAuth` middleware.
 */
export default class AppVersionsController {
  /** Dashboard home — every build, newest first. */
  async index({ view }: HttpContext) {
    const versions = await AppVersion.query().orderBy('version_code', 'desc')
    return view.render('admin/versions/index', { versions })
  }

  /** Upload form. */
  async create({ view }: HttpContext) {
    return view.render('admin/versions/create')
  }

  /**
   * Accept an uploaded APK, read its version metadata, and store it. The APK is
   * scanned at its temp path *before* being moved into place, so a bad upload
   * never leaves a file behind.
   *
   * The upload form posts via XHR so it can show a progress bar; for those
   * requests we answer with JSON ({ error } on failure, { redirect } on
   * success) instead of a redirect. A plain (no-JS) form submit still gets the
   * flash-and-redirect behaviour as a fallback.
   */
  async store({ request, response, session }: HttpContext) {
    const wantsJson = request.ajax()

    /** Report a validation failure as JSON (XHR) or a flashed redirect (no-JS). */
    const fail = (message: string) => {
      if (wantsJson) return response.status(422).json({ error: message })
      session.flash('error', message)
      return response.redirect().back()
    }

    const apk = request.file('apk', { extnames: ['apk'], size: MAX_APK_SIZE })
    if (!apk) return fail('Please choose an APK file to upload.')
    if (!apk.isValid) return fail(apk.errors[0]?.message ?? 'Invalid APK file.')
    if (!apk.tmpPath) return fail('Upload failed — please try again.')

    let info: Awaited<ReturnType<typeof inspectApk>>
    try {
      info = await inspectApk(apk.tmpPath)
    } catch {
      return fail('Could not read the APK. Is it a valid Android build?')
    }

    // Guard against publishing a build for the wrong app.
    const expectedPackage = env.get('APP_ANDROID_PACKAGE')
    if (expectedPackage && info.packageName !== expectedPackage) {
      return fail(
        `APK package "${info.packageName}" does not match the expected "${expectedPackage}".`
      )
    }

    // Reject only an exact duplicate (same name AND code). Different builds may
    // share a versionCode (e.g. you bump only the name 1.0.5→1.0.6 keeping +1) —
    // the update check ranks on the full version, so that's fine.
    const duplicate = await AppVersion.query()
      .where('version_code', info.versionCode)
      .where('version_name', info.versionName)
      .first()
    if (duplicate) {
      return fail(`${info.versionName} (build ${info.versionCode}) is already uploaded.`)
    }

    const fileName = `telecinema-${info.versionName.replace(/[^\w.-]/g, '_')}-${info.versionCode}.apk`
    await apk.move(app.makePath('storage/apks'), { name: fileName, overwrite: true })

    await AppVersion.create({
      versionName: info.versionName,
      versionCode: info.versionCode,
      packageName: info.packageName,
      fileName,
      fileSize: apk.size,
      releaseNotes: cleanNotes(request.input('release_notes')),
      isMandatory: toBool(request.input('is_mandatory')),
      status: 'published',
    })

    // Flash is read on the next page load — works for both the XHR client
    // (which then navigates to /admin) and the no-JS redirect below.
    session.flash('success', `Uploaded ${info.versionName} (build ${info.versionCode}).`)
    if (wantsJson) return response.json({ redirect: '/admin' })
    return response.redirect('/admin')
  }

  /** Edit form for release notes + the Force flag (the APK itself is immutable). */
  async edit({ params, view, response }: HttpContext) {
    const version = await AppVersion.find(params.id)
    if (!version) return response.redirect('/admin')
    return view.render('admin/versions/edit', { version })
  }

  /** Persist release-notes / Force-flag edits. */
  async update({ params, request, response, session }: HttpContext) {
    const version = await AppVersion.findOrFail(params.id)
    version.releaseNotes = cleanNotes(request.input('release_notes'))
    version.isMandatory = toBool(request.input('is_mandatory'))
    await version.save()
    session.flash('success', `Updated ${version.versionName}.`)
    return response.redirect('/admin')
  }

  /** Kill-switch — block a build so it is force-updated off and never served. */
  async block({ params, response, session }: HttpContext) {
    const version = await AppVersion.findOrFail(params.id)
    version.status = 'blocked'
    await version.save()
    session.flash('success', `Blocked ${version.versionName} (build ${version.versionCode}).`)
    return response.redirect('/admin')
  }

  /** Re-publish a previously blocked build. */
  async unblock({ params, response, session }: HttpContext) {
    const version = await AppVersion.findOrFail(params.id)
    version.status = 'published'
    await version.save()
    session.flash('success', `Published ${version.versionName} (build ${version.versionCode}).`)
    return response.redirect('/admin')
  }

  /** Delete a build row and its APK file. */
  async destroy({ params, response, session }: HttpContext) {
    const version = await AppVersion.findOrFail(params.id)
    await unlink(app.makePath('storage/apks', version.fileName)).catch(() => {})
    await version.delete()
    session.flash('success', `Deleted ${version.versionName} (build ${version.versionCode}).`)
    return response.redirect('/admin')
  }
}
