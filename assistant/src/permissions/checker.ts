import { RiskLevel, type PermissionCheckResult, type AllowlistOption, type ScopeOption, type PolicyContext } from './types.js';
import { findHighestPriorityRule } from './trust-store.js';
import { parse } from '../tools/terminal/parser.js';
import { resolveSkillSelector } from '../config/skills.js';
import { computeSkillVersionHash } from '../skills/version-hash.js';
import { getTool } from '../tools/registry.js';
import { getConfig } from '../config/loader.js';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { looksLikeHostPortShorthand, looksLikePathOnlyInput } from '../tools/network/url-safety.js';
import { normalizeFilePath, isSkillSourcePath } from '../skills/path-classifier.js';

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

/**
 * Resolve a skill selector to its id and version hash. The version hash
 * is always computed from disk so that untrusted input cannot spoof a
 * pre-approved hash. If disk computation fails, only the bare id is returned.
 */
function resolveSkillIdAndHash(selector: string): { id: string; versionHash?: string } | null {
  const resolved = resolveSkillSelector(selector);
  if (!resolved.skill) return null;

  try {
    const hash = computeSkillVersionHash(resolved.skill.directoryPath);
    return { id: resolved.skill.id, versionHash: hash };
  } catch {
    return { id: resolved.skill.id };
  }
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

function buildCommandCandidates(toolName: string, input: Record<string, unknown>, workingDir: string): string[] {
  if (toolName === 'bash' || toolName === 'host_bash') {
    return [getStringField(input, 'command')];
  }

  if (toolName === 'skill_load') {
    const rawSelector = getStringField(input, 'skill').trim();
    const targets: string[] = [];
    if (!rawSelector) {
      targets.push('');
    } else {
      const resolved = resolveSkillIdAndHash(rawSelector);
      if (resolved) {
        // Version-specific candidate lets rules pin to an exact skill version
        if (resolved.versionHash) {
          targets.push(`${resolved.id}@${resolved.versionHash}`);
        }
        // Bare skill id candidate for backward compat / any-version rules
        targets.push(resolved.id);
      }
      targets.push(rawSelector);
    }
    return [...new Set(targets)].map((target) => `${toolName}:${target}`);
  }

  if (toolName === 'scaffold_managed_skill' || toolName === 'delete_managed_skill') {
    const skillId = getStringField(input, 'skill_id').trim();
    return [`${toolName}:${skillId}`];
  }

  if (toolName === 'web_fetch' || toolName === 'browser_navigate' || toolName === 'network_request') {
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
  if (toolName === 'host_file_read' || toolName === 'host_file_write' || toolName === 'host_file_edit') {
    const resolved = fileTarget ? resolve(fileTarget) : fileTarget;
    const normalized = resolved && process.platform === 'win32' ? resolved.replaceAll('\\', '/') : resolved;
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
  const resolved = rawResolved && process.platform === 'win32' ? rawResolved.replaceAll('\\', '/') : rawResolved;
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

export async function classifyRisk(toolName: string, input: Record<string, unknown>, workingDir?: string): Promise<RiskLevel> {
  if (toolName === 'file_read') return RiskLevel.Low;
  if (toolName === 'file_write' || toolName === 'file_edit') {
    const filePath = getStringField(input, 'path', 'file_path');
    if (filePath && isSkillSourcePath(resolve(workingDir ?? process.cwd(), filePath), getConfig().skills.load.extraDirs)) {
      return RiskLevel.High;
    }
    return RiskLevel.Medium;
  }
  if (toolName === 'web_search') return RiskLevel.Low;
  if (toolName === 'web_fetch') {
    // Private-network fetches are High risk so that blanket allow rules
    // (including the starter bundle) cannot silently bypass the prompt.
    return input.allow_private_network === true ? RiskLevel.High : RiskLevel.Low;
  }
  if (toolName === 'browser_navigate') {
    return input.allow_private_network === true ? RiskLevel.High : RiskLevel.Low;
  }
  // All other browser tools are low risk — the browser is sandboxed and user-visible.
  if (toolName.startsWith('browser_')) return RiskLevel.Low;
  // Proxy-authenticated network requests are Medium risk — they carry injected
  // credentials and the user should approve the target host/origin.
  if (toolName === 'network_request') return RiskLevel.Medium;
  if (toolName === 'skill_load') return RiskLevel.Low;

  // Escalate host file mutations targeting skill source paths to High risk.
  // The host variants fall through to the tool registry (Medium) by default,
  // but writing to skill source code is a privilege-escalation vector.
  if (toolName === 'host_file_write' || toolName === 'host_file_edit') {
    const filePath = getStringField(input, 'path', 'file_path');
    if (filePath && isSkillSourcePath(resolve(filePath), getConfig().skills.load.extraDirs)) {
      return RiskLevel.High;
    }
    // Fall through to the tool registry default (Medium) below.
  }

  if (toolName === 'bash' || toolName === 'host_bash') {
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
  policyContext?: PolicyContext,
): Promise<PermissionCheckResult> {
  const risk = await classifyRisk(toolName, input, workingDir);
  const permissionsMode = getConfig().permissions.mode;
  const hostPermissionTarget = isHostPermissionTarget(toolName, policyContext);

  // Build command string candidates for rule matching
  const commandCandidates = buildCommandCandidates(toolName, input, workingDir);

  // Find the highest-priority matching rule across all candidates
  const matchedRule = findHighestPriorityRule(toolName, commandCandidates, workingDir, policyContext);

  // Deny rules apply at ALL risk levels — including proxied network mode.
  // Evaluate them first so hard blocks are never downgraded to a prompt.
  if (matchedRule && matchedRule.decision === 'deny') {
    return { decision: 'deny', reason: `Blocked by deny rule: ${matchedRule.pattern}`, matchedRule };
  }

  // Workspace full-access mode auto-allows all non-host tools. This keeps
  // sandbox/workspace work frictionless while preserving host-level prompts.
  if (permissionsMode === 'workspace_full_access' && !hostPermissionTarget) {
    return {
      decision: 'allow',
      reason: 'Workspace full-access mode: non-host tool auto-allowed',
      matchedRule: matchedRule ?? undefined,
    };
  }

  // Proxied network mode requires explicit user approval for every
  // invocation because the command routes through an authenticated
  // proxy with injected credentials. This runs after deny rules but
  // before allow/ask rules so that trust rules cannot auto-approve
  // proxied commands.
  if (toolName === 'bash' && input.network_mode === 'proxied') {
    return { decision: 'prompt', reason: 'Proxied network mode requires explicit approval for each invocation.' };
  }

  if (matchedRule) {
    if (matchedRule.decision === 'ask') {
      // Ask rules always prompt — never auto-allow or auto-deny
      return { decision: 'prompt', reason: `Matched ask rule: ${matchedRule.pattern}`, matchedRule };
    }

    // Allow rule: auto-allow for non-High risk
    if (risk !== RiskLevel.High) {
      return { decision: 'allow', reason: `Matched trust rule: ${matchedRule.pattern}`, matchedRule };
    }
    // High risk with allow rule that explicitly permits high-risk → auto-allow
    if (matchedRule.allowHighRisk === true) {
      return { decision: 'allow', reason: `Matched high-risk trust rule: ${matchedRule.pattern}`, matchedRule };
    }
    // High risk with allow rule (without allowHighRisk) → fall through to prompt
  }

  // No matching rule (or High risk with allow rule) → risk-based fallback

  // Third-party skill-origin tools default to prompting when no trust rule
  // matches, regardless of risk level. Bundled skill tools are first-party
  // and trusted, so they fall through to the normal risk-based policy.
  if (!matchedRule) {
    const tool = getTool(toolName);
    if (tool?.origin === 'skill' && !tool.ownerSkillBundled) {
      return { decision: 'prompt', reason: 'Skill tool: requires approval by default' };
    }
  }

  // In workspace full-access mode, host-targeted tools require an explicit
  // allow rule before they can auto-run.
  if (permissionsMode === 'workspace_full_access' && hostPermissionTarget && !matchedRule) {
    return { decision: 'prompt', reason: 'Host tool: requires approval in workspace full-access mode' };
  }

  // In strict mode, every tool without an explicit matching rule must be
  // prompted — there is no implicit auto-allow for any risk level.
  // This explicitly covers skill_load: activating a skill can grant the
  // agent new capabilities, so in strict mode users must approve each
  // skill load via an exact-version or wildcard trust rule.
  if (permissionsMode === 'strict' && !matchedRule) {
    return { decision: 'prompt', reason: `Strict mode: no matching rule, requires approval` };
  }

  // Auto-allow low-risk bundled skill tools even without explicit trust rules.
  // These are first-party tools with a vetted risk declaration — applying the
  // same policy as the per-tool default allow rules for browser tools, but
  // generically so every new bundled skill benefits automatically.
  // This block must come AFTER the strict mode check so that strict mode
  // still prompts for bundled skill tools without explicit rules.
  if (!matchedRule && risk === RiskLevel.Low) {
    const tool = getTool(toolName);
    if (tool?.origin === 'skill' && tool.ownerSkillBundled) {
      return { decision: 'allow', reason: 'Bundled skill tool: low risk, auto-allowed' };
    }
  }

  if (risk === RiskLevel.High) {
    return { decision: 'prompt', reason: `High risk: always requires approval` };
  }

  if (risk === RiskLevel.Low) {
    return { decision: 'allow', reason: 'Low risk: auto-allowed' };
  }

  return { decision: 'prompt', reason: `${risk} risk: requires approval` };
}

function isHostPermissionTarget(
  toolName: string,
  policyContext?: PolicyContext,
): boolean {
  if (policyContext?.executionTarget === 'host') {
    return true;
  }
  if (toolName.startsWith('host_') || toolName.startsWith('computer_use_')) {
    return true;
  }
  const tool = getTool(toolName);
  return tool?.executionTarget === 'host';
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  file_read: 'file reads',
  file_write: 'file writes',
  file_edit: 'file edits',
  host_file_read: 'host file reads',
  host_file_write: 'host file writes',
  host_file_edit: 'host file edits',
  web_fetch: 'URL fetches',
  browser_navigate: 'browser navigations',
  network_request: 'network requests',
};

function friendlyBasename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function friendlyHostname(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

export function generateAllowlistOptions(toolName: string, input: Record<string, unknown>): AllowlistOption[] {
  if (toolName === 'bash' || toolName === 'host_bash') {
    const command = ((input.command as string) ?? '').trim();
    const parts = command.split(/\s+/);
    const program = parts[0] ?? command;
    const options: AllowlistOption[] = [];

    // Exact match
    options.push({ label: command, description: 'This exact command', pattern: command });

    if (parts.length >= 2) {
      // Subcommand wildcard: "npm install *"
      const sub = parts.slice(0, -1).join(' ');
      options.push({
        label: `${sub} *`,
        description: `Any "${sub}" command`,
        pattern: `${sub} *`,
      });
    }

    if (parts.length >= 1) {
      // Program wildcard: "npm *"
      options.push({ label: `${program} *`, description: `Any ${program} command`, pattern: `${program} *` });
    }

    // Deduplicate
    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.pattern)) return false;
      seen.add(o.pattern);
      return true;
    });
  }

  if (
    toolName === 'file_write' || toolName === 'file_read' || toolName === 'file_edit'
    || toolName === 'host_file_write' || toolName === 'host_file_read' || toolName === 'host_file_edit'
  ) {
    const filePath = (input.path as string) ?? (input.file_path as string) ?? '';
    const toolLabel = TOOL_DISPLAY_NAMES[toolName] ?? toolName;
    const options: AllowlistOption[] = [];

    // Patterns must match the "tool:path" format used by check()
    // Exact file
    options.push({ label: filePath, description: `This file only`, pattern: `${toolName}:${filePath}` });

    // Ancestor directory wildcards — walk up from immediate parent, stop at home dir or /
    const home = homedir();
    let dir = dirname(filePath);
    const maxLevels = 3;
    let levels = 0;
    while (dir && dir !== '/' && dir !== '.' && levels < maxLevels) {
      const dirName = friendlyBasename(dir);
      options.push({ label: `${dir}/**`, description: `Anything in ${dirName}/`, pattern: `${toolName}:${dir}/**` });
      if (dir === home) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      levels++;
    }

    // Tool wildcard
    options.push({ label: `${toolName}:*`, description: `All ${toolLabel}`, pattern: `${toolName}:*` });

    return options;
  }

  if (toolName === 'web_fetch' || toolName === 'browser_navigate' || toolName === 'network_request') {
    const rawUrl = getStringField(input, 'url').trim();
    const normalized = normalizeWebFetchUrl(rawUrl);
    const exact = normalized?.href ?? rawUrl;

    const options: AllowlistOption[] = [];
    if (exact) {
      options.push({ label: exact, description: 'This exact URL', pattern: `${toolName}:${escapeMinimatchLiteral(exact)}` });
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
    options.push({ label: `${toolName}:*`, description: `All ${toolLabel}`, pattern: `**` });

    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.pattern)) return false;
      seen.add(o.pattern);
      return true;
    });
  }

  if (toolName === 'scaffold_managed_skill' || toolName === 'delete_managed_skill') {
    const skillId = getStringField(input, 'skill_id').trim();
    const toolLabel = toolName === 'scaffold_managed_skill' ? 'scaffold' : 'delete';
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

  if (toolName === 'skill_load') {
    const rawSelector = getStringField(input, 'skill').trim();

    if (rawSelector) {
      const resolved = resolveSkillIdAndHash(rawSelector);
      if (resolved && resolved.versionHash) {
        // Always pin approval to the exact version
        return [
          {
            label: `${resolved.id}@${resolved.versionHash}`,
            description: 'This exact version',
            pattern: `skill_load:${resolved.id}@${resolved.versionHash}`,
          },
        ];
      }
      // No version hash — use the resolved id or raw selector
      const id = resolved ? resolved.id : rawSelector;
      return [
        {
          label: id,
          description: 'This skill',
          pattern: `skill_load:${id}`,
        },
      ];
    }

    // No selector at all — fallback to wildcard
    return [
      {
        label: 'skill_load:*',
        description: 'All skill loads',
        pattern: 'skill_load:*',
      },
    ];
  }

  return [{ label: '*', description: 'Everything', pattern: '*' }];
}

export function generateScopeOptions(workingDir: string, toolName?: string): ScopeOption[] {
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

  if (!toolName?.startsWith('host_')) {
    return options;
  }

  const everywhere = options.find((option) => option.scope === 'everywhere');
  const scoped = options.filter((option) => option.scope !== 'everywhere');
  return everywhere ? [everywhere, ...scoped] : options;
}
