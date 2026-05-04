/**
 * `assistant gateway` CLI namespace.
 *
 * Subcommands:
 *   logs tail — Show the last N gateway log entries via the daemon IPC proxy.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// -- Types --------------------------------------------------------------------

interface PinoEntry {
  time: number; // Unix ms timestamp
  level: number; // pino numeric level
  module?: string;
  msg?: string;
  [key: string]: unknown;
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
  const gateway = program.command("gateway").description("Gateway management");

  gateway.addHelpText(
    "after",
    `
The gateway is the channel ingress layer — it handles inbound HTTP requests,
manages trust rules, routes traffic to the assistant, and records
structured logs for all inbound activity.

Examples:
  $ assistant gateway logs tail
  $ assistant gateway logs tail -n 50
  $ assistant gateway logs tail --level warn
  $ assistant gateway logs tail --module cors`,
  );

  const logs = gateway.command("logs").description("Gateway log operations");

  logs.addHelpText(
    "after",
    `
Gateway logs are structured JSON (ndjson) entries emitted by the gateway
process. Each entry carries a timestamp, numeric pino log level, optional
module tag, and a message. Use 'tail' to inspect recent entries.

Examples:
  $ assistant gateway logs tail
  $ assistant gateway logs tail --level error --module cors`,
  );

  logs
    .command("tail")
    .description("Show last N gateway log entries")
    .option("-n <number>", "Number of lines (default: 10)")
    .option("-q, --quiet", "Suppress column headers")
    .option(
      "--level <level>",
      "Minimum log level (trace|debug|info|warn|error|fatal)",
      "info",
    )
    .option("--module <name>", "Filter to exact module name")
    .option("--raw", "Output raw ndjson (one JSON object per line)")
    .addHelpText(
      "after",
      `
Arguments:
  -n <number>        Number of entries to return, clamped to 1–1000 (default: 10).
  --level <level>    Minimum log level to include. One of:
                       trace | debug | info | warn | error | fatal
                     Defaults to "info". Use "trace" or "debug" for verbose output.
  --module <name>    Filter to entries whose module tag exactly matches <name>.
                     Useful for isolating a specific subsystem (e.g. "cors", "trust").
  --raw              Emit raw ndjson — one JSON object per line — instead of the
                     formatted table. Useful for piping to jq or other JSON tools.
  -q, --quiet        Suppress the column-header line in table output.

Output format (default table):
  TIME (24 chars)  LEVEL (5 chars)  MODULE (up to 12 chars)  MESSAGE (truncated at 120 chars)

Truncation:
  When more matching entries exist beyond the requested -n window, a dim
  "(showing last N matching entries — earlier entries exist)" footer is printed.

Examples:
  $ assistant gateway logs tail
  $ assistant gateway logs tail -n 50 --level warn
  $ assistant gateway logs tail --module cors --raw | jq .msg`,
    )
    .action(async (opts) => {
      const n = Math.max(1, Math.min(1000, parseInt(opts.n ?? "10", 10) || 10));
      const params: Record<string, unknown> = { n };
      if (opts.level && opts.level !== "info") params.level = opts.level;
      if (opts.module) params.module = opts.module;

      const result = await cliIpcCall<{ lines: PinoEntry[]; truncated: boolean }>(
        "gateway_logs_tail",
        { body: params },
      );

      if (!result.ok) {
        log.error(result.error ?? "Failed to fetch gateway logs");
        process.exitCode = 1;
        return;
      }

      const { lines, truncated } = result.result!;

      if (opts.raw) {
        for (const entry of lines) process.stdout.write(JSON.stringify(entry) + "\n");
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
}
