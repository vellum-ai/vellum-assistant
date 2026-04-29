import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { loadSkillCatalog, resolveSkillSelector } from "../config/skills.js";
import { ipcClassifyRisk } from "../ipc/gateway-client.js";
import { indexCatalogById } from "../skills/include-graph.js";
import { getSkillRoots } from "../skills/path-classifier.js";
import { computeTransitiveSkillVersionHash } from "../skills/transitive-version-hash.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { ManifestOverride } from "../tools/execution-target.js";
import {
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
} from "../tools/network/url-safety.js";
import { getTool } from "../tools/registry.js";
import {
  getDeprecatedDir,
  getProtectedDir,
  getWorkspaceDir,
  getWorkspaceHooksDir,
} from "../util/platform.js";
import {
  type ApprovalContext,
  DefaultApprovalPolicy,
} from "./approval-policy.js";
import { getAutoApproveThreshold } from "./gateway-threshold-reader.js";
import type { RiskAssessment } from "./risk-types.js";
import {
  type AllowlistOption,
  type PermissionCheckResult,
  type PolicyContext,
  RiskLevel,
  type ScopeOption,
} from "./types.js";
import { isWorkspaceScopedInvocation } from "./workspace-policy.js";

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
    .digest("hex");
  return `${toolName}\0${hash}`;
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
    if (typeof value === "string") return value;
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
  if (!resolved.skill) return null;

  try {
    const hash = computeSkillVersionHash(resolved.skill.directoryPath);
    return { id: resolved.skill.id, versionHash: hash };
  } catch {
    return { id: resolved.skill.id };
  }
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
  if (!trimmed) return null;

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
  return {
    protectedDir: getProtectedDir(),
    deprecatedDir: getDeprecatedDir(),
    hooksDir: getWorkspaceHooksDir(),
    actorTokenSigningKeyPath: join(
      getProtectedDir(),
      "actor-token-signing-key",
    ),
    skillSourceDirs: getSkillRoots(config.skills.load.extraDirs),
  };
}

function resolveSkillMetadata(selector: string): SkillMetadata | undefined {
  const resolved = resolveSkillIdAndHash(selector);
  if (!resolved) return undefined;

  const config = getConfig();
  const inlineEnabled = isAssistantFeatureFlagEnabled(
    "inline-skill-commands",
    config,
  );
  const inlineExpansions = hasInlineExpansions(resolved.id);
  const isDynamic = inlineEnabled && inlineExpansions;

  return {
    skillId: resolved.id,
    selector,
    versionHash: resolved.versionHash ?? "",
    transitiveHash: isDynamic
      ? computeTransitiveHashSafe(resolved.id)
      : undefined,
    hasInlineExpansions: inlineExpansions,
    isDynamic,
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
    return {
      tool: toolName,
      command: getStringField(input, "command"),
      workingDir,
      workspaceRoot: getWorkspaceDir(),
      isContainerized: getIsContainerized(),
      networkMode:
        typeof input.network_mode === "string" ? input.network_mode : undefined,
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
    const isHostTool = toolName.startsWith("host_");
    let filePath: string;
    if (toolName === "host_file_transfer") {
      // For host_file_transfer the security-sensitive path is the host-side
      // path: source_path when reading from the host (to_sandbox), dest_path
      // when writing to the host (to_host).
      const direction = getStringField(input, "direction");
      filePath =
        direction === "to_sandbox"
          ? getStringField(input, "source_path")
          : getStringField(input, "dest_path");
    } else {
      filePath = getStringField(input, "path", "file_path");
    }
    return {
      tool: toolName,
      path: filePath,
      workingDir: isHostTool ? "/" : (workingDir ?? process.cwd()),
      fileContext: buildFileContext(),
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
  const cacheKey = riskCacheKey(toolName, input, workingDir, manifestOverride);
  const cached = riskCache.get(cacheKey);
  if (cached !== undefined) {
    // LRU refresh
    riskCache.delete(cacheKey);
    riskCache.set(cacheKey, cached);
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
    allowlistOptions: gatewayResult.allowlistOptions,
    resolvedPaths: gatewayResult.resolvedPaths,
  };

  // Cache the result.
  if (riskCache.size >= RISK_CACHE_MAX) {
    const oldest = riskCache.keys().next().value;
    if (oldest !== undefined) riskCache.delete(oldest);
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
    if (oldest !== undefined) assessmentCache.delete(oldest);
  }
  assessmentCache.set(aKey, assessment);

  return result;
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
  const tool = getTool(toolName);
  const threshold = await getAutoApproveThreshold(
    policyContext?.conversationId,
    policyContext?.executionContext,
  );
  const approvalContext: ApprovalContext = {
    riskLevel: risk,
    toolName,
    isContainerized: getIsContainerized(),
    isWorkspaceScoped:
      risk === RiskLevel.Low
        ? isWorkspaceScopedInvocation(toolName, input, workingDir)
        : false,
    toolOrigin:
      tool?.origin === "skill" || tool?.origin === "plugin"
        ? "skill"
        : tool
          ? "builtin"
          : undefined,
    isSkillBundled: tool?.ownerSkillBundled ?? false,
    hasManifestOverride: !!manifestOverride,
    autoApproveUpTo: threshold,
    hasSandboxAutoApprove,
  };

  // Delegate the allow/prompt/deny decision to the approval policy
  const approvalDecision = defaultApprovalPolicy.evaluate(approvalContext);

  // Enrich the reason with the classifier's explanation when available.
  // For risk-based fallback decisions (prompt/deny from High/Medium risk),
  // incorporate the classifier reason so the user sees *why* the command
  // was classified at that level (e.g. "High risk (Recursive force delete): requires approval").
  let enrichedReason = approvalDecision.reason;
  if (riskReason && !approvalDecision.matchedRule) {
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
    matchedRule: approvalDecision.matchedRule,
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
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
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
    if (seen.has(o.pattern)) return false;
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

    // Check whether this is a dynamic (inline-command) skill load
    const config = getConfig();
    const inlineEnabled = isAssistantFeatureFlagEnabled(
      "inline-skill-commands",
      config,
    );

    if (resolved && inlineEnabled && hasInlineExpansions(resolved.id)) {
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
