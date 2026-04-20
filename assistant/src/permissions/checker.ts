import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { loadSkillCatalog, resolveSkillSelector } from "../config/skills.js";
import { indexCatalogById } from "../skills/include-graph.js";
import {
  isSkillSourcePath,
  normalizeDirPath,
  normalizeFilePath,
} from "../skills/path-classifier.js";
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
  getWorkspaceHooksDir,
} from "../util/platform.js";
import { bashRiskClassifier } from "./bash-risk-classifier.js";
import { riskToRiskLevel } from "./risk-types.js";
import {
  buildShellAllowlistOptions,
  buildShellCommandCandidates,
  cachedParse,
  type ParsedCommand,
} from "./shell-identity.js";
import { findHighestPriorityRule, onRulesChanged } from "./trust-store.js";
import {
  type AllowlistOption,
  type PermissionCheckResult,
  type PolicyContext,
  RiskLevel,
  type ScopeOption,
} from "./types.js";
import { isWorkspaceScopedInvocation } from "./workspace-policy.js";

// ── Risk classification cache ────────────────────────────────────────────────
// classifyRisk() is called on every permission check and can invoke WASM
// parsing for shell commands. Cache results keyed on
// (toolName, inputHash, workingDir, manifestOverride).
// Invalidated when trust rules change since risk classification for file tools
// depends on skill source path checks which reference config, but the core
// risk logic is input-deterministic.
const RISK_CACHE_MAX = 256;
const riskCache = new Map<string, RiskLevel>();
let riskCacheInvalidationHookRegistered = false;

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
}

function ensureRiskCacheInvalidationHook(): void {
  if (riskCacheInvalidationHookRegistered) return;
  // Register lazily to avoid an ESM initialization cycle between checker and
  // trust-store when a higher-level module imports both during startup.
  riskCacheInvalidationHookRegistered = true;
  onRulesChanged(clearRiskCache);
}

/**
 * Determines at runtime whether a high-risk operation should be auto-allowed
 * without requiring a persisted allowHighRisk flag. This replaces the
 * stateful allowHighRisk field on trust rules with a context-aware check.
 *
 * Auto-allow cases:
 * - Containerized bash: all commands are sandboxed, so high-risk is safe.
 *
 * Note: `rm BOOTSTRAP.md` and `rm UPDATES.md` are already classified as
 * Medium risk (not High) by the BashRiskClassifier's rm safe-file
 * downgrade, so they don't need special handling here.
 */
function shouldAutoAllowHighRisk(toolName: string): boolean {
  if (toolName === "bash" && getIsContainerized()) {
    return true;
  }
  return false;
}

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
): Promise<RiskLevel> {
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
  let result: RiskLevel;
  if (toolName === "bash" || toolName === "host_bash") {
    const command = ((input.command as string) ?? "").trim();
    if (!command) {
      result = RiskLevel.Low;
    } else {
      const assessment = await bashRiskClassifier.classify({
        command,
        toolName: toolName as "bash" | "host_bash",
      });
      result = riskToRiskLevel(assessment.riskLevel);
    }
  } else {
    result = await classifyRiskUncached(
      toolName,
      input,
      workingDir,
      manifestOverride,
    );
  }

  // Proxied bash commands route through the credential proxy which handles
  // per-request approval separately. Cap the bash tool's own risk at Medium
  // so trust rules can auto-allow the command execution.
  if (
    toolName === "bash" &&
    input.network_mode === "proxied" &&
    result === RiskLevel.High
  ) {
    result = RiskLevel.Medium;
  }

  if (cacheKey) {
    if (riskCache.size >= RISK_CACHE_MAX) {
      const oldest = riskCache.keys().next().value;
      if (oldest !== undefined) riskCache.delete(oldest);
    }
    riskCache.set(cacheKey, result);
  }

  return result;
}

