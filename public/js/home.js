/* ==========================================================================
   Watch Party — home client
   --------------------------------------------------------------------------
   Subscribes to live viewer counts so every room card shows, in real time,
   how many people are currently watching it.
   ========================================================================== */

;(function () {
  'use strict'

  var socket = io()

  /** Update the viewer count rendered on a single room card. */
  function setCount(slug, count) {
    var badge = document.querySelector('.viewer-badge[data-slug="' + slug + '"]')
    if (!badge) return
    var label = badge.querySelector('.viewer-count')
    if (label) label.textContent = count
  }

  socket.on('connect', function () {
    socket.emit('join_home')
  })

  // Initial snapshot of every room's viewer count.
  socket.on('viewer_counts', function (data) {
    if (!data || !data.counts) return
    Object.keys(data.counts).forEach(function (slug) {
      setCount(slug, data.counts[slug])
    })
  })

  // Live updates as people join and leave rooms.
  socket.on('viewer_count', function (data) {
    if (data && data.slug) setCount(data.slug, data.count)
  })
})()
