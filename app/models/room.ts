import { DateTime } from 'luxon'
import { BaseModel, column, computed } from '@adonisjs/lucid/orm'

/**
 * Room model represents a single watch-party room. Each room is bound to
 * exactly one video file and one thumbnail image. The `slug` is used both
 * for the public URL (/room/:slug) and as the Socket.io room identifier.
 */
export default class Room extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare slug: string

  @column()
  declare videoFilename: string

  @column()
  declare thumbnailFilename: string

  /**
   * Source of the room's video. Rooms are created as one of three types:
   * `upload` and `download` both end up as a file under `storage/videos/`,
   * and `torrent` streams a file out of a BitTorrent swarm (via WebTorrent)
   * served over `/stream/:slug`, downloading pieces on demand.
   *
   * `external` (an iframe embed URL) is a **legacy** type: existing rows still
   * render, but it can no longer be created — the create form offers only
   * upload, download and torrent.
   */
  @column()
  declare roomType: 'upload' | 'download' | 'external' | 'torrent'

  /**
   * Embed URL for legacy `external` rooms — the third-party player iframe
   * shown in place of our own `<video>` element. Always null for the
   * upload/download/torrent types that can be created today.
   */
  @column()
  declare externalUrl: string | null

  /**
   * Magnet URI for `torrent` rooms — the source swarm the server streams from.
   * Never serialized: clients stream through `/stream/:slug` and never need the
   * raw magnet. Null for every other room type.
   */
  @column({ serializeAs: null })
  declare magnet: string | null

  /**
   * Filename of an uploaded subtitle file (SRT/VTT) for external rooms.
   * Stored under `storage/subtitles/` and rendered as our own overlay on
   * top of the iframe, since cross-origin embeds cannot host a `<track>`.
   */
  @column()
  declare subtitleFilename: string | null

  /**
   * Scrypt hash of the room password, or null for open rooms. Never
   * serialized so it cannot leak into a rendered page or JSON response.
   */
  @column({ serializeAs: null })
  declare passwordHash: string | null

  /**
   * True for rooms created through the upload flow, false for seeded rooms.
   */
  @column()
  declare isUserCreated: boolean

  @column()
  declare viewCount: number

  @column()
  declare category: string | null

  @column()
  declare reactions: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  /**
   * Human-readable relative creation time, e.g. "2h ago", "3d ago".
   */
  @computed()
  get createdAgo(): string {
    const diff = -this.createdAt.diffNow('seconds').seconds
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`
    return `${Math.floor(diff / 31536000)}y ago`
  }

  /**
   * Whether the room is password protected. Safe to expose to templates —
   * it reveals only that a password exists, never the hash itself.
   */
  @computed()
  get viewCountLabel(): string {
    const n = this.viewCount
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M views`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k views`
    if (n === 1) return '1 view'
    return `${n} views`
  }

  @computed()
  get reactionsList(): string[] {
    if (!this.reactions) return ['👍', '❤️', '😂', '😮', '🎉', '🔥']
    try {
      const parsed = JSON.parse(this.reactions)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(0, 8)
    } catch { /* fall through */ }
    return ['👍', '❤️', '😂', '😮', '🎉', '🔥']
  }

  @computed()
  get hasPassword(): boolean {
    return this.passwordHash !== null && this.passwordHash !== ''
  }

  /**
   * Magnet URI, exposed to clients ONLY for torrent rooms. The app streams
   * torrents on-device (each client adds this magnet to its own embedded
   * engine) rather than through the server, so unlike the raw `magnet` column
   * (serializeAs: null) this computed value is sent in API responses. Null for
   * every non-torrent room.
   */
  @computed()
  get magnetUri(): string | null {
    return this.roomType === 'torrent' ? this.magnet : null
  }
}
