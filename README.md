# Watch Party

A synchronized watch-party web app built on **AdonisJS v6 (TypeScript)**. Every
viewer inside a room watches the same video in lock-step — any play, pause, or
seek instantly applies to everyone else in that room. Volume is permanently
locked on.

## Stack

| Concern        | Choice                                                       |
| -------------- | ------------------------------------------------------------ |
| Framework      | AdonisJS v6 (MVC, TypeScript)                                |
| Real-time sync | Socket.io, attached to the AdonisJS HTTP server              |
| Video delivery | Custom `/video/:filename` route with HTTP range streaming    |
| Templating     | Edge.js                                                      |
| Database       | SQLite via Lucid ORM                                         |
| Styling        | Vanilla CSS (dark theme, teal accent)                        |

## Getting started

```bash
npm install
node ace migration:run   # creates the rooms table
node ace db:seed         # inserts the 4 sample rooms
npm run dev              # http://localhost:3333
```

## Add the videos

The four rooms expect these files in `storage/videos/`:

```
nature.mp4   space.mp4   ocean.mp4   city.mp4
```

Drop in any H.264/AAC `.mp4` files with those names — no server restart needed.
Until a file exists, that room shows a "Video file not found" overlay; sync,
controls, and viewer counts still work. See `storage/videos/README.md`.

## How sync works

`start/socket.ts` holds an in-memory `Map<slug, RoomState>` of master playback
state. `providers/socket_provider.ts` attaches Socket.io to the Node HTTP
server once it is listening.

- `join_room` → the client receives the current `sync` (state extrapolated
  forward if playing) and the room's viewer count is broadcast.
- `control` (`play` / `pause` / `seek`) → master state is updated and a `sync`
  is relayed to every **other** client in the room.
- `disconnect` → the viewer count drops; when it hits 0 the room resets to
  paused at 0:00.

The home page joins a `home` channel to receive live per-room viewer counts.

## Notes / deviations from spec

- **Thumbnails are SVG, not JPG.** No image tooling (ffmpeg/ImageMagick) was
  available in the build environment, so `public/thumbnails/<slug>.svg`
  placeholders were generated instead. They render identically inside the
  `<img>` tags. To use real JPGs, drop them in and update `videoFilename`'s
  sibling `thumbnailFilename` in `database/seeders/database_seeder.ts`.
- The scaffolded auth pages (login/signup) were left intact but are unused by
  the watch-party feature.
