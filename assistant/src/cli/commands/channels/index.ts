/**
 * `assistant channels` — inspect and repair messaging channels.
 *
 * Generic subcommands (`list`, `status`, `refresh`) wrap the
 * `ChannelReadinessService` over IPC, surfacing the same snapshots
 * the runtime exposes via `/v1/channels/readiness`.
 *
 * Channel-specific repair lives under sub-commands (e.g. `channels slack
 * reconnect`) so the generic surface stays small.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { registerChannelsSlackCommand } from "./slack.js";

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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusGlyph(s: ChannelSnapshot): string {
  if (s.ready) return "✅";
  if (s.setupStatus === "not_configured") return "○ ";
  return "⚠️ ";
}

function renderList(snapshots: ChannelSnapshot[]): void {
  const sorted = [...snapshots].sort((a, b) =>
    a.channel.localeCompare(b.channel),
  );
  log.info("Channel        Status");
  log.info("-------------  ------");
  for (const s of sorted) {
    const status = s.ready
      ? "ready"
      : s.setupStatus === "not_configured"
        ? "not configured"
        : "incomplete";
    log.info(`${statusGlyph(s)} ${s.channel.padEnd(12)}  ${status}`);
  }
}

function renderStatus(s: ChannelSnapshot): void {
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
  if (s.stale) {
    log.info("");
    log.info(
      "(cached snapshot — pass --refresh to invalidate and re-run remote checks)",
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerChannelsCommand(program: Command): void {
  registerCommand(program, {
    name: "channels",
    transport: "ipc",
    description:
      "Inspect and repair messaging channels (email, slack, telegram, etc.)",
    build: (channels) => {
      channels.option("--json", "Machine-readable compact JSON output");

      channels.addHelpText(
        "after",
        `
Channels are the messaging surfaces the assistant talks over — email, slack,
telegram, whatsapp, phone, vellum, a2a. Each channel has a probe that reports
whether it's configured and (when applicable) reachable.

For a complete repair workflow on a single channel, use the channel-specific
sub-command (e.g. \`assistant channels slack reconnect\`).

Examples:
  $ assistant channels list                       Overview of every channel
  $ assistant channels status slack               Detailed snapshot for slack
  $ assistant channels status slack --refresh     Force re-probe (skip cache)
  $ assistant channels refresh                    Invalidate cache for all channels
  $ assistant channels slack reconnect            Re-paste slack tokens (xoxb/xapp)`,
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
          "Include remote checks (network round-trip to provider)",
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
            const snapshots = r.result!.snapshots;
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { snapshots });
            } else {
              renderList(snapshots);
            }
          },
        );

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      channels
        .command("status")
        .description("Show a detailed readiness snapshot for one channel")
        .argument(
          "<channel>",
          "Channel id (slack, email, telegram, whatsapp, phone, vellum, a2a)",
        )
        .option("--json", "Machine-readable compact JSON output")
        .option(
          "--refresh",
          "Invalidate the cached snapshot and re-run remote checks before reading",
          false,
        )
        .action(
          async (
            channel: string,
            opts: { json?: boolean; refresh?: boolean },
            cmd: Command,
          ) => {
            const method = opts.refresh
              ? "channels_readiness_refresh_post"
              : "channels_readiness_get";
            const params = opts.refresh
              ? { body: { channel, includeRemote: true } }
              : {
                  queryParams: {
                    channel,
                    includeRemote: "true",
                  },
                };

            const r = await cliIpcCall<ReadinessResponse>(method, params);
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
              renderStatus(snapshot);
            }
          },
        );

      // -----------------------------------------------------------------------
      // refresh
      // -----------------------------------------------------------------------

      channels
        .command("refresh")
        .description(
          "Invalidate the readiness cache and re-probe one or all channels",
        )
        .argument("[channel]", "Optional channel id; defaults to all channels")
        .option("--json", "Machine-readable compact JSON output")
        .action(
          async (
            channel: string | undefined,
            opts: { json?: boolean },
            cmd: Command,
          ) => {
            const body: Record<string, unknown> = { includeRemote: true };
            if (channel) body.channel = channel;

            const r = await cliIpcCall<ReadinessResponse>(
              "channels_readiness_refresh_post",
              { body },
            );
            if (!r.ok) {
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            const snapshots = r.result!.snapshots;
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { snapshots });
            } else {
              renderList(snapshots);
            }
          },
        );

      // -----------------------------------------------------------------------
      // channel-specific sub-commands
      // -----------------------------------------------------------------------

      registerChannelsSlackCommand(channels);
    },
  });
}
