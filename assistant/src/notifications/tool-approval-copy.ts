/**
 * Deterministic, display-ready projection for guardian tool-approval cards.
 *
 * The companion to {@link AccessRequestCardView} in `access-request-copy.ts`:
 * a single pure view model shared by every renderer (the Vellum Surface card,
 * the Slack Card block) plus the flat one-line phrasing used for Telegram
 * `deliveryText` / CLI fallback / clarification. Authoring the assistant-as-actor
 * copy, the source link, and the preview in exactly one place is what keeps the
 * three surfaces from drifting — the asymmetry this replaces had the copy spelled
 * out in three independent builders.
 *
 * Pure: it reads only the facts the producer captured into the payload (see
 * `tool-approval-source.ts`) and never touches the store, so it is exercised
 * directly with `bun test`.
 */

import {
  buildSlackMessagePermalink,
  isSlackDmConversation,
} from "./access-request-copy.js";
import type { LenientToolApprovalPayload } from "./guardian-question-mode.js";
import {
  nonEmpty,
  sanitizeIdentityField,
  sanitizeMessagePreview,
} from "./notification-utils.js";

/**
 * The facts a tool-approval card is projected from — the subset of the parsed
 * guardian payload the view reads. Derived from the Zod-inferred payload type
 * (not hand-declared) so it cannot drift from the schema the producers write
 * and the renderers parse; callers pass the parsed payload directly.
 */
export type ToolApprovalCardInput = Pick<
  LenientToolApprovalPayload,
  | "toolName"
  | "requesterIdentifier"
  | "sourceChannel"
  | "conversationExternalId"
  | "channelName"
  | "messageTs"
  | "messagePreview"
  | "commandPreview"
  | "requestId"
>;

/**
 * Display-ready projection of a tool-approval request, shared by every renderer.
 * Carries the sanitized, pre-computed facts each surface needs plus the
 * authored copy lines, so projection lives in exactly one place. Renderers lay
 * these out in their channel-native shape without re-deriving them.
 */
export interface ToolApprovalCardView {
  toolName: string;
  /** Sanitized requester display name, or `undefined` (self / no inbound trigger). */
  actorDisplayName: string | undefined;
  sourceChannel: string | undefined;
  conversationExternalId: string | undefined;
  channelName: string | undefined;
  /** Whether the source Slack conversation is a DM. */
  isSlackDm: boolean;
  /** Exact-message Slack permalink — present only for a slack source with channel + ts. */
  messagePermalink: string | undefined;
  /** Sanitized triggering-message preview (the requester's words). */
  messagePreview: string | undefined;
  /** Redacted tool-input summary (what the tool will do). */
  commandPreview: string | undefined;
  requestId: string | undefined;
  /** Assistant-as-actor primary line, e.g. `Assistant wants to use "web_fetch"`. */
  titleLine: string;
  /**
   * Connective line attributing the action to the inbound message, e.g.
   * `in response to Noa Flaherty's message in #general`. `undefined` when there
   * is no inbound trigger (self / scheduled / voice), in which case renderers
   * fall back to a generic subtitle.
   */
  connectiveLine: string | undefined;
  /**
   * Flat one-line sentence (title + connective) for non-card surfaces —
   * Telegram `deliveryText`, CLI fallback, clarification. The single phrasing
   * source of truth, so every surface says the same thing.
   */
  sentence: string;
}

const FALLBACK_TOOL_NAME = "unknown tool";

/** Channels that carry an inbound text message worth attributing in the connective. */
function hasInboundTextMessage(sourceChannel: string | undefined): boolean {
  // Voice has a caller but no "message"; scheduled/self/proactive have no
  // requester at all (handled by the missing display name). Everything else
  // that reaches a tool-grant escalation came from an inbound text message.
  return sourceChannel != null && sourceChannel !== "phone";
}

/** The channel token shown inside the connective, or `undefined` to omit it. */
function resolveConnectiveChannel(
  view: Pick<
    ToolApprovalCardView,
    "sourceChannel" | "conversationExternalId" | "channelName" | "isSlackDm"
  >,
): string | undefined {
  if (
    view.sourceChannel !== "slack" ||
    !view.conversationExternalId ||
    view.isSlackDm
  ) {
    return undefined;
  }
  return `#${view.channelName ?? view.conversationExternalId}`;
}

/**
 * Project a parsed tool-approval payload into display-ready card facts + the
 * authored assistant-as-actor copy. Pure — every renderer calls this so the
 * copy, source link, and preview are authored exactly once.
 */
export function buildToolApprovalCardView(
  input: ToolApprovalCardInput,
): ToolApprovalCardView {
  const toolName = nonEmpty(input.toolName) ?? FALLBACK_TOOL_NAME;

  const rawActor = nonEmpty(input.requesterIdentifier);
  const actorDisplayName = rawActor
    ? sanitizeIdentityField(rawActor)
    : undefined;

  const sourceChannel = nonEmpty(input.sourceChannel);
  const conversationExternalId = nonEmpty(input.conversationExternalId);
  const channelName = nonEmpty(input.channelName);
  const messageTs = nonEmpty(input.messageTs);

  const isSlackDm =
    sourceChannel === "slack" && conversationExternalId != null
      ? isSlackDmConversation(conversationExternalId)
      : false;

  const messagePermalink =
    sourceChannel === "slack" && conversationExternalId && messageTs
      ? buildSlackMessagePermalink(conversationExternalId, messageTs)
      : undefined;

  const rawPreview = nonEmpty(input.messagePreview);
  const messagePreview = rawPreview
    ? sanitizeMessagePreview(rawPreview) || undefined
    : undefined;

  const commandPreview = nonEmpty(input.commandPreview);

  // ── Authored copy (the single phrasing source of truth) ──────────────────
  const titleLine = `Assistant wants to use "${toolName}"`;

  let connectiveLine: string | undefined;
  if (actorDisplayName && hasInboundTextMessage(sourceChannel)) {
    const channelToken = resolveConnectiveChannel({
      sourceChannel,
      conversationExternalId,
      channelName,
      isSlackDm,
    });
    connectiveLine = channelToken
      ? `in response to ${actorDisplayName}'s message in ${channelToken}`
      : `in response to ${actorDisplayName}'s message`;
  }

  const sentence = connectiveLine
    ? `${titleLine} ${connectiveLine}.`
    : `${titleLine}.`;

  return {
    toolName,
    actorDisplayName,
    sourceChannel,
    conversationExternalId,
    channelName,
    isSlackDm,
    messagePermalink,
    messagePreview,
    commandPreview,
    requestId: nonEmpty(input.requestId),
    titleLine,
    connectiveLine,
    sentence,
  };
}
