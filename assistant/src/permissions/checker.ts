import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { loadSkillCatalog, resolveSkillSelector } from "../config/skills.js";
import { ipcClassifyRisk } from "../ipc/gateway-client.js";
import {
  MEMORY_RETROSPECTIVE_ORIGIN,
  SKILL_MANAGEMENT_SKILL_ID,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { indexCatalogById } from "../skills/include-graph.js";
import { getSkillRoots } from "../skills/path-classifier.js";
import { computeTransitiveSkillVersionHash } from "../skills/transitive-version-hash.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { ManifestOverride } from "../tools/execution-target.js";
import {
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
} from "../tools/network/url-safety.js";
import { getTool, getToolOwner, resolveTool } from "../tools/registry.js";
import { resolveRealPath } from "../tools/shared/filesystem/path-policy.js";
import type { Tool } from "../tools/types.js";
import {
  getDeprecatedDir,
  getMonitoringDataDir,
  getProtectedDir,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
  getWorkspaceToolsDir,
  getWorkspaceWorkflowsDir,
} from "../util/platform.js";
import {
  type ApprovalContext,
  DefaultApprovalPolicy,
} from "./approval-policy.js";
import { buildChannelPermissionCellQuery } from "./channel-permission-query.js";
import {
  getAutoApproveThreshold,
  refreshAutoApproveThreshold,
} from "./gateway-threshold-reader.js";
import type { RiskAssessment } from "./risk-types.js";
import {
  type AllowlistOption,
  type PermissionCheckResult,
  type PolicyContext,
  RiskLevel,
  type ScopeOption,
} from "./types.js";
import {
  isPathWithinWorkspaceRoot,
  isWorkspaceScopedInvocation,
} from "./workspace-policy.js";

// ── Risk classification cache ────────────────────────────────────────────────
// classifyRisk() is called on every permission check and delegates to the
// gateway via IPC. Cache results keyed on
// (toolName, inputHash, workingDir, manifestOverride).
// Invalidated when trust rules change since risk classification for file tools
// depends on skill source path checks which reference config, but the core
// risk logic is input-deterministic.
/** The result of classifyRisk(): a risk level with an optional human-readable reason. */
export interface RiskClassification {
  level: RiskLevel;
  /** Human-readable explanation of why this risk level was assigned. */
  reason?: string;
}

/**
 * Extended risk classification that includes gateway-provided metadata
 * used by check() for command candidate building and sandbox auto-approve.
 */
interface RiskClassificationWithMeta extends RiskClassification {
  /** Command candidates from the gateway for trust rule matching (bash tools). */
  commandCandidates?: string[];
  /** Action keys from the gateway for trust rule matching (bash tools). */
  actionKeys?: string[];
  /** Whether the command qualifies for sandbox auto-approve (bash tools). */
  sandboxAutoApprove?: boolean;
  /**
   * Lexically-resolved path args from the gateway for bash sandbox
   * auto-approve. Stored in the cache so the symlink escape check can be
   * re-run on cache hits (symlink targets may change between calls).
   */
  sandboxPathArgs?: string[];
  /** Allowlist options from the gateway for generateAllowlistOptions(). */
  allowlistOptions?: AllowlistOption[];
  /** Resolved filesystem path arguments for directory-scoped rule matching. */
  resolvedPaths?: string[];
}

const RISK_CACHE_MAX = 256;
const riskCache = new Map<string, RiskClassificationWithMeta>();

// ── Assessment cache ─────────────────────────────────────────────────────────
// Stores the full ClassificationResult from the gateway so that
// generateAllowlistOptions() can read gateway-produced allowlistOptions
// without re-classifying. Keyed on (toolName, inputHash) — a simpler key
// than the full risk cache since generateAllowlistOptions() does not receive
// workingDir or manifestOverride. Cleared alongside the risk cache.
const assessmentCache = new Map<string, RiskAssessment>();

function assessmentCacheKey(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const { reason: _reason, activity: _activity, ...cacheableInput } = input;
  const inputJson = JSON.stringify(cacheableInput);
  const hash = createHash("sha256").update(inputJson).digest("hex");
  return `${toolName}\0${hash}`;
}

function riskCacheKey(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  manifestOverride?: ManifestOverride,
  fsStateKey?: string,
): string {
  // Strip `reason` and `activity` before computing the cache key — they are
  // cosmetic status text that varies per invocation even for identical tool
  // operations, causing unnecessary cache misses.
  const { reason: _reason, activity: _activity, ...cacheableInput } = input;
  const inputJson = JSON.stringify(cacheableInput);
  const hash = createHash("sha256")
    .update(inputJson)
    .update("\0")
    .update(workingDir ?? "")
    .update("\0")
    .update(manifestOverride ? JSON.stringify(manifestOverride) : "")
    // For file tools, fold in the symlink-resolved target path(s). File risk
    // depends on filesystem state (a symlink can be retargeted under a
    // protected dir between calls), so the same raw input must miss the cache
    // when its canonicalized target changes.
    .update("\0")
    .update(fsStateKey ?? "")
    .digest("hex");
  return `${toolName}\0${hash}`;
}

/**
 * Compute the filesystem-state component of the risk cache key for file tools:
 * the symlink-resolved target path(s). Returns `undefined` for non-file tools
 * (whose risk does not depend on filesystem state).
 */
function fileToolFsStateKey(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
): string | undefined {
  if (!FILE_TOOL_NAMES.has(toolName)) {
    return undefined;
  }
  const resolved = resolveFileToolPaths(toolName, input, workingDir);
  return `${resolved.resolvedPath ?? ""}\0${resolved.resolvedTransferDestPath ?? ""}`;
}

/** Clear the risk classification cache. Called when trust rules change. Exported for test setup. */
export function clearRiskCache(): void {
  riskCache.clear();
  assessmentCache.clear();
}

// ── Approval policy singleton ────────────────────────────────────────────────
const defaultApprovalPolicy = new DefaultApprovalPolicy();

function getStringField(
  input: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/**
 * Resolve a skill selector to its id and version hash. The version hash
 * is always computed from disk so that untrusted input cannot spoof a
 * pre-approved hash. If disk computation fails, only the bare id is returned.
 */
function resolveSkillIdAndHash(
  selector: string,
): { id: string; versionHash?: string } | null {
  const resolved = resolveSkillSelector(selector);
  if (!resolved.skill) {
    return null;
  }

  try {
    const hash = computeSkillVersionHash(resolved.skill.directoryPath);
    return { id: resolved.skill.id, versionHash: hash };
  } catch {
    return { id: resolved.skill.id };
  }
}

/**
 * Resolve whether the skill that owns this tool is bundled (first-party).
 * Returns false when the tool has no owning skill or the skill is not in
 * the catalog. Derived from `loadSkillCatalog()` at check time so the
 * answer reflects current catalog truth (managed overrides flip the bit
 * without needing to re-register tools). Owner is looked up from the tool
 * registry (`getToolOwner(name)`) rather than read from the `Tool` object,
 * since ownership lives on the registry, not on the tool itself.
 */
function isToolOwnerSkillBundled(tool: Tool | undefined): boolean {
  if (!tool) {
    return false;
  }
  const owner = getToolOwner(tool.name);
  if (owner?.kind !== "skill") {
    return false;
  }
  const skill = loadSkillCatalog().find((s) => s.id === owner.id);
  return skill?.bundled ?? false;
}

/**
 * Check whether a skill (by id) has parsed inline command expansions.
 * Returns false when the skill is not found in the catalog.
 */
function hasInlineExpansions(skillId: string): boolean {
  const catalog = loadSkillCatalog();
  const skill = catalog.find((s) => s.id === skillId);
  return (
    skill?.inlineCommandExpansions != null &&
    skill.inlineCommandExpansions.length > 0
  );
}

/**
 * Whether this invocation is an inline-command ("dynamic") skill load: a
 * `skill_load` whose resolved skill carries inline command expansions,
 * which execute shell commands at load time via child_process.spawn.
 * Exported for the non-interactive guardian gate in
 * tools/permission-checker.ts — a prompted dynamic load must never be
 * silently auto-approved without a human present. (A pinned trust rule
 * that covers the load lowers its classified risk upstream, so covered
 * loads resolve to "allow" before that gate is reached.)
 */
export function isDynamicSkillLoadInvocation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName !== "skill_load") {
    return false;
  }
  const selector = getStringField(input, "skill").trim();
  if (!selector) {
    return false;
  }
  const resolved = resolveSkillIdAndHash(selector);
  return resolved !== null && hasInlineExpansions(resolved.id);
}

