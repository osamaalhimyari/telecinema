import ApkReader from '@devicefarmer/adbkit-apkreader'

/**
 * The pieces of an APK's `AndroidManifest.xml` the dashboard cares about. These
 * are read straight out of the uploaded file so the admin never types a version
 * by hand (and can't get it wrong).
 */
export interface ApkInfo {
  /** Human-readable version, e.g. "1.0.5" — shown in the UI and to users. */
  versionName: string
  /** Android integer build number — the value the update check compares on. */
  versionCode: number
  /** applicationId, e.g. "com.example.watch_aprty_app". */
  packageName: string
}

/**
 * Parses an uploaded `.apk` and returns its version metadata by reading the
 * binary `AndroidManifest.xml` inside the archive. Throws when the file isn't a
 * readable APK or the manifest is missing the fields we need, so the controller
 * can reject the upload before persisting anything.
 */
export async function inspectApk(absolutePath: string): Promise<ApkInfo> {
  const reader = await ApkReader.open(absolutePath)
  const manifest = await reader.readManifest()

  const versionName = String(manifest.versionName ?? '').trim()
  const versionCode = Number(manifest.versionCode ?? 0)
  const packageName = String(manifest.package ?? '').trim()

  if (!versionName || !Number.isFinite(versionCode) || versionCode <= 0 || !packageName) {
    throw new Error('apk_manifest_incomplete')
  }

  return { versionName, versionCode, packageName }
}
