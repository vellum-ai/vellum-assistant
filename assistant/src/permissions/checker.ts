import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
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
import { getWorkspaceHooksDir } from "../util/platform.js";
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

// Low-risk shell programs that are read-only / informational
const LOW_RISK_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "grep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "which",
  "where",
  "whereis",
  "type",
  "echo",
  "printf",
  "date",
  "cal",
  "uptime",
  "whoami",
  "hostname",
  "uname",
  "pwd",
  "realpath",
  "dirname",
  "basename",
  "git",
  "node",
  "bun",
  "deno",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "python",
  "python3",
  "pip",
  "pip3",
  "man",
  "help",
  "info",
  "env",
  "printenv",
  "set",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "xargs",
  "jq",
  "yq",
  "http",
  "dig",
  "nslookup",
  "ping",
  "tree",
  "du",
  "df",
]);

// High-risk shell programs / patterns
const HIGH_RISK_PROGRAMS = new Set([
  "sudo",
  "su",
  "doas",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "mount",
  "umount",
  "systemctl",
  "service",
  "launchctl",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "iptables",
  "ufw",
  "firewall-cmd",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "kill",
  "killall",
  "pkill",
]);

// Git subcommands that are low-risk (read-only)
const LOW_RISK_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "remote",
  "stash",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "reflog",
]);

/**
 * Classify risk for `assistant` CLI subcommands. Multi-word subcommands
 * (e.g. `assistant oauth token`) are matched by walking the positional args.
 */
function classifyAssistantSubcommand(args: string[]): RiskLevel {
  const sub = firstPositionalArg(args);
  if (!sub) return RiskLevel.Low;

  if (sub === "oauth") {
    const oauthSub = firstPositionalArg(args.slice(args.indexOf(sub) + 1));
    if (oauthSub === "token") return RiskLevel.High;
    if (oauthSub === "mode") {
      // `oauth mode --set` is high risk; bare `oauth mode` (read) is low.
      // Match both `--set value` (two tokens) and `--set=value` (one token).
      if (args.some((a) => a === "--set" || a.startsWith("--set=")))
        return RiskLevel.High;
      return RiskLevel.Low;
    }
    if (oauthSub === "request") return RiskLevel.Medium;
    if (oauthSub === "connect" || oauthSub === "disconnect")
      return RiskLevel.Medium;
    return RiskLevel.Low;
  }

  if (sub === "credentials") {
    const credSub = firstPositionalArg(args.slice(args.indexOf(sub) + 1));
    if (credSub === "reveal") return RiskLevel.High;
    if (credSub === "set" || credSub === "delete") return RiskLevel.High;
    return RiskLevel.Low;
  }

  if (sub === "keys") {
    const keysSub = firstPositionalArg(args.slice(args.indexOf(sub) + 1));
    if (keysSub === "set" || keysSub === "delete") return RiskLevel.High;
    return RiskLevel.Low;
  }

  if (sub === "trust") {
    const trustSub = firstPositionalArg(args.slice(args.indexOf(sub) + 1));
    if (trustSub === "remove" || trustSub === "clear") return RiskLevel.High;
    return RiskLevel.Low;
  }

  return RiskLevel.Low;
}

// Commands that wrap another program — the real program appears as the first
// non-flag argument.  When one of these is the segment program we look through
// its args to find the effective program (e.g. `env curl …` → curl).
const WRAPPER_PROGRAMS = new Set([
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "exec",
  "strace",
  "ltrace",
  "ionice",
  "taskset",
  "timeout",
]);

// `env` flags that consume the next positional argument as their value.
// Without this, `env -u curl echo` would incorrectly identify `curl` (the
// value of -u) as the wrapped program instead of `echo`.
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir"]);

// `timeout` flags that consume the next positional argument as their value.
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);

// Wrapper programs where the first non-flag positional argument is a
// configuration value (duration, CPU mask), not the wrapped program name.
// For these wrappers, the second non-flag positional is the real program.
const WRAPPER_SKIP_FIRST_POSITIONAL = new Set(["timeout", "taskset"]);

// `git` global flags that consume the next positional argument as their value.
// Without this, `git -C status commit` would incorrectly identify `status`
// (the directory path) as the subcommand instead of `commit`.
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/**
 * Return the first non-flag argument from an argument list, optionally
 * skipping value-taking flags.  Flags are arguments that start with `-`.
 * This is used to skip global options (e.g. `--verbose`, `-h`, `-C <path>`)
 * when extracting the subcommand from CLIs like `git`, `vellum`, and
 * `assistant`.
 *
 * When `valueFlags` is provided, any flag in that set causes the next
 * argument to be skipped as well (it is the flag's value, not a positional).
 */
