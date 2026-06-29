#!/usr/bin/env bun
/**
 * Local CES entrypoint.
 *
 * In local mode the assistant spawns CES as a child process and communicates
 * over stdin/stdout using newline-delimited JSON. This entrypoint:
 *
 * 1. Ensures the CES-private data directories exist.
 * 2. Starts the RPC server on process.stdin / process.stdout (the spawning
 *    parent's transport, and the process lifecycle anchor).
 * 3. Additionally listens on a Unix socket under the CES-private data dir so
 *    the daemon's sibling processes can reach CES (see `local-socket.ts`).
 * 4. Shuts down cleanly when stdin closes (parent exit) or SIGTERM arrives,
 *    tearing down the socket listener with it.
 *
 * Local mode never opens a TCP listener. The stdio transport is never inherited
 * by shell subprocesses spawned by CES (e.g. for `run_authenticated_command`):
 * Bun's `Bun.spawn` defaults to "pipe" for stdio, and the Unix socket's
 * listening fd is likewise not passed to those subprocesses.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
} from "@vellumai/service-contracts/credential-rpc";
import { StaticCredentialMetadataStore } from "@vellumai/credential-storage";

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
import type { SecureKeyBackend } from "@vellumai/credential-storage";
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { createLocalOAuthLookup } from "./materializers/local-oauth-lookup.js";
import { createLocalTokenRefreshFn } from "./materializers/local-token-refresh.js";
import { resolveLocalSubject } from "./subjects/local.js";
import { checkCredentialPolicy } from "./subjects/policy.js";
import { initLogger, getLogger } from "./logger.js";
import {
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesLogDir,
  getCesToolStoreDir,
  getLocalSocketPath,
} from "./paths.js";
import { startLocalSocketServer } from "./local-socket.js";
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
import { CES_MIGRATIONS } from "./migrations/registry.js";
import { runCesMigrations } from "./migrations/runner.js";

// ---------------------------------------------------------------------------
// Data directory bootstrap
// ---------------------------------------------------------------------------

function ensureDataDirs(): void {
  const dirs = [
    getCesDataRoot("local"),
    getCesGrantsDir("local"),
    getCesAuditDir("local"),
    getCesToolStoreDir("local"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace directory.
 *
 * Priority:
 * 1. `VELLUM_WORKSPACE_DIR` env var (set by the platform template)
 * 2. Default: `~/.vellum/workspace`
 */
function getWorkspaceDir(): string {
  return (
    process.env["VELLUM_WORKSPACE_DIR"]?.trim() ||
    join(homedir(), ".vellum", "workspace")
  );
}

/**
 * Resolve the CES security directory (contains key stores, encryption data).
 *
 * Priority:
 * 1. `CREDENTIAL_SECURITY_DIR` env var (set by the platform template for
 *    the CES container — `/ces-security` in managed mode)
 * 2. Default: `~/.vellum/protected` (local mode)
 */
function getSecurityDir(): string {
  return (
    process.env["CREDENTIAL_SECURITY_DIR"]?.trim() ||
    join(homedir(), ".vellum", "protected")
  );
}

// ---------------------------------------------------------------------------
// Build RPC handler registry
// ---------------------------------------------------------------------------

function buildHandlers(
  secureKeyBackend: SecureKeyBackend,
): RpcHandlerRegistry {
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

  // Start with the HTTP handler (make_authenticated_request)
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

  // Register run_authenticated_command handler
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (handle) => {
        // Resolve the subject first, then materialise through the local backend
        const subjectResult = resolveLocalSubject(handle, {
          metadataStore,
          oauthConnections,
        });
        if (!subjectResult.ok) {
          return { ok: false as const, error: subjectResult.error };
        }

        // Enforce credential-level policies for local static handles
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
    publishBundle: (request) => publishBundle({ ...request, cesMode: "local" }),
    unregisterTool: (toolName: string) => {
      const entry = toolRegistry.get(toolName);
      const removed = toolRegistry.delete(toolName);
      if (removed && entry?.bundleDigest) {
        const stillInUse = Array.from(toolRegistry.values()).some(
          (t) => t.bundleDigest === entry.bundleDigest,
        );
        if (!stillInUse) {
          deleteBundleFromToolstore(entry.bundleDigest, "local");
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

  return handlers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDataDirs();

  initLogger({ dir: getCesLogDir(), retentionDays: 30 });
  const log = getLogger("main");

  log.info(
    `Starting CES v${CES_PROTOCOL_VERSION} (local mode, stdio + socket transport)`,
  );

  const controller = new AbortController();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    log.info("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Build the credential backend and run one-time migrations before starting
  // the RPC server. Migrations complete synchronously before any connection
  // is accepted — the backend is then passed to buildHandlers so it is not
  // re-instantiated.
  const secureKeyBackend = createLocalSecureKeyBackend(
    dirname(getSecurityDir()),
  );
  await runCesMigrations(
    getCesDataRoot("local"),
    secureKeyBackend,
    CES_MIGRATIONS,
  );
  log.info("CES local startup: migrations complete");

  // Build the handler registry with all available RPC implementations.
  // The handshake session ID is captured per connection in the server's
  // SessionContext; handlers read it at call time for audit records.
  const handlers = buildHandlers(secureKeyBackend);

  const rpcLog = getLogger("rpc");
  const rpcLogger = {
    log: (msg: string, ...args: unknown[]) => rpcLog.info({ args }, msg),
    warn: (msg: string, ...args: unknown[]) => rpcLog.warn({ args }, msg),
    error: (msg: string, ...args: unknown[]) => rpcLog.error({ args }, msg),
  };

  // Serve the spawning parent over stdio. This is the lifecycle anchor: when
  // the parent exits, stdin closes and serve() resolves, and we tear down.
  const stdioServer = new CesRpcServer({
    input: process.stdin,
    output: process.stdout,
    handlers,
    logger: rpcLogger,
    signal: controller.signal,
    // Local mode reads API keys from env/store directly — no-op handler so
    // update_managed_credential is still registered and returns success.
    onApiKeyUpdate: () => {},
  });

  // Additionally listen on a Unix socket so the daemon's sibling processes can
  // reach CES (the spawning parent keeps using stdio). Possession of the socket
  // is the authorization boundary — it lives under the CES-private data dir —
  // and each accepted connection is served by its own server over the shared,
  // connection-safe handler registry.
  const socketPath = getLocalSocketPath();
  startLocalSocketServer({
    socketPath,
    handlers,
    signal: controller.signal,
    logger: rpcLogger,
    onListening: (p) => log.info(`Local CES socket listening at ${p}`),
    onServerError: (err) =>
      rpcLog.warn({ err }, "Local CES socket server error"),
  });

  await stdioServer.serve();
  // The parent disconnected (or a shutdown signal fired). Abort so the socket
  // listener and any live socket connections are torn down too.
  controller.abort();
  log.info("Server stopped.");
}

main().catch((err) => {
  try {
    getLogger("main").fatal({ err }, "Fatal error");
  } catch {
    process.stderr.write(`[ces-local] Fatal: ${err}\n`);
  }
  process.exit(1);
});
