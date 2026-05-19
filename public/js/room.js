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

  video.controls = false
  video.volume = 1.0
  video.muted = false

  video.addEventListener('volumechange', function () {
    if (video.volume !== 1.0 || video.muted) {
      video.volume = 1.0
      video.muted = false
    }
  })

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
    applySync(state)
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
  function seekTo(time) {
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

  /* ------------------------------------------------------------------------
     UI poll — drive the seek bar from video.currentTime every 250ms.
     This intentionally avoids the video's own "timeupdate" event and never
     emits anything.
     ------------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------------
     Video element lifecycle
     ------------------------------------------------------------------------ */

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

  /* ------------------------------------------------------------------------
     Autoplay gate — clicking it counts as a user gesture, after which we
     re-request a fresh sync so playback resumes exactly in step.
     ------------------------------------------------------------------------ */

  playGate.addEventListener('click', function () {
    hideGate()
    var playPromise = video.play()
    if (playPromise && playPromise.catch) playPromise.catch(function () {})
    // Re-join to pull the current master state (the server will not
    // double-count this socket).
    socket.emit('join_room', { roomSlug: slug })
  })

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

    // Source pixel dimensions give a layout-independent aspect ratio.
    var vw = video.videoWidth
    var vh = video.videoHeight
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
  video.addEventListener('loadedmetadata', applyRotation)
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
    // Hide on inactivity regardless of play state; never while talking.
    if (!isTalking) player.classList.add('is-idle')
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

  video.addEventListener('pause', scheduleControlsHide)
  video.addEventListener('play', scheduleControlsHide)

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
