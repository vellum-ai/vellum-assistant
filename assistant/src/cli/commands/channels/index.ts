/**
 * `assistant channels` — inspect messaging channels.
 *
 *   list                     — overview of every channel + ready state
 *   get <channel>            — detailed live snapshot of a single channel
 *
 * `get` always re-runs remote probes (it invalidates the readiness cache
 * before reading), so the CLI answer matches the live source-of-truth.
 *
 * A mutating `refresh` verb (for reconnecting channels — e.g. supplying
 * fresh Slack tokens) is intentionally not shipped here; it will land in
 * its own PR.
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import type { SlackChannelConfigResult } from "../../../runtime/routes/integrations/slack/channel.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Snapshot shape (mirrors runtime/routes/channel-readiness-routes.ts)
// ---------------------------------------------------------------------------

interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;
}

interface ChannelSnapshot {
  channel: string;
  ready: boolean;
  setupStatus: "not_configured" | "incomplete" | "ready";
  checkedAt: number;
  stale: boolean;
  reasons: Array<{ code: string; text: string }>;
  localChecks: ReadinessCheck[];
  remoteChecks?: ReadinessCheck[];
  channelHandle?: unknown;
}

interface ReadinessResponse {
  success: boolean;
  snapshots: ChannelSnapshot[];
}

/**
 * Read `{ botToken, appToken }` from the `--payload` flag or, preferably,
 * stdin. Reading from stdin keeps the secret tokens off the process command
 * line — callers (e.g. the `slack-app-setup` skill) pipe the values in so
 * they never appear in a process listing or shell history.
 */