function firstPositionalArg(
  args: string[],
  valueFlags?: Set<string>,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (valueFlags?.has(arg)) i++; // skip the next arg (the flag's value)
      continue;
    }
    return arg;
  }
  return undefined;
}

// Bare filenames that `rm` is allowed to delete at Medium risk (instead of
// High) so workspace-scoped allow rules can approve them without the
// dangerous `allowHighRisk` flag. Only matches when the args contain no
// flags and exactly one of these filenames.
const RM_SAFE_BARE_FILES = new Set(["BOOTSTRAP.md", "UPDATES.md"]);

function isRmOfKnownSafeFile(args: string[]): boolean {
  if (args.length !== 1) return false;
  const target = args[0];
  if (target.startsWith("-") || target.includes("/")) return false;
  return RM_SAFE_BARE_FILES.has(target);
}

/**
 * Given a segment whose program is a known wrapper, return the first
 * non-flag argument (i.e. the wrapped program name).  Returns `undefined`
 * when no suitable argument is found.
 *
 * Handles `env` specially: skips `VAR=value` pairs and value-taking flags
 * like `-u NAME` and `-C DIR`.
 *
 * Handles `timeout` and `taskset` specially: their first non-flag positional
 * argument is a duration or CPU mask, not the wrapped program. The second
 * non-flag positional is the real program.
 */
function getWrappedProgram(seg: {
  program: string;
  args: string[];
}): string | undefined {
  const isEnv = seg.program === "env";
  const isTimeout = seg.program === "timeout";
  const skipFirst = WRAPPER_SKIP_FIRST_POSITIONAL.has(seg.program);
  let skippedFirstPositional = false;
  for (let i = 0; i < seg.args.length; i++) {
    const arg = seg.args[i];
    if (arg.startsWith("-")) {
      if (isEnv && ENV_VALUE_FLAGS.has(arg)) i++; // skip the value argument
      if (isTimeout && TIMEOUT_VALUE_FLAGS.has(arg)) i++; // skip the value argument
      continue;
    }
    if (isEnv && arg.includes("=")) continue; // skip env VAR=value pairs
    if (skipFirst && !skippedFirstPositional) {
      skippedFirstPositional = true;
      continue; // skip the duration/CPU mask
    }
    return arg;
  }
  return undefined;
}

/**
 * Like `getWrappedProgram`, but also returns the remaining args after the
 * wrapped program name. This allows callers to propagate subcommand-aware
 * classification (e.g. `env assistant oauth token` → classify `oauth token`).
 */
