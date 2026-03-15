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

export {
  CesRpcServer,
  createCesServer,
  createMakeAuthenticatedRequestHandler,
  buildHandlersWithHttp,
} from "./server.js";
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

export { PersistentGrantStore, TemporaryGrantStore } from "./grants/index.js";
export type {
  PersistentGrant,
  TemporaryGrant,
  TemporaryGrantKind,
} from "./grants/index.js";

export { computeDigest, verifyDigest } from "./toolstore/integrity.js";
export type { DigestVerificationResult } from "./toolstore/integrity.js";

export {
  isValidSha256Hex,
  validateSourceUrl,
  isWorkspaceOriginPath,
} from "./toolstore/manifest.js";
export type {
  BundleOrigin,
  ToolstoreManifest,
} from "./toolstore/manifest.js";

export {
  publishBundle,
  readPublishedManifest,
  isBundlePublished,
  getBundleDir,
  getBundleManifestPath,
  getBundleContentPath,
} from "./toolstore/publish.js";
export type {
  PublishRequest,
  PublishResult,
} from "./toolstore/publish.js";

export { resolveLocalSubject } from "./subjects/local.js";
export type {
  ResolvedStaticSubject,
  ResolvedOAuthSubject,
  ResolvedLocalSubject,
  SubjectResolutionResult,
  OAuthConnectionLookup,
  LocalSubjectResolverDeps,
} from "./subjects/local.js";

export { LocalMaterialiser } from "./materializers/local.js";
export type {
  MaterialisedCredential,
  MaterialisationResult,
  TokenRefreshFn,
  LocalMaterialiserDeps,
} from "./materializers/local.js";

export { executeAuthenticatedHttpRequest } from "./http/executor.js";
export type { HttpExecutorDeps } from "./http/executor.js";
