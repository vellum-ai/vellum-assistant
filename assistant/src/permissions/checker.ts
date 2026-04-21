import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { loadSkillCatalog, resolveSkillSelector } from "../config/skills.js";
import { indexCatalogById } from "../skills/include-graph.js";
import { normalizeFilePath } from "../skills/path-classifier.js";
import { computeTransitiveSkillVersionHash } from "../skills/transitive-version-hash.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { ManifestOverride } from "../tools/execution-target.js";
import {
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
} from "../tools/network/url-safety.js";
import { getTool } from "../tools/registry.js";
import {
  type ApprovalContext,
  DefaultApprovalPolicy,
  resolveThreshold,
} from "./approval-policy.js";
import { bashRiskClassifier } from "./bash-risk-classifier.js";
import { fileRiskClassifier } from "./file-risk-classifier.js";
import { type RiskAssessment, riskToRiskLevel } from "./risk-types.js";
import {
  buildShellAllowlistOptions,
  buildShellCommandCandidates,
  cachedParse,
  type ParsedCommand,
} from "./shell-identity.js";
import { skillLoadRiskClassifier } from "./skill-risk-classifier.js";
import { findHighestPriorityRule, onRulesChanged } from "./trust-store.js";
import {
  type AllowlistOption,
  type PermissionCheckResult,
  type PolicyContext,
  RiskLevel,
  type ScopeOption,
} from "./types.js";
import { webRiskClassifier } from "./web-risk-classifier.js";
import { isWorkspaceScopedInvocation } from "./workspace-policy.js";

// ── Risk classification cache ────────────────────────────────────────────────
// classifyRisk() is called on every permission check and can invoke WASM
// parsing for shell commands. Cache results keyed on
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

const RISK_CACHE_MAX = 256;
const riskCache = new Map<string, RiskClassification>();
let riskCacheInvalidationHookRegistered = false;

// ── Assessment cache ─────────────────────────────────────────────────────────
// Stores the full RiskAssessment from classifier-backed tools so that
// generateAllowlistOptions() can read classifier-produced allowlistOptions
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

/** Clear the risk classification cache. Called when trust rules change. */
function clearRiskCache(): void {
  riskCache.clear();
  assessmentCache.clear();
}

