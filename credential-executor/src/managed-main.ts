#!/usr/bin/env bun
/**
 * Managed CES entrypoint.
 *
 * In managed (sidecar) mode the CES container:
 *
 * 1. Ensures the CES-private data directories exist.
 * 2. Binds a bootstrap Unix socket on the shared bootstrap volume.
 * 3. Accepts a single assistant runtime connection.
 * 4. Unlinks the socket path immediately after the connection is accepted,
 *    preventing any second process from connecting while the session is live.
 * 5. Serves RPC on the accepted stream only.
 * 6. When that session ends (the assistant disconnects or its container is
 *    restarted), re-binds the socket and awaits a reconnection. CES is a
 *    long-lived sidecar — it outlives any single assistant session and only
 *    shuts down on SIGTERM/SIGINT. At most one connection is ever active.
 * 7. Simultaneously serves health probes (`/healthz`, `/readyz`) on a
 *    dedicated HTTP port for Kubernetes liveness/readiness checks.
 *
 * The managed entrypoint never opens a generic TCP or HTTP command API.
 * All RPC traffic flows exclusively over the accepted Unix socket stream.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
} from "@vellumai/service-contracts/credential-rpc";

import { AuditStore } from "./audit/store.js";
import { PersistentGrantStore } from "./grants/persistent-store.js";
import {
  createListAuditRecordsHandler,
  createListGrantsHandler,
  createRecordGrantHandler,
  createRevokeGrantHandler,
} from "./grants/rpc-handlers.js";
import { TemporaryGrantStore } from "./grants/temporary-store.js";
import { initLogger, getLogger } from "./logger.js";
import {
  getBootstrapSocketPath,
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesLogDir,
  getCesToolStoreDir,
  getHealthPort,
} from "./paths.js";
import {
  buildHandlersWithHttp,
  CesRpcServer,
  registerCommandExecutionHandler,
  registerManageSecureCommandToolHandler,
  type RpcHandlerRegistry,
  type ServeEndReason,
  type SessionIdRef,
} from "./server.js";
import {
  deleteBundleFromToolstore,
  publishBundle,
} from "./toolstore/publish.js";
import { validateSourceUrl } from "./toolstore/manifest.js";
import { buildCesEgressHooks } from "./commands/egress-hooks.js";
import { resolveManagedSubject } from "./subjects/managed.js";
import { materializeManagedToken } from "./materializers/managed-platform.js";
import {
  HandleType,
  parseHandle,
} from "@vellumai/service-contracts/credential-rpc";
import {
  applyManagedCredentialRefs,
  buildLazyGetters,
  type ApiKeyRef,
  type AssistantIdRef,
} from "./managed-lazy-getters.js";
import { MANAGED_LOCAL_STATIC_REJECTION_ERROR } from "./managed-errors.js";
import type { SecureKeyBackend } from "@vellumai/credential-storage";
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import type { LocalMaterialiser } from "./materializers/local.js";
import type { LocalSubjectResolverDeps } from "./subjects/local.js";
import {
  handleCredentialRoute,
  type CredentialRouteDeps,
} from "./http/credential-routes.js";
import { handleLogExportRoute } from "./http/log-export-routes.js";
import { CES_MIGRATIONS } from "./migrations/registry.js";
import { runCesMigrations } from "./migrations/runner.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Module-level logger used before initLogger() runs (early bootstrap) and
// after it runs (structured file + stderr). Before initLogger() the fallback
// inside getLogger() writes to stderr only, so early messages still appear.
const log = getLogger("main");

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

function buildHandlers(
  sessionIdRef: SessionIdRef,
  apiKeyRef: ApiKeyRef,
  assistantIdRef: AssistantIdRef,
  secureKeyBackend: SecureKeyBackend,
): { handlers: RpcHandlerRegistry; temporaryGrantStore: TemporaryGrantStore } {
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
  const platformBaseUrl = process.env["VELLUM_PLATFORM_URL"] ?? "";

  const { getManagedSubjectOptions, getManagedMaterializerOptions } =
    buildLazyGetters({
      platformBaseUrl,
      assistantIdRef,
      apiKeyRef,
      envApiKey: process.env["ASSISTANT_API_KEY"] || "",
    });

  if (!platformBaseUrl) {
    log.warn(
      "VELLUM_PLATFORM_URL not set. " +
        "Managed credential materialisation will depend on the handshake-provided values.",
    );
  }

  // -- Workspace root for command execution cwd ------------------------------
  // Use VELLUM_WORKSPACE_DIR when set, otherwise fall back to the legacy
  // path derived from the assistant data mount.
  const defaultWorkspaceDir =
    process.env["VELLUM_WORKSPACE_DIR"] ??
    (() => {
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

  const localSubjectDepsStub: LocalSubjectResolverDeps = {
    metadataStore: {
      getById: () => undefined,
      list: () => [],
    } as unknown as LocalSubjectResolverDeps["metadataStore"],
    oauthConnections: { getById: () => undefined },
  };

  // Use a deps object with getters so the handshake-provided API key
  // is resolved lazily at RPC call time (after the handshake completes).
  const httpDeps = {
    persistentGrantStore,
    temporaryGrantStore,
    localMaterialiser: localMaterialiserStub as unknown as LocalMaterialiser,
    localSubjectDeps: localSubjectDepsStub,
    get managedSubjectOptions() {
      return getManagedSubjectOptions();
    },
    get managedMaterializerOptions() {
      return getManagedMaterializerOptions();
    },
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
                  "VELLUM_PLATFORM_URL and/or ASSISTANT_API_KEY not set. " +
                  "Managed credential materialisation is not available.",
              };
            }

            const subjectResult = await resolveManagedSubject(handle, subOpts);
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
              error:
                `Handle type "${parseResult.handle.type}" is not supported in managed mode. ` +
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
  const toolRegistry = new Map<
    string,
    {
      toolName: string;
      credentialHandle: string;
      description: string;
      bundleDigest: string;
    }
  >();

  registerManageSecureCommandToolHandler(handlers, {
    downloadBundle: async (sourceUrl: string) => {
      const urlError = validateSourceUrl(sourceUrl);
      if (urlError) {
        throw new Error(urlError);
      }
      const MAX_BUNDLE_SIZE = 100 * 1024 * 1024; // 100 MB
      const resp = await fetch(sourceUrl, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      const contentLength = resp.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_BUNDLE_SIZE) {
        throw new Error(
          `Bundle too large: ${contentLength} bytes (max ${MAX_BUNDLE_SIZE})`,
        );
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
          throw new Error(
            `Bundle too large: received >${MAX_BUNDLE_SIZE} bytes (max ${MAX_BUNDLE_SIZE})`,
          );
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    publishBundle: (request) =>
      publishBundle({ ...request, cesMode: "managed" }),
    unregisterTool: (toolName: string) => {
      const entry = toolRegistry.get(toolName);
      const removed = toolRegistry.delete(toolName);
      if (removed && entry?.bundleDigest) {
        const stillInUse = Array.from(toolRegistry.values()).some(
          (t) => t.bundleDigest === entry.bundleDigest,
        );
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
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.ListGrants] = createListGrantsHandler({
    persistentGrantStore,
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.RevokeGrant] = createRevokeGrantHandler({
    persistentGrantStore,
  }) as (typeof handlers)[string];

  // Register audit record handler
  handlers[CesRpcMethod.ListAuditRecords] = createListAuditRecordsHandler({
    auditStore,
  }) as (typeof handlers)[string];

  // Register credential CRUD handlers
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

  return { handlers, temporaryGrantStore };
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
        return new Response(JSON.stringify({ status: "ok", rpcConnected }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
// Bootstrap socket server (accepts one connection at a time)
// ---------------------------------------------------------------------------

/**
 * Listen on a Unix socket, accept one connection, unlink the socket path,
 * and return readable/writable streams for the accepted connection.
 *
 * The socket is unlinked while a connection is active so no second process
 * can connect concurrently (only one assistant ever talks to CES at a time).
 * When that session ends, the caller re-invokes this function to re-bind the
 * socket and accept the assistant's reconnection — CES outlives any single
 * assistant session (see `main()`).
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

    // Remove this listener once the promise settles. Because CES re-binds
    // the socket after each session ends, a long-lived AbortSignal would
    // otherwise accumulate one dangling listener per reconnection.
    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted while waiting for connection"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    netServer.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      cleanup();
      reject(err);
    });

    netServer.listen(socketPath, () => {
      log.info(`Bootstrap socket listening at ${socketPath}`);
    });

    netServer.on("connection", (socket: Socket) => {
      // Accept the connection, then close the listener and unlink the
      // socket path so no other process can connect while this session
      // is active.
      signal.removeEventListener("abort", onAbort);
      log.info("Assistant connected via bootstrap socket");
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked
      }
      log.info("Bootstrap socket unlinked (single active connection enforced)");

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

  initLogger({ dir: getCesLogDir("managed"), retentionDays: 30 });

  log.info(`Starting CES v${CES_PROTOCOL_VERSION} (managed mode)`);

  const controller = new AbortController();

  // Graceful shutdown — pass the signal as the abort reason so consumers
  // of controller.signal can inspect signal.reason for triage.
  process.on("SIGTERM", () => {
    log.warn(
      { signal: "SIGTERM", pid: process.pid, uptime: process.uptime() },
      "Received SIGTERM — shutting down",
    );
    controller.abort("SIGTERM");
  });
  process.on("SIGINT", () => {
    log.warn(
      { signal: "SIGINT", pid: process.pid, uptime: process.uptime() },
      "Received SIGINT — shutting down",
    );
    controller.abort("SIGINT");
  });

  // Create the secure key backend unconditionally — it's needed by both
  // HTTP credential routes (when CES_SERVICE_TOKEN is set) and RPC
  // credential CRUD handlers (always available).
  const assistantDataMount =
    process.env["CES_ASSISTANT_DATA_MOUNT"] ?? "/assistant-data-ro";
  const vellumRoot = join(assistantDataMount, ".vellum");
  const secureKeyBackend = createLocalSecureKeyBackend(vellumRoot);

  // Run one-time credential store migrations before accepting connections.
  await runCesMigrations(
    getCesDataRoot("managed"),
    secureKeyBackend,
    CES_MIGRATIONS,
  );
  log.info("CES managed startup: migrations complete");

  // Set up credential CRUD routes if a service token is configured.
  // The assistant and gateway use CES_SERVICE_TOKEN to authenticate
  // credential management requests over HTTP.
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

  // Start health server on dedicated port. The returned handle isn't
  // needed because the server lifetime is bound to controller.signal,
  // which fires on shutdown and triggers Bun.serve's stop().
  const healthPort = getHealthPort();
  startHealthServer(healthPort, controller.signal, credentialDeps);
  log.info(`Health server listening on port ${healthPort}`);

  // Build the handler registry once, up front, and reuse it across every
  // assistant session. All CES state lives behind these handlers — file-backed
  // grant/audit stores plus the in-memory temporary-grant store and the
  // secure-command tool registry — and must be process-scoped so it survives
  // an assistant reconnection. In particular, the tool registry mirrors the
  // persistent toolstore on disk; rebuilding it per session would let a later
  // `unregister` miss a tool registered in an earlier session and orphan its
  // bundle.
  //
  // The in-memory temporary-grant store is the exception: `allow_once` /
  // `allow_10m` grants are keyed by proposal hash only (not session), so they
  // would otherwise leak ephemeral approvals across sessions. It is cleared at
  // the end of every session below so a reconnecting assistant must re-prompt.
  //
  // The mutable refs carry the handshake-provided session ID, API key, and
  // assistant ID; handlers read them at call time, so updating the refs when
  // each session's handshake completes is all that's needed per connection.
  const sessionIdRef: SessionIdRef = { current: `ces-managed-${Date.now()}` };
  const apiKeyRef: ApiKeyRef = { current: "" };
  const assistantIdRef: AssistantIdRef = { current: "" };
  const { handlers, temporaryGrantStore } = buildHandlers(
    sessionIdRef,
    apiKeyRef,
    assistantIdRef,
    secureKeyBackend,
  );

  // Serve loop. CES is a long-lived sidecar that must outlive any single
  // assistant session: the assistant container can crash and be restarted
  // independently of the CES container (Kubernetes restarts containers, not
  // the whole pod), so when the RPC stream ends we re-bind the bootstrap
  // socket and wait for the assistant to reconnect rather than tearing the
  // sidecar down. The loop only exits on a shutdown signal (SIGTERM/SIGINT),
  // which aborts the controller.
  const rpcLog = getLogger("rpc");
  const socketPath = getBootstrapSocketPath();

  while (!controller.signal.aborted) {
    log.info(`Waiting for assistant connection on ${socketPath}...`);

    let connection: Awaited<ReturnType<typeof acceptOneConnection>>;
    try {
      connection = await acceptOneConnection(socketPath, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        log.info("Shutdown before assistant connected.");
        return;
      }
      throw err;
    }

    rpcConnected = true;

    const server = new CesRpcServer({
      input: connection.readable,
      output: connection.writable,
      handlers,
      logger: {
        log: (msg: string, ...args: unknown[]) => rpcLog.info({ args }, msg),
        warn: (msg: string, ...args: unknown[]) => rpcLog.warn({ args }, msg),
        error: (msg: string, ...args: unknown[]) => rpcLog.error({ args }, msg),
      },
      signal: controller.signal,
      onHandshakeComplete: (hsSessionId, hsApiKey, hsAssistantId) => {
        sessionIdRef.current = hsSessionId;
        // Overwrite the credential refs on every handshake. The handler
        // registry persists across reconnects, so a new session that omits
        // the API key / assistant ID must fail closed (falling back to the
        // env key, or no key) rather than reusing the previous session's
        // credentials.
        applyManagedCredentialRefs(
          apiKeyRef,
          assistantIdRef,
          hsApiKey,
          hsAssistantId,
        );
        if (hsApiKey) {
          log.info("Received assistant API key via handshake");
        }
        if (hsAssistantId) {
          log.info("Received assistant ID via handshake");
        }
      },
      onApiKeyUpdate: (newKey, newAssistantId) => {
        // Overwrite both refs on every credential update, for the same
        // fail-closed reason as the handshake: the assistant sources the
        // assistant ID from the same place it sources the key, so an update
        // that omits the ID means it has none — CES must clear the stale ID
        // rather than keep materializing for the previous session's assistant.
        applyManagedCredentialRefs(
          apiKeyRef,
          assistantIdRef,
          newKey,
          newAssistantId,
        );
        log.info("Assistant API key updated via RPC");
        if (newAssistantId) {
          log.info("Assistant ID updated via RPC");
        }
      },
    });

    // `serve()` resolves on a clean stream end or signal abort, and rejects
    // when the transport stream errors — which is precisely what a hard
    // disconnect (connection reset when the assistant container crashes)
    // looks like. Both cases must keep the sidecar up; only a shutdown
    // signal should tear it down. So treat a serve() rejection the same as
    // a session end and fall through to await reconnection.
    let endReason: ServeEndReason | "transport_error";
    try {
      endReason = await server.serve();
    } catch (err) {
      server.close();
      endReason = "transport_error";
      log.warn(
        { err, uptime: process.uptime(), pid: process.pid },
        "RPC transport errored — treating as session end",
      );
    }

    rpcConnected = false;

    // Drop all ephemeral approvals when the session ends. `allow_once` /
    // `allow_10m` grants are keyed by proposal hash only, so reusing the
    // store across a reconnect would let a pre-disconnect approval be
    // consumed by a later session without re-prompting. Clearing here
    // restores the prior behavior, where the process exited on stream end
    // and these grants never survived.
    temporaryGrantStore.clear();

    // A signal-driven end means the process is shutting down; exit the loop.
    // Any other end reason (the assistant disconnected, its stream closed,
    // or the transport errored) means we keep the sidecar up and await a
    // reconnection.
    if (
      controller.signal.aborted ||
      endReason === "signal_aborted" ||
      endReason === "signal_aborted_before_start"
    ) {
      log.info(
        { reason: endReason, uptime: process.uptime(), pid: process.pid },
        "RPC session ended due to shutdown — exiting serve loop",
      );
      break;
    }

    log.warn(
      { reason: endReason, uptime: process.uptime(), pid: process.pid },
      "RPC session ended (assistant disconnected) — awaiting reconnection",
    );
  }
}

main().catch((err) => {
  try {
    getLogger("main").fatal({ err }, "Fatal error");
  } catch {
    process.stderr.write(`[ces-managed] Fatal: ${err}\n`);
  }
  process.exit(1);
});
