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
  var rotateBtn = document.getElementById('rotate')
  var fullscreenBtn = document.getElementById('fullscreen')
  var micBtn = document.getElementById('micBtn')
  var voiceIndicator = document.getElementById('voiceIndicator')
  var player = document.getElementById('player')
  var playerRotor = document.getElementById('playerRotor')
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

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0
    var m = Math.floor(seconds / 60)
    var s = Math.floor(seconds % 60)
    return m + ':' + (s < 10 ? '0' : '') + s
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

  function applySync(state) {
    isSyncing = true

    var target = Number(state.currentTime) || 0

    /**
     * When the room is playing, compensate for the network latency between
     * the server stamping the event and us receiving it.
     */
    if (state.isPlaying && state.serverTime) {
      target += (Date.now() - state.serverTime) / 1000
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
        // Unmuted autoplay is blocked until the user interacts: show the gate.
        playPromise.catch(showGate)
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

  socket.on('connect', function () {
    socket.emit('join_room', { roomSlug: slug })
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
        emitControl('play', video.currentTime)
      } else {
        video.pause()
        emitControl('pause', video.currentTime)
      }
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
     * The seek bar fires "input" only on real user interaction — programmatic
     * `seek.value` updates from the poll loop below do not trigger it.
     */
    seek.addEventListener('input', function () {
      if (isSyncing) return
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

      // Don't fight the user while they are dragging the slider.
      if (duration > 0 && document.activeElement !== seek) {
        seek.value = String(current)
      }

      curTime.textContent = formatTime(current)
      durTime.textContent = formatTime(duration)
    }, 250)

    /* ----------------------------------------------------------------------
       Video element lifecycle
       ---------------------------------------------------------------------- */

    video.addEventListener('loadedmetadata', function () {
      seek.max = String(video.duration || 0)
      durTime.textContent = formatTime(video.duration)
    })

    // Keep the play/pause button glyph in sync (UI only — never emits).
    video.addEventListener('play', function () {
      playPause.textContent = '❚❚'
    })
    video.addEventListener('pause', function () {
      playPause.textContent = '▶'
    })

    // The video file is missing or unplayable.
    video.addEventListener('error', function () {
      videoError.classList.add('is-visible')
    })

    /* ----------------------------------------------------------------------
       Autoplay gate — clicking it counts as a user gesture, after which we
       re-request a fresh sync so playback resumes exactly in step.
       ---------------------------------------------------------------------- */

    playGate.addEventListener('click', function () {
      hideGate()
      var playPromise = video.play()
      if (playPromise && playPromise.catch) playPromise.catch(function () {})
      // Re-join to pull the current master state (the server will not
      // double-count this socket).
      socket.emit('join_room', { roomSlug: slug })
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

    /* ----------------------------------------------------------------------
       Subtitles — upload an SRT/VTT and render an overlay on top of the
       iframe, driven by the virtual playhead. The overlay is rendered by
       us because cross-origin embeds cannot host a `<track>` of ours.
       ---------------------------------------------------------------------- */

    var subtitleBtn = document.getElementById('subtitleBtn')
    var subtitleModal = document.getElementById('subtitleModal')
    var subtitleFile = document.getElementById('subtitleFile')
    var subtitleOffsetInput = document.getElementById('subtitleOffset')
    var confirmSubtitle = document.getElementById('confirmSubtitle')
    var cancelSubtitle = document.getElementById('cancelSubtitle')
    var subtitleModalError = document.getElementById('subtitleModalError')
    var subtitleText = document.getElementById('subtitleText')

    /** Parsed cue list, sorted by start time. */
    var subtitleCues = []
    /** Per-viewer offset in seconds; persisted to localStorage by room slug. */
    var subtitleOffset = 0
    /** Last rendered cue index — caches the binary-search starting point. */
    var lastCueIndex = -1

    var OFFSET_KEY = 'wp_sub_offset_' + slug
    try {
      var savedOffset = parseFloat(localStorage.getItem(OFFSET_KEY) || '0')
      if (isFinite(savedOffset)) subtitleOffset = savedOffset
      if (subtitleOffsetInput) subtitleOffsetInput.value = String(subtitleOffset)
    } catch (e) {
      /* localStorage unavailable — keep offset at 0 */
    }

    /**
     * Parses an SRT or WebVTT string into a sorted `{start, end, text}` cue
     * list. Tolerant of either separator (`,` for SRT, `.` for VTT) and of
     * stray cue numbers / VTT headers between cues.
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
        subtitleText.textContent = ''
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
          subtitleText.textContent = ''
        })
    }

    /**
     * Picks the cue at the given time. Linear scan with a "remember the
     * last hit" optimization — subtitle files almost always step forward,
     * so we usually find the next cue within one or two iterations.
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
      if (subtitleCues.length === 0) {
        if (subtitleText.textContent !== '') subtitleText.textContent = ''
        return
      }
      var cue = findCue(vplay.currentTime + subtitleOffset)
      var next = cue ? cue.text : ''
      if (subtitleText.textContent !== next) subtitleText.textContent = next
    }

    // A dedicated render loop — the playback tick only runs while playing,
    // but subtitles need to refresh on offset/seek changes even while paused.
    setInterval(renderSubtitle, 150)

    /* ---- Modal wiring + upload form ----------------------------------- */

    function openSubtitleModal() {
      subtitleModalError.hidden = true
      subtitleFile.value = ''
      subtitleOffsetInput.value = String(subtitleOffset)
      subtitleModal.classList.add('is-open')
      subtitleModal.setAttribute('aria-hidden', 'false')
    }

    function closeSubtitleModal() {
      subtitleModal.classList.remove('is-open')
      subtitleModal.setAttribute('aria-hidden', 'true')
    }

    if (subtitleBtn) {
      subtitleBtn.addEventListener('click', openSubtitleModal)
      cancelSubtitle.addEventListener('click', closeSubtitleModal)
      subtitleModal.addEventListener('click', function (e) {
        if (e.target === subtitleModal) closeSubtitleModal()
      })

      subtitleOffsetInput.addEventListener('input', function () {
        var v = parseFloat(subtitleOffsetInput.value)
        if (!isFinite(v)) v = 0
        subtitleOffset = v
        try {
          localStorage.setItem(OFFSET_KEY, String(v))
        } catch (e) {
          /* ignore */
        }
        // Force a re-evaluation against the new offset on the next tick.
        lastCueIndex = -1
      })

      confirmSubtitle.addEventListener('click', function () {
        var file = subtitleFile.files && subtitleFile.files[0]
        if (!file) {
          subtitleModalError.textContent = 'Choose an .srt or .vtt file first.'
          subtitleModalError.hidden = false
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
          confirmSubtitle.textContent = 'Upload'
          var body = {}
          try {
            body = JSON.parse(xhr.responseText)
          } catch (e) {}

          if (xhr.status >= 200 && xhr.status < 300 && body.filename) {
            // The server already broadcast `subtitle_changed`, which our
            // socket handler picks up — no need to load it here ourselves.
            closeSubtitleModal()
          } else {
            subtitleModalError.textContent =
              body.error || 'Upload failed (HTTP ' + xhr.status + ').'
            subtitleModalError.hidden = false
          }
        })
        xhr.addEventListener('error', function () {
          confirmSubtitle.disabled = false
          confirmSubtitle.textContent = 'Upload'
          subtitleModalError.textContent = 'The upload failed — check your connection.'
          subtitleModalError.hidden = false
        })
        xhr.send(form)
      })
    }

    /** Broadcast: a new subtitle was uploaded. Each client refetches it. */
    socket.on('subtitle_changed', function (payload) {
      var filename = payload && typeof payload.filename === 'string' ? payload.filename : null
      setSubtitleSource(filename)
    })

    /**
     * The template loads the iframe with the raw embed URL so a slow first
     * sync still shows *something*. As soon as a sync arrives, the iframe
     * is brought in line with the room's master state. We also kick off a
     * subtitle load here if the room already has one persisted, and a
     * provider setup so YouTube/Vimeo embeds attach their SDK immediately.
     */
    iframeApplied.isPlaying = true
    iframeApplied.currentTime = 0
    pausedOverlay.classList.remove('is-visible')
    updateExternalUI()
    setupProvider()

    if (window.ROOM_SUBTITLE) setSubtitleSource(window.ROOM_SUBTITLE)
  }

  /* ------------------------------------------------------------------------
     Rotation — the rotate button toggles the whole player (the video AND
     both control bars) between horizontal and vertical. It is a single 90°
     turn, on or off: no partial flips. The rotor element is sized so the
     turned result fits the available space exactly.
     ------------------------------------------------------------------------ */

  var rotated = false

  function applyRotation() {
    rotateBtn.classList.toggle('is-active', rotated)

    // Horizontal — clear every rotation style and keep the natural layout.
    if (!rotated) {
      player.classList.remove('is-rotated')
      player.style.width = ''
      player.style.height = ''
      playerRotor.style.width = ''
      playerRotor.style.height = ''
      playerRotor.style.transform = ''
      return
    }

    player.classList.add('is-rotated')

    /**
     * External rooms have no `<video>` to read pixel dimensions from, so the
     * rotor is given the player's own dimensions (swapped). That is enough
     * for an iframe, whose aspect ratio is controlled by the embedded page.
     */
    var vw = video ? video.videoWidth : player.clientWidth
    var vh = video ? video.videoHeight : player.clientHeight
    if (!vw || !vh) {
      // Metadata not ready yet — turn now, size correctly once it loads.
      playerRotor.style.transform = 'rotate(90deg)'
      return
    }

    // Space available to the rotated player.
    var pad = 32
    var fs = isFullscreen()
    var topbar = document.querySelector('.room-topbar')
    var availW = window.innerWidth - (fs ? 0 : pad)
    var availH = fs
      ? window.innerHeight
      : window.innerHeight - (topbar ? topbar.offsetHeight : 56) - pad

    // The turned video is portrait — fit a (vh : vw) box into that space.
    var portrait = vh / vw
    var visualW = availW
    var visualH = visualW / portrait
    if (visualH > availH) {
      visualH = availH
      visualW = visualH * portrait
    }

    // Non-fullscreen: size the player to the turned result so the stage can
    // center it. Fullscreen: the player already fills the screen, so only
    // the rotor is sized and the player centers it.
    if (fs) {
      player.style.width = ''
      player.style.height = ''
    } else {
      player.style.width = visualW + 'px'
      player.style.height = visualH + 'px'
    }

    // The rotor's un-turned box; a 90° turn lands it on visualW x visualH.
    playerRotor.style.width = visualH + 'px'
    playerRotor.style.height = visualW + 'px'
    playerRotor.style.transform = 'rotate(90deg)'
  }

  rotateBtn.addEventListener('click', function () {
    rotated = !rotated
    applyRotation()
  })

  // Re-fit a rotated player when metadata arrives or the window resizes.
  if (video) video.addEventListener('loadedmetadata', applyRotation)
  window.addEventListener('resize', applyRotation)

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

  function onFullscreenChange() {
    var fs = isFullscreen()
    fullscreenBtn.classList.toggle('is-active', fs)
    // Drive fullscreen layout from a class — more reliable than :fullscreen.
    player.classList.toggle('is-fullscreen', fs)
    // A rotated video must be re-fitted to the new viewport dimensions.
    applyRotation()
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
    clearTimeout(idleTimer)
    hideControls()
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

    function startTalking(e) {
      if (isTalking) return
      isTalking = true
      micBtn.classList.add('is-talking')
      showControls()
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

          recorder.ondataavailable = function (ev) {
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
      var active = Object.keys(voicePlayers).length > 0
      voiceIndicator.classList.toggle('is-visible', active)
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

    function createPlayer(id, mimeType) {
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
      createPlayer(data.id, data.mimeType)
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
})()
