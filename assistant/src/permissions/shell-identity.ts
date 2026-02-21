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
