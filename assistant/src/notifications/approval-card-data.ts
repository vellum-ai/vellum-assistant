/**
 * Channel-agnostic approval card data model and resolver.
 *
 * `resolveApprovalCardData()` parses a notification payload once and
 * returns a discriminated union (`ApprovalCardData`) carrying every
 * field that any renderer (Surface cards, Slack Card blocks, Telegram
 * Rich Messages, etc.) needs to display an approval notification.
 *
 * Renderers are pure functions that take `ApprovalCardData` and produce
 * channel-native blocks — no payload parsing, no business logic.
 *
 * Zod schemas: https://zod.dev/?id=basic-usage
 * Slack Card block: https://docs.slack.dev/reference/block-kit/blocks/card-block
 */

import {
  AccessRequestPayloadSchema,
  buildAccessRequestWarnings,
  buildSlackMessagePermalink,
  isSlackDmConversation,
  type ParsedAccessRequestPayload,
} from "./access-request-copy.js";
import {
  type GuardianQuestionPayload,
  type LenientToolApprovalPayload,
  LenientToolApprovalPayloadSchema,
  parseGuardianQuestionPayload,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianInstructionModeFromPayload,
} from "./guardian-question-mode.js";
import {
  nonEmpty,
  sanitizeIdentityField,
  sanitizeMessagePreview,
} from "./notification-utils.js";

// ── Card data types ─────────────────────────────────────────────────────────

export interface ToolApprovalCardData {
  kind: "tool_approval" | "tool_grant";
  toolName: string;
  requester: string;
  questionText: string | undefined;
  sourceChannel: string | undefined;
  requestId: string | undefined;
  requestCode: string | undefined;
}

export interface AccessRequestCardData {
  kind: "access_request";
  /** Sanitized display name (actorDisplayName ?? senderIdentifier). */
  displayName: string;
  /** Sanitized username (without `@` prefix). */
  username: string | undefined;
  /** Sanitized external ID. */
  externalId: string | undefined;
  senderIdentifier: string | undefined;
  sourceChannel: string | undefined;
  conversationExternalId: string | undefined;
  messageTs: string | undefined;
  /** Sanitized message preview text (no quoting/wrapping applied). */
  messagePreview: string | undefined;
  warnings: string[];
  guardianResolutionSource: string | undefined;
  requestId: string | undefined;
  requestCode: string | undefined;
  /** Whether the Slack conversation is a DM. */
  isSlackDm: boolean;
  /** Slack permalink (when sourceChannel is slack and conversationExternalId + messageTs exist). */
  messagePermalink: string | undefined;
  /** Raw fields preserved for fallback text generation via buildAccessRequestContractText. */
  previousMemberStatus: string | undefined;
  isStranger: boolean | undefined;
  isRestricted: boolean | undefined;
}

export type ApprovalCardData = ToolApprovalCardData | AccessRequestCardData;

// ── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve channel-agnostic approval card data from a notification payload.
 *
 * Returns `undefined` when the payload does not represent an approval card.
 * Each field is pre-sanitized so downstream renderers can use values directly.
 */
export function resolveApprovalCardData(
  sourceEventName: string,
  contextPayload: Record<string, unknown> | undefined,
): ApprovalCardData | undefined {
  if (!contextPayload) return undefined;

  if (sourceEventName === "ingress.access_request") {
    return resolveAccessRequestCardData(contextPayload);
  }

  if (sourceEventName === "guardian.question") {
    return resolveToolApprovalCardData(contextPayload);
  }

  return undefined;
}

// ── Tool approval resolver ──────────────────────────────────────────────────

function resolveToolApprovalCardData(
  payload: Record<string, unknown>,
): ToolApprovalCardData | undefined {
  // Strict Zod parse first.
  const strict = parseGuardianQuestionPayload(payload);
  if (strict) {
    if (!isToolApprovalPayload(strict)) return undefined;
    return extractToolApprovalFields(strict);
  }

  // Lenient fallback for partially-constructed payloads.
  const lenient = LenientToolApprovalPayloadSchema.safeParse(payload);
  if (!lenient.success) return undefined;
  if (!isLenientToolApproval(lenient.data)) return undefined;
  return extractToolApprovalFields(lenient.data);
}

function isToolApprovalPayload(payload: GuardianQuestionPayload): boolean {
  const { mode } = resolveGuardianInstructionModeFromPayload(payload);
  return mode === "approval" && payload.requestKind !== "access_request";
}

function isLenientToolApproval(payload: LenientToolApprovalPayload): boolean {
  const modeResolution = resolveGuardianInstructionModeFromFields(
    payload.requestKind,
    payload.toolName,
  );
  if (!modeResolution) return false;
  return (
    modeResolution.mode === "approval" &&
    payload.requestKind !== "access_request"
  );
}

function extractToolApprovalFields(
  p: GuardianQuestionPayload | LenientToolApprovalPayload,
): ToolApprovalCardData {
  const toolName =
    ("toolName" in p ? nonEmpty(p.toolName) : undefined) ?? "unknown tool";
  const rawRequester = nonEmpty(p.requesterIdentifier);
  const requester = rawRequester
    ? sanitizeIdentityField(rawRequester)
    : "Someone";

  return {
    kind:
      p.requestKind === "tool_grant_request" ? "tool_grant" : "tool_approval",
    toolName,
    requester,
    questionText: nonEmpty(p.questionText),
    sourceChannel: nonEmpty(p.sourceChannel),
    requestId: nonEmpty(p.requestId),
    requestCode: nonEmpty(p.requestCode),
  };
}

// ── Access request resolver ─────────────────────────────────────────────────

function resolveAccessRequestCardData(
  payload: Record<string, unknown>,
): AccessRequestCardData {
  const p: ParsedAccessRequestPayload =
    AccessRequestPayloadSchema.parse(payload);

  const rawName = nonEmpty(p.actorDisplayName) ?? nonEmpty(p.senderIdentifier);
  const displayName = rawName ? sanitizeIdentityField(rawName) : "Someone";
  const rawUsername = nonEmpty(p.actorUsername);
  const username = rawUsername ? sanitizeIdentityField(rawUsername) : undefined;
  const rawExternalId = nonEmpty(p.actorExternalId);
  const externalId = rawExternalId
    ? sanitizeIdentityField(rawExternalId)
    : undefined;
  const rawPreview = nonEmpty(p.messagePreview);
  const messagePreview = rawPreview
    ? sanitizeMessagePreview(rawPreview) || undefined
    : undefined;

  const sourceChannel = nonEmpty(p.sourceChannel);
  const conversationExternalId = nonEmpty(p.conversationExternalId);
  const messageTs = nonEmpty(p.messageTs);

  const isSlackDm =
    sourceChannel === "slack" && conversationExternalId != null
      ? isSlackDmConversation(conversationExternalId)
      : false;

  const messagePermalink =
    sourceChannel === "slack" && conversationExternalId && messageTs
      ? buildSlackMessagePermalink(conversationExternalId, messageTs)
      : undefined;

  return {
    kind: "access_request",
    displayName,
    username,
    externalId,
    senderIdentifier: nonEmpty(p.senderIdentifier),
    sourceChannel,
    conversationExternalId,
    messageTs,
    messagePreview,
    warnings: buildAccessRequestWarnings(p),
    guardianResolutionSource: nonEmpty(p.guardianResolutionSource),
    requestId: nonEmpty(p.requestId),
    requestCode: nonEmpty(p.requestCode),
    isSlackDm,
    messagePermalink,
    previousMemberStatus: nonEmpty(p.previousMemberStatus),
    isStranger: p.isStranger,
    isRestricted: p.isRestricted,
  };
}
