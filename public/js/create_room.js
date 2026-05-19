/* ==========================================================================
   Watch Party — create-room client
   --------------------------------------------------------------------------
   Drives the "Create room" form. A room's video can be supplied two ways:

     • Upload a file   — sent over XHR so the progress bar tracks bytes sent.
     • Paste a link    — the server downloads the file itself; the form POST
                          returns a job id, which is then polled so the same
                          progress bar tracks the server-side download.

   Either way the room only appears once the video is fully in place, so the
   visitor just watches the bar until it redirects them in.
   ========================================================================== */

;(function () {
  'use strict'

  var form = document.getElementById('createForm')
  var fileInput = document.getElementById('video')
  var videoUrlInput = document.getElementById('videoUrl')
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

  /** How often the link-download job is polled for progress, in ms. */
  var POLL_INTERVAL = 800
  /** Consecutive failed polls tolerated before the download is given up. */
  var MAX_POLL_ERRORS = 6

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

  function showFile(file) {
    if (!file) {
      dropzone.classList.remove('has-file')
      dropzoneText.textContent = 'Click to choose a video, or drop it here'
      return
    }
    dropzone.classList.add('has-file')
    dropzoneText.textContent = file.name + ' — ' + formatSize(file.size)
  }

  /**
   * A room takes its video from exactly one source. Choosing a file clears a
   * pasted link, and vice versa, so the visitor is never left guessing which
   * one will be used (the server prefers the file if both somehow arrive).
   */
  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0]
    showFile(file)
    if (file) videoUrlInput.value = ''
  })

  videoUrlInput.addEventListener('input', function () {
    if (videoUrlInput.value.trim() && fileInput.files && fileInput.files.length) {
      fileInput.value = ''
      showFile(null)
    }
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
      videoUrlInput.value = ''
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
   */
  function renderProgress(percent, bytesDone) {
    if (typeof percent === 'number') {
      progressBar.classList.remove('is-indeterminate')
      progressFill.style.width = percent + '%'
      progressLabel.textContent = percent + '%'
    } else {
      // Clear the inline width so the CSS animation owns the bar.
      progressBar.classList.add('is-indeterminate')
      progressFill.style.width = ''
      progressLabel.textContent = bytesDone ? formatSize(bytesDone) : '…'
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

          renderProgress(job.percent, job.bytesDownloaded)
          window.setTimeout(tick, POLL_INTERVAL)
        })
        .catch(function () {
          // A blip is tolerated; a sustained outage ends the download.
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
     Submit — POST the form, then either redirect or hand off to the poller
     ------------------------------------------------------------------------ */

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    formError.hidden = true

    var hasFile = fileInput.files && fileInput.files.length
    var hasUrl = videoUrlInput.value.trim().length > 0

    if (!hasFile && !hasUrl) {
      showError('Please paste a video link or choose a video file to upload.')
      return
    }

    var xhr = new XMLHttpRequest()
    xhr.open('POST', form.action)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.setRequestHeader('Accept', 'application/json')

    submitBtn.disabled = true
    submitBtn.textContent = hasFile ? 'Uploading…' : 'Starting…'
    progress.hidden = false
    renderProgress(hasFile ? 0 : null, 0)

    // Meaningful while a file uploads; for a link the body is tiny, so this
    // simply jumps to 100% before the poller takes the bar over.
    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable || !hasFile) return
      var pct = Math.round((evt.loaded / evt.total) * 100)
      renderProgress(pct)
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
        // Upload flow — the room already exists, go straight to it.
        if (body.redirectTo) {
          window.location.href = body.redirectTo
          return
        }
        // Link flow — the room appears only once the download completes.
        if (body.jobId) {
          pollJob(body.jobId)
          return
        }
      }

      // Surface the most specific message the server gave us; otherwise
      // explain the failure from the HTTP status so it is never a mystery.
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
