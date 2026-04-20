/**
 * Gateway-side trust store — file-backed persistence of trust rules.
 *
 * Ported from `assistant/src/permissions/trust-store.ts` so that the gateway
 * can own trust rule CRUD and expose it via HTTP API.  The assistant daemon
 * will later use the gateway's HTTP API instead of reading trust.json directly.
 */

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

import type {
  TrustDecision,
  TrustFileData,
  TrustRule,
} from "@vellumai/ces-contracts/trust-rules";
import {
  parseTrustFileData,
  parseTrustRule,
} from "@vellumai/ces-contracts/trust-rules";

import { getLogger } from "./logger.js";
import { getGatewaySecurityDir } from "./paths.js";

export type { TrustDecision, TrustRule };

const log = getLogger("trust-store");

const TRUST_FILE_VERSION = 3;

// ---------------------------------------------------------------------------
// Starter bundle definitions
// ---------------------------------------------------------------------------

export interface StarterBundleRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: "allow";
  priority: number;
}

function getStarterBundleRules(): StarterBundleRule[] {
  return [
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

// ---------------------------------------------------------------------------
// Pattern compilation cache
// ---------------------------------------------------------------------------

const compiledPatterns = new Map<string, Minimatch>();
const invalidPatterns = new Set<string>();

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

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

function getTrustPath(): string {
  return join(getGatewaySecurityDir(), "trust.json");
}

// ---------------------------------------------------------------------------
// Rule ordering
// ---------------------------------------------------------------------------

/**
 * Sort comparator: highest priority first. At the same priority, deny rules
 * come before allow rules for safety (deny wins ties).
 */
function ruleOrder(a: TrustRule, b: TrustRule): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.decision !== b.decision) {
    const order = { deny: 0, ask: 1, allow: 2 };
    return (order[a.decision] ?? 2) - (order[b.decision] ?? 2);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

function matchesScope(
  ruleScope: string | undefined,
  workingDir: string,
): boolean {
  if (!ruleScope || ruleScope === "everywhere") return true;
  const prefix = ruleScope.replace(/\*$/, "").replace(/\/+$/, "");
  const dir = workingDir.replace(/\/+$/, "");
  return dir === prefix || dir.startsWith(prefix + "/");
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

let cachedRules: TrustRule[] | null = null;
let cachedStarterBundleAccepted: boolean | null = null;

function loadFromDisk(): TrustRule[] {
  const path = getTrustPath();
  let rules: TrustRule[] = [];
  let needsSave = false;

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const version = typeof parsed.version === "number" ? parsed.version : 0;

      // Unknown future version — return empty rules for safety; do NOT
      // overwrite the file so a newer gateway can still read it.
      if (version !== TRUST_FILE_VERSION && version !== 1 && version !== 2) {
        log.warn(
          { version },
          "Unknown trust file version, returning empty rules",
        );
        return [];
      }

      // Parse and normalize using the shared canonical parser
      const { data, normalized } = parseTrustFileData(parsed);

      cachedStarterBundleAccepted = data.starterBundleAccepted === true;

      if (normalized) {
        needsSave = true;
      }

      // Version upgrade triggers re-save
      if (version !== TRUST_FILE_VERSION) {
        needsSave = true;
        log.info(
          { version, targetVersion: TRUST_FILE_VERSION },
          "Migrating legacy trust file version",
        );
      }

      // Strip __internal: rules that may have been hand-edited in
      const sanitizedRules = data.rules.filter((r) => {
        if (typeof r.tool === "string" && r.tool.startsWith("__internal:")) {
          log.warn(
            { ruleId: r.id, tool: r.tool },
            "Stripping __internal: rule from trust file on load",
          );
          needsSave = true;
          return false;
        }
        return true;
      });

      // Strip legacy principal-scoped fields
      for (const rule of sanitizedRules) {
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

      rules = sanitizedRules;
    } catch (err) {
      log.error({ err }, "Failed to load trust file");
    }
  }

  rules.sort(ruleOrder);

  if (needsSave) {
    try {
      saveToDisk(rules);
    } catch (err) {
      log.warn(
        { err },
        "Failed to persist normalized trust rules (continuing with in-memory rules)",
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
  const data: TrustFileData = { version: TRUST_FILE_VERSION, rules };
  if (cachedStarterBundleAccepted) {
    data.starterBundleAccepted = true;
  }
  const tmpPath = path + ".tmp." + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function getRules(): TrustRule[] {
  if (cachedRules == null) {
    cachedRules = loadFromDisk();
    rebuildPatternCache(cachedRules);
  }
  return cachedRules;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadRules(): TrustRule[] {
  return getRules();
}

export function saveRules(rules: TrustRule[]): void {
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
}

export function getAllRules(): TrustRule[] {
  return [...getRules()];
}

export function addRule(
  tool: string,
  pattern: string,
  scope: string,
  decision: TrustDecision = "allow",
  priority: number = 100,
  options?: {
    executionTarget?: string;
  },
): TrustRule {
  if (tool.startsWith("__internal:"))
    throw new Error(`Cannot create internal pseudo-rule via addRule: ${tool}`);

  // Re-read from disk to avoid lost updates
  cachedRules = null;
  const rules = [...getRules()];

  // Canonicalize through the shared parser so fields invalid for the tool's
  // family are stripped before persistence, regardless of callsite.
  const { rule: canonical } = parseTrustRule({
    id: uuid(),
    tool,
    pattern,
    scope,
    decision,
    priority,
    createdAt: Date.now(),
    ...(options?.executionTarget != null
      ? { executionTarget: options.executionTarget }
      : {}),
  });
  const rule = canonical;
  rules.push(rule);
  rules.sort(ruleOrder);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  log.info({ rule }, "Added trust rule");
  return rule;
}

export function updateRule(
  id: string,
  updates: {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: TrustDecision;
    priority?: number;
  },
): TrustRule {
  if (updates.tool?.startsWith("__internal:"))
    throw new Error(
      `Cannot update tool to internal pseudo-rule: ${updates.tool}`,
    );

  // Re-read from disk to avoid lost updates
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
  log.info({ rule }, "Updated trust rule");
  return rule;
}

export function removeRule(id: string): boolean {
  // Re-read from disk to avoid lost updates
  cachedRules = null;
  const rules = [...getRules()];
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  rules.splice(index, 1);
  cachedRules = rules;
  rebuildPatternCache(rules);
  saveToDisk(rules);
  log.info({ id }, "Removed trust rule");
  return true;
}

export function clearRules(): void {
  cachedStarterBundleAccepted = false;
  cachedRules = [];
  rebuildPatternCache([]);
  saveToDisk([]);
  log.info("Cleared all trust rules");
}

export function findMatchingRule(
  tool: string,
  command: string,
  scope: string,
): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    const compiled = getCompiledPattern(rule.pattern);
    if (!compiled || !compiled.match(command)) continue;
    if (!matchesScope(rule.scope, scope)) continue;
    return rule;
  }
  return null;
}

/**
 * Find the highest-priority rule that matches any of the command candidates.
 * Rules are pre-sorted by priority descending, so the first match wins.
 */
export function findHighestPriorityRule(
  tool: string,
  commands: string[],
  scope: string,
): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (!matchesScope(rule.scope, scope)) continue;
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

// ---------------------------------------------------------------------------
// Starter bundle
// ---------------------------------------------------------------------------

export interface AcceptStarterBundleResult {
  accepted: boolean;
  rulesAdded: number;
  alreadyAccepted: boolean;
}

export function isStarterBundleAccepted(): boolean {
  getRules();
  return cachedStarterBundleAccepted === true;
}

export function acceptStarterBundle(): AcceptStarterBundleResult {
  // Re-read from disk to avoid lost updates
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
  log.info({ rulesAdded: added }, "Starter approval bundle accepted");

  return { accepted: true, rulesAdded: added, alreadyAccepted: false };
}

/** Reset cached state (useful for tests). */
export function clearCache(): void {
  cachedRules = null;
  cachedStarterBundleAccepted = null;
  compiledPatterns.clear();
  invalidPatterns.clear();
}
