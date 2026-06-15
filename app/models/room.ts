import { DateTime } from 'luxon'
import { BaseModel, column, computed, beforeCreate } from '@adonisjs/lucid/orm'

/**
 * The built-in placeholder artwork under `public/thumbnails/`. A room with no
 * real poster gets one of these at random (see {@link Room.assignDefaultThumbnail}).
 */
const PLACEHOLDER_THUMBNAILS = ['city.svg', 'nature.svg', 'ocean.svg', 'space.svg']

/**
 * Room model represents a single watch-party room. Each room is bound to
 * exactly one video file and one thumbnail image. The `slug` is used both
 * for the public URL (/room/:slug) and as the Socket.io room identifier.
 */
export default class Room extends BaseModel {
  /**
   * When a room is created without an explicit thumbnail (the common case for
   * user-made rooms that carry no movie/series poster), give it one of the four
   * built-in SVG placeholders at random — so every room shows artwork instead of
   * a blank tile. A real poster URL passed at creation is left untouched.
   */
  @beforeCreate()
  static assignDefaultThumbnail(room: Room) {
    if (!room.thumbnailFilename) {
      const i = Math.floor(Math.random() * PLACEHOLDER_THUMBNAILS.length)
      room.thumbnailFilename = PLACEHOLDER_THUMBNAILS[i]
    }
  }

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
   * Source of the room's video. Rooms are created as one of these types:
   * `upload` and `download` both end up as a file under `storage/videos/`,
   * `torrent` streams a file out of a BitTorrent swarm (via WebTorrent) served
   * over `/stream/:slug`, and `youtube` streams a YouTube watch URL resolved to
   * a direct googlevideo stream and proxied over `/youtube/:slug`.
   *
   * `external` (an iframe embed URL) is a **legacy** type: existing rows still
   * render, but it can no longer be created — the create form offers only
   * upload, download, torrent and youtube.
   */
  @column()
  declare roomType: 'upload' | 'download' | 'external' | 'torrent' | 'youtube'

  /**
   * For legacy `external` rooms, the third-party player iframe URL; for
   * `youtube` rooms, the YouTube **watch** URL the `/youtube/:slug` proxy
   * resolves to a direct stream. Null for the file/torrent types.
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
   * For `torrent` rooms, the directory under `storage/torrents/` where the
   * swarm's pieces are cached on disk — WebTorrent names it after the torrent's
   * own `name`. Kept so the cached files can be deleted by path when the room
   * is removed, even when the live swarm is no longer in memory to tear down
   * (e.g. after a server restart). Never serialized; null for every other type.
   */
  @column({ serializeAs: null })
  declare torrentDir: string | null

  /**
   * Filename of an uploaded subtitle file (SRT/VTT) for a room. Stored under
   * `storage/subtitles/` and served via `/subtitles/:filename`. File rooms
   * load it as an external subtitle track; legacy external rooms render it as
   * an overlay on the iframe (cross-origin embeds cannot host a `<track>`).
   */
  @column()
  declare subtitleFilename: string | null

  /**
   * Shared subtitle display settings, synchronized across every client in the
   * room (like {@link subtitleFilename} itself). Updated over the socket via
   * `set_subtitle_settings` and broadcast as `subtitle_settings_changed`.
   *
   *  - `subtitleOffset` — seconds to shift cues (+later / -earlier), clamped
   *    to [-60, 60]. Reset to 0 whenever the subtitle (or source) changes.
   *  - `subtitleWeight` — font weight 100..900 (500 = default).
   *  - `subtitleSize`   — font size in px (16 = default).
   */
  @column()
  declare subtitleOffset: number

  @column()
  declare subtitleWeight: number

  @column()
  declare subtitleSize: number

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

  /**
   * IMDB id of the title this room plays (e.g. `tt1190634`), captured when the
   * room is created from the Browse catalogue. Powers the in-room "Download
   * subtitle" search against OpenSubtitles. Null for manually created rooms.
   */
  @column()
  declare imdbId: string | null

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
