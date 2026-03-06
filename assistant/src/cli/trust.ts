import type { Command } from "commander";

import {
  clearAllRules,
  getAllRules,
  removeRule,
} from "../permissions/trust-store.js";
import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

const SHORT_HASH_LENGTH = 8;

export function registerTrustCommand(program: Command): void {
  const trust = program.command("trust").description("Manage trust rules");

  trust.addHelpText(
    "after",
    `
Trust rules are pattern-based decisions (allow/deny) for tool invocations.
Each rule specifies a tool name, a command pattern matched with glob syntax,
a scope, a decision (allow or deny), and a priority. Rules are stored in
~/.vellum/protected/trust.json and evaluated in priority order when the
assistant invokes a tool.

Examples:
  $ vellum trust list
  $ vellum trust remove abc123
  $ vellum trust clear`,
  );

  trust
    .command("list")
    .description("List all trust rules")
    .addHelpText(
      "after",
      `
Displays a table of all trust rules with the following columns:

  ID        First 8 characters of the full rule UUID
  Tool      Tool name the rule applies to (e.g. bash, host_bash)
  Pattern   Glob pattern matched against the tool's command argument
  Scope     Context scope for the rule (e.g. workspace path)
  Dcn       Decision: allow or deny
  Pri       Priority (higher values take precedence)
  Created   Date the rule was created (YYYY-MM-DD)

IDs are shown truncated to 8 characters. Use the full ID or any unique
prefix with "trust remove".

Examples:
  $ vellum trust list`,
    )
    .action(() => {
      const rules = getAllRules();
      if (rules.length === 0) {
        log.info("No trust rules");
        return;
      }
      const idW = 8;
      const toolW = 12;
      const patternW = 30;
      const scopeW = 20;
      const decW = 6;
      const priW = 4;
      log.info(
        "ID".padEnd(idW) +
          "Tool".padEnd(toolW) +
          "Pattern".padEnd(patternW) +
          "Scope".padEnd(scopeW) +
          "Dcn".padEnd(decW) +
          "Pri".padEnd(priW) +
          "Created",
      );
      log.info("-".repeat(idW + toolW + patternW + scopeW + decW + priW + 20));
      for (const r of rules) {
        const id = r.id.slice(0, SHORT_HASH_LENGTH);
        const created = new Date(r.createdAt).toISOString().slice(0, 10);
        log.info(
          id.padEnd(idW) +
            r.tool.padEnd(toolW) +
            r.pattern.slice(0, patternW - 2).padEnd(patternW) +
            r.scope.slice(0, scopeW - 2).padEnd(scopeW) +
            r.decision.slice(0, decW - 1).padEnd(decW) +
            String(r.priority).padEnd(priW) +
            created,
        );
      }
    });

  trust
    .command("remove <id>")
    .description("Remove a trust rule by ID (or prefix)")
    .addHelpText(
      "after",
      `
Arguments:
  id   Full UUID or any unique prefix of the rule to remove

Matches the given id against all stored rule IDs using prefix matching. If
exactly one rule matches, it is removed. If multiple rules match (ambiguous
prefix), lists the matches and exits with an error — no rule is removed. If
no rule matches, exits with an error. Use "trust list" to see rule IDs
(shown truncated to 8 chars).

Examples:
  $ vellum trust remove abc12345
  $ vellum trust remove abc1
  $ vellum trust remove a1b2c3d4-e5f6-7890-abcd-ef1234567890`,
    )
    .action((id: string) => {
      const rules = getAllRules();
      const matches = rules.filter((r) => r.id.startsWith(id));
      if (matches.length === 0) {
        log.error(`No rule found matching "${id}"`);
        process.exit(1);
      }
      if (matches.length > 1) {
        log.error(`Ambiguous prefix "${id}" matches ${matches.length} rules:`);
        for (const m of matches) {
          log.error(
            `  ${m.id.slice(0, SHORT_HASH_LENGTH)}  ${m.tool}: ${m.pattern}`,
          );
        }
        log.error("Provide a longer prefix to uniquely identify the rule.");
        process.exit(1);
      }
      const match = matches[0]!;
      try {
        removeRule(match.id);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log.info(
        `Removed rule ${match.id.slice(0, SHORT_HASH_LENGTH)} (${match.tool}: ${
          match.pattern
        })`,
      );
    });

  trust
    .command("clear")
    .description("Remove all trust rules")
    .addHelpText(
      "after",
      `
Removes every trust rule from ~/.vellum/protected/trust.json. Prompts for
confirmation before proceeding (y/N). This action is irreversible — all
rules must be re-created manually after clearing.

Examples:
  $ vellum trust clear`,
    )
    .action(async () => {
      const rules = getAllRules();
      if (rules.length === 0) {
        log.info("No trust rules to clear");
        return;
      }
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Remove all ${rules.length} trust rules? (y/N) `, resolve);
      });
      rl.close();
      if (answer.toLowerCase() === "y") {
        clearAllRules();
        log.info(`Cleared ${rules.length} trust rules`);
      } else {
        log.info("Cancelled");
      }
    });
}
