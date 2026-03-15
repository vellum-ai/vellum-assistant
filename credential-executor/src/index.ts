#!/usr/bin/env bun
/**
 * @vellumai/credential-executor
 *
 * Credential Execution Service (CES) — an isolated runtime that executes
 * credential-bearing tool operations on behalf of untrusted agents. The CES
 * receives RPC requests from the assistant daemon, materialises credentials
 * from the local credential store, executes the requested operation through
 * the egress proxy, and returns sanitised results.
 *
 * This module re-exports the public API surface. For entrypoints see:
 * - `main.ts` — local mode (stdio transport, child process)
 * - `managed-main.ts` — managed mode (Unix socket transport, sidecar)
 */

export { CesRpcServer, createCesServer } from "./server.js";
export type {
  CesServerOptions,
  RpcHandlerRegistry,
  RpcMethodHandler,
} from "./server.js";

export {
  getCesDataRoot,
  getCesGrantsDir,
  getCesAuditDir,
  getCesToolStoreDir,
  getCesMode,
  getBootstrapSocketPath,
  getHealthPort,
} from "./paths.js";
export type { CesMode } from "./paths.js";
