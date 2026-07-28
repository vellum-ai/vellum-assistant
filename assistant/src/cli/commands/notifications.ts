import type { Command } from "commander";

import type { FeedItem } from "../../home/feed-types.js";
import {
  cliIpcCall,
  exitCodeFromIpcResult,
  exitFromIpcResult,
} from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { tryResolveConversationId } from "../utils/conversation-id.js";
import {
  DEFAULT_SOURCE_CHANNEL,
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_SOURCE_CHANNEL_VALUES,
  NOTIFICATION_STATUS_VALUES,
  notificationsHelp,
  URGENCY_VALUES,
} from "./notifications.help.js";

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
    name: notificationsHelp.name,
    transport: "ipc",
    description: notificationsHelp.description,
    build: (notifications) => {
      applyCommandHelp(notifications, notificationsHelp);

      // -------------------------------------------------------------------------
      // send
      // -------------------------------------------------------------------------

      subcommand(notifications, "send").action(
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
            const sourceChannel = opts.sourceChannel ?? DEFAULT_SOURCE_CHANNEL;
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

      const list = subcommand(notifications, "list");

      // The declarative help contract carries plain data only, so the
      // repeatable flags are declared there without their collector and get
      // it attached here before any parsing happens.
      for (const flags of [
        "--status <status>",
        "--urgency <urgency>",
        "--category <category>",
      ]) {
        list.options.find((o) => o.flags === flags)!.argParser(collectFlag);
      }

      list.action(
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

      subcommand(notifications, "edit").action(
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
