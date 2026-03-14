import {
  type CommandSegment,
  type DangerousPattern,
  parse,
  type ParsedCommand,
} from "../tools/terminal/parser.js";
import type { AllowlistOption } from "./types.js";

export type { ParsedCommand };

// ── Shell parse result cache ─────────────────────────────────────────────────
// Shell parsing via web-tree-sitter WASM is deterministic — the same command
// string always produces the same ParsedCommand. Cache results to avoid
// redundant WASM invocations on repeated permission checks.
const PARSE_CACHE_MAX = 256;
const parseCache = new Map<string, ParsedCommand>();

export async function cachedParse(command: string): Promise<ParsedCommand> {
  const cached = parseCache.get(command);
  if (cached !== undefined) {
    // LRU refresh: move to end of insertion order
    parseCache.delete(command);
    parseCache.set(command, cached);
    return cached;
  }
  const result = await parse(command);
  // Evict oldest entry if at capacity
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(command, result);
  return result;
}

export interface ShellActionKey {
  /** e.g. "action:gh", "action:gh pr", "action:gh pr view" */
  key: string;
  /** How many tokens deep this key goes */
  depth: number;
}

export interface ShellIdentityAnalysis {
  /** The parsed segments from the shell parser */
  segments: CommandSegment[];
  /** The operator sequence between segments (e.g. ['&&', '|']) */
  operators: string[];
  /** Whether the command contains opaque constructs (eval, heredocs, etc.) */
  hasOpaqueConstructs: boolean;
  /** Dangerous patterns detected by the parser */
  dangerousPatterns: DangerousPattern[];
}

export interface ActionKeyResult {
  /** The derived action keys from narrowest to broadest */
  keys: ShellActionKey[];
  /** Whether this command has a "simple action" shape (setup prefix + single action) */
  isSimpleAction: boolean;
  /** The primary action segment (the non-setup-prefix action command) */
  primarySegment?: CommandSegment;
}

/** Programs that are considered setup prefixes (not the main action) */
const SETUP_PREFIX_PROGRAMS = new Set([
  "cd",
  "pushd",
  "export",
  "unset",
  "set",
]);

const MAX_ACTION_KEY_DEPTH = 3;

/**
 * Analyze a shell command using the tree-sitter parser to extract
 * identity information for permission decisions.
 */
export async function analyzeShellCommand(
  command: string,
  preParsed?: ParsedCommand,
): Promise<ShellIdentityAnalysis> {
  const parsed = preParsed ?? (await cachedParse(command));

  const operators: string[] = [];
  for (const seg of parsed.segments) {
    if (seg.operator) {
      operators.push(seg.operator);
    }
  }

  return {
    segments: parsed.segments,
    operators,
    hasOpaqueConstructs: parsed.hasOpaqueConstructs,
    dangerousPatterns: parsed.dangerousPatterns,
  };
}

/**
 * Derive canonical action keys from a shell command analysis.
 *
 * Action keys identify the "family" of a command for allowlist purposes.
 * For example, `cd repo && gh pr view 5525 --json title` derives:
 *   - action:gh pr view
 *   - action:gh pr
 *   - action:gh
 *
 * Only "simple action" commands (optional setup prefix + one action) get
 * action keys. Pipelines and complex chains are marked non-simple.
 */
