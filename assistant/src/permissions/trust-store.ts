import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { v4 as uuid } from 'uuid';
import { minimatch } from 'minimatch';
import { getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import type { TrustRule } from './types.js';

const log = getLogger('trust-store');

const TRUST_FILE_VERSION = 1;

interface TrustFile {
  version: number;
  rules: TrustRule[];
}

let cachedRules: TrustRule[] | null = null;

function getTrustPath(): string {
  return join(getDataDir(), 'trust.json');
}

function loadFromDisk(): TrustRule[] {
  const path = getTrustPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as TrustFile;
    if (data.version !== TRUST_FILE_VERSION) {
      log.warn({ version: data.version }, 'Unknown trust file version, ignoring');
      return [];
    }
    return data.rules ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to load trust file');
    return [];
  }
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

export function addRule(tool: string, pattern: string, scope: string, decision: 'allow' | 'deny' = 'allow'): TrustRule {
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
    createdAt: Date.now(),
  };
  rules.push(rule);
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

function findRuleByDecision(tool: string, command: string, scope: string, decision: 'allow' | 'deny'): TrustRule | null {
  const rules = getRules();
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (rule.decision !== decision) continue;
    if (!minimatch(command, rule.pattern)) continue;
    // Scope check: rule scope must be a prefix of the working dir, or 'everywhere'
    if (rule.scope !== 'everywhere' && !scope.startsWith(rule.scope.replace(/\*$/, ''))) continue;
    return rule;
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
  cachedRules = [];
  saveToDisk([]);
  log.info('Cleared all trust rules');
}

export function clearCache(): void {
  cachedRules = null;
}
