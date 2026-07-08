#!/usr/bin/env bun
/**
 * CES (Credential Execution Service) entrypoint — unified for both
 * local (bare-metal sibling) and managed (Kubernetes sidecar) modes.
 *
 * Mode is determined by `getCesMode()` from `paths.ts`:
 * - `CES_MODE=managed` (set in the Dockerfile / K8s statefulset) → managed mode
 * - absent or any other value → local mode (bare-metal sibling)
 *
 * Both modes serve RPC over a Unix socket using a concurrent multi-connection
 * server (`serveStandaloneSocket`). Each connection gets its own `CesRpcServer`
 * over a shared, process-scoped handler registry. The server stays listening
 * across connections, so an assistant that disconnects (crash, restart) can
 * reconnect without CES re-binding.
 *
 * Managed mode additionally starts a health HTTP server (`/healthz`, `/readyz`,
 * optional credential CRUD routes) for Kubernetes liveness/readiness probes,
 * and uses handshake-provided credential refs (API key, assistant ID) resolved
 * lazily via `buildLazyGetters`.
 *
 * Local mode never opens a TCP listener. The Unix socket's listening fd is not
 * inherited by shell subprocesses spawned by CES (e.g. for
 * `run_authenticated_command`): Bun's `Bun.spawn` defaults to "pipe" for
 * stdio, and the listening socket is not passed to those subprocesses.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  HandleType,
  parseHandle,
} from "@vellumai/service-contracts/credential-rpc";
import { StaticCredentialMetadataStore } from "@vellumai/credential-storage";
import type { SecureKeyBackend } from "@vellumai/credential-storage";

import { AuditStore } from "./audit/store.js";
import { PersistentGrantStore } from "./grants/persistent-store.js";
import {
  createListAuditRecordsHandler,
  createListGrantsHandler,
  createRecordGrantHandler,
  createRevokeGrantHandler,
} from "./grants/rpc-handlers.js";
import { TemporaryGrantStore } from "./grants/temporary-store.js";
import { LocalMaterialiser } from "./materializers/local.js";
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { createLocalOAuthLookup } from "./materializers/local-oauth-lookup.js";
import { createLocalTokenRefreshFn } from "./materializers/local-token-refresh.js";
import { resolveLocalSubject } from "./subjects/local.js";
import type { LocalSubjectResolverDeps } from "./subjects/local.js";
import { checkCredentialPolicy } from "./subjects/policy.js";
import { resolveManagedSubject } from "./subjects/managed.js";
import { materializeManagedToken } from "./materializers/managed-platform.js";
import {
  applyManagedCredentialRefs,
  buildLazyGetters,
  type ApiKeyRef,
  type AssistantIdRef,
} from "./managed-lazy-getters.js";
import { MANAGED_LOCAL_STATIC_REJECTION_ERROR } from "./managed-errors.js";
import { initLogger, getLogger } from "./logger.js";
import {
  getBootstrapSocketPath,
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesLogDir,
  getCesMode,
  getCesToolStoreDir,
  getHealthPort,
  getLocalSocketPath,
  getSecurityDir,
  type CesMode,
} from "./paths.js";
import {
  buildHandlersWithHttp,
  CesRpcServer,
  registerCommandExecutionHandler,
  registerManageSecureCommandToolHandler,
  type RpcHandlerRegistry,
} from "./server.js";
import {
  deleteBundleFromToolstore,
  publishBundle,
} from "./toolstore/publish.js";
import { validateSourceUrl } from "./toolstore/manifest.js";
import { buildCesEgressHooks } from "./commands/egress-hooks.js";
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
  const dirs = [
    getCesDataRoot(mode),
    getCesGrantsDir(mode),
    getCesAuditDir(mode),
    getCesToolStoreDir(mode),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Path resolution (local-mode helpers)
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace directory (local mode only).
 *
 * Priority:
 * 1. `VELLUM_WORKSPACE_DIR` env var (set by the CLI when launching the sibling)
 * 2. Default: `~/.vellum/workspace`
 */
function getWorkspaceDir(): string {
  return (
    process.env["VELLUM_WORKSPACE_DIR"]?.trim() ||
    join(homedir(), ".vellum", "workspace")
  );
}

// ---------------------------------------------------------------------------
// Shared handler registration
// ---------------------------------------------------------------------------

/**
 * Download a secure-command tool bundle from a source URL, enforcing a 100 MB
 * size limit. Used by the manage_secure_command_tool handler in both modes.
 */
async function downloadBundle(sourceUrl: string): Promise<Buffer> {
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
}

/**
 * Register handlers shared between local and managed modes:
 * manage_secure_command_tool, grant management, audit records, and
 * credential CRUD. These are identical across modes except for the cesMode
 * argument passed to publishBundle / deleteBundleFromToolstore.
 */
