import type { ApplicationService } from '@adonisjs/core/types'

/**
 * SocketProvider attaches the Socket.io server to the AdonisJS HTTP server.
 *
 * The work is done inside the `ready` lifecycle hook because that hook runs
 * *after* the Node HTTP server has been created and is listening — which is
 * exactly when `server.getNodeServer()` returns a usable instance.
 */
export default class SocketProvider {
  constructor(protected app: ApplicationService) {}

  async ready() {
    /**
     * Socket.io only makes sense when an HTTP server is running. Ace
     * commands, the REPL and tests boot the app without one — skip them.
     */
    if (this.app.getEnvironment() !== 'web') {
      return
    }

    const logger = await this.app.container.make('logger')

    /**
     * The AdonisJS HTTP server wrapper. `getNodeServer()` hands back the
     * underlying `node:http` server that Socket.io needs to attach to.
     */
    const httpServer = await this.app.container.make('server')
    const nodeServer = httpServer.getNodeServer()

    if (!nodeServer) {
      logger.error('[socket] Node HTTP server unavailable — Socket.io not started')
      return
    }

    const { boot } = await import('#start/socket')
    boot(nodeServer)

    logger.info('[socket] Socket.io server attached')
  }
}
