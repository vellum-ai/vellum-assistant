/**
 * `assistant channels` — inspect and repair messaging channels.
 *
 *   list                     — overview of every channel + ready state
 *   get <channel>            — detailed live snapshot of a single channel
 *   refresh [channel]        — reconnect / repair (mutating)
 *
 * `get` always re-runs remote probes (it invalidates the readiness cache
 * before reading), so the CLI answer matches the live source-of-truth.
 *
 * `refresh` is the mutating verb: for slack it stores fresh xoxb / xapp /
 * xoxp tokens and re-runs auth.test; without a channel argument it walks
 * each registered probe and reports what each channel needs to reconnect.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
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

interface SlackConfigResult {
  success: boolean;
  teamId?: string;
  teamName?: string;
  botUsername?: string;
  error?: string;
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

// ---------------------------------------------------------------------------
// Reconnect handlers — one per channel that supports CLI reconnect
// ---------------------------------------------------------------------------

interface ReconnectOpts {
  botToken?: string;
  appToken?: string;
  userToken?: string;
}

interface ReconnectResult {
  channel: string;
  attempted: boolean;
  ok?: boolean;
  message: string;
}

async function reconnectSlack(
  opts: ReconnectOpts,
): Promise<ReconnectResult> {
  if (!opts.botToken && !opts.appToken && !opts.userToken) {
    return {
      channel: "slack",
      attempted: false,
      message:
        "needs --bot-token <xoxb-…>, --app-token <xapp-…>, and/or --user-token <xoxp-…>",
    };
  }
  const body: Record<string, string> = {};
  if (opts.botToken) body.botToken = opts.botToken;
  if (opts.appToken) body.appToken = opts.appToken;
  if (opts.userToken) body.userToken = opts.userToken;

  const r = await cliIpcCall<SlackConfigResult>(
    "integrations_slack_channel_config_post",
    { body },
  );
  if (!r.ok) {
    return {
      channel: "slack",
      attempted: true,
      ok: false,
      message: r.error ?? "IPC call failed",
    };
  }
  const result = r.result!;
  return {
    channel: "slack",
    attempted: true,
    ok: result.success,
    message: result.success
      ? `connected to ${result.teamName ?? result.teamId ?? "workspace"} as ${result.botUsername ?? "bot"}`
      : (result.error ?? "Slack rejected the credentials"),
  };
}

/** Channels with an interactive (non-OAuth) reconnect path implemented in this CLI. */
const RECONNECT_HANDLERS: Record<
  string,
  (opts: ReconnectOpts) => Promise<ReconnectResult>
> = {
  slack: reconnectSlack,
};

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
  refresh [channel]       Reconnect / repair (mutating)

Examples:
  $ assistant channels list
  $ assistant channels get slack
  $ assistant channels refresh slack --bot-token xoxb-… --app-token xapp-…
  $ assistant channels refresh                  Walk every channel and report
                                                 what each needs to reconnect`,
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
          async (
            opts: { json?: boolean; remote?: boolean },
            cmd: Command,
          ) => {
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
        .argument(
          "<channel>",
          `Channel id: ${KNOWN_CHANNELS.join(", ")}`,
        )
        .option("--json", "Machine-readable compact JSON output")
        .action(
          async (
            channel: string,
            _opts: { json?: boolean },
            cmd: Command,
          ) => {
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
              log.error(`No readiness probe registered for channel: ${channel}`);
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
      // refresh — mutating reconnect
      // -----------------------------------------------------------------------

      channels
        .command("refresh")
        .description(
          "Reconnect a channel (mutating). Without an argument, walks every channel and reports what each needs.",
        )
        .argument(
          "[channel]",
          `Channel id to reconnect: ${Object.keys(RECONNECT_HANDLERS).join(", ")}`,
        )
        .option("--json", "Machine-readable compact JSON output")
        .option(
          "--bot-token <token>",
          "Slack bot token (xoxb-…) — required to reconnect slack",
        )
        .option(
          "--app-token <token>",
          "Slack app-level token (xapp-…) — required to reconnect slack with Socket Mode",
        )
        .option(
          "--user-token <token>",
          "Slack user token (xoxp-…) — optional, expands read scope",
        )
        .action(
          async (
            channel: string | undefined,
            opts: {
              json?: boolean;
              botToken?: string;
              appToken?: string;
              userToken?: string;
            },
            cmd: Command,
          ) => {
            const tokens: ReconnectOpts = {
              botToken: opts.botToken,
              appToken: opts.appToken,
              userToken: opts.userToken,
            };

            // -- Single channel mode ---------------------------------------
            if (channel) {
              const handler = RECONNECT_HANDLERS[channel];
              if (!handler) {
                log.error(
                  `No reconnect handler for '${channel}'. Available: ${Object.keys(RECONNECT_HANDLERS).join(", ") || "(none)"}`,
                );
                process.exitCode = 1;
                return;
              }
              const result = await handler(tokens);
              // Exit code is determined by the result; output format is
              // independent. A failed reconnect must exit non-zero even
              // when --json is set.
              if (!result.attempted || result.ok === false) {
                process.exitCode = 1;
              }
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, result);
                return;
              }
              if (!result.attempted) {
                log.error(`✗ ${channel}: ${result.message}`);
              } else if (result.ok) {
                log.info(`✅ ${channel}: ${result.message}`);
              } else {
                log.error(`✗ ${channel}: ${result.message}`);
              }
              return;
            }

            // -- All-channels mode -----------------------------------------
            // Walk every known channel; run a reconnect handler if we have
            // one, otherwise report that it isn't implemented yet.
            const results: ReconnectResult[] = [];
            for (const ch of KNOWN_CHANNELS) {
              const handler = RECONNECT_HANDLERS[ch];
              if (!handler) {
                results.push({
                  channel: ch,
                  attempted: false,
                  message:
                    "no CLI reconnect handler yet — connect via the dedicated command (e.g. `assistant oauth connect`, `assistant email register`)",
                });
                continue;
              }
              results.push(await handler(tokens));
            }

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { results });
              return;
            }
            for (const r of results) {
              const glyph = r.ok ? "✅" : r.attempted ? "✗ " : "ℹ️ ";
              log.info(`${glyph} ${r.channel.padEnd(12)} ${r.message}`);
            }
            if (results.some((r) => r.attempted && r.ok === false)) {
              process.exitCode = 1;
            }
          },
        );

    },
  });
}
