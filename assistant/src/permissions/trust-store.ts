import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { v4 as uuid } from 'uuid';
import { minimatch } from 'minimatch';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getDefaultRuleTemplates } from './defaults.js';
import type { TrustRule, PolicyContext } from './types.js';

const log = getLogger('trust-store');

const TRUST_FILE_VERSION = 3;

interface TrustFile {
  version: number;
  rules: TrustRule[];
}

let cachedRules: TrustRule[] | null = null;

function getTrustPath(): string {
  return join(getRootDir(), 'protected', 'trust.json');
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
  const oldDefaultPrefix = 'default:deny-';
  const newDefaultPrefix = 'default:ask-';
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.id.startsWith(oldDefaultPrefix) && rule.id.endsWith('-protected')) {
      const newId = newDefaultPrefix + rule.id.slice(oldDefaultPrefix.length);
      rules.splice(i, 1);
      existingIds.delete(rule.id);
      // Don't add newId to existingIds — let the backfill loop re-add it
      changed = true;
      log.info({ oldId: rule.id, newId }, 'Migrated default deny rule to ask');
    }
  }

  // Remove default rules that are no longer in the template set (e.g.
  // computer_use_done/computer_use_respond were removed from the ask-rule list
  // because they are terminal signal tools that don't need approval).
  const templateIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.id.startsWith('default:') && !templateIds.has(rule.id)) {
      rules.splice(i, 1);
      existingIds.delete(rule.id);
      changed = true;
      log.info({ ruleId: rule.id }, 'Removed stale default trust rule');
    }
  }

  // Migrate existing default rules whose priority or pattern has changed
  // in the template (e.g. host_bash pattern changed from '*' to '**',
  // host tool priorities changed from 1000 to 50).
  for (const template of getDefaultRuleTemplates()) {
    if (existingIds.has(template.id)) {
      const rule = rules.find((r) => r.id === template.id);
      if (rule && (rule.priority !== template.priority || rule.pattern !== template.pattern)) {
        log.info(
          { ruleId: rule.id, oldPriority: rule.priority, newPriority: template.priority, oldPattern: rule.pattern, newPattern: template.pattern },
          'Migrated default rule to updated template values',
        );
        rule.priority = template.priority;
        rule.pattern = template.pattern;
        changed = true;
      }
    }
  }

  for (const template of getDefaultRuleTemplates()) {
    if (!existingIds.has(template.id)) {
      rules.push({
        id: template.id,
        tool: template.tool,
        pattern: template.pattern,
        scope: template.scope,
        decision: template.decision,
        priority: template.priority,
        createdAt: Date.now(),
      });
      changed = true;
      log.info({ ruleId: template.id }, 'Backfilled default trust rule');
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
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as TrustFile;

      // Guard: ensure rules is an array (protects against hand-edited files)
      const rawRules = Array.isArray(data.rules) ? data.rules : [];

      if (data.version === 1) {
        // Migration: v1 → v2. All existing rules are user-created → priority 100.
        rules = rawRules.map((r) => ({
          ...r,
          priority: 100,
        }));
        needsSave = true;
        log.info({ ruleCount: rules.length }, 'Migrated v1 trust rules to v2 (priority=100)');
        // Fall through to v2 → v3 migration below
      }

      if (data.version === 2 || (data.version === 1 && needsSave)) {
        // Migration: v2 → v3. Existing rules have no principal fields,
        // which is correct — missing principal fields act as wildcards.
        if (data.version === 2) {
          rules = rawRules;
        }
        needsSave = true;
        log.info({ ruleCount: rules.length }, 'Migrated v2 trust rules to v3 (principal fields)');
      } else if (data.version === TRUST_FILE_VERSION) {
        rules = rawRules;
      } else if (data.version !== 1) {
        log.warn({ version: data.version }, 'Unknown trust file version, applying defaults in-memory only');
        // Apply default deny rules in-memory so the assistant is still
        // protected, but do NOT persist — we must not overwrite a newer
        // trust file format we don't understand.
        const memRules: TrustRule[] = [];
        backfillDefaults(memRules);
        memRules.sort(ruleOrder);
        return memRules;
      }
    } catch (err) {
      log.error({ err }, 'Failed to load trust file');
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
      log.warn({ err }, 'Failed to persist migrated trust rules (continuing with in-memory rules)');
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
  const tmpPath = path + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, path);
}

