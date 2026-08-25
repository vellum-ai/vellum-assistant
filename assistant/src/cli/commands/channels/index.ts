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
import type { ChannelReadinessSnapshot } from "../../../runtime/channel-readiness-types.js";
import { applyCommandHelp, subcommand } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { channelsHelp } from "./index.help.js";

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

/**
 * The readiness service's own snapshot type, not a copy of it. A local
 * mirror is what let this command fall a field behind the contract: it had
 * no `health`, so a channel whose setup was complete and whose delivery had
 * stopped rendered as unfinished setup.
 */
type ChannelSnapshot = ChannelReadinessSnapshot;

interface ReadinessResponse {
  success: boolean;
  snapshots: ChannelSnapshot[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Two axes, reported as one line each.
 *
 * `setupStatus` says whether setup finished; `health` says whether the
 * channel is delivering. Collapsing them into setup progress alone is how a
 * configured channel whose socket had died came to print as `incomplete`,
 * which tells the reader to go finish a setup that is already complete.
 * Ordered so the operational answer wins: once setup is done, what remains
 * to say is whether it works.
 */
function statusState(
  s: ChannelSnapshot,
):
  | "ready"
  | "not configured"
  | "not delivering"
  | "state unknown"
  | "incomplete" {
  if (s.ready) {
    return "ready";
  }
  if (s.setupStatus === "not_configured") {
    return "not configured";
  }
  if (s.setupStatus === "ready") {
    return s.health === "unknown" ? "state unknown" : "not delivering";
  }
  return "incomplete";
}

const STATE_GLYPHS: Record<ReturnType<typeof statusState>, string> = {
  ready: "✅",
  "not configured": "○ ",
  "not delivering": "⚠️ ",
  // Neither vouched for nor condemned: the checks ran and settled nothing.
  "state unknown": "? ",
  incomplete: "⚠️ ",
};

function statusGlyph(s: ChannelSnapshot): string {
  return STATE_GLYPHS[statusState(s)];
}

function renderList(snapshots: ChannelSnapshot[]): void {
  const sorted = [...snapshots].sort((a, b) =>
    a.channel.localeCompare(b.channel),
  );
  log.info("Channel        Status");
  log.info("-------------  ------");
  for (const s of sorted) {
    log.info(`${statusGlyph(s)} ${s.channel.padEnd(12)}  ${statusState(s)}`);
  }
}

function renderSnapshot(s: ChannelSnapshot): void {
  log.info(`${statusGlyph(s)} ${s.channel} — ${statusState(s)}`);
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
// Command registration
// ---------------------------------------------------------------------------

export function registerChannelsCommand(program: Command): void {
  registerCommand(program, {
    name: channelsHelp.name,
    transport: "ipc",
    description: channelsHelp.description,
    build: (channels) => {
      applyCommandHelp(channels, channelsHelp);

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      subcommand(channels, "list").action(
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

      subcommand(channels, "get").action(
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
