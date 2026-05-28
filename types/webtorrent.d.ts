/**
 * Minimal type surface for the slice of `webtorrent` v3 this app uses.
 *
 * The package ships as ESM with no bundled types, and `@types/webtorrent`
 * targets an older API, so we declare only what `app/services/torrent_streamer.ts`
 * actually touches. `skipLibCheck` keeps this from being checked against the
 * real (untyped) JS implementation.
 */
declare module 'webtorrent' {
  import type { Readable } from 'node:stream'

  export interface TorrentFile {
    name: string
    path: string
    length: number
    downloaded: number
    select(priority?: number): void
    deselect(): void
    createReadStream(opts?: { start?: number; end?: number }): Readable
  }

  export interface Torrent {
    infoHash: string
    name: string
    length: number
    downloaded: number
    progress: number
    files: TorrentFile[]
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void
    on(event: 'ready' | 'metadata' | 'done', listener: () => void): this
    on(event: 'error', listener: (err: Error | string) => void): this
  }

  export interface AddOptions {
    path?: string
    [key: string]: unknown
  }

  export default class WebTorrent {
    constructor(opts?: Record<string, unknown>)
    add(torrentId: string, opts: AddOptions, cb: (torrent: Torrent) => void): Torrent
    add(torrentId: string, cb: (torrent: Torrent) => void): Torrent
    remove(
      torrentId: string | Torrent,
      opts: { destroyStore?: boolean },
      cb?: (err?: Error) => void
    ): void
    remove(torrentId: string | Torrent, cb?: (err?: Error) => void): void
    on(event: 'error', listener: (err: Error | string) => void): this
    destroy(cb?: (err?: Error) => void): void
  }
}
