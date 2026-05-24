/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

const RoomsController = () => import('#controllers/rooms_controller')
const VideosController = () => import('#controllers/videos_controller')
const RoomsApiController = () => import('#controllers/api/rooms_api_controller')

/*
|--------------------------------------------------------------------------
| Watch-party routes
|--------------------------------------------------------------------------
*/

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
 * Video streaming endpoint with HTTP range-request support.
 */
router.get('/video/:filename', [VideosController, 'stream']).as('videos.stream')

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
