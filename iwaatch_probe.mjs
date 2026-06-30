/*
 * One-off probe for the iwaatch scraper — RUN IT ON A MACHINE THAT CAN REACH
 * iwaatch.com (the server, or your laptop with the VPN on):
 *
 *     node iwaatch_probe.mjs "back-in-action-2025"
 *     node iwaatch_probe.mjs "Back in Action 2025"
 *
 * It mirrors app/services/iwaatch/iwaatch_scraper.ts and prints any direct
 * media links it finds. If it finds NONE, it dumps diagnostics (whether the
 * stream URL is embedded in the page or loaded via a separate /api call) so we
 * can finalize the extractor. Safe to delete afterwards.
 */
const BASE = 'https://iwaatch.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const slugify = (s) =>
  s.trim().toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const unescapeUrls = (s) =>
  s.replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/')

async function get(url, referer) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } })
    return { status: res.status, finalUrl: res.url, type: res.headers.get('content-type') || '', body: await res.text() }
  } catch (e) {
    return { status: 0, finalUrl: url, type: '', body: '', error: String(e) }
  }
}

function mediaUrls(html) {
  const text = unescapeUrls(html)
  const out = new Set()
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+\.m3u8(?:\?[^\s"'`<>\\)]*)?/gi)) out.add(m[0])
  for (const m of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+\.mp4(?:\?[^\s"'`<>\\)]*)?/gi)) out.add(m[0])
  return [...out]
}

const arg = process.argv.slice(2).join(' ') || 'back-in-action-2025'
const slug = slugify(arg)
console.log(`\n=== probing slug: ${slug} ===\n`)

for (const path of [`/view/${slug}`, `/movie/${slug}`]) {
  const url = BASE + path
  const r = await get(url, BASE + '/')
  console.log(`${path} -> HTTP ${r.status} (${r.type})${r.error ? '  ERROR: ' + r.error : ''}`)
  if (r.status !== 200) continue
  const media = mediaUrls(r.body)
  if (media.length) {
    console.log('  MEDIA FOUND:')
    media.forEach((u) => console.log('   - ' + u))
  } else {
    const hasNextData = /id="__NEXT_DATA__"/.test(r.body)
    const apiPaths = [...new Set([...unescapeUrls(r.body).matchAll(/["'`](\/api\/[^"'`\s]+)/g)].map((m) => m[1]))]
    const iframe = r.body.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || null
    const viewLink = r.body.match(/\/view\/[a-z0-9-]+/i)?.[0] || null
    console.log('  NO MEDIA URL EMBEDDED.')
    console.log('   __NEXT_DATA__ present:', hasNextData)
    console.log('   /api/ paths seen   :', apiPaths.length ? apiPaths : '(none)')
    console.log('   iframe src         :', iframe || '(none)')
    console.log('   /view link on page :', viewLink || '(none)')
  }
  console.log()
}

console.log('If everything says NO MEDIA URL EMBEDDED, copy the .mp4/.m3u8 URL')
console.log('from the browser DevTools → Network tab on a /view page and send it over.')
