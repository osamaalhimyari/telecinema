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
   */
  function renderProgress(percent, bytesDone) {
    if (typeof percent === 'number') {
      progressBar.classList.remove('is-indeterminate')
      progressFill.style.width = percent + '%'
      progressLabel.textContent = percent + '%'
    } else {
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
     Emoji picker — click to toggle, max 6 selected
     ------------------------------------------------------------------------ */

  var emojiPicker = document.getElementById('emojiPicker')
  var reactionsInput = document.getElementById('reactionsInput')

  if (emojiPicker) {
    var emojiOpts = emojiPicker.querySelectorAll('.emoji-opt')
    var selectedEmojis = ['👍', '❤️', '😂', '😮', '🎉', '🔥']

    function updateReactionsInput() {
      reactionsInput.value = JSON.stringify(selectedEmojis)
      emojiOpts.forEach(function (btn) {
        btn.classList.toggle('is-selected', selectedEmojis.indexOf(btn.getAttribute('data-emoji')) !== -1)
      })
    }

    emojiOpts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var emoji = btn.getAttribute('data-emoji')
        var idx = selectedEmojis.indexOf(emoji)
        if (idx !== -1) {
          selectedEmojis.splice(idx, 1)
        } else if (selectedEmojis.length < 6) {
          selectedEmojis.push(emoji)
        }
        updateReactionsInput()
      })
    })

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
    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable || type !== 'upload') return
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
