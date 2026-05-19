/* ==========================================================================
   Watch Party — create-room client
   --------------------------------------------------------------------------
   Drives the "Create room" form: a styled file picker with drag-and-drop, a
   password show/hide toggle, and an XHR upload that reports live progress
   (a plain form submit gives no feedback while a large video uploads).
   ========================================================================== */

;(function () {
  'use strict'

  var form = document.getElementById('createForm')
  var fileInput = document.getElementById('video')
  var dropzone = document.getElementById('dropzone')
  var dropzoneText = document.getElementById('dropzoneText')
  var submitBtn = document.getElementById('submitBtn')
  var progress = document.getElementById('uploadProgress')
  var progressFill = document.getElementById('uploadProgressFill')
  var progressLabel = document.getElementById('uploadProgressLabel')
  var formError = document.getElementById('formError')
  var passwordInput = document.getElementById('password')
  var passwordToggle = document.getElementById('passwordToggle')

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
     Submit — upload over XHR so the progress bar can track the bytes sent
     ------------------------------------------------------------------------ */

  function showError(message) {
    formError.textContent = message
    formError.hidden = false
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    formError.hidden = true

    if (!fileInput.files || !fileInput.files.length) {
      showError('Please choose a video file to upload.')
      return
    }

    var xhr = new XMLHttpRequest()
    xhr.open('POST', form.action)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
    xhr.setRequestHeader('Accept', 'application/json')

    submitBtn.disabled = true
    submitBtn.textContent = 'Uploading…'
    progress.hidden = false

    /** Restores the form to an editable state and surfaces an error. */
    function reset(message) {
      submitBtn.disabled = false
      submitBtn.textContent = 'Create room'
      progress.hidden = true
      progressFill.style.width = '0%'
      progressLabel.textContent = '0%'
      showError(message)
    }

    xhr.upload.addEventListener('progress', function (evt) {
      if (!evt.lengthComputable) return
      var pct = Math.round((evt.loaded / evt.total) * 100)
      progressFill.style.width = pct + '%'
      progressLabel.textContent = pct >= 100 ? 'Processing…' : pct + '%'
    })

    xhr.addEventListener('load', function () {
      var body = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch (err) {
        /* non-JSON response (e.g. an HTML error page) */
      }

      if (xhr.status >= 200 && xhr.status < 300 && body.redirectTo) {
        window.location.href = body.redirectTo
        return
      }

      // Surface the most specific message the server gave us; otherwise
      // explain the failure from the HTTP status so it is never a mystery.
      var message =
        body.error ||
        body.message ||
        (body.errors && body.errors[0] && body.errors[0].message) ||
        (xhr.status === 413
          ? 'That video file is too large to upload.'
          : 'Upload failed (HTTP ' + (xhr.status || '?') + '). Please try again.')
      reset(message)
    })

    xhr.addEventListener('error', function () {
      reset('The upload failed — the file may be too large, or check your connection.')
    })

    xhr.send(new FormData(form))
  })
})()
