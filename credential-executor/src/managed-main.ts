#!/usr/bin/env bun
/**
 * Managed CES entrypoint.
 *
 * In managed (sidecar) mode the CES container:
 *
 * 1. Ensures the CES-private data directories exist.
 * 2. Binds a bootstrap Unix socket on the shared bootstrap volume.
 * 3. Accepts exactly **one** assistant runtime connection.
 * 4. Unlinks the socket path immediately after the connection is accepted,
 *    preventing any second process from connecting.
 * 5. Serves RPC on the accepted stream only.
 * 6. Simultaneously serves health probes (`/healthz`, `/readyz`) on a
 *    dedicated HTTP port for Kubernetes liveness/readiness checks.
 *
 * The managed entrypoint never opens a generic TCP or HTTP command API.
 * All RPC traffic flows exclusively over the accepted Unix socket stream.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

import { CES_PROTOCOL_VERSION, CesRpcMethod } from "@vellumai/ces-contracts";

import { AuditStore } from "./audit/store.js";
import { PersistentGrantStore } from "./grants/persistent-store.js";
import {
  createListAuditRecordsHandler,
  createListGrantsHandler,
  createRecordGrantHandler,
  createRevokeGrantHandler,
} from "./grants/rpc-handlers.js";
import { TemporaryGrantStore } from "./grants/temporary-store.js";
import {
  getBootstrapSocketPath,
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesToolStoreDir,
  getHealthPort,
} from "./paths.js";
import {
  buildHandlersWithHttp,
  CesRpcServer,
  registerCommandExecutionHandler,
  registerManageSecureCommandToolHandler,
  type RpcHandlerRegistry,
} from "./server.js";
import { publishBundle } from "./toolstore/publish.js";
import { validateSourceUrl } from "./toolstore/manifest.js";
import { resolveManagedSubject, type ManagedSubjectResolverOptions } from "./subjects/managed.js";
import { materializeManagedToken, type ManagedMaterializerOptions } from "./materializers/managed-platform.js";
import { HandleType, parseHandle } from "@vellumai/ces-contracts";

// ---------------------------------------------------------------------------
// Logging (managed always logs to stderr)
// ---------------------------------------------------------------------------

const log = (msg: string) =>
  process.stderr.write(`[ces-managed] ${msg}\n`);

const warn = (msg: string) =>
  process.stderr.write(`[ces-managed] WARN: ${msg}\n`);

// ---------------------------------------------------------------------------
// Data directory bootstrap
// ---------------------------------------------------------------------------

function ensureDataDirs(): void {
  const dirs = [
    getCesDataRoot("managed"),
    getCesGrantsDir("managed"),
    getCesAuditDir("managed"),
    getCesToolStoreDir("managed"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Build RPC handler registry (managed mode)
// ---------------------------------------------------------------------------

function buildHandlers(sessionId: string): RpcHandlerRegistry {
  // -- Grant stores ----------------------------------------------------------
  const persistentGrantStore = new PersistentGrantStore(
    getCesGrantsDir("managed"),
  );
  persistentGrantStore.init();

  const temporaryGrantStore = new TemporaryGrantStore();

  // -- Audit store -----------------------------------------------------------
  const auditStore = new AuditStore(getCesAuditDir("managed"));
  auditStore.init();

  // -- Managed credential options --------------------------------------------
  // In managed mode, credentials are obtained from the platform via its
  // token-materialization endpoint. The platform URL, API key, and assistant
  // ID are provided through environment variables set by the orchestration layer.
  const platformBaseUrl = process.env["PLATFORM_BASE_URL"] ?? "";
  const assistantApiKey = process.env["ASSISTANT_API_KEY"] ?? "";
  const assistantId = process.env["PLATFORM_ASSISTANT_ID"] ?? "";

  const managedSubjectOptions: ManagedSubjectResolverOptions | undefined =
    platformBaseUrl && assistantApiKey && assistantId
      ? { platformBaseUrl, assistantApiKey, assistantId }
      : undefined;

  const managedMaterializerOptions: ManagedMaterializerOptions | undefined =
    platformBaseUrl && assistantApiKey && assistantId
      ? { platformBaseUrl, assistantApiKey, assistantId }
      : undefined;

  if (!managedSubjectOptions) {
    warn(
      "PLATFORM_BASE_URL, ASSISTANT_API_KEY, and/or PLATFORM_ASSISTANT_ID not set. " +
        "Managed credential materialisation will not be available.",
    );
  }

  // -- Build handler registry ------------------------------------------------

  // In managed mode there is no local secure-key backend. The HTTP handler
  // uses managed subject resolution and managed materialisation instead.
  // The localMaterialiser and localSubjectDeps are required by HttpExecutorDeps
  // but will only be reached for local_static/local_oauth handles (which are
  // not expected in managed deployments). We stub them to fail closed.
  const stubLocalMaterialiser = {
    async materialise() {
      return {
        ok: false as const,
        error: "Local credential materialisation is not available in managed mode.",
      };
    },
    reset() {},
  };

  const handlers = buildHandlersWithHttp(
    {
      persistentGrantStore,
      temporaryGrantStore,
      localMaterialiser: stubLocalMaterialiser as any,
      localSubjectDeps: {
        metadataStore: { getByServiceField: () => undefined } as any,
        oauthConnections: { getById: () => undefined },
      },
      managedSubjectOptions,
      managedMaterializerOptions,
      auditStore,
      sessionId,
    },
  );

  // Register run_authenticated_command handler with managed platform materializer
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (handle) => {
        if (!managedMaterializerOptions) {
          return {
            ok: false as const,
            error:
              "PLATFORM_BASE_URL and/or ASSISTANT_API_KEY not set. " +
              "Managed credential materialisation is not available.",
          };
        }

        // Parse handle to determine type
        const parseResult = parseHandle(handle);
        if (!parseResult.ok) {
          return { ok: false as const, error: parseResult.error };
        }

        if (parseResult.handle.type !== HandleType.PlatformOAuth) {
          return {
            ok: false as const,
            error: `Handle type "${parseResult.handle.type}" is not supported in managed mode. ` +
              `Only platform_oauth handles are available.`,
          };
        }

        // Resolve managed subject
        const subjectResult = await resolveManagedSubject(
          handle,
          managedSubjectOptions!,
        );
        if (!subjectResult.ok) {
          return { ok: false as const, error: subjectResult.error.message };
        }

        // Materialize through the managed platform materializer
        const matResult = await materializeManagedToken(
          subjectResult.subject,
          managedMaterializerOptions,
        );
        if (!matResult.ok) {
          return { ok: false as const, error: matResult.error.message };
        }

        return {
          ok: true as const,
          value: matResult.token.accessToken,
          handleType: HandleType.PlatformOAuth,
        };
      },
      auditStore,
      cesMode: "managed",
    },
    defaultWorkspaceDir: "/workspace",
  });

  // Register manage_secure_command_tool handler
  const toolRegistry = new Map<string, { toolName: string; credentialHandle: string; description: string; bundleDigest: string }>();

  registerManageSecureCommandToolHandler(handlers, {
    downloadBundle: async (sourceUrl: string) => {
      const urlError = validateSourceUrl(sourceUrl);
      if (urlError) {
        throw new Error(urlError);
      }
      const MAX_BUNDLE_SIZE = 100 * 1024 * 1024; // 100 MB
      const resp = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const contentLength = resp.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_BUNDLE_SIZE) {
        throw new Error(`Bundle too large: ${contentLength} bytes (max ${MAX_BUNDLE_SIZE})`);
      }
      // Stream the body and enforce the size limit on actual bytes received,
      // since Content-Length can be absent (chunked encoding) or lie.
      const body = resp.body;
      if (!body) {
        throw new Error("Response body is null");
      }
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      for await (const chunk of body) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_BUNDLE_SIZE) {
          // Cancel the stream to free resources
          await body.cancel();
          throw new Error(`Bundle too large: received >${MAX_BUNDLE_SIZE} bytes (max ${MAX_BUNDLE_SIZE})`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    publishBundle: (request) => publishBundle({ ...request, cesMode: "managed" }),
    unregisterTool: (toolName: string) => {
      return toolRegistry.delete(toolName);
    },
    registerTool: (entry) => {
      toolRegistry.set(entry.toolName, entry);
    },
  });

  // Register grant management handlers
  handlers[CesRpcMethod.RecordGrant] = createRecordGrantHandler({
    persistentGrantStore,
    temporaryGrantStore,
  }) as typeof handlers[string];

  handlers[CesRpcMethod.ListGrants] = createListGrantsHandler({
    persistentGrantStore,
    sessionId,
  }) as typeof handlers[string];

  handlers[CesRpcMethod.RevokeGrant] = createRevokeGrantHandler({
    persistentGrantStore,
  }) as typeof handlers[string];

  // Register audit record handler
  handlers[CesRpcMethod.ListAuditRecords] = createListAuditRecordsHandler({
    auditStore,
  }) as typeof handlers[string];

  return handlers;
}

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

let rpcConnected = false;

function startHealthServer(port: number, signal: AbortSignal): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(
          JSON.stringify({ status: "ok", version: CES_PROTOCOL_VERSION }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/readyz") {
        const ready = rpcConnected;
        return new Response(
          JSON.stringify({ ready, version: CES_PROTOCOL_VERSION }),
          {
            status: ready ? 200 : 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  signal.addEventListener("abort", () => {
    server.stop(true);
  }, { once: true });

  return server;
}

// ---------------------------------------------------------------------------
// Bootstrap socket server (accepts exactly one connection)
// ---------------------------------------------------------------------------

/**
 * Listen on a Unix socket, accept exactly one connection, unlink the
 * socket path, and return readable/writable streams for the accepted
 * connection.
 */
