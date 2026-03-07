import type { Command } from "commander";

import { getRecentInvocations } from "../../memory/tool-usage-store.js";
import { getCliLogger } from "../../util/logger.js";

const log = getCliLogger("cli");

export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description("Show recent tool invocations")
    .option("-l, --limit <n>", "Number of entries to show", "20")
    .addHelpText(
      "after",
      `
Reads from the local tool invocation log stored by the assistant. Each row
represents one tool call the assistant made, including what was invoked,
how the approval system classified it, and how long it took.

Table columns:
  Timestamp   When the tool was invoked (UTC, YYYY-MM-DD HH:MM:SS)
  Tool        Tool name (e.g. bash, read_file, write_file, browser)
  Input       Truncated summary of the tool input (command, path, etc.)
  Decision    Approval decision: allow, deny, or ask
  Risk        Risk classification: none, low, medium, high
  Duration    Wall-clock execution time (e.g. 120ms, 1.3s)

Examples:
  $ assistant audit
  $ assistant audit --limit 50`,
    )
    .action((opts: { limit: string }) => {
      const limit = parseInt(opts.limit, 10) || 20;
      const rows = getRecentInvocations(limit);
      if (rows.length === 0) {
        log.info("No tool invocations recorded");
        return;
      }
      const tsW = 20;
      const toolW = 14;
      const inputW = 30;
      const decW = 8;
      const riskW = 8;
      const durW = 8;
      log.info(
        "Timestamp".padEnd(tsW) +
          "Tool".padEnd(toolW) +
          "Input".padEnd(inputW) +
          "Decision".padEnd(decW) +
          "Risk".padEnd(riskW) +
          "Duration",
      );
      log.info("-".repeat(tsW + toolW + inputW + decW + riskW + durW));
      for (const r of rows) {
        const ts = new Date(r.createdAt)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        let inputSummary = "";
        try {
          const parsed = JSON.parse(r.input);
          if (parsed.command) inputSummary = parsed.command;
          else if (parsed.path) inputSummary = parsed.path;
          else inputSummary = r.input;
        } catch {
          inputSummary = r.input;
        }
        if (inputSummary.length > inputW - 2) {
          inputSummary = inputSummary.slice(0, inputW - 4) + "..";
        }
        const dur =
          r.durationMs < 1000
            ? `${r.durationMs}ms`
            : `${(r.durationMs / 1000).toFixed(1)}s`;
        log.info(
          ts.padEnd(tsW) +
            r.toolName.padEnd(toolW) +
            inputSummary.padEnd(inputW) +
            r.decision.padEnd(decW) +
            r.riskLevel.padEnd(riskW) +
            dur,
        );
      }
    });
}
