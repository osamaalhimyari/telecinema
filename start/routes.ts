/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { readFile } from 'node:fs/promises'
import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'
import app from '@adonisjs/core/services/app'

const RoomsController = () => import('#controllers/rooms_controller')
const VideosController = () => import('#controllers/videos_controller')
const LiveTvController = () => import('#controllers/live_tv_controller')
const RoomsApiController = () => import('#controllers/api/rooms_api_controller')
const FavoritesApiController = () => import('#controllers/api/favorites_api_controller')
const TopcinemaApiController = () => import('#controllers/api/topcinema_api_controller')
const AppVersionsApiController = () => import('#controllers/api/app_versions_api_controller')
const AdminSessionController = () => import('#controllers/admin/admin_session_controller')
const AdminVersionsController = () => import('#controllers/admin/app_versions_controller')

/*
|--------------------------------------------------------------------------
| Watch-party routes
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| Mobile deep-link association files
|--------------------------------------------------------------------------
|
| Served so that a shared room link (https://<host>/room/:slug) opens the
| TeleCinema app instead of this website when the app is installed:
|   * Android App Links   → /.well-known/assetlinks.json
|   * iOS Universal Links → /.well-known/apple-app-site-association
|
| Both must be returned as application/json over HTTPS with no redirect. The
| static file middleware ignores dotfiles, so these explicit routes own the
| paths. The JSON lives under public/.well-known/ so the signing fingerprint
| (Android) and Apple Team ID can be edited without touching code.
*/
router.get('/.well-known/assetlinks.json', async ({ response }) => {
  const raw = await readFile(app.makePath('public/.well-known/assetlinks.json'), 'utf-8')
  // Parse + return the object so AdonisJS emits application/json itself.
  return response.json(JSON.parse(raw))
})
router.get('/.well-known/apple-app-site-association', async ({ response }) => {
  const raw = await readFile(app.makePath('public/.well-known/apple-app-site-association'), 'utf-8')
  return response.json(JSON.parse(raw))
})

/**
 * Home — grid of every available room.
 */
router.get('/', [RoomsController, 'index']).as('home')

/**
 * Create room — the form for uploading a video and (optionally) a password.
 */
router.get('/create', [RoomsController, 'create']).as('rooms.create')
router.post('/rooms', [RoomsController, 'store']).as('rooms.store')

/**
 * Progress poll for a room being created from a pasted video link.
 */
router
  .get('/rooms/download/:jobId', [RoomsController, 'downloadProgress'])
  .as('rooms.downloadProgress')

/**
 * Room — the synchronized video player for a single room.
 */
router.get('/room/:slug', [RoomsController, 'show']).as('rooms.show')

/**
 * Unlock a password-protected room, and delete a room with its video.
 */
router.post('/room/:slug/unlock', [RoomsController, 'unlock']).as('rooms.unlock')
router.post('/room/:slug/delete', [RoomsController, 'destroy']).as('rooms.destroy')

/**
 * Video streaming endpoints with HTTP range-request support — one for files on
 * disk (upload/download rooms), one that streams a torrent room's swarm, and
 * one that proxies a youtube room's resolved googlevideo stream.
 */
router.get('/video/:filename', [VideosController, 'stream']).as('videos.stream')
router.get('/stream/:slug', [VideosController, 'streamTorrent']).as('videos.streamTorrent')
router.get('/youtube/:slug', [VideosController, 'streamYoutube']).as('videos.streamYoutube')
// Live-TV HLS relay: fetches the (ISP-blocked, header-gated) channel stream
// server-side and rewrites it through this server. `/p` proxies sub-resources.
router.get('/livetv/:slug', [LiveTvController, 'index']).as('livetv.index')
router.get('/livetv/:slug/p', [LiveTvController, 'part']).as('livetv.part')

/**
 * Subtitle endpoints — upload an .srt/.vtt for an external room, and serve
 * stored subtitle files to the client overlay.
 */
router.post('/room/:slug/subtitle', [RoomsController, 'uploadSubtitle']).as('rooms.subtitle')
router.get('/room/:slug/subtitles/search', [RoomsController, 'searchSubtitles']).as('rooms.subtitles.search')
router
  .post('/room/:slug/subtitle/opensubtitles', [RoomsController, 'attachSubtitle'])
  .as('rooms.subtitle.attach')
router.put('/room/:slug', [RoomsController, 'update']).as('rooms.update')
router.get('/subtitles/:filename', [RoomsController, 'streamSubtitle']).as('subtitles.stream')