function registerSharedHandlers(
  handlers: RpcHandlerRegistry,
  opts: {
    secureKeyBackend: SecureKeyBackend;
    persistentGrantStore: PersistentGrantStore;
    temporaryGrantStore: TemporaryGrantStore;
    auditStore: AuditStore;
    cesMode: CesMode;
  },
): void {
  const { secureKeyBackend, persistentGrantStore, temporaryGrantStore, auditStore, cesMode } = opts;

  // -- manage_secure_command_tool -------------------------------------------
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
    downloadBundle,
    publishBundle: (request) =>
      publishBundle({ ...request, cesMode }),
    unregisterTool: (toolName: string) => {
      const entry = toolRegistry.get(toolName);
      const removed = toolRegistry.delete(toolName);
      if (removed && entry?.bundleDigest) {
        const stillInUse = Array.from(toolRegistry.values()).some(
          (t) => t.bundleDigest === entry.bundleDigest,
        );
        if (!stillInUse) {
          deleteBundleFromToolstore(entry.bundleDigest, cesMode);
        }
      }
      return removed;
    },
    registerTool: (entry) => {
      toolRegistry.set(entry.toolName, entry);
    },
  });

  // -- Grant management handlers ---------------------------------------------
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

  // -- Audit record handler --------------------------------------------------
  handlers[CesRpcMethod.ListAuditRecords] = createListAuditRecordsHandler({
    auditStore,
  }) as (typeof handlers)[string];

  // -- Credential CRUD handlers ----------------------------------------------
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
}

// ---------------------------------------------------------------------------
// Local-mode handler builder
// ---------------------------------------------------------------------------

function buildLocalHandlers(secureKeyBackend: SecureKeyBackend): RpcHandlerRegistry {
  // -- Grant stores ----------------------------------------------------------
  const persistentGrantStore = new PersistentGrantStore(
    getCesGrantsDir("local"),
  );
  persistentGrantStore.init();

  const temporaryGrantStore = new TemporaryGrantStore();

  // -- Audit store -----------------------------------------------------------
  const auditStore = new AuditStore(getCesAuditDir("local"));
  auditStore.init();

  // -- Credential backend (local) --------------------------------------------
  // In local mode CES shares the filesystem with the assistant and can access
  // the same credential metadata and secure-key stores.
  const workspaceDir = getWorkspaceDir();
  const credentialMetadataPath = join(
    workspaceDir,
    "data",
    "credentials",
    "metadata.json",
  );
  const metadataStore = new StaticCredentialMetadataStore(
    credentialMetadataPath,
  );

  // Read-only OAuth connection lookup backed by the assistant's SQLite
  // database. CES opens the database in read-only mode.
  const oauthConnections = createLocalOAuthLookup(workspaceDir);

  const localMaterialiser = new LocalMaterialiser({
    secureKeyBackend,
    tokenRefreshFn: createLocalTokenRefreshFn(workspaceDir, secureKeyBackend),
  });

  // -- Build handler registry ------------------------------------------------
  const handlers = buildHandlersWithHttp({
    persistentGrantStore,
    temporaryGrantStore,
    localMaterialiser,
    localSubjectDeps: {
      metadataStore,
      oauthConnections,
    },
    auditStore,
  });

  // -- run_authenticated_command (local) ------------------------------------
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (handle) => {
        const subjectResult = resolveLocalSubject(handle, {
          metadataStore,
          oauthConnections,
        });
        if (!subjectResult.ok) {
          return { ok: false as const, error: subjectResult.error };
        }

        if (subjectResult.subject.type === "local_static") {
          const policyCheck = checkCredentialPolicy(
            subjectResult.subject.metadata,
            "run_authenticated_command",
          );
          if (!policyCheck.ok) {
            return { ok: false as const, error: policyCheck.error! };
          }
        }

        const matResult = await localMaterialiser.materialise(
          subjectResult.subject,
        );
        if (!matResult.ok) {
          return { ok: false as const, error: matResult.error };
        }
        return {
          ok: true as const,
          value: matResult.credential.value,
          handleType: matResult.credential.handleType,
        };
      },
      auditStore,
      cesMode: "local",
      egressHooks: buildCesEgressHooks(),
    },
    defaultWorkspaceDir: workspaceDir,
  });

  // -- Shared handlers (grants, audit, CRUD, toolstore) ---------------------
  registerSharedHandlers(handlers, {
    secureKeyBackend,
    persistentGrantStore,
    temporaryGrantStore,
    auditStore,
    cesMode: "local",
  });

  return handlers;
}

// ---------------------------------------------------------------------------
// Managed-mode handler builder
// ---------------------------------------------------------------------------