/**
 * Compute the transitive version hash for a skill, returning `undefined`
 * when computation fails (missing includes, cycle, etc.). The permission
 * layer falls back to the any-version candidate in that case.
 */
function computeTransitiveHashSafe(skillId: string): string | undefined {
  try {
    const catalog = loadSkillCatalog();
    const index = indexCatalogById(catalog);
    return computeTransitiveSkillVersionHash(skillId, index);
  } catch {
    return undefined;
  }
}

function canonicalizeWebFetchUrl(parsed: URL): URL {
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";

  try {
    // Normalize equivalent escaped paths (for example, "/%70rivate" -> "/private")
    // so path-scoped trust rules cannot be bypassed via percent-encoding.
    parsed.pathname = decodeURI(parsed.pathname);
  } catch {
    // Keep URL parser canonical form when decoding fails.
  }

  if (parsed.hostname.endsWith(".")) {
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  }

  return parsed;
}

function normalizeWebFetchUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (looksLikeHostPortShorthand(trimmed)) {
    try {
      return canonicalizeWebFetchUrl(new URL(`https://${trimmed}`));
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return canonicalizeWebFetchUrl(parsed);
    }
    return null;
  } catch {
    // Fall through.
  }

  if (looksLikePathOnlyInput(trimmed)) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  try {
    return canonicalizeWebFetchUrl(new URL(`https://${trimmed}`));
  } catch {
    return null;
  }
}

function escapeMinimatchLiteral(value: string): string {
  return value.replace(/([\\*?[\]{}()!+@|])/g, "\\$1");
}

