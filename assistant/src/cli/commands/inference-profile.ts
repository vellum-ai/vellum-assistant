/**
 * `assistant inference profile` CLI namespace.
 *
 * Subcommands:
 *   - `assistant inference profile open <profileName>`  — Open a profile session
 *   - `assistant inference profile close`               — Close the active profile session
 *   - `assistant inference profile list`                — List active profile sessions
 *
 * All commands delegate to the daemon via IPC.
 */

import type { Command } from "commander";

import { getConfigReadOnly } from "../../config/loader.js";
import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { resolveConversationId } from "../utils/conversation-id.js";
import { parseDuration } from "../utils/parse-duration.js";

const CONV_ID_HELP =
  "No conversation ID available.\n" +
  "Provide --conversation-id explicitly, or run from a skill or bash tool context.";

// ── Type aliases ─────────────────────────────────────────────────────

type OpenResult = {
  conversationId: string;
  profile: string | null;
  sessionId: string | null;
  expiresAt: number | null;
  ttlSeconds: number | null;
  replaced: {
    profile: string | null;
    sessionId: string | null;
    expiresAt: number | null;
  } | null;
};

type CloseResult = {
  conversationId: string;
  closed: { profile: string | null; sessionId: string | null } | null;
  noop: boolean;
};

type ListSession = {
  conversationId: string;
  conversationTitle: string | null;
  profile: string;
  sessionId: string;
  expiresAt: number;
  remainingSeconds: number;
};

type ListResult = { sessions: ListSession[] };

// ── Helpers ───────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function writeLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

// ── Registration ─────────────────────────────────────────────────────

