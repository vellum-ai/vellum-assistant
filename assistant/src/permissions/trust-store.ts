import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { v4 as uuid } from 'uuid';
import { minimatch } from 'minimatch';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getDefaultRuleTemplates } from './defaults.js';
import type { TrustRule } from './types.js';

const log = getLogger('trust-store');

const TRUST_FILE_VERSION = 2;

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
  if (a.decision !== b.decision) return a.decision === 'deny' ? -1 : 1;
  return 0;
}

/**
 * Ensure default deny rules are always present in the rule set.
 * Mutates the provided array and returns whether any rules were added.
 */
function backfillDefaults(rules: TrustRule[]): boolean {
  let added = false;
  const existingIds = new Set(rules.map((r) => r.id));
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
      added = true;
      log.info({ ruleId: template.id }, 'Backfilled default trust rule');
    }
  }
  return added;
}

function loadFromDisk(): TrustRule[] {
  const path = getTrustPath();
  let rules: TrustRule[] = [];
  let needsSave = false;

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as TrustFile;

      if (data.version === 1) {
        // Migration: v1 → v2. All existing rules are user-created → priority 100.
        rules = (data.rules ?? []).map((r) => ({
          ...r,
          priority: 100,
        }));
        needsSave = true;
        log.info({ ruleCount: rules.length }, 'Migrated v1 trust rules to v2 (priority=100)');
      } else if (data.version === TRUST_FILE_VERSION) {
        rules = data.rules ?? [];
      } else {
        log.warn({ version: data.version }, 'Unknown trust file version, ignoring');
        // Fall through to backfill defaults even for unknown versions
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
  decision: 'allow' | 'deny' = 'allow',
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

export function removeRule(id: string): boolean {
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

function findRuleByDecision(tool: string, command: string, scope: string, decision: 'allow' | 'deny'): TrustRule | null {
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
 * Find the highest-priority rule that matches any of the command candidates.
 * Rules are pre-sorted by priority descending, so the first match wins.
 */
export function findHighestPriorityRule(tool: string, commands: string[], scope: string): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (!matchesScope(rule.scope, scope)) continue;
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
  // Re-backfill default deny rules so protected directory stays guarded.
  const rules: TrustRule[] = [];
  backfillDefaults(rules);
  rules.sort(ruleOrder);
  cachedRules = rules;
  saveToDisk(rules);
  log.info('Cleared all user trust rules (default deny rules preserved)');
}

export function clearCache(): void {
  cachedRules = null;
}
