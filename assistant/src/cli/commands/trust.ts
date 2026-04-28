/**
 * `assistant trust` CLI namespace.
 *
 * Subcommands: list, add, update, remove — thin wrappers
 * over the daemon's trust rule IPC routes (`trust_rules_list`,
 * `trust_rules_create`, `trust_rules_update`, `trust_rules_remove`).
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
    .description("Manage tool trust rules (allow-list patterns for tool use)");

  trust.addHelpText(
    "after",
    `
Trust rules define which tool invocations the assistant is allowed to
execute without prompting. Each rule matches a specific tool and a
pattern (regular expression) against the tool input.

Examples:
  $ assistant trust list                List user-modified trust rules
  $ assistant trust list --all          Include unmodified defaults
  $ assistant trust add --tool bash --pattern "ls .*" --risk low --description "Directory listing"
  $ assistant trust update <id> --risk medium
  $ assistant trust remove <id>`,
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
    .action(
      async (opts: { all?: boolean; tool?: string; json?: boolean }) => {
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
      },
    );

  // ── add ───────────────────────────────────────────────────────────────────

  trust
    .command("add")
    .description("Add a new trust rule")
    .requiredOption("--tool <name>", "Tool name (e.g. bash, file_write)")
    .requiredOption("--pattern <regex>", "Regular expression pattern to match")
    .requiredOption(
      "--risk <level>",
      "Risk level: low, medium, or high",
    )
    .requiredOption(
      "--description <text>",
      "Human-readable description of the rule",
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Patterns are regular expressions (regex), not globs.

Example:
  $ assistant trust add --tool bash --pattern "ls .*" --risk low --description "Directory listing"

Options:
  --tool <name>          Tool name (e.g. bash, file_write, http_request).
  --pattern <regex>      Regular expression matched against the tool input.
  --risk <level>         One of: low, medium, high.
  --description <text>   Human-readable description of what this rule allows.
  --json                 Output as compact JSON instead of a success message.`,
    )
    .action(
      async (opts: {
        tool: string;
        pattern: string;
        risk: string;
        description: string;
        json?: boolean;
      }) => {
        const validRisks = ["low", "medium", "high"];
        if (!validRisks.includes(opts.risk)) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error: `Invalid --risk "${opts.risk}". Must be one of: low, medium, high`,
              }) + "\n",
            );
          } else {
            log.error(
              `Invalid --risk "${opts.risk}". Must be one of: low, medium, high`,
            );
          }
          process.exitCode = 1;
          return;
        }

        const result = await cliIpcCall<{ rule: TrustRule }>(
          "trust_rules_create",
          {
            body: {
              tool: opts.tool,
              pattern: opts.pattern,
              risk: opts.risk,
              description: opts.description,
            },
          },
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(result.error ?? "Failed to create trust rule");
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
        } else {
          const rule = result.result!.rule;
          log.info("Trust rule created: " + rule.id.slice(0, 8));
        }
      },
    );

  // ── update ────────────────────────────────────────────────────────────────

  trust
    .command("update <id>")
    .description("Update an existing trust rule by ID prefix")
    .option("--risk <level>", "New risk level: low, medium, or high")
    .option("--description <text>", "New human-readable description")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Run 'assistant trust list' to see available rule IDs.

The <id> argument can be a prefix of the full UUID (at least the first
few characters, enough to be unambiguous).

At least one of --risk or --description must be provided.

Examples:
  $ assistant trust update abc12345 --risk medium
  $ assistant trust update abc12345 --description "Updated description"
  $ assistant trust update abc12345 --risk high --description "Dangerous pattern"`,
    )
    .action(
      async (
        id: string,
        opts: { risk?: string; description?: string; json?: boolean },
      ) => {
        if (!opts.risk && !opts.description) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error:
                  "At least one of --risk or --description must be provided",
              }) + "\n",
            );
          } else {
            log.error(
              "At least one of --risk or --description must be provided",
            );
          }
          process.exitCode = 1;
          return;
        }

        if (opts.risk) {
          const validRisks = ["low", "medium", "high"];
          if (!validRisks.includes(opts.risk)) {
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({
                  ok: false,
                  error: `Invalid --risk "${opts.risk}". Must be one of: low, medium, high`,
                }) + "\n",
              );
            } else {
              log.error(
                `Invalid --risk "${opts.risk}". Must be one of: low, medium, high`,
              );
            }
            process.exitCode = 1;
            return;
          }
        }

        // Prefix resolution: fetch all rules to find the full ID
        const listResult = await cliIpcCall<{ rules: TrustRule[] }>(
          "trust_rules_list",
          { body: { include_all: true } },
        );

        if (!listResult.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: listResult.error }) + "\n",
            );
          } else {
            log.error(listResult.error ?? "Failed to list trust rules");
          }
          process.exitCode = 1;
          return;
        }

        const rules = listResult.result!.rules;
        const matches = rules.filter((r) => r.id.startsWith(id));

        if (matches.length === 0) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error: `No trust rule found matching prefix "${id}". Run 'assistant trust list --all' to see all rule IDs.`,
              }) + "\n",
            );
          } else {
            log.error(`No trust rule found matching prefix "${id}". Run 'assistant trust list --all' to see all rule IDs.`);
          }
          process.exitCode = 1;
          return;
        }

        if (matches.length > 1) {
          const details = matches
            .map((r) => `  ${r.id.slice(0, 20)}  ${r.tool}  ${r.pattern}`)
            .join("\n");
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error: `Ambiguous prefix "${id}" matches ${matches.length} rules:\n${details}`,
              }) + "\n",
            );
          } else {
            log.error(
              `Ambiguous prefix "${id}" matches ${matches.length} rules:\n${details}`,
            );
          }
          process.exitCode = 1;
          return;
        }

        const updateParams: Record<string, unknown> = {
          id: matches[0].id,
          ...(opts.risk ? { risk: opts.risk } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        };

        const result = await cliIpcCall<{ rule: TrustRule }>(
          "trust_rules_update",
          { body: updateParams },
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(result.error ?? "Failed to update trust rule");
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
        } else {
          const rule = result.result!.rule;
          log.info("Trust rule updated: " + rule.id.slice(0, 8));
        }
      },
    );

  // ── remove ────────────────────────────────────────────────────────────────

  trust
    .command("remove <id>")
    .description("Remove a trust rule by ID prefix")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Run 'assistant trust list' to see available rule IDs.

The <id> argument can be a prefix of the full UUID (at least the first
few characters, enough to be unambiguous).

Examples:
  $ assistant trust remove abc12345
  $ assistant trust remove abc12345 --json`,
    )
    .action(
      async (id: string, opts: { json?: boolean }) => {
        // Prefix resolution: fetch all rules to find the full ID
        const listResult = await cliIpcCall<{ rules: TrustRule[] }>(
          "trust_rules_list",
          { body: { include_all: true } },
        );

        if (!listResult.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: listResult.error }) + "\n",
            );
          } else {
            log.error(listResult.error ?? "Failed to list trust rules");
          }
          process.exitCode = 1;
          return;
        }

        const rules = listResult.result!.rules;
        const matches = rules.filter((r) => r.id.startsWith(id));

        if (matches.length === 0) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error: `No trust rule found matching prefix "${id}". Run 'assistant trust list --all' to see all rule IDs.`,
              }) + "\n",
            );
          } else {
            log.error(`No trust rule found matching prefix "${id}". Run 'assistant trust list --all' to see all rule IDs.`);
          }
          process.exitCode = 1;
          return;
        }

        if (matches.length > 1) {
          const details = matches
            .map((r) => `  ${r.id.slice(0, 20)}  ${r.tool}  ${r.pattern}`)
            .join("\n");
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                ok: false,
                error: `Ambiguous prefix "${id}" matches ${matches.length} rules:\n${details}`,
              }) + "\n",
            );
          } else {
            log.error(
              `Ambiguous prefix "${id}" matches ${matches.length} rules:\n${details}`,
            );
          }
          process.exitCode = 1;
          return;
        }

        const result = await cliIpcCall<{ success: boolean }>(
          "trust_rules_remove",
          { body: { id: matches[0].id } },
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(result.error ?? "Failed to remove trust rule");
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              data: { success: true, id: matches[0].id },
            }) + "\n",
          );
        } else {
          log.info("Trust rule removed: " + matches[0].id.slice(0, 8));
        }
      },
    );
}
