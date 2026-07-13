#!/usr/bin/env bun
/**
 * CES (Credential Execution Service) entrypoint — unified for both
 * local (bare-metal sibling) and managed (Kubernetes sidecar) modes.
 *
 * Mode is determined by `getCesMode()` from `paths.ts`:
 * - `CES_MODE=managed` (set in the Dockerfile / K8s statefulset) → managed mode
 * - absent or any other value → local mode (bare-metal sibling)
 *
 * Both modes serve credential CRUD RPC over a Unix socket using a concurrent
 * multi-connection server (`serveStandaloneSocket`). Each connection gets its
 * own `CesRpcServer` over a shared, process-scoped handler registry. The server
 * stays listening across connections, so an assistant that disconnects (crash,
 * restart) can reconnect without CES re-binding.
 *
 * Managed mode additionally starts a health HTTP server (`/healthz`, `/readyz`,
 * optional credential CRUD routes) for Kubernetes liveness/readiness probes.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
} from "@vellumai/service-contracts/credential-rpc";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { initLogger, getLogger } from "./logger.js";
import {
  getBootstrapSocketPath,
  getCesDataRoot,
  getCesLogDir,
  getCesMode,
  getHealthPort,
  getLocalSocketPath,
  getSecurityDir,
  type CesMode,
} from "./paths.js";
import { CesRpcServer, type RpcHandlerRegistry } from "./server.js";
import {
  handleCredentialRoute,
  type CredentialRouteDeps,
} from "./http/credential-routes.js";
import { handleLogExportRoute } from "./http/log-export-routes.js";
import { CES_MIGRATIONS } from "./migrations/registry.js";
import { runCesMigrations } from "./migrations/runner.js";

// ---------------------------------------------------------------------------
// Logging (module-level for early bootstrap + structured logging post-init)
// ---------------------------------------------------------------------------

const log = getLogger("main");

// ---------------------------------------------------------------------------
// Data directory bootstrap
// ---------------------------------------------------------------------------

function ensureDataDirs(mode: CesMode): void {
  mkdirSync(getCesDataRoot(mode), { recursive: true });
}

// ---------------------------------------------------------------------------
// Credential CRUD handlers
// ---------------------------------------------------------------------------

/**
 * Build the RPC handler registry. CES serves credential CRUD (get / set /
 * delete / list / bulk-set) backed by the secure key store. The
 * `update_managed_credential` handler is registered separately by the RPC
 * server when an `onApiKeyUpdate` callback is supplied. Local and managed modes
 * share the same registry — they differ only in where the secure key backend
 * reads from and whether the health server is started.
 */
