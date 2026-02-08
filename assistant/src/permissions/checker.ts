import { RiskLevel, type PermissionCheckResult, type AllowlistOption, type ScopeOption } from './types.js';
import { findMatchingRule } from './trust-store.js';
import { parse } from '../tools/terminal/parser.js';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

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

export async function classifyRisk(toolName: string, input: Record<string, unknown>): Promise<RiskLevel> {
  if (toolName === 'file_read') return RiskLevel.Low;
  if (toolName === 'file_write') return RiskLevel.Medium;
  if (toolName === 'file_edit') return RiskLevel.Medium;

  if (toolName === 'shell') {
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

  // Unknown tool → Medium
  return RiskLevel.Medium;
}

export async function check(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
): Promise<PermissionCheckResult> {
  const risk = await classifyRisk(toolName, input);

  // High risk → always prompt, trust rules ignored
  if (risk === RiskLevel.High) {
    return { decision: 'prompt', reason: `High risk: always requires approval` };
  }

  // Low risk → auto-allow
  if (risk === RiskLevel.Low) {
    return { decision: 'allow', reason: 'Low risk: auto-allowed' };
  }

  // Medium risk → check trust rules
  const commandStr = toolName === 'shell'
    ? (input.command as string) ?? ''
    : `${toolName}:${(input.path as string) ?? (input.file_path as string) ?? ''}`;

  const matchedRule = findMatchingRule(toolName, commandStr, workingDir);
  if (matchedRule) {
    return { decision: 'allow', reason: `Matched trust rule: ${matchedRule.pattern}`, matchedRule };
  }

  return { decision: 'prompt', reason: `${risk} risk: requires approval` };
}

export function generateAllowlistOptions(toolName: string, input: Record<string, unknown>): AllowlistOption[] {
  if (toolName === 'shell') {
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
