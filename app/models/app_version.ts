import { AppVersionSchema } from '#database/schema'

/** Parses a versionName like "1.0.5" into a [major, minor, patch] tuple. */
function parseVersionName(name: string): [number, number, number] {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(name ?? '')
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0), Number(m?.[3] ?? 0)]
}

/**
 * Compares two builds by their FULL version: `major.minor.patch` first, then the
 * build number (`versionCode`) as a tiebreak. Returns >0 when A is newer than B,
 * <0 when older, 0 when identical.
 *
 * This is what the update check compares on, so a higher versionName always wins
 * even when an older build happens to carry a larger versionCode (e.g. a
 * split-APK ABI offset like 2001) — fixing the "1.0.5 offered an update to
 * 1.0.4" bug.
 */
export function compareVersions(aName: string, aCode: number, bName: string, bCode: number): number {
  const a = parseVersionName(aName)
  const b = parseVersionName(bName)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return aCode - bCode
}

/**
 * AppVersion model — one published (or blocked) Android build. The version
 * metadata columns are filled from the uploaded APK by `#services/apk_inspector`;
 * see the migration for what each column means.
 */
export default class AppVersion extends AppVersionSchema {
  /** A blocked build is never offered for download and force-updates its users. */
  get isBlocked() {
    return this.status === 'blocked'
  }

  /**
   * The newest published build by FULL version (not just versionCode). Sorted in
   * JS because a string `ORDER BY` would mis-rank "1.0.10" vs "1.0.9". Returns
   * null when nothing is published.
   */
  static async latestPublished() {
    const all = await this.query().where('status', 'published')
    if (all.length === 0) return null
    return all.sort((x, y) =>
      compareVersions(y.versionName, y.versionCode, x.versionName, x.versionCode)
    )[0]
  }
}
