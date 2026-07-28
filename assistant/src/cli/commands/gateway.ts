/**
 * `assistant gateway` CLI namespace.
 *
 * Subcommands:
 *   status   — Show the gateway's public tunnel status via the daemon IPC proxy.
 *   logs tail — Show the last N gateway log entries via the daemon IPC proxy.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { gatewayHelp } from "./gateway.help.js";

// -- Types --------------------------------------------------------------------

interface PinoEntry {
  time: number; // Unix ms timestamp
  level: number; // pino numeric level
  module?: string;
  msg?: string;
  [key: string]: unknown;
}

interface GatewayStatusResult {
  tunnel?: string;
}

// -- Helpers ------------------------------------------------------------------

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const centis = String(Math.floor((ms % 1000) / 10)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${centis}`
  );
}

const LEVEL_NAMES: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

function levelName(n: number): string {
  return LEVEL_NAMES[n] ?? String(n);
}

function colorLevel(name: string, levelNum: number): string {
  if (!process.stdout.isTTY) return name;
  if (levelNum >= 50) return `\x1b[31m${name}\x1b[0m`; // red: error/fatal
  if (levelNum === 40) return `\x1b[33m${name}\x1b[0m`; // yellow: warn
  if (levelNum <= 20) return `\x1b[2m${name}\x1b[0m`; // dim: debug/trace
  return name;
}

// -- Registration -------------------------------------------------------------

export function registerGatewayCommand(program: Command): void {
  registerCommand(program, {
    name: gatewayHelp.name,
    transport: "ipc",
    description: gatewayHelp.description,
    build: (gateway) => {
      applyCommandHelp(gateway, gatewayHelp);

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      subcommand(gateway, "status").action(async (_opts, cmd: Command) => {
        const r = await cliIpcCall<GatewayStatusResult>("gateway_status", {});
        if (!r.ok)
          return exitFromIpcResult(
            { ok: false, error: r.error, statusCode: r.statusCode },
            cmd,
          );

        const result = r.result!;

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
          return;
        }

        if (result.tunnel) {
          log.info(`Tunnel: connected (${result.tunnel})`);
        } else {
          log.info("Tunnel: not connected");
        }
        log.info(
          "  The public tunnel is only used to route inbound Twilio webhooks and",
        );
        log.info(
          "  live voice/audio WebSockets. It is not needed for text channels or",
        );
        log.info("  the managed LLM proxy.");
      });

      const logs = subcommand(gateway, "logs");

      subcommand(logs, "tail").action(async (opts) => {
        const n = Math.max(
          1,
          Math.min(1000, parseInt(opts.n ?? "10", 10) || 10),
        );
        const params: Record<string, unknown> = { n };
        if (opts.level && opts.level !== "info") params.level = opts.level;
        if (opts.module) params.module = opts.module;

        const result = await cliIpcCall<{
          lines: PinoEntry[];
          truncated: boolean;
        }>("gateway_logs_tail", { body: params });

        if (!result.ok) {
          log.error(result.error ?? "Failed to fetch gateway logs");
          process.exitCode = 1;
          return;
        }

        const { lines, truncated } = result.result!;

        if (opts.raw) {
          for (const entry of lines)
            process.stdout.write(JSON.stringify(entry) + "\n");
          return;
        }

        if (lines.length === 0) {
          if (!opts.quiet) process.stdout.write("No log entries found.\n");
          return;
        }

        const moduleWidth = Math.min(
          12,
          Math.max(6, ...lines.map((l) => l.module?.length ?? 0)),
        );

        if (!opts.quiet) {
          process.stdout.write(
            `${"TIME".padEnd(24)}  ${"LEVEL".padEnd(5)}  ${"MODULE".padEnd(moduleWidth)}  MESSAGE\n`,
          );
        }

        for (const entry of lines) {
          const time = formatTime(entry.time).padEnd(24);
          const lvlName = levelName(entry.level).padEnd(5);
          const lvlColored = colorLevel(lvlName, entry.level);
          const mod = (entry.module ?? "").padEnd(moduleWidth);
          const msg = entry.msg ?? "";
          const msgTrunc = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
          process.stdout.write(`${time}  ${lvlColored}  ${mod}  ${msgTrunc}\n`);
        }

        if (truncated) {
          const footer = `(showing last ${n} matching entries — earlier entries exist)`;
          const dim = process.stdout.isTTY ? `\x1b[2m${footer}\x1b[0m` : footer;
          process.stdout.write(dim + "\n");
        }
      });
    },
  });
}
