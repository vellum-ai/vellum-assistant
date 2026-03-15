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

import { CES_PROTOCOL_VERSION } from "@vellumai/ces-contracts";

import {
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesToolStoreDir,
} from "./paths.js";
import { CesRpcServer, type RpcHandlerRegistry } from "./server.js";

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
// Stub RPC handlers (real implementations will be added in subsequent PRs)
// ---------------------------------------------------------------------------

const handlers: RpcHandlerRegistry = {
  // Placeholder — each RPC method will be wired to its implementation
  // as the respective PRs land.
};

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
