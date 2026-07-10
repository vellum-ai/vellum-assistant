import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { auditHelp } from "./audit.help.js";

interface ToolInvocationRow {
  toolName: string;
  input: string;
  decision: string;
  riskLevel: string;
  durationMs: number;
  createdAt: number;
}

export function registerAuditCommand(program: Command): void {
  registerCommand(program, {
    name: auditHelp.name,
    transport: "ipc",
    description: auditHelp.description,
    build: (audit) => {
      applyCommandHelp(audit, auditHelp);
      audit.action(async (opts: { limit: string; json?: boolean }) => {
        const limit = parseInt(opts.limit, 10) || 20;
        const response = await cliIpcCall<{
          invocations: ToolInvocationRow[];
        }>("audit_list", {
          queryParams: { limit: String(limit) },
        });
        if (!response.ok) {
          return exitFromIpcResult(response);
        }
        const rows = response.result!.invocations;

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

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
    },
  });
}
