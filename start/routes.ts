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
const RoomsApiController = () => import('#controllers/api/rooms_api_controller')
const FavoritesApiController = () => import('#controllers/api/favorites_api_controller')
const TopcinemaApiController = () => import('#controllers/api/topcinema_api_controller')

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
 * disk (upload/download rooms), one that streams a torrent room's swarm.
 */
router.get('/video/:filename', [VideosController, 'stream']).as('videos.stream')
router.get('/stream/:slug', [VideosController, 'streamTorrent']).as('videos.streamTorrent')

/**
 * Subtitle endpoints — upload an .srt/.vtt for an external room, and serve
 * stored subtitle files to the client overlay.
 */
router.post('/room/:slug/subtitle', [RoomsController, 'uploadSubtitle']).as('rooms.subtitle')
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
    router.get('/rooms/:slug', [RoomsApiController, 'show']).as('api.rooms.show')
    router.post('/rooms/:slug/unlock', [RoomsApiController, 'unlock']).as('api.rooms.unlock')
    router.delete('/rooms/:slug', [RoomsApiController, 'destroy']).as('api.rooms.destroy')
    router
      .post('/rooms/:slug/subtitle', [RoomsApiController, 'uploadSubtitle'])
      .as('api.rooms.subtitle')

    // Account-less global favorites — saved movies/series from the catalogue.
    router.get('/favorites', [FavoritesApiController, 'index']).as('api.favorites.index')
    router.post('/favorites', [FavoritesApiController, 'store']).as('api.favorites.store')
    router
      .delete('/favorites/:mediaId', [FavoritesApiController, 'destroy'])
      .as('api.favorites.destroy')

    // Isolated "second way" — topcinema direct-download source resolution.
    router.get('/topcinema/series', [TopcinemaApiController, 'series']).as('api.topcinema.series')
    router.get('/topcinema/resolve', [TopcinemaApiController, 'resolve']).as('api.topcinema.resolve')
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