function getRules(): TrustRule[] {
  if (cachedRules === null) {
    cachedRules = loadFromDisk();
  }
  return cachedRules;
}

export function addRule(
  tool: string,
  pattern: string,
  scope: string,
  decision: 'allow' | 'deny' | 'ask' = 'allow',
  priority: number = 100,
): TrustRule {
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
  rules.push(rule);
  rules.sort(ruleOrder);
  cachedRules = rules;
  saveToDisk(rules);
  log.info({ rule }, 'Added trust rule');
  return rule;
}

export function updateRule(
  id: string,
  updates: { tool?: string; pattern?: string; scope?: string; decision?: 'allow' | 'deny' | 'ask'; priority?: number },
): TrustRule {
  const defaultIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  if (defaultIds.has(id)) throw new Error(`Cannot modify default trust rule: ${id}`);

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
  saveToDisk(rules);
  log.info({ rule }, 'Updated trust rule');
  return rule;
}

export function removeRule(id: string): boolean {
  const defaultIds = new Set(getDefaultRuleTemplates().map((t) => t.id));
  if (defaultIds.has(id)) throw new Error(`Cannot remove default trust rule: ${id}`);

  // Re-read from disk to avoid lost updates from concurrent modifications.
  cachedRules = null;
  const rules = [...getRules()];
  const index = rules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  rules.splice(index, 1);
  cachedRules = rules;
  saveToDisk(rules);
  log.info({ id }, 'Removed trust rule');
  return true;
}

function matchesScope(ruleScope: string, workingDir: string): boolean {
  if (ruleScope === 'everywhere') return true;
  return workingDir.startsWith(ruleScope.replace(/\*$/, ''));
}

function findRuleByDecision(tool: string, command: string, scope: string, decision: 'allow' | 'deny' | 'ask'): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (rule.decision !== decision) continue;
    if (!minimatch(command, rule.pattern)) continue;
    if (!matchesScope(rule.scope, scope)) continue;
    return rule;
  }
  return null;
}

/**
 * Check whether a rule's principal constraints match the given policy context.
 *
 * A missing field on the rule acts as a wildcard — it matches any value
 * (or absence) in the context. When a rule specifies a principal field,
 * the context must provide a matching value for the rule to apply.
 */
function matchesPrincipal(rule: TrustRule, ctx?: PolicyContext): boolean {
  // If the rule has no principal constraints it matches everything (wildcard).
  if (rule.principalKind == null && rule.principalId == null && rule.principalVersion == null) {
    return true;
  }

  const principal = ctx?.principal;

  // Rule specifies a principalKind — context must supply one that matches.
  if (rule.principalKind != null) {
    if (principal?.kind !== rule.principalKind) return false;
  }

  // Rule specifies a principalId — context must supply one that matches.
  if (rule.principalId != null) {
    if (principal?.id !== rule.principalId) return false;
  }

  // Rule specifies a principalVersion — context must supply one that matches.
  // If the rule omits principalVersion, any version (or none) is accepted.
  if (rule.principalVersion != null) {
    if (principal?.version !== rule.principalVersion) return false;
  }

  return true;
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
 * When a `PolicyContext` is provided, rules that specify principal or
 * executionTarget constraints are filtered accordingly. Rules without
 * those constraints act as wildcards and match any context.
 */
export function findHighestPriorityRule(tool: string, commands: string[], scope: string, ctx?: PolicyContext): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (!matchesScope(rule.scope, scope)) continue;
    if (!matchesPrincipal(rule, ctx)) continue;
    if (!matchesExecutionTarget(rule, ctx)) continue;
    for (const command of commands) {
      if (minimatch(command, rule.pattern)) {
        return rule;
      }
    }
  }
  return null;
}

export function findMatchingRule(tool: string, command: string, scope: string): TrustRule | null {
  return findRuleByDecision(tool, command, scope, 'allow');
}

export function findDenyRule(tool: string, command: string, scope: string): TrustRule | null {
  return findRuleByDecision(tool, command, scope, 'deny');
}

export function getAllRules(): TrustRule[] {
  return [...getRules()];
}

export function clearAllRules(): void {
  // Re-backfill default rules so protected directory stays guarded.
  const rules: TrustRule[] = [];
  backfillDefaults(rules);
  rules.sort(ruleOrder);
  cachedRules = rules;
  saveToDisk(rules);
  log.info('Cleared all user trust rules (default rules preserved)');
}

export function clearCache(): void {
  cachedRules = null;
}