function readSlackConfigPayload(payloadFlag?: string): {
  botToken: string;
  appToken: string;
} {
  let raw: string;
  if (payloadFlag) {
    raw = payloadFlag;
  } else if (process.stdin.isTTY) {
    throw new Error(
      'No tokens provided. Pipe JSON {"botToken":"...","appToken":"..."} into stdin (preferred for secrets) or use --payload.',
    );
  } else {
    raw = readFileSync("/dev/stdin", "utf-8");
  }

  if (!raw.trim()) {
    throw new Error(
      'Empty input. Provide JSON {"botToken":"...","appToken":"..."}.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Payload must be a JSON object with botToken and appToken.",
    );
  }

  const obj = parsed as Record<string, unknown>;
  const botToken = typeof obj.botToken === "string" ? obj.botToken.trim() : "";
  const appToken = typeof obj.appToken === "string" ? obj.appToken.trim() : "";
  if (!botToken || !appToken) {
    throw new Error("Both botToken and appToken are required.");
  }
  return { botToken, appToken };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusGlyph(s: ChannelSnapshot): string {
  if (s.ready) return "✅";
  if (s.setupStatus === "not_configured") return "○ ";
  return "⚠️ ";
}

function statusWord(s: ChannelSnapshot): string {
  if (s.ready) return "ready";
  if (s.setupStatus === "not_configured") return "not configured";
  return "incomplete";
}

function renderList(snapshots: ChannelSnapshot[]): void {
  const sorted = [...snapshots].sort((a, b) =>
    a.channel.localeCompare(b.channel),
  );
  log.info("Channel        Status");
  log.info("-------------  ------");
  for (const s of sorted) {
    log.info(`${statusGlyph(s)} ${s.channel.padEnd(12)}  ${statusWord(s)}`);
  }
}

function renderSnapshot(s: ChannelSnapshot): void {
  log.info(`${statusGlyph(s)} ${s.channel} — ${s.setupStatus}`);
  if (s.reasons.length > 0) {
    log.info("");
    log.info("Reasons:");
    for (const r of s.reasons) {
      log.info(`  • [${r.code}] ${r.text}`);
    }
  }
  if (s.localChecks.length > 0) {
    log.info("");
    log.info("Local checks:");
    for (const c of s.localChecks) {
      log.info(`  ${c.passed ? "✓" : "✗"} ${c.name} — ${c.message}`);
    }
  }
  if (s.remoteChecks && s.remoteChecks.length > 0) {
    log.info("");
    log.info("Remote checks:");
    for (const c of s.remoteChecks) {
      log.info(`  ${c.passed ? "✓" : "✗"} ${c.name} — ${c.message}`);
    }
  }
}

/** All channel IDs the readiness service knows about. Mirrors channels/types.ts. */
const KNOWN_CHANNELS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
] as const;

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerChannelsCommand(program: Command): void {
  registerCommand(program, {
    name: "channels",
    transport: "ipc",
    description:
      "Inspect and repair messaging channels (slack, telegram, email, etc.)",
    build: (channels) => {
      channels.addHelpText(
        "after",
        `
Channels are the messaging surfaces the assistant talks over — slack,
telegram, whatsapp, email, phone, vellum, platform, a2a. Each channel
has a probe that reports whether it's configured and reachable.

  list                    Overview of every channel + ready state
  get <channel>           Live snapshot of one channel (always re-probes)

Examples:
  $ assistant channels list
  $ assistant channels get slack`,
      );

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      channels
        .command("list")
        .description("Show readiness state for every configured channel")
        .option("--json", "Machine-readable compact JSON output")
        .option(
          "--remote",
          "Include remote checks (live network round-trip per channel)",
          false,
        )
        .action(
          async (opts: { json?: boolean; remote?: boolean }, cmd: Command) => {
            const r = await cliIpcCall<ReadinessResponse>(
              "channels_readiness_get",
              {
                queryParams: {
                  includeRemote: opts.remote ? "true" : "false",
                },
              },
            );
            if (!r.ok) {
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { snapshots: r.result!.snapshots });
            } else {
              renderList(r.result!.snapshots);
            }
          },
        );

      // -----------------------------------------------------------------------
      // get — always live (invalidates cache + re-runs remote checks)
      // -----------------------------------------------------------------------

      channels
        .command("get")
        .description(
          "Live readiness snapshot for one channel (always re-probes; no caching)",
        )
        .argument("<channel>", `Channel id: ${KNOWN_CHANNELS.join(", ")}`)
        .option("--json", "Machine-readable compact JSON output")
        .action(
          async (channel: string, _opts: { json?: boolean }, cmd: Command) => {
            // `get` is always live: invalidate the cache and re-run remote
            // checks. This matches what source code does when it needs to
            // know the channel's current state — no stale snapshots.
            const r = await cliIpcCall<ReadinessResponse>(
              "channels_readiness_refresh_post",
              { body: { channel, includeRemote: true } },
            );
            if (!r.ok) {
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            const snapshot = r.result!.snapshots.find(
              (s) => s.channel === channel,
            );
            if (!snapshot) {
              log.error(
                `No readiness probe registered for channel: ${channel}`,
              );
              process.exitCode = 1;
              return;
            }
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, snapshot);
            } else {
              renderSnapshot(snapshot);
            }
          },
        );

      // -----------------------------------------------------------------------
      // configure-slack — validate + store Slack tokens, activate Socket Mode
      // -----------------------------------------------------------------------

      channels
        .command("configure-slack")
        .description(
          "Validate and store Slack bot + app tokens, then activate Socket Mode",
        )
        .option(
          "--payload <json>",
          'JSON object {"botToken":"...","appToken":"..."} (defaults to reading stdin; prefer stdin for secrets)',
        )
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Stores both Slack tokens through the same validated path the Settings UI
uses: the bot token is checked against Slack's auth.test, workspace metadata
is recorded, and Socket Mode activates once both tokens are present.

Tokens are read from stdin by default so they never appear on the command
line. Both botToken and appToken are required.

Examples:
  $ echo '{"botToken":"xoxb-...","appToken":"xapp-..."}' | assistant channels configure-slack --json`,
        )
        .action(
          async (opts: { payload?: string; json?: boolean }, cmd: Command) => {
            let tokens: { botToken: string; appToken: string };
            try {
              tokens = readSlackConfigPayload(opts.payload);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, { ok: false, error: msg });
              } else {
                log.error(msg);
              }
              process.exitCode = 1;
              return;
            }

            const r = await cliIpcCall<SlackChannelConfigResult>(
              "integrations_slack_channel_config_post",
              { body: tokens },
            );
            if (!r.ok) {
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }

            const result = r.result!;
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { ok: true, ...result });
            } else if (result.connected) {
              const team = result.teamName ?? "your workspace";
              const bot = result.botUsername ? ` (@${result.botUsername})` : "";
              log.info(
                `✅ Slack connected to ${team}${bot}. Socket Mode is active.`,
              );
            } else if (result.warning) {
              log.info(`⚠️  ${result.warning}`);
            } else {
              log.info("Slack tokens stored.");
            }
          },
        );
    },
  });
}
