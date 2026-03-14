import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Minimatch } from "minimatch";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getRootDir } from "../util/platform.js";
import { getDefaultRuleTemplates } from "./defaults.js";
import type { PolicyContext, TrustRule } from "./types.js";

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

/** Register a callback to be invoked whenever trust rules change. */
export function onRulesChanged(listener: () => void): void {
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
 * Check whether a minimatch pattern matches a candidate string.
 * Reuses the compiled pattern cache from trust rule evaluation.
 */
export function patternMatchesCandidate(
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
  return join(getRootDir(), "protected", "trust.json");
}

/**
 * Sort comparator: highest priority first. At the same priority, deny rules
 * come before allow rules for safety (deny wins ties).
 */
function ruleOrder(a: TrustRule, b: TrustRule): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.decision !== b.decision) {
    // deny > ask > allow
    const order = { deny: 0, ask: 1, allow: 2 };
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

  // Migrate existing default rules whose priority, pattern, decision, or
  // allowHighRisk has changed in the template (e.g. host_bash pattern changed
  // from '*' to '**', host tool priorities changed from 1000 to 50).
  for (const template of getDefaultRuleTemplates()) {
    if (existingIds.has(template.id)) {
      const rule = rules.find((r) => r.id === template.id);
      if (
        rule &&
        (rule.priority !== template.priority ||
          rule.pattern !== template.pattern ||
          rule.decision !== template.decision ||
          rule.allowHighRisk !== template.allowHighRisk)
      ) {
        log.info(
          {
            ruleId: rule.id,
            oldPriority: rule.priority,
            newPriority: template.priority,
            oldPattern: rule.pattern,
            newPattern: template.pattern,
          },
          "Migrated default rule to updated template values",
        );
        rule.priority = template.priority;
        rule.pattern = template.pattern;
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
      const rule: TrustRule = {
        id: template.id,
        tool: template.tool,
        pattern: template.pattern,
        scope: template.scope,
        decision: template.decision,
        priority: template.priority,
        createdAt: Date.now(),
      };
      if (template.allowHighRisk != null) {
        rule.allowHighRisk = template.allowHighRisk;
      }
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
        rules = sanitizedRules;
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
  if (tool.startsWith("__internal:"))
    throw new Error(`Cannot create internal pseudo-rule via addRule: ${tool}`);
  // Re-read from disk to avoid lost updates if another call modified rules
  // between our last read and now (e.g. two rapid trust rule additions).
  cachedRules = null;
  const rules = [...getRules()];
  const rule: TrustRule = {
    id: uuid(),
    tool,
    pattern,
    scope,
    decision,
    priority,
    createdAt: Date.now(),
  };
  if (options?.allowHighRisk != null) {
    rule.allowHighRisk = options.allowHighRisk;
  }
  if (options?.executionTarget != null) {
    rule.executionTarget = options.executionTarget;
  }
  rules.push(rule);
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ rule }, "Added trust rule");
  return rule;
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
  const defaultIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  if (defaultIds.has(id))
    throw new Error(`Cannot modify default trust rule: ${id}`);
  if (updates.tool?.startsWith("__internal:"))
    throw new Error(
      `Cannot update tool to internal pseudo-rule: ${updates.tool}`,
    );

  // Re-read from disk to avoid lost updates from concurrent modifications.
  cachedRules = null;
  const rules = [...getRules()];
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`Trust rule not found: ${id}`);
  const rule = { ...rules[index] };
  if (updates.tool != null) rule.tool = updates.tool;
  if (updates.pattern != null) rule.pattern = updates.pattern;
  if (updates.scope != null) rule.scope = updates.scope;
  if (updates.decision != null) rule.decision = updates.decision;
  if (updates.priority != null) rule.priority = updates.priority;
  rules[index] = rule;
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  notifyRulesChanged();
  log.info({ rule }, "Updated trust rule");
  return rule;
}

export function removeRule(id: string): boolean {
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
    if (!matchesScope(rule.scope, scope)) continue;
    return rule;
  }
  return null;
}

/**
 * Check whether a rule's executionTarget constraint matches the context.
 *
 * If the rule does not specify an executionTarget it matches any target
 * (wildcard). If specified, it must match exactly.
 */
function matchesExecutionTarget(rule: TrustRule, ctx?: PolicyContext): boolean {
  if (rule.executionTarget == null) return true;
  return ctx?.executionTarget === rule.executionTarget;
}

/**
 * Find the highest-priority rule that matches any of the command candidates.
 * Rules are pre-sorted by priority descending, so the first match wins.
 *
 * When a `PolicyContext` is provided, rules that specify executionTarget
 * constraints are filtered accordingly. Rules without those constraints
 * act as wildcards and match any context.
 */
export function findHighestPriorityRule(
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
    if (!matchesScope(rule.scope, scope)) continue;
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

export function findMatchingRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return findRuleByDecision(tool, command, scope, "allow");
}

export function findDenyRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  return findRuleByDecision(tool, command, scope, "deny");
}

export function getAllRules(): TrustRule[] {
  return [...getRules()];
}

export function clearAllRules(): void {
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

export function clearCache(): void {
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

export interface StarterBundleRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: "allow";
  priority: number;
}

/**
 * Returns the starter bundle rule definitions.  These cover read-only and
 * information-gathering tools that never mutate the filesystem or execute
 * arbitrary code.
 */
export function getStarterBundleRules(): StarterBundleRule[] {
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

/** Whether the user has previously accepted the starter bundle. */
export function isStarterBundleAccepted(): boolean {
  // Ensure rules are loaded (which also loads the flag from disk)
  getRules();
  return cachedStarterBundleAccepted === true;
}

export interface AcceptStarterBundleResult {
  accepted: boolean;
  rulesAdded: number;
  alreadyAccepted: boolean;
}

/**
 * Seed the trust store with the starter bundle rules.
 *
 * Idempotent: if the bundle was already accepted, no rules are added and
 * `alreadyAccepted` is returned as true.  Rules whose IDs already exist
 * (e.g. from a previous partial acceptance) are skipped individually.
 */
export function acceptStarterBundle(): AcceptStarterBundleResult {
  // Re-read from disk to avoid lost updates.
  cachedRules = null;
  cachedStarterBundleAccepted = null;
  const rules = [...getRules()];

  if (cachedStarterBundleAccepted === true) {
    return { accepted: true, rulesAdded: 0, alreadyAccepted: true };
  }

  const existingIds = new Set(rules.map((r) => r.id));
  let added = 0;

  for (const template of getStarterBundleRules()) {
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
