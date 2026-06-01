/**
 * guard.js — "closed application" hardening for the watch-party web client.
 *
 * Makes the page feel like a kiosk / native app rather than an inspectable web
 * page: blocks the right-click menu, text selection + copy/cut, image & video
 * dragging, and the common DevTools / view-source / save keyboard shortcuts.
 *
 * IMPORTANT: this is a DETERRENT, not real security. A determined visitor can
 * still disable JavaScript, open DevTools from the browser's menu bar, read the
 * page via a `view-source:` URL, or proxy the traffic. Anything that must stay
 * private (stream bytes, secrets) has to be enforced on the server — this file
 * only stops casual poking.
 *
 * Form fields (input / textarea / contenteditable) are intentionally exempt so
 * the join name, password, chat box and search keep working normally.
 */
(function () {
  'use strict'

  // Treat the element (or any ancestor) as "editable" — we leave these alone so
  // typing, selecting and copying inside form fields keeps working.
  function isEditable(el) {
    while (el && el !== document) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        return true
      }
      el = el.parentNode
    }
    return false
  }

  // 1. Kill the right-click / long-press context menu everywhere except inside
  //    form fields. Capture phase so we win before any other handler, which
  //    also suppresses the mobile long-press copy/paste callout on Android.
  document.addEventListener('contextmenu', function (e) {
    if (!isEditable(e.target)) e.preventDefault()
  }, true)

  // 2. Block copy / cut / text selection / drag outside form fields.
  ;['copy', 'cut', 'selectstart', 'dragstart'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (!isEditable(e.target)) e.preventDefault()
    }, true)
  })

  // 3. Swallow the DevTools / view-source / save keyboard shortcuts.
  document.addEventListener('keydown', function (e) {
    var key = (e.key || '').toLowerCase()

    // F12 — opens DevTools directly.
    if (e.key === 'F12') { e.preventDefault(); return }

    // Ctrl/Cmd + Shift + I / J / C — inspector, console, element picker.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
      e.preventDefault(); return
    }

    // Ctrl/Cmd + U — view source ;  Ctrl/Cmd + S — save page.
    if ((e.ctrlKey || e.metaKey) && (key === 'u' || key === 's')) {
      e.preventDefault()
    }
  })

  // 4. CSS: disable selection + native drag globally, re-enabled in form fields.
  var style = document.createElement('style')
  style.textContent =
    '*{-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;' +
    '-webkit-touch-callout:none;}' +
    'input,textarea,[contenteditable="true"]{-webkit-user-select:text;-moz-user-select:text;' +
    '-ms-user-select:text;user-select:text;}' +
    'img,video{-webkit-user-drag:none;user-drag:none;}'
  ;(document.head || document.documentElement).appendChild(style)
})()
