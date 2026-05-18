import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerNotificationsCommand(program: Command): void {
  registerCommand(program, {
    name: "notifications",
    transport: "ipc",
    description:
      "Send and inspect notifications through the unified notification router",
    build: (notifications) => {
      notifications.option("--json", "Machine-readable compact JSON output");

      notifications.addHelpText(
        "after",
        `
Notifications flow through a unified pipeline: a signal is emitted with a
source channel, event name, and attention hints. The decision engine evaluates
whether and where to deliver the notification based on connected channels,
urgency, and user preferences.

Minimal usage: only --message is required. Add --urgent for a push + visual
flag in the inbox. Source channel/event name fall back to assistant_tool /
assistant.share when omitted.

Examples:
  $ assistant notifications send --message "Build finished"
  $ assistant notifications send --message "Pager: prod is down" --urgent
  $ assistant notifications send --message "Build green" --conversation-id 649c4645-3a6f-4ded-a713-504f02ca806b`,
      );

      // -------------------------------------------------------------------------
      // send
      // -------------------------------------------------------------------------

      notifications
        .command("send")
        .description(
          "Send a notification through the unified notification router. Only --message is required; pass --urgent for a push + visual flag.",
        )
        .requiredOption(
          "--message <message>",
          "Notification message the user should receive",
        )
        .option(
          "--urgent",
          "Mark this notification as urgent (fires push + visual flag in inbox)",
          false,
        )
        .option(
          "--source-channel <channel>",
          "Source channel producing this notification (default: assistant_tool)",
        )
        .option(
          "--source-event-name <name>",
          "Event name for audit, routing, and dedupe grouping (default: assistant.share)",
        )
        .option("--title <title>", "Optional notification title")
        .option(
          "--urgency <urgency>",
          "Urgency hint: low, medium, high, critical (default: low; use --urgent for critical)",
        )
        .option(
          "--requires-action",
          "Whether the notification expects user action (default: false; use --urgent to force true)",
        )
        .option(
          "--no-requires-action",
          "Mark that the notification does not expect user action",
        )
        .option(
          "--is-async-background",
          "Whether the event is asynchronous/background work (default: false)",
        )
        .option(
          "--no-is-async-background",
          "Mark that the event is not asynchronous/background work",
        )
        .option(
          "--visible-in-source-now",
          "Set true when user is already viewing the source context (default: false)",
        )
        .option(
          "--no-visible-in-source-now",
          "Mark that the user is not viewing the source context",
        )
        .option(
          "--deadline-at <epoch>",
          "Optional deadline timestamp in epoch milliseconds",
        )
        .option(
          "--preferred-channels <channels>",
          "Comma-separated channel hints (e.g. vellum,telegram,slack)",
        )
        .option(
          "--session-id <id>",
          "Source session or conversation ID (default: cli-<timestamp>)",
        )
        .option(
          "--dedupe-key <key>",
          "Optional dedupe key to suppress duplicate notifications",
        )
        .option(
          "--deep-link-metadata <json>",
          "Optional JSON metadata clients can use for deep linking",
        )
        .option(
          "--conversation-id <id>",
          "Local vellum conversation ID to deliver into. When set, the notification reuses the specified conversation instead of starting a new one — bypasses the LLM's conversation-routing decision via affinity hint.",
        )
        .addHelpText(
          "after",
          `
Arguments:
  --message            The notification body text (required, must be non-empty)
  --urgent             Shortcut that maps to urgency=critical + requires-action=true

Behavioral notes:
  - The signal is emitted through the full notification pipeline: event store,
    decision engine, deterministic checks, and channel dispatch.
  - --urgent overrides --urgency and --requires-action defaults so the signal
    is treated as critical and requires user action. Explicit --urgency /
    --requires-action flags still win for back-compat.
  - Without --urgent, --urgency defaults to low and --requires-action to false.
  - --preferred-channels are hints only; the decision engine may override them.
  - --dedupe-key suppresses duplicate signals with the same key.
  - --conversation-id pins delivery to an existing vellum conversation
    deterministically. Other channels (telegram, slack) continue to use
    binding-based pairing for their external threads.

Examples:
  $ assistant notifications send --message "Task complete"
  $ assistant notifications send --message "Pager: prod is down" --urgent
  $ assistant notifications send --message "Build green" --conversation-id 649c4645-3a6f-4ded-a713-504f02ca806b`,
        )
        .action(
          async (
            opts: {
              sourceChannel?: string;
              sourceEventName?: string;
              message: string;
              urgent: boolean;
              title?: string;
              urgency?: string;
              requiresAction?: boolean;
              isAsyncBackground: boolean;
              visibleInSourceNow: boolean;
              deadlineAt?: string;
              preferredChannels?: string;
              sessionId?: string;
              dedupeKey?: string;
              deepLinkMetadata?: string;
              conversationId?: string;
            },
            cmd: Command,
          ) => {
            try {
              // Apply defaults for optional source fields (minimal-surface
              // ergonomics; explicit values from the CLI still win).
              const sourceChannel = opts.sourceChannel ?? "assistant_tool";
              const sourceEventName = opts.sourceEventName ?? "assistant.share";

              // Validate --message (keep basic validation for immediate CLI feedback)
              const message = opts.message.trim();
              if (message.length === 0) {
                writeOutput(cmd, {
                  ok: false,
                  error: "Message must be a non-empty string",
                });
                process.exitCode = 1;
                return;
              }

              // --urgent is a shortcut for urgency=critical + requiresAction=true.
              // Explicit --urgency / --requires-action flags still win so the
              // back-compat path keeps working during the deprecation window.
              const urgentDefaults = opts.urgent
                ? { urgency: "critical", requiresAction: true }
                : { urgency: "low", requiresAction: false };

              // Validate --urgency
              const urgency = opts.urgency ?? urgentDefaults.urgency;
              if (
                urgency !== "low" &&
                urgency !== "medium" &&
                urgency !== "high" &&
                urgency !== "critical"
              ) {
                writeOutput(cmd, {
                  ok: false,
                  error: `Invalid urgency "${opts.urgency}". Must be one of: low, medium, high, critical`,
                });
                process.exitCode = 1;
                return;
              }
              const requiresAction =
                opts.requiresAction ?? urgentDefaults.requiresAction;

              // Parse --deadline-at
              let deadlineAt: number | undefined;
              if (opts.deadlineAt != null) {
                const parsed = Number(opts.deadlineAt);
                if (!Number.isFinite(parsed)) {
                  writeOutput(cmd, {
                    ok: false,
                    error: `Invalid deadline-at "${opts.deadlineAt}". Must be a finite number (epoch milliseconds)`,
                  });
                  process.exitCode = 1;
                  return;
                }
                deadlineAt = parsed;
              }

              // Parse --preferred-channels
              let preferredChannels: string[] | undefined;
              if (opts.preferredChannels) {
                preferredChannels = opts.preferredChannels
                  .split(",")
                  .map((ch) => ch.trim())
                  .filter((ch) => ch.length > 0);
              }

              // Parse --deep-link-metadata
              let deepLinkMetadata: Record<string, unknown> | undefined;
              if (opts.deepLinkMetadata != null) {
                try {
                  deepLinkMetadata = JSON.parse(
                    opts.deepLinkMetadata,
                  ) as Record<string, unknown>;
                } catch {
                  writeOutput(cmd, {
                    ok: false,
                    error: `Invalid deep-link-metadata: must be a valid JSON string`,
                  });
                  process.exitCode = 1;
                  return;
                }
              }

              const sourceContextId = opts.sessionId ?? `cli-${Date.now()}`;

              // Validate --conversation-id if provided
              const conversationId = opts.conversationId?.trim();
              if (opts.conversationId != null && !conversationId) {
                writeOutput(cmd, {
                  ok: false,
                  error: "Conversation ID must be a non-empty string",
                });
                process.exitCode = 1;
                return;
              }

              const result = await cliIpcCall<{
                signalId: string;
                dispatched: boolean;
                deduplicated: boolean;
                reason: string;
              }>("emit_notification_signal", {
                body: {
                  sourceChannel,
                  sourceEventName,
                  sourceContextId,
                  attentionHints: {
                    requiresAction,
                    urgency,
                    deadlineAt,
                    isAsyncBackground: opts.isAsyncBackground ?? false,
                    visibleInSourceNow: opts.visibleInSourceNow ?? false,
                  },
                  contextPayload: {
                    requestedMessage: message,
                    requestedBySource: sourceChannel,
                    ...(opts.title ? { requestedTitle: opts.title } : {}),
                    ...(preferredChannels?.length ? { preferredChannels } : {}),
                    ...(deepLinkMetadata ? { deepLinkMetadata } : {}),
                  },
                  ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
                  ...(conversationId
                    ? { conversationAffinityHint: { vellum: conversationId } }
                    : {}),
                  throwOnError: true,
                },
              });

              if (!result.ok) return exitFromIpcResult(result);

              const signal = result.result!;

              writeOutput(cmd, {
                ok: true,
                signalId: signal.signalId,
                dispatched: signal.dispatched,
                reason: signal.reason,
              });

              if (!shouldOutputJson(cmd)) {
                log.info(
                  `Signal ${signal.signalId} emitted (dispatched: ${signal.dispatched})`,
                );
                if (signal.reason) {
                  log.info(`  Reason: ${signal.reason}`);
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
            }
          },
        );

      // -------------------------------------------------------------------------
      // list
      // -------------------------------------------------------------------------

      notifications
        .command("list")
        .description(
          "List recent notification events from the local event store",
        )
        .option(
          "--limit <n>",
          "Maximum number of events to return (default: 20)",
        )
        .option("--source-event-name <name>", "Filter by source event name")
        .addHelpText(
          "after",
          `
Reads from the local notification events store, ordered by creation time
(newest first). Each event represents a signal that was emitted through the
notification pipeline.

Examples:
  $ assistant notifications list
  $ assistant notifications list --limit 5
  $ assistant notifications list --source-event-name schedule.notify
  $ assistant notifications list --source-event-name schedule.notify --limit 10 --json`,
        )
        .action(
          async (
            opts: {
              limit?: string;
              sourceEventName?: string;
            },
            cmd: Command,
          ) => {
            try {
              // Validate --source-event-name (accept any non-empty string; custom
              // event names are valid since skills can emit arbitrary names)
              if (
                opts.sourceEventName != null &&
                opts.sourceEventName.trim().length === 0
              ) {
                writeOutput(cmd, {
                  ok: false,
                  error: "Source event name must be a non-empty string",
                });
                process.exitCode = 1;
                return;
              }

              // Parse and validate --limit
              let limit = 20;
              if (opts.limit != null) {
                const parsed = Number(opts.limit);
                if (
                  !Number.isFinite(parsed) ||
                  !Number.isInteger(parsed) ||
                  parsed < 1
                ) {
                  writeOutput(cmd, {
                    ok: false,
                    error: `Invalid limit "${opts.limit}". Must be a positive integer`,
                  });
                  process.exitCode = 1;
                  return;
                }
                limit = parsed;
              }

              const result = await cliIpcCall<
                Array<{
                  id: string;
                  sourceEventName: string;
                  sourceChannel: string;
                  sourceContextId: string;
                  urgency: string;
                  dedupeKey: string | null;
                  createdAt: string;
                }>
              >("list_notification_events", {
                body: { limit, sourceEventName: opts.sourceEventName },
              });

              if (!result.ok) {
                writeOutput(cmd, { ok: false, error: result.error });
                process.exitCode = 1;
                return;
              }

              const events = result.result!;

              writeOutput(cmd, { ok: true, events });

              if (!shouldOutputJson(cmd)) {
                if (events.length === 0) {
                  log.info("No notification events found");
                } else {
                  log.info(`${events.length} event(s):\n`);
                  for (const event of events) {
                    log.info(
                      `  ${event.createdAt}  ${event.sourceEventName}  ${event.urgency}  ${event.sourceChannel}`,
                    );
                  }
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
            }
          },
        );
    },
  });
}
