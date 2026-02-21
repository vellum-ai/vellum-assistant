import { parse, type ParsedCommand, type CommandSegment, type DangerousPattern } from '../tools/terminal/parser.js';

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
const SETUP_PREFIX_PROGRAMS = new Set(['cd', 'pushd', 'export', 'unset', 'set']);

const MAX_ACTION_KEY_DEPTH = 3;

/**
 * Analyze a shell command using the tree-sitter parser to extract
 * identity information for permission decisions.
 */
export async function analyzeShellCommand(command: string): Promise<ShellIdentityAnalysis> {
  const parsed = await parse(command);

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
export function deriveShellActionKeys(analysis: ShellIdentityAnalysis): ActionKeyResult {
  const { segments, operators } = analysis;

  if (segments.length === 0) {
    return { keys: [], isSimpleAction: false };
  }

  // Pipelines are never simple
  if (operators.includes('|')) {
    return { keys: [], isSimpleAction: false };
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
    if (arg.startsWith('-')) continue;
    if (arg.includes('/') || arg.startsWith('.')) continue;
    if (/^\d+$/.test(arg)) continue;
    if (arg.includes('$') || arg.includes('"') || arg.includes("'")) continue;
    tokens.push(arg);
  }

  // Build action keys from narrowest to broadest
  const keys: ShellActionKey[] = [];
  for (let depth = tokens.length; depth >= 1; depth--) {
    keys.push({
      key: `action:${tokens.slice(0, depth).join(' ')}`,
      depth,
    });
  }

  return { keys, isSimpleAction: true, primarySegment };
}
