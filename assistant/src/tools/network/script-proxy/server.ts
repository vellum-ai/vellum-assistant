/**
 * Proxy server factory — creates an HTTP server configured to handle
 * plain HTTP proxy requests via the forwarder.
 */

import { createServer, type Server } from 'node:http';
import { forwardHttpRequest, type PolicyCallback } from './http-forwarder.js';
import { handleConnect } from './connect-tunnel.js';

export interface ProxyServerConfig {
  /** Optional policy callback for credential injection / access control. */
  policyCallback?: PolicyCallback;
  /** Called on every forwarded request for logging. */
  onRequest?: (method: string, url: string) => void;
}

/**
 * Create an HTTP server that acts as a forward proxy for plain HTTP
 * requests (absolute-URL form) and CONNECT tunnelling for HTTPS pass-through.
 */
export function createProxyServer(config: ProxyServerConfig = {}): Server {
  const server = createServer((req, res) => {
    if (config.onRequest && req.method && req.url) {
      config.onRequest(req.method, req.url);
    }

    forwardHttpRequest(req, res, config.policyCallback);
  });

  server.on('connect', (req, clientSocket, head) => {
    handleConnect(req, clientSocket, head);
  });

  return server;
}
