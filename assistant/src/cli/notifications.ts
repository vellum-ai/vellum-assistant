import type { Command } from "commander";

import { getDeliverableChannels } from "../channels/config.js";
import { initializeDb } from "../memory/db.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  isNotificationSourceChannel,
  isNotificationSourceEventName,
  NOTIFICATION_SOURCE_CHANNELS,
  NOTIFICATION_SOURCE_EVENT_NAMES,
} from "../notifications/signal.js";
import type { NotificationChannel } from "../notifications/types.js";
import { getCliLogger } from "../util/logger.js";
import { shouldOutputJson, writeOutput } from "./integrations.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Help text builders
// ---------------------------------------------------------------------------

function buildSourceChannelsHelpBlock(): string {
  const lines = NOTIFICATION_SOURCE_CHANNELS.map(
    (c) => `  ${c.id.padEnd(20)} ${c.description}`,
  );
  return `\nSource channels:\n${lines.join("\n")}`;
}

function buildSourceEventNamesHelpBlock(): string {
  const lines = NOTIFICATION_SOURCE_EVENT_NAMES.map(
    (e) => `  ${e.id.padEnd(50)} ${e.description}`,
  );
  return `\nSource event names:\n${lines.join("\n")}`;
}

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
${buildSourceChannelsHelpBlock()}
${buildSourceEventNamesHelpBlock()}

Examples:
  $ vellum notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Build finished"
  $ vellum notifications send --source-channel scheduler --source-event-name reminder.fired --message "Stand-up in 5 minutes" --urgency high
  $ vellum notifications send --source-channel watcher --source-event-name watcher.notification --message "File changed" --no-requires-action --is-async-background
  $ vellum notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Deploy complete" --preferred-channels vellum,telegram --json`,
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
    .addHelpText(
      "after",
      `
Arguments:
  --source-channel     One of the registered source channels (see "vellum notifications --help")
  --source-event-name  One of the registered event names (see "vellum notifications --help")
  --message            The notification body text (required, must be non-empty)

Behavioral notes:
  - The signal is emitted through the full notification pipeline: event store,
    decision engine, deterministic checks, and channel dispatch.
  - --requires-action defaults to true; use --no-requires-action to disable.
  - --urgency defaults to medium if not specified.
  - --preferred-channels are hints only; the decision engine may override them.
  - --dedupe-key suppresses duplicate signals with the same key.

Examples:
  $ vellum notifications send --source-channel assistant_tool --source-event-name user.send_notification --message "Task complete"
  $ vellum notifications send --source-channel scheduler --source-event-name reminder.fired --message "Meeting in 5 min" --urgency high --title "Reminder"
  $ vellum notifications send --source-channel watcher --source-event-name watcher.notification --message "Detected change" --no-requires-action --is-async-background --json`,
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
        },
        cmd: Command,
      ) => {
        try {
          // Validate --source-channel
          if (!isNotificationSourceChannel(opts.sourceChannel)) {
            const validChannels = NOTIFICATION_SOURCE_CHANNELS.map(
              (c) => c.id,
            ).join(", ");
            writeOutput(cmd, {
              ok: false,
              error: `Invalid source channel "${opts.sourceChannel}". Valid values: ${validChannels}`,
            });
            process.exitCode = 1;
            return;
          }

          // Validate --source-event-name
          if (!isNotificationSourceEventName(opts.sourceEventName)) {
            const validEvents = NOTIFICATION_SOURCE_EVENT_NAMES.map(
              (e) => e.id,
            ).join(", ");
            writeOutput(cmd, {
              ok: false,
              error: `Invalid source event name "${opts.sourceEventName}". Valid values: ${validEvents}`,
            });
            process.exitCode = 1;
            return;
          }

          // Validate --message
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

          // Validate --deadline-at
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

          // Validate --preferred-channels
          let preferredChannels: NotificationChannel[] | undefined;
          if (opts.preferredChannels) {
            const deliverable = getDeliverableChannels();
            const requested = opts.preferredChannels
              .split(",")
              .map((ch) => ch.trim())
              .filter((ch) => ch.length > 0);

            for (const ch of requested) {
              if (!deliverable.includes(ch as NotificationChannel)) {
                writeOutput(cmd, {
                  ok: false,
                  error: `Invalid preferred channel "${ch}". Valid deliverable channels: ${deliverable.join(", ")}`,
                });
                process.exitCode = 1;
                return;
              }
            }
            preferredChannels = requested as NotificationChannel[];
          }

          initializeDb();

          const sourceSessionId = opts.sessionId ?? `cli-${Date.now()}`;

          const result = await emitNotificationSignal({
            sourceEventName: opts.sourceEventName,
            sourceChannel: opts.sourceChannel,
            sourceSessionId,
            attentionHints: {
              requiresAction: opts.requiresAction,
              urgency,
              deadlineAt,
              isAsyncBackground: opts.isAsyncBackground,
              visibleInSourceNow: opts.visibleInSourceNow,
            },
            contextPayload: {
              requestedMessage: message,
              requestedBySource: opts.sourceChannel,
              ...(opts.title ? { requestedTitle: opts.title } : {}),
              ...(preferredChannels?.length ? { preferredChannels } : {}),
            },
            ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
            throwOnError: true,
          });

          writeOutput(cmd, {
            ok: true,
            signalId: result.signalId,
            dispatched: result.dispatched,
            reason: result.reason,
          });

          if (!shouldOutputJson(cmd)) {
            log.info(
              `Signal ${result.signalId} emitted (dispatched: ${result.dispatched})`,
            );
            if (result.reason) {
              log.info(`  Reason: ${result.reason}`);
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
