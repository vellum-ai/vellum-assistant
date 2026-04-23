import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command("notifications")
    .description(
      "Send and inspect notifications through the unified notification router",
    )
    .option("--json", "Machine-readable compact JSON output");

  notifications.addHelpText(
    "after",
    `
Notifications flow through a unified pipeline: a signal is emitted with a
source channel, event name, and attention hints. The decision engine evaluates
whether and where to deliver the notification based on connected channels,
urgency, and user preferences.

Examples:
  $ assistant notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Build finished"
  $ assistant notifications send --source-channel scheduler --source-event-name schedule.notify --message "Stand-up in 5 minutes" --urgency high
  $ assistant notifications send --source-channel watcher --source-event-name watcher.notification --message "File changed" --no-requires-action --is-async-background
  $ assistant notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Deploy complete" --preferred-channels vellum,telegram --json`,
  );

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  notifications
    .command("send")
    .description("Send a notification through the unified notification router")
    .requiredOption(
      "--source-channel <channel>",
      "Source channel producing this notification",
    )
    .requiredOption(
      "--source-event-name <name>",
      "Event name for audit, routing, and dedupe grouping",
    )
    .requiredOption(
      "--message <message>",
      "Notification message the user should receive",
    )
    .option("--title <title>", "Optional notification title")
    .option(
      "--urgency <urgency>",
      "Urgency hint: low, medium, high (default: medium)",
    )
    .option(
      "--requires-action",
      "Whether the notification expects user action (default: true)",
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
    .addHelpText(
      "after",
      `
Arguments:
  --source-channel     One of the registered source channels (see "assistant notifications --help")
  --source-event-name  One of the registered event names (see "assistant notifications --help")
  --message            The notification body text (required, must be non-empty)

Behavioral notes:
  - The signal is emitted through the full notification pipeline: event store,
    decision engine, deterministic checks, and channel dispatch.
  - --requires-action defaults to true; use --no-requires-action to disable.
  - --urgency defaults to medium if not specified.
  - --preferred-channels are hints only; the decision engine may override them.
  - --dedupe-key suppresses duplicate signals with the same key.

Examples:
  $ assistant notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Task complete"
  $ assistant notifications send --source-channel scheduler --source-event-name schedule.notify --message "Meeting in 5 min" --urgency high --title "Reminder"
  $ assistant notifications send --source-channel watcher --source-event-name watcher.notification --message "Detected change" --no-requires-action --is-async-background --json`,
    )
    .action(
      async (
        opts: {
          sourceChannel: string;
          sourceEventName: string;
          message: string;
          title?: string;
          urgency?: string;
          requiresAction: boolean;
          isAsyncBackground: boolean;
          visibleInSourceNow: boolean;
          deadlineAt?: string;
          preferredChannels?: string;
          sessionId?: string;
          dedupeKey?: string;
          deepLinkMetadata?: string;
        },
        cmd: Command,
      ) => {
        try {
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

          // Validate --urgency
          const urgency = opts.urgency ?? "medium";
          if (urgency !== "low" && urgency !== "medium" && urgency !== "high") {
            writeOutput(cmd, {
              ok: false,
              error: `Invalid urgency "${opts.urgency}". Must be one of: low, medium, high`,
            });
            process.exitCode = 1;
            return;
          }

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
              deepLinkMetadata = JSON.parse(opts.deepLinkMetadata) as Record<
                string,
                unknown
              >;
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

          const result = await cliIpcCall<{
            signalId: string;
            dispatched: boolean;
            deduplicated: boolean;
            reason: string;
          }>("emit_notification_signal", {
            sourceChannel: opts.sourceChannel,
            sourceEventName: opts.sourceEventName,
            sourceContextId,
            attentionHints: {
              requiresAction: opts.requiresAction ?? true,
              urgency,
              deadlineAt,
              isAsyncBackground: opts.isAsyncBackground ?? false,
              visibleInSourceNow: opts.visibleInSourceNow ?? false,
            },
            contextPayload: {
              requestedMessage: message,
              requestedBySource: opts.sourceChannel,
              ...(opts.title ? { requestedTitle: opts.title } : {}),
              ...(preferredChannels?.length ? { preferredChannels } : {}),
              ...(deepLinkMetadata ? { deepLinkMetadata } : {}),
            },
            ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
            throwOnError: true,
          });

          if (!result.ok) {
            writeOutput(cmd, { ok: false, error: result.error });
            process.exitCode = 1;
            return;
          }

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
    .description("List recent notification events from the local event store")
    .option("--limit <n>", "Maximum number of events to return (default: 20)")
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
            limit,
            sourceEventName: opts.sourceEventName,
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
}
