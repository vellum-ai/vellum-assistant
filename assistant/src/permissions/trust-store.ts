import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { parseTrustFileData, parseTrustRule } from "@vellumai/ces-contracts";
import { Minimatch } from "minimatch";
import { v4 as uuid } from "uuid";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { getProtectedDir } from "../util/platform.js";
import { getDefaultRuleTemplates } from "./defaults.js";
import * as trustClient from "./trust-client.js";
import type {
  AcceptStarterBundleResult,
  StarterBundleRule,
  TrustStoreBackend,
} from "./trust-store-interface.js";
import type { PolicyContext, TrustRule } from "./types.js";

export type {
  AcceptStarterBundleResult,
  StarterBundleRule,
} from "./trust-store-interface.js";
export type { TrustStoreBackend } from "./trust-store-interface.js";

const log = getLogger("trust-store");

const TRUST_FILE_VERSION = 3;

interface TrustFile {
  version: number;
  rules: TrustRule[];
  /** Set to true when the user explicitly accepts the starter approval bundle. */
  starterBundleAccepted?: boolean;
}

let cachedRules: TrustRule[] | null = null;
let cachedStarterBundleAccepted: boolean | null = null;

// Callbacks invoked when trust rules change (add/update/remove/clear).
// Used by the permission checker to invalidate dependent caches.
const rulesChangedListeners: Array<() => void> = [];

/** Register a callback to be invoked whenever trust rules change (file backend). */
function fileOnRulesChanged(listener: () => void): void {
  rulesChangedListeners.push(listener);
}

function notifyRulesChanged(): void {
  for (const listener of rulesChangedListeners) {
    listener();
  }
}

/**
 * Cache of pre-compiled Minimatch objects keyed by pattern string.
 * Rebuilt whenever cachedRules changes. Avoids re-parsing glob patterns
 * on every tool-call permission check.
 */
const compiledPatterns = new Map<string, Minimatch>();
/** Patterns that failed compilation — cached to avoid repeated attempts and log spam. */
const invalidPatterns = new Set<string>();

/** Get or compile a Minimatch object for the given pattern. Returns null if the pattern is invalid. */
function getCompiledPattern(pattern: string): Minimatch | null {
  if (invalidPatterns.has(pattern)) return null;
  let compiled = compiledPatterns.get(pattern);
  if (!compiled) {
    if (typeof pattern !== "string") {
      log.warn({ pattern }, "Cannot compile non-string pattern");
      invalidPatterns.add(pattern as string);
      return null;
    }
    try {
      compiled = new Minimatch(pattern);
      compiledPatterns.set(pattern, compiled);
    } catch (err) {
      log.warn({ pattern, err }, "Failed to compile pattern");
      invalidPatterns.add(pattern);
      return null;
    }
  }
  return compiled;
}

/**
 * Check whether a minimatch pattern matches a candidate string (file backend).
 * Reuses the compiled pattern cache from trust rule evaluation.
 */
function filePatternMatchesCandidate(
  pattern: string,
  candidate: string,
): boolean {
  const compiled = getCompiledPattern(pattern);
  if (!compiled) return false;
  return compiled.match(candidate);
}

/** Rebuild the compiled pattern cache from the current rule set. */
function rebuildPatternCache(rules: TrustRule[]): void {
  compiledPatterns.clear();
  invalidPatterns.clear();
  for (const rule of rules) {
    if (typeof rule.pattern !== "string") {
      log.warn(
        { ruleId: rule.id, pattern: rule.pattern },
        "Skipping rule with non-string pattern during cache rebuild",
      );
      continue;
    }
    if (!compiledPatterns.has(rule.pattern)) {
      try {
        compiledPatterns.set(rule.pattern, new Minimatch(rule.pattern));
      } catch (err) {
        log.warn(
          { ruleId: rule.id, pattern: rule.pattern, err },
          "Skipping rule with invalid pattern during cache rebuild",
        );
      }
    }
  }
}

function getTrustPath(): string {
  return join(getGatewaySecurityDir(), "trust.json");
}

/**
 * Resolve the gateway security directory.
 *
 * Docker: `GATEWAY_SECURITY_DIR` env var.
 * Local:  the per-instance protected directory resolved by `getProtectedDir()`.
 */
function getGatewaySecurityDir(): string {
  const securityDir = process.env.GATEWAY_SECURITY_DIR;
  if (securityDir) return securityDir;
  return getProtectedDir();
}

/**
 * Sort comparator: highest priority first. At the same priority, deny rules
 * come before allow rules for safety (deny wins ties).
 */
function ruleOrder(a: TrustRule, b: TrustRule): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.decision !== b.decision) {
    // deny > ask > allow
    const order: Record<string, number> = { deny: 0, ask: 1, allow: 2 };
    return (order[a.decision] ?? 2) - (order[b.decision] ?? 2);
  }
  return 0;
}