function getWrappedProgramWithArgs(seg: {
  program: string;
  args: string[];
}): { program: string; args: string[] } | undefined {
  const isEnv = seg.program === "env";
  const isTimeout = seg.program === "timeout";
  const skipFirst = WRAPPER_SKIP_FIRST_POSITIONAL.has(seg.program);
  let skippedFirstPositional = false;
  for (let i = 0; i < seg.args.length; i++) {
    const arg = seg.args[i];
    if (arg.startsWith("-")) {
      if (isEnv && ENV_VALUE_FLAGS.has(arg)) i++;
      if (isTimeout && TIMEOUT_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    if (isEnv && arg.includes("=")) continue;
    if (skipFirst && !skippedFirstPositional) {
      skippedFirstPositional = true;
      continue; // skip the duration/CPU mask
    }
    return { program: arg, args: seg.args.slice(i + 1) };
  }
  return undefined;
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

  if (
    toolName === "web_fetch" ||
    toolName === "browser_navigate" ||
    toolName === "network_request"
  ) {
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

  const result = await classifyRiskUncached(
    toolName,
    input,
    workingDir,
    preParsed,
    manifestOverride,
  );

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
  preParsed?: ParsedCommand,
  manifestOverride?: ManifestOverride,
): Promise<RiskLevel> {
  if (toolName === "file_read") return RiskLevel.Low;
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
  if (toolName === "browser_navigate") {
    return input.allow_private_network === true
      ? RiskLevel.High
      : RiskLevel.Low;
  }
  // All other browser tools are low risk — the browser is sandboxed and user-visible.
  if (toolName.startsWith("browser_")) return RiskLevel.Low;
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

  if (toolName === "bash" || toolName === "host_bash") {
    const command = (input.command as string) ?? "";
    if (!command.trim()) return RiskLevel.Low;

    const parsed = preParsed ?? (await cachedParse(command));

    // Dangerous patterns → High
    if (parsed.dangerousPatterns.length > 0) return RiskLevel.High;

    // Opaque constructs → at least Medium (never Low)
    if (parsed.hasOpaqueConstructs) return RiskLevel.Medium;

    // Check each segment
    let maxRisk = RiskLevel.Low;

    for (const seg of parsed.segments) {
      const prog = seg.program;

      if (HIGH_RISK_PROGRAMS.has(prog)) return RiskLevel.High;

      if (prog === "rm") {
        // Only downgrade rm of known safe workspace files for sandboxed bash.
        // host_bash has a global ask rule that would prompt Medium-risk
        // commands, so rm on the host must always require explicit approval.
        if (toolName === "bash" && isRmOfKnownSafeFile(seg.args)) {
          maxRisk = RiskLevel.Medium;
          continue;
        }
        return RiskLevel.High;
      }

      if (
        prog === "chmod" ||
        prog === "chown" ||
        prog === "chgrp" ||
        prog === "sed" ||
        prog === "awk"
      ) {
        maxRisk = RiskLevel.Medium;
        continue;
      }

      // curl/wget can download and execute arbitrary code from the internet.
      // Also catch wrapped invocations like `env curl …` or `nice wget …`.
      if (prog === "curl" || prog === "wget") {
        maxRisk = RiskLevel.Medium;
        continue;
      }

      if (WRAPPER_PROGRAMS.has(prog)) {
        // `command -v` and `command -V` are read-only lookups (print where
        // a command lives) — don't escalate to high risk for those.
        if (
          prog === "command" &&
          seg.args.length > 0 &&
          (seg.args[0] === "-v" || seg.args[0] === "-V")
        ) {
          continue;
        }
        const wrapped = getWrappedProgram(seg);
        if (wrapped === "rm") return RiskLevel.High;
        if (wrapped && HIGH_RISK_PROGRAMS.has(wrapped)) return RiskLevel.High;
        if (wrapped === "curl" || wrapped === "wget") {
          maxRisk = RiskLevel.Medium;
          continue;
        }
        // Propagate subcommand-aware classification for wrapped git/assistant
        if (wrapped === "git") {
          const wrappedWithArgs = getWrappedProgramWithArgs(seg);
          if (wrappedWithArgs) {
            const subcommand = firstPositionalArg(
              wrappedWithArgs.args,
              GIT_VALUE_FLAGS,
            );
            if (subcommand && LOW_RISK_GIT_SUBCOMMANDS.has(subcommand)) {
              continue;
            }
            maxRisk = RiskLevel.Medium;
            continue;
          }
        }
        if (wrapped === "assistant") {
          const wrappedWithArgs = getWrappedProgramWithArgs(seg);
          if (wrappedWithArgs) {
            const assistantRisk = classifyAssistantSubcommand(
              wrappedWithArgs.args,
            );
            if (assistantRisk === RiskLevel.High) return RiskLevel.High;
            if (assistantRisk === RiskLevel.Medium) {
              maxRisk = RiskLevel.Medium;
            }
            continue;
          }
        }
      }

      if (prog === "git") {
        const subcommand = firstPositionalArg(seg.args, GIT_VALUE_FLAGS);
        if (subcommand && LOW_RISK_GIT_SUBCOMMANDS.has(subcommand)) {
          // Stay at current risk
          continue;
        }
        // Non-read-only git commands are medium
        maxRisk = RiskLevel.Medium;
        continue;
      }

      if (prog === "assistant") {
        const assistantRisk = classifyAssistantSubcommand(seg.args);
        if (assistantRisk === RiskLevel.High) return RiskLevel.High;
        if (assistantRisk === RiskLevel.Medium) {
          maxRisk = RiskLevel.Medium;
        }
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
    // High risk with allow rule that explicitly permits high-risk → auto-allow
    if (matchedRule.allowHighRisk === true) {
      return {
        decision: "allow",
        reason: `Matched high-risk trust rule: ${matchedRule.pattern}`,
        matchedRule,
      };
    }
    // High risk with allow rule (without allowHighRisk) → fall through to prompt
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
    // When sandbox is disabled, bash runs on the host — don't auto-allow
    const sandboxEnabled = getConfig().sandbox.enabled;
    if (toolName === "bash" && !sandboxEnabled) {
      // Fall through to risk-based policy below
    } else if (isWorkspaceScopedInvocation(toolName, input, workingDir)) {
      return {
        decision: "allow",
        reason: "Workspace mode: workspace-scoped operation auto-allowed",
      };
    }
  }

  // Auto-allow low-risk bundled skill tools even without explicit trust rules.
  // These are first-party tools with a vetted risk declaration — applying the
  // same policy as the per-tool default allow rules for browser tools, but
  // generically so every new bundled skill benefits automatically.
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
  browser_navigate: "browser navigations",
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
  browser_navigate: urlAllowlistStrategy,
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
