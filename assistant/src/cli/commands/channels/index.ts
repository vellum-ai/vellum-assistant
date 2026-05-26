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
    },
  });
}
