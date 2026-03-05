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

  trust
    .command("list")
    .description("List all trust rules")
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
    .action((id: string) => {
      const rules = getAllRules();
      const match = rules.find((r) => r.id.startsWith(id));
      if (!match) {
        log.error(`No rule found matching "${id}"`);
        process.exit(1);
      }
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
