/**
 * `assistant trust` CLI namespace.
 *
 * Subcommand: list — thin wrapper over the daemon's trust rule
 * IPC route (`trust_rules_list`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// -- Types --------------------------------------------------------------------

interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  risk: string;
  origin: string;
  userModified: boolean;
  updatedAt: string;
}

// -- Registration -------------------------------------------------------------

export function registerTrustCommand(program: Command): void {
  const trust = program
    .command("trust")
    .description("View tool trust rules (allow-list patterns for tool use)");

  trust.addHelpText(
    "after",
    `
Trust rules define which tool invocations the assistant is allowed to
execute without prompting. Each rule matches a specific tool and a
pattern (regular expression) against the tool input.

Examples:
  $ assistant trust list                List user-modified trust rules
  $ assistant trust list --all          Include unmodified defaults`,
  );

  // ── list ──────────────────────────────────────────────────────────────────

  trust
    .command("list")
    .description("List trust rules")
    .option("--all", "Include unmodified default rules")
    .option("--tool <name>", "Filter by tool name")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Patterns are regular expressions (regex), not globs.

Options:
  --all           Include unmodified default rules in the output.
  --tool <name>   Filter results to rules for the named tool.
  --json          Output as compact JSON instead of a table.

Examples:
  $ assistant trust list
  $ assistant trust list --all
  $ assistant trust list --tool bash
  $ assistant trust list --json`,
    )
    .action(async (opts: { all?: boolean; tool?: string; json?: boolean }) => {
      const params: Record<string, unknown> = {
        ...(opts.all ? { include_all: true } : {}),
        ...(opts.tool ? { tool: opts.tool } : {}),
      };

      const result = await cliIpcCall<{ rules: TrustRule[] }>(
        "trust_rules_list",
        { body: params },
      );

      if (!result.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: result.error }) + "\n",
          );
        } else {
          log.error(result.error ?? "Failed to list trust rules");
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, data: result.result }) + "\n",
        );
        return;
      }

      const { rules } = result.result!;

      if (rules.length === 0) {
        log.info("No trust rules found.");
        return;
      }

      // Table output
      const showOrigin = !!opts.all;
      const header = [
        "ID",
        "TOOL",
        "PATTERN",
        "RISK",
        ...(showOrigin ? ["ORIGIN"] : []),
        "MODIFIED",
      ];

      const rows: string[][] = rules.map((r: TrustRule) => [
        r.id.slice(0, 16),
        r.tool,
        r.pattern,
        r.risk,
        ...(showOrigin ? [r.origin] : []),
        r.updatedAt.slice(0, 10),
      ]);

      // Calculate column widths
      const colWidths = header.map((h: string, i: number) =>
        Math.max(h.length, ...rows.map((row: string[]) => row[i].length)),
      );

      const pad = (s: string, w: number) => s.padEnd(w);
      const line = header
        .map((h: string, i: number) => pad(h, colWidths[i]))
        .join("  ");
      log.info(line);
      log.info(colWidths.map((w: number) => "─".repeat(w)).join("  "));
      for (const row of rows) {
        log.info(
          row.map((c: string, i: number) => pad(c, colWidths[i])).join("  "),
        );
      }
    });
}
