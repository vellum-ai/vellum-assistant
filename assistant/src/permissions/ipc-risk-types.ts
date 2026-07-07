/**
 * Types for gateway IPC risk classification.
 *
 * These types mirror the gateway's classify_risk IPC response shape
 * (gateway/src/ipc/risk-classification-handlers.ts) and request parameters.
 * Keep in sync when the gateway response evolves.
 */

import type { DirectoryScopeOption, ScopeOption } from "./risk-types.js";
import type { AllowlistOption } from "./types.js";

// ── Dangerous pattern (mirrors gateway wire format) ─────────────────────────

export interface DangerousPattern {
  type: string;
  description: string;
  text: string;
}

// ── Gateway response type ───────────────────────────────────────────────────

/**
 * The response returned by the gateway's `classify_risk` IPC method.
 *
 * Mirrors the `ClassificationResult` in
 * `gateway/src/ipc/risk-classification-handlers.ts`.
 */
export interface ClassificationResult {
  risk: "low" | "medium" | "high" | "unknown";
  reason: string;
  matchType: "user_rule" | "registry" | "unknown";
  scopeOptions: ScopeOption[];
  allowlistOptions?: AllowlistOption[];
  directoryScopeOptions?: DirectoryScopeOption[];
  resolvedPaths?: string[];
  actionKeys?: string[];
  commandCandidates?: string[];
  dangerousPatterns?: DangerousPattern[];
  opaqueConstructs?: boolean;
  isComplexSyntax?: boolean;
  sandboxAutoApprove?: boolean;
  /**
   * Lexically-resolved path arguments from sandbox-auto-approve-eligible
   * bash segments. The daemon resolves these through symlinks (via
   * {@link isPathWithinWorkspaceRoot}) and overrides sandboxAutoApprove to
   * false if any resolves outside the workspace. Closes the symlink-escape
   * gap: the gateway's lexical check passes a path like
   * `/workspace/escape/passwd` (symlink → `/etc/passwd`) because it cannot
   * follow symlinks, but the daemon can.
   */
  sandboxPathArgs?: string[];
}

// ── Gateway request type ────────────────────────────────────────────────────

/**
 * File classifier context pre-resolved by the assistant and forwarded
 * to the gateway so it can run file-risk classification without importing
 * assistant-specific path helpers.
 */
export interface FileContext {
  protectedDir: string;
  deprecatedDir: string;
  hooksDir: string;
  pluginsDir: string;
  toolsDir: string;
  routesDir: string;
  workflowsDir: string;
  /** Monitoring data dir — sentinel lives here, writes are code-injection risk. */
  monitoringDir: string;
  actorTokenSigningKeyPath: string;
  skillSourceDirs: string[];
}

/**
 * Skill metadata pre-resolved by the assistant and forwarded to the
 * gateway for skill-load risk classification.
 */
export interface SkillMetadata {
  skillId: string;
  selector: string;
  versionHash: string;
  transitiveHash?: string;
  hasInlineExpansions: boolean;
  isDynamic: boolean;
}

/**
 * Parameters for the `classify_risk` IPC request.
 *
 * Mirrors the Zod schema in
 * `gateway/src/ipc/risk-classification-handlers.ts`.
 */
export interface ClassifyRiskParams {
  tool: string;
  command?: string;
  url?: string;
  path?: string;
  /**
   * The file tool's target path with symlinks resolved (canonicalized by the
   * daemon, which owns the workspace filesystem). The gateway uses this for its
   * security escalation prefix checks so a symlink cannot mask a write into a
   * protected directory. Falls back to lexical `path` resolution when absent.
   */
  resolvedPath?: string;
  skill?: string;
  mode?: string;
  script?: string;
  workingDir?: string;
  workspaceRoot?: string;
  allowPrivateNetwork?: boolean;
  networkMode?: string;
  isContainerized?: boolean;
  fileContext?: FileContext;
  skillMetadata?: SkillMetadata;
  /** Tool registry default risk level for unknown tools. */
  registryDefaultRisk?: string;
  /** Number of credential references attached to this tool invocation. */
  credentialRefCount?: number;
  /**
   * For host_file_transfer with `direction: "to_sandbox"`: the workspace-side
   * destination path and the sandbox working directory it resolves against, so
   * the gateway can escalate transfers that install an executable file in a
   * code-injection sink (tools/routes/hooks/plugins/skills).
   */
  transferSandboxDestPath?: string;
  transferSandboxWorkingDir?: string;
  /**
   * The `to_sandbox` workspace destination with symlinks resolved
   * (canonicalized by the daemon). Used for the code-injection-sink check so a
   * symlinked destination cannot mask the real target. Falls back to lexical
   * resolution of `transferSandboxDestPath` when absent.
   */
  resolvedTransferDestPath?: string;
}
