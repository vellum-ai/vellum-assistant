import type { Command } from "commander";

import { startCli } from "../../cli.js";
import { shouldAutoStartDaemon } from "../../daemon/connection-policy.js";
import { ensureDaemonRunning } from "../../daemon/lifecycle.js";

export function registerDefaultAction(program: Command): void {
  program.action(async (_options: unknown, cmd: Command) => {
    // Commander routes unknown subcommands to the root action as positional
    // args instead of raising an error. Detect this case and fail with a
    // helpful message so users don't silently get the interactive CLI when
    // they mistype a command name.
    if (cmd.args.length > 0) {
      const unknown = cmd.args[0];
      const available = cmd.commands.map((c) => c.name());
      const suggestion = findClosestCommand(unknown, available);
      const lines = [`unknown command '${unknown}'`];
      if (suggestion) {
        lines.push(`(Did you mean '${suggestion}'?)`);
      }
      lines.push(`Run 'assistant --help' to see a list of available commands.`);
      cmd.error(lines.join("\n"), {
        code: "commander.unknownCommand",
        exitCode: 1,
      });
      return;
    }

    if (shouldAutoStartDaemon()) {
      await ensureDaemonRunning();
    }
    await startCli();
  });
}

/**
 * Find the closest matching command name using Levenshtein distance.
 * Returns the best match if the distance is ≤ 40% of the longer string's
 * length, otherwise returns undefined.
 */
function findClosestCommand(
  input: string,
  candidates: string[],
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;

  for (const name of candidates) {
    const dist = levenshtein(input.toLowerCase(), name.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }

  // Only suggest if the edit distance is at most 40% of the longer string
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
