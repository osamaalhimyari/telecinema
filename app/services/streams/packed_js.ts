/*
|--------------------------------------------------------------------------
| Packed-JS unpacker
|--------------------------------------------------------------------------
|
| Ported verbatim from the Flutter client's `packed_js.dart`. Reverses Dean
| Edwards' `eval(function(p,a,c,k,e,d){…}('payload',base,count,'word|word|…'.split('|')…))`
| packing that file-host embed pages use to hide their real `.mp4`/`.m3u8` url,
| so the resolver can then regex the media url out of the expanded source. Pure
| string work; no JS engine.
*/

const BLOCK =
  /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/

/** Returns the expanded source, or null when `src` contains no packed block. */
export function unpackPackedJs(src: string): string | null {
  const m = BLOCK.exec(src)
  if (!m) return null

  let payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  const radix = Number.parseInt(m[2], 10) || 0
  const count = Number.parseInt(m[3], 10) || 0
  if (radix === 0) return null
  const words = m[4].split('|')

  let c = count
  while (c-- > 0) {
    if (c < words.length && words[c].length > 0) {
      const token = encode(c, radix)
      const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g')
      const replacement = words[c]
      // Function replacement so `$`/`\` in the dictionary word stay literal.
      payload = payload.replace(re, () => replacement)
    }
  }
  return payload
}

/**
 * Number → base-`radix` token, matching the packer's own `e()` encoder
 * (0-9, a-z, then A-Z for digits above 35).
 */
function encode(c: number, radix: number): string {
  const prefix = c < radix ? '' : encode(Math.floor(c / radix), radix)
  const rem = c % radix
  const suffix = rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36)
  return prefix + suffix
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
