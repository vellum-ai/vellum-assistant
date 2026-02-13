import { RiskLevel, type PermissionCheckResult, type AllowlistOption, type ScopeOption } from './types.js';
import { findHighestPriorityRule } from './trust-store.js';
import { parse } from '../tools/terminal/parser.js';
import { resolveSkillSelector } from '../config/skills.js';
import { getTool } from '../tools/registry.js';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { looksLikeHostPortShorthand, looksLikePathOnlyInput } from '../tools/network/url-safety.js';

// Low-risk shell programs that are read-only / informational
const LOW_RISK_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  'grep', 'rg', 'ag', 'ack', 'find', 'fd', 'which', 'where', 'whereis', 'type',
  'echo', 'printf', 'date', 'cal', 'uptime', 'whoami', 'hostname', 'uname',
  'pwd', 'realpath', 'dirname', 'basename',
  'git', 'node', 'bun', 'deno', 'npm', 'npx', 'yarn', 'pnpm',
  'python', 'python3', 'pip', 'pip3',
  'man', 'help', 'info',
  'env', 'printenv', 'set',
  'diff', 'sort', 'uniq', 'cut', 'tr', 'tee', 'xargs',
  'jq', 'yq', 'sed', 'awk',
  'curl', 'wget', 'http', 'dig', 'nslookup', 'ping',
  'tree', 'du', 'df',
]);

// High-risk shell programs / patterns
const HIGH_RISK_PROGRAMS = new Set([
  'sudo', 'su', 'doas',
  'dd', 'mkfs', 'fdisk', 'parted', 'mount', 'umount',
  'systemctl', 'service', 'launchctl',
  'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel',
  'iptables', 'ufw', 'firewall-cmd',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'kill', 'killall', 'pkill',
]);

// Git subcommands that are low-risk (read-only)
const LOW_RISK_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'stash',
  'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'ls-tree',
  'cat-file', 'reflog',
]);

function isHighRiskRm(args: string[]): boolean {
  // rm with -r, -rf, -fr, or targeting root/home
  for (const arg of args) {
    if (arg.startsWith('-') && (arg.includes('r') || arg.includes('f'))) {
      return true;
    }
    if (arg === '/' || arg === '~' || arg === '$HOME') {
      return true;
    }
  }
  return false;
}

