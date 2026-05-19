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
