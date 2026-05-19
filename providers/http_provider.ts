import type { ApplicationService } from '@adonisjs/core/types'

/**
 * HttpProvider tunes the underlying Node HTTP server so that large video
 * uploads are not cut short.
 *
 * Node's default `requestTimeout` is 5 minutes and aborts any request that
 * takes longer to *complete* — which a multi-gigabyte upload streaming to
 * disk easily can. We disable it here. Header timeouts are left at their
 * defaults, so a client that stalls before sending its body is still
 * rejected promptly.
 */
export default class HttpProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    /**
     * Only relevant when an HTTP server is actually running — ace commands,
     * the REPL and tests boot the app without one.
     */
    if (this.app.getEnvironment() !== 'web') {
      return
    }

    const logger = await this.app.container.make('logger')
    const httpServer = await this.app.container.make('server')
    const nodeServer = httpServer.getNodeServer()

    if (!nodeServer) {
      return
    }

    /**
     * `0` disables the per-request timeout entirely, so an upload of a
     * full-length movie (up to the 15 GB body limit) runs to completion.
     */
    nodeServer.requestTimeout = 0

    logger.info('[http] per-request timeout disabled — large uploads enabled')
  }
}
