import type { Command } from "commander";

/**
 * Result of detecting an unknown top-level subcommand. `suggestion` is set
 * when a near-match is found (Levenshtein distance ≤ 40% of the longer name).
 */
export interface UnknownCommandHit {
  readonly token: string;
  readonly suggestion?: string;
}

/**
 * Collect every top-level subcommand name and alias registered on `program`.
 */
export function knownCommandNames(program: Command): Set<string> {
  const names = new Set<string>();
  for (const cmd of program.commands) {
    names.add(cmd.name());
    for (const alias of cmd.aliases()) {
      names.add(alias);
    }
  }
  return names;
}

/**
 * Pre-parse scan: returns the first positional argv token that doesn't match
 * any known subcommand/alias, or null when the args look valid.
 *
 * Commander processes `--help` / `--version` before any action or hook runs,
 * so `assistant invalid --help` would otherwise dump the root help instead of
 * surfacing the unknown command. Callers should run this before `parse()` so
 * the error wins over the help short-circuit.
 *
 * The first non-flag token is treated as the subcommand candidate. Flags are
 * skipped wholesale; the root program has no value-taking options today.
 */
export function detectUnknownCommand(
  program: Command,
  argv: readonly string[],
): UnknownCommandHit | null {
  const firstPositional = argv.find((token) => !token.startsWith("-"));
  if (!firstPositional) return null;

  const known = knownCommandNames(program);
  if (known.has(firstPositional)) return null;

  const suggestion = findClosestCommand(firstPositional, [...known]);
  return suggestion
    ? { token: firstPositional, suggestion }
    : { token: firstPositional };
}

/**
 * Format the unknown-command error as a multi-line message. Kept as a pure
 * function so it can be reused by `default-action`'s in-parse path (when the
 * user runs `assistant invalid` with no `--help`) and by the pre-parse path.
 */
export function formatUnknownCommandMessage(hit: UnknownCommandHit): string {
  const lines = [`unknown command '${hit.token}'`];
  if (hit.suggestion) {
    lines.push(`(Did you mean '${hit.suggestion}'?)`);
  }
  lines.push(`Run 'assistant --help' to see a list of available commands.`);
  return lines.join("\n");
}

/**
 * Find the closest matching command name using Levenshtein distance.
 * Returns the best match if the distance is ≤ 40% of the longer string's
 * length, otherwise returns undefined.
 */
export function findClosestCommand(
  input: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const lowered = input.toLowerCase();

  for (const name of candidates) {
    const dist = levenshtein(lowered, name.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }

  const maxLen = Math.max(input.length, best?.length ?? 0);
  if (best && bestDist <= Math.ceil(maxLen * 0.4)) {
    return best;
  }
  return undefined;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
