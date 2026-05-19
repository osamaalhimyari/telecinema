# storage/videos/

Place the room video files here. The seeder expects these four filenames:

| Room               | File          |
| ------------------ | ------------- |
| Nature Documentary | `nature.mp4`  |
| Space Exploration  | `space.mp4`   |
| Ocean Depths       | `ocean.mp4`   |
| City Time-lapse    | `city.mp4`    |

Any `.mp4` (H.264 / AAC) file works. They are streamed to the browser by
`GET /video/:filename` with full HTTP range-request support, so seeking works
without re-downloading the file.

Until a file exists, its room page shows a "Video file not found" overlay —
everything else (sync, controls, viewer counts) still works the moment a real
`.mp4` is dropped in. No server restart is required.

To use different filenames, update `database/seeders/database_seeder.ts`
(`videoFilename`) and re-run `node ace db:seed`.
