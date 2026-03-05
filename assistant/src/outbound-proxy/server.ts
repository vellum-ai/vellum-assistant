/**
 * Proxy server factory -- creates an HTTP server configured to handle
 * plain HTTP proxy requests via the forwarder, plain CONNECT tunnelling,
 * and optional MITM interception for credential-injected HTTPS requests.
 */

import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { ConnectionOptions } from "node:tls";

import { handleConnect } from "./connect-tunnel.js";
import { forwardHttpRequest, type PolicyCallback } from "./http-forwarder.js";
import { handleMitm, type RewriteCallback } from "./mitm-handler.js";
import type { RouteDecision } from "./router.js";

export interface MitmHandlerConfig {
  /** Path to the local CA directory containing ca.pem / ca-key.pem. */
  caDir: string;
  /**
   * Decide whether the CONNECT target should be MITM-intercepted.
   * Returns a RouteDecision with action ('mitm' | 'tunnel') and a
   * deterministic reason code for auditing.
   */
  shouldIntercept: (hostname: string, port: number) => RouteDecision;
  /** Called with the decrypted request; returns headers to merge or null to reject. */
  rewriteCallback: RewriteCallback;
  /** Extra TLS options for the upstream connection (e.g. custom CA for testing). */
  upstreamTlsOptions?: Pick<ConnectionOptions, "ca" | "rejectUnauthorized">;
}

export interface ProxyServerConfig {
  /** Optional policy callback for credential injection / access control. */
  policyCallback?: PolicyCallback;
  /** Called on every forwarded request for logging. */
  onRequest?: (method: string, url: string) => void;
  /** When provided, CONNECT requests matching shouldIntercept are MITM-handled. */
  mitmHandler?: MitmHandlerConfig;
}

/**
 * Parse a CONNECT target of the form `host:port`.
 */
function parseConnectTarget(
  url: string | undefined,
): { host: string; port: number } | null {
  if (!url) return null;
  const colonIdx = url.lastIndexOf(":");
  if (colonIdx <= 0) return null;
  let host = url.slice(0, colonIdx);
  const portStr = url.slice(colonIdx + 1);
  if (!host || !portStr) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Strip brackets from IPv6 literals -- net.connect expects the raw address
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (!host) return null;
  }
  return { host, port };
}

/**
 * Create an HTTP server that acts as a forward proxy for plain HTTP
 * requests (absolute-URL form), CONNECT tunnelling for HTTPS pass-through,
 * and optional MITM interception for credential-injected HTTPS requests.
 */
export function createProxyServer(config: ProxyServerConfig = {}): Server {
  const server = createServer((req, res) => {
    if (config.onRequest && req.method && req.url) {
      config.onRequest(req.method, req.url);
    }

    forwardHttpRequest(req, res, config.policyCallback);
  });

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    if (config.mitmHandler) {
      const target = parseConnectTarget(req.url);
      const decision = target
        ? config.mitmHandler.shouldIntercept(target.host, target.port)
        : undefined;

      if (target && decision?.action === "mitm") {
        handleMitm(
          clientSocket,
          head,
          target.host,
          target.port,
          config.mitmHandler.caDir,
          config.mitmHandler.rewriteCallback,
          config.mitmHandler.upstreamTlsOptions,
        ).catch(() => {
          if (clientSocket.writable) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
          clientSocket.destroy();
        });
        return;
      }
    }

    // Gate CONNECT tunnels through policyCallback the same way HTTP requests are gated
    if (config.policyCallback) {
      const connectTarget = parseConnectTarget(req.url);
      if (!connectTarget) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      if (config.onRequest) {
        config.onRequest("CONNECT", req.url!);
      }

      config
        .policyCallback(
          connectTarget.host,
          connectTarget.port === 443 ? null : connectTarget.port,
          "/",
          "https",
        )
        .then((extraHeaders) => {
          if (extraHeaders == null) {
            clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            clientSocket.destroy();
            return;
          }
          handleConnect(req, clientSocket, head);
        })
        .catch(() => {
          if (clientSocket.writable) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
          clientSocket.destroy();
        });
    } else {
      if (config.onRequest && req.url) {
        config.onRequest("CONNECT", req.url);
      }
      handleConnect(req, clientSocket, head);
    }
  });

  return server;
}