/**
 * Ensure default rules are always present in the rule set.
 * Mutates the provided array and returns whether any rules were added.
 */
function backfillDefaults(rules: TrustRule[]): boolean {
  let changed = false;
  const existingIds = new Set(rules.map((r) => r.id));

  // Migrate old default:deny-*-protected rules → default:ask-*-protected
  const oldDefaultPrefix = "default:deny-";
  const newDefaultPrefix = "default:ask-";
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (
      rule.id.startsWith(oldDefaultPrefix) &&
      rule.id.endsWith("-protected")
    ) {
      const newId = newDefaultPrefix + rule.id.slice(oldDefaultPrefix.length);
      rules.splice(i, 1);
      existingIds.delete(rule.id);
      // Don't add newId to existingIds — let the backfill loop re-add it
      changed = true;
      log.info({ oldId: rule.id, newId }, "Migrated default deny rule to ask");
    }
  }

  // Remove default rules that are no longer in the template set (e.g.
  // computer_use_done/computer_use_respond were removed from the ask-rule list
  // because they are terminal signal tools that don't need approval).
  const templateIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.id.startsWith("default:") && !templateIds.has(rule.id)) {
      rules.splice(i, 1);
      existingIds.delete(rule.id);
      changed = true;
      log.info({ ruleId: rule.id }, "Removed stale default trust rule");
    }
  }

  // Migrate existing default rules whose priority, pattern, scope, decision,
  // or allowHighRisk has changed in the template (e.g. host_bash pattern
  // changed from '*' to '**', host tool priorities changed from 1000 to 50,
  // workspace scope changed from getRootDir()+workspace to getWorkspaceDir()).
  //
  // Rules with `userModifiedAt` set are skipped — the user explicitly
  // customized them and their override should be preserved across upgrades.
  for (const template of getDefaultRuleTemplates()) {
    if (existingIds.has(template.id)) {
      const rule = rules.find((r) => r.id === template.id);
      if (
        rule &&
        (rule.priority !== template.priority ||
          rule.pattern !== template.pattern ||
          rule.scope !== template.scope ||
          rule.decision !== template.decision ||
          rule.allowHighRisk !== template.allowHighRisk)
      ) {
        if (rule.userModifiedAt != null) {
          log.info(
            { ruleId: rule.id, userModifiedAt: rule.userModifiedAt },
            "Skipping migration of user-modified default rule",
          );
          continue;
        }
        log.info(
          {
            ruleId: rule.id,
            oldPriority: rule.priority,
            newPriority: template.priority,
            oldPattern: rule.pattern,
            newPattern: template.pattern,
            oldScope: rule.scope,
            newScope: template.scope,
          },
          "Migrated default rule to updated template values",
        );
        rule.priority = template.priority;
        rule.pattern = template.pattern;
        rule.scope = template.scope;
        rule.decision = template.decision;
        if (template.allowHighRisk != null) {
          rule.allowHighRisk = template.allowHighRisk;
        } else {
          delete rule.allowHighRisk;
        }
        changed = true;
      }
    }
  }

  for (const template of getDefaultRuleTemplates()) {
    if (!existingIds.has(template.id)) {
      // Default rules may carry allowHighRisk (e.g. bash container rules).
      // Build as GenericTrustRule to accommodate all optional fields.
      const rule: TrustRule = {
        id: template.id,
        tool: template.tool,
        pattern: template.pattern,
        scope: template.scope,
        decision: template.decision,
        priority: template.priority,
        createdAt: Date.now(),
        ...(template.allowHighRisk != null
          ? { allowHighRisk: template.allowHighRisk }
          : {}),
      };
      rules.push(rule);
      changed = true;
      log.info({ ruleId: template.id }, "Backfilled default trust rule");
    }
  }
  return changed;
}

