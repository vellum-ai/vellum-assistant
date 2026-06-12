import type { Command } from "commander";

import type { FeedItem } from "../../home/feed-types.js";
import {
  cliIpcCall,
  exitCodeFromIpcResult,
  exitFromIpcResult,
} from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";

// ---------------------------------------------------------------------------
// Local types & helpers
// ---------------------------------------------------------------------------

interface ListHomeFeedPayload {
  items: FeedItem[];
  total: number;
  returned: number;
  hasMore: boolean;
  updatedAt: string;
}

const NOTIFICATION_SOURCE_CHANNEL_VALUES = [
  "assistant_tool",
  "vellum",
  "phone",
  "telegram",
  "slack",
  "scheduler",
  "watcher",
] as const;

const URGENCY_VALUES = ["low", "medium", "high", "critical"] as const;

const NOTIFICATION_STATUS_VALUES = [
  "new",
  "seen",
  "acted_on",
  "dismissed",
] as const;

const NOTIFICATION_CATEGORY_VALUES = [
  "security",
  "scheduling",
  "background",
  "email",
  "system",
] as const;

const DEFAULT_SOURCE_CHANNEL = "assistant_tool";
const SOURCE_CHANNEL_HELP = NOTIFICATION_SOURCE_CHANNEL_VALUES.join(", ");
const URGENCY_HELP = URGENCY_VALUES.join(", ");
const STATUS_HELP = NOTIFICATION_STATUS_VALUES.join(", ");
const CATEGORY_HELP = NOTIFICATION_CATEGORY_VALUES.join(", ");

function parseBoundedInt(
  raw: string | undefined,
  label: string,
  bounds: { min: number; max?: number },
): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const n = Number(raw);
  const upper = bounds.max ?? Infinity;
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < bounds.min ||
    n > upper
  ) {
    const range =
      bounds.max !== undefined
        ? `[${bounds.min}, ${bounds.max}]`
        : `>= ${bounds.min}`;
    return {
      error: `Invalid ${label} "${raw}". Must be an integer ${range}`,
    };
  }
  return { value: n };
}

function renderFeedItemsHuman(payload: ListHomeFeedPayload): void {
  if (payload.items.length === 0) {
    log.info("No notifications match the filters.");
    return;
  }
  log.info(`${payload.returned} of ${payload.total} notifications:\n`);
  for (const item of payload.items) {
    const idShort = item.id.slice(0, 8);
    const status = item.status.toUpperCase().padEnd(10);
    const urgency = (item.urgency ?? "").padEnd(8);
    const headline = item.title ?? item.summary;
    const convoTag = item.conversationId
      ? `  (conv: ${item.conversationId.slice(0, 8)})`
      : "";
    log.info(
      `  ${idShort}  ${item.createdAt}  ${status} ${urgency} ${headline}${convoTag}`,
    );
  }
  if (payload.hasMore) {
    log.info("\n(more results available; bump --offset to paginate)");
  }
}

function validateEnumValue(
  value: string | undefined,
  label: string,
  allowed: readonly string[],
): { error?: string } {
  if (value === undefined || allowed.includes(value)) return {};
  return {
    error: `Invalid ${label} "${value}". Must be one of: ${allowed.join(", ")}`,
  };
}

