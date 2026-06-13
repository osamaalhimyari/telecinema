import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import AppVersion, { compareVersions } from '#models/app_version'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * The in-app update API consumed by the Flutter client. Stateless and under
 * `/api/*`, so it is exempt from CSRF (see `config/shield.ts`).
 */
export default class AppVersionsApiController {
  /**
   * GET /api/app/version?versionName=<x.y.z>&versionCode=<int>&platform=android
   *
   * Tells the client whether a newer build exists, and whether updating is
   * forced. "Newer" is decided on the FULL version (major.minor.patch, then
   * build number) — see `compareVersions` — so a higher versionName always wins,
   * even if an older build carries a larger versionCode. `forced` is true when
   * the newest published build is mandatory, or when the client's exact build
   * has been blocked (kill-switch).
   */
  async check({ request, response }: HttpContext) {
    const versionCode = Number(request.input('versionCode', request.input('version_code', 0))) || 0
    const versionName = String(request.input('versionName', request.input('version_name', '')) || '')

    const latest = await AppVersion.latestPublished()
    if (!latest) {
      return response.json({
        success: true,
        data: { updateAvailable: false, forced: false, latest: null },
      })
    }

    const updateAvailable =
      compareVersions(latest.versionName, latest.versionCode, versionName, versionCode) > 0

    let forced = false
    if (updateAvailable) {
      if (latest.isMandatory) forced = true
      if (versionCode > 0) {
        // Identify the client's exact build (name + code) to honour a block.
        const current = await AppVersion.query()
          .where('version_code', versionCode)
          .if(versionName, (q) => q.where('version_name', versionName))
          .first()
        if (current?.status === 'blocked') forced = true
      }
    }

    return response.json({
      success: true,
      data: {
        updateAvailable,
        forced,
        latest: {
          versionName: latest.versionName,
          versionCode: latest.versionCode,
          releaseNotes: latest.releaseNotes,
          fileSize: latest.fileSize,
          // Relative path — the client joins it onto whatever server origin it is
          // configured to use, so a local/override server still downloads locally.
          downloadPath: `/api/app/download/${latest.id}`,
          // Absolute URL (APP_URL) for any non-app consumer.
          downloadUrl: `${env.get('APP_URL')}/api/app/download/${latest.id}`,
        },
      },
    })
  }

  /**
   * GET /api/app/download/:id — streams a published build's APK with HTTP range
   * support (so the client download can resume), mirroring VideosController.
   * Blocked / missing builds 404.
   */
  async download({ params, request, response }: HttpContext) {
    const version = await AppVersion.find(params.id)
    if (!version || version.status !== 'published') {
      return response.status(404).json({ success: false, message: 'version_not_found' })
    }

    const filePath = app.makePath('storage/apks', version.fileName)
    let fileSize: number
    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) throw new Error('not a file')
      fileSize = stats.size
    } catch {
      return response.status(404).json({ success: false, message: 'file_missing' })
    }

    response.header('Content-Type', 'application/vnd.android.package-archive')
    response.header('Content-Disposition', `attachment; filename="${version.fileName}"`)
    response.header('Accept-Ranges', 'bytes')
    response.header('Cache-Control', 'public, max-age=3600')

    const rangeHeader = request.header('range')
    const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null

    if (!match) {
      response.status(200)
      response.header('Content-Length', String(fileSize))
      return response.stream(createReadStream(filePath))
    }

    let start = match[1] ? Number.parseInt(match[1], 10) : 0
    let end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1
    if (Number.isNaN(start)) start = 0
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1

    if (start > end || start < 0 || start >= fileSize) {
      response.status(416)
      response.header('Content-Range', `bytes */${fileSize}`)
      return response.send('Requested range not satisfiable')
    }

    response.status(206)
    response.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    response.header('Content-Length', String(end - start + 1))
    return response.stream(createReadStream(filePath, { start, end }))
  }
}
