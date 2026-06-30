import type { HttpContext } from '@adonisjs/core/http'

/**
 * Connectivity probe — checks whether *this server* can reach an external host
 * and, if so, returns that host's page verbatim.
 *
 * Useful for diagnosing ISP/firewall reachability from the server's network
 * (the server may reach a host the client can't, or vice-versa).
 */
export default class ReachabilityController {
  private static readonly TARGET = 'https://iwaatch.com/'

  private static readonly BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

  private static readonly FETCH_TIMEOUT_MS = 20000

  /**
   * GET /reach/iwaatch — fetch https://iwaatch.com/ from the server and return
   * the page. On a network failure (DNS/blocked/timeout) responds 502 with the
   * error so you can tell "server can't reach it" from "host returned an error".
   */
  async iwaatch({ response }: HttpContext) {
    try {
      const res = await fetch(ReachabilityController.TARGET, {
        headers: { 'User-Agent': ReachabilityController.BROWSER_UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(ReachabilityController.FETCH_TIMEOUT_MS),
      })

      const body = await res.text()
      const contentType = res.headers.get('content-type') ?? 'text/html; charset=utf-8'

      return response.status(res.status).header('content-type', contentType).send(body)
    } catch (error) {
      return response.status(502).json({
        ok: false,
        target: ReachabilityController.TARGET,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