function buildManagedHandlers(
  apiKeyRef: ApiKeyRef,
  assistantIdRef: AssistantIdRef,
  secureKeyBackend: SecureKeyBackend,
): RpcHandlerRegistry {
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
  const defaultWorkspaceDir =
    process.env["VELLUM_WORKSPACE_DIR"] ??
    (() => {
      const assistantDataMount =
        process.env["CES_ASSISTANT_DATA_MOUNT"] ?? "/assistant-data-ro";
      return join(join(assistantDataMount, ".vellum"), "workspace");
    })();

  // -- local_static stubs (not supported in managed mode) -------------------
  // v2 stores use a UID-independent `store.key` file that removes the
  // technical barrier (legacy v1 stores relied on PBKDF2 key derivation
  // from user identity, which broke across container users). The managed-
  // mode restriction is now a policy choice: managed deployments use
  // platform_oauth handles exclusively for simpler lifecycle and
  // centralized token management.
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

  // Use a deps obj with getters so the handshake-provided API key
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
  };

  const handlers = buildHandlersWithHttp(httpDeps);

  // -- run_authenticated_command (managed) ----------------------------------
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (handle) => {
        const parseResult = parseHandle(handle);
        if (!parseResult.ok) {
          return { ok: false as const, error: parseResult.error };
        }

        switch (parseResult.handle.type) {
          case HandleType.LocalStatic: {
            return {
              ok: false as const,
              error: MANAGED_LOCAL_STATIC_REJECTION_ERROR,
            };
          }

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
      cesMode: "managed",
      egressHooks: buildCesEgressHooks(),
    },
    defaultWorkspaceDir,
  });

  // -- Shared handlers (grants, audit, CRUD, toolstore) ---------------------
  registerSharedHandlers(handlers, {
    secureKeyBackend,
    persistentGrantStore,
    temporaryGrantStore,
    auditStore,
    cesMode: "managed",
  });

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
  onHandshakeComplete?: (sessionId: string, assistantApiKey?: string, assistantId?: string) => void;
  onApiKeyUpdate?: (assistantApiKey: string, assistantId?: string) => void;
}): void {
  const { socketPath, handlers, signal, logger, log, onHandshakeComplete, onApiKeyUpdate } = opts;

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
          rpcConnected = true;
          onHandshakeComplete?.(sessionId, apiKey, assistantId);
        },
        onApiKeyUpdate: onApiKeyUpdate ?? (() => {}),
      });
      void server.serve().catch((err) => {
        server.close();
        log.warn(
          { err },
          "CES connection ended with a transport error",
        );
      }).then(() => {
        rpcConnected = false;
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = getCesMode();
  ensureDataDirs(mode);

  initLogger({ dir: getCesLogDir(mode), retentionDays: 30 });

  log.info(`Starting CES v${CES_PROTOCOL_VERSION} (${mode} mode, socket transport)`);

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
  // Managed mode needs credential refs for handshake callbacks; local mode
  // does not. The refs are process-scoped and persist across reconnects.
  // The per-connection session ID lives in each CesRpcServer's
  // SessionContext; handlers read it at call time for audit records.
  let managedRefs: { apiKeyRef: ApiKeyRef; assistantIdRef: AssistantIdRef } | undefined;
  const handlers =
    mode === "managed"
      ? (() => {
          const apiKeyRef: ApiKeyRef = { current: "" };
          const assistantIdRef: AssistantIdRef = { current: "" };
          managedRefs = { apiKeyRef, assistantIdRef };
          return buildManagedHandlers(apiKeyRef, assistantIdRef, secureKeyBackend);
        })()
      : buildLocalHandlers(secureKeyBackend);

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

  // Managed mode: wire handshake callbacks to update credential refs.
  // Capture in a const so TS narrows the type inside the closures.
  const refs = managedRefs;
  serveStandaloneSocket({
    socketPath,
    handlers,
    signal: controller.signal,
    logger: rpcLogger,
    log,
    onHandshakeComplete: refs
      ? (_hsSessionId, hsApiKey, hsAssistantId) => {
          // Overwrite the credential refs on every handshake. The handler
          // registry persists across reconnects, so a new session that omits
          // the API key / assistant ID must fail closed (falling back to the
          // env key, or no key) rather than reusing the previous session's
          // credentials.
          applyManagedCredentialRefs(
            refs.apiKeyRef,
            refs.assistantIdRef,
            hsApiKey,
            hsAssistantId,
          );
          if (hsApiKey) {
            log.info("Received assistant API key via handshake");
          }
          if (hsAssistantId) {
            log.info("Received assistant ID via handshake");
          }
        }
      : undefined,
    onApiKeyUpdate: refs
      ? (newKey: string, newAssistantId?: string) => {
          applyManagedCredentialRefs(
            refs.apiKeyRef,
            refs.assistantIdRef,
            newKey,
            newAssistantId,
          );
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
