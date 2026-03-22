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
import { dirname, join } from "node:path";
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
  type SessionIdRef,
} from "./server.js";
import { deleteBundleFromToolstore, publishBundle } from "./toolstore/publish.js";
import { validateSourceUrl } from "./toolstore/manifest.js";
import { buildCesEgressHooks } from "./commands/egress-hooks.js";
import { resolveManagedSubject } from "./subjects/managed.js";
import { materializeManagedToken } from "./materializers/managed-platform.js";
import { HandleType, parseHandle } from "@vellumai/ces-contracts";
import { buildLazyGetters, type ApiKeyRef } from "./managed-lazy-getters.js";
import { MANAGED_LOCAL_STATIC_REJECTION_ERROR } from "./managed-errors.js";
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { handleCredentialRoute, type CredentialRouteDeps } from "./http/credential-routes.js";

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

function buildHandlers(sessionIdRef: SessionIdRef, apiKeyRef: ApiKeyRef): RpcHandlerRegistry {
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
  // token-materialization endpoint. The platform URL and assistant ID come
  // from environment variables. The API key may come from the env var OR
  // from the bootstrap handshake (the assistant forwards it after hatch).
  // We use a lazy getter so the handshake-provided key takes effect even
  // though handlers are built before the handshake completes.
  const platformBaseUrl = process.env["PLATFORM_BASE_URL"] ?? "";
  const assistantId = process.env["PLATFORM_ASSISTANT_ID"] ?? "";

  const { getAssistantApiKey, getManagedSubjectOptions, getManagedMaterializerOptions } =
    buildLazyGetters({
      platformBaseUrl,
      assistantId,
      apiKeyRef,
      envApiKey: process.env["ASSISTANT_API_KEY"] || "",
    });

  if (!platformBaseUrl || !assistantId) {
    warn(
      "PLATFORM_BASE_URL and/or PLATFORM_ASSISTANT_ID not set. " +
        "Managed credential materialisation will depend on the handshake-provided API key.",
    );
  }

  // -- Workspace root for command execution cwd ------------------------------
  // Prefer WORKSPACE_DIR when set (new Docker layout mounts workspace at
  // /workspace). Fall back to the legacy path derived from the assistant
  // data mount for backwards compatibility.
  const defaultWorkspaceDir = process.env["WORKSPACE_DIR"] ?? (() => {
    const assistantDataMount =
      process.env["CES_ASSISTANT_DATA_MOUNT"] ?? "/assistant-data-ro";
    return join(join(assistantDataMount, ".vellum"), "workspace");
  })();

  // -- Build handler registry ------------------------------------------------
  // NOTE: local_static credential handles are NOT supported in managed mode.
  // v2 stores use a UID-independent `store.key` file that removes the
  // technical barrier (legacy v1 stores relied on PBKDF2 key derivation
  // from user identity, which broke across container users). The managed-
  // mode restriction is now a policy choice: managed deployments use
  // platform_oauth handles exclusively for simpler lifecycle and
  // centralized token management.
  //
  // We provide error-returning stubs for localMaterialiser/localSubjectDeps
  // so the HTTP handler compiles but any local_static request gets a clear
  // rejection message.

  const localMaterialiserStub = {
    materialise: async () => ({
      ok: false as const,
      error: MANAGED_LOCAL_STATIC_REJECTION_ERROR,
    }),
  };

  const localSubjectDepsStub = {
    metadataStore: { getById: () => undefined, list: () => [] } as any,
    oauthConnections: { getById: () => undefined },
  };

  // Use a deps object with getters so the handshake-provided API key
  // is resolved lazily at RPC call time (after the handshake completes).
  const httpDeps = {
    persistentGrantStore,
    temporaryGrantStore,
    localMaterialiser: localMaterialiserStub as any,
    localSubjectDeps: localSubjectDepsStub,
    get managedSubjectOptions() { return getManagedSubjectOptions(); },
    get managedMaterializerOptions() { return getManagedMaterializerOptions(); },
    auditStore,
    sessionId: sessionIdRef,
  };

  const handlers = buildHandlersWithHttp(httpDeps);

  // Register run_authenticated_command handler with managed platform materializer
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (handle) => {
        // Parse handle to determine type
        const parseResult = parseHandle(handle);
        if (!parseResult.ok) {
          return { ok: false as const, error: parseResult.error };
        }

        switch (parseResult.handle.type) {
          // -- Local static: NOT supported in managed mode -------------------
          case HandleType.LocalStatic: {
            return {
              ok: false as const,
              error: MANAGED_LOCAL_STATIC_REJECTION_ERROR,
            };
          }

          // -- Platform OAuth: materialise via the platform endpoint ----------
          case HandleType.PlatformOAuth: {
            const matOpts = getManagedMaterializerOptions();
            const subOpts = getManagedSubjectOptions();
            if (!matOpts || !subOpts) {
              return {
                ok: false as const,
                error:
                  "PLATFORM_BASE_URL and/or ASSISTANT_API_KEY not set. " +
                  "Managed credential materialisation is not available.",
              };
            }

            const subjectResult = await resolveManagedSubject(
              handle,
              subOpts,
            );
            if (!subjectResult.ok) {
              return { ok: false as const, error: subjectResult.error.message };
            }

            const matResult = await materializeManagedToken(
              subjectResult.subject,
              matOpts,
            );
            if (!matResult.ok) {
              return { ok: false as const, error: matResult.error.message };
            }

            return {
              ok: true as const,
              value: matResult.token.accessToken,
              handleType: HandleType.PlatformOAuth,
            };
          }

          default:
            return {
              ok: false as const,
              error: `Handle type "${parseResult.handle.type}" is not supported in managed mode. ` +
                `Supported types: platform_oauth.`,
            };
        }
      },
      auditStore,
      sessionId: sessionIdRef,
      cesMode: "managed",
      egressHooks: buildCesEgressHooks(),
    },
    defaultWorkspaceDir,
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
          throw new Error(`Bundle too large: received >${MAX_BUNDLE_SIZE} bytes (max ${MAX_BUNDLE_SIZE})`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    publishBundle: (request) => publishBundle({ ...request, cesMode: "managed" }),
    unregisterTool: (toolName: string) => {
      const entry = toolRegistry.get(toolName);
      const removed = toolRegistry.delete(toolName);
      if (removed && entry?.bundleDigest) {
        const stillInUse = Array.from(toolRegistry.values()).some(t => t.bundleDigest === entry.bundleDigest);
        if (!stillInUse) {
          deleteBundleFromToolstore(entry.bundleDigest, "managed");
        }
      }
      return removed;
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

function startHealthServer(
  port: number,
  signal: AbortSignal,
  credentialDeps: CredentialRouteDeps | null,
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(
          JSON.stringify({ status: "ok", version: CES_PROTOCOL_VERSION }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/readyz") {
        // Always return 200 — pod readiness must not depend on whether the
        // assistant has connected.  When the CES feature flag is off the
        // assistant never connects, and a 503 here would block pod
        // scheduling during dark-launch.  The sidecar can't do useful work
        // without a connection anyway, so readiness is purely about the
        // process being up and able to accept a future connection.
        return new Response(
          JSON.stringify({ ready: true, rpcConnected, version: CES_PROTOCOL_VERSION }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Credential CRUD routes (only if service token is configured)
      if (credentialDeps) {
        const credentialResponse = await handleCredentialRoute(req, credentialDeps);
        if (credentialResponse) return credentialResponse;
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

  // Set up credential CRUD routes if a service token is configured.
  // The assistant and gateway use CES_SERVICE_TOKEN to authenticate
  // credential management requests over HTTP.
  const serviceToken = process.env["CES_SERVICE_TOKEN"] ?? "";
  let credentialDeps: CredentialRouteDeps | null = null;

  if (serviceToken) {
    const assistantDataMount =
      process.env["CES_ASSISTANT_DATA_MOUNT"] ?? "/assistant-data-ro";
    const vellumRoot = join(assistantDataMount, ".vellum");
    const backend = createLocalSecureKeyBackend(vellumRoot);
    credentialDeps = { backend, serviceToken };
    log("Credential CRUD routes enabled (CES_SERVICE_TOKEN configured)");
  } else {
    warn(
      "CES_SERVICE_TOKEN not set — credential CRUD HTTP routes are disabled. " +
        "Set CES_SERVICE_TOKEN to enable credential management over HTTP.",
    );
  }

  // Start health server on dedicated port
  const healthPort = getHealthPort();
  const healthServer = startHealthServer(healthPort, controller.signal, credentialDeps);
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

  // Build the handler registry with all available RPC implementations.
  // Use mutable refs so the handshake-provided session ID and API key
  // are available to handlers at call time (after the handshake completes).
  const sessionIdRef: SessionIdRef = { current: `ces-managed-${Date.now()}` };
  const apiKeyRef: ApiKeyRef = { current: "" };
  const handlers = buildHandlers(sessionIdRef, apiKeyRef);

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
    onHandshakeComplete: (hsSessionId, hsApiKey) => {
      sessionIdRef.current = hsSessionId;
      if (hsApiKey) {
        apiKeyRef.current = hsApiKey;
        log(`Received assistant API key via handshake`);
      }
    },
    onApiKeyUpdate: (newKey) => {
      apiKeyRef.current = newKey;
      log(`Assistant API key updated via RPC`);
    },
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