// ── IPC param builders ───────────────────────────────────────────────────────
// Build the ClassifyRiskParams for each tool family. These resolve
// assistant-local context (file paths, skill metadata, etc.) before
// forwarding to the gateway.

import type {
  ClassifyRiskParams,
  FileContext,
  SkillMetadata,
} from "./ipc-risk-types.js";

function buildFileContext(): FileContext {
  const config = getConfig();
  // Canonicalize the protected directories via realpath so that a symlinked
  // component anywhere in their path still prefix-matches the canonicalized
  // target path computed in buildClassifyRiskParams. Both sides must be
  // symlink-resolved for the gateway's lexical prefix checks to be sound.
  const protectedDir = resolveRealPath(getProtectedDir());
  return {
    protectedDir,
    deprecatedDir: resolveRealPath(getDeprecatedDir()),
    hooksDir: resolveRealPath(getWorkspaceHooksDir()),
    pluginsDir: resolveRealPath(getWorkspacePluginsDir()),
    toolsDir: resolveRealPath(getWorkspaceToolsDir()),
    routesDir: resolveRealPath(getWorkspaceRoutesDir()),
    workflowsDir: resolveRealPath(getWorkspaceWorkflowsDir()),
    monitoringDir: resolveRealPath(getMonitoringDataDir()),
    actorTokenSigningKeyPath: join(protectedDir, "actor-token-signing-key"),
    skillSourceDirs: getSkillRoots(config.skills.load.extraDirs).map(
      resolveRealPath,
    ),
  };
}

/**
 * Canonicalize the security-sensitive path of a file tool invocation by
 * resolving symlinks before it is sent to the gateway risk classifier.
 *
 * The gateway classifies file risk by lexically prefix-matching the target
 * path against protected directories (skill source, hooks, plugins, the actor
 * token signing key). Lexical resolution alone does not follow symlinks, so a
 * symlink whose name looks benign but whose real target is a protected
 * directory would be under-classified and could skip the High-risk approval
 * prompt. Resolving symlinks here — on the daemon, which owns the workspace
 * filesystem — closes that gap while keeping the gateway free of filesystem
 * access (it cannot see the workspace in Docker mode).
 *
 * `resolveRealPath` falls back to the lexical path when the target lives on a
 * filesystem this process cannot see (e.g. host_file paths proxied to a remote
 * client), so this never regresses below today's lexical behavior.
 */
// The Docker sandbox mounts the workspace at /workspace, and the model emits
// container-scoped paths (e.g. "/workspace/tools/evil.ts") even on local turns.
// Mirror the gateway's resolveSandboxPath remap so the symlink-resolved path we
// forward lines up with the gateway's lexical fallback and the protected dirs.
const CONTAINER_WORKSPACE_PREFIX = "/workspace/";
const CONTAINER_WORKSPACE_EXACT = "/workspace";

function resolveSandboxBase(rawPath: string, workingDir: string): string {
  let effectivePath = rawPath;
  if (!rawPath.startsWith(workingDir + "/") && rawPath !== workingDir) {
    if (rawPath.startsWith(CONTAINER_WORKSPACE_PREFIX)) {
      effectivePath = rawPath.slice(CONTAINER_WORKSPACE_PREFIX.length);
    } else if (rawPath === CONTAINER_WORKSPACE_EXACT) {
      effectivePath = ".";
    }
  }
  return resolve(workingDir, effectivePath);
}

function resolveClassificationPath(
  filePath: string,
  workingDir: string,
  isHostTool: boolean,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  // Mirror the gateway classifier's lexical base: host tools resolve the path
  // as absolute/relative-to-cwd; sandbox tools apply the /workspace remap and
  // resolve against workingDir. Then follow symlinks so a benign-looking name
  // whose real target is a protected directory is still escalated.
  const base = isHostTool
    ? resolve(filePath)
    : resolveSandboxBase(filePath, workingDir);
  return resolveRealPath(base);
}

const FILE_TOOL_NAMES = new Set([
  "file_read",
  "file_write",
  "file_edit",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
]);

interface FileToolResolution {
  filePath: string;
  effectiveWorkingDir: string;
  isHostTool: boolean;
  resolvedPath?: string;
  transferSandboxDestPath?: string;
  transferSandboxWorkingDir?: string;
  resolvedTransferDestPath?: string;
}

/**
 * Resolve the security-sensitive path(s) of a file tool invocation, including
 * symlink canonicalization. Shared by the IPC param builder and the risk cache
 * key so both observe the same filesystem state — file risk now depends on
 * symlink targets, so the cache must key on the canonicalized path, not just
 * the raw tool input.
 */
function resolveFileToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
): FileToolResolution {
  const isHostTool = toolName.startsWith("host_");
  let filePath: string;
  // For host_file_transfer to_sandbox, the file is written into the workspace
  // at dest_path — capture it (plus the sandbox working dir) so the gateway can
  // escalate writes that land in a code-injection sink, since `path` carries
  // the host-side source.
  let transferSandboxDestPath: string | undefined;
  let transferSandboxWorkingDir: string | undefined;
  if (toolName === "host_file_transfer") {
    // The security-sensitive host-side path is source_path when reading from
    // the host (to_sandbox), dest_path when writing to the host (to_host).
    const direction = getStringField(input, "direction");
    if (direction === "to_sandbox") {
      filePath = getStringField(input, "source_path");
      transferSandboxDestPath = getStringField(input, "dest_path");
      transferSandboxWorkingDir = workingDir ?? process.cwd();
    } else {
      filePath = getStringField(input, "dest_path");
    }
  } else {
    filePath = getStringField(input, "path", "file_path");
  }
  const effectiveWorkingDir = isHostTool ? "/" : (workingDir ?? process.cwd());
  return {
    filePath,
    effectiveWorkingDir,
    isHostTool,
    resolvedPath: resolveClassificationPath(
      filePath,
      effectiveWorkingDir,
      isHostTool,
    ),
    transferSandboxDestPath,
    transferSandboxWorkingDir,
    // The to_sandbox destination is a workspace write — symlink-resolve it too
    // so it can't mask a code-injection sink.
    resolvedTransferDestPath:
      transferSandboxDestPath != null
        ? resolveClassificationPath(
            transferSandboxDestPath,
            transferSandboxWorkingDir ?? process.cwd(),
            false,
          )
        : undefined,
  };
}

function resolveSkillMetadata(selector: string): SkillMetadata | undefined {
  const resolved = resolveSkillIdAndHash(selector);
  if (!resolved) {
    return undefined;
  }

  const inlineExpansions = hasInlineExpansions(resolved.id);

  return {
    skillId: resolved.id,
    selector,
    versionHash: resolved.versionHash ?? "",
    transitiveHash: inlineExpansions
      ? computeTransitiveHashSafe(resolved.id)
      : undefined,
    hasInlineExpansions: inlineExpansions,
    isDynamic: inlineExpansions,
  };
}

function buildClassifyRiskParams(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  manifestOverride?: ManifestOverride,
): ClassifyRiskParams {
  // ── Bash/host_bash ──
  if (toolName === "bash" || toolName === "host_bash") {
    // Count credential references attached to this invocation.
    let credentialRefCount: number | undefined;
    if (Array.isArray(input.credential_ids)) {
      const validIds = (input.credential_ids as unknown[]).filter(
        (id) => typeof id === "string" && id.length > 0,
      );
      if (validIds.length > 0) {
        credentialRefCount = validIds.length;
      }
    }

    return {
      tool: toolName,
      command: getStringField(input, "command"),
      workingDir,
      workspaceRoot: getWorkspaceDir(),
      isContainerized: getIsContainerized(),
      networkMode:
        typeof input.network_mode === "string" ? input.network_mode : undefined,
      credentialRefCount,
    };
  }

  // ── File tools ──
  if (
    [
      "file_read",
      "file_write",
      "file_edit",
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_file_transfer",
    ].includes(toolName)
  ) {
    const resolved = resolveFileToolPaths(toolName, input, workingDir);
    return {
      tool: toolName,
      path: resolved.filePath,
      resolvedPath: resolved.resolvedPath,
      workingDir: resolved.effectiveWorkingDir,
      fileContext: buildFileContext(),
      transferSandboxDestPath: resolved.transferSandboxDestPath,
      transferSandboxWorkingDir: resolved.transferSandboxWorkingDir,
      resolvedTransferDestPath: resolved.resolvedTransferDestPath,
    };
  }

  // ── Web tools ──
  if (["web_fetch", "network_request", "web_search"].includes(toolName)) {
    return {
      tool: toolName,
      url: getStringField(input, "url"),
      allowPrivateNetwork: input.allow_private_network === true,
    };
  }

  // ── Skill tools ──
  if (
    ["skill_load", "scaffold_managed_skill", "delete_managed_skill"].includes(
      toolName,
    )
  ) {
    const selector = getStringField(input, "skill", "skill_id").trim();
    return {
      tool: toolName,
      skill: selector,
      skillMetadata: selector ? resolveSkillMetadata(selector) : undefined,
    };
  }

  // ── Schedule tools ──
  if (toolName === "schedule_create" || toolName === "schedule_update") {
    return {
      tool: toolName,
      mode: getStringField(input, "mode") || undefined,
      script: getStringField(input, "script") || undefined,
    };
  }

  // ── Unknown tools ──
  // Forward the tool's registry default risk level so the gateway can use it
  // instead of hardcoding medium for unknown tools. When the tool is not in the
  // registry but a manifestOverride provides a risk, use that instead.
  const tool = getTool(toolName);
  let registryDefaultRisk: string | undefined;
  if (tool) {
    registryDefaultRisk =
      tool.defaultRiskLevel === RiskLevel.Low
        ? "low"
        : tool.defaultRiskLevel === RiskLevel.High
          ? "high"
          : tool.defaultRiskLevel === RiskLevel.Medium
            ? "medium"
            : undefined;
  } else if (manifestOverride?.risk) {
    registryDefaultRisk = manifestOverride.risk;
  }
  return { tool: toolName, registryDefaultRisk };
}

// ── Risk string → RiskLevel mapping ──────────────────────────────────────────

