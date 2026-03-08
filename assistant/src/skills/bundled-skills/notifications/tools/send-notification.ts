import { getDeliverableChannels } from "../../../../channels/config.js";
import { emitNotificationSignal } from "../../../../notifications/emit-signal.js";
import type { AttentionHints } from "../../../../notifications/signal.js";
import type { NotificationChannel } from "../../../../notifications/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

const INVALID = Symbol("invalid");

const VALID_URGENCY = new Set<AttentionHints["urgency"]>([
  "low",
  "medium",
  "high",
]);
const VALID_CHANNEL_HINTS = new Set<NotificationChannel>(
  getDeliverableChannels() as NotificationChannel[],
);

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBool(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function parseDeadlineAt(value: unknown): number | undefined | typeof INVALID {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return INVALID;
}

function parseObject(
  value: unknown,
): Record<string, unknown> | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return INVALID;
  return value as Record<string, unknown>;
}

function parsePreferredChannels(
  value: unknown,
): NotificationChannel[] | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return INVALID;

  const channels: NotificationChannel[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !VALID_CHANNEL_HINTS.has(item as NotificationChannel)
    ) {
      return INVALID;
    }
    channels.push(item as NotificationChannel);
  }
  return [...new Set(channels)];
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const message = asNonEmptyString(input.message);
  if (!message) {
    return err("message is required.");
  }

  const urgencyInput = asNonEmptyString(input.urgency)?.toLowerCase();
  if (
    urgencyInput &&
    !VALID_URGENCY.has(urgencyInput as AttentionHints["urgency"])
  ) {
    return err("urgency must be one of: low, medium, high.");
  }
  const urgency =
    (urgencyInput as AttentionHints["urgency"] | undefined) ?? "medium";

  const deadlineAt = parseDeadlineAt(input.deadline_at);
  if (deadlineAt === INVALID) {
    return err("deadline_at must be a valid epoch timestamp (milliseconds).");
  }

  const deepLinkMetadata = parseObject(input.deep_link_metadata);
  if (deepLinkMetadata === INVALID) {
    return err("deep_link_metadata must be an object.");
  }

  const preferredChannels = parsePreferredChannels(input.preferred_channels);
  if (preferredChannels === INVALID) {
    return err(
      `preferred_channels must be an array containing only: ${[
        ...VALID_CHANNEL_HINTS,
      ].join(", ")}.`,
    );
  }

  const sourceEventName =
    asNonEmptyString(input.source_event_name) ?? "user.send_notification";
  const requestedConversationId =
    asNonEmptyString(input.conversation_id) ?? context.conversationId;
  const sourceSessionId = requestedConversationId ?? context.sessionId;
  const title = asNonEmptyString(input.title);
  const dedupeKey = asNonEmptyString(input.dedupe_key);

  const contextPayload: Record<string, unknown> = {
    requestedMessage: message,
    requestedByTool: "send_notification",
    requestedBySessionId: context.sessionId,
  };
  if (title) contextPayload.requestedTitle = title;
  if (requestedConversationId)
    contextPayload.requestedByConversationId = requestedConversationId;
  if (preferredChannels && preferredChannels.length > 0)
    contextPayload.preferredChannels = preferredChannels;
  if (deepLinkMetadata) contextPayload.deepLinkMetadata = deepLinkMetadata;

  try {
    await emitNotificationSignal({
      sourceEventName,
      sourceChannel: "assistant_tool",
      sourceSessionId,
      attentionHints: {
        requiresAction: parseBool(input.requires_action, true),
        urgency,
        deadlineAt,
        isAsyncBackground: parseBool(input.is_async_background, false),
        visibleInSourceNow: parseBool(input.visible_in_source_now, false),
      },
      contextPayload,
      dedupeKey,
      throwOnError: true,
    });

    return ok(
      "Notification request queued. Channel selection and delivery are handled by the notification router.",
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
