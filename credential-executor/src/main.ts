#!/usr/bin/env bun
/**
 * Local CES entrypoint.
 *
 * In local mode the assistant spawns CES as a child process and communicates
 * over stdin/stdout using newline-delimited JSON. This entrypoint:
 *
 * 1. Ensures the CES-private data directories exist.
 * 2. Starts the RPC server on process.stdin / process.stdout.
 * 3. Shuts down cleanly when stdin closes (parent exit) or SIGTERM arrives.
 *
 * Local mode never opens a TCP listener or Unix socket. All communication
 * flows through the inherited stdio file descriptors, which are automatically
 * closed when the parent process exits.
 *
 * The stdio transport ensures that shell subprocesses spawned by CES
 * (e.g. for `run_authenticated_command`) do not accidentally inherit the
 * command channel — Bun's `Bun.spawn` defaults to "pipe" for stdio on
 * child processes, so CES's own stdin/stdout are not leaked to subprocesses.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CES_PROTOCOL_VERSION, CesRpcMethod } from "@vellumai/ces-contracts";
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
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { createLocalOAuthLookup } from "./materializers/local-oauth-lookup.js";
import { resolveLocalSubject } from "./subjects/local.js";
import {
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesToolStoreDir,
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
// Vellum root resolution (mirrors assistant/src/util/platform.ts)
// ---------------------------------------------------------------------------

function getVellumRootDir(): string {
  const baseDataDir = process.env["BASE_DATA_DIR"]?.trim();
  return join(baseDataDir || homedir(), ".vellum");
}

// ---------------------------------------------------------------------------
// Build RPC handler registry
// ---------------------------------------------------------------------------

function buildHandlers(sessionId: string): RpcHandlerRegistry {
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
  const vellumRoot = getVellumRootDir();
  const credentialMetadataPath = join(
    vellumRoot,
    "workspace",
    "data",
    "credentials",
    "metadata.json",
  );
  const metadataStore = new StaticCredentialMetadataStore(
    credentialMetadataPath,
  );

  // Read-only OAuth connection lookup backed by the assistant's SQLite
  // database. CES opens the database in read-only mode.
  const oauthConnections = createLocalOAuthLookup(vellumRoot);

  // CES-native SecureKeyBackend that reads from the assistant's encrypted
  // key store file. Read-only — CES never writes or deletes keys.
  const secureKeyBackend = createLocalSecureKeyBackend(vellumRoot);

  const localMaterialiser = new LocalMaterialiser({
    secureKeyBackend,
  });

  // -- Build handler registry ------------------------------------------------

  // Start with the HTTP handler (make_authenticated_request)
  const handlers = buildHandlersWithHttp(
    {
      persistentGrantStore,
      temporaryGrantStore,
      localMaterialiser,
      localSubjectDeps: {
        metadataStore,
        oauthConnections,
      },
      auditStore,
      sessionId,
    },
  );

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
        const matResult = await localMaterialiser.materialise(subjectResult.subject);
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
    },
    defaultWorkspaceDir: join(vellumRoot, "workspace"),
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
    publishBundle: (request) => publishBundle({ ...request, cesMode: "local" }),
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDataDirs();

  const log = (msg: string) =>
    process.stderr.write(`[ces-local] ${msg}\n`);

  log(`Starting CES v${CES_PROTOCOL_VERSION} (local mode, stdio transport)`);

  const controller = new AbortController();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    log("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Build the handler registry with all available RPC implementations
  const sessionId = `ces-local-${Date.now()}`;
  const handlers = buildHandlers(sessionId);

  const server = new CesRpcServer({
    input: process.stdin,
    output: process.stdout,
    handlers,
    logger: {
      log: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-local] ${msg} ${args.map(String).join(" ")}\n`),
      warn: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-local] WARN: ${msg} ${args.map(String).join(" ")}\n`),
      error: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-local] ERROR: ${msg} ${args.map(String).join(" ")}\n`),
    },
    signal: controller.signal,
  });

  await server.serve();
  log("Server stopped.");
}

main().catch((err) => {
  process.stderr.write(`[ces-local] Fatal: ${err}\n`);
  process.exit(1);
});