function loadFromDisk(): TrustRule[] {
  const path = getTrustPath();
  let rules: TrustRule[] = [];
  let needsSave = false;

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as TrustFile;

      // Guard: ensure rules is an array (protects against hand-edited files)
      const rawRules = Array.isArray(data.rules) ? data.rules : [];

      // Restore persisted starter bundle flag
      cachedStarterBundleAccepted = data.starterBundleAccepted === true;

      // Defense-in-depth: strip any __internal: prefixed rules that may have
      // been hand-edited into trust.json.
      const sanitizedRules = rawRules.filter((r) => {
        if (typeof r.tool === "string" && r.tool.startsWith("__internal:")) {
          log.warn(
            { ruleId: r.id, tool: r.tool },
            "Stripping __internal: rule from trust file on load",
          );
          return false;
        }
        return true;
      });

      if (
        data.version === TRUST_FILE_VERSION ||
        data.version === 1 ||
        data.version === 2
      ) {
        if (sanitizedRules.length < rawRules.length) {
          needsSave = true;
        }
        if (data.version !== TRUST_FILE_VERSION) {
          needsSave = true;
          log.info(
            { version: data.version, targetVersion: TRUST_FILE_VERSION },
            "Migrating legacy trust file version",
          );
        }

        // Apply canonical parser for family-aware normalization.
        // The parser strips fields that are invalid for a rule's tool family
        // (e.g. executionTarget on URL rules), preserves compatible optional
        // fields like allowHighRisk, and coerces malformed values.
        const { data: parsedData, normalized } = parseTrustFileData({
          ...data,
          rules: sanitizedRules,
        });
        // The contracts parser returns the union TrustRule type; our local
        // TrustRule flattens the union with optional fields for backward
        // compatibility. The structural overlap is safe to cast here.
        rules = parsedData.rules as TrustRule[];
        if (normalized) {
          needsSave = true;
        }

        // Strip legacy principal-scoped fields from persisted v3 rules.
        // Before the principal concept was removed, rules could carry
        // principalKind/principalId/principalVersion which acted as scope
        // constraints. Now that matching ignores those fields, leaving them
        // on loaded rules would silently widen their scope to global
        // wildcards. Stripping them and re-saving prevents scope escalation.
        for (const rule of rules) {
          // Legacy v3 rules may carry principal-scoped fields that no longer
          // exist in the TrustRule interface — cast to strip them at runtime.
          const r = rule as unknown as Record<string, unknown>;
          if (
            "principalKind" in r ||
            "principalId" in r ||
            "principalVersion" in r
          ) {
            delete r.principalKind;
            delete r.principalId;
            delete r.principalVersion;
            needsSave = true;
          }
        }
      } else {
        log.warn(
          { version: data.version },
          "Unknown trust file version, applying defaults in-memory only",
        );
        // Apply default deny rules in-memory so the assistant is still
        // protected, but do NOT persist — we must not overwrite a newer
        // trust file format we don't understand.
        const memRules: TrustRule[] = [];
        backfillDefaults(memRules);
        memRules.sort(ruleOrder);
        return memRules;
      }
    } catch (err) {
      log.error({ err }, "Failed to load trust file");
      // Fall through to backfill defaults even on parse errors
    }
  }

  // Backfill default rules at their declared priority
  if (backfillDefaults(rules)) {
    needsSave = true;
  }

  rules.sort(ruleOrder);

  if (needsSave) {
    try {
      saveToDisk(rules);
    } catch (err) {
      log.warn(
        { err },
        "Failed to persist migrated trust rules (continuing with in-memory rules)",
      );
    }
  }

  return rules;
}

function saveToDisk(rules: TrustRule[]): void {
  const path = getTrustPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: TrustFile = { version: TRUST_FILE_VERSION, rules };
  if (cachedStarterBundleAccepted) {
    data.starterBundleAccepted = true;
  }
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  // Enforce owner-only permissions even if the file already existed with
  // wider permissions. Matches the pattern used in encrypted-store.ts.
  chmodSync(path, 0o600);
}

function getRules(): TrustRule[] {
  if (cachedRules == null) {
    cachedRules = loadFromDisk();
    rebuildPatternCache(cachedRules);
  }
  return cachedRules;
}

function fileAddRule(
  tool: string,
  pattern: string,
  scope: string,
  decision: "allow" | "deny" | "ask" = "allow",
  priority: number = 100,
  options?: {
    allowHighRisk?: boolean;
    executionTarget?: string;
  },
): TrustRule {
  if (tool.startsWith("__internal:"))
    throw new Error(`Cannot create internal pseudo-rule via addRule: ${tool}`);

  // Canonicalize through the shared parser so fields invalid for the tool's
  // family are stripped before persistence, regardless of which callsite
  // invoked addRule.
  const { rule: canonical } = parseTrustRule({
    id: uuid(),
    tool,
    pattern,
    scope,
    decision,
    priority,
    createdAt: Date.now(),
    ...(options?.allowHighRisk != null
      ? { allowHighRisk: options.allowHighRisk }
      : {}),
    ...(options?.executionTarget != null
      ? { executionTarget: options.executionTarget }
      : {}),
  });
  const rule = canonical as TrustRule;

  // Re-read from disk to avoid lost updates if another call modified rules
  // between our last read and now (e.g. two rapid trust rule additions).
  cachedRules = null;
  const rules = [...getRules()];
  rules.push(rule);
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ rule }, "Added trust rule");
  return rule;
}

