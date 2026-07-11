/**
 * `assistant inference session` CLI namespace.
 *
 * Subcommands:
 *   - `assistant inference session open <profileName>`  — Open a profile session
 *   - `assistant inference session close`               — Close the active profile session
 *   - `assistant inference session list`                — List active profile sessions
 *
 * All commands delegate to the daemon via IPC.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";
import { resolveConversationId } from "../utils/conversation-id.js";
import { parseDuration } from "../utils/parse-duration.js";

const CONV_ID_HELP =
  "No conversation ID available.\n" +
  "Provide --conversation-id explicitly, or run from a skill or bash tool context.";

/**
 * Default session TTL in seconds when --ttl is not specified.
 * Matches the documented default of 30 minutes.
 */
const DEFAULT_TTL_SECONDS = 1800;

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

export function attachSessionSubcommand(parent: Command): void {
  const session = subcommand(parent, "session");

  // ── profile open ──────────────────────────────────────────────────

  subcommand(session, "open").action(
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
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
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
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(`Error: ${msg}`);
            }
            process.exitCode = 1;
            return;
          }
        }
      }

      const effectiveTtlSeconds =
        ttlSeconds !== undefined ? ttlSeconds : DEFAULT_TTL_SECONDS;
      const body: Record<string, unknown> = {
        conversationId,
        profile: profileName,
        ttlSeconds: effectiveTtlSeconds,
      };

      const ipcResult = await cliIpcCall<OpenResult>("inference_profile_open", {
        body,
      });

      if (!ipcResult.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
          );
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
          writeLine(
            `note: ttl clamped to ${formatDuration(resultTtlSeconds)} (config maxTtlSeconds)`,
          );
        }

        // Human-readable output
        if (resultTtlSeconds == null) {
          writeLine(`profile ${profileName} active (sticky, no expiry)`);
        } else {
          const expireStr =
            expiresAt != null ? formatLocalTime(expiresAt) : "?";
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

  subcommand(session, "close").action(
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
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
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
          process.stdout.write(
            JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
          );
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

  subcommand(session, "list").action(
    async (opts: { conversationId?: string; json?: boolean }) => {
      const ipcResult = await cliIpcCall<ListResult>("inference_profile_list", {
        queryParams: opts.conversationId
          ? { conversationId: opts.conversationId }
          : {},
      });

      if (!ipcResult.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
          );
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
              expiresAt:
                s.expiresAt != null
                  ? new Date(s.expiresAt).toISOString()
                  : null,
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
        const remaining = `${formatDuration(s.remainingSeconds)} left`.padEnd(
          12,
        );
        const rawTitle = s.conversationTitle ?? "...";
        const title =
          rawTitle.length > 30 ? rawTitle.slice(0, 30) + "..." : rawTitle;
        writeLine(`  ${convId}  ${profile}  ${remaining}  "${title}"`);
      }
    },
  );
}
