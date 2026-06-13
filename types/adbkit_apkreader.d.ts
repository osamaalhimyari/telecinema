/**
 * Minimal ambient types for `@devicefarmer/adbkit-apkreader` (ships no types).
 * Only the bits `#services/apk_inspector` uses are declared.
 */
declare module '@devicefarmer/adbkit-apkreader' {
  interface ApkManifest {
    versionName?: string
    versionCode?: number
    package?: string
    [key: string]: unknown
  }

  export default class ApkReader {
    static open(path: string): Promise<ApkReader>
    readManifest(): Promise<ApkManifest>
  }
}