function riskStringToLevel(risk: string): RiskLevel {
  switch (risk) {
    case "low":
      return RiskLevel.Low;
    case "medium":
      return RiskLevel.Medium;
    case "high":
      return RiskLevel.High;
    default:
      return RiskLevel.Medium;
  }
}

/**
 * Re-check bash sandbox auto-approve path args against the workspace root
 * with symlink resolution. The gateway's lexical check cannot follow
 * symlinks (no filesystem access), so the daemon resolves each path arg
 * through {@link isPathWithinWorkspaceRoot} (which uses realpathSync) and
 * revokes auto-approve if any escapes the workspace boundary.
 *
 * Called both on fresh gateway results and on cache hits, because symlink
 * targets can change between invocations — a path that was safe on the
 * first call may escape on the second if the symlink was retargeted.
 */
function applyBashSymlinkEscapeCheck(
  result: RiskClassificationWithMeta,
  sandboxPathArgs?: string[],
): void {
  if (
    !result.sandboxAutoApprove ||
    !sandboxPathArgs ||
    sandboxPathArgs.length === 0
  ) {
    return;
  }
  const wsRoot = getWorkspaceDir();
  const escaped = sandboxPathArgs.some(
    (p) => !isPathWithinWorkspaceRoot(p, wsRoot),
  );
  if (escaped) {
    result.sandboxAutoApprove = false;
  }
}

export async function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  _preParsed?: unknown,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
): Promise<RiskClassificationWithMeta> {
  signal?.throwIfAborted();

  // Check cache first.
  const cacheKey = riskCacheKey(
    toolName,
    input,
    workingDir,
    manifestOverride,
    fileToolFsStateKey(toolName, input, workingDir),
  );
  const cached = riskCache.get(cacheKey);
  if (cached !== undefined) {
    // LRU refresh
    riskCache.delete(cacheKey);
    riskCache.set(cacheKey, cached);
    // Re-run the symlink escape check on cache hits: symlink targets can
    // change between invocations, so a path that was safe when cached may
    // now escape. Return a shallow copy so the cache entry is not mutated.
    if (cached.sandboxPathArgs && cached.sandboxPathArgs.length > 0) {
      const fresh = { ...cached };
      applyBashSymlinkEscapeCheck(fresh, cached.sandboxPathArgs);
      return fresh;
    }
    return cached;
  }

  // ── Delegate to gateway via IPC ────────────────────────────────────────────
  const ipcParams = buildClassifyRiskParams(
    toolName,
    input,
    workingDir,
    manifestOverride,
  );
  const gatewayResult = await ipcClassifyRisk(ipcParams);

  if (!gatewayResult) {
    throw new Error(
      `Gateway IPC classify_risk failed for tool "${toolName}" — gateway is unreachable or returned an invalid response`,
    );
  }

  const result: RiskClassificationWithMeta = {
    level: riskStringToLevel(gatewayResult.risk),
    reason: gatewayResult.reason,
    commandCandidates: gatewayResult.commandCandidates,
    actionKeys: gatewayResult.actionKeys,
    sandboxAutoApprove: gatewayResult.sandboxAutoApprove,
    sandboxPathArgs: gatewayResult.sandboxPathArgs,
    allowlistOptions: gatewayResult.allowlistOptions,
    resolvedPaths: gatewayResult.resolvedPaths,
  };

  // ── Symlink escape check for bash sandbox auto-approve ───────────────
  // The gateway checks bash path args against the workspace root
  // lexically (path.resolve) — it has no filesystem access to follow
  // symlinks. A symlink inside the workspace pointing outside (e.g.
  // `ln -s /etc /workspace/escape`) would pass the lexical check and
  // be auto-approved. Resolve the gateway-provided path args through
  // symlinks here and revoke auto-approve if any escapes the workspace.
  // The check is also re-run on cache hits (see above) because symlink
  // targets can change between invocations.
  applyBashSymlinkEscapeCheck(result, gatewayResult.sandboxPathArgs);

  // Cache the result.
  if (riskCache.size >= RISK_CACHE_MAX) {
    const oldest = riskCache.keys().next().value;
    if (oldest !== undefined) {
      riskCache.delete(oldest);
    }
  }
  riskCache.set(cacheKey, result);

  // Store a RiskAssessment-shaped entry in the assessment cache so that
  // generateAllowlistOptions() can retrieve gateway-produced allowlistOptions
  // and permission-checker.ts can populate riskScopeOptions for the Rule
  // Editor Modal via cachedAssessment.scopeOptions.
  const assessment: RiskAssessment = {
    riskLevel: gatewayResult.risk === "unknown" ? "medium" : gatewayResult.risk,
    reason: gatewayResult.reason,
    scopeOptions: gatewayResult.scopeOptions ?? [],
    matchType: gatewayResult.matchType ?? "unknown",
    allowlistOptions: gatewayResult.allowlistOptions,
    directoryScopeOptions: gatewayResult.directoryScopeOptions,
    resolvedPaths: gatewayResult.resolvedPaths,
  };
  const aKey = assessmentCacheKey(toolName, input);
  if (assessmentCache.size >= RISK_CACHE_MAX) {
    const oldest = assessmentCache.keys().next().value;
    if (oldest !== undefined) {
      assessmentCache.delete(oldest);
    }
  }
  assessmentCache.set(aKey, assessment);

  return result;
}

