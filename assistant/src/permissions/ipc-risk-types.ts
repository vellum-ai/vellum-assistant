/**
 * Types for gateway IPC risk classification.
 *
 * These types mirror the gateway's classify_risk IPC response shape
 * (gateway/src/ipc/risk-classification-handlers.ts) and request parameters.
 * Keep them in sync when the gateway response evolves.
 */

import type { ScopeOption } from "./risk-types.js";
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
  actionKeys?: string[];
  commandCandidates?: string[];
  dangerousPatterns?: DangerousPattern[];
  opaqueConstructs?: boolean;
  isComplexSyntax?: boolean;
  sandboxAutoApprove?: boolean;
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
}