async function classifyRiskUncached(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  manifestOverride?: ManifestOverride,
): Promise<RiskLevel> {
  if (toolName === "file_read") {
    const filePath = getStringField(input, "path", "file_path");
    if (isActorTokenSigningKeyPath(filePath, workingDir)) {
      return RiskLevel.High;
    }
    return RiskLevel.Low;
  }
  if (toolName === "file_write" || toolName === "file_edit") {
    const filePath = getStringField(input, "path", "file_path");
    if (
      filePath &&
      isSkillSourcePath(
        resolve(workingDir ?? process.cwd(), filePath),
        getConfig().skills.load.extraDirs,
      )
    ) {
      return RiskLevel.High;
    }
    if (filePath) {
      const normalizedHooksDir = normalizeDirPath(getWorkspaceHooksDir());
      const normalizedPath = normalizeFilePath(
        resolve(workingDir ?? process.cwd(), filePath),
      );
      const hooksDirNoTrailingSlash = normalizedHooksDir.slice(0, -1);
      if (
        normalizedPath === hooksDirNoTrailingSlash ||
        normalizedPath.startsWith(normalizedHooksDir)
      ) {
        return RiskLevel.High;
      }
    }
    return RiskLevel.Low;
  }
  if (toolName === "web_search") return RiskLevel.Low;
  if (toolName === "web_fetch") {
    // Private-network fetches are High risk so that blanket allow rules
    // (including the starter bundle) cannot silently bypass the prompt.
    return input.allow_private_network === true
      ? RiskLevel.High
      : RiskLevel.Low;
  }
  // Proxy-authenticated network requests are Medium risk — they carry injected
  // credentials and the user should approve the target host/origin.
  if (toolName === "network_request") return RiskLevel.Medium;
  if (toolName === "skill_load") return RiskLevel.Low;

  // Skill mutation tools are always High risk — they write or delete persistent
  // skill source code. These tools moved from core tool registry to bundled
  // skills, but their security classification must remain High regardless of
  // whether they appear in the tool registry.
  if (
    toolName === "scaffold_managed_skill" ||
    toolName === "delete_managed_skill"
  ) {
    return RiskLevel.High;
  }

  // Escalate host file mutations targeting skill source paths to High risk.
  // The host variants fall through to the tool registry (Medium) by default,
  // but writing to skill source code is a privilege-escalation vector.
  if (toolName === "host_file_write" || toolName === "host_file_edit") {
    const filePath = getStringField(input, "path", "file_path");
    if (
      filePath &&
      isSkillSourcePath(resolve(filePath), getConfig().skills.load.extraDirs)
    ) {
      return RiskLevel.High;
    }
    if (filePath) {
      const normalizedHooksDir = normalizeDirPath(getWorkspaceHooksDir());
      const normalizedPath = normalizeFilePath(resolve(filePath));
      const hooksDirNoTrailingSlash = normalizedHooksDir.slice(0, -1);
      if (
        normalizedPath === hooksDirNoTrailingSlash ||
        normalizedPath.startsWith(normalizedHooksDir)
      ) {
        return RiskLevel.High;
      }
    }
    // Fall through to the tool registry default (Medium) below.
  }

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

function isActorTokenSigningKeyPath(
  filePath: string | undefined,
  workingDir?: string,
): boolean {
  if (!filePath) return false;
  const cwd = workingDir ?? process.cwd();
  const resolvedPath = resolve(cwd, filePath);
  // Include both the per-instance protected dir AND the legacy global
  // ~/.vellum/protected path so upgraded machines with a host-wide signing
  // key still classify reads as High risk.
  const signingKeyPaths = Array.from(
    new Set([
      join(homedir(), ".vellum", "protected", "actor-token-signing-key"),
      join(getProtectedDir(), "actor-token-signing-key"),
      join(getDeprecatedDir(), "actor-token-signing-key"),
      resolve(cwd, "deprecated", "actor-token-signing-key"),
    ]),
  );
  return signingKeyPaths.includes(resolvedPath);
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

  const risk = await classifyRisk(
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

  // Deny rules apply at ALL risk levels — including proxied network mode.
  // Evaluate them first so hard blocks are never downgraded to a prompt.
  if (matchedRule && matchedRule.decision === "deny") {
    return {
      decision: "deny",
      reason: `Blocked by deny rule: ${matchedRule.pattern}`,
      matchedRule,
    };
  }

  if (matchedRule) {
    if (matchedRule.decision === "ask") {
      // Ask rules always prompt — never auto-allow or auto-deny
      return {
        decision: "prompt",
        reason: `Matched ask rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }

    // Allow rule: auto-allow for non-High risk
    if (risk !== RiskLevel.High) {
      return {
        decision: "allow",
        reason: `Matched trust rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }
    // High risk with allow rule — check runtime context for auto-allow
    if (shouldAutoAllowHighRisk(toolName)) {
      return {
        decision: "allow",
        reason: `Matched trust rule in auto-allow-high-risk context: ${matchedRule.pattern}`,
        matchedRule,
      };
    }
    // High risk with allow rule (no runtime auto-allow) → fall through to prompt
  }

  // No matching rule (or High risk with allow rule) → risk-based fallback

  // Third-party skill-origin tools default to prompting when no trust rule
  // matches, regardless of risk level. Bundled skill tools are first-party
  // and trusted, so they fall through to the normal risk-based policy.
  // When manifestOverride is present, the tool comes from a skill manifest
  // but isn't registered — treat it as a third-party skill tool.
  if (!matchedRule) {
    const tool = getTool(toolName);
    if (tool?.origin === "skill" && !tool.ownerSkillBundled) {
      return {
        decision: "prompt",
        reason: "Skill tool: requires approval by default",
      };
    }
    if (!tool && manifestOverride) {
      return {
        decision: "prompt",
        reason: "Skill tool: requires approval by default",
      };
    }
  }

  // In strict mode, every tool without an explicit matching rule must be
  // prompted — there is no implicit auto-allow for any risk level.
  // This explicitly covers skill_load: activating a skill can grant the
  // agent new capabilities, so in strict mode users must approve each
  // skill load via an exact-version or wildcard trust rule.
  const permissionsMode = getConfig().permissions.mode;

  if (permissionsMode === "strict" && !matchedRule) {
    return {
      decision: "prompt",
      reason: `Strict mode: no matching rule, requires approval`,
    };
  }

  // Workspace mode: auto-allow workspace-scoped operations that don't have
  // an explicit rule, but only when risk is Low. Medium and High risk operations
  // fall through to risk-based policy and always require approval.
  if (
    permissionsMode === "workspace" &&
    !matchedRule &&
    risk === RiskLevel.Low
  ) {
    // Outside a container, bash runs on the host — don't auto-allow
    if (toolName === "bash" && !getIsContainerized()) {
      // Fall through to risk-based policy below
    } else if (isWorkspaceScopedInvocation(toolName, input, workingDir)) {
      return {
        decision: "allow",
        reason: "Workspace mode: workspace-scoped operation auto-allowed",
      };
    }
  }

  // Auto-allow low-risk bundled skill tools even without explicit trust rules.
  // These are first-party tools with a vetted risk declaration.
  // This block must come AFTER the strict mode check so that strict mode
  // still prompts for bundled skill tools without explicit rules.
  if (!matchedRule && risk === RiskLevel.Low) {
    const tool = getTool(toolName);
    if (tool?.origin === "skill" && tool.ownerSkillBundled) {
      return {
        decision: "allow",
        reason: "Bundled skill tool: low risk, auto-allowed",
      };
    }
  }

  if (risk === RiskLevel.High) {
    return {
      decision: "prompt",
      reason: `High risk: always requires approval`,
    };
  }

  if (risk === RiskLevel.Low) {
    return { decision: "allow", reason: "Low risk: auto-allowed" };
  }

  return { decision: "prompt", reason: `${risk} risk: requires approval` };
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
