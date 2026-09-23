/**
 * Prepare channel-inbound message content for a turn.
 *
 * A non-guardian channel message is untrusted external data, so its text is
 * fenced in `<external_content>` boundaries (via {@link wrapUntrustedContent})
 * before it enters model context — the model is instructed never to follow
 * instructions found inside those boundaries. Guardian messages are trusted and
 * pass through unwrapped. Slack additionally keeps the raw text as
 * `displayContent` so the UI shows the message the sender actually typed, and
 * prepends a `<slack_app_context>` block when the event reported what the
 * sender had open in Slack.
 *
 * Shared by the live ingress path (`inbound-message-handler.ts`) and the retry
 * sweep (`channel-retry-sweep.ts`) so both prepare content identically: a turn
 * replayed from the stored payload is fenced exactly as its first run, and the
 * boundary cannot be skipped on a retry or crash-recovery path.
 */
import type { ChannelId } from "../../../channels/types.js";
import type {
  SlackAppContext,
  SlackAppContextEntity,
} from "../../../daemon/handlers/shared.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import { wrapUntrustedContent } from "../../../security/untrusted-content.js";

/** Slack `app_context` entity types whose `value` is a plain object id. */
const SLACK_APP_CONTEXT_ID_LABELS = new Map<string, string>([
  ["slack#/types/channel_id", "channel"],
  ["slack#/types/canvas_id", "canvas"],
  ["slack#/types/list_id", "list"],
]);

/** The one entity type whose `value` is an object rather than an id string. */
const SLACK_APP_CONTEXT_MESSAGE_TYPE = "slack#/types/message_context";

/**
 * Shape of a Slack-issued object id (channel `C…`/`G…`/`D…`, canvas/list `F…`).
 * The rendered block sits OUTSIDE the `<external_content>` fence, so every
 * value that reaches it must be provably Slack-minted rather than sender-typed
 * text — an entity whose id does not match this is dropped, not rendered.
 */
const SLACK_OBJECT_ID_PATTERN = /^[A-Z][A-Z0-9]{1,31}$/;

/** Slack message `ts`, `<seconds>.<micros>`. Same rationale as the id pattern. */
const SLACK_TS_PATTERN = /^\d{1,19}\.\d{1,19}$/;

/**
 * Cap on rendered entities. Slack sends a handful; the cap bounds how much
 * trusted framing a malformed payload can occupy.
 */
const MAX_APP_CONTEXT_ENTITIES = 8;

/**
 * Render the sender's active Slack context as a `<slack_app_context>` block, or
 * `undefined` when no entity survives validation.
 *
 * The block is deliberately NOT fenced as untrusted content. Every value it
 * carries is a Slack-issued opaque identifier, validated against the patterns
 * above, so there is no sender-authored text in it — and the model has to be
 * able to act on the block (resolving "this channel", "that message") rather
 * than treat it as inert data it must ignore. Nothing derived from a channel
 * name, canvas title, or any other user-writable string may be added here
 * without moving the block inside the fence.
 *
 * The block reaches the model for this turn only: persistence stores
 * `displayContent` (the raw text), so replayed history carries the message
 * without it. That is the intended lifetime — `app_context` describes what the
 * sender had open when they sent the message, not what they have open now.
 */
function renderSlackAppContext(
  entities: readonly SlackAppContextEntity[],
): string | undefined {
  const lines: string[] = [];

  for (const entity of entities) {
    if (lines.length >= MAX_APP_CONTEXT_ENTITIES) {
      break;
    }
    // Entities arrive unvalidated on both paths (an unparsed HTTP body live, a
    // stored payload on replay), so a malformed element is skipped, not thrown on.
    if (!entity || typeof entity !== "object") {
      continue;
    }
    const idLabel = SLACK_APP_CONTEXT_ID_LABELS.get(entity.type);
    if (idLabel) {
      if (
        typeof entity.value === "string" &&
        SLACK_OBJECT_ID_PATTERN.test(entity.value)
      ) {
        lines.push(`${idLabel}: ${entity.value}`);
      }
      continue;
    }
    if (
      entity.type !== SLACK_APP_CONTEXT_MESSAGE_TYPE ||
      !entity.value ||
      typeof entity.value !== "object"
    ) {
      continue;
    }
    const { channelId, messageTs } = entity.value;
    if (
      channelId &&
      messageTs &&
      SLACK_OBJECT_ID_PATTERN.test(channelId) &&
      SLACK_TS_PATTERN.test(messageTs)
    ) {
      lines.push(`message: channel ${channelId} ts ${messageTs}`);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  return [
    "<slack_app_context>",
    "Slack reports these as open for the sender right now. Use the ids to",
    'resolve references like "this channel" or "that message"; when the',
    "reference is still ambiguous, ask rather than guess.",
    "",
    ...lines,
    "</slack_app_context>",
  ].join("\n");
}

export interface PreparedChannelInboundContent {
  /**
   * Model-facing content. For non-guardian senders this is `trimmedContent`
   * fenced in an `<external_content>` boundary; for guardians it is the raw
   * `trimmedContent`.
   */
  content: string;
  /**
   * User-facing display copy (the raw, unwrapped text) persisted alongside the
   * model content so the UI renders what the sender typed rather than the
   * boundary-wrapped form. Set on any Slack turn whose `content` diverges from
   * the raw text — non-guardian turns (which are fenced) and turns carrying a
   * `<slack_app_context>` block. Absent otherwise (persistence falls back to
   * `content`).
   */
  displayContent?: string;
}

/**
 * Fence untrusted (non-guardian) channel content and derive the display copy.
 * Pure and side-effect free so both the live ingress path and the retry sweep
 * can call it and get byte-identical results for the same inputs.
 */
export function prepareChannelInboundContent(params: {
  trimmedContent: string;
  trustClass: TrustContext["trustClass"];
  sourceChannel: ChannelId;
  requesterIdentifier?: string;
  /**
   * The sender's active Slack context, when the inbound event carried one.
   * Ignored for non-Slack channels.
   */
  slackAppContext?: SlackAppContext;
}): PreparedChannelInboundContent {
  const {
    trimmedContent,
    trustClass,
    sourceChannel,
    requesterIdentifier,
    slackAppContext,
  } = params;

  const isGuardian = trustClass === "guardian";
  const messageContent = isGuardian
    ? trimmedContent
    : wrapUntrustedContent(trimmedContent, {
        source: sourceChannel === "slack" ? "slack" : "webhook",
        sourceDetail: requesterIdentifier,
      });

  // Prepended outside the fence — see `renderSlackAppContext` for why that is
  // safe and what would make it unsafe.
  // `Array.isArray` rather than a truthiness check: on the replay path this
  // object comes straight off the stored payload without re-validation.
  const appContextBlock =
    sourceChannel === "slack" && Array.isArray(slackAppContext?.entities)
      ? renderSlackAppContext(slackAppContext.entities)
      : undefined;
  const content = appContextBlock
    ? `${appContextBlock}\n\n${messageContent}`
    : messageContent;

  // Slack persists the raw text as display copy whenever the model content
  // diverges from it, so the transcript shows the sender's words rather than
  // the wrapped form or the prepended context block.
  if (sourceChannel === "slack" && (!isGuardian || appContextBlock)) {
    return { content, displayContent: trimmedContent };
  }
  return { content };
}