export function attachProfileSubcommand(parent: Command): void {
  const profile = parent
    .command("profile")
    .description("Manage conversation-scoped inference profile sessions");

  profile.addHelpText(
    "after",
    `
Inference profile sessions pin a named model profile to a specific
conversation for the duration of the session.

Examples:
  $ assistant inference profile open balanced --ttl 30m
  $ assistant inference profile open fast --ttl never
  $ assistant inference profile close
  $ assistant inference profile list`,
  );

  // ── profile open ──────────────────────────────────────────────────

  profile
    .command("open <profileName>")
    .description("Open a profile session for the current conversation")
    .option(
      "--ttl <duration>",
      'Session TTL (e.g. 30m, 1h, "never" for sticky; default: configured llm.profileSession.defaultTtlSeconds (30m if unset))',
    )
    .option(
      "--conversation-id <id>",
      "Conversation ID (auto-resolved from context if omitted)",
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Opens a profile session that pins the given profile to the current
conversation. The session expires after --ttl, or is sticky (no
expiry) if --ttl never is specified. If --ttl is omitted, the session
defaults to llm.profileSession.defaultTtlSeconds (30m if unset).

Examples:
  $ assistant inference profile open balanced --ttl 30m
  $ assistant inference profile open fast --ttl never
  $ assistant inference profile open balanced            # uses default 30m TTL
  $ assistant inference profile open balanced --json`,
    )
    .action(
      async (
        profileName: string,
        opts: {
          ttl?: string;
          conversationId?: string;
          json?: boolean;
        },
      ) => {
        let conversationId: string;
        try {
          conversationId = resolveConversationId({
            explicit: opts.conversationId,
            failureHelp: CONV_ID_HELP,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
          return;
        }

        // Parse TTL
        let ttlSeconds: number | null | undefined; // undefined = omit from body
        let requestedTtlSeconds: number | undefined;

        if (opts.ttl !== undefined) {
          if (opts.ttl === "never") {
            ttlSeconds = null;
          } else {
            try {
              ttlSeconds = parseDuration(opts.ttl);
              requestedTtlSeconds = ttlSeconds;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (opts.json) {
                process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
              } else {
                log.error(`Error: ${msg}`);
              }
              process.exitCode = 1;
              return;
            }
          }
        }

        const defaultTtlSeconds =
          getConfigReadOnly().llm?.profileSession?.defaultTtlSeconds ?? 1800;
        const effectiveTtlSeconds =
          ttlSeconds !== undefined ? ttlSeconds : defaultTtlSeconds;
        const body: Record<string, unknown> = {
          conversationId,
          profile: profileName,
          ttlSeconds: effectiveTtlSeconds,
        };

        const ipcResult = await cliIpcCall<OpenResult>(
          "inference_profile_open",
          { body },
        );

        if (!ipcResult.ok) {
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: ipcResult.error }) + "\n");
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const result = ipcResult.result!;
        const { sessionId, expiresAt, replaced } = result;
        const resultTtlSeconds = result.ttlSeconds;

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              conversationId: result.conversationId,
              profile: profileName,
              sessionId,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
              ttlSeconds: resultTtlSeconds,
              replaced: replaced
                ? {
                    ...replaced,
                    expiresAt: replaced.expiresAt
                      ? new Date(replaced.expiresAt).toISOString()
                      : null,
                  }
                : null,
            }) + "\n",
          );
        } else {
          // Warn if TTL was clamped by the server (human-readable mode only)
          if (
            typeof requestedTtlSeconds === "number" &&
            typeof resultTtlSeconds === "number" &&
            requestedTtlSeconds !== resultTtlSeconds
          ) {
            writeLine(`note: ttl clamped to ${formatDuration(resultTtlSeconds)} (config maxTtlSeconds)`);
          }

          // Human-readable output
          if (resultTtlSeconds == null) {
            writeLine(`profile ${profileName} active (sticky, no expiry)`);
          } else {
            const expireStr = expiresAt != null ? formatLocalTime(expiresAt) : "?";
            writeLine(
              `profile ${profileName} active for ${formatDuration(resultTtlSeconds)} (until ${expireStr})`,
            );
          }

          if (replaced) {
            const replacedExpiry = replaced.expiresAt
              ? formatLocalTime(replaced.expiresAt)
              : "?";
            writeLine(
              `replaced: ${replaced.profile} (was active until ${replacedExpiry})`,
            );
          }
        }
      },
    );

  // ── profile close ─────────────────────────────────────────────────

  profile
    .command("close")
    .description("Close the active profile session for the current conversation")
    .option(
      "--conversation-id <id>",
      "Conversation ID (auto-resolved from context if omitted)",
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Closes the active profile session for the conversation. This is
idempotent — if no session is active the command succeeds with
a "no active profile session" message.

Examples:
  $ assistant inference profile close
  $ assistant inference profile close --json`,
    )
    .action(
      async (opts: { conversationId?: string; json?: boolean }) => {
        let conversationId: string;
        try {
          conversationId = resolveConversationId({
            explicit: opts.conversationId,
            failureHelp: CONV_ID_HELP,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
          } else {
            log.error(`Error: ${msg}`);
          }
          process.exitCode = 1;
          return;
        }

        const ipcResult = await cliIpcCall<CloseResult>(
          "inference_profile_close",
          { body: { conversationId } },
        );

        if (!ipcResult.ok) {
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: ipcResult.error }) + "\n");
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const result = ipcResult.result!;

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              conversationId: result.conversationId,
              closed: result.closed,
              noop: result.noop,
            }) + "\n",
          );
        } else {
          if (result.noop || !result.closed) {
            writeLine("no active profile session");
          } else {
            writeLine(`closed profile ${result.closed.profile}`);
          }
        }
      },
    );

  // ── profile list ──────────────────────────────────────────────────

  profile
    .command("list")
    .description("List active profile sessions")
    .option(
      "--conversation-id <id>",
      "Filter to a specific conversation ID",
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Lists all active inference profile sessions. Optionally filter by
conversation ID.

Examples:
  $ assistant inference profile list
  $ assistant inference profile list --conversation-id conv-abc123
  $ assistant inference profile list --json`,
    )
    .action(async (opts: { conversationId?: string; json?: boolean }) => {
      const ipcResult = await cliIpcCall<ListResult>(
        "inference_profile_list",
        {
          queryParams: opts.conversationId
            ? { conversationId: opts.conversationId }
            : {},
        },
      );

      if (!ipcResult.ok) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: false, error: ipcResult.error }) + "\n");
        } else {
          log.error(`Error: ${ipcResult.error}`);
        }
        process.exitCode = 1;
        return;
      }

      const { sessions } = ipcResult.result!;

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            ok: true,
            sessions: sessions.map((s) => ({
              ...s,
              expiresAt: s.expiresAt != null ? new Date(s.expiresAt).toISOString() : null,
            })),
          }) + "\n",
        );
        return;
      }

      if (sessions.length === 0) {
        writeLine("no active profile sessions");
        return;
      }

      writeLine(`${sessions.length} active session(s):`);
      for (const s of sessions) {
        const convId = s.conversationId.padEnd(14);
        const profile = s.profile.padEnd(16);
        const remaining = `${formatDuration(s.remainingSeconds)} left`.padEnd(12);
        const rawTitle = s.conversationTitle ?? "...";
        const title =
          rawTitle.length > 30 ? rawTitle.slice(0, 30) + "..." : rawTitle;
        writeLine(`  ${convId}  ${profile}  ${remaining}  "${title}"`);
      }
    });
}
