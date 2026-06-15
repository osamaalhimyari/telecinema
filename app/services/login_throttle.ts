/**
 * Tiny in-memory brute-force throttle for the admin login.
 *
 * Keyed by client IP: after {@link MAX_ATTEMPTS} failed sign-ins inside
 * {@link WINDOW_MS}, that IP is locked out for {@link LOCK_MS}. A successful
 * login clears the counter. State is per-process and resets on restart — which
 * is fine for a single-node admin dashboard (a restart simply lifts any lock).
 *
 * Self-contained on purpose: no extra package, no DB table, no config. If the
 * dashboard ever runs multi-process, swap this for `@adonisjs/limiter`.
 */

interface Attempt {
  count: number
  /** Wall-clock ms of the first failure in the current window. */
  firstAt: number
  /** Wall-clock ms until which this key is locked (0 = not locked). */
  lockedUntil: number
}

/** Failures allowed inside the window before a lockout kicks in. */
const MAX_ATTEMPTS = 5
/** Rolling window in which failures accumulate. */
const WINDOW_MS = 15 * 60 * 1000
/** How long a key stays locked once it trips the limit. */
const LOCK_MS = 15 * 60 * 1000
/** Prune the map when it grows past this many keys (keeps memory bounded). */
const PRUNE_AT = 1000

const attempts = new Map<string, Attempt>()

/** Drops entries whose window has fully elapsed and that aren't locked. */
function prune(now: number): void {
  for (const [key, a] of attempts) {
    if (a.lockedUntil <= now && now - a.firstAt > WINDOW_MS) attempts.delete(key)
  }
}

/**
 * Seconds the caller must wait before trying again, or 0 when not locked.
 */
export function retryAfter(key: string): number {
  const a = attempts.get(key)
  if (!a) return 0
  const now = Date.now()
  if (a.lockedUntil > now) return Math.ceil((a.lockedUntil - now) / 1000)
  return 0
}

/** Record a failed sign-in for [key], locking it out once the limit is hit. */
export function recordFailure(key: string): void {
  const now = Date.now()
  if (attempts.size > PRUNE_AT) prune(now)

  const a = attempts.get(key)
  // Fresh counter when there's none, or the previous window has expired.
  if (!a || now - a.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 })
    return
  }

  a.count += 1
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = now + LOCK_MS
}

/** Clear all failure state for [key] (call on a successful login). */
export function clearAttempts(key: string): void {
  attempts.delete(key)
}
