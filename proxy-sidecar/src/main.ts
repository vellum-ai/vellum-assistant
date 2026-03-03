#!/usr/bin/env bun
/**
 * Standalone entrypoint for the proxy-sidecar service.
 *
 * Starts an HTTP forward-proxy server that handles:
 *   - Plain HTTP proxy requests (absolute-URL form)
 *   - CONNECT tunnelling for HTTPS pass-through
 *   - Optional MITM interception when a CA directory is provided
 *
 * Configuration is driven entirely by environment variables — see config.ts
 * for the full list and defaults.
 *
 * Usage:
 *   bun run proxy-sidecar/src/main.ts
 *   PROXY_PORT=9090 bun run proxy-sidecar/src/main.ts
 */

import type { Server } from 'node:http';

import { ConfigError, loadConfig } from './config.js';
import { createProxyServer } from './server.js';
import type { ProxyServerConfig } from './server.js';

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server: Server | null = null;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log('error', err.message);
      process.exit(1);
    }
    throw err;
  }

  log('info', 'proxy-sidecar starting', {
    port: config.port,
    host: config.host,
    caDir: config.caDir,
    logLevel: config.logLevel,
  });

  const serverConfig: ProxyServerConfig = {};

  // Attach a request logger when debug-level logging is active
  if (config.logLevel === 'debug') {
    serverConfig.onRequest = (method, url) => {
      log('debug', 'proxy request', { method, url });
    };
  }

  server = createProxyServer(serverConfig);

  server.listen(config.port, config.host, () => {
    const addr = server!.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
    log('info', 'proxy-sidecar listening', {
      port: boundPort,
      host: config.host,
    });
  });

  server.on('error', (err) => {
    log('error', 'server error', { error: String(err) });
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  log('info', 'shutting down', { signal });

  if (!server) {
    process.exit(0);
    return;
  }

  // Stop accepting new connections and wait for in-flight requests.
  server.close((err) => {
    if (err) {
      log('error', 'error during shutdown', { error: String(err) });
      process.exit(1);
    }
    log('info', 'proxy-sidecar stopped');
    process.exit(0);
  });

  // Force-exit after 10 seconds if graceful shutdown stalls.
  setTimeout(() => {
    log('warn', 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main();
