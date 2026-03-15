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
  createRevokeGrantHandler,
} from "./grants/rpc-handlers.js";
import { TemporaryGrantStore } from "./grants/temporary-store.js";
import { LocalMaterialiser } from "./materializers/local.js";
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
import type { OAuthConnectionLookup } from "./subjects/local.js";

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
    "data",
    "credential-metadata.json",
  );
  const metadataStore = new StaticCredentialMetadataStore(
    credentialMetadataPath,
  );

  // Stub OAuth connection lookup — local OAuth connections are resolved from
  // the assistant's SQLite database which CES cannot access directly. When
  // local OAuth execution is needed, a connection bridge must be added.
  const oauthConnections: OAuthConnectionLookup = {
    getById: () => undefined,
  };

  // Stub SecureKeyBackend — in local mode the backend implementation lives in
  // the assistant process (keychain or encrypted file store). CES cannot import
  // it directly. HTTP/command handlers that require credential materialisation
  // will return a structured error until a CES-native backend is wired in.
  const stubSecureKeyBackend = {
    async get(_key: string) {
      return undefined;
    },
    async set(_key: string, _value: string) {
      return false;
    },
    async delete(_key: string) {
      return "error" as const;
    },
    async list() {
      return [];
    },
  };

  const localMaterialiser = new LocalMaterialiser({
    secureKeyBackend: stubSecureKeyBackend,
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
      sessionId,
    },
  );

  // Register run_authenticated_command handler
  registerCommandExecutionHandler(handlers, {
    executorDeps: {
      persistentStore: persistentGrantStore,
      temporaryStore: temporaryGrantStore,
      materializeCredential: async (_handle) => ({
        ok: false as const,
        error:
          "CES local credential materialisation not yet available. " +
          "A CES-native secure-key backend must be configured.",
      }),
      cesMode: "local",
    },
    defaultWorkspaceDir: join(vellumRoot, "workspace"),
  });

  // Register manage_secure_command_tool handler
  const toolRegistry = new Map<string, { toolName: string; credentialHandle: string; description: string; bundleDigest: string }>();

  registerManageSecureCommandToolHandler(handlers, {
    downloadBundle: async (sourceUrl: string) => {
      const resp = await fetch(sourceUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return Buffer.from(await resp.arrayBuffer());
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