// ── Background memory-retrospective skill-authoring auto-grant ────────────────
// Skill scaffolding (`scaffold_managed_skill`, risk: high + allowlist-gated),
// finding similar skills (`find_similar_skills`), and loading the
// `skill-management` skill (`skill_load skill-management`, which exposes the
// scaffold tool) require an interactive approval. The memory-retrospective
// background job runs without any connected client, so it can never answer that
// prompt. The grant resolves these tools to ALLOW non-interactively, and ONLY
// when all of these hold:
//   - procedural-memory-as-skills is active (`policyContext.procToSkillsActive`,
//     precomputed by buildPolicyContext: memory-v3 is live),
//   - the turn is the retrospective background source — guardian trust, `vellum`
//     source channel, `memory_retrospective` origin (set in
//     memory-retrospective-job.ts).
//
// The grant is intentionally narrow: it matches exactly these tools AND the
// retrospective origin on a v3-live assistant, so no interactive session, other
// origin, or non-v3-live install is affected.
function isRetrospectiveSkillAuthoringGrant(
  toolName: string,
  input: Record<string, unknown>,
  policyContext?: PolicyContext,
): boolean {
  if (
    policyContext?.procToSkillsActive !== true ||
    policyContext.requestOrigin !== MEMORY_RETROSPECTIVE_ORIGIN ||
    policyContext.trustClass !== "guardian" ||
    policyContext.sourceChannel !== "vellum"
  ) {
    return false;
  }
  if (toolName === "scaffold_managed_skill") {
    return true;
  }
  if (toolName === "find_similar_skills") {
    return true;
  }
  if (toolName === "skill_load") {
    return (
      getStringField(input, "skill", "skill_id").trim() ===
      SKILL_MANAGEMENT_SKILL_ID
    );
  }
  return false;
}

export async function check(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
  policyContext?: PolicyContext,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
): Promise<PermissionCheckResult> {
  signal?.throwIfAborted();

  if (isRetrospectiveSkillAuthoringGrant(toolName, input, policyContext)) {
    return {
      decision: "allow",
      reason:
        "Memory retrospective background session: skill authoring auto-approved",
    };
  }

  const classification = await classifyRisk(
    toolName,
    input,
    workingDir,
    undefined,
    manifestOverride,
    signal,
  );

  const { level: risk, reason: riskReason } = classification;

  // Use gateway-provided sandboxAutoApprove instead of evaluating locally.
  const hasSandboxAutoApprove = classification.sandboxAutoApprove ?? false;

  // Build approval context from local variables
  const tool = await resolveTool(toolName);
  const cellQuery = buildChannelPermissionCellQuery(policyContext);
  const threshold = await getAutoApproveThreshold(
    policyContext?.conversationId,
    policyContext?.executionContext,
    cellQuery,
  );
  const approvalContext: ApprovalContext = {
    riskLevel: risk,
    toolName,
    isContainerized: getIsContainerized(),
    isWorkspaceScoped:
      risk === RiskLevel.Low
        ? isWorkspaceScopedInvocation(toolName, input, workingDir)
        : false,
    toolOrigin: getToolOwner(toolName)?.kind,
    isSkillBundled: isToolOwnerSkillBundled(tool),
    hasManifestOverride: !!manifestOverride,
    autoApproveUpTo: threshold,
    hasSandboxAutoApprove,
  };

  // Delegate the allow/prompt/deny decision to the approval policy
  let approvalDecision = defaultApprovalPolicy.evaluate(approvalContext);

  // A "prompt" computed from a cached threshold may contradict a setting
  // the user just changed: the reader caches thresholds (5s conversation /
  // 30s global TTL) and no threshold write path invalidates this process's
  // caches. Re-read the threshold fresh before interrupting the user; when
  // the current value differs, re-evaluate so e.g. Full access never
  // prompts. A failed refresh returns null and keeps the prompt — fail
  // toward asking, never toward silent approval.
  if (approvalDecision.decision === "prompt") {
    const freshThreshold = await refreshAutoApproveThreshold(
      policyContext?.conversationId,
      policyContext?.executionContext,
      cellQuery,
    );
    if (freshThreshold !== null && freshThreshold !== threshold) {
      approvalDecision = defaultApprovalPolicy.evaluate({
        ...approvalContext,
        autoApproveUpTo: freshThreshold,
      });
    }
  }

  // Inline-command ("dynamic") skill loads execute embedded shell commands
  // at load time, so a threshold-based allow is not enough: they run
  // without asking only when the user's own trust rule covers them (the
  // rule re-classifies the risk inside the gateway, arriving here as
  // matchType "user_rule"). Everything else prompts — at every threshold
  // and in every execution context. The non-interactive guardian gate in
  // tools/permission-checker.ts then converts the prompt into a denial
  // when no human is present to answer it.
  if (
    approvalDecision.decision === "allow" &&
    isDynamicSkillLoadInvocation(toolName, input) &&
    getCachedAssessment(toolName, input)?.matchType !== "user_rule"
  ) {
    approvalDecision = {
      decision: "prompt",
      reason:
        "Inline-command skill load: executes embedded commands, requires explicit approval",
    };
  }

  // Enrich the reason with the classifier's explanation when available.
  // For risk-based fallback decisions (prompt/deny from High/Medium risk),
  // incorporate the classifier reason so the user sees *why* the command
  // was classified at that level (e.g. "High risk (Recursive force delete): requires approval").
  let enrichedReason = approvalDecision.reason;
  if (riskReason) {
    const riskLabelMatch = enrichedReason.match(
      /^(High|Medium|Low|high|medium|low) risk(.*)/i,
    );
    if (riskLabelMatch) {
      const capitalizedLabel =
        riskLabelMatch[1].charAt(0).toUpperCase() +
        riskLabelMatch[1].slice(1).toLowerCase();
      enrichedReason = `${capitalizedLabel} risk (${riskReason})${riskLabelMatch[2]}`;
    }
  }

  return {
    decision: approvalDecision.decision,
    reason: enrichedReason,
    hasSandboxAutoApprove:
      approvalDecision.reason ===
        "Workspace filesystem operation (sandbox auto-approve)" || undefined,
  };
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  file_read: "file reads",
  file_write: "file writes",
  file_edit: "file edits",
  host_file_read: "host file reads",
  host_file_write: "host file writes",
  host_file_edit: "host file edits",
  host_file_transfer: "host file transfers",
  web_fetch: "URL fetches",
  network_request: "network requests",
};

