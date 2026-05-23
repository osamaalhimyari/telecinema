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

    // The video file is missing or unplayable.
    video.addEventListener('error', function () {
      videoError.classList.add('is-visible')
    })
    video.addEventListener('canplay', function () {
      videoError.classList.remove('is-visible')
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

  player.addEventListener('click', function () {
    if (isFullscreen()) scheduleControlsHide()
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
      if (!chatToggleBadge) return
      if (unread <= 0) {
        chatToggleBadge.hidden = true
        chatToggleBadge.textContent = '0'
      } else {
        chatToggleBadge.hidden = false
        chatToggleBadge.textContent = unread > 99 ? '99+' : String(unread)
      }
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
