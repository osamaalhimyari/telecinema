/* ==========================================================================
   Watch Party — create-room client
   --------------------------------------------------------------------------
   Drives the "Create room" form. A room's video can be supplied three ways:

     • Stream from outside — an embed URL rendered as an iframe. The room is
                              created instantly, no bytes change hands.
     • Download from link  — the server fetches the file itself; the form POST
                              returns a job id, which is then polled so the
                              progress bar tracks the server-side download.
     • Upload a file       — sent over XHR so the progress bar tracks bytes
                              sent.

   The visitor picks one with the type selector at the top of the form, and
   only the field that matches their choice is visible. On submit we route to
   the right server response handler (redirect for upload/external, polling
   for download).
   ========================================================================== */

;(function () {
  'use strict'

  var form = document.getElementById('createForm')
  var fileInput = document.getElementById('video')
  var videoUrlInput = document.getElementById('videoUrl')
  var externalUrlInput = document.getElementById('externalUrl')
  var dropzone = document.getElementById('dropzone')
  var dropzoneText = document.getElementById('dropzoneText')
  var submitBtn = document.getElementById('submitBtn')
  var progress = document.getElementById('uploadProgress')
  var progressBar = progress.querySelector('.upload-progress-bar')
  var progressFill = document.getElementById('uploadProgressFill')
  var progressLabel = document.getElementById('uploadProgressLabel')
  var formError = document.getElementById('formError')
  var passwordInput = document.getElementById('password')
  var passwordToggle = document.getElementById('passwordToggle')
  var typePicker = document.getElementById('typePicker')
  var typePanels = document.querySelectorAll('[data-type-panel]')
  var typeRadios = typePicker.querySelectorAll('input[name="roomType"]')

  /** How often the link-download job is polled for progress, in ms. */
  var POLL_INTERVAL = 800
  /** Consecutive failed polls tolerated before the download is given up. */
  var MAX_POLL_ERRORS = 6

  /* ------------------------------------------------------------------------
     Type picker — reveal the field that matches the chosen source
     ------------------------------------------------------------------------ */

  function currentType() {
    var checked = typePicker.querySelector('input[name="roomType"]:checked')
    return checked ? checked.value : 'external'
  }

  function applyType() {
    var type = currentType()

    // Toggle the visible panel.
    typePanels.forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-type-panel') !== type
    })

    // Highlight the active card.
    typeRadios.forEach(function (radio) {
      radio.parentElement.classList.toggle('is-active', radio.checked)
    })
  }

  typeRadios.forEach(function (radio) {
    radio.addEventListener('change', applyType)
  })

  applyType()

  /* ------------------------------------------------------------------------
     Password show / hide
     ------------------------------------------------------------------------ */

  passwordToggle.addEventListener('click', function () {
    var hidden = passwordInput.type === 'password'
    passwordInput.type = hidden ? 'text' : 'password'
    passwordToggle.textContent = hidden ? 'Hide' : 'Show'
  })

  /* ------------------------------------------------------------------------
     File picker — show the chosen file and accept drag-and-drop
     ------------------------------------------------------------------------ */

  /** Formats a byte count as a short, human-readable string. */
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    var units = ['KB', 'MB', 'GB']
    var i = -1
    do {
      bytes /= 1024
      i++
    } while (bytes >= 1024 && i < units.length - 1)
    return bytes.toFixed(1) + ' ' + units[i]
  }

  /**
   * Formats a duration in seconds into the biggest meaningful unit:
   *   42         → "42s"
   *   95         → "1m 35s"
   *   3725       → "1h 2m"
   * Anything under a second or non-finite collapses to "…".
   */
  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '…'
    seconds = Math.round(seconds)
    if (seconds < 60) return seconds + 's'
    if (seconds < 3600) {
      var m = Math.floor(seconds / 60)
      var s = seconds % 60
      return s === 0 ? m + 'm' : m + 'm ' + s + 's'
    }
    var h = Math.floor(seconds / 3600)
    var rm = Math.floor((seconds % 3600) / 60)
    return rm === 0 ? h + 'h' : h + 'h ' + rm + 'm'
  }

  function showFile(file) {
    if (!file) {
      dropzone.classList.remove('has-file')
      dropzoneText.textContent = 'Click to choose a video, or drop it here'
      return
    }
    dropzone.classList.add('has-file')
    dropzoneText.textContent = file.name + ' — ' + formatSize(file.size)
  }

  fileInput.addEventListener('change', function () {
    showFile(fileInput.files[0])
  })

  ;['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault()
      dropzone.classList.add('is-dragover')
    })
  })
  ;['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault()
      dropzone.classList.remove('is-dragover')
    })
  })
  dropzone.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files
    if (files && files.length) {
      fileInput.files = files
      showFile(files[0])
    }
  })

  /* ------------------------------------------------------------------------
     Progress bar — shared by the upload and the link-download flows
     ------------------------------------------------------------------------ */

  function showError(message) {
    formError.textContent = message
    formError.hidden = false
  }

  /**
   * Renders progress. A numeric `percent` fills the bar to that point; a null
   * `percent` (a download whose total size is unknown) switches the bar to an
   * indeterminate animation and reports the bytes received so far instead.
   *
   * `etaSeconds` (optional) is appended to the label as a "~Xm Ys left" hint,
   * making the bar much friendlier for the slow bits of a big download.
   */
  function renderProgress(percent, bytesDone, etaSeconds) {
    var head
    if (typeof percent === 'number') {
      progressBar.classList.remove('is-indeterminate')
      progressFill.style.width = percent + '%'
      head = percent + '%'
    } else {
      progressBar.classList.add('is-indeterminate')
      progressFill.style.width = ''
      head = bytesDone ? formatSize(bytesDone) : '…'
    }

    if (isFinite(etaSeconds) && etaSeconds > 0) {
      progressLabel.textContent = head + ' · ~' + formatDuration(etaSeconds) + ' left'
    } else {
      progressLabel.textContent = head
    }
  }

  /** Puts the form back into an editable state and surfaces a failure. */
  function reset(message) {
    submitBtn.disabled = false
    submitBtn.textContent = 'Create room'
    progress.hidden = true
    progressBar.classList.remove('is-indeterminate')
    progressFill.style.width = '0%'
    progressLabel.textContent = '0%'
    showError(message)
  }

  /* ------------------------------------------------------------------------
     Link flow — poll the server-side download job until it finishes
     ------------------------------------------------------------------------ */

  function pollJob(jobId) {
    submitBtn.textContent = 'Downloading…'

    var errorCount = 0

    /**
     * Track download rate so we can show an ETA. We hold a tiny sliding
     * window of recent (timestamp, bytes) samples and divide the byte
     * delta by the time delta — much steadier than the instantaneous
     * rate when the network briefly stalls between polls.
     */
    var samples = []
    var SAMPLE_WINDOW_MS = 8000

    function estimateEta(job) {
      if (!job || typeof job.bytesDownloaded !== 'number' || !job.totalBytes) return null
      if (samples.length < 2) return null
      var oldest = samples[0]
      var newest = samples[samples.length - 1]
      var dt = (newest.ts - oldest.ts) / 1000
      var db = newest.bytes - oldest.bytes
      if (dt <= 0 || db <= 0) return null
      var ratePerSec = db / dt
      var remaining = job.totalBytes - job.bytesDownloaded
      if (remaining <= 0) return 0
      return remaining / ratePerSec
    }

    function tick() {
      fetch('/rooms/download/' + encodeURIComponent(jobId), {
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          return res.json()
        })
        .then(function (job) {
          errorCount = 0

          if (job.status === 'done' && job.redirectTo) {
            renderProgress(100)
            window.location.href = job.redirectTo
            return
          }
          if (job.status === 'error') {
            reset(job.error || 'The video could not be downloaded.')
            return
          }

          // Record a sample and drop anything older than the window.
          if (typeof job.bytesDownloaded === 'number') {
            var now = Date.now()
            samples.push({ ts: now, bytes: job.bytesDownloaded })
            while (samples.length > 1 && now - samples[0].ts > SAMPLE_WINDOW_MS) {
              samples.shift()
            }
          }

          renderProgress(job.percent, job.bytesDownloaded, estimateEta(job))
          window.setTimeout(tick, POLL_INTERVAL)
        })
        .catch(function () {
          errorCount++
          if (errorCount >= MAX_POLL_ERRORS) {
            reset('Lost contact with the server while downloading.')
            return
          }
          window.setTimeout(tick, POLL_INTERVAL)
        })
    }

    tick()
  }

  /* ------------------------------------------------------------------------
     Emoji picker — click to toggle, max 8 selected, collapsed by default
     ------------------------------------------------------------------------ */

  var emojiPicker = document.getElementById('emojiPicker')
  var reactionsInput = document.getElementById('reactionsInput')
  var emojiGrid = document.getElementById('emojiGrid')
  var emojiToggle = document.getElementById('emojiToggle')
  var emojiSelected = document.getElementById('emojiSelected')

  if (emojiPicker) {
    var emojiOpts = emojiPicker.querySelectorAll('.emoji-opt')
    var selectedEmojis = ['👍', '❤️', '😂', '😮', '🎉', '🔥', '👏', '💯']

    function renderSelectedBar() {
      emojiSelected.innerHTML = ''
      selectedEmojis.forEach(function (emoji) {
        var el = document.createElement('span')
        el.className = 'emoji-selected-item'
        el.textContent = emoji
        el.addEventListener('click', function (e) {
          e.stopPropagation()
          var idx = selectedEmojis.indexOf(emoji)
          if (idx !== -1) selectedEmojis.splice(idx, 1)
          updateReactionsInput()
        })
        emojiSelected.appendChild(el)
      })
    }

    function updateReactionsInput() {
      reactionsInput.value = JSON.stringify(selectedEmojis)
      emojiOpts.forEach(function (btn) {
        btn.classList.toggle('is-selected', selectedEmojis.indexOf(btn.getAttribute('data-emoji')) !== -1)
      })
      renderSelectedBar()
    }

    emojiOpts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji')
        var idx = selectedEmojis.indexOf(emoji)
        if (idx !== -1) {
          selectedEmojis.splice(idx, 1)
        } else if (selectedEmojis.length < 8) {
          selectedEmojis.push(emoji)
        }
        updateReactionsInput()
      })
    })

    emojiToggle.addEventListener('click', function () {
      emojiGrid.classList.toggle('is-collapsed')
      emojiToggle.textContent = emojiGrid.classList.contains('is-collapsed') ? 'Show all emojis' : 'Hide all emojis'
    })

    emojiGrid.classList.add('is-collapsed')
    updateReactionsInput()
  }

  /* ------------------------------------------------------------------------
     Submit — POST the form, then either redirect or hand off to the poller
     ------------------------------------------------------------------------ */

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    formError.hidden = true

    var type = currentType()

    // Per-type presence check — the controller validates again, but failing
    // here means the visitor never sees a server round-trip for an obvious
    // typo.
    if (type === 'external') {
      if (!externalUrlInput.value.trim()) {
        showError('Please paste the embed link for the external stream.')
        return
      }
    } else if (type === 'download') {
      if (!videoUrlInput.value.trim()) {
        showError('Please paste a link to the video file.')
        return
      }
    } else if (type === 'upload') {
      if (!fileInput.files || !fileInput.files.length) {
        showError('Please choose a video file to upload.')
        return
      }
    }

    var xhr = new XMLHttpRequest()
    xhr.open('POST', form.action)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.setRequestHeader('Accept', 'application/json')

    submitBtn.disabled = true
    if (type === 'upload') {
      submitBtn.textContent = 'Uploading…'
      progress.hidden = false
      renderProgress(0)
    } else if (type === 'download') {
      submitBtn.textContent = 'Starting…'
      progress.hidden = false
      renderProgress(null, 0)
    } else {
      submitBtn.textContent = 'Creating…'
      // External rooms appear instantly; no progress bar needed.
    }

    // Meaningful only when an actual file is travelling over the wire.
    // Same windowed rate-tracker pattern as the download poll, so the
    // user sees a steady ETA on big uploads instead of just a bar.
    var uploadSamples = []
    var UPLOAD_SAMPLE_WINDOW_MS = 8000
    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable || type !== 'upload') return
      var pct = Math.round((evt.loaded / evt.total) * 100)

      var now = Date.now()
      uploadSamples.push({ ts: now, bytes: evt.loaded })
      while (uploadSamples.length > 1 && now - uploadSamples[0].ts > UPLOAD_SAMPLE_WINDOW_MS) {
        uploadSamples.shift()
      }

      var eta = null
      if (uploadSamples.length >= 2 && evt.loaded < evt.total) {
        var oldest = uploadSamples[0]
        var newest = uploadSamples[uploadSamples.length - 1]
        var dt = (newest.ts - oldest.ts) / 1000
        var db = newest.bytes - oldest.bytes
        if (dt > 0 && db > 0) {
          eta = (evt.total - evt.loaded) / (db / dt)
        }
      }

      renderProgress(pct, evt.loaded, eta)
      if (pct >= 100) progressLabel.textContent = 'Processing…'
    })

    xhr.addEventListener('load', function () {
      var body = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch (err) {
        /* non-JSON response (e.g. an HTML error page) */
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        // Upload + external — the room already exists, go straight to it.
        if (body.redirectTo) {
          window.location.href = body.redirectTo
          return
        }
        // Download flow — the room appears only once the download completes.
        if (body.jobId) {
          pollJob(body.jobId)
          return
        }
      }

      var message =
        body.error ||
        body.message ||
        (body.errors && body.errors[0] && body.errors[0].message) ||
        (xhr.status === 413
          ? 'That video file is too large to upload.'
          : 'Request failed (HTTP ' + (xhr.status || '?') + '). Please try again.')
      reset(message)
    })

    xhr.addEventListener('error', function () {
      reset('The request failed — the file may be too large, or check your connection.')
    })

    xhr.send(new FormData(form))
  })
})()
