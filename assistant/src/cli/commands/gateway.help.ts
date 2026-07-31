/** Declarative help for the `assistant gateway` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const gatewayHelp: CliCommandHelp = {
  name: "gateway",
  description: "Gateway management",
  helpText: `
The gateway is the channel ingress layer — it handles inbound HTTP requests,
manages trust rules, routes traffic to the assistant, and records
structured logs for all inbound activity.

Examples:
  $ assistant gateway status
  $ assistant gateway logs tail
  $ assistant gateway logs tail -n 50
  $ assistant gateway logs tail --level warn
  $ assistant gateway logs tail --module cors`,
  subcommands: [
    {
      name: "status",
      description: "Show gateway status (public tunnel state)",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Reports the live status of the gateway's public tunnel — the outbound
public-ingress transport (currently Velay).

The tunnel is ONLY used to route inbound Twilio webhooks and live voice/audio
WebSockets through to this assistant. It has nothing to do with platform
credentials, the managed LLM proxy, or text channels. If you are not using
Twilio voice or live audio, a "not connected" tunnel is expected and harmless.

JSON output (--json):
  { "tunnel": "<public-url>" }   when a tunnel is connected
  { }                            when the gateway is running but no tunnel is up

If the gateway itself is not running, the command exits non-zero with an error
rather than reporting an empty tunnel.

Examples:
  $ assistant gateway status
  $ assistant gateway status --json`,
    },
    {
      name: "logs",
      description: "Gateway log operations",
      helpText: `
Gateway logs are structured JSON (ndjson) entries emitted by the gateway
process. Each entry carries a timestamp, numeric pino log level, optional
module tag, and a message. Use 'tail' to inspect recent entries.

Examples:
  $ assistant gateway logs tail
  $ assistant gateway logs tail --level error --module cors`,
      subcommands: [
        {
          name: "tail",
          description: "Show last N gateway log entries",
          options: [
            {
              flags: "-n <number>",
              description: "Number of lines (default: 10)",
            },
            {
              flags: "-q, --quiet",
              description: "Suppress column headers",
            },
            {
              flags: "--level <level>",
              description:
                "Minimum log level (trace|debug|info|warn|error|fatal)",
              defaultValue: "info",
            },
            {
              flags: "--module <name>",
              description: "Filter to exact module name",
            },
            {
              flags: "--raw",
              description: "Output raw ndjson (one JSON object per line)",
            },
          ],
          helpText: `
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
        },
      ],
    },
  ],
};
