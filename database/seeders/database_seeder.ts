import Room from '#models/room'
import { BaseSeeder } from '@adonisjs/lucid/seeders'

/**
 * Seeds the four sample watch-party rooms. Uses `updateOrCreateMany` keyed on
 * the slug so the seeder is idempotent and can be re-run safely.
 */
export default class extends BaseSeeder {
  async run() {
    await Room.updateOrCreateMany('slug', [
      {
        name: 'Nature',
        slug: 'nature',
        videoFilename: 'nature.mp4',
        thumbnailFilename: 'nature.svg',
        roomType: 'upload',
        isUserCreated: false,
        reactions: '["👍","❤️","😂","😮","🎉","🔥"]',
      },
      {
        name: 'Space',
        slug: 'space',
        videoFilename: 'space.mp4',
        thumbnailFilename: 'space.svg',
        roomType: 'upload',
        isUserCreated: false,
        reactions: '["👍","❤️","😂","😮","🎉","🔥"]',
      },
      {
        name: 'Ocean',
        slug: 'ocean',
        videoFilename: 'ocean.mp4',
        thumbnailFilename: 'ocean.svg',
        roomType: 'upload',
        isUserCreated: false,
        reactions: '["👍","❤️","😂","😮","🎉","🔥"]',
      },
      {
        name: 'City',
        slug: 'city',
        videoFilename: 'city.mp4',
        thumbnailFilename: 'city.svg',
        roomType: 'upload',
        isUserCreated: false,
        reactions: '["👍","❤️","😂","😮","🎉","🔥"]',
      },
    ])
  }
}
