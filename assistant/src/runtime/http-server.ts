/**
 * Optional HTTP server that exposes the canonical runtime API.
 *
 * Runs in the same process as the daemon. Started only when
 * `RUNTIME_HTTP_PORT` is set (default: disabled).
 */

import { getLogger } from '../util/logger.js';

const log = getLogger('runtime-http');

const DEFAULT_PORT = 7821;

export interface RuntimeHttpServerOptions {
  port?: number;
}

export class RuntimeHttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;

  constructor(options: RuntimeHttpServerOptions = {}) {
    this.port = options.port ?? DEFAULT_PORT;
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });

    log.info({ port: this.port }, 'Runtime HTTP server listening');
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
      log.info('Runtime HTTP server stopped');
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Match /v1/assistants/:assistantId/health
    const healthMatch = path.match(/^\/v1\/assistants\/([^/]+)\/health$/);
    if (healthMatch && req.method === 'GET') {
      return this.handleHealth();
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleHealth(): Response {
    return Response.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  }
}
