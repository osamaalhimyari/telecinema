;var socketSearch = (function () {
  'use strict'

  var socket = io()
  var cards = Array.from(document.querySelectorAll('.room-card'))

  /* ------------------------------------------------------------------------
     Live viewer counts
     ------------------------------------------------------------------------ */

  function setCount(slug, count) {
    var badge = document.querySelector('.viewer-badge[data-slug="' + slug + '"]')
    if (!badge) return
    var label = badge.querySelector('.viewer-count')
    if (label) label.textContent = count
    var live = document.querySelector('.room-card-live[data-slug="' + slug + '"]')
    if (live) {
      if (count > 0) {
        live.textContent = 'LIVE'
        live.classList.add('is-live')
      } else {
        live.textContent = ''
        live.classList.remove('is-live')
      }
    }
  }

  socket.on('connect', function () {
    socket.emit('join_home')
  })

  socket.on('viewer_counts', function (data) {
    if (!data || !data.counts) return
    Object.keys(data.counts).forEach(function (slug) {
      setCount(slug, data.counts[slug])
    })
  })

  socket.on('viewer_count', function (data) {
    if (data && data.slug) setCount(data.slug, data.count)
  })

  /* ------------------------------------------------------------------------
     Search — filter cards in real time
     ------------------------------------------------------------------------ */

  var searchInput = document.getElementById('homeSearch')
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim().toLowerCase()
      cards.forEach(function (card) {
        var name = (card.getAttribute('data-room-name') || '').toLowerCase()
        var match = !q || name.indexOf(q) !== -1
        card.hidden = !match
      })
    })
  }

  /* ------------------------------------------------------------------------
     Sort — newest / name / active (by viewer count)
     ------------------------------------------------------------------------ */

  var sortBtns = document.querySelectorAll('.sort-btn')
  var grid = document.querySelector('.room-grid')
  if (sortBtns.length && grid) {
    sortBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        sortBtns.forEach(function (b) { b.classList.remove('is-active') })
        btn.classList.add('is-active')
        var sort = btn.getAttribute('data-sort')
        cards.sort(function (a, b) {
          if (sort === 'name') {
            var na = (a.getAttribute('data-room-name') || '').toLowerCase()
            var nb = (b.getAttribute('data-room-name') || '').toLowerCase()
            return na < nb ? -1 : na > nb ? 1 : 0
          }
          if (sort === 'active') {
            var ca = parseInt(a.querySelector('.viewer-count').textContent, 10) || 0
            var cb = parseInt(b.querySelector('.viewer-count').textContent, 10) || 0
            return cb - ca
          }
          /* newest */
          var ta = parseInt(a.getAttribute('data-room-created'), 10) || 0
          var tb = parseInt(b.getAttribute('data-room-created'), 10) || 0
          return tb - ta
        })
        cards.forEach(function (c) { grid.appendChild(c) })
      })
    })
  }
})()