function ensureRiskCacheInvalidationHook(): void {
  if (riskCacheInvalidationHookRegistered) return;
  // Register lazily to avoid an ESM initialization cycle between checker and
  // trust-store when a higher-level module imports both during startup.
  riskCacheInvalidationHookRegistered = true;
  onRulesChanged(clearRiskCache);
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

export function normalizeWebFetchUrl(rawUrl: string): URL | null {
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

async function buildCommandCandidates(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
  preParsed?: ParsedCommand,
): Promise<string[]> {
  if (toolName === "bash" || toolName === "host_bash") {
    return buildShellCommandCandidates(
      getStringField(input, "command"),
      preParsed,
    );
  }

  if (toolName === "skill_load") {
    const rawSelector = getStringField(input, "skill").trim();
    const targets: string[] = [];
    if (!rawSelector) {
      targets.push("");
    } else {
      const resolved = resolveSkillIdAndHash(rawSelector);

      // When the resolved skill contains inline command expansions and the
      // feature flag is on, emit skill_load_dynamic: candidates so the
      // higher-priority default ask rule catches them instead of falling
      // through to the permissive skill_load:* allow rule.
      const config = getConfig();
      const inlineEnabled = isAssistantFeatureFlagEnabled(
        "inline-skill-commands",
        config,
      );

      if (resolved && inlineEnabled && hasInlineExpansions(resolved.id)) {
        const transitiveHash = computeTransitiveHashSafe(resolved.id);
        if (transitiveHash) {
          targets.push(`skill_load_dynamic:${resolved.id}@${transitiveHash}`);
        }
        targets.push(`skill_load_dynamic:${resolved.id}`);
        // Don't fall through to skill_load:* — dynamic skills use their own
        // candidate namespace so the default ask rule applies.
      } else {
        if (resolved && resolved.versionHash) {
          // Version-specific candidate lets rules pin to an exact skill version
          targets.push(`${resolved.id}@${resolved.versionHash}`);
        }
        targets.push(rawSelector);
      }
    }

    // Dynamic candidates use skill_load_dynamic: prefix; normal ones use skill_load:
    return [...new Set(targets)].map((target) => {
      if (target.startsWith("skill_load_dynamic:")) return target;
      return `${toolName}:${target}`;
    });
  }

  if (
    toolName === "scaffold_managed_skill" ||
    toolName === "delete_managed_skill"
  ) {
    const skillId = getStringField(input, "skill_id").trim();
    return [`${toolName}:${skillId}`];
  }

  if (toolName === "web_fetch" || toolName === "network_request") {
    const rawUrl = getStringField(input, "url").trim();
    const candidates: string[] = [];

    if (rawUrl) {
      candidates.push(`${toolName}:${rawUrl}`);
    }

    const normalized = normalizeWebFetchUrl(rawUrl);
    if (normalized) {
      candidates.push(`${toolName}:${normalized.href}`);
      candidates.push(`${toolName}:${normalized.origin}/*`);
    }

    if (candidates.length === 0) {
      candidates.push(`${toolName}:`);
    }

    return [...new Set(candidates)];
  }

  const fileTarget = getStringField(input, "path", "file_path");
  if (
    toolName === "host_file_read" ||
    toolName === "host_file_write" ||
    toolName === "host_file_edit"
  ) {
    const resolved = fileTarget ? resolve(fileTarget) : fileTarget;
    const normalized =
      resolved && process.platform === "win32"
        ? resolved.replaceAll("\\", "/")
        : resolved;
    const candidates = [`${toolName}:${normalized}`];
    if (normalized !== fileTarget) {
      candidates.push(`${toolName}:${fileTarget}`);
    }
    // Include the canonical (symlink-resolved) form so rules written against
    // real paths match even when the tool receives a symlinked path.
    if (fileTarget) {
      const canonical = normalizeFilePath(normalized);
      if (canonical !== normalized && canonical !== fileTarget) {
        candidates.push(`${toolName}:${canonical}`);
      }
    }
    return [...new Set(candidates)];
  }

  const rawResolved = fileTarget ? resolve(workingDir, fileTarget) : fileTarget;
  const resolved =
    rawResolved && process.platform === "win32"
      ? rawResolved.replaceAll("\\", "/")
      : rawResolved;
  const candidates = [`${toolName}:${resolved}`];
  // Also include the raw path if it differs, so user-created rules with
  // raw paths still match.
  if (resolved !== fileTarget) {
    candidates.push(`${toolName}:${fileTarget}`);
  }
  // Include the canonical (symlink-resolved) form so rules written against
  // real paths match even when the tool receives a symlinked or relative path
  // with redundant segments like `./foo/../bar`.
  if (fileTarget) {
    const canonical = normalizeFilePath(resolved);
    if (canonical !== resolved && canonical !== fileTarget) {
      candidates.push(`${toolName}:${canonical}`);
    }
  }
  return [...new Set(candidates)];
}

export async function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  preParsed?: ParsedCommand,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
): Promise<RiskClassification> {
  signal?.throwIfAborted();
  ensureRiskCacheInvalidationHook();

  // Check cache first (skip when preParsed is provided since caller already
  // parsed and we'd just be duplicating the key computation cost).
  const cacheKey = preParsed
    ? null
    : riskCacheKey(toolName, input, workingDir, manifestOverride);
  if (cacheKey) {
    const cached = riskCache.get(cacheKey);
    if (cached !== undefined) {
      // LRU refresh
      riskCache.delete(cacheKey);
      riskCache.set(cacheKey, cached);
      return cached;
    }
  }

  // ── Bash/host_bash: delegate to the registry-driven BashRiskClassifier ────
  let result: RiskClassification;
  let classifierAssessment: RiskAssessment | undefined;
  if (toolName === "bash" || toolName === "host_bash") {
    const command = ((input.command as string) ?? "").trim();
    if (!command) {
      result = { level: RiskLevel.Low };
    } else {
      const assessment = await bashRiskClassifier.classify({
        command,
        toolName: toolName as "bash" | "host_bash",
      });
      classifierAssessment = assessment;
      result = {
        level: riskToRiskLevel(assessment.riskLevel),
        reason: assessment.reason,
      };
    }
  }
  // ── File tools: delegate to FileRiskClassifier ──────────────────────────
  else if (
    [
      "file_read",
      "file_write",
      "file_edit",
      "host_file_read",
      "host_file_write",
      "host_file_edit",
    ].includes(toolName)
  ) {
    const filePath = getStringField(input, "path", "file_path");
    const isHostTool = toolName.startsWith("host_");
    const assessment = await fileRiskClassifier.classify({
      toolName: toolName as
        | "file_read"
        | "file_write"
        | "file_edit"
        | "host_file_read"
        | "host_file_write"
        | "host_file_edit",
      filePath,
      workingDir: isHostTool ? "/" : (workingDir ?? process.cwd()),
    });
    classifierAssessment = assessment;
    result = {
      level: riskToRiskLevel(assessment.riskLevel),
      reason: assessment.reason,
    };
  }
  // ── Web tools: delegate to WebRiskClassifier ────────────────────────────
  else if (["web_fetch", "network_request", "web_search"].includes(toolName)) {
    const assessment = await webRiskClassifier.classify({
      toolName: toolName as "web_fetch" | "network_request" | "web_search",
      url: getStringField(input, "url"),
      allowPrivateNetwork: input.allow_private_network === true,
    });
    classifierAssessment = assessment;
    result = {
      level: riskToRiskLevel(assessment.riskLevel),
      reason: assessment.reason,
    };
  }
  // ── Skill tools: delegate to SkillLoadRiskClassifier ────────────────────
  else if (
    ["skill_load", "scaffold_managed_skill", "delete_managed_skill"].includes(
      toolName,
    )
  ) {
    const assessment = await skillLoadRiskClassifier.classify({
      toolName: toolName as
        | "skill_load"
        | "scaffold_managed_skill"
        | "delete_managed_skill",
      skillSelector: getStringField(input, "skill"),
    });
    classifierAssessment = assessment;
    result = {
      level: riskToRiskLevel(assessment.riskLevel),
      reason: assessment.reason,
    };
  }
  // ── Remaining tools: fall through to classifyRiskUncached ───────────────
  else {
    result = {
      level: await classifyRiskUncached(
        toolName,
        input,
        workingDir,
        manifestOverride,
      ),
    };
  }

  // Proxied bash commands route through the credential proxy which handles
  // per-request approval separately. Cap the bash tool's own risk at Medium
  // so trust rules can auto-allow the command execution.
  if (
    toolName === "bash" &&
    input.network_mode === "proxied" &&
    result.level === RiskLevel.High
  ) {
    result = { level: RiskLevel.Medium, reason: result.reason };
  }

  if (cacheKey) {
    if (riskCache.size >= RISK_CACHE_MAX) {
      const oldest = riskCache.keys().next().value;
      if (oldest !== undefined) riskCache.delete(oldest);
    }
    riskCache.set(cacheKey, result);
  }

  // Store the full assessment in a separate cache keyed on (toolName, input)
  // so generateAllowlistOptions() can retrieve classifier-produced options.
  if (classifierAssessment) {
    const aKey = assessmentCacheKey(toolName, input);
    if (assessmentCache.size >= RISK_CACHE_MAX) {
      const oldest = assessmentCache.keys().next().value;
      if (oldest !== undefined) assessmentCache.delete(oldest);
    }
    assessmentCache.set(aKey, classifierAssessment);
  }

  return result;
}

async function classifyRiskUncached(
  toolName: string,
  _input: Record<string, unknown>,
  _workingDir?: string,
  manifestOverride?: ManifestOverride,
): Promise<RiskLevel> {
  // Check the tool registry for a declared default risk level
  const tool = getTool(toolName);
  if (tool) return tool.defaultRiskLevel;

  // Use manifest metadata for unregistered skill tools so the Permission
  // Simulator shows accurate risk levels instead of defaulting to Medium.
  if (manifestOverride) {
    const riskMap: Record<string, RiskLevel> = {
      low: RiskLevel.Low,
      medium: RiskLevel.Medium,
      high: RiskLevel.High,
    };
    return riskMap[manifestOverride.risk] ?? RiskLevel.Medium;
  }

  // Unknown tool → Medium
  return RiskLevel.Medium;
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

  // For shell tools, parse once and share the result to avoid duplicate tree-sitter work.
  let shellParsed: ParsedCommand | undefined;
  if (toolName === "bash" || toolName === "host_bash") {
    const command = ((input.command as string) ?? "").trim();
    if (command) {
      shellParsed = await cachedParse(command);
    }
  }

  const { level: risk, reason: riskReason } = await classifyRisk(
    toolName,
    input,
    workingDir,
    shellParsed,
    manifestOverride,
    signal,
  );

  // Build command string candidates for rule matching
  const commandCandidates = await buildCommandCandidates(
    toolName,
    input,
    workingDir,
    shellParsed,
  );

  // Find the highest-priority matching rule across all candidates
  const matchedRule = findHighestPriorityRule(
    toolName,
    commandCandidates,
    workingDir,
    policyContext,
  );

  // Build approval context from local variables
  const tool = getTool(toolName);
  const config = getConfig();
  const resolvedThreshold = resolveThreshold(
    config.permissions.autoApproveUpTo,
    policyContext?.executionContext,
  );
  const approvalContext: ApprovalContext = {
    riskLevel: risk,
    toolName,
    matchedRule: matchedRule ?? undefined,
    permissionsMode: config.permissions.mode,
    isContainerized: getIsContainerized(),
    isWorkspaceScoped:
      risk === RiskLevel.Low
        ? isWorkspaceScopedInvocation(toolName, input, workingDir)
        : false,
    toolOrigin:
      tool?.origin === "skill" ? "skill" : tool ? "builtin" : undefined,
    isSkillBundled: tool?.ownerSkillBundled ?? false,
    hasManifestOverride: !!manifestOverride,
    autoApproveUpTo: resolvedThreshold,
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

function shellAllowlistStrategy(
  _toolName: string,
  input: Record<string, unknown>,
): Promise<AllowlistOption[]> {
  const command = ((input.command as string) ?? "").trim();
  // TODO(phase-3): Wire RiskAssessment.scopeOptions into permission prompts
  // and retire buildShellAllowlistOptions + buildShellCommandCandidates from
  // shell-identity.ts. The classifier's generateScopeOptions produces the
  // canonical scope ladder; this legacy path should not diverge further.
  return buildShellAllowlistOptions(command);
}

function fileAllowlistStrategy(
  toolName: string,
  input: Record<string, unknown>,
): AllowlistOption[] {
  const filePath = (input.path as string) ?? (input.file_path as string) ?? "";
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
  bash: shellAllowlistStrategy,
  host_bash: shellAllowlistStrategy,
  file_read: fileAllowlistStrategy,
  file_write: fileAllowlistStrategy,
  file_edit: fileAllowlistStrategy,
  host_file_read: fileAllowlistStrategy,
  host_file_write: fileAllowlistStrategy,
  host_file_edit: fileAllowlistStrategy,
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

  // Check if a classifier already produced allowlist options during
  // classifyRisk(). If so, return those directly — avoids duplicate
  // computation and keeps scope option generation unified with risk
  // classification.
  const aKey = assessmentCacheKey(toolName, input);
  const cachedAssessment = assessmentCache.get(aKey);
  if (
    cachedAssessment?.allowlistOptions &&
    cachedAssessment.allowlistOptions.length > 0
  ) {
    return cachedAssessment.allowlistOptions;
  }

  // Fall back to the per-tool strategy function for tools that don't have
  // classifier-produced options (e.g. bash tools use the shell identity
  // strategy, or when the cache was missed).
  if (Object.hasOwn(ALLOWLIST_STRATEGIES, toolName)) {
    return ALLOWLIST_STRATEGIES[toolName](toolName, input);
  }

  return [{ label: "*", description: "Everything", pattern: "*" }];
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