function acceptOneConnection(
  socketPath: string,
  signal: AbortSignal,
): Promise<{ readable: Readable; writable: Writable; socket: Socket }> {
  return new Promise((resolve, reject) => {
    // Ensure the socket directory exists
    mkdirSync(dirname(socketPath), { recursive: true });

    // Clean up any stale socket file
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore — file may not exist
    }

    const netServer = createNetServer();

    const cleanup = () => {
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked or never created
      }
    };

    if (signal.aborted) {
      reject(new Error("Aborted before listening"));
      return;
    }

    signal.addEventListener("abort", () => {
      cleanup();
      reject(new Error("Aborted while waiting for connection"));
    }, { once: true });

    netServer.on("error", (err) => {
      cleanup();
      reject(err);
    });

    netServer.listen(socketPath, () => {
      log(`Bootstrap socket listening at ${socketPath}`);
    });

    netServer.on("connection", (socket: Socket) => {
      // Accept exactly one connection, then close the listener and
      // unlink the socket path so no other process can connect.
      log("Assistant connected via bootstrap socket");
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked
      }
      log("Bootstrap socket unlinked (single-connection enforced)");

      const readable = new Readable({
        read() {
          // Data is pushed externally
        },
      });

      const writable = new Writable({
        write(chunk, _encoding, callback) {
          if (socket.writable) {
            socket.write(chunk, callback);
          } else {
            callback(new Error("Socket no longer writable"));
          }
        },
      });

      socket.on("data", (chunk) => {
        readable.push(chunk);
      });

      socket.on("end", () => {
        readable.push(null);
      });

      socket.on("error", (err) => {
        readable.destroy(err);
        writable.destroy(err);
      });

      resolve({ readable, writable, socket });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDataDirs();

  log(`Starting CES v${CES_PROTOCOL_VERSION} (managed mode)`);

  const controller = new AbortController();

  // Graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start health server on dedicated port
  const healthPort = getHealthPort();
  const healthServer = startHealthServer(healthPort, controller.signal);
  log(`Health server listening on port ${healthPort}`);

  // Wait for exactly one assistant connection on the bootstrap socket
  const socketPath = getBootstrapSocketPath();
  log(`Waiting for assistant connection on ${socketPath}...`);

  let connection: Awaited<ReturnType<typeof acceptOneConnection>>;
  try {
    connection = await acceptOneConnection(socketPath, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      log("Shutdown before assistant connected.");
      return;
    }
    throw err;
  }

  rpcConnected = true;

  // Build the handler registry with all available RPC implementations
  const sessionId = `ces-managed-${Date.now()}`;
  const handlers = buildHandlers(sessionId);

  const server = new CesRpcServer({
    input: connection.readable,
    output: connection.writable,
    handlers,
    logger: {
      log: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] ${msg} ${args.map(String).join(" ")}\n`),
      warn: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] WARN: ${msg} ${args.map(String).join(" ")}\n`),
      error: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] ERROR: ${msg} ${args.map(String).join(" ")}\n`),
    },
    signal: controller.signal,
  });

  await server.serve();

  rpcConnected = false;
  log("RPC session ended. Shutting down...");
  controller.abort();
}

main().catch((err) => {
  process.stderr.write(`[ces-managed] Fatal: ${err}\n`);
  process.exit(1);
});