function getStringField(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function canonicalizeWebFetchUrl(parsed: URL): URL {
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';

  try {
    // Normalize equivalent escaped paths (for example, "/%70rivate" -> "/private")
    // so path-scoped trust rules cannot be bypassed via percent-encoding.
    parsed.pathname = decodeURI(parsed.pathname);
  } catch {
    // Keep URL parser canonical form when decoding fails.
  }

  if (parsed.hostname.endsWith('.')) {
    parsed.hostname = parsed.hostname.replace(/\.+$/, '');
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
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
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
  return value.replace(/([\\*?[\]{}()!+@|])/g, '\\$1');
}

function buildCommandCandidates(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'bash') {
    return [getStringField(input, 'command')];
  }

  if (toolName === 'skill_load') {
    const rawSelector = getStringField(input, 'skill').trim();
    const targets: string[] = [];
    if (!rawSelector) {
      targets.push('');
    } else {
      const resolved = resolveSkillSelector(rawSelector);
      if (resolved.skill) {
        targets.push(resolved.skill.id);
      }
      targets.push(rawSelector);
    }
    return [...new Set(targets)].map((target) => `${toolName}:${target}`);
  }

  if (toolName === 'web_fetch' || toolName === 'browser_navigate') {
    const rawUrl = getStringField(input, 'url').trim();
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

  const fileTarget = getStringField(input, 'path', 'file_path');
  return [`${toolName}:${fileTarget}`];
}

export async function classifyRisk(toolName: string, input: Record<string, unknown>): Promise<RiskLevel> {
  if (toolName === 'file_read') return RiskLevel.Low;
  if (toolName === 'file_write') return RiskLevel.Medium;
  if (toolName === 'file_edit') return RiskLevel.Medium;
  if (toolName === 'web_search') return RiskLevel.Low;
  if (toolName === 'web_fetch' || toolName === 'browser_navigate') {
    return input.allow_private_network === true ? RiskLevel.Medium : RiskLevel.Low;
  }
  if (toolName === 'browser_snapshot') return RiskLevel.Low;
  if (toolName === 'browser_close') {
    return input.close_all_pages === true ? RiskLevel.High : RiskLevel.Medium;
  }
  if (toolName === 'browser_click') return RiskLevel.Medium;
  if (toolName === 'browser_type') return RiskLevel.Medium;
  if (toolName === 'browser_press_key') return RiskLevel.Medium;
  if (toolName === 'browser_wait_for') return RiskLevel.Low;
  if (toolName === 'browser_extract') return RiskLevel.Low;
  if (toolName === 'skill_load') return RiskLevel.Low;

  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    if (!command.trim()) return RiskLevel.Low;

    const parsed = await parse(command);

    // Dangerous patterns → High
    if (parsed.dangerousPatterns.length > 0) return RiskLevel.High;

    // Opaque constructs → at least Medium (never Low)
    if (parsed.hasOpaqueConstructs) return RiskLevel.Medium;

    // Check each segment
    let maxRisk = RiskLevel.Low;

    for (const seg of parsed.segments) {
      const prog = seg.program;

      if (HIGH_RISK_PROGRAMS.has(prog)) return RiskLevel.High;

      if (prog === 'rm') {
        if (isHighRiskRm(seg.args)) return RiskLevel.High;
        maxRisk = RiskLevel.Medium;
        continue;
      }

      if (prog === 'chmod' || prog === 'chown' || prog === 'chgrp') {
        maxRisk = RiskLevel.Medium;
        continue;
      }

      if (prog === 'git') {
        const subcommand = seg.args[0];
        if (subcommand && LOW_RISK_GIT_SUBCOMMANDS.has(subcommand)) {
          // Stay at current risk
          continue;
        }
        // Non-read-only git commands are medium
        maxRisk = RiskLevel.Medium;
        continue;
      }

      if (!LOW_RISK_PROGRAMS.has(prog)) {
        // Unknown program → medium
        if (maxRisk === RiskLevel.Low) {
          maxRisk = RiskLevel.Medium;
        }
      }
    }

    // If no segments could be extracted, treat as opaque
    if (parsed.segments.length === 0) {
      return RiskLevel.Medium;
    }

    return maxRisk;
  }

  // Check the tool registry for a declared default risk level
  const tool = getTool(toolName);
  if (tool) return tool.defaultRiskLevel;

  // Unknown tool → Medium
  return RiskLevel.Medium;
}

export async function check(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): Promise<PermissionCheckResult> {
  const risk = await classifyRisk(toolName, input);

  // Build command string candidates for rule matching
  const commandCandidates = buildCommandCandidates(toolName, input);

  // Find the highest-priority matching rule across all candidates
  const matchedRule = findHighestPriorityRule(toolName, commandCandidates, workingDir);

  if (matchedRule) {
    if (matchedRule.decision === 'deny') {
      // Deny rules apply at ALL risk levels
      return { decision: 'deny', reason: `Blocked by deny rule: ${matchedRule.pattern}`, matchedRule };
    }

    // Allow rule: auto-allow for non-High risk
    if (risk !== RiskLevel.High) {
      return { decision: 'allow', reason: `Matched trust rule: ${matchedRule.pattern}`, matchedRule };
    }
    // High risk with allow rule → fall through to prompt
  }

  // No matching rule (or High risk with allow rule) → risk-based fallback
  if (risk === RiskLevel.High) {
    return { decision: 'prompt', reason: `High risk: always requires approval` };
  }

  if (risk === RiskLevel.Low) {
    return { decision: 'allow', reason: 'Low risk: auto-allowed' };
  }

  return { decision: 'prompt', reason: `${risk} risk: requires approval` };
}

export function generateAllowlistOptions(toolName: string, input: Record<string, unknown>): AllowlistOption[] {
  if (toolName === 'bash') {
    const command = ((input.command as string) ?? '').trim();
    const parts = command.split(/\s+/);
    const options: AllowlistOption[] = [];

    // Exact match
    options.push({ label: command, pattern: command });

    if (parts.length >= 2) {
      // Subcommand wildcard: "npm install *"
      options.push({
        label: `${parts.slice(0, -1).join(' ')} *`,
        pattern: `${parts.slice(0, -1).join(' ')} *`,
      });
    }

    if (parts.length >= 1) {
      // Program wildcard: "npm *"
      options.push({ label: `${parts[0]} *`, pattern: `${parts[0]} *` });
    }

    // Deduplicate
    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.pattern)) return false;
      seen.add(o.pattern);
      return true;
    });
  }

  if (toolName === 'file_write' || toolName === 'file_read' || toolName === 'file_edit') {
    const filePath = (input.path as string) ?? (input.file_path as string) ?? '';
    const options: AllowlistOption[] = [];

    // Patterns must match the "tool:path" format used by check()
    // Exact file
    options.push({ label: filePath, pattern: `${toolName}:${filePath}` });

    // Directory wildcard
    const dir = dirname(filePath);
    options.push({ label: `${dir}/*`, pattern: `${toolName}:${dir}/*` });

    // Tool wildcard
    options.push({ label: `${toolName}:*`, pattern: `${toolName}:*` });

    return options;
  }

  if (toolName === 'web_fetch' || toolName === 'browser_navigate') {
    const rawUrl = getStringField(input, 'url').trim();
    const normalized = normalizeWebFetchUrl(rawUrl);
    const exact = normalized?.href ?? rawUrl;

    const options: AllowlistOption[] = [];
    if (exact) {
      options.push({ label: exact, pattern: `${toolName}:${escapeMinimatchLiteral(exact)}` });
    }
    if (normalized) {
      options.push({
        label: `${normalized.origin}/*`,
        pattern: `${toolName}:${escapeMinimatchLiteral(normalized.origin)}/*`,
      });
    }
    options.push({ label: `${toolName}:*`, pattern: `${toolName}:*` });

    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.pattern)) return false;
      seen.add(o.pattern);
      return true;
    });
  }

  return [{ label: '*', pattern: '*' }];
}

export function generateScopeOptions(workingDir: string): ScopeOption[] {
  const home = homedir();
  const options: ScopeOption[] = [];

  // Project directory
  const displayDir = workingDir.startsWith(home)
    ? '~' + workingDir.slice(home.length)
    : workingDir;
  options.push({ label: displayDir, scope: workingDir });

  // Parent directory
  const parentDir = dirname(workingDir);
  if (parentDir !== workingDir) {
    const displayParent = parentDir.startsWith(home)
      ? '~' + parentDir.slice(home.length)
      : parentDir;
    options.push({ label: `${displayParent}/*`, scope: parentDir });
  }

  // Everywhere
  options.push({ label: 'everywhere', scope: 'everywhere' });

  return options;
}