function buildCrudHandlers(
  secureKeyBackend: SecureKeyBackend,
): RpcHandlerRegistry {
  const handlers: RpcHandlerRegistry = {};

  handlers[CesRpcMethod.GetCredential] = (async (req: { account: string }) => {
    const value = await secureKeyBackend.get(req.account);
    return { found: value !== undefined, value };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.SetCredential] = (async (req: {
    account: string;
    value: string;
  }) => {
    const ok = await secureKeyBackend.set(req.account, req.value);
    return { ok };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.DeleteCredential] = (async (req: {
    account: string;
  }) => {
    const result = await secureKeyBackend.delete(req.account);
    return { result };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.ListCredentials] = (async () => {
    const accounts = await secureKeyBackend.list();
    return { accounts };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.BulkSetCredentials] = (async (req: {
    credentials: Array<{ account: string; value: string }>;
  }) => {
    const results = [];
    for (const { account, value } of req.credentials) {
      const ok = await secureKeyBackend.set(account, value);
      results.push({ account, ok });
    }
    return { results };
  }) as (typeof handlers)[string];

  return handlers;
}

// ---------------------------------------------------------------------------
// Socket server (unified multi-connection model)
// ---------------------------------------------------------------------------

/**
 * Serve RPC over a Unix socket using a concurrent multi-connection model.
 *
 * Binds the socket, accepts connections concurrently (each served by its own
 * CesRpcServer over the shared handler registry), and unlinks the socket when
 * the signal aborts. The listener stays open across connections so a client
 * that disconnects can reconnect without CES re-binding.
 */
function serveStandaloneSocket(opts: {
  socketPath: string;
  handlers: RpcHandlerRegistry;
  signal: AbortSignal;
  logger: Pick<Console, "log" | "warn" | "error">;
  log: ReturnType<typeof getLogger>;
  onHandshakeComplete?: (
    sessionId: string,
    assistantApiKey?: string,
    assistantId?: string,
  ) => void;
  onApiKeyUpdate?: (assistantApiKey: string, assistantId?: string) => void;
}): void {
  const {
    socketPath,
    handlers,
    signal,
    logger,
    log,
    onHandshakeComplete,
    onApiKeyUpdate,
  } = opts;

  mkdirSync(dirname(socketPath), { recursive: true });
  try {
    unlinkSync(socketPath);
  } catch {
    // stale or absent — fine
  }

  const netServer = createNetServer();

  netServer.on("error", (err) => {
    log.warn({ err }, "CES socket server error");
  });

  netServer.on("connection", (socket: Socket) => {
    connectionCount++;
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        if (socket.writable) {
          socket.write(chunk, callback);
        } else {
          callback(new Error("Socket no longer writable"));
        }
      },
    });
    socket.on("data", (chunk) => readable.push(chunk));
    socket.on("end", () => readable.push(null));
    socket.on("error", (err) => {
      readable.destroy(err);
      writable.destroy(err);
    });

    const server = new CesRpcServer({
      input: readable,
      output: writable,
      handlers,
      logger,
      signal,
      onHandshakeComplete: (sessionId, apiKey, assistantId) => {
        onHandshakeComplete?.(sessionId, apiKey, assistantId);
      },
      onApiKeyUpdate: onApiKeyUpdate ?? (() => {}),
    });
    void server
      .serve()
      .catch((err) => {
        server.close();
        log.warn({ err }, "CES connection ended with a transport error");
      })
      .then(() => {
        connectionCount = Math.max(0, connectionCount - 1);
      });
  });

  netServer.listen(socketPath, () => {
    log.info(`CES socket listening at ${socketPath}`);
  });

  signal.addEventListener(
    "abort",
    () => {
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // already removed
      }
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// Health server (managed mode only)
// ---------------------------------------------------------------------------

let connectionCount = 0;

function startHealthServer(
  port: number,
  signal: AbortSignal,
  credentialDeps: CredentialRouteDeps | null,
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/readyz") {
        // Always return 200 — pod readiness must not depend on whether the
        // assistant has connected.  When the CES feature flag is off the
        // assistant never connects, and a 503 here would block pod
        // scheduling during dark-launch.  The sidecar can't do useful work
        // without a connection anyway, so readiness is purely about the
        // process being up and able to accept a future connection.
        return new Response(
          JSON.stringify({
            status: "ok",
            connections: connectionCount,
            rpcConnected: connectionCount > 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Credential CRUD routes (only if service token is configured)
      if (credentialDeps) {
        const credentialResponse = await handleCredentialRoute(
          req,
          credentialDeps,
        );
        if (credentialResponse) return credentialResponse;
      }

      // Log export route
      const logExportResponse = await handleLogExportRoute(
        req,
        getCesLogDir("managed"),
      );
      if (logExportResponse) return logExportResponse;

      return new Response("Not Found", { status: 404 });
    },
  });

  signal.addEventListener(
    "abort",
    () => {
      server.stop(true);
    },
    { once: true },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = getCesMode();
  ensureDataDirs(mode);

  initLogger({ dir: getCesLogDir(mode), retentionDays: 30 });

  log.info(
    `Starting CES v${CES_PROTOCOL_VERSION} (${mode} mode, socket transport)`,
  );

  const controller = new AbortController();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    log.info("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // -- Secure key backend + migrations --------------------------------------
  // The secure key backend path differs by mode:
  // - Local: dirname(getSecurityDir()) — the parent of ~/.vellum/protected
  //   (or CREDENTIAL_SECURITY_DIR when set by the CLI).
  // - Managed: join(assistantDataMount, ".vellum") — the assistant data mount.
  const secureKeyBackend =
    mode === "managed"
      ? createLocalSecureKeyBackend(
          join(
            process.env["CES_ASSISTANT_DATA_MOUNT"] ?? "/assistant-data-ro",
            ".vellum",
          ),
        )
      : createLocalSecureKeyBackend(dirname(getSecurityDir()));

  await runCesMigrations(
    getCesDataRoot(mode),
    secureKeyBackend,
    CES_MIGRATIONS,
  );
  log.info(`CES ${mode} startup: migrations complete`);

  // -- Build handlers --------------------------------------------------------
  // The per-connection session ID lives in each CesRpcServer's SessionContext;
  // handlers read it at call time. The registry is shared across connections
  // and identical in both modes.
  const handlers = buildCrudHandlers(secureKeyBackend);

  // -- Health server (managed only) -----------------------------------------
  if (mode === "managed") {
    const serviceToken = process.env["CES_SERVICE_TOKEN"] ?? "";
    let credentialDeps: CredentialRouteDeps | null = null;

    if (serviceToken) {
      credentialDeps = { backend: secureKeyBackend, serviceToken };
      log.info("Credential CRUD routes enabled (CES_SERVICE_TOKEN configured)");
    } else {
      log.warn(
        "CES_SERVICE_TOKEN not set — credential CRUD HTTP routes are disabled. " +
          "Set CES_SERVICE_TOKEN to enable credential management over HTTP.",
      );
    }

    const healthPort = getHealthPort();
    startHealthServer(healthPort, controller.signal, credentialDeps);
    log.info(`Health server listening on port ${healthPort}`);
  }

  // -- Socket server ---------------------------------------------------------
  const socketPath =
    mode === "managed" ? getBootstrapSocketPath() : getLocalSocketPath();

  const rpcLog = getLogger("rpc");
  const rpcLogger = {
    log: (msg: string, ...args: unknown[]) => rpcLog.info({ args }, msg),
    warn: (msg: string, ...args: unknown[]) => rpcLog.warn({ args }, msg),
    error: (msg: string, ...args: unknown[]) => rpcLog.error({ args }, msg),
  };

  // Managed mode registers the `update_managed_credential` handler (via the
  // `onApiKeyUpdate` hook) so the assistant can push its API key/ID after hatch.
  // The push is acknowledged and logged; CES stores credentials via the CRUD
  // handlers and no longer materializes platform tokens itself.
  serveStandaloneSocket({
    socketPath,
    handlers,
    signal: controller.signal,
    logger: rpcLogger,
    log,
    onApiKeyUpdate:
      mode === "managed"
        ? (_newKey: string, newAssistantId?: string) => {
            log.info("Assistant API key updated via RPC");
            if (newAssistantId) {
              log.info("Assistant ID updated via RPC");
            }
          }
        : undefined,
  });

  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
  log.info("Server stopped.");
}

main().catch((err) => {
  try {
    getLogger("main").fatal({ err }, "Fatal error");
  } catch {
    process.stderr.write(`[ces-${getCesMode()}] Fatal: ${err}\n`);
  }
  process.exit(1);
});