export function deriveShellActionKeys(
  analysis: ShellIdentityAnalysis,
): ActionKeyResult {
  const { segments } = analysis;

  if (segments.length === 0) {
    return { keys: [], isSimpleAction: false };
  }

  // For multi-segment commands, only allow simple-action classification if
  // ALL inter-segment operators are explicitly &&. Any other operator (|, ||,
  // ;, &, empty/missing) means the separator is unknown or unsafe.
  // This safely handles cases where the parser doesn't capture certain
  // separators (;, newline, &) and leaves them as empty operators.
  if (segments.length > 1) {
    for (const seg of segments) {
      const op = seg.operator;
      // Non-empty operator that isn't && → definitely complex
      if (op && op !== "&&") {
        return { keys: [], isSimpleAction: false };
      }
    }
    // Also check: if there are multiple segments but no operators at all
    // between them (e.g. newline-separated), that's suspicious.
    // The first segment always has operator '' (no preceding operator).
    // If any non-first segment also has operator '', the separator was
    // not captured — treat as complex for safety.
    for (let i = 1; i < segments.length; i++) {
      if (!segments[i].operator) {
        return { keys: [], isSimpleAction: false };
      }
    }
  }

  // Separate setup-prefix segments from action segments
  const actionSegments: CommandSegment[] = [];
  let foundNonPrefix = false;

  for (const seg of segments) {
    if (!foundNonPrefix && SETUP_PREFIX_PROGRAMS.has(seg.program)) {
      continue;
    }
    foundNonPrefix = true;
    actionSegments.push(seg);
  }

  // Simple action: exactly one non-prefix action segment
  if (actionSegments.length !== 1) {
    return { keys: [], isSimpleAction: false };
  }

  const primarySegment = actionSegments[0];
  const tokens: string[] = [primarySegment.program];

  // Add non-flag, non-path stable subcommand tokens (up to MAX_ACTION_KEY_DEPTH)
  for (const arg of primarySegment.args) {
    if (tokens.length >= MAX_ACTION_KEY_DEPTH) break;
    if (arg.startsWith("-")) continue;
    if (arg.includes("/") || arg.startsWith(".")) continue;
    if (/^\d+$/.test(arg)) continue;
    if (arg.includes("$") || arg.includes('"') || arg.includes("'")) continue;
    tokens.push(arg);
  }

  // Build action keys from narrowest to broadest
  const keys: ShellActionKey[] = [];
  for (let depth = tokens.length; depth >= 1; depth--) {
    keys.push({
      key: `action:${tokens.slice(0, depth).join(" ")}`,
      depth,
    });
  }

  return { keys, isSimpleAction: true, primarySegment };
}

/**
 * Build an ordered list of command candidates for trust-rule matching.
 *
 * Candidate ordering:
 *   1. Raw command (most specific match — the full command as written)
 *   2. Canonical primary command (if simple action) — the full primary segment text
 *   3. Action keys from narrowest to broadest (if simple action)
 *
 * Complex commands (pipelines, multi-action chains) only return the raw candidate.
 */
export async function buildShellCommandCandidates(
  command: string,
  preParsed?: ParsedCommand,
): Promise<string[]> {
  const trimmed = command.trim();
  if (!trimmed) return [trimmed];

  const analysis = await analyzeShellCommand(trimmed, preParsed);
  const actionResult = deriveShellActionKeys(analysis);

  const candidates: string[] = [trimmed];

  if (actionResult.isSimpleAction && actionResult.primarySegment) {
    // Add canonical primary command text (the actual segment, not the full command with setup prefixes)
    const canonical = actionResult.primarySegment.command;
    if (canonical !== trimmed) {
      candidates.push(canonical);
    }

    // Add action keys
    for (const actionKey of actionResult.keys) {
      candidates.push(actionKey.key);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

/**
 * Build allowlist options for shell commands using parser-derived identity.
 *
 * For simple actions (optional setup prefix + one action), options are:
 *   1. Exact canonical primary command
 *   2. Deepest action key (e.g. "action:gh pr view")
 *   3. Broader action keys (e.g. "action:gh pr", "action:gh")
 *
 * For complex commands (pipelines, multi-action chains), only the exact
 * command is offered (no broad options).
 */
export async function buildShellAllowlistOptions(
  command: string,
): Promise<AllowlistOption[]> {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const analysis = await analyzeShellCommand(trimmed);
  const actionResult = deriveShellActionKeys(analysis);

  if (!actionResult.isSimpleAction || !actionResult.primarySegment) {
    // Complex command — exact only
    return [
      {
        label: trimmed,
        description: "This exact compound command",
        pattern: trimmed,
      },
    ];
  }

  const options: AllowlistOption[] = [];

  // Full original command text — "this exact command" means exactly what the user approved
  options.push({
    label: trimmed,
    description: "This exact command",
    pattern: trimmed,
  });

  // Action keys from narrowest to broadest
  for (const actionKey of actionResult.keys) {
    const keyTokens = actionKey.key.replace(/^action:/, "");
    options.push({
      label: `${keyTokens} *`,
      description: `Any "${keyTokens}" command`,
      pattern: actionKey.key,
    });
  }

  // Deduplicate by pattern
  const seen = new Set<string>();
  return options.filter((o) => {
    if (seen.has(o.pattern)) return false;
    seen.add(o.pattern);
    return true;
  });
}