/*
|--------------------------------------------------------------------------
| JSON API — consumed by the Flutter watch-party client
|--------------------------------------------------------------------------
|
| A thin, stateless mirror of the web room catalogue. The realtime watch
| experience (sync, chat, presence, reactions, voice) runs over the same
| Socket.io protocol as the web client; these routes only own the room
| catalogue and lifecycle over HTTP. All are exempt from CSRF in
| `config/shield.ts` (`/api/*`).
*/
router
  .group(() => {
    router.get('/rooms', [RoomsApiController, 'index']).as('api.rooms.index')
    router.post('/rooms', [RoomsApiController, 'store']).as('api.rooms.store')
    router
      .get('/rooms/download/:jobId', [RoomsApiController, 'downloadProgress'])
      .as('api.rooms.downloadProgress')

    // Device-scoped server transfers — list this device's in-flight operations
    // and cancel one. Used by the app's operations panel.
    router.get('/operations', [RoomsApiController, 'operations']).as('api.operations.index')
    router
      .post('/rooms/download/:jobId/cancel', [RoomsApiController, 'cancelOperation'])
      .as('api.rooms.cancelDownload')
    router.get('/rooms/:slug', [RoomsApiController, 'show']).as('api.rooms.show')
    router.post('/rooms/:slug/unlock', [RoomsApiController, 'unlock']).as('api.rooms.unlock')
    // Live-TV token refresh: a client pushes a freshly re-resolved stream URL
    // so an expired `tv` room keeps playing for everyone.
    router.post('/rooms/:slug/stream', [RoomsApiController, 'updateStream']).as('api.rooms.stream')
    // Diagnostic: can this server reach the live-TV provider + stream hosts?
    // (Decides whether a server-side HLS relay is viable.) Temporary.
    router.get('/livetv/probe', [RoomsApiController, 'probeLiveTv']).as('api.livetv.probe')
    router.delete('/rooms/:slug', [RoomsApiController, 'destroy']).as('api.rooms.destroy')
    router
      .post('/rooms/:slug/subtitle', [RoomsApiController, 'uploadSubtitle'])
      .as('api.rooms.subtitle')
    router.post('/rooms/:slug/voice', [RoomsApiController, 'uploadVoice']).as('api.rooms.voice')

    // Account-less global favorites — saved movies/series from the catalogue.
    router.get('/favorites', [FavoritesApiController, 'index']).as('api.favorites.index')
    router.post('/favorites', [FavoritesApiController, 'store']).as('api.favorites.store')
    router
      .delete('/favorites/:mediaId', [FavoritesApiController, 'destroy'])
      .as('api.favorites.destroy')

    // Isolated "second way" — topcinema direct-download source resolution.
    router.get('/topcinema/series', [TopcinemaApiController, 'series']).as('api.topcinema.series')
    router.get('/topcinema/resolve', [TopcinemaApiController, 'resolve']).as('api.topcinema.resolve')

    // In-app updates — the client asks if a newer build exists, then downloads
    // the APK (range-supported) from these two routes.
    router.get('/app/version', [AppVersionsApiController, 'check']).as('api.app.version')
    router.get('/app/download/:id', [AppVersionsApiController, 'download']).as('api.app.download')
  })
  .prefix('/api')

/*
|--------------------------------------------------------------------------
| Authentication routes (scaffolded — left intact)
|--------------------------------------------------------------------------
*/

router
  .group(() => {
    router.get('signup', [controllers.NewAccount, 'create'])
    router.post('signup', [controllers.NewAccount, 'store'])

    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store'])
  })
  .use(middleware.guest())

router
  .group(() => {
    router.post('logout', [controllers.Session, 'destroy'])
  })
  .use(middleware.auth())

/*
|--------------------------------------------------------------------------
| Admin dashboard — in-app version management
|--------------------------------------------------------------------------
|
| A self-contained panel (own `admin` auth guard, own login) for publishing the
| Android builds the Flutter client updates to. Login is public; everything else
| sits behind the `adminAuth` middleware.
*/
router.get('/admin/login', [AdminSessionController, 'create']).as('admin.login')
router.post('/admin/login', [AdminSessionController, 'store']).as('admin.login.store')

router
  .group(() => {
    router.post('/admin/logout', [AdminSessionController, 'destroy']).as('admin.logout')
    router.get('/admin', [AdminVersionsController, 'index']).as('admin.versions.index')
    router.get('/admin/versions/create', [AdminVersionsController, 'create']).as('admin.versions.create')
    router.post('/admin/versions', [AdminVersionsController, 'store']).as('admin.versions.store')
    router.get('/admin/versions/:id/edit', [AdminVersionsController, 'edit']).as('admin.versions.edit')
    router.post('/admin/versions/:id', [AdminVersionsController, 'update']).as('admin.versions.update')
    router.post('/admin/versions/:id/block', [AdminVersionsController, 'block']).as('admin.versions.block')
    router.post('/admin/versions/:id/unblock', [AdminVersionsController, 'unblock']).as('admin.versions.unblock')
    router.post('/admin/versions/:id/delete', [AdminVersionsController, 'destroy']).as('admin.versions.destroy')
  })
  .use(middleware.adminAuth())