function friendlyBasename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function friendlyHostname(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

// ── Per-tool allowlist option strategies ─────────────────────────────────────
// Each strategy receives the tool name and raw input and returns allowlist
// options. Adding support for a new tool type means adding a function here
// and registering it in ALLOWLIST_STRATEGIES below.

type AllowlistStrategy = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<AllowlistOption[]> | AllowlistOption[];

function fileAllowlistStrategy(
  toolName: string,
  input: Record<string, unknown>,
): AllowlistOption[] {
  let filePath: string;
  if (toolName === "host_file_transfer") {
    // Use the host-side path: source_path for to_sandbox, dest_path for to_host.
    const direction = (input.direction as string) ?? "";
    filePath =
      direction === "to_sandbox"
        ? ((input.source_path as string) ?? "")
        : ((input.dest_path as string) ?? "");
  } else {
    filePath =
      (input.path as string) ??
      (input.file_path as string) ??
      (input.dest_path as string) ??
      (input.source_path as string) ??
      "";
  }
  const toolLabel = TOOL_DISPLAY_NAMES[toolName] ?? toolName;
  const options: AllowlistOption[] = [];

  // Patterns must match the "tool:path" format used by check()
  options.push({
    label: filePath,
    description: `This file only`,
    pattern: `${toolName}:${filePath}`,
  });

  // Ancestor directory wildcards — walk up from immediate parent, stop at home dir or /
  const home = homedir();
  let dir = dirname(filePath);
  const maxLevels = 3;
  let levels = 0;
  while (dir && dir !== "/" && dir !== "." && levels < maxLevels) {
    const dirName = friendlyBasename(dir);
    options.push({
      label: `${dir}/**`,
      description: `Anything in ${dirName}/`,
      pattern: `${toolName}:${dir}/**`,
    });
    if (dir === home) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
    levels++;
  }

  options.push({
    label: `${toolName}:*`,
    description: `All ${toolLabel}`,
    pattern: `${toolName}:*`,
  });
  return options;
}

function urlAllowlistStrategy(
  toolName: string,
  input: Record<string, unknown>,
): AllowlistOption[] {
  const rawUrl = getStringField(input, "url").trim();
  const normalized = normalizeWebFetchUrl(rawUrl);
  const exact = normalized?.href ?? rawUrl;

  const options: AllowlistOption[] = [];
  if (exact) {
    options.push({
      label: exact,
      description: "This exact URL",
      pattern: `${toolName}:${escapeMinimatchLiteral(exact)}`,
    });
  }
  if (normalized) {
    const host = friendlyHostname(normalized);
    options.push({
      label: `${normalized.origin}/*`,
      description: `Any page on ${host}`,
      pattern: `${toolName}:${escapeMinimatchLiteral(normalized.origin)}/*`,
    });
  }
  const toolLabel = TOOL_DISPLAY_NAMES[toolName] ?? toolName;
  // Use standalone "**" globstar — minimatch only treats ** as globstar when
  // it is its own path segment, so "${toolName}:*" would fail to match URL
  // candidates containing "/".  The tool field is already filtered separately.
  options.push({
    label: `${toolName}:*`,
    description: `All ${toolLabel}`,
    pattern: `**`,
  });

  const seen = new Set<string>();
  return options.filter((o) => {
    if (seen.has(o.pattern)) {
      return false;
    }
    seen.add(o.pattern);
    return true;
  });
}

function managedSkillAllowlistStrategy(
  toolName: string,
  input: Record<string, unknown>,
): AllowlistOption[] {
  const skillId = getStringField(input, "skill_id").trim();
  const toolLabel =
    toolName === "scaffold_managed_skill" ? "scaffold" : "delete";
  const options: AllowlistOption[] = [];
  if (skillId) {
    options.push({
      label: skillId,
      description: `This skill only`,
      pattern: `${toolName}:${skillId}`,
    });
  }
  options.push({
    label: `${toolName}:*`,
    description: `All managed skill ${toolLabel}s`,
    pattern: `${toolName}:*`,
  });
  return options;
}

function skillLoadAllowlistStrategy(
  _toolName: string,
  input: Record<string, unknown>,
): AllowlistOption[] {
  const rawSelector = getStringField(input, "skill").trim();

  if (rawSelector) {
    const resolved = resolveSkillIdAndHash(rawSelector);

    if (resolved && hasInlineExpansions(resolved.id)) {
      const transitiveHash = computeTransitiveHashSafe(resolved.id);
      const options: AllowlistOption[] = [];
      if (transitiveHash) {
        options.push({
          label: `${resolved.id}@${transitiveHash}`,
          description: "This exact version (pinned)",
          pattern: `skill_load_dynamic:${resolved.id}@${transitiveHash}`,
        });
      }
      options.push({
        label: resolved.id,
        description: "This skill (any version)",
        pattern: `skill_load_dynamic:${resolved.id}`,
      });
      return options;
    }

    if (resolved && resolved.versionHash) {
      return [
        {
          label: `${resolved.id}@${resolved.versionHash}`,
          description: "This exact version",
          pattern: `skill_load:${resolved.id}@${resolved.versionHash}`,
        },
      ];
    }
    return [
      {
        label: rawSelector,
        description: "This skill",
        pattern: `skill_load:${rawSelector}`,
      },
    ];
  }

  return [
    {
      label: "skill_load:*",
      description: "All skill loads",
      pattern: "skill_load:*",
    },
  ];
}

const ALLOWLIST_STRATEGIES: Record<string, AllowlistStrategy> = {
  file_read: fileAllowlistStrategy,
  file_write: fileAllowlistStrategy,
  file_edit: fileAllowlistStrategy,
  host_file_read: fileAllowlistStrategy,
  host_file_write: fileAllowlistStrategy,
  host_file_edit: fileAllowlistStrategy,
  host_file_transfer: fileAllowlistStrategy,
  web_fetch: urlAllowlistStrategy,
  network_request: urlAllowlistStrategy,
  scaffold_managed_skill: managedSkillAllowlistStrategy,
  delete_managed_skill: managedSkillAllowlistStrategy,
  skill_load: skillLoadAllowlistStrategy,
};

export async function generateAllowlistOptions(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AllowlistOption[]> {
  signal?.throwIfAborted();

  // Use gateway-produced allowlist options from the assessment cache.
  // For bash/host_bash tools, these are always provided by the gateway.
  // For other tools that have classifier-produced options, use those too.
  const aKey = assessmentCacheKey(toolName, input);
  const cachedAssessment = assessmentCache.get(aKey);
  if (
    cachedAssessment?.allowlistOptions &&
    cachedAssessment.allowlistOptions.length > 0
  ) {
    return cachedAssessment.allowlistOptions;
  }

  // Fall back to the per-tool strategy function for non-bash tools
  // or when no cached assessment exists.
  if (Object.hasOwn(ALLOWLIST_STRATEGIES, toolName)) {
    return ALLOWLIST_STRATEGIES[toolName](toolName, input);
  }

  return [{ label: "*", description: "Everything", pattern: "*" }];
}

/**
 * Retrieve a cached RiskAssessment for a given tool invocation.
 * Returns `undefined` when no classifier-backed assessment exists
 * (e.g. MCP tools, unknown tools that fall through to registry defaults).
 */
export function getCachedAssessment(
  toolName: string,
  input: Record<string, unknown>,
): RiskAssessment | undefined {
  return assessmentCache.get(assessmentCacheKey(toolName, input));
}

// Directory-based scope only applies to filesystem and shell tools.
// All other tools auto-use "everywhere" (the client handles this).
export const SCOPE_AWARE_TOOLS = new Set([
  "bash",
  "host_bash",
  "file_read",
  "file_write",
  "file_edit",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
]);

export function generateScopeOptions(
  workingDir: string,
  toolName?: string,
): ScopeOption[] {
  if (toolName && !SCOPE_AWARE_TOOLS.has(toolName)) {
    return [];
  }

  const home = homedir();
  const options: ScopeOption[] = [];

  // Project directory
  const displayDir = workingDir.startsWith(home)
    ? "~" + workingDir.slice(home.length)
    : workingDir;
  options.push({ label: displayDir, scope: workingDir });

  // Parent directory
  const parentDir = dirname(workingDir);
  if (parentDir !== workingDir) {
    const displayParent = parentDir.startsWith(home)
      ? "~" + parentDir.slice(home.length)
      : parentDir;
    options.push({ label: `${displayParent}/*`, scope: parentDir });
  }

  // Everywhere
  options.push({ label: "everywhere", scope: "everywhere" });

  return options;
}
