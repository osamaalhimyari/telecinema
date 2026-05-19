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
        name: '[arabseed].Widows.Bay.S01E04.720p',
        slug: 'nature',
        videoFilename: '[arabseed].Widows.Bay.S01E04.720p.mp4',
        thumbnailFilename: 'nature.svg',
      },
        ])
  }
}
