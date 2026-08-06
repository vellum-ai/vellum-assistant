#!/usr/bin/env bun
/**
 * @vellumai/credential-executor
 *
 * Credential Execution Service (CES) — an isolated runtime that stores and
 * serves credentials on behalf of the assistant daemon over RPC. The CES owns
 * the credential store and exposes credential CRUD operations (get, set,
 * delete, list, bulk-set) plus the managed-credential update handshake.
 *
 * This module re-exports the public API surface. For the entrypoint see
 * `main.ts` — unified for both local (bare-metal sibling) and managed
 * (Kubernetes sidecar) modes, selected by `getCesMode()`.
 */

export { CesRpcServer, createCesServer } from "./server.js";
export type {
  CesServerOptions,
  RpcHandlerRegistry,
  RpcMethodHandler,
  SessionContext,
} from "./server.js";

export {
  getCesDataRoot,
  getCesMode,
  getBootstrapSocketPath,
  getHealthPort,
} from "./paths.js";
export type { CesMode } from "./paths.js";
