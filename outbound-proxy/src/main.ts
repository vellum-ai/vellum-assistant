#!/usr/bin/env bun
/**
 * Standalone entrypoint for the outbound-proxy service.
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
 *   bun run outbound-proxy/src/main.ts
 *   PROXY_PORT=9090 bun run outbound-proxy/src/main.ts
 */

import type { Server } from 'node:http';

import { ConfigError, loadConfig } from './config.js';
import { createHealthServer } from './health.js';
import { createProxyServer } from './server.js';
import type { ProxyServerConfig } from './server.js';

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server: Server | null = null;
let healthServer: Server | null = null;
let proxyListening = false;

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

  log('info', 'outbound-proxy starting', {
    port: config.port,
    host: config.host,
    healthPort: config.healthPort,
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
    proxyListening = true;
    const addr = server!.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : config.port;
    log('info', 'outbound-proxy listening', {
      port: boundPort,
      host: config.host,
    });
  });

  server.on('error', (err) => {
    log('error', 'server error', { error: String(err) });
    process.exit(1);
  });

  // Start health/readiness server on separate control port
  healthServer = createHealthServer({
    isReady: () => proxyListening,
  });

  healthServer.listen(config.healthPort, config.host, () => {
    log('info', 'health server listening', {
      port: config.healthPort,
      host: config.host,
    });
  });

  healthServer.on('error', (err) => {
    log('error', 'health server error', { error: String(err) });
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  log('info', 'shutting down', { signal });
  proxyListening = false;

  if (!server && !healthServer) {
    process.exit(0);
    return;
  }

  let pending = 0;
  let hasError = false;

  const onClosed = (name: string) => (err?: Error) => {
    if (err) {
      log('error', `error during ${name} shutdown`, { error: String(err) });
      hasError = true;
    }
    pending--;
    if (pending === 0) {
      log('info', 'outbound-proxy stopped');
      process.exit(hasError ? 1 : 0);
    }
  };

  // Close proxy server first to drain in-flight requests while health probes remain available
  if (server) {
    pending++;
    server.close(onClosed('proxy'));
  }

  if (healthServer) {
    pending++;
    healthServer.close(onClosed('health'));
  }

  // Force-exit after 10 seconds if graceful shutdown stalls.
  setTimeout(() => {
    log('warn', 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main();