function validateEnumFlag(
  values: string[] | undefined,
  label: string,
  allowed: readonly string[],
): { error?: string } {
  if (!values) return {};
  for (const v of values) {
    const result = validateEnumValue(v, label, allowed);
    if (result.error) return result;
  }
  return {};
}

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
          "Notification body. Markdown (GFM) renders in the detail panel; the OS banner shows plain text.",
        )
        .option(
          "--urgent",
          "Mark this notification as urgent (fires push + visual flag in inbox)",
          false,
        )
        .option(
          "--source-channel <channel>",
          `Source channel producing this notification. One of: ${SOURCE_CHANNEL_HELP} (default: ${DEFAULT_SOURCE_CHANNEL})`,
        )
        .option(
          "--source-event-name <name>",
          "Event name for audit, routing, and dedupe grouping (default: assistant.share)",
        )
        .option(
          "--title <title>",
          "Short headline (≤ 8 words). Always provide one — the auto-derived fallback just truncates --message.",
        )
        .option(
          "--urgency <urgency>",
          `Urgency hint. One of: ${URGENCY_HELP} (default: low; use --urgent for critical)`,
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
              const sourceChannel =
                opts.sourceChannel ?? DEFAULT_SOURCE_CHANNEL;
              const sourceEventName = opts.sourceEventName ?? "assistant.share";

              const sourceChannelError = validateEnumValue(
                sourceChannel,
                "source-channel",
                NOTIFICATION_SOURCE_CHANNEL_VALUES,
              );
              if (sourceChannelError.error) {
                writeOutput(cmd, {
                  ok: false,
                  error: sourceChannelError.error,
                });
                process.exitCode = 1;
                return;
              }

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
              const urgencyError = validateEnumValue(
                urgency,
                "urgency",
                URGENCY_VALUES,
              );
              if (urgencyError.error) {
                writeOutput(cmd, {
                  ok: false,
                  error: urgencyError.error,
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

              // Picks up __CONVERSATION_ID / __SKILL_CONTEXT_JSON env vars
              // so deferred-emit can buffer notifications when called from a
              // background job that hasn't confirmed success yet.
              const originatingConversationId = tryResolveConversationId();

              // The signal's `sourceContextId` doubles as the home-feed's
              // navigation target — `resolveHomeFeedMirror` looks it up via
              // `getConversation()` and only renders a "Go to Convo" button
              // when it resolves to a real row. Prefer the conversation the
              // CLI was invoked from (env-derived) so notifications emitted
              // by background jobs and skills link back to their producing
              // convo; an explicit --session-id still wins to preserve
              // caller intent, and --conversation-id is the last resort
              // before the unresolvable `cli-<ts>` sentinel.
              const sourceContextId =
                opts.sessionId ??
                originatingConversationId ??
                conversationId ??
                `cli-${Date.now()}`;

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
                  ...(originatingConversationId
                    ? { originatingConversationId }
                    : {}),
                  throwOnError: true,
                },
              });

              if (!result.ok) {
                if (shouldOutputJson(cmd)) {
                  writeOutput(cmd, { ok: false, error: result.error });
                  process.exitCode = exitCodeFromIpcResult(result);
                  return;
                }
                return exitFromIpcResult(result);
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

      // Commander's `.exitOverride()` (used in tests) swallows thrown errors
      // from collector functions, so we append values here and validate the
      // accumulated array inside the action handler instead.
      const collectFlag = (
        value: string,
        prev: string[] | undefined,
      ): string[] => [...(prev ?? []), value];

      notifications
        .command("list")
        .description(
          "List notifications surfaced to the user via the home feed. Excludes dismissed items by default.",
        )
        .option(
          "--all",
          "Include dismissed items (default: only new/seen/acted_on)",
          false,
        )
        .option(
          "--status <status>",
          `Filter by status. One of: ${STATUS_HELP}; repeatable. Overrides --all default behavior.`,
          collectFlag,
        )
        .option(
          "--before <iso>",
          "Only items with createdAt strictly before this ISO-8601 timestamp",
        )
        .option(
          "--after <iso>",
          "Only items with createdAt strictly after this ISO-8601 timestamp",
        )
        .option(
          "--urgency <urgency>",
          `Filter by urgency. One of: ${URGENCY_HELP}; repeatable`,
          collectFlag,
        )
        .option(
          "--category <category>",
          `Filter by category. One of: ${CATEGORY_HELP}; repeatable`,
          collectFlag,
        )
        .option(
          "--conversation-id <id>",
          "Only items tied to this conversation id",
        )
        .option(
          "--from-assistant",
          "Only items emitted by the assistant",
          false,
        )
        .option("--noteworthy", "Only items flagged as noteworthy", false)
        .option(
          "--limit <n>",
          "Maximum number of items to return (default: 20, max: 200)",
        )
        .option("--offset <n>", "Pagination offset (default: 0)")
        .addHelpText(
          "after",
          `
Reads the home feed at $VELLUM_WORKSPACE_DIR/data/home-feed.json — the
user's notification inbox. Items are ordered by priority then recency,
matching what the user sees in the macOS Home page. The home feed covers
background/async notifications mirrored from the unified pipeline;
real-time chat pushes that did not mirror to the feed will not appear.

Examples:
  $ assistant notifications list
  $ assistant notifications list --all
  $ assistant notifications list --status new --status seen
  $ assistant notifications list --after 2026-05-28T00:00:00Z --urgency high
  $ assistant notifications list --conversation-id 7fab234c --json
  $ assistant notifications list --limit 5 --offset 5`,
        )
        .action(
          async (
            opts: {
              all?: boolean;
              status?: string[];
              before?: string;
              after?: string;
              urgency?: string[];
              category?: string[];
              conversationId?: string;
              fromAssistant?: boolean;
              noteworthy?: boolean;
              limit?: string;
              offset?: string;
            },
            cmd: Command,
          ) => {
            try {
              const enumChecks: Array<{ error?: string }> = [
                validateEnumFlag(
                  opts.status,
                  "status",
                  NOTIFICATION_STATUS_VALUES,
                ),
                validateEnumFlag(opts.urgency, "urgency", URGENCY_VALUES),
                validateEnumFlag(
                  opts.category,
                  "category",
                  NOTIFICATION_CATEGORY_VALUES,
                ),
              ];
              const enumError = enumChecks.find((c) => c.error);
              if (enumError) {
                writeOutput(cmd, { ok: false, error: enumError.error });
                process.exitCode = 1;
                return;
              }

              const limit = parseBoundedInt(opts.limit, "limit", {
                min: 1,
                max: 200,
              });
              if (limit.error) {
                writeOutput(cmd, { ok: false, error: limit.error });
                process.exitCode = 1;
                return;
              }
              const offset = parseBoundedInt(opts.offset, "offset", {
                min: 0,
              });
              if (offset.error) {
                writeOutput(cmd, { ok: false, error: offset.error });
                process.exitCode = 1;
                return;
              }

              if (opts.conversationId != null) {
                const trimmed = opts.conversationId.trim();
                if (trimmed.length === 0) {
                  writeOutput(cmd, {
                    ok: false,
                    error: "Conversation ID must be a non-empty string",
                  });
                  process.exitCode = 1;
                  return;
                }
              }

              const body: Record<string, unknown> = {};
              if (opts.all) body.includeDismissed = true;
              if (opts.status?.length) body.statuses = opts.status;
              if (opts.before) body.before = opts.before;
              if (opts.after) body.after = opts.after;
              if (opts.urgency?.length) body.urgencies = opts.urgency;
              if (opts.category?.length) body.categories = opts.category;
              if (opts.conversationId)
                body.conversationId = opts.conversationId.trim();
              if (opts.fromAssistant) body.fromAssistant = true;
              if (opts.noteworthy) body.noteworthy = true;
              if (limit.value !== undefined) body.limit = limit.value;
              if (offset.value !== undefined) body.offset = offset.value;

              const result = await cliIpcCall<ListHomeFeedPayload>(
                "list_home_feed",
                { body },
              );

              if (!result.ok) {
                writeOutput(cmd, { ok: false, error: result.error });
                process.exitCode = exitCodeFromIpcResult(result);
                return;
              }

              const payload = result.result!;
              writeOutput(cmd, { ok: true, ...payload });

              if (!shouldOutputJson(cmd)) {
                renderFeedItemsHuman(payload);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              writeOutput(cmd, { ok: false, error: message });
              process.exitCode = 1;
            }
          },
        );

      // -------------------------------------------------------------------------
      // edit
      // -------------------------------------------------------------------------

      notifications
        .command("edit")
        .description(
          "Edit an already-sent notification. Patches the home-feed entry and updates the delivered channel message in place where supported (Slack today).",
        )
        .requiredOption(
          "--id <id>",
          "Feed item id (notif:<uuid>) from `notifications list --json`. Bare uuids without the `notif:` prefix are also accepted.",
        )
        .option(
          "--message <message>",
          "New notification body. Updates the home-feed summary and the delivered channel message text where supported.",
        )
        .option("--title <title>", "New short headline (≤ 8 words).")
        .option(
          "--urgency <urgency>",
          `Set urgency. One of: ${URGENCY_HELP}. Feed-only — does not re-push channel messages.`,
        )
        .option(
          "--status <status>",
          `Set lifecycle status. One of: ${STATUS_HELP}. Feed-only.`,
        )
        .addHelpText(
          "after",
          `
At least one of --message, --title, --urgency, or --status must be
supplied. --urgency and --status only update the home-feed entry —
they never re-push channel messages.

Channel updates are best-effort: Slack messages get updated via
chat.update; other channels (push, email, SMS) cannot be edited and
are reported as "unsupported".

Examples:
  $ assistant notifications edit --id notif:abc12345-... --message "Fixed body"
  $ assistant notifications edit --id abc12345-... --title "Backup complete"
  $ assistant notifications edit --id notif:abc12345-... --urgency low
  $ assistant notifications edit --id notif:abc12345-... --status dismissed`,
        )
        .action(
          async (
            opts: {
              id: string;
              message?: string;
              title?: string;
              urgency?: string;
              status?: string;
            },
            cmd: Command,
          ) => {
            try {
              const id = opts.id.trim();
              if (!id) {
                writeOutput(cmd, {
                  ok: false,
                  error: "--id must be a non-empty string",
                });
                process.exitCode = 1;
                return;
              }

              if (
                opts.message === undefined &&
                opts.title === undefined &&
                opts.urgency === undefined &&
                opts.status === undefined
              ) {
                writeOutput(cmd, {
                  ok: false,
                  error:
                    "At least one of --message, --title, --urgency, or --status must be supplied",
                });
                process.exitCode = 1;
                return;
              }

              const urgencyError = validateEnumValue(
                opts.urgency,
                "urgency",
                URGENCY_VALUES,
              );
              if (urgencyError.error) {
                writeOutput(cmd, {
                  ok: false,
                  error: urgencyError.error,
                });
                process.exitCode = 1;
                return;
              }
              const statusError = validateEnumValue(
                opts.status,
                "status",
                NOTIFICATION_STATUS_VALUES,
              );
              if (statusError.error) {
                writeOutput(cmd, {
                  ok: false,
                  error: statusError.error,
                });
                process.exitCode = 1;
                return;
              }

              const body: Record<string, unknown> = { id };
              if (opts.message !== undefined) body.body = opts.message;
              if (opts.title !== undefined) body.title = opts.title;
              if (opts.urgency !== undefined) body.urgency = opts.urgency;
              if (opts.status !== undefined) body.status = opts.status;

              const result = await cliIpcCall<{
                feedItem: FeedItem;
                channels: Array<{
                  channel: string;
                  deliveryId: string;
                  outcome: "updated" | "unsupported" | "skipped" | "failed";
                  reason?: string;
                }>;
              }>("edit_notification", { body });

              if (!result.ok) {
                writeOutput(cmd, { ok: false, error: result.error });
                process.exitCode = exitCodeFromIpcResult(result);
                return;
              }

              const payload = result.result!;
              writeOutput(cmd, { ok: true, ...payload });

              if (!shouldOutputJson(cmd)) {
                const item = payload.feedItem;
                log.info(`Updated ${item.id}`);
                const headline = item.title ?? item.summary;
                log.info(`  ${headline}`);
                if (payload.channels.length === 0) {
                  log.info("  No channel deliveries to update.");
                } else {
                  log.info("  Channels:");
                  for (const ch of payload.channels) {
                    const reason = ch.reason ? ` — ${ch.reason}` : "";
                    log.info(`    ${ch.channel}: ${ch.outcome}${reason}`);
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
