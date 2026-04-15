import type { CommandCategory } from "./types.js";

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Strip common command prefixes that don't affect classification:
 * - `cd <path> &&` chains
 * - environment variable assignments (`FOO=bar`)
 * - `sudo`
 */
function stripPrefixes(cmd: string): string {
  let result = cmd.trim();

  // Strip leading `cd <path> &&` (possibly repeated)
  while (/^cd\s+\S+\s*&&\s*/.test(result)) {
    result = result.replace(/^cd\s+\S+\s*&&\s*/, "");
  }

  // Strip leading env var assignments (KEY=value, KEY="value", KEY='value')
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(result)) {
    result = result.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  }

  // Strip leading `sudo`
  result = result.replace(/^sudo\s+/, "");

  return result.trim();
}

interface DetectResult {
  category: CommandCategory;
  commandName: string;
}

const CATEGORIES: Array<{ category: CommandCategory; pattern: RegExp }> = [
  // Test runners — highest priority
  {
    category: "test-runner",
    pattern:
      /\b(cargo\s+test|pytest|python\s+-m\s+pytest|jest|vitest|npx\s+(jest|vitest)|go\s+test|bun\s+test|rspec|playwright)\b/,
  },
  // git diff / git show
  {
    category: "git-diff",
    pattern: /\bgit\s+(diff|show)\b/,
  },
  // git status
  {
    category: "git-status",
    pattern: /\bgit\s+status\b/,
  },
  // Directory listing
  {
    category: "directory-listing",
    pattern: /\b(ls|find|tree)\b/,
  },
  // Search tools
  {
    category: "search-results",
    pattern: /\b(grep|rg|ripgrep|ag)\b/,
  },
  // Build / lint tools
  {
    category: "build-lint",
    pattern:
      /\b(tsc|eslint|cargo\s+(build|check|clippy)|npm\s+run\s+(build|lint)|ruff)\b/,
  },
];

/**
 * Detect the primary command category from a shell command string.
 *
 * Handles ANSI codes, `cd && ...` chains, env-var prefixes, `sudo`,
 * and pipes. Only the head segment of a pipeline (before the first `|`)
 * is classified, since that command produces the output we compress.
 */
export function detectCommand(command: string): DetectResult {
  if (!command || !command.trim()) {
    return { category: "unknown", commandName: "" };
  }

  const cleaned = stripAnsi(command);
  // Extract the head segment of a pipeline — only the first command before
  // any `|` produces the output we'll compress.
  const pipeIndex = cleaned.indexOf("|");
  const headSegment = pipeIndex >= 0 ? cleaned.slice(0, pipeIndex) : cleaned;
  const stripped = stripPrefixes(headSegment);

  for (const { category, pattern } of CATEGORIES) {
    const match = stripped.match(pattern);
    if (match) {
      return { category, commandName: match[0].trim() };
    }
  }

  return { category: "unknown", commandName: "" };
}
