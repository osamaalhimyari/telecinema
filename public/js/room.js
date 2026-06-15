/* ==========================================================================
   Watch Party — room client
   --------------------------------------------------------------------------
   Owns the synchronized player: it relays local control actions to the
   server and applies remote "sync" events to the <video> element, while
   keeping the custom controls bar in step with playback.
   ========================================================================== */

;(function () {
  'use strict'

  var socket = io()
  var slug = window.ROOM_SLUG
  /**
   * `external` rooms render an iframe instead of our own `<video>`: there is
   * no element to control, no syncing to do. The voice + viewer-count code
   * paths still run; the video-specific blocks are gated on this flag.
   */
  var isExternal = window.ROOM_TYPE === 'external'

  var video = document.getElementById('video')
  var playPause = document.getElementById('playPause')
  var back10 = document.getElementById('back10')
  var fwd10 = document.getElementById('fwd10')
  var seek = document.getElementById('seek')
  var curTime = document.getElementById('curTime')
  var durTime = document.getElementById('durTime')
  var viewerCount = document.getElementById('viewerCount')
  var viewerCountFs = document.getElementById('viewerCountFs')
  var playGate = document.getElementById('playGate')
  var videoError = document.getElementById('videoError')
  var fullscreenBtn = document.getElementById('fullscreen')
  var micBtn = document.getElementById('micBtn')
  var voiceIndicator = document.getElementById('voiceIndicator')
  var voiceSpeakerName = document.getElementById('voiceSpeakerName')
  var player = document.getElementById('player')
  var controls = document.getElementById('controls')
  var topControls = document.getElementById('topControls')
  var deleteBtn = document.getElementById('deleteBtn')
  var deleteModal = document.getElementById('deleteModal')
  var cancelDelete = document.getElementById('cancelDelete')

  /** True while this client is holding the push-to-talk button. */
  var isTalking = false

  /**
   * True while we are applying a server "sync". It guards every video
   * mutation so the resulting UI events never echo a control back out.
   */
  var isSyncing = false

  /** The most recent sync payload — replayed when the autoplay gate clears. */
  var lastSync = null

  /* ------------------------------------------------------------------------
     Hard-disable native controls and lock the volume to 1.0
     ------------------------------------------------------------------------ */

  if (video) {
    video.controls = false
    video.volume = 1.0
    video.muted = false

    video.addEventListener('volumechange', function () {
      if (video.volume !== 1.0 || video.muted) {
        video.volume = 1.0
        video.muted = false
      }
    })
  }

  /* ------------------------------------------------------------------------
     Helpers
     ------------------------------------------------------------------------ */

  /**
   * Formats a duration in seconds as `m:ss` (under an hour) or
   * `h:mm:ss` (an hour or more). Padding follows the YouTube/VLC
   * convention: minutes stay single-digit until hours appear, then jump
   * to two digits so the columns line up.
   */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0
    var h = Math.floor(seconds / 3600)
    var m = Math.floor((seconds % 3600) / 60)
    var s = Math.floor(seconds % 60)
    var ss = (s < 10 ? '0' : '') + s
    if (h > 0) {
      var mm = (m < 10 ? '0' : '') + m
      return h + ':' + mm + ':' + ss
    }
    return m + ':' + ss
  }

  /** Briefly raise the sync guard around a programmatic video mutation. */
  function withSyncGuard(mutate) {
    isSyncing = true
    try {
      mutate()
    } catch (e) {
      /* setting currentTime can throw before metadata loads — ignore */
    }
    setTimeout(function () {
      isSyncing = false
    }, 120)
  }

  function showGate() {
    playGate.classList.add('is-visible')
  }

  function hideGate() {
    playGate.classList.remove('is-visible')
  }

  /* ------------------------------------------------------------------------
     Applying state received from the server
     ------------------------------------------------------------------------ */

  /** Currently agreed-upon playback rate (1× by default). */
  var currentRate = 1

  function applyRate(rate) {
    rate = Number(rate)
    if (!isFinite(rate) || rate <= 0) rate = 1
    currentRate = rate
    if (video) {
      try {
        video.playbackRate = rate
      } catch (e) {
        /* some browsers refuse exotic rates — silently ignore */
      }
    }
    var speedBtn = document.getElementById('speedBtn')
    if (speedBtn) speedBtn.textContent = (rate === 1 ? '1' : String(rate)) + '×'
  }

  function applySync(state) {
    isSyncing = true

    if (state.playbackRate) applyRate(state.playbackRate)

    var target = Number(state.currentTime) || 0

    /**
     * When the room is playing, compensate for the network latency between
     * the server stamping the event and us receiving it. The room's
     * playback rate stretches that wall-clock gap into media time.
     */
    if (state.isPlaying && state.serverTime) {
      target += ((Date.now() - state.serverTime) / 1000) * currentRate
    }

    try {
      if (isFinite(target)) {
        video.currentTime = Math.max(0, target)
      }
    } catch (e) {
      /* currentTime not yet settable — the next sync will correct it */
    }

    if (state.isPlaying) {
      var playPromise = video.play()
      if (playPromise && playPromise.catch) {
        playPromise.catch(function (err) {
          // Only a genuine autoplay block — which needs a user gesture to
          // clear — should raise the "tap to play" gate. A seek (or a freshly
          // arrived sync) interrupts the pending play() with an AbortError, and
          // a streaming stall rejects too; those are transient and must NOT
          // flash the gate every time the viewer scrubs the timeline.
          if (err && err.name === 'NotAllowedError') showGate()
        })
      }
    } else {
      video.pause()
    }

    /**
     * Release the guard on the next tick so any seeked/play/pause events
     * triggered by the mutations above are still treated as "syncing".
     */
    setTimeout(function () {
      isSyncing = false
    }, 120)
  }

  socket.on('sync', function (state) {
    lastSync = state
    if (video) applySync(state)
    else if (isExternal) applyExternalSync(state)
  })

  /**
   * The room's playback rate was changed by someone. We get the freshly
   * timed `currentTime` along with it so a rate flip never causes a visible
   * jump on the other clients — apply the time first, then the new rate.
   */
  socket.on('rate_changed', function (state) {
    if (!state) return
    if (video) {
      isSyncing = true
      try {
        if (typeof state.currentTime === 'number') {
          var t = state.currentTime
          if (state.isPlaying && state.serverTime) {
            t += ((Date.now() - state.serverTime) / 1000) * Number(state.playbackRate || 1)
          }
          video.currentTime = Math.max(0, t)
        }
      } catch (e) {}
      applyRate(state.playbackRate)
      setTimeout(function () { isSyncing = false }, 120)
    } else {
      applyRate(state.playbackRate)
    }
  })

  socket.on('viewer_count', function (data) {
    if (data && typeof data.count === 'number') {
      viewerCount.textContent = data.count
      // Mirror it onto the in-player badge shown during fullscreen.
      if (viewerCountFs) viewerCountFs.textContent = data.count
    }
  })

  // The room was deleted by someone else — there is nothing left to watch.
  socket.on('room_deleted', function () {
    window.location.href = '/'
  })

  /**
   * "Wait for slow viewers" — the server tells us who (if anyone) is
   * currently buffering. While the list is non-empty the room is held
   * paused and we show a banner naming the offender(s). An empty list
   * clears the banner (and the server simultaneously sends a `sync`
   * that resumes playback).
   */
  socket.on('wait_state', function (data) {
    var users = data && Array.isArray(data.users) ? data.users : []
    renderWaitBanner(users)
  })

  function renderWaitBanner(users) {
    var banner = document.getElementById('waitBanner')
    var label = document.getElementById('waitBannerLabel')
    if (!banner || !label) return

    if (users.length === 0) {
      banner.classList.remove('is-visible')
      return
    }

    var myName = null
    try {
      myName = localStorage.getItem('wp_display_name_' + slug)
    } catch (e) {
      /* localStorage unavailable */
    }

    var imSlow = false
    for (var i = 0; i < users.length; i++) {
      if (users[i].name === myName) { imSlow = true; break }
    }

    if (imSlow && users.length === 1) {
      label.textContent = 'Your connection is slow — the room is waiting for you…'
    } else if (users.length === 1) {
      label.textContent = users[0].name + ' has connection issues with loading…'
    } else {
      var names = users.map(function (u) { return u.name }).join(', ')
      label.textContent = names + ' have connection issues with loading…'
    }
    banner.classList.add('is-visible')
  }

  socket.on('connect', function () {
    // Only auto-join the room if the overlay is NOT shown (returning
    // visitor with stored name and no password required).
    var dn = getDisplayName()
    if (dn) socket.emit('set_name', { name: dn })
    if (hasStoredName && !needsPassword) {
      socket.emit('join_room', { roomSlug: slug })
    }
  })

  /* ------------------------------------------------------------------------
     Emitting local control actions
     ------------------------------------------------------------------------ */

  function emitControl(action, time) {
    socket.emit('control', { action: action, currentTime: time })
  }

  if (video) {
    playPause.addEventListener('click', function () {
      if (isSyncing) return

      if (video.paused) {
        var playPromise = video.play()
        if (playPromise && playPromise.catch) playPromise.catch(function () {})
      } else {
        video.pause()
      }
      /* No emit here — the `play`/`pause` event listeners below broadcast
         the change. Routing every state flip through the video element
         means PiP, OS media keys, headphone buttons, and any other path
         that toggles playback also notifies the room. */
    })

    /** Seek to an absolute time, clamped to [0, duration], then broadcast it. */
    var seekTo = function (time) {
      var duration = video.duration || 0
      var clamped = Math.min(Math.max(0, time), duration || time)

      withSyncGuard(function () {
        video.currentTime = clamped
      })
      emitControl('seek', clamped)
    }

    back10.addEventListener('click', function () {
      seekTo((video.currentTime || 0) - 10)
    })

    fwd10.addEventListener('click', function () {
      seekTo((video.currentTime || 0) + 10)
    })

    /**
     * Scrubbing the seek bar. We commit the seek only when the user lets go
     * (`change`), not on every `input` tick: a streaming source (in-browser
     * torrent or the server stream) has to re-fetch data for each landing
     * point, so seeking on every pixel of the drag re-buffers dozens of times
     * and floods the room with `seek` events. During the drag we just move the
     * time label so the viewer still sees where they're heading.
     *
     * `input`/`change` fire only on real user interaction — programmatic
     * `seek.value` updates from the poll loop below do not trigger them.
     */
    var isScrubbing = false
    seek.addEventListener('input', function () {
      if (isSyncing) return
      isScrubbing = true
      curTime.textContent = formatTime(parseFloat(seek.value) || 0)
    })
    seek.addEventListener('change', function () {
      if (isSyncing) return
      isScrubbing = false
      seekTo(parseFloat(seek.value))
    })

    /* ----------------------------------------------------------------------
       UI poll — drive the seek bar from video.currentTime every 250ms.
       This intentionally avoids the video's own "timeupdate" event and never
       emits anything.
       ---------------------------------------------------------------------- */

    setInterval(function () {
      var duration = video.duration || 0
      var current = video.currentTime || 0

      // Don't fight the user while they are dragging the slider — leave both the
      // thumb and the time label showing their chosen target until they let go.
      if (duration > 0 && !isScrubbing && document.activeElement !== seek) {
        seek.value = String(current)
      }

      if (!isScrubbing) curTime.textContent = formatTime(current)
      durTime.textContent = formatTime(duration)
    }, 250)

    /* ----------------------------------------------------------------------
       Video element lifecycle
       ---------------------------------------------------------------------- */

    video.addEventListener('loadedmetadata', function () {
      seek.max = String(video.duration || 0)
      durTime.textContent = formatTime(video.duration)
      // A `sync` that arrived before the video could seek (the usual case right
      // after joining a room that's already mid-playback) silently fails to set
      // currentTime, leaving this client stuck at 0. Now that seeking works,
      // re-apply the latest room state so we jump to the shared position — and,
      // crucially, so we never later echo that stale 0 back and yank everyone to
      // the start. applySync runs under the sync guard, so this re-seek/play is
      // not broadcast to the room.
      if (lastSync) applySync(lastSync)
    })

    /**
     * Authoritative play/pause/seek listeners — fire for ANY path that
     * mutates the video (our custom button, the Picture-in-Picture
     * window's controls, OS media keys, headset buttons, etc.). We
     * broadcast the new state to the room unless we're currently
     * applying a server sync ourselves, in which case `isSyncing` is
     * raised and we skip the echo to avoid an infinite ping-pong.
     */
    video.addEventListener('play', function () {
      playPause.textContent = '❚❚'
      if (!isSyncing) emitControl('play', video.currentTime)
    })
    video.addEventListener('pause', function () {
      playPause.textContent = '▶'
      if (!isSyncing) emitControl('pause', video.currentTime)
    })
    /**
     * `seeked` fires once a seek lands. Local seeks via our seek bar /
     * back10 / fwd10 already emit through `seekTo`, and they raise the
     * sync guard so this listener stays quiet for those. What this
     * listener catches is the PiP "skip backward/forward" controls and
     * any media-session seek action.
     */
    video.addEventListener('seeked', function () {
      if (!isSyncing) emitControl('seek', video.currentTime)
    })

    /* ----------------------------------------------------------------------
       Buffer reporter — drives the "wait for slow viewers" feature.

       The browser fires `waiting`/`stalled` when the video runs out of
       buffered data while trying to play, and `playing`/`canplay` when
       data flows again. We forward those state changes to the server
       so it can pause the whole room until everyone is loaded.

       A 1.5s debounce filters out micro-stalls that nobody would
       notice — we only flag real buffering, not the briefest hiccup.
       Recoveries are reported immediately for a snappy resume.
       ---------------------------------------------------------------------- */

    ;(function setupBufferReporter() {
      var BUFFER_DETECT_MS = 1500
      var stallTimer = null
      var reportedBuffering = false

      function reportBuffering(on) {
        if (on === reportedBuffering) return
        reportedBuffering = on
        socket.emit('buffer_state', { buffering: on })
      }

      function clearStallTimer() {
        if (stallTimer) {
          clearTimeout(stallTimer)
          stallTimer = null
        }
      }

      function onStall() {
        /* A user-initiated pause stalls the stream but isn't a network
           problem — only flag stalls while the video wants to play. */
        if (video.paused) return
        clearStallTimer()
        stallTimer = setTimeout(function () {
          reportBuffering(true)
        }, BUFFER_DETECT_MS)
      }

      function onRecover() {
        clearStallTimer()
        reportBuffering(false)
      }

      video.addEventListener('waiting', onStall)
      video.addEventListener('stalled', onStall)
      video.addEventListener('playing', onRecover)
      video.addEventListener('canplay', onRecover)
      /* A real user pause cancels any pending "still buffering" flag and
         clears one already in flight — pausing isn't a connection issue. */
      video.addEventListener('pause', function () {
        clearStallTimer()
        if (reportedBuffering) reportBuffering(false)
      })
    })()

    // Torrent rooms have a "preparing" overlay (upload/download rooms don't),
    // which doubles as the flag for "this is a torrent room".
    var videoPreparing = document.getElementById('videoPreparing')
    var isTorrentRoom = !!videoPreparing
    var torrentTries = 0
    var TORRENT_MAX_TRIES = 18
    var torrentRetryTimer = null

    function showPreparing() {
      if (videoPreparing) videoPreparing.classList.add('is-visible')
    }
    function hidePreparing() {
      if (videoPreparing) videoPreparing.classList.remove('is-visible')
    }

    /* ----------------------------------------------------------------------
       Hybrid torrent streaming
       ----------------------------------------------------------------------
       A torrent room first tries to stream peer-to-peer IN THE BROWSER via
       WebTorrent (over WebRTC), exactly like the mobile app streams on its own
       device — the server then only relays play/pause/seek sync, not the video
       bytes. Browsers can only reach WebRTC/WSS peers, though, so when none are
       found (most public magnets have none) we fall back to the server's
       /stream/:slug, which pulls from the full TCP/UDP swarm. The control sync
       and the rest of this file are identical either way: both sources end up
       as a range-supported `src` on the same <video>.

       Failing over to the server is never wrong — it just changes where the
       bytes come from — so anything that blocks in-browser playback (no peers,
       an unplayable codec, no service-worker support, an insecure origin) ends
       in useServerFallback(). */
    var torrentSource = null /* 'webtorrent' | 'server' */
    var wtClient = null
    var wtFallbackTimer = null
    /* How long to give web peers before assuming there are none and letting the
       server take over. Falling back early is cheap; waiting forever is not. */
    var WT_FALLBACK_MS = 12000
    /* Public WebRTC/WSS trackers, added to whatever the magnet carries so a
       magnet with only udp:// trackers can still discover browser peers (e.g.
       the Sintel demo, seeded over openwebtorrent). */
    var WT_WSS_TRACKERS = [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
      'wss://tracker.btorrent.xyz',
    ]
    var VIDEO_FILE_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi)$/i

    function clearWtFallbackTimer() {
      if (wtFallbackTimer) {
        clearTimeout(wtFallbackTimer)
        wtFallbackTimer = null
      }
    }
    function destroyWtClient() {
      clearWtFallbackTimer()
      if (wtClient) {
        try { wtClient.destroy() } catch (e) {}
        wtClient = null
      }
    }

    /* Switch to the server stream. Idempotent — only the first call switches,
       so the fallback timer, a torrent error and a media error can all race to
       call it harmlessly. */
    function useServerFallback() {
      if (torrentSource === 'server') return
      torrentSource = 'server'
      destroyWtClient()
      torrentTries = 0
      showPreparing()
      var fallback = video.getAttribute('data-fallback') || ('/stream/' + slug)
      video.src = fallback
      video.load()
      var p = video.play()
      if (p && p.catch) p.catch(function () {})
    }

    /* Runs cb once the service worker that serves streamURL is active. */
    function whenSwActive(reg, cb) {
      var w = reg.active || reg.waiting || reg.installing
      if (!w || w.state === 'activated') return cb()
      w.addEventListener('statechange', function onState() {
        if (w.state === 'activated') {
          w.removeEventListener('statechange', onState)
          cb()
        }
      })
    }

    /* Attempt in-browser WebTorrent; defer to the server on any obstacle. */
    function startWebTorrent() {
      var magnet = video.getAttribute('data-magnet') || ''
      if (
        !magnet ||
        typeof window.WebTorrent !== 'function' ||
        !('serviceWorker' in navigator) ||
        !window.isSecureContext
      ) {
        useServerFallback()
        return
      }

      torrentSource = 'webtorrent'
      showPreparing()
      wtFallbackTimer = setTimeout(useServerFallback, WT_FALLBACK_MS)

      navigator.serviceWorker
        .register('/sw.min.js')
        .then(function (reg) {
          whenSwActive(reg, function () {
            if (torrentSource !== 'webtorrent') return /* already fell back */
            try {
              wtClient = new window.WebTorrent()
              wtClient.on('error', function () { useServerFallback() })
              wtClient.createServer({ controller: reg })
              wtClient.add(magnet, { announce: WT_WSS_TRACKERS }, function (torrent) {
                if (torrentSource !== 'webtorrent') return
                /* Largest video file, falling back to the largest file. */
                var file = null
                for (var i = 0; i < torrent.files.length; i++) {
                  var f = torrent.files[i]
                  if (VIDEO_FILE_RE.test(f.name) && (!file || f.length > file.length)) file = f
                }
                if (!file && torrent.files.length) file = torrent.files[0]
                if (!file) { useServerFallback(); return }
                try {
                  video.src = file.streamURL
                  video.load()
                  var p = video.play()
                  if (p && p.catch) p.catch(function () {})
                } catch (e) {
                  useServerFallback()
                }
              })
            } catch (e) {
              useServerFallback()
            }
          })
        })
        .catch(function () { useServerFallback() })
    }

    video.addEventListener('error', function () {
      /* The in-browser P2P source failed (e.g. an unplayable codec) — hand off
         to the server rather than treating it as a dead end. */
      if (torrentSource === 'webtorrent') {
        useServerFallback()
        return
      }
      // The server stream can briefly answer 503 while it finds seeders /
      // fetches metadata. Rather than flashing "video not found" on that
      // transient state, keep the "preparing" overlay and retry for up to ~90s
      // (the server's metadata window) before giving up. Upload/download rooms
      // aren't torrent rooms, so they fail fast as before.
      if (isTorrentRoom && torrentTries < TORRENT_MAX_TRIES) {
        torrentTries += 1
        videoError.classList.remove('is-visible')
        showPreparing()
        if (torrentRetryTimer) clearTimeout(torrentRetryTimer)
        torrentRetryTimer = setTimeout(function () {
          var base = (video.getAttribute('src') || '').split('?')[0]
          if (!base) return
          // Cache-bust so the browser re-requests instead of replaying the
          // failed 503 response.
          video.src = base + '?t=' + Date.now()
          video.load()
          var p = video.play()
          if (p && p.catch) p.catch(function () {})
        }, 5000)
        return
      }
      hidePreparing()
      videoError.classList.add('is-visible')
    })
    video.addEventListener('canplay', function () {
      videoError.classList.remove('is-visible')
      hidePreparing()
      torrentTries = 0
      /* Playing — whichever source won, stop the P2P→server fallback timer. */
      clearWtFallbackTimer()
      if (torrentRetryTimer) {
        clearTimeout(torrentRetryTimer)
        torrentRetryTimer = null
      }
    })

    // Kick off hybrid streaming for torrent rooms (no `src` was set in the
    // template — we choose the source here).
    if (isTorrentRoom) startWebTorrent()

    /* ----------------------------------------------------------------------
       Autoplay gate — clicking it counts as a user gesture, after which we
       re-request a fresh sync so playback resumes exactly in step.
       ---------------------------------------------------------------------- */

    playGate.addEventListener('click', function () {
      hideGate()
      // Raise the sync guard so the play() below — which may run before the
      // room's position has been applied (video at 0) — doesn't echo a stale
      // control back and reset everyone. Re-join to pull the master state; the
      // incoming `sync` re-applies the correct position under the same guard.
      isSyncing = true
      var playPromise = video.play()
      if (playPromise && playPromise.catch) playPromise.catch(function () {})
      socket.emit('join_room', { roomSlug: slug })
      // Fallback release in case no fresh `sync` arrives promptly; applySync
      // re-raises and releases the guard when one does.
      setTimeout(function () { isSyncing = false }, 600)
    })
  }

  /* ------------------------------------------------------------------------
     External-room sync — same control protocol as video rooms, driven by a
     virtual playhead.
     --------------------------------------------------------------------
     We cannot reach into a cross-origin iframe to play / pause / seek its
     embedded player, so the room cannot share *the iframe's* timeline. What
     it CAN share is its own: a logical playhead that everyone agrees on,
     ticked locally and corrected from the same `sync` events upload rooms
     already use. The iframe is then driven from that playhead with the only
     two levers cross-origin embeds expose to us:

       • Play / seek → reload the iframe at `?t=N`, the de-facto standard
         query parameter most embed sites read on load.
       • Pause       → swap the iframe to `about:blank`, which truly stops
         it (no half-stuck audio).

     To keep us from thrashing the iframe on every micro-update, an applied
     `(isPlaying, currentTime)` pair is remembered and the iframe is only
     reloaded when one of them actually changes by something a viewer would
     notice (a different play state, or more than two seconds of drift).
     -------------------------------------------------------------------- */

  /** Forward declaration — assigned in the `if (isExternal)` block below. */
  var applyExternalSync = function () {}

  if (isExternal) {
    var iframe = document.getElementById('externalEmbed')
    var pausedOverlay = document.getElementById('externalPausedOverlay')

    /** Cleaned embed URL (no stale `t=`), used as the base for every reload. */
    var EXTERNAL_BASE = iframe.getAttribute('data-base') || iframe.src
    /** Unknown — we cannot read it from the iframe. Two hours covers a film. */
    var EXTERNAL_DURATION_FALLBACK = 7200

    /**
     * Virtual playhead. Mirrors the shape of an `<video>` (currentTime /
     * paused / duration) so the rest of the file can reason about it the
     * same way.
     */
    var vplay = {
      currentTime: 0,
      paused: true,
      duration: EXTERNAL_DURATION_FALLBACK,
      _tickHandle: null,
      _lastTickAt: 0,
    }

    /** Last `(isPlaying, currentTime)` we wrote to the iframe — see preamble. */
    var iframeApplied = { isPlaying: null, currentTime: 0 }
    /** Reload threshold, in seconds. Smaller drifts are absorbed silently. */
    var IFRAME_SEEK_TOLERANCE = 2

    /* --------------------------------------------------------------------
       Provider detection + SDK adapters
       ----------------------------------------------------------------
       YouTube and Vimeo expose official JS SDKs that let us drive their
       embedded players directly — no iframe reloads, no `?t=` prayers,
       no Resync needed. For those two hosts we attach an adapter built
       on the provider's SDK; for every other origin the existing generic
       reload-based flow further down keeps applying. The SDK script is
       lazy-loaded only when the current room actually uses that provider.
    ---------------------------------------------------------------------- */

    function detectProvider(rawUrl) {
      try {
        var u = new URL(rawUrl, window.location.href)
        var h = u.hostname.toLowerCase()
        if (
          h === 'youtu.be' ||
          h === 'youtube.com' ||
          h === 'www.youtube.com' ||
          h === 'm.youtube.com' ||
          h === 'music.youtube.com' ||
          h.endsWith('.youtube-nocookie.com')
        ) {
          return 'youtube'
        }
        if (h === 'vimeo.com' || h === 'www.vimeo.com' || h === 'player.vimeo.com') {
          return 'vimeo'
        }
      } catch (e) {
        /* malformed URL — treat as generic */
      }
      return 'generic'
    }

    function extractYouTubeId(rawUrl) {
      try {
        var u = new URL(rawUrl, window.location.href)
        if (u.hostname === 'youtu.be') {
          return u.pathname.slice(1).split('/')[0] || null
        }
        var em = /^\/(?:embed|v|shorts)\/([^/?]+)/.exec(u.pathname)
        if (em) return em[1]
        var v = u.searchParams.get('v')
        if (v) return v
      } catch (e) {
        /* malformed URL */
      }
      return null
    }

    function extractVimeoId(rawUrl) {
      try {
        var u = new URL(rawUrl, window.location.href)
        var m = /\/(?:video\/)?(\d+)/.exec(u.pathname)
        return m ? m[1] : null
      } catch (e) {
        /* malformed URL */
      }
      return null
    }

    /** Loads the YouTube IFrame Player API once; resolves when `window.YT` exists. */
    function loadYouTubeApi() {
      if (window.YT && window.YT.Player) return Promise.resolve()
      return new Promise(function (resolve) {
        var prev = window.onYouTubeIframeAPIReady
        window.onYouTubeIframeAPIReady = function () {
          if (typeof prev === 'function') {
            try {
              prev()
            } catch (e) {}
          }
          resolve()
        }
        if (!document.querySelector('script[data-yt-api]')) {
          var s = document.createElement('script')
          s.src = 'https://www.youtube.com/iframe_api'
          s.async = true
          s.setAttribute('data-yt-api', '1')
          document.head.appendChild(s)
        }
      })
    }

    /** Loads the Vimeo Player SDK once; resolves when `window.Vimeo.Player` exists. */
    function loadVimeoApi() {
      if (window.Vimeo && window.Vimeo.Player) return Promise.resolve()
      return new Promise(function (resolve, reject) {
        if (document.querySelector('script[data-vimeo-api]')) {
          var tries = 0
          ;(function check() {
            if (window.Vimeo && window.Vimeo.Player) return resolve()
            if (++tries > 50) return reject(new Error('vimeo-timeout'))
            setTimeout(check, 100)
          })()
          return
        }
        var s = document.createElement('script')
        s.src = 'https://player.vimeo.com/api/player.js'
        s.async = true
        s.setAttribute('data-vimeo-api', '1')
        s.onload = function () {
          resolve()
        }
        s.onerror = reject
        document.head.appendChild(s)
      })
    }

    /**
     * YouTube adapter — drives the YT iframe via the official IFrame Player
     * API. Reverse-syncs onStateChange events as `play`/`pause` control
     * messages so a viewer's click inside the YT player propagates to the
     * rest of the room.
     */
    function createYouTubeAdapter(iframeEl, hooks) {
      var player = null
      var ready = false
      /**
       * Suppresses state-change echoes for a short window after we
       * programmatically drive the player. Without this every applied
       * play/pause would re-broadcast itself, looping forever.
       */
      var driving = 0
      function endDrive() {
        driving = Math.max(0, driving - 1)
      }

      return {
        loadSource: function (rawUrl, initialTime, isPlaying) {
          var videoId = extractYouTubeId(rawUrl)
          if (!videoId) return Promise.reject(new Error('youtube-id'))

          ready = false
          var startAt = Math.max(0, Math.floor(initialTime || 0))
          iframeEl.src =
            'https://www.youtube.com/embed/' +
            encodeURIComponent(videoId) +
            '?enablejsapi=1' +
            '&origin=' +
            encodeURIComponent(window.location.origin) +
            '&autoplay=' +
            (isPlaying ? 1 : 0) +
            '&playsinline=1' +
            '&rel=0' +
            (startAt > 0 ? '&start=' + startAt : '')

          return loadYouTubeApi().then(function () {
            return new Promise(function (resolve) {
              player = new window.YT.Player(iframeEl.id, {
                events: {
                  onReady: function () {
                    ready = true
                    resolve()
                  },
                  onStateChange: function (e) {
                    if (driving > 0) return
                    var t = 0
                    try {
                      t = player.getCurrentTime()
                    } catch (err) {
                      /* player not yet ready */
                    }
                    if (e.data === 1 /* playing */) {
                      if (hooks.onUserPlay) hooks.onUserPlay(t)
                    } else if (e.data === 2 /* paused */) {
                      if (hooks.onUserPause) hooks.onUserPause(t)
                    }
                  },
                },
              })
            })
          })
        },

        apply: function (playing, currentTime, force) {
          if (!ready || !player) return
          driving++
          try {
            var cur = 0
            try {
              cur = player.getCurrentTime()
            } catch (e) {}
            if (force || Math.abs(cur - currentTime) > 1.5) {
              try {
                player.seekTo(currentTime, true)
              } catch (e) {}
            }
            var state = -1
            try {
              state = player.getPlayerState()
            } catch (e) {}
            if (playing && state !== 1) {
              try {
                player.playVideo()
              } catch (e) {}
            } else if (!playing && state !== 2) {
              try {
                player.pauseVideo()
              } catch (e) {}
            }
          } finally {
            setTimeout(endDrive, 1500)
          }
        },
      }
    }

    /**
     * Vimeo adapter — drives the Vimeo iframe through the official Player
     * SDK. The API is promise-based, so the "driving" suppressor uses the
     * promise lifecycle rather than a fixed timeout.
     */
    function createVimeoAdapter(iframeEl, hooks) {
      var player = null
      var ready = false
      var driving = 0
      function endDrive() {
        driving = Math.max(0, driving - 1)
      }

      return {
        loadSource: function (rawUrl, initialTime, isPlaying) {
          var videoId = extractVimeoId(rawUrl)
          if (!videoId) return Promise.reject(new Error('vimeo-id'))

          ready = false
          var startAt = Math.max(0, Math.floor(initialTime || 0))
          iframeEl.src =
            'https://player.vimeo.com/video/' +
            encodeURIComponent(videoId) +
            '?api=1' +
            '&autoplay=' +
            (isPlaying ? 1 : 0) +
            '&playsinline=1' +
            (startAt > 0 ? '#t=' + startAt + 's' : '')

          return loadVimeoApi().then(function () {
            return new Promise(function (resolve) {
              player = new window.Vimeo.Player(iframeEl)
              player.on('play', function () {
                if (driving > 0) return
                player
                  .getCurrentTime()
                  .then(function (t) {
                    if (hooks.onUserPlay) hooks.onUserPlay(t)
                  })
                  .catch(function () {})
              })
              player.on('pause', function () {
                if (driving > 0) return
                player
                  .getCurrentTime()
                  .then(function (t) {
                    if (hooks.onUserPause) hooks.onUserPause(t)
                  })
                  .catch(function () {})
              })
              player.on('seeked', function (data) {
                if (driving > 0) return
                var t = (data && data.seconds) || 0
                if (hooks.onUserSeek) hooks.onUserSeek(t)
              })
              player
                .ready()
                .then(function () {
                  ready = true
                  resolve()
                })
                .catch(function () {
                  resolve()
                })
            })
          })
        },

        apply: function (playing, currentTime, force) {
          if (!ready || !player) return
          driving++
          var chain = player
            .getCurrentTime()
            .then(function (cur) {
              if (force || Math.abs(cur - currentTime) > 1.5) {
                return player.setCurrentTime(currentTime)
              }
            })
            .then(function () {
              return playing ? player.play() : player.pause()
            })
            .catch(function () {})
          chain.then(function () {
            setTimeout(endDrive, 200)
          })
        },
      }
    }

    function createSdkAdapter(kind, iframeEl, hooks) {
      if (kind === 'youtube') return createYouTubeAdapter(iframeEl, hooks)
      if (kind === 'vimeo') return createVimeoAdapter(iframeEl, hooks)
      return null
    }

    /* ---- Per-room provider state -------------------------------------- */

    var providerKind = detectProvider(EXTERNAL_BASE)
    var sdkAdapter = null
    var sdkReady = false

    /**
     * Hooks an SDK adapter calls when it detects the visitor interacted
     * with the embedded player directly (e.g. clicked the YouTube play
     * button). Each event is broadcast as the same `control` message a
     * click on our own buttons would have produced — so the room stays
     * in sync regardless of which UI was used.
     */
    var sdkHooks = {
      onUserPlay: function (t) {
        if (isSyncing) return
        if (vplay.paused) {
          vplay.paused = false
          vplay.currentTime = t
          vplay._lastTickAt = Date.now()
          startTicking()
          updateExternalUI()
          emitControl('play', t)
        }
      },
      onUserPause: function (t) {
        if (isSyncing) return
        if (!vplay.paused) {
          vplay.paused = true
          vplay.currentTime = t
          stopTicking()
          updateExternalUI()
          emitControl('pause', t)
        }
      },
      onUserSeek: function (t) {
        if (isSyncing) return
        vplay.currentTime = t
        vplay._lastTickAt = Date.now()
        updateExternalUI()
        emitControl('seek', t)
      },
    }

    /**
     * (Re)initializes the SDK for the current `EXTERNAL_BASE`. Called both
     * at first load and from the `source_changed` socket event when the
     * embed URL changes. Falls back to generic reload control if the SDK
     * script fails or the URL is missing an id.
     */
    function setupProvider() {
      // We deliberately do not call `destroy()` on the old SDK player —
      // YouTube's destroy() removes the iframe element, and we want to
      // keep it. The old player is orphaned but harmless: once the iframe
      // src changes underneath it, it stops receiving postMessages.
      sdkAdapter = null
      sdkReady = false

      providerKind = detectProvider(EXTERNAL_BASE)

      if (providerKind !== 'youtube' && providerKind !== 'vimeo') {
        // Generic — let applyIframeState handle the about:blank / ?t= flow
        // for the (potentially new) URL.
        iframeApplied.currentTime = Number.NEGATIVE_INFINITY
        iframeApplied.isPlaying = null
        applyIframeState()
        return
      }

      var adapter = createSdkAdapter(providerKind, iframe, sdkHooks)
      if (!adapter) {
        providerKind = 'generic'
        return
      }

      sdkAdapter = adapter
      adapter
        .loadSource(EXTERNAL_BASE, vplay.currentTime, !vplay.paused)
        .then(function () {
          if (sdkAdapter !== adapter) return
          sdkReady = true
          pausedOverlay.classList.remove('is-visible')
          // The room state may have moved while the SDK was loading.
          adapter.apply(!vplay.paused, vplay.currentTime, true)
        })
        .catch(function () {
          // Fall back to generic reload-based control.
          if (sdkAdapter !== adapter) return
          sdkAdapter = null
          sdkReady = false
          providerKind = 'generic'
          iframeApplied.currentTime = Number.NEGATIVE_INFINITY
          iframeApplied.isPlaying = null
          applyIframeState()
        })
    }

    function urlWithTime(base, time) {
      var t = Math.max(0, Math.floor(time))
      try {
        var u = new URL(base, window.location.href)
        u.searchParams.set('t', String(t))
        return u.toString()
      } catch (err) {
        var sep = base.indexOf('?') >= 0 ? '&' : '?'
        return base + sep + 't=' + t
      }
    }

    /**
     * Reconciles the iframe with the virtual playhead. For SDK-backed
     * providers (YouTube / Vimeo) it delegates to the adapter, which uses
     * postMessage and never reloads. For generic embeds it falls back to
     * the reload model: about:blank when paused, `?t=N` when playing.
     *
     * @param {boolean=} force - when true, an SDK seek is applied even if
     *   the current player time is within tolerance. Used for explicit
     *   user seeks.
     */
    function applyIframeState(force) {
      if (sdkAdapter && sdkReady) {
        pausedOverlay.classList.remove('is-visible')
        sdkAdapter.apply(!vplay.paused, vplay.currentTime, !!force)
        return
      }

      if (vplay.paused) {
        if (iframeApplied.isPlaying !== false) {
          iframe.src = 'about:blank'
          iframeApplied.isPlaying = false
          iframeApplied.currentTime = vplay.currentTime
        }
        pausedOverlay.classList.add('is-visible')
        return
      }

      pausedOverlay.classList.remove('is-visible')

      var drift = Math.abs(iframeApplied.currentTime - vplay.currentTime)
      if (iframeApplied.isPlaying !== true || drift > IFRAME_SEEK_TOLERANCE) {
        iframe.src = urlWithTime(EXTERNAL_BASE, vplay.currentTime)
        iframeApplied.isPlaying = true
        iframeApplied.currentTime = vplay.currentTime
      }
    }

    function startTicking() {
      stopTicking()
      vplay._lastTickAt = Date.now()
      vplay._tickHandle = setInterval(function () {
        var now = Date.now()
        vplay.currentTime += (now - vplay._lastTickAt) / 1000
        vplay._lastTickAt = now
        // The iframeApplied.currentTime tracks ticking too, so a tiny drift
        // never triggers a reload — only an explicit seek does.
        iframeApplied.currentTime = vplay.currentTime
        updateExternalUI()
      }, 250)
    }

    function stopTicking() {
      if (vplay._tickHandle) {
        clearInterval(vplay._tickHandle)
        vplay._tickHandle = null
      }
    }

    /**
     * True while the visitor is actively dragging the seek bar. We skip the
     * poll loop's writes to `seek.value` and `curTime` while it is true so
     * the dragged thumb position isn't yanked back to the live playhead
     * mid-drag.
     */
    var draggingSeek = false

    function updateExternalUI() {
      if (document.activeElement !== seek && !draggingSeek) {
        seek.value = String(vplay.currentTime)
      }
      seek.max = String(vplay.duration)
      if (!draggingSeek) curTime.textContent = formatTime(vplay.currentTime)
      // Right-hand label stays as the "LIVE" badge from the template; we
      // don't overwrite it because we never learn the embed's real length.
      playPause.textContent = vplay.paused ? '▶' : '❚❚'
    }

    /**
     * Inbound `sync` handler — drop the virtual playhead onto the master
     * state. Extrapolates a playing room's currentTime by the network hop,
     * exactly like the video flow does.
     */
    applyExternalSync = function (state) {
      isSyncing = true

      var target = Number(state.currentTime) || 0
      if (state.isPlaying && state.serverTime) {
        target += (Date.now() - state.serverTime) / 1000
      }

      vplay.currentTime = Math.max(0, target)
      vplay._lastTickAt = Date.now()

      if (state.isPlaying && vplay.paused) {
        vplay.paused = false
        startTicking()
      } else if (!state.isPlaying && !vplay.paused) {
        vplay.paused = true
        stopTicking()
      }

      applyIframeState()
      updateExternalUI()

      setTimeout(function () {
        isSyncing = false
      }, 120)
    }

    /* ---- Local control actions — same socket protocol as video rooms --- */

    playPause.addEventListener('click', function () {
      if (isSyncing) return

      if (vplay.paused) {
        vplay.paused = false
        vplay._lastTickAt = Date.now()
        startTicking()
        applyIframeState()
        updateExternalUI()
        emitControl('play', vplay.currentTime)
      } else {
        vplay.paused = true
        stopTicking()
        applyIframeState()
        updateExternalUI()
        emitControl('pause', vplay.currentTime)
      }
    })

    function virtualSeek(t) {
      vplay.currentTime = Math.max(0, t)
      vplay._lastTickAt = Date.now()
      if (sdkAdapter && sdkReady) {
        // SDK: jump via the player API; no reload, no `?t=` URL gymnastics.
        applyIframeState(true)
      } else {
        // Generic: force the next reload even when drift is tiny so the
        // embed actually jumps.
        iframeApplied.currentTime = vplay.paused
          ? vplay.currentTime
          : Number.NEGATIVE_INFINITY
        applyIframeState()
      }
      updateExternalUI()
    }

    back10.addEventListener('click', function () {
      virtualSeek(vplay.currentTime - 10)
      emitControl('seek', vplay.currentTime)
    })

    fwd10.addEventListener('click', function () {
      virtualSeek(vplay.currentTime + 10)
      emitControl('seek', vplay.currentTime)
    })

    /**
     * Seek debouncing for external rooms — a drag must NOT fire one
     * `virtualSeek` per pixel. `input` only updates the visual scrub
     * position (cheap — just a label change); `change` fires once when the
     * thumb is released and is the only event that actually broadcasts the
     * seek and reloads the iframe. Without this, dragging the bar reloads
     * the embed dozens of times before the visitor lets go.
     */
    seek.addEventListener('input', function () {
      if (isSyncing) return
      draggingSeek = true
      curTime.textContent = formatTime(parseFloat(seek.value) || 0)
    })

    seek.addEventListener('change', function () {
      if (isSyncing) return
      draggingSeek = false
      virtualSeek(parseFloat(seek.value) || 0)
      emitControl('seek', vplay.currentTime)
    })

    // `change` does not fire if the slider is blurred without a value
    // commit — release the drag lock there too so the poll loop resumes.
    seek.addEventListener('blur', function () {
      draggingSeek = false
    })

    /**
     * "Resync everyone" — asks the server to broadcast a forced realignment
     * to every client in the room (including this one). Useful for the
     * inevitable drift between an iframe's actual frame and the shared room
     * clock during continuous playback. The button is only rendered for
     * external rooms.
     */
    var resyncBtn = document.getElementById('resyncBtn')
    if (resyncBtn) {
      resyncBtn.addEventListener('click', function () {
        // Visual feedback — flips off on the next applyIframeState().
        resyncBtn.classList.add('is-active')
        socket.emit('force_resync')
        setTimeout(function () {
          resyncBtn.classList.remove('is-active')
        }, 600)
      })
    }

    /**
     * Inbound `force_resync` — apply the room's master state exactly like a
     * normal sync, then force the iframe to reload at that time regardless
     * of how small the drift looks against our local model. The drift is in
     * the embed (which we cannot see), not in our virtual clock.
     */
    socket.on('force_resync', function (state) {
      iframeApplied.currentTime = Number.NEGATIVE_INFINITY
      iframeApplied.isPlaying = null
      applyExternalSync(state)
    })

    /* ----------------------------------------------------------------------
       Change-source modal — swap the embed for the next episode / another
       server. The new URL is broadcast through the socket; everyone reloads.
       ---------------------------------------------------------------------- */

    var sourceBtn = document.getElementById('sourceBtn')
    var sourceModal = document.getElementById('sourceModal')
    var newSourceUrl = document.getElementById('newSourceUrl')
    var confirmSource = document.getElementById('confirmSource')
    var cancelSource = document.getElementById('cancelSource')
    var sourceModalError = document.getElementById('sourceModalError')

    function openSourceModal() {
      newSourceUrl.value = EXTERNAL_BASE
      sourceModalError.hidden = true
      sourceModal.classList.add('is-open')
      sourceModal.setAttribute('aria-hidden', 'false')
      setTimeout(function () {
        newSourceUrl.focus()
        newSourceUrl.select()
      }, 30)
    }

    function closeSourceModal() {
      sourceModal.classList.remove('is-open')
      sourceModal.setAttribute('aria-hidden', 'true')
    }

    if (sourceBtn) {
      sourceBtn.addEventListener('click', openSourceModal)
      cancelSource.addEventListener('click', closeSourceModal)
      sourceModal.addEventListener('click', function (e) {
        if (e.target === sourceModal) closeSourceModal()
      })

      confirmSource.addEventListener('click', function () {
        var raw = String(newSourceUrl.value || '').trim()
        if (!raw) {
          sourceModalError.textContent = 'Paste an embed URL first.'
          sourceModalError.hidden = false
          return
        }
        try {
          var parsed = new URL(raw)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('protocol')
          }
        } catch (err) {
          sourceModalError.textContent = 'That does not look like a valid http(s) URL.'
          sourceModalError.hidden = false
          return
        }

        socket.emit('change_source', { url: raw })
        closeSourceModal()
      })
    }

    /**
     * Inbound `source_changed` — server has accepted a new embed URL. Rebuild
     * the base, reset the playhead, and reload the iframe from scratch. The
     * subtitle is cleared server-side too.
     */
    socket.on('source_changed', function (payload) {
      if (!payload || typeof payload.url !== 'string') return

      EXTERNAL_BASE = payload.url
      iframe.setAttribute('data-base', payload.url)

      vplay.currentTime = Number(payload.currentTime) || 0
      vplay._lastTickAt = Date.now()

      if (payload.isPlaying) {
        if (vplay.paused) {
          vplay.paused = false
          startTicking()
        }
      } else if (!vplay.paused) {
        vplay.paused = true
        stopTicking()
      }

      // Re-detect provider, swap the SDK adapter, and reload the iframe.
      setupProvider()
      updateExternalUI()

      // Source change wipes the subtitle.
      setSubtitleSource(null)
    })

    /**
     * The template loads the iframe with the raw embed URL so a slow first
     * sync still shows *something*. As soon as a sync arrives, the iframe is
     * brought in line with the room's master state. Provider setup lets
     * YouTube/Vimeo embeds attach their SDK immediately.
     */
    iframeApplied.isPlaying = true
    iframeApplied.currentTime = 0
    pausedOverlay.classList.remove('is-visible')
    updateExternalUI()
    setupProvider()
  }

  /* ------------------------------------------------------------------------
     Subtitles — available on EVERY room type. File/torrent rooms get a JS
     overlay rendered over the <video>; external rooms over the iframe (a
     cross-origin embed cannot host a <track> of ours). The cue text, the
     room-shared timing offset and the shared weight/size are all driven from
     here. A subtitle reaches the room either by searching OpenSubtitles
     (proxied by the server to dodge CORS) or by uploading an .srt/.vtt; both
     paths store the file on the room and broadcast `subtitle_changed`. The
     timing/weight/size are shared via `set_subtitle_settings`, so adjusting a
     slider updates the look for everyone — matching the mobile app.
     ------------------------------------------------------------------------ */

  var subtitleText = document.getElementById('subtitleText')
  var subtitleBtn = document.getElementById('subtitleBtn')
  var subtitleSettingsBtn = document.getElementById('subtitleSettingsBtn')
  var subtitleModal = document.getElementById('subtitleModal')
  var subtitleSettingsModal = document.getElementById('subtitleSettingsModal')
  var subtitleModalError = document.getElementById('subtitleModalError')

  // Search controls
  var subtitleQuery = document.getElementById('subtitleQuery')
  var subtitleLang = document.getElementById('subtitleLang')
  var subtitleSeason = document.getElementById('subtitleSeason')
  var subtitleEpisode = document.getElementById('subtitleEpisode')
  var subtitleSearchBtn = document.getElementById('subtitleSearchBtn')
  var subtitleResults = document.getElementById('subtitleResults')

  // Upload control
  var subtitleFile = document.getElementById('subtitleFile')
  var confirmSubtitle = document.getElementById('confirmSubtitle')
  var cancelSubtitle = document.getElementById('cancelSubtitle')

  // Settings controls
  var subtitlePreviewText = document.getElementById('subtitlePreviewText')
  var subtitleTimingRange = document.getElementById('subtitleTimingRange')
  var subtitleTimingLabel = document.getElementById('subtitleTimingLabel')
  var subtitleTimingReset = document.getElementById('subtitleTimingReset')
  var subtitleWeightRange = document.getElementById('subtitleWeightRange')
  var subtitleWeightLabel = document.getElementById('subtitleWeightLabel')
  var subtitleSizeRange = document.getElementById('subtitleSizeRange')
  var subtitleSizeLabel = document.getElementById('subtitleSizeLabel')
  var closeSubtitleSettings = document.getElementById('closeSubtitleSettings')

  /** Parsed cue list, sorted by start time. */
  var subtitleCues = []
  /** Last rendered cue index — caches the linear-scan starting point. */
  var lastCueIndex = -1
  /** Room-shared display settings (seeded/updated by `subtitle_settings_changed`). */
  var subtitleOffset = 0
  var subtitleWeight = 500
  var subtitleSize = 28

  /** Languages offered in the search picker — ISO 639-2/B, mirroring the app. */
  var SUBTITLE_LANGS = [
    { id: 'eng', label: 'English' },
    { id: 'ara', label: 'Arabic' },
    { id: 'spa', label: 'Spanish' },
    { id: 'fre', label: 'French' },
    { id: 'ger', label: 'German' },
    { id: 'ita', label: 'Italian' },
    { id: 'por', label: 'Portuguese' },
    { id: 'pob', label: 'Portuguese (BR)' },
    { id: 'rus', label: 'Russian' },
    { id: 'dut', label: 'Dutch' },
    { id: 'pol', label: 'Polish' },
    { id: 'swe', label: 'Swedish' },
    { id: 'tur', label: 'Turkish' },
    { id: 'hin', label: 'Hindi' },
    { id: 'heb', label: 'Hebrew' },
    { id: 'gre', label: 'Greek' },
    { id: 'rum', label: 'Romanian' },
    { id: 'cze', label: 'Czech' },
    { id: 'dan', label: 'Danish' },
    { id: 'fin', label: 'Finnish' },
    { id: 'nor', label: 'Norwegian' },
    { id: 'kor', label: 'Korean' },
    { id: 'jpn', label: 'Japanese' },
    { id: 'chi', label: 'Chinese' },
    { id: 'ind', label: 'Indonesian' },
    { id: 'vie', label: 'Vietnamese' },
    { id: 'tha', label: 'Thai' },
    { id: 'ukr', label: 'Ukrainian' },
    { id: 'fas', label: 'Persian' }
  ]

  function populateLanguages() {
    if (!subtitleLang || subtitleLang.options.length > 0) return
    for (var i = 0; i < SUBTITLE_LANGS.length; i++) {
      var opt = document.createElement('option')
      opt.value = SUBTITLE_LANGS[i].id
      opt.textContent = SUBTITLE_LANGS[i].label
      subtitleLang.appendChild(opt)
    }
    subtitleLang.value = 'eng'
  }

  /** Current playhead time in seconds, whichever player this room uses. */
  function subtitlePlayheadTime() {
    if (isExternal) return vplay ? vplay.currentTime : 0
    return video ? video.currentTime : 0
  }

  /** Pushes the shared weight/size onto the overlay (and the settings preview). */
  function applySubtitleStyle() {
    if (subtitleText) {
      subtitleText.style.fontSize = subtitleSize + 'px'
      subtitleText.style.fontWeight = String(subtitleWeight)
    }
    if (subtitlePreviewText) {
      subtitlePreviewText.style.fontSize = subtitleSize + 'px'
      subtitlePreviewText.style.fontWeight = String(subtitleWeight)
    }
  }

  /**
   * Parses an SRT or WebVTT string into a sorted `{start, end, text}` cue list.
   * Tolerant of either separator (`,` for SRT, `.` for VTT) and of stray cue
   * numbers / VTT headers between cues.
   */
  function parseSubtitles(text) {
    text = String(text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '')

    var lines = text.split('\n')
    var tsRe =
      /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/

    function toSeconds(h, m, s, frac) {
      return (
        (parseInt(h, 10) || 0) * 3600 +
        parseInt(m, 10) * 60 +
        parseInt(s, 10) +
        parseFloat('0.' + (frac || '0'))
      )
    }

    var cues = []
    var i = 0
    while (i < lines.length) {
      var m = tsRe.exec(lines[i])
      if (m) {
        var start = toSeconds(m[1], m[2], m[3], m[4])
        var end = toSeconds(m[5], m[6], m[7], m[8])
        i++
        var body = []
        while (i < lines.length && lines[i].trim() !== '') {
          // Drop simple HTML/VTT styling tags so plain text renders.
          body.push(lines[i].replace(/<[^>]+>/g, ''))
          i++
        }
        if (body.length > 0 && end > start) {
          cues.push({ start: start, end: end, text: body.join('\n') })
        }
      } else {
        i++
      }
    }

    cues.sort(function (a, b) {
      return a.start - b.start
    })
    return cues
  }

  /**
   * Loads a subtitle file by name (the bare filename stored on the room).
   * Pass `null` to clear the overlay entirely.
   */
  function setSubtitleSource(filename) {
    if (!filename) {
      subtitleCues = []
      lastCueIndex = -1
      if (subtitleText) subtitleText.textContent = ''
      return
    }

    var url = '/subtitles/' + encodeURIComponent(filename) + '?t=' + Date.now()
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('http')
        return res.text()
      })
      .then(function (text) {
        subtitleCues = parseSubtitles(text)
        lastCueIndex = -1
      })
      .catch(function () {
        subtitleCues = []
        lastCueIndex = -1
        if (subtitleText) subtitleText.textContent = ''
      })
  }

  /**
   * Picks the cue at the given time. Linear scan with a "remember the last hit"
   * optimization — subtitle files almost always step forward, so we usually
   * find the next cue within one or two iterations.
   */
  function findCue(time) {
    if (subtitleCues.length === 0) return null

    var n = subtitleCues.length
    // Try a small window around the last hit before falling back to scan.
    if (lastCueIndex >= 0 && lastCueIndex < n) {
      var c = subtitleCues[lastCueIndex]
      if (time >= c.start && time < c.end) return c
    }

    for (var i = 0; i < n; i++) {
      var cue = subtitleCues[i]
      if (time < cue.start) return null
      if (time < cue.end) {
        lastCueIndex = i
        return cue
      }
    }
    return null
  }

  function renderSubtitle() {
    if (!subtitleText) return
    if (subtitleCues.length === 0) {
      if (subtitleText.textContent !== '') subtitleText.textContent = ''
      return
    }
    var cue = findCue(subtitlePlayheadTime() + subtitleOffset)
    var next = cue ? cue.text : ''
    if (subtitleText.textContent !== next) subtitleText.textContent = next
  }

  // A dedicated render loop — the playback tick only runs while playing, but
  // subtitles need to refresh on offset/seek changes even while paused.
  setInterval(renderSubtitle, 150)

  /* ---- Shared settings: labels, sync, broadcast --------------------------- */

  function timingLabel(offset) {
    if (Math.abs(offset) < 0.05) return 'In sync'
    var secs = Math.abs(offset).toFixed(1)
    var dir = offset > 0 ? 'later' : 'earlier'
    var sign = offset > 0 ? '+' : '−'
    return sign + secs + ' s · ' + dir
  }

  /** Reflects the shared settings into the sliders/labels/overlay (no broadcast). */
  function syncSettingsControls() {
    if (subtitleTimingRange) subtitleTimingRange.value = String(subtitleOffset)
    if (subtitleTimingLabel) subtitleTimingLabel.textContent = timingLabel(subtitleOffset)
    if (subtitleTimingReset) subtitleTimingReset.disabled = subtitleOffset === 0
    if (subtitleWeightRange) subtitleWeightRange.value = String(subtitleWeight)
    if (subtitleWeightLabel) subtitleWeightLabel.textContent = String(subtitleWeight)
    if (subtitleSizeRange) subtitleSizeRange.value = String(subtitleSize)
    if (subtitleSizeLabel) subtitleSizeLabel.textContent = String(subtitleSize)
    applySubtitleStyle()
  }

  /** Inbound shared settings — seeds a newcomer on join + live updates. */
  function applyRemoteSubtitleSettings(payload) {
    if (!payload) return
    if (isFinite(Number(payload.offset))) subtitleOffset = Number(payload.offset)
    if (isFinite(Number(payload.weight))) subtitleWeight = Number(payload.weight)
    if (isFinite(Number(payload.size))) subtitleSize = Number(payload.size)
    lastCueIndex = -1
    syncSettingsControls()
  }

  /** Broadcasts the current shared settings to the room (clamped server-side). */
  function commitSubtitleSettings() {
    socket.emit('set_subtitle_settings', {
      offset: subtitleOffset,
      weight: subtitleWeight,
      size: subtitleSize
    })
  }

  /* ---- Modal helpers ------------------------------------------------------ */

  function openModalEl(el) {
    if (!el) return
    el.classList.add('is-open')
    el.setAttribute('aria-hidden', 'false')
  }
  function closeModalEl(el) {
    if (!el) return
    el.classList.remove('is-open')
    el.setAttribute('aria-hidden', 'true')
  }

  function openSubtitleModal() {
    if (subtitleModalError) subtitleModalError.hidden = true
    if (subtitleFile) subtitleFile.value = ''
    if (subtitleQuery && !subtitleQuery.value) subtitleQuery.value = window.ROOM_NAME || ''
    openModalEl(subtitleModal)
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  /* ---- Search OpenSubtitles ----------------------------------------------- */

  function renderResults(results) {
    if (!subtitleResults) return
    subtitleResults.innerHTML = ''
    if (!results || results.length === 0) {
      subtitleResults.innerHTML =
        '<p class="sub-results-empty">No subtitles found — try a different name or language.</p>'
      return
    }
    var max = Math.min(results.length, 30)
    for (var i = 0; i < max; i++) {
      var r = results[i]
      var row = document.createElement('div')
      row.className = 'sub-result'
      var meta =
        (r.downloadsCount ? r.downloadsCount + ' ↓' : '') +
        (r.rating ? ' · ★' + r.rating : '') +
        (r.format ? ' · ' + String(r.format).toUpperCase() : '')
      row.innerHTML =
        '<span class="sub-result-lang">' + escapeHtml((r.langId || '').toUpperCase()) + '</span>' +
        '<span class="sub-result-main">' +
        '<span class="sub-result-title">' + escapeHtml(r.releaseName || r.fileName || 'Subtitle') + '</span>' +
        '<span class="sub-result-meta">' + escapeHtml(meta) + '</span>' +
        '</span>' +
        '<button class="btn-primary sub-result-add" type="button">Add</button>'
      ;(function (result, button) {
        button.addEventListener('click', function () {
          attachSubtitle(result, button)
        })
      })(r, row.querySelector('.sub-result-add'))
      subtitleResults.appendChild(row)
    }
  }

  function runSearch() {
    if (!subtitleResults) return
    var query = ((subtitleQuery && subtitleQuery.value) || '').trim()
    if (!query) {
      subtitleResults.innerHTML = '<p class="sub-results-empty">Type a movie or show name to search.</p>'
      return
    }
    var params = new URLSearchParams()
    params.set('query', query)
    params.set('lang', (subtitleLang && subtitleLang.value) || 'eng')
    var s = parseInt(subtitleSeason && subtitleSeason.value, 10)
    var e = parseInt(subtitleEpisode && subtitleEpisode.value, 10)
    if (isFinite(s) && s > 0) params.set('season', String(s))
    if (isFinite(e) && e > 0) params.set('episode', String(e))

    subtitleResults.innerHTML = '<p class="sub-results-empty">Searching…</p>'
    if (subtitleSearchBtn) subtitleSearchBtn.disabled = true

    fetch('/room/' + encodeURIComponent(slug) + '/subtitles/search?' + params.toString(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
      .then(function (res) {
        return res.json().then(function (b) {
          return { ok: res.ok, body: b }
        })
      })
      .then(function (r) {
        if (subtitleSearchBtn) subtitleSearchBtn.disabled = false
        if (!r.ok) {
          subtitleResults.innerHTML =
            '<p class="sub-results-empty">' +
            escapeHtml((r.body && r.body.error) || 'Search failed — try again.') +
            '</p>'
          return
        }
        renderResults(r.body && r.body.results)
      })
      .catch(function () {
        if (subtitleSearchBtn) subtitleSearchBtn.disabled = false
        subtitleResults.innerHTML =
          '<p class="sub-results-empty">Search failed — check your connection.</p>'
      })
  }

  function attachSubtitle(result, button) {
    if (!result || !result.downloadLink) return
    if (button) {
      button.disabled = true
      button.textContent = 'Adding…'
    }
    fetch('/room/' + encodeURIComponent(slug) + '/subtitle/opensubtitles', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ downloadLink: result.downloadLink, format: result.format || 'srt' })
    })
      .then(function (res) {
        return res.json().then(function (b) {
          return { ok: res.ok, body: b }
        })
      })
      .then(function (r) {
        if (button) {
          button.disabled = false
          button.textContent = 'Add'
        }
        if (r.ok && r.body && r.body.filename) {
          // Server broadcasts `subtitle_changed`; our handler loads it.
          closeModalEl(subtitleModal)
          if (window.showToast) showToast('Subtitle added', 'success')
        } else if (window.showToast) {
          showToast((r.body && r.body.error) || 'Could not add subtitle.', 'error')
        }
      })
      .catch(function () {
        if (button) {
          button.disabled = false
          button.textContent = 'Add'
        }
        if (window.showToast) showToast('Could not add subtitle — check your connection.', 'error')
      })
  }

  /* ---- Upload a file ------------------------------------------------------ */

  function uploadSubtitleFile() {
    var file = subtitleFile && subtitleFile.files && subtitleFile.files[0]
    if (!file) {
      if (subtitleModalError) {
        subtitleModalError.textContent = 'Choose an .srt or .vtt file first.'
        subtitleModalError.hidden = false
      }
      return
    }

    var form = new FormData()
    form.append('subtitle', file)

    var xhr = new XMLHttpRequest()
    xhr.open('POST', '/room/' + encodeURIComponent(slug) + '/subtitle')
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.setRequestHeader('Accept', 'application/json')
    confirmSubtitle.disabled = true
    confirmSubtitle.textContent = 'Uploading…'

    xhr.addEventListener('load', function () {
      confirmSubtitle.disabled = false
      confirmSubtitle.textContent = 'Upload file'
      var body = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch (e) {}

      if (xhr.status >= 200 && xhr.status < 300 && body.filename) {
        // The server already broadcast `subtitle_changed` — our handler loads it.
        closeModalEl(subtitleModal)
        if (window.showToast) showToast('Subtitle added', 'success')
      } else {
        subtitleModalError.textContent = body.error || 'Upload failed (HTTP ' + xhr.status + ').'
        subtitleModalError.hidden = false
      }
    })
    xhr.addEventListener('error', function () {
      confirmSubtitle.disabled = false
      confirmSubtitle.textContent = 'Upload file'
      subtitleModalError.textContent = 'The upload failed — check your connection.'
      subtitleModalError.hidden = false
    })
    xhr.send(form)
  }

  /* ---- Wiring ------------------------------------------------------------- */

  if (subtitleBtn) subtitleBtn.addEventListener('click', openSubtitleModal)
  if (cancelSubtitle)
    cancelSubtitle.addEventListener('click', function () {
      closeModalEl(subtitleModal)
    })
  if (subtitleModal)
    subtitleModal.addEventListener('click', function (e) {
      if (e.target === subtitleModal) closeModalEl(subtitleModal)
    })
  if (subtitleSearchBtn) subtitleSearchBtn.addEventListener('click', runSearch)
  if (subtitleQuery)
    subtitleQuery.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        runSearch()
      }
    })
  if (confirmSubtitle) confirmSubtitle.addEventListener('click', uploadSubtitleFile)

  if (subtitleSettingsBtn)
    subtitleSettingsBtn.addEventListener('click', function () {
      syncSettingsControls()
      openModalEl(subtitleSettingsModal)
    })
  if (closeSubtitleSettings)
    closeSubtitleSettings.addEventListener('click', function () {
      closeModalEl(subtitleSettingsModal)
    })
  if (subtitleSettingsModal)
    subtitleSettingsModal.addEventListener('click', function (e) {
      if (e.target === subtitleSettingsModal) closeModalEl(subtitleSettingsModal)
    })

  // Timing/weight/size: preview live while dragging, broadcast on release.
  if (subtitleTimingRange) {
    subtitleTimingRange.addEventListener('input', function () {
      subtitleOffset = Math.round(parseFloat(subtitleTimingRange.value) * 10) / 10
      if (subtitleTimingLabel) subtitleTimingLabel.textContent = timingLabel(subtitleOffset)
      if (subtitleTimingReset) subtitleTimingReset.disabled = subtitleOffset === 0
      lastCueIndex = -1
    })
    subtitleTimingRange.addEventListener('change', commitSubtitleSettings)
  }
  if (subtitleTimingReset)
    subtitleTimingReset.addEventListener('click', function () {
      subtitleOffset = 0
      syncSettingsControls()
      commitSubtitleSettings()
    })
  if (subtitleWeightRange) {
    subtitleWeightRange.addEventListener('input', function () {
      subtitleWeight = parseInt(subtitleWeightRange.value, 10) || 500
      if (subtitleWeightLabel) subtitleWeightLabel.textContent = String(subtitleWeight)
      applySubtitleStyle()
    })
    subtitleWeightRange.addEventListener('change', commitSubtitleSettings)
  }
  if (subtitleSizeRange) {
    subtitleSizeRange.addEventListener('input', function () {
      subtitleSize = parseInt(subtitleSizeRange.value, 10) || 28
      if (subtitleSizeLabel) subtitleSizeLabel.textContent = String(subtitleSize)
      applySubtitleStyle()
    })
    subtitleSizeRange.addEventListener('change', commitSubtitleSettings)
  }

  /** Broadcast: a new subtitle was uploaded/attached. Each client refetches it. */
  socket.on('subtitle_changed', function (payload) {
    var filename = payload && typeof payload.filename === 'string' ? payload.filename : null
    setSubtitleSource(filename)
  })

  /** Shared display settings — seeded on join, updated live by any viewer. */
  socket.on('subtitle_settings_changed', applyRemoteSubtitleSettings)

  populateLanguages()
  applySubtitleStyle()
  if (window.ROOM_SUBTITLE) setSubtitleSource(window.ROOM_SUBTITLE)

  /* ------------------------------------------------------------------------
     Delete-room modal — a confirmation gate in front of the delete form.
     The form itself posts to /room/:slug/delete; the server enforces the
     password and "nobody else watching" rules.
     ------------------------------------------------------------------------ */

  function openModal() {
    deleteModal.classList.add('is-open')
    deleteModal.setAttribute('aria-hidden', 'false')
  }

  function closeModal() {
    deleteModal.classList.remove('is-open')
    deleteModal.setAttribute('aria-hidden', 'true')
  }

  if (deleteBtn && deleteModal && cancelDelete) {
    deleteBtn.addEventListener('click', openModal)
    cancelDelete.addEventListener('click', closeModal)

    // A click on the dimmed backdrop (outside the card) closes the modal.
    deleteModal.addEventListener('click', function (e) {
      if (e.target === deleteModal) closeModal()
    })

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal()
    })
  }

  /* ------------------------------------------------------------------------
     Share link — copy the room URL to the clipboard
     ------------------------------------------------------------------------ */

  var shareBtn = document.getElementById('shareBtn')
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var url = window.location.href
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          showToast('Link copied!')
        }).catch(function () {
          showToast('Could not copy link.', 'error')
        })
      } else {
        // Fallback for non-HTTPS contexts.
        var ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
          showToast('Link copied!')
        } catch (e) {
          showToast('Could not copy link.', 'error')
        }
        document.body.removeChild(ta)
      }
    })
  }

  /* ------------------------------------------------------------------------
     Display name — ask through a styled overlay, store in localStorage
     ------------------------------------------------------------------------ */

  var DISPLAY_NAME_KEY = 'wp_display_name_' + slug

  function getDisplayName() {
    try {
      return localStorage.getItem(DISPLAY_NAME_KEY)
    } catch (e) {
      return null
    }
  }

  function setDisplayName(name) {
    try {
      localStorage.setItem(DISPLAY_NAME_KEY, name)
    } catch (e) {}
  }

  /* ---- Join overlay — replaces the old prompt() + room_locked page ------ */

  var joinOverlay = document.getElementById('joinOverlay')
  var joinName = document.getElementById('joinName')
  var joinPassword = document.getElementById('joinPassword')
  var joinPasswordField = document.getElementById('joinPasswordField')
  var joinBtn = document.getElementById('joinBtn')
  var joinError = document.getElementById('joinError')

  /**
   * If a display name is already stored (returning visitor) and there's no
   * password to enter, skip the join overlay. Otherwise show it.
   */
  var hasStoredName = !!getDisplayName()
  var needsPassword = window.ROOM_HAS_PASSWORD && !window.ROOM_UNLOCKED
  if ((!hasStoredName || needsPassword) && joinOverlay) {
    joinOverlay.classList.add('is-visible')
  }

  /* Pre-fill the name if returning. */
  if (hasStoredName && joinName) {
    joinName.value = getDisplayName()
    /* Reveal the password field if the room is locked. */
    if (joinPasswordField) {
      joinPasswordField.hidden = !needsPassword
    }
  }

  /* Reveal the password field once the user starts typing a name. */
  if (joinPasswordField) {
    joinName.addEventListener('input', function () {
      joinPasswordField.hidden = joinName.value.trim().length === 0
    })
  }

  function submitJoin() {
    var name = joinName ? joinName.value.trim() : ''
    if (!name) {
      if (joinError) {
        joinError.textContent = 'Please enter a display name.'
        joinError.hidden = false
      }
      return
    }

    if (joinBtn) {
      joinBtn.disabled = true
      joinBtn.textContent = 'Joining…'
    }

    function enterRoom() {
      setDisplayName(name.slice(0, 30))
      socket.emit('set_name', { name: name })

      // Establish a user gesture context so the subsequent video.play()
      // from the sync handler is not blocked by browser autoplay policy.
      if (video) {
        video.play().catch(function () {})
      }

      socket.emit('join_room', { roomSlug: slug })
      if (joinOverlay) joinOverlay.classList.remove('is-visible')
      if (joinBtn) {
        joinBtn.disabled = false
        joinBtn.textContent = 'Join'
      }
    }

    // If the room is password-protected and not yet unlocked, POST to the
    // unlock endpoint first.
    if (
      window.ROOM_HAS_PASSWORD &&
      !window.ROOM_UNLOCKED &&
      joinPassword &&
      joinPasswordField &&
      !joinPasswordField.hidden
    ) {
      var password = joinPassword.value
      if (!password) {
        if (joinError) {
          joinError.textContent = 'Please enter the room password.'
          joinError.hidden = false
        }
        if (joinBtn) {
          joinBtn.disabled = false
          joinBtn.textContent = 'Join'
        }
        return
      }

      var xhr = new XMLHttpRequest()
      xhr.open('POST', '/room/' + encodeURIComponent(slug) + '/unlock')
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded')
      xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          enterRoom()
        } else {
          var res = {}
          try {
            res = JSON.parse(xhr.responseText)
          } catch (e) {}
          if (joinError) {
            joinError.textContent = res.error || 'Incorrect password.'
            joinError.hidden = false
          }
          if (joinBtn) {
            joinBtn.disabled = false
            joinBtn.textContent = 'Join'
          }
        }
      })
      xhr.addEventListener('error', function () {
        if (joinError) {
          joinError.textContent = 'Request failed — check your connection.'
          joinError.hidden = false
        }
        if (joinBtn) {
          joinBtn.disabled = false
          joinBtn.textContent = 'Join'
        }
      })
      xhr.send('password=' + encodeURIComponent(password))
    } else {
      enterRoom()
    }
  }

  if (joinBtn) {
    joinBtn.addEventListener('click', submitJoin)
  }

  /* Also submit on Enter key in either input. */
  if (joinName) {
    joinName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitJoin()
      }
    })
  }
  if (joinPassword) {
    joinPassword.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitJoin()
      }
    })
  }



  /* ------------------------------------------------------------------------
     User presence — who's watching popover
     ------------------------------------------------------------------------ */

  var presenceBtn = document.getElementById('presenceBtn')
  var presencePopover = document.getElementById('presencePopover')
  var presenceList = document.getElementById('presenceList')
  var presenceAvatars = document.getElementById('presenceAvatars')
  var presenceCount = document.getElementById('presenceCount')

  var AVATAR_COLORS = ['#2dd4bf', '#f87171', '#60a5fa', '#fbbf24', '#a78bfa', '#34d399', '#fb923c', '#e879f9']

  function avatarColor(name) {
    var hash = 0
    for (var i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash)
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
  }

  function updatePresence(users) {
    if (!presenceList || !presenceAvatars || !presenceCount) return

    presenceCount.textContent = users.length

    // Show up to 3 avatar circles.
    var maxAvatars = 3
    presenceAvatars.innerHTML = ''
    users.slice(0, maxAvatars).forEach(function (u) {
      var span = document.createElement('span')
      span.className = 'presence-avatar'
      span.textContent = (u.name.charAt(0) || '?').toUpperCase()
      span.style.background = avatarColor(u.name)
      span.title = u.name
      presenceAvatars.appendChild(span)
    })
    if (users.length > maxAvatars) {
      var more = document.createElement('span')
      more.className = 'presence-avatar presence-avatar--more'
      more.textContent = '+' + (users.length - maxAvatars)
      presenceAvatars.appendChild(more)
    }

    // Popover list.
    presenceList.innerHTML = ''
    if (users.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'presence-list-empty'
      empty.textContent = 'No one else is here yet.'
      presenceList.appendChild(empty)
      return
    }
    users.forEach(function (u) {
      var row = document.createElement('div')
      row.className = 'presence-row'
      var dot = document.createElement('span')
      dot.className = 'presence-row-avatar'
      dot.textContent = (u.name.charAt(0) || '?').toUpperCase()
      dot.style.background = avatarColor(u.name)
      row.appendChild(dot)
      var label = document.createElement('span')
      label.className = 'presence-row-name'
      label.textContent = u.name
      row.appendChild(label)
      presenceList.appendChild(row)
    })
  }

  socket.on('room_users', function (data) {
    if (data && Array.isArray(data.users)) updatePresence(data.users)
  })

  if (presenceBtn && presencePopover) {
    presenceBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      var hidden = presencePopover.hasAttribute('hidden')
      presencePopover.hidden = !hidden
    })
    document.addEventListener('click', function (e) {
      if (!presenceBtn.contains(e.target) && !presencePopover.contains(e.target)) {
        presencePopover.hidden = true
      }
    })
  }

  /* ------------------------------------------------------------------------
     Emoji reactions — broadcast to the room, float-up animation
     ------------------------------------------------------------------------ */

  var reactionTray = document.getElementById('reactionTray')
  var reactionToggle = document.getElementById('reactionToggle')
  if (reactionTray) {
    reactionTray.addEventListener('click', function (e) {
      var btn = e.target.closest('.reaction-btn')
      if (!btn) return
      var emoji = btn.getAttribute('data-reaction')
      if (!emoji) return
      socket.emit('reaction', { emoji: emoji })

      // Show own reaction locally — same wrapper + random position as
      // everyone else's, just without the avatar badge.
      var wrapper = document.createElement('span')
      wrapper.className = 'reaction-emoji-wrapper'
      wrapper.style.left = (10 + Math.random() * 60) + '%'
      var selfEl = document.createElement('span')
      selfEl.className = 'reaction-emoji'
      selfEl.textContent = emoji
      wrapper.appendChild(selfEl)
      player.appendChild(wrapper)
      setTimeout(function () { wrapper.remove() }, 1600)
    })
  }

  if (reactionToggle && reactionTray) {
    reactionToggle.addEventListener('click', function (e) {
      e.stopPropagation()
      reactionTray.classList.toggle('is-open')
    })
    document.addEventListener('click', function (e) {
      if (
        reactionTray.classList.contains('is-open') &&
        !reactionToggle.contains(e.target) &&
        !reactionTray.contains(e.target)
      ) {
        reactionTray.classList.remove('is-open')
      }
    })
  }

  socket.on('reaction', function (payload) {
    var emoji = payload && typeof payload.emoji === 'string' ? payload.emoji : null
    if (!emoji) return

    var wrapper = document.createElement('span')
    wrapper.className = 'reaction-emoji-wrapper'
    wrapper.style.left = (10 + Math.random() * 60) + '%'

    var el = document.createElement('span')
    el.className = 'reaction-emoji'
    el.textContent = emoji
    wrapper.appendChild(el)

    var name = payload && typeof payload.name === 'string' ? payload.name : ''
    if (name) {
      var avatar = document.createElement('span')
      avatar.className = 'reaction-avatar'
      avatar.textContent = name.charAt(0).toUpperCase()
      avatar.style.background = avatarColor(name)
      avatar.title = name
      wrapper.appendChild(avatar)
    }

    player.appendChild(wrapper)
    setTimeout(function () { wrapper.remove() }, 2200)
  })

  /* ------------------------------------------------------------------------
     Collaborative drawing — pen tool over the video
     ------------------------------------------------------------------------
     A port of the mobile app's draw layer. Every viewer's strokes (this
     device's local echo plus relayed `draw` events) render on one canvas;
     each finished line lingers then fades in place. While draw mode is on,
     pointer drags are captured, normalized 0..1 against the player box, and
     streamed as `draw` segments (throttled ~25/s) so others watch the line
     form. Colors, widths and fade timing match the app exactly.
     ------------------------------------------------------------------------ */

  ;(function () {
    var canvas = document.getElementById('drawCanvas')
    var toggle = document.getElementById('drawToggle')
    var palette = document.getElementById('drawPalette')
    var paletteClose = document.getElementById('drawPaletteClose')
    if (!canvas || !toggle) return
    var ctx = canvas.getContext('2d')

    var LINGER_MS = 1800
    var FADE_MS = 800
    var MAX_ALIVE_MS = 10000
    var THROTTLE_MS = 40
    var STROKE_WIDTH = 4

    var active = false
    var color = '#FF5252'
    /** Active strokes keyed by `senderId:strokeId`. */
    var strokes = {}
    var rafId = null

    /* ---- Canvas sizing (devicePixelRatio-aware) ---- */
    function resize() {
      var rect = canvas.getBoundingClientRect()
      var dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    window.addEventListener('resize', resize)
    // The player box changes on (un)fullscreen — re-measure after the layout settles.
    document.addEventListener('fullscreenchange', function () { setTimeout(resize, 60) })
    document.addEventListener('webkitfullscreenchange', function () { setTimeout(resize, 60) })
    resize()

    /* ---- Render loop (runs only while strokes exist) ---- */
    function opacityOf(s, now) {
      if (s.doneAt == null) return 1
      var e = now - s.doneAt
      if (e <= LINGER_MS) return 1
      return Math.max(0, 1 - (e - LINGER_MS) / FADE_MS)
    }

    function render() {
      var now = Date.now()
      var rect = canvas.getBoundingClientRect()
      var w = rect.width
      var h = rect.height
      ctx.clearRect(0, 0, w, h)

      var any = false
      Object.keys(strokes).forEach(function (key) {
        var s = strokes[key]
        if (s.doneAt != null) {
          if (now - s.doneAt > LINGER_MS + FADE_MS) { delete strokes[key]; return }
        } else if (now - s.createdAt > MAX_ALIVE_MS) {
          delete strokes[key]; return
        }
        any = true
        var op = opacityOf(s, now)
        if (op <= 0 || !s.points.length) return
        ctx.globalAlpha = op
        ctx.strokeStyle = s.color
        ctx.fillStyle = s.color
        ctx.lineWidth = STROKE_WIDTH
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        if (s.points.length === 1) {
          // A tap with no drag — render a dot.
          ctx.beginPath()
          ctx.arc(s.points[0].x * w, s.points[0].y * h, 2.4, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        ctx.beginPath()
        ctx.moveTo(s.points[0].x * w, s.points[0].y * h)
        for (var i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * w, s.points[i].y * h)
        }
        ctx.stroke()
      })
      ctx.globalAlpha = 1

      if (any) {
        rafId = requestAnimationFrame(render)
      } else {
        rafId = null
        ctx.clearRect(0, 0, w, h)
      }
    }

    function ensureRender() {
      if (rafId == null) rafId = requestAnimationFrame(render)
    }

    function addSegment(key, colorHex, pts, done) {
      var s = strokes[key]
      if (!s) {
        s = { color: colorHex || '#ffffff', points: [], createdAt: Date.now(), doneAt: null }
        strokes[key] = s
      }
      for (var i = 0; i < pts.length; i++) s.points.push(pts[i])
      if (done && s.doneAt == null) s.doneAt = Date.now()
      ensureRender()
    }

    /* ---- Incoming strokes from other viewers ---- */
    socket.on('draw', function (payload) {
      if (!payload) return
      var id = typeof payload.id === 'string' ? payload.id : ''
      var strokeId = typeof payload.strokeId === 'string' ? payload.strokeId : ''
      if (!strokeId) return
      var pts = []
      if (Array.isArray(payload.points)) {
        payload.points.forEach(function (p) {
          if (Array.isArray(p) && p.length >= 2) pts.push({ x: +p[0], y: +p[1] })
        })
      }
      addSegment(id + ':' + strokeId, payload.color, pts, payload.done === true)
    })

    /* ---- Local drawing — capture, throttle, stream ---- */
    var curStrokeId = null
    var localKey = null
    var pending = []
    var lastFlush = 0

    function newStrokeId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }

    function normalize(evt) {
      var rect = canvas.getBoundingClientRect()
      var x = rect.width ? (evt.clientX - rect.left) / rect.width : 0
      var y = rect.height ? (evt.clientY - rect.top) / rect.height : 0
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    }

    function flush(done) {
      if (!curStrokeId) return
      if (!pending.length && !done) return
      var pts = pending.slice()
      pending = []
      lastFlush = Date.now()
      // Local echo so the drawer sees their own line immediately.
      addSegment(localKey, color, pts, done)
      socket.emit('draw', {
        strokeId: curStrokeId,
        color: color,
        points: pts.map(function (p) { return [p.x, p.y] }),
        done: done,
      })
    }

    function onDown(evt) {
      if (!active) return
      evt.preventDefault()
      curStrokeId = newStrokeId()
      localKey = 'local:' + curStrokeId
      pending = [normalize(evt)]
      flush(false)
      if (canvas.setPointerCapture && evt.pointerId != null) {
        try { canvas.setPointerCapture(evt.pointerId) } catch (e) {}
      }
    }

    function onMove(evt) {
      if (!active || !curStrokeId) return
      evt.preventDefault()
      pending.push(normalize(evt))
      if (Date.now() - lastFlush >= THROTTLE_MS) flush(false)
    }

    function onUp(evt) {
      if (!curStrokeId) return
      if (evt && evt.preventDefault) evt.preventDefault()
      flush(true)
      curStrokeId = null
      localKey = null
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    /* ---- Toggle + palette ---- */
    function setActive(on) {
      active = on
      player.classList.toggle('is-drawing', on)
      if (palette) palette.hidden = !on
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
      if (!on) onUp(null)
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation()
      setActive(!active)
    })

    if (paletteClose) {
      paletteClose.addEventListener('click', function (e) {
        e.stopPropagation()
        setActive(false)
      })
    }

    var swatches = palette ? palette.querySelectorAll('.draw-swatch') : []
    Array.prototype.forEach.call(swatches, function (sw) {
      sw.addEventListener('click', function (e) {
        e.stopPropagation()
        color = sw.getAttribute('data-color') || '#FF5252'
        Array.prototype.forEach.call(swatches, function (o) {
          o.classList.toggle('is-selected', o === sw)
        })
        // Picking a color engages draw mode (matches the app).
        setActive(true)
      })
    })
  })()

  /* ------------------------------------------------------------------------
     Keyboard shortcuts — keyboard-driven player controls
     ------------------------------------------------------------------------ */

  var shortcutsModal = document.getElementById('shortcutsModal')
  var closeShortcutsBtn = document.getElementById('closeShortcutsBtn')

  function openShortcuts() {
    if (shortcutsModal) {
      shortcutsModal.classList.add('is-open')
      shortcutsModal.setAttribute('aria-hidden', 'false')
    }
  }

  function closeShortcuts() {
    if (shortcutsModal) {
      shortcutsModal.classList.remove('is-open')
      shortcutsModal.setAttribute('aria-hidden', 'true')
    }
  }

  if (closeShortcutsBtn) {
    closeShortcutsBtn.addEventListener('click', closeShortcuts)
    shortcutsModal.addEventListener('click', function (e) {
      if (e.target === shortcutsModal) closeShortcuts()
    })
  }

  document.addEventListener('keydown', function (e) {
    // Ignore when typing in inputs.
    if (e.target.matches('input, textarea, select')) return

    switch (e.key) {
      case ' ':
        e.preventDefault()
        if (playPause) playPause.click()
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (back10) back10.click()
        break
      case 'ArrowRight':
        e.preventDefault()
        if (fwd10) fwd10.click()
        break
      case 'ArrowUp':
        e.preventDefault()
        if (video) seekTo((video.currentTime || 0) + 60)
        else if (isExternal) virtualSeek(vplay.currentTime + 60)
        break
      case 'ArrowDown':
        e.preventDefault()
        if (video) seekTo((video.currentTime || 0) - 60)
        else if (isExternal) virtualSeek(vplay.currentTime - 60)
        break
      case 'f':
      case 'F':
        fullscreenBtn.click()
        break
      case 'm':
      case 'M':
        micBtn.click()
        break
      case 'd':
      case 'D':
        var drawToggleBtn = document.getElementById('drawToggle')
        if (drawToggleBtn) drawToggleBtn.click()
        break
      case '?':
        openShortcuts()
        break
    }
  })

  /* ------------------------------------------------------------------------
     Edit room — change name/password through XHR PUT
     ------------------------------------------------------------------------ */

  var editBtn = document.getElementById('editBtn')
  var editModal = document.getElementById('editModal')
  var editName = document.getElementById('editName')
  var editPassword = document.getElementById('editPassword')
  var editCurrentPassword = document.getElementById('editCurrentPassword')
  var editModalError = document.getElementById('editModalError')
  var confirmEdit = document.getElementById('confirmEdit')
  var cancelEdit = document.getElementById('cancelEdit')
  var roomTitle = document.getElementById('roomTitle')

  /* ---- Edit modal emoji picker ---- */

  var editEmojiPicker = document.getElementById('editEmojiPicker')
  var editReactionsInput = document.getElementById('editReactionsInput')
  var editEmojiGrid = document.getElementById('editEmojiGrid')
  var editEmojiToggle = document.getElementById('editEmojiToggle')
  var editEmojiSelected = document.getElementById('editEmojiSelected')
  var editSelectedEmojis = []
  var editSavedReactions = ''
  if (editEmojiPicker) {
    editSavedReactions = editReactionsInput.value
    try { editSelectedEmojis = JSON.parse(editSavedReactions || '[]') } catch (e) {}
    var editEmojiOpts = editEmojiPicker.querySelectorAll('.emoji-opt')
    function renderEditSelectedBar() {
      editEmojiSelected.innerHTML = ''
      editSelectedEmojis.forEach(function (emoji) {
        var el = document.createElement('span')
        el.className = 'emoji-selected-item'
        el.textContent = emoji
        el.addEventListener('click', function (e) {
          e.stopPropagation()
          var idx = editSelectedEmojis.indexOf(emoji)
          if (idx !== -1) editSelectedEmojis.splice(idx, 1)
          updateEditEmojis()
        })
        editEmojiSelected.appendChild(el)
      })
    }
    function updateEditEmojis() {
      editReactionsInput.value = JSON.stringify(editSelectedEmojis)
      editEmojiOpts.forEach(function (btn) {
        btn.classList.toggle('is-selected', editSelectedEmojis.indexOf(btn.getAttribute('data-emoji')) !== -1)
      })
      renderEditSelectedBar()
    }
    editEmojiOpts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji')
        var idx = editSelectedEmojis.indexOf(emoji)
        if (idx !== -1) {
          editSelectedEmojis.splice(idx, 1)
        } else if (editSelectedEmojis.length < 8) {
          editSelectedEmojis.push(emoji)
        }
        updateEditEmojis()
      })
    })
    editEmojiToggle.addEventListener('click', function () {
      editEmojiGrid.classList.toggle('is-collapsed')
      editEmojiToggle.textContent = editEmojiGrid.classList.contains('is-collapsed') ? 'Show all emojis' : 'Hide all emojis'
    })
    editEmojiGrid.classList.add('is-collapsed')
    updateEditEmojis()
  }

  if (editBtn && editModal) {
    function openEditModal() {
      // Reset emoji selection to the saved room state
      if (editEmojiPicker) {
        try { editSelectedEmojis = JSON.parse(editSavedReactions || '[]') } catch (e) { editSelectedEmojis = [] }
        updateEditEmojis()
      }
      editModalError.hidden = true
      editModal.classList.add('is-open')
      editModal.setAttribute('aria-hidden', 'false')
      if (editPassword) editPassword.value = ''
      if (editCurrentPassword) editCurrentPassword.value = ''
      setTimeout(function () { if (editName) editName.focus() }, 30)
    }

    function closeEditModal() {
      editModal.classList.remove('is-open')
      editModal.setAttribute('aria-hidden', 'true')
    }

    editBtn.addEventListener('click', openEditModal)
    if (cancelEdit) cancelEdit.addEventListener('click', closeEditModal)
    editModal.addEventListener('click', function (e) {
      if (e.target === editModal) closeEditModal()
    })

    confirmEdit.addEventListener('click', function () {
      var name = editName ? editName.value.trim() : ''
      if (name.length < 2) {
        editModalError.textContent = 'Room name must be at least 2 characters.'
        editModalError.hidden = false
        return
      }

      var body = new FormData()
      body.append('name', name)
      if (editPassword && editPassword.value) body.append('password', editPassword.value)
      if (editCurrentPassword) body.append('currentPassword', editCurrentPassword.value)
      if (editReactionsInput) body.append('reactions', editReactionsInput.value)

      confirmEdit.disabled = true
      confirmEdit.textContent = 'Saving…'

      var xhr = new XMLHttpRequest()
      xhr.open('PUT', '/room/' + encodeURIComponent(slug))
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.addEventListener('load', function () {
        confirmEdit.disabled = false
        confirmEdit.textContent = 'Save'
        var res = {}
        try { res = JSON.parse(xhr.responseText) } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && res.success) {
          if (res.name && roomTitle) roomTitle.textContent = res.name
          if (document.title) document.title = res.name + ' — Watch Party'
          // Prefer the server's authoritative list — falls back to whatever
          // was in the hidden input if the server didn't echo it back.
          var newEmojis = Array.isArray(res.reactions) ? res.reactions : null
          if (!newEmojis && editReactionsInput) {
            try { newEmojis = JSON.parse(editReactionsInput.value || '[]') } catch (e) { newEmojis = [] }
          }
          if (newEmojis && reactionTray) {
            reactionTray.innerHTML = ''
            newEmojis.forEach(function (emoji) {
              var btn = document.createElement('button')
              btn.className = 'reaction-btn'
              btn.setAttribute('data-reaction', emoji)
              btn.type = 'button'
              btn.textContent = emoji
              reactionTray.appendChild(btn)
            })
          }
          // Keep the hidden input in step with what the server actually
          // saved, so a follow-up edit doesn't re-submit the unsaved draft.
          if (editReactionsInput && newEmojis) {
            editReactionsInput.value = JSON.stringify(newEmojis)
          }
          // Remember the saved value so reopening the modal resets correctly
          editSavedReactions = editReactionsInput ? editReactionsInput.value : ''
          closeEditModal()
          showToast('Room settings saved.')
        } else {
          editModalError.textContent = res.error || 'Save failed (HTTP ' + xhr.status + ').'
          editModalError.hidden = false
        }
      })
      xhr.addEventListener('error', function () {
        confirmEdit.disabled = false
        confirmEdit.textContent = 'Save'
        editModalError.textContent = 'Request failed — check your connection.'
        editModalError.hidden = false
      })
      xhr.send(body)
    })
  }

  /* ------------------------------------------------------------------------
     Fullscreen — toggles the whole player (video + controls) in and out of
     the browser's fullscreen mode, with a Safari (webkit) fallback.
     ------------------------------------------------------------------------ */

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement)
  }

  fullscreenBtn.addEventListener('click', function () {
    try {
      if (isFullscreen()) {
        ;(document.exitFullscreen || document.webkitExitFullscreen).call(document)
      } else {
        var request = player.requestFullscreen || player.webkitRequestFullscreen
        var pending = request.call(player)
        if (pending && pending.catch) pending.catch(function () {})
      }
    } catch (e) {
      /* fullscreen is unavailable — ignore */
    }
  })

  /**
   * While in fullscreen the browser's fullscreen element may not bubble
   * mousemove events in all implementations (especially with an iframe or
   * video covering the surface).  A document-level mousemove guarantees we
   * never lose the ability to bring the controls back.
   */
  var fsMousemove = null

  function onFullscreenChange() {
    var fs = isFullscreen()
    fullscreenBtn.classList.toggle('is-active', fs)
    player.classList.toggle('is-fullscreen', fs)

    if (fs) {
      fsMousemove = function () {
        if (Date.now() < ignoreMouseUntil) return
        scheduleControlsHide()
      }
      document.addEventListener('mousemove', fsMousemove)
    } else if (fsMousemove) {
      document.removeEventListener('mousemove', fsMousemove)
      fsMousemove = null
    }

    scheduleControlsHide()
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)

  /* ------------------------------------------------------------------------
     Auto-hiding controls — both control bars fade away (and the cursor with
     them) after a short idle period with no pointer or touch activity. On a
     mouse, moving the pointer brings them back; on a touchscreen a tap on the
     video toggles them — tap to show, tap again to hide. This happens whether
     the video is playing or paused; the bars only stay up while the talk
     button is held.
     ------------------------------------------------------------------------ */

  var idleTimer = null
  var IDLE_MS = 2800

  function showControls() {
    player.classList.remove('is-idle')
  }

  function hideControls() {
    // Hide on inactivity regardless of play state; never while talking. For
    // external rooms the iframe swallows every `mousemove` over its
    // surface, so a hidden bar could not be brought back without a tap on
    // the (invisible) bar zone itself. Keep the bar up there.
    if (!isTalking && !isExternal) player.classList.add('is-idle')
  }

  function scheduleControlsHide() {
    clearTimeout(idleTimer)
    showControls()
    idleTimer = setTimeout(hideControls, IDLE_MS)
  }

  /**
   * A tap fires synthetic mouse events (mousemove/click) right after the
   * touch ones; this timestamp lets the mouse handlers ignore that echo so a
   * tap-to-hide is not immediately undone by a phantom mousemove.
   */
  var ignoreMouseUntil = 0

  /** True when the tapped element is one of the actual control widgets. */
  function tappedOnControls(node) {
    return !!(node && node.closest && node.closest('.controls, .top-controls'))
  }

  player.addEventListener('mousemove', function () {
    if (Date.now() < ignoreMouseUntil) return
    scheduleControlsHide()
  })

  player.addEventListener(
    'touchstart',
    function (e) {
      ignoreMouseUntil = Date.now() + 700

      // Taps that land on a button or the seek bar drive that widget and
      // just keep the bars up — they never toggle them away.
      if (tappedOnControls(e.target)) {
        scheduleControlsHide()
        return
      }

      // A tap on the video area toggles the bars: show if hidden, else hide.
      if (player.classList.contains('is-idle')) {
        scheduleControlsHide()
      } else {
        clearTimeout(idleTimer)
        hideControls()
      }
    },
    { passive: true }
  )

  player.addEventListener('mouseleave', function () {
    if (isFullscreen()) return
    clearTimeout(idleTimer)
    hideControls()
  })

  player.addEventListener('click', function (e) {
    // The synthetic click that trails a touch tap is already handled by the
    // touchstart toggle above — ignore it so the bars don't double-toggle.
    if (Date.now() < ignoreMouseUntil) return
    // A click on a control widget (a button or the seek bar) drives that widget
    // and just keeps the bars up — it never toggles them away.
    if (tappedOnControls(e.target)) {
      scheduleControlsHide()
      return
    }
    // A click anywhere else on the video toggles the bars: show if hidden, hide
    // if showing — the desktop counterpart of the tap-to-toggle above.
    if (player.classList.contains('is-idle')) {
      scheduleControlsHide()
    } else {
      clearTimeout(idleTimer)
      hideControls()
      // Stop the trailing mouse activity from instantly bringing them back.
      ignoreMouseUntil = Date.now() + 700
    }
  })

  // Hovering either control bar keeps it open; leaving restarts the timer.
  ;[controls, topControls].forEach(function (bar) {
    if (!bar) return
    bar.addEventListener('mouseenter', function () {
      clearTimeout(idleTimer)
      showControls()
    })
    bar.addEventListener('mouseleave', scheduleControlsHide)
  })

  if (video) {
    video.addEventListener('pause', scheduleControlsHide)
    video.addEventListener('play', scheduleControlsHide)
  }

  // Hide the controls shortly after load even if the viewer never moves.
  scheduleControlsHide()

  /* ------------------------------------------------------------------------
     Push-to-talk voice — hold the mic button to broadcast your microphone to
     everyone else in the room; release it to stop. Audio is streamed in small
     encoded chunks over the existing socket and played back through the
     MediaSource API. It is fully independent of video synchronization.
     ------------------------------------------------------------------------ */

  function setupVoice() {
    if (!micBtn) return

    var hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    var hasMediaRecorder = typeof window.MediaRecorder !== 'undefined'
    var hasMediaSource = typeof window.MediaSource !== 'undefined'

    // Pick a recording format this browser can produce.
    var MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    var recordMime = ''
    if (hasMediaRecorder) {
      for (var i = 0; i < MIME_CANDIDATES.length; i++) {
        if (window.MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) {
          recordMime = MIME_CANDIDATES[i]
          break
        }
      }
    }

    if (!hasGetUserMedia || !hasMediaRecorder || !hasMediaSource || !recordMime) {
      micBtn.disabled = true
      micBtn.title = 'Voice chat is not supported by this browser'
      return
    }

    /* ---- Sending: capture and stream the local microphone --------------- */

    var micStream = null
    var recorder = null
    var micLoadingEl = null

    function showMicLoading() {
      if (micLoadingEl) return
      micLoadingEl = document.createElement('div')
      micLoadingEl.className = 'mic-loading'
      micLoadingEl.innerHTML =
        '<svg class="mic-loading-ring" viewBox="0 0 40 40"><circle class="mic-loading-track" cx="20" cy="20" r="17" fill="none" stroke-width="3"/><circle class="mic-loading-fill" cx="20" cy="20" r="17" fill="none" stroke-width="3" stroke-dasharray="106.8" stroke-dashoffset="106.8"/></svg><span class="mic-loading-count">0</span>'
      micBtn.appendChild(micLoadingEl)
      var count = 0
      var interval = setInterval(function () {
        count++
        var label = micLoadingEl && micLoadingEl.querySelector('.mic-loading-count')
        if (label) label.textContent = count
        var fill = micLoadingEl && micLoadingEl.querySelector('.mic-loading-fill')
        if (fill) {
          var dash = Math.max(0, 106.8 - (count / 60) * 106.8)
          fill.style.strokeDashoffset = String(dash)
        }
        if (count >= 60) clearInterval(interval)
      }, 100)
      micLoadingEl._interval = interval
    }

    function hideMicLoading() {
      if (micLoadingEl) {
        clearInterval(micLoadingEl._interval)
        micLoadingEl.remove()
        micLoadingEl = null
      }
    }

    function startTalking(e) {
      if (isTalking) return
      isTalking = true
      micBtn.classList.add('is-talking')
      showControls()
      showMicLoading()
      if (e && e.pointerId != null && micBtn.setPointerCapture) {
        try {
          micBtn.setPointerCapture(e.pointerId)
        } catch (err) {
          /* capture unavailable — pointerup on the button still works */
        }
      }

      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(function (stream) {
          // The button may have been released while permission was pending.
          if (!isTalking) {
            stream.getTracks().forEach(function (t) {
              t.stop()
            })
            return
          }

          micStream = stream
          recorder = new MediaRecorder(stream, { mimeType: recordMime })

          var firstChunk = true
          recorder.ondataavailable = function (ev) {
            if (firstChunk) {
              firstChunk = false
              hideMicLoading()
            }
            if (ev.data && ev.data.size > 0) socket.emit('voice_chunk', ev.data)
          }
          recorder.onstop = function () {
            socket.emit('voice_end')
            if (micStream) {
              micStream.getTracks().forEach(function (t) {
                t.stop()
              })
              micStream = null
            }
          }

          socket.emit('voice_start', { mimeType: recordMime })
          recorder.start(200) // emit an audio chunk roughly every 200ms
        })
        .catch(function () {
          // No microphone or permission denied — reset the button.
          hideMicLoading()
          isTalking = false
          micBtn.classList.remove('is-talking')
          micBtn.title = 'Microphone unavailable — check browser permissions'
          scheduleControlsHide()
        })
    }

    function stopTalking() {
      if (!isTalking) return
      isTalking = false
      micBtn.classList.remove('is-talking')
      hideMicLoading()
      scheduleControlsHide()

      if (recorder && recorder.state !== 'inactive') {
        // Fires a final `dataavailable`, then `onstop` (emits voice_end).
        recorder.stop()
      } else if (micStream) {
        // Released before the recorder started (during the permission prompt).
        micStream.getTracks().forEach(function (t) {
          t.stop()
        })
        micStream = null
      }
      recorder = null
    }

    micBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault()
      startTalking(e)
    })
    micBtn.addEventListener('pointerup', stopTalking)
    micBtn.addEventListener('pointercancel', stopTalking)
    micBtn.addEventListener('lostpointercapture', stopTalking)
    // Safety net: release the mic if the window loses focus while held.
    window.addEventListener('blur', stopTalking)

    /* ---- Receiving: play remote speakers through MediaSource ------------ */

    var voicePlayers = {} // speaker socket id -> playback pipeline

    function refreshIndicator() {
      var ids = Object.keys(voicePlayers)
      voiceIndicator.classList.toggle('is-visible', ids.length > 0)
      if (ids.length === 0) {
        if (voiceSpeakerName) voiceSpeakerName.textContent = ''
      } else if (ids.length === 1) {
        if (voiceSpeakerName) voiceSpeakerName.textContent = voicePlayers[ids[0]].name + ' speaking'
      } else if (ids.length === 2) {
        if (voiceSpeakerName) voiceSpeakerName.textContent = voicePlayers[ids[0]].name + ' + ' + voicePlayers[ids[1]].name + ' speaking'
      } else {
        if (voiceSpeakerName) voiceSpeakerName.textContent = voicePlayers[ids[0]].name + ' + ' + (ids.length - 1) + ' others speaking'
      }
    }

    function pump(id) {
      var p = voicePlayers[id]
      if (!p || !p.sourceBuffer || p.sourceBuffer.updating) return

      if (p.queue.length > 0) {
        try {
          p.sourceBuffer.appendBuffer(p.queue.shift())
        } catch (err) {
          destroyPlayer(id)
        }
        return
      }

      if (p.ended) {
        try {
          if (p.mediaSource.readyState === 'open') p.mediaSource.endOfStream()
        } catch (err) {
          /* already closed — nothing to do */
        }
      }
    }

    function destroyPlayer(id) {
      var p = voicePlayers[id]
      if (!p) return
      delete voicePlayers[id]
      try {
        p.audio.pause()
      } catch (e) {}
      try {
        if (p.mediaSource.readyState === 'open') p.mediaSource.endOfStream()
      } catch (e) {}
      try {
        URL.revokeObjectURL(p.objectUrl)
      } catch (e) {}
      refreshIndicator()
    }

    function createPlayer(id, mimeType, name) {
      destroyPlayer(id)

      var mediaSource = new MediaSource()
      var audio = new Audio()
      var objectUrl = URL.createObjectURL(mediaSource)
      audio.src = objectUrl
      audio.autoplay = true

      var p = {
        audio: audio,
        mediaSource: mediaSource,
        objectUrl: objectUrl,
        sourceBuffer: null,
        queue: [],
        ended: false,
        name: name || 'Someone',
      }
      voicePlayers[id] = p

      mediaSource.addEventListener('sourceopen', function () {
        if (voicePlayers[id] !== p) return
        var type = mimeType || 'audio/webm;codecs=opus'
        if (!window.MediaSource.isTypeSupported(type)) {
          type = 'audio/webm;codecs=opus'
        }
        try {
          var sb = mediaSource.addSourceBuffer(type)
          sb.mode = 'sequence' // play segments back-to-back, ignore timestamps
          sb.addEventListener('updateend', function () {
            pump(id)
          })
          p.sourceBuffer = sb
          pump(id)
        } catch (err) {
          destroyPlayer(id)
        }
      })

      var playAttempt = audio.play()
      if (playAttempt && playAttempt.catch) playAttempt.catch(function () {})
      refreshIndicator()
    }

    function enqueueChunk(id, data) {
      var p = voicePlayers[id]
      if (!p) return
      p.queue.push(data)
      pump(id)
    }

    socket.on('voice_start', function (data) {
      if (!data || typeof data.id !== 'string') return
      createPlayer(data.id, data.mimeType, data.name || 'Someone')
    })

    socket.on('voice_chunk', function (data) {
      if (!data || typeof data.id !== 'string' || !voicePlayers[data.id]) return
      var chunk = data.chunk
      if (chunk instanceof Blob) {
        chunk.arrayBuffer().then(function (buf) {
          enqueueChunk(data.id, buf)
        })
      } else if (chunk) {
        enqueueChunk(data.id, chunk)
      }
    })

    socket.on('voice_end', function (data) {
      if (!data || typeof data.id !== 'string') return
      var p = voicePlayers[data.id]
      if (!p) return
      p.ended = true
      pump(data.id)
      // Let the buffered tail finish playing, then tear the pipeline down.
      setTimeout(function () {
        destroyPlayer(data.id)
      }, 4000)
    })
  }

  setupVoice()

  /* ------------------------------------------------------------------------
     Synced playback speed (upload/download rooms only).
     The button cycles through a small list of rates and broadcasts the
     choice as a `control` event with action `rate`. Every other client
     receives a `rate_changed` event and applies the same speed locally.
     ------------------------------------------------------------------------ */

  var speedBtn = document.getElementById('speedBtn')
  if (speedBtn && video) {
    var RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
    speedBtn.addEventListener('click', function () {
      var idx = RATES.indexOf(currentRate)
      var next = RATES[(idx + 1) % RATES.length] || 1
      applyRate(next)
      socket.emit('control', { action: 'rate', rate: next, currentTime: video.currentTime })
    })
  }

  /* ------------------------------------------------------------------------
     Picture-in-Picture (upload/download rooms only).
     Most modern browsers support `requestPictureInPicture` on a <video>; the
     button is hidden if not. Toggling out of PiP is also supported.
     ------------------------------------------------------------------------ */

  var pipBtn = document.getElementById('pipBtn')
  if (pipBtn && video) {
    if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
      pipBtn.hidden = true
    } else {
      pipBtn.addEventListener('click', function () {
        try {
          if (document.pictureInPictureElement) {
            document.exitPictureInPicture()
          } else {
            video.requestPictureInPicture().catch(function () {})
          }
        } catch (e) {
          /* PiP unavailable in this context — silently ignore */
        }
      })
      video.addEventListener('enterpictureinpicture', function () {
        pipBtn.classList.add('is-active')
      })
      video.addEventListener('leavepictureinpicture', function () {
        pipBtn.classList.remove('is-active')
      })
    }
  }

  /* ------------------------------------------------------------------------
     Chat — synchronized real-time messaging per room.
     Server keeps a small ring buffer of recent messages and broadcasts each
     new one to every client (including the sender), so all clients render
     through the same DOM path.
     ------------------------------------------------------------------------ */

  setupChat()

  function setupChat() {
    var chatPanel = document.getElementById('chatPanel')
    var chatToggle = document.getElementById('chatToggle')
    var chatToggleBadge = document.getElementById('chatToggleBadge')
    // In-player chat toggle, shown only in fullscreen (the top-bar one is hidden there).
    var fsChatToggle = document.getElementById('fsChatToggle')
    var fsChatToggleBadge = document.getElementById('fsChatToggleBadge')
    var chatClose = document.getElementById('chatClose')
    var chatMessages = document.getElementById('chatMessages')
    var chatEmpty = document.getElementById('chatEmpty')
    var chatForm = document.getElementById('chatForm')
    var chatInput = document.getElementById('chatInput')
    var chatSend = document.getElementById('chatSend')
    var playerStage = document.getElementById('playerStage')

    if (!chatPanel || !chatForm || !chatInput || !chatMessages) return

    /** Unread message counter — only ticks while the panel is closed. */
    var unread = 0
    /** Cached open state so we don't have to query the class every time. */
    var isOpen = false

    function updateUnreadBadge() {
      var label = unread > 99 ? '99+' : String(unread)
      ;[chatToggleBadge, fsChatToggleBadge].forEach(function (badge) {
        if (!badge) return
        if (unread <= 0) {
          badge.hidden = true
          badge.textContent = '0'
        } else {
          badge.hidden = false
          badge.textContent = label
        }
      })
    }

    function openChat() {
      isOpen = true
      chatPanel.classList.add('is-open')
      if (playerStage) playerStage.classList.add('has-chat-open')
      unread = 0
      updateUnreadBadge()
      // Defer focus so a tap on the toggle doesn't blur the input immediately.
      setTimeout(function () { chatInput.focus() }, 50)
      scrollToBottom(true)
    }

    function closeChat() {
      isOpen = false
      chatPanel.classList.remove('is-open')
      if (playerStage) playerStage.classList.remove('has-chat-open')
    }

    function toggleChat() {
      if (isOpen) closeChat()
      else openChat()
    }

    if (chatToggle) chatToggle.addEventListener('click', toggleChat)
    if (fsChatToggle) fsChatToggle.addEventListener('click', toggleChat)
    if (chatClose) chatClose.addEventListener('click', closeChat)

    /**
     * Decide whether the messages list is at (or very near) the bottom. If
     * it is, a new message scrolls it down automatically; if the user has
     * scrolled up to read older messages, we leave the scroll position
     * alone and bump the unread counter instead.
     */
    function isPinnedToBottom() {
      var gap = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight
      return gap < 40
    }

    function scrollToBottom(force) {
      if (force || isPinnedToBottom()) {
        chatMessages.scrollTop = chatMessages.scrollHeight
      }
    }

    function formatTs(ts) {
      var d = new Date(ts)
      var h = d.getHours()
      var m = d.getMinutes()
      return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
    }

    /** Escape text for safe insertion as innerHTML. */
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /** Track the previous author so consecutive messages can be grouped. */
    var lastAuthorId = null

    /**
     * Floating chat overlays — a brief card pinned to the bottom-left of
     * the player showing avatar + name + text for each new message.
     */
    var flyoverHost = document.getElementById('chatFlyovers')
    /** Max overlays visible at once before the oldest fades out early. */
    var FLYOVER_MAX = 4
    /** How long each overlay stays before its fade-out begins (ms). */
    var FLYOVER_LIFETIME = 5200

    function spawnFlyover(msg, isOwn) {
      if (!flyoverHost) return

      // Cap the stack — if there are too many, dismiss the oldest first
      // so the column never pushes into the top controls bar.
      while (flyoverHost.children.length >= FLYOVER_MAX) {
        var oldest = flyoverHost.firstElementChild
        if (!oldest) break
        oldest.classList.add('is-leaving')
        oldest.addEventListener('transitionend', function handleEnd() {
          oldest.removeEventListener('transitionend', handleEnd)
          if (oldest.parentNode) oldest.parentNode.removeChild(oldest)
        })
        // Hard fallback in case the transition is interrupted.
        setTimeout(function () {
          if (oldest.parentNode) oldest.parentNode.removeChild(oldest)
        }, 400)
        break
      }

      var card = document.createElement('div')
      card.className = 'chat-flyover' + (isOwn ? ' chat-flyover--own' : '')

      var avatar = document.createElement('span')
      avatar.className = 'chat-flyover-avatar'
      avatar.textContent = (msg.name.charAt(0) || '?').toUpperCase()
      avatar.style.background = avatarColor(msg.name)
      card.appendChild(avatar)

      var body = document.createElement('div')
      body.className = 'chat-flyover-body'

      var who = document.createElement('div')
      who.className = 'chat-flyover-name'
      who.textContent = msg.name
      body.appendChild(who)

      var text = document.createElement('div')
      text.className = 'chat-flyover-text'
      // Same linkify pass as the chat panel — escape, then upgrade URLs.
      var urlRe = /\bhttps?:\/\/[^\s<]+/g
      text.innerHTML = escapeHtml(msg.text).replace(urlRe, function (u) {
        return '<a class="chat-flyover-link" href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'
      })
      body.appendChild(text)

      card.appendChild(body)
      flyoverHost.appendChild(card)

      // Trigger the slide-in transition on the next frame so the browser
      // sees the "from" state first.
      requestAnimationFrame(function () {
        card.classList.add('is-visible')
      })

      // Schedule the fade-out. After the transition finishes the node is
      // removed from the DOM so the overlay never piles up invisible.
      setTimeout(function () {
        if (!card.parentNode) return
        card.classList.add('is-leaving')
        card.classList.remove('is-visible')
        setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card)
        }, 400)
      }, FLYOVER_LIFETIME)
    }

    function renderMessage(msg) {
      if (chatEmpty) chatEmpty.hidden = true

      var ownName = (function () {
        try { return localStorage.getItem(DISPLAY_NAME_KEY) } catch (e) { return null }
      })()
      var isOwn = ownName && ownName === msg.name

      var groupKey = msg.name + '::' + (isOwn ? 'self' : 'other')
      var grouped = lastAuthorId === groupKey
      lastAuthorId = groupKey

      var row = document.createElement('div')
      row.className = 'chat-msg' + (isOwn ? ' chat-msg--own' : '') + (grouped ? ' chat-msg--grouped' : '')

      if (!grouped) {
        var avatar = document.createElement('span')
        avatar.className = 'chat-msg-avatar'
        avatar.textContent = (msg.name.charAt(0) || '?').toUpperCase()
        avatar.style.background = avatarColor(msg.name)
        row.appendChild(avatar)
      } else {
        var spacer = document.createElement('span')
        spacer.className = 'chat-msg-avatar chat-msg-avatar--spacer'
        row.appendChild(spacer)
      }

      var body = document.createElement('div')
      body.className = 'chat-msg-body'

      if (!grouped) {
        var head = document.createElement('div')
        head.className = 'chat-msg-head'
        var who = document.createElement('span')
        who.className = 'chat-msg-name'
        who.textContent = msg.name
        head.appendChild(who)
        var when = document.createElement('span')
        when.className = 'chat-msg-time'
        when.textContent = formatTs(msg.ts || Date.now())
        head.appendChild(when)
        body.appendChild(head)
      }

      var text = document.createElement('div')
      text.className = 'chat-msg-text'
      // Linkify bare http(s) URLs; everything else is escaped.
      var urlRe = /\bhttps?:\/\/[^\s<]+/g
      var safe = escapeHtml(msg.text).replace(urlRe, function (u) {
        return '<a class="chat-msg-link" href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'
      })
      text.innerHTML = safe
      body.appendChild(text)

      row.appendChild(body)
      chatMessages.appendChild(row)

      scrollToBottom(false)

      if (!isOpen && !isOwn) {
        unread += 1
        updateUnreadBadge()
      }

      // Float the message over the player too — but skip when the chat
      // panel is already on screen (the message is already visible
      // there) or when this call is part of a history replay (old
      // messages shouldn't pop up again on every reconnect).
      if (!isOpen && !suppressFlyovers) {
        spawnFlyover(msg, isOwn)
      }
    }

    /** True while replaying history so flyovers don't fire for old messages. */
    var suppressFlyovers = false

    /** Bulk renderer — used on `chat_history` after (re)joining. */
    function renderHistory(messages) {
      chatMessages.innerHTML = ''
      if (chatEmpty) {
        chatEmpty.hidden = messages.length > 0
        if (messages.length === 0) chatMessages.appendChild(chatEmpty)
      }
      lastAuthorId = null
      suppressFlyovers = true
      try {
        messages.forEach(renderMessage)
      } finally {
        suppressFlyovers = false
      }
      // History never counts as unread.
      unread = 0
      updateUnreadBadge()
      scrollToBottom(true)
    }

    socket.on('chat', renderMessage)
    socket.on('chat_history', function (data) {
      if (data && Array.isArray(data.messages)) renderHistory(data.messages)
    })
    socket.on('chat_throttled', function () {
      if (typeof showToast === 'function') {
        showToast('You’re sending messages too fast.', 'error')
      }
    })

    chatForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var text = chatInput.value.trim()
      if (!text) return
      // Send without an optimistic render — the server echoes back to us
      // through the same `chat` broadcast every other client receives.
      socket.emit('chat', { text: text })
      chatInput.value = ''
    })

    // Light input affordance: enable/disable send based on emptiness.
    function refreshSendState() {
      if (chatSend) chatSend.disabled = chatInput.value.trim().length === 0
    }
    chatInput.addEventListener('input', refreshSendState)
    refreshSendState()
  }

  /* ------------------------------------------------------------------------
     Keyboard shortcut: C toggles chat. Wired here so it sees the freshly
     created chat panel — keep the keydown handler above untouched.
     ------------------------------------------------------------------------ */

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'c' && e.key !== 'C') return
    if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return
    var chatToggle = document.getElementById('chatToggle')
    if (chatToggle) {
      e.preventDefault()
      chatToggle.click()
    }
  })

  /* ------------------------------------------------------------------------
     Mobile hamburger menu — collapses the topbar action buttons (Share,
     Edit, Delete) into a dropdown at narrow widths. The CSS hides the
     dropdown until `.is-open` is toggled on by this handler.
     ------------------------------------------------------------------------ */

  ;(function () {
    var menuToggle = document.getElementById('topbarMenuToggle')
    var menuItems = document.getElementById('topbarActions')
    if (!menuToggle || !menuItems) return

    function setOpen(open) {
      menuItems.classList.toggle('is-open', open)
      menuToggle.classList.toggle('is-open', open)
      menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    }

    menuToggle.addEventListener('click', function (e) {
      e.stopPropagation()
      setOpen(!menuItems.classList.contains('is-open'))
    })

    // Clicking any action in the menu fires its existing handler, then
    // closes the dropdown so the user is returned to a normal layout.
    menuItems.addEventListener('click', function (e) {
      if (e.target.closest('button')) {
        // Defer close so the action's own click handler runs first
        // before the dropdown collapses (and possibly unmounts a button).
        setTimeout(function () { setOpen(false) }, 0)
      }
    })

    // Dismiss when clicking elsewhere on the page or pressing Escape.
    document.addEventListener('click', function (e) {
      if (!menuItems.classList.contains('is-open')) return
      if (menuToggle.contains(e.target) || menuItems.contains(e.target)) return
      setOpen(false)
    })

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuItems.classList.contains('is-open')) {
        setOpen(false)
      }
    })
  })()
})()
