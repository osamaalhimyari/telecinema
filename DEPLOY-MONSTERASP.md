# Manual deploy to MonsterASP.NET

This app is **Node/AdonisJS + Socket.io + SQLite (better-sqlite3)**. MonsterASP
runs it as a Node process behind IIS via `httpPlatformHandler` (see `web.config`).

> ⚠️ The `.github/workflows/main.yml` in this repo is a **.NET template** and does
> NOT build this app. Ignore it for manual deploys (or have it rewritten for Node).

---

## 0. One-time: things to know
- **No CLI on the host** → you can't run migrations there. Seed the DB locally and upload the file.
- **`better-sqlite3` is a native binary** → it must match the host's CPU arch (x64 vs x86) or boot fails with `ERR_DLOPEN_FAILED`. Build on the SAME arch as the host (x64 today on most MonsterASP nodes).
- **Videos live in `storage/videos/`** and are NOT part of the build. Upload them separately and mind the disk quota (free tier ≈ small).

## 1. Build locally (Windows x64)
```powershell
# from project root
npm ci                 # full deps, incl. better-sqlite3
node ace build         # → build/  (compiled app + web.config + views + public assets)
```

## 2. Install production deps inside build/
```powershell
cd build
npm ci --omit=dev      # installs better-sqlite3 with the win32-x64 prebuilt
cd ..
```

## 3. Pre-create the SQLite database
```powershell
# from project root — --force is required because NODE_ENV=production
node ace migration:run --force
node ace db:seed                       # inserts the 4 sample rooms
# copy the seeded DB into the build so it ships to wwwroot/tmp/
New-Item -ItemType Directory -Force build\tmp | Out-Null
Copy-Item tmp\db.sqlite3 build\tmp\db.sqlite3 -Force
```

## 4. Create the production .env
```powershell
Copy-Item .env.production.example build\.env
# then edit build\.env:
#   APP_URL=https://<your-site>.runasp.net
#   keep the existing APP_KEY (changing it invalidates sessions)
```

## 5. Upload to wwwroot
Upload the **contents of `build/`** into `wwwroot` (so `web.config` lands at
`wwwroot/web.config`). FTP of `node_modules/` is thousands of tiny files and slow —
**zip `build/` and use MonsterASP File Manager → upload → extract** instead.

Then upload separately:
- `storage/videos/*.mp4`  →  `wwwroot/storage/videos/`
- confirm `wwwroot/tmp/db.sqlite3` and `wwwroot/.env` are present

## 6. First boot & logs
`web.config` has `stdoutLogEnabled="true"`, so Node startup output goes to
`wwwroot/logs/`. Hit the site, then read those logs if it 502s.

**Most likely failure — `ERR_DLOPEN_FAILED` (sqlite arch mismatch):**
- Easiest fix: in the MonsterASP control panel, set the app pool to **64-bit**.
- Or rebuild for x86 before uploading:
  ```powershell
  cd build
  $env:npm_config_arch="ia32"; npm rebuild better-sqlite3 --build-from-source
  ```
Once it boots cleanly, set `stdoutLogEnabled="false"` in `web.config` and re-upload it.

## 7. Verify WebSockets (the real test for this app)
Open a room, then in browser DevTools → Network → filter `socket.io`:
- A `101 Switching Protocols` request = **WebSockets work** → instant sync. ✅
- Stuck on repeated `transport=polling` requests = host has WebSockets disabled.
  Sync still works but is laggy. This is the known MonsterASP limitation that
  pushed this project to Render previously.

---

## Security note
`APP_KEY` is currently committed in `.env` and `.env.production.example`. It's a
secret. Consider rotating it and keeping the real value out of git.