function fileUpdateRule(
  id: string,
  updates: {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: "allow" | "deny" | "ask";
    priority?: number;
  },
): TrustRule {
  if (updates.tool?.startsWith("__internal:"))
    throw new Error(
      `Cannot update tool to internal pseudo-rule: ${updates.tool}`,
    );

  // Re-read from disk to avoid lost updates from concurrent modifications.
  cachedRules = null;
  const rules = [...getRules()];
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`Trust rule not found: ${id}`);
  const merged = { ...rules[index] };
  if (updates.tool != null) merged.tool = updates.tool;
  if (updates.pattern != null) merged.pattern = updates.pattern;
  if (updates.scope != null) merged.scope = updates.scope;
  if (updates.decision != null) merged.decision = updates.decision;
  if (updates.priority != null) merged.priority = updates.priority;

  // Mark default rules with userModifiedAt so backfillDefaults() preserves
  // the user's customization across upgrades instead of overwriting it.
  const defaultIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  if (defaultIds.has(id)) {
    merged.userModifiedAt = Date.now();
  }

  // Canonicalize through parseTrustRule so that fields invalid for the
  // (potentially changed) tool family are stripped. For example, if a rule's
  // tool is changed from "bash" to "web_fetch", executionTarget is dropped
  // because URL-family tools don't support target scoping.
  const { rule } = parseTrustRule(merged as unknown as Record<string, unknown>);
  rules[index] = rule;
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ rule }, "Updated trust rule");
  return rule;
}

function fileRemoveRule(id: string): boolean {
  const defaultIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  if (defaultIds.has(id))
    throw new Error(`Cannot remove default trust rule: ${id}`);

  // Re-read from disk to avoid lost updates from concurrent modifications.
  cachedRules = null;
  const rules = [...getRules()];
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  rules.splice(index, 1);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ id }, "Removed trust rule");
  return true;
}

/**
 * Resolve the effective scope of a trust rule.
 *
 * Not all trust rule families require a scope — after canonical parsing,
 * rules that had no scope are normalized to `"everywhere"`. This helper
 * ensures any residual rules without a scope field default to `"everywhere"`
 * for safe matching.
 */
function effectiveScope(rule: TrustRule): string {
  return rule.scope || "everywhere";
}

function matchesScope(ruleScope: string, workingDir: string): boolean {
  if (ruleScope === "everywhere") return true;
  // Strip optional trailing wildcard, then enforce a directory-boundary match
  // so that a rule for "/path/project" does NOT match "/path/project-evil".
  const prefix = ruleScope.replace(/\*$/, "").replace(/\/+$/, "");
  const dir = workingDir.replace(/\/+$/, "");
  return dir === prefix || dir.startsWith(prefix + "/");
}

function findRuleByDecision(
  tool: string,
  command: string,
  scope: string,
  decision: "allow" | "deny" | "ask",
): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (rule.decision !== decision) continue;
    const compiled = getCompiledPattern(rule.pattern);
    if (!compiled || !compiled.match(command)) continue;
    if (!matchesScope(effectiveScope(rule), scope)) continue;
    return rule;
  }
  return null;
}

/**
 * Check whether a rule's executionTarget constraint matches the context.
 *
 * If the rule does not specify an executionTarget it matches any target
 * (wildcard). If specified, it must match exactly.
 *
 * Not all trust rule families carry `executionTarget` — URL, managed-skill,
 * and skill-load rules never have it. For those families the check is a
 * no-op (wildcard match).
 */
function matchesExecutionTarget(rule: TrustRule, ctx?: PolicyContext): boolean {
  if (rule.executionTarget == null) return true;
  return ctx?.executionTarget === rule.executionTarget;
}

/**
 * Find the highest-priority rule that matches any of the command candidates (file backend).
 * Rules are pre-sorted by priority descending, so the first match wins.
 *
 * When a `PolicyContext` is provided, rules that specify executionTarget
 * constraints are filtered accordingly. Rules without those constraints
 * act as wildcards and match any context.
 */
function fileFindHighestPriorityRule(
  tool: string,
  commands: string[],
  scope: string,
  ctx?: PolicyContext,
): TrustRule | null {
  // Check ephemeral (task-scoped) rules first — they take precedence over
  // file-based rules at the same priority because they are evaluated earlier.
  // The ruleOrder sort (highest priority first, deny wins ties) still applies
  // across the combined set because ephemeral rules use a lower default
  // priority (50) than user rules (100), so user deny rules still win.
  const ephemeral = ctx?.ephemeralRules ?? [];
  const fileRules = getRules();

  // Concatenate and re-sort so priority ordering is respected across both sets.
  const allRules =
    ephemeral.length > 0
      ? [...ephemeral, ...fileRules].sort(ruleOrder)
      : fileRules;

  for (const rule of allRules) {
    if (rule.tool !== tool) continue;
    if (!matchesScope(effectiveScope(rule), scope)) continue;
    if (!matchesExecutionTarget(rule, ctx)) continue;
    const compiled = getCompiledPattern(rule.pattern);
    if (!compiled) continue;
    for (const command of commands) {
      if (compiled.match(command)) {
        return rule;
      }
    }
  }
  return null;
}

function fileFindMatchingRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return findRuleByDecision(tool, command, scope, "allow");
}

function fileFindDenyRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return findRuleByDecision(tool, command, scope, "deny");
}

function fileGetAllRules(): TrustRule[] {
  return [...getRules()];
}

function fileClearAllRules(): void {
  // Reset the starter bundle flag so the bundle can be re-accepted after clear.
  cachedStarterBundleAccepted = false;
  // Re-backfill default rules so protected directory stays guarded.
  const rules: TrustRule[] = [];
  backfillDefaults(rules);
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info("Cleared all user trust rules (default rules preserved)");
}

function fileClearCache(): void {
  cachedRules = null;
  cachedStarterBundleAccepted = null;
  compiledPatterns.clear();
  invalidPatterns.clear();
}

// ─── Starter approval bundle ────────────────────────────────────────────────
//
// A curated set of low-risk tool rules that most users would approve
// individually during normal use.  Accepting the bundle seeds them all at
// once, reducing prompt noise in strict mode while keeping the action
// explicitly opt-in.

/**
 * Returns the starter bundle rule definitions (file backend).  These cover read-only and
 * information-gathering tools that never mutate the filesystem or execute
 * arbitrary code.
 */
function fileGetStarterBundleRules(): StarterBundleRule[] {
  return [
    // Use standalone "**" globstar — minimatch only treats ** as globstar when
    // it is its own path segment, so a "tool:**" prefix would collapse to
    // single-star behavior and fail to match candidates containing "/".
    // The tool field is already filtered by findHighestPriorityRule.
    {
      id: "starter:allow-file_read",
      tool: "file_read",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
    {
      id: "starter:allow-glob",
      tool: "glob",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
    {
      id: "starter:allow-grep",
      tool: "grep",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
    {
      id: "starter:allow-list_directory",
      tool: "list_directory",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
    {
      id: "starter:allow-web_search",
      tool: "web_search",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
    {
      id: "starter:allow-web_fetch",
      tool: "web_fetch",
      pattern: "**",
      scope: "everywhere",
      decision: "allow",
      priority: 90,
    },
  ];
}

/** Whether the user has previously accepted the starter bundle (file backend). */
function fileIsStarterBundleAccepted(): boolean {
  // Ensure rules are loaded (which also loads the flag from disk)
  getRules();
  return cachedStarterBundleAccepted === true;
}

/**
 * Seed the trust store with the starter bundle rules (file backend).
 *
 * Idempotent: if the bundle was already accepted, no rules are added and
 * `alreadyAccepted` is returned as true.  Rules whose IDs already exist
 * (e.g. from a previous partial acceptance) are skipped individually.
 */
function fileAcceptStarterBundle(): AcceptStarterBundleResult {
  // Re-read from disk to avoid lost updates.
  cachedRules = null;
  cachedStarterBundleAccepted = null;
  const rules = [...getRules()];

  if (cachedStarterBundleAccepted === true) {
    return { accepted: true, rulesAdded: 0, alreadyAccepted: true };
  }

  const existingIds = new Set(rules.map((r) => r.id));
  let added = 0;

  for (const template of fileGetStarterBundleRules()) {
    if (existingIds.has(template.id)) continue;
    rules.push({
      id: template.id,
      tool: template.tool,
      pattern: template.pattern,
      scope: template.scope,
      decision: template.decision,
      priority: template.priority,
      createdAt: Date.now(),
    });
    added++;
  }

  cachedStarterBundleAccepted = true;
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ rulesAdded: added }, "Starter approval bundle accepted");

  return { accepted: true, rulesAdded: added, alreadyAccepted: false };
}

// ─── Backend interface ──────────────────────────────────────────────────────

/**
 * File-based trust store backend. Wraps the module-level functions into a
 * `TrustStoreBackend` so callers can program against the interface.
 */
const fileTrustStoreBackend: TrustStoreBackend = {
  getAllRules: fileGetAllRules,
  findHighestPriorityRule: fileFindHighestPriorityRule,
  findMatchingRule: fileFindMatchingRule,
  findDenyRule: fileFindDenyRule,
  addRule: fileAddRule,
  updateRule: fileUpdateRule,
  removeRule: fileRemoveRule,
  clearAllRules: fileClearAllRules,
  acceptStarterBundle: fileAcceptStarterBundle,
  isStarterBundleAccepted: fileIsStarterBundleAccepted,
  onRulesChanged: fileOnRulesChanged,
  clearCache: fileClearCache,
  patternMatchesCandidate: filePatternMatchesCandidate,
  getStarterBundleRules: fileGetStarterBundleRules,
};

// ─── Gateway-backed trust store adapter ─────────────────────────────────────
//
// When the daemon runs in a container (IS_CONTAINERIZED=true), trust rules
// are stored in the gateway — not on the local filesystem. This adapter
// wraps the async gateway HTTP client into the synchronous TrustStoreBackend
// interface using an in-memory cache.
//
// Read operations serve from the cache. Write operations call the gateway
// synchronously (via curl), then update the cache from the response.
// A background timer refreshes the cache every CACHE_TTL_MS.

const CACHE_TTL_MS = 5_000;

/**
 * Gateway-backed trust store that caches rules in memory and refreshes
 * on a TTL. Satisfies the synchronous TrustStoreBackend interface by
 * reading from cache and writing via synchronous HTTP calls.
 */
class GatewayTrustStoreAdapter implements TrustStoreBackend {
  private rules: TrustRule[] = [];
  private starterBundleAccepted = false;
  private initialized = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners: Array<() => void> = [];

  /** Pattern cache — mirrors the file-based store's approach. */
  private readonly gwCompiledPatterns = new Map<string, Minimatch>();
  private readonly gwInvalidPatterns = new Set<string>();

  // ── Initialization ──────────────────────────────────────────────────────

  /**
   * Ensure the cache is populated. Blocks synchronously on the first call
   * by fetching rules from the gateway via the sync client. Subsequent
   * calls are no-ops because the background refresh timer keeps the cache
   * current.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    try {
      this.rules = trustClient.getAllRulesSync();
      this.rules.sort(ruleOrder);
      this.rebuildPatternCache();
      // Infer starterBundleAccepted from the fetched rules — if any starter
      // rule IDs are present, the bundle was accepted.
      const starterIds = new Set(fileGetStarterBundleRules().map((r) => r.id));
      this.starterBundleAccepted = this.rules.some((r) => starterIds.has(r.id));
    } catch (err) {
      log.error(
        { err },
        "Failed to load trust rules from gateway; using empty rule set",
      );
      this.rules = [];
    }
    this.initialized = true;
    this.startRefreshTimer();
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer != null) return;
    this.refreshTimer = setInterval(() => {
      this.refreshCache();
    }, CACHE_TTL_MS);
    // Unref so the timer doesn't prevent the process from exiting.
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === "object" &&
      "unref" in this.refreshTimer
    ) {
      (this.refreshTimer as NodeJS.Timeout).unref();
    }
  }

  private refreshCache(): void {
    try {
      const fresh = trustClient.getAllRulesSync();
      fresh.sort(ruleOrder);
      const oldJson = JSON.stringify(this.rules);
      this.rules = fresh;
      this.rebuildPatternCache();
      // Detect starter bundle acceptance
      const starterIds = new Set(fileGetStarterBundleRules().map((r) => r.id));
      this.starterBundleAccepted = this.rules.some((r) => starterIds.has(r.id));
      if (JSON.stringify(fresh) !== oldJson) {
        this.notifyListeners();
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to refresh trust rules from gateway; using stale cache",
      );
    }
  }

  private rebuildPatternCache(): void {
    this.gwCompiledPatterns.clear();
    this.gwInvalidPatterns.clear();
    for (const rule of this.rules) {
      if (typeof rule.pattern !== "string") continue;
      if (!this.gwCompiledPatterns.has(rule.pattern)) {
        try {
          this.gwCompiledPatterns.set(
            rule.pattern,
            new Minimatch(rule.pattern),
          );
        } catch {
          // skip invalid patterns
        }
      }
    }
  }

  private getCompiledPattern(pattern: string): Minimatch | null {
    if (this.gwInvalidPatterns.has(pattern)) return null;
    let compiled = this.gwCompiledPatterns.get(pattern);
    if (!compiled) {
      try {
        compiled = new Minimatch(pattern);
        this.gwCompiledPatterns.set(pattern, compiled);
      } catch {
        this.gwInvalidPatterns.add(pattern);
        return null;
      }
    }
    return compiled;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ── TrustStoreBackend implementation ────────────────────────────────────

  getAllRules(): TrustRule[] {
    this.ensureInitialized();
    return [...this.rules];
  }

  findHighestPriorityRule(
    tool: string,
    commands: string[],
    scope: string,
    ctx?: PolicyContext,
  ): TrustRule | null {
    this.ensureInitialized();
    const ephemeral = ctx?.ephemeralRules ?? [];
    const allRules =
      ephemeral.length > 0
        ? [...ephemeral, ...this.rules].sort(ruleOrder)
        : this.rules;

    for (const rule of allRules) {
      if (rule.tool !== tool) continue;
      if (!matchesScope(effectiveScope(rule), scope)) continue;
      if (!matchesExecutionTarget(rule, ctx)) continue;
      const compiled = this.getCompiledPattern(rule.pattern);
      if (!compiled) continue;
      for (const command of commands) {
        if (compiled.match(command)) {
          return rule;
        }
      }
    }
    return null;
  }

  findMatchingRule(
    tool: string,
    command: string,
    scope: string,
  ): TrustRule | null {
    this.ensureInitialized();
    for (const rule of this.rules) {
      if (rule.tool !== tool) continue;
      if (rule.decision !== "allow") continue;
      const compiled = this.getCompiledPattern(rule.pattern);
      if (!compiled || !compiled.match(command)) continue;
      if (!matchesScope(effectiveScope(rule), scope)) continue;
      return rule;
    }
    return null;
  }

  findDenyRule(tool: string, command: string, scope: string): TrustRule | null {
    this.ensureInitialized();
    for (const rule of this.rules) {
      if (rule.tool !== tool) continue;
      if (rule.decision !== "deny") continue;
      const compiled = this.getCompiledPattern(rule.pattern);
      if (!compiled || !compiled.match(command)) continue;
      if (!matchesScope(effectiveScope(rule), scope)) continue;
      return rule;
    }
    return null;
  }

  addRule(
    tool: string,
    pattern: string,
    scope: string,
    decision: "allow" | "deny" | "ask" = "allow",
    priority: number = 100,
    options?: {
      allowHighRisk?: boolean;
      executionTarget?: string;
    },
  ): TrustRule {
    if (tool.startsWith("__internal:"))
      throw new Error(
        `Cannot create internal pseudo-rule via addRule: ${tool}`,
      );

    // Canonicalize through the shared parser so fields invalid for the tool's
    // family are stripped before sending to the gateway.
    const { rule: canonical } = parseTrustRule({
      id: "",
      tool,
      pattern,
      scope,
      decision,
      priority,
      createdAt: 0,
      ...(options?.allowHighRisk != null
        ? { allowHighRisk: options.allowHighRisk }
        : {}),
      ...(options?.executionTarget != null
        ? { executionTarget: options.executionTarget }
        : {}),
    });
    const canonicalOpts: { allowHighRisk?: boolean; executionTarget?: string } =
      {};
    if ("allowHighRisk" in canonical) {
      canonicalOpts.allowHighRisk = (
        canonical as { allowHighRisk?: boolean }
      ).allowHighRisk;
    }
    if ("executionTarget" in canonical) {
      canonicalOpts.executionTarget = (
        canonical as { executionTarget?: string }
      ).executionTarget;
    }

    this.ensureInitialized();
    const rule = trustClient.addRuleSync({
      tool: canonical.tool,
      pattern: canonical.pattern,
      scope: canonical.scope,
      decision: canonical.decision,
      priority: canonical.priority,
      allowHighRisk: canonicalOpts.allowHighRisk,
      executionTarget: canonicalOpts.executionTarget,
    });
    // Update local cache
    this.rules = [...this.rules, rule].sort(ruleOrder);
    this.rebuildPatternCache();
    this.notifyListeners();
    log.info({ rule }, "Added trust rule via gateway");
    return rule;
  }

  updateRule(
    id: string,
    updates: {
      tool?: string;
      pattern?: string;
      scope?: string;
      decision?: "allow" | "deny" | "ask";
      priority?: number;
    },
  ): TrustRule {
    if (updates.tool?.startsWith("__internal:"))
      throw new Error(
        `Cannot update tool to internal pseudo-rule: ${updates.tool}`,
      );
    this.ensureInitialized();

    // Send only the caller's partial updates to the gateway.  The gateway's
    // own updateRule merges and canonicalizes via parseTrustRule, so doing a
    // full-rule merge here against the local cache would risk overwriting
    // concurrent edits with stale cached values.
    const rule = trustClient.updateRuleSync(id, updates);
    // Update local cache
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    this.rules = [...this.rules].sort(ruleOrder);
    this.rebuildPatternCache();
    this.notifyListeners();
    log.info({ rule }, "Updated trust rule via gateway");
    return rule;
  }

  removeRule(id: string): boolean {
    this.ensureInitialized();
    const success = trustClient.removeRuleSync(id);
    if (success) {
      this.rules = this.rules.filter((r) => r.id !== id);
      this.rebuildPatternCache();
      this.notifyListeners();
      log.info({ id }, "Removed trust rule via gateway");
    }
    return success;
  }

  clearAllRules(): void {
    this.ensureInitialized();
    trustClient.clearRulesSync();
    this.starterBundleAccepted = false;
    // Re-fetch to get the default rules the gateway preserves
    try {
      this.rules = trustClient.getAllRulesSync();
      this.rules.sort(ruleOrder);
    } catch {
      this.rules = [];
    }
    this.rebuildPatternCache();
    this.notifyListeners();
    log.info("Cleared all user trust rules via gateway");
  }

  acceptStarterBundle(): AcceptStarterBundleResult {
    this.ensureInitialized();
    const result = trustClient.acceptStarterBundleSync();
    this.starterBundleAccepted = true;
    // Refresh cache to include the newly added starter rules
    try {
      this.rules = trustClient.getAllRulesSync();
      this.rules.sort(ruleOrder);
    } catch {
      // Keep stale cache
    }
    this.rebuildPatternCache();
    this.notifyListeners();
    log.info(
      { rulesAdded: result.rulesAdded },
      "Starter approval bundle accepted via gateway",
    );
    return { ...result, alreadyAccepted: result.rulesAdded === 0 };
  }

  isStarterBundleAccepted(): boolean {
    this.ensureInitialized();
    return this.starterBundleAccepted;
  }

  onRulesChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  clearCache(): void {
    this.initialized = false;
    this.rules = [];
    this.starterBundleAccepted = false;
    this.gwCompiledPatterns.clear();
    this.gwInvalidPatterns.clear();
    if (this.refreshTimer != null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  patternMatchesCandidate(pattern: string, candidate: string): boolean {
    const compiled = this.getCompiledPattern(pattern);
    if (!compiled) return false;
    return compiled.match(candidate);
  }

  getStarterBundleRules(): StarterBundleRule[] {
    // Starter bundle definitions are static — same regardless of backend.
    return fileGetStarterBundleRules();
  }
}

/** Singleton gateway adapter instance (lazily created). */
let gatewayTrustStoreBackend: GatewayTrustStoreAdapter | null = null;

function getGatewayTrustStore(): GatewayTrustStoreAdapter {
  if (!gatewayTrustStoreBackend) {
    gatewayTrustStoreBackend = new GatewayTrustStoreAdapter();
  }
  return gatewayTrustStoreBackend;
}

/**
 * Returns the active trust store backend.
 *
 * When `IS_CONTAINERIZED=true`, returns a gateway-backed adapter that
 * proxies all trust operations through the gateway HTTP API.
 *
 * When `IS_CONTAINERIZED=false`, returns the file-based implementation.
 */
export function getTrustStore(): TrustStoreBackend {
  if (getIsContainerized()) {
    return getGatewayTrustStore();
  }
  return fileTrustStoreBackend;
}

// ─── Module-level exports that delegate through getTrustStore() ─────────────
//
// All existing callers import these functions directly. By delegating through
// getTrustStore(), they automatically get the right backend (file-based or
// gateway-backed) without changing their imports.

export function addRule(
  tool: string,
  pattern: string,
  scope: string,
  decision: "allow" | "deny" | "ask" = "allow",
  priority: number = 100,
  options?: {
    allowHighRisk?: boolean;
    executionTarget?: string;
  },
): TrustRule {
  return getTrustStore().addRule(
    tool,
    pattern,
    scope,
    decision,
    priority,
    options,
  );
}

export function updateRule(
  id: string,
  updates: {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: "allow" | "deny" | "ask";
    priority?: number;
  },
): TrustRule {
  return getTrustStore().updateRule(id, updates);
}

export function removeRule(id: string): boolean {
  return getTrustStore().removeRule(id);
}

export function clearAllRules(): void {
  getTrustStore().clearAllRules();
}

export function getAllRules(): TrustRule[] {
  return getTrustStore().getAllRules();
}

export function findHighestPriorityRule(
  tool: string,
  commands: string[],
  scope: string,
  ctx?: PolicyContext,
): TrustRule | null {
  return getTrustStore().findHighestPriorityRule(tool, commands, scope, ctx);
}

export function findMatchingRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return getTrustStore().findMatchingRule(tool, command, scope);
}

export function findDenyRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return getTrustStore().findDenyRule(tool, command, scope);
}

export function acceptStarterBundle(): AcceptStarterBundleResult {
  return getTrustStore().acceptStarterBundle();
}

export function isStarterBundleAccepted(): boolean {
  return getTrustStore().isStarterBundleAccepted();
}

export function getStarterBundleRules(): StarterBundleRule[] {
  return getTrustStore().getStarterBundleRules();
}

export function onRulesChanged(listener: () => void): void {
  getTrustStore().onRulesChanged(listener);
}

export function clearCache(): void {
  getTrustStore().clearCache();
}

export function patternMatchesCandidate(
  pattern: string,
  candidate: string,
): boolean {
  return getTrustStore().patternMatchesCandidate(pattern, candidate);
}
