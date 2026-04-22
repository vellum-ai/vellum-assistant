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
 * Simple actions (optional setup prefix + one action) and pipelines get
 * action keys. Both are marked non-simple when they involve pipes, but
 * pipelines extract keys from the first segment before the first pipe.
 * Complex chains (semicolons, ||, &, newlines) get no action keys.
 */
export function deriveShellActionKeys(
  analysis: ShellIdentityAnalysis,
): ActionKeyResult {
  const { segments } = analysis;

  if (segments.length === 0) {
    return { keys: [], isSimpleAction: false };
  }

  // For multi-segment commands, check operators to determine the command shape.
  // Pipes (|) get special handling — we can extract action keys from the first
  // segment before the pipe. Other complex operators (||, ;, &, empty/missing)
  // are truly opaque and get no action keys.
  if (segments.length > 1) {
    let hasPipe = false;

    for (const seg of segments) {
      const op = seg.operator;
      // Non-empty operator that isn't && or | → definitely complex, no keys
      if (op && op !== "&&" && op !== "|") {
        return { keys: [], isSimpleAction: false };
      }
      if (op === "|") {
        hasPipe = true;
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

    // For pipelines, extract action keys from the first non-setup-prefix segment
    // before the first pipe. This enables broader "Any pdftotext command" rules
    // that match pipelines like "pdftotext file | head -100".
    if (hasPipe) {
      const firstPipeIndex = segments.findIndex((s) => s.operator === "|");
      if (firstPipeIndex > 0) {
        const preSegments = segments.slice(0, firstPipeIndex);
        const actionSegs = preSegments.filter(
          (s) => !SETUP_PREFIX_PROGRAMS.has(s.program),
        );
        if (actionSegs.length === 1) {
          const seg = actionSegs[0];
          const tokens: string[] = [seg.program];
          for (const arg of seg.args) {
            if (tokens.length >= MAX_ACTION_KEY_DEPTH) break;
            if (arg.startsWith("-")) continue;
            if (arg.includes("/") || arg.startsWith(".")) continue;
            if (/^\d+$/.test(arg)) continue;
            if (arg.includes("$") || arg.includes('"') || arg.includes("'"))
              continue;
            tokens.push(arg);
          }
          const keys: ShellActionKey[] = [];
          for (let depth = tokens.length; depth >= 1; depth--) {
            keys.push({
              key: `action:${tokens.slice(0, depth).join(" ")}`,
              depth,
            });
          }
          return { keys, isSimpleAction: false, primarySegment: seg };
        }
      }
      // Pipeline but couldn't extract a single primary action — no keys
      return { keys: [], isSimpleAction: false };
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
 * Build allowlist options for shell commands using parser-derived identity.
 *
 * For simple actions (optional setup prefix + one action), options are:
 *   1. Exact canonical primary command
 *   2. Deepest action key (e.g. "action:gh pr view")
 *   3. Broader action keys (e.g. "action:gh pr", "action:gh")
 *
 * For pipelines, the exact command plus action-key-based broader options
 * are offered. For other complex commands (multi-action chains, semicolons,
 * etc.), only the exact command is offered.
 */
export async function buildShellAllowlistOptions(
  command: string,
): Promise<AllowlistOption[]> {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const analysis = await analyzeShellCommand(trimmed);
  const actionResult = deriveShellActionKeys(analysis);

  if (!actionResult.isSimpleAction || !actionResult.primarySegment) {
    const options: AllowlistOption[] = [
      {
        label: trimmed,
        description: "This exact compound command",
        pattern: trimmed,
      },
    ];
    // If pipeline action keys were extracted, offer them as broader options
    for (const actionKey of actionResult.keys) {
      const keyTokens = actionKey.key.replace(/^action:/, "");
      options.push({
        label: `${keyTokens} *`,
        description: `Any "${keyTokens}" command`,
        pattern: actionKey.key,
      });
    }
    return options;
  }

  const options: AllowlistOption[] = [];

  // Full original command text
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

