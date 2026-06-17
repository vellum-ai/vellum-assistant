/**
 * Unified resolver + renderer for guardian approval card seed content.
 *
 * `contextPayload` is resolved once into a typed {@link ApprovalCardData}
 * discriminated union, then rendered into Surface `[ui_surface, text]` blocks
 * via the shared {@link buildApprovalCardBlocks}. Both access-request and
 * tool-approval notifications flow through this single entry point so the
 * raw payload is parsed and shaped to card data in one place rather than
 * independently across the copy modules.
 *
 * The Surface card data shape matches `CardSurfaceData` from
 * `daemon/message-types/surfaces.ts`. Actions use the canonical
 * `apr:<requestId>:<action>` callback format consumed by
 * `surface-action-routes.ts` → `processGuardianDecision`.
 */

import {
  buildAccessRequestContractText,
  buildAccessRequestWarnings,
  buildSlackMessagePermalink,
  isSlackDmConversation,
  parseAccessRequestPayload,
} from "./access-request-copy.js";
import {
  type ApprovalCardParams,
  buildApprovalCardBlocks,
} from "./approval-card-builder.js";
import {
  buildGuardianRequestCodeInstruction,
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

// ── Typed card data ─────────────────────────────────────────────────────────

/** Resolved card data for an access-request notification. */
export interface AccessRequestCardData {
  kind: "access_request";
  card: ApprovalCardParams;
}

/** Resolved card data for a tool-approval / tool-grant notification. */
export interface ToolApprovalCardData {
  kind: "tool_approval";
  card: ApprovalCardParams;
}

/**
 * Channel-agnostic approval card content, resolved once from `contextPayload`.
 * The discriminant `kind` lets consumers branch on the approval type without
 * re-parsing the payload.
 */
export type ApprovalCardData = AccessRequestCardData | ToolApprovalCardData;

// ── Access-request resolution ────────────────────────────────────────────────

/** Shape the parsed access-request payload into card params. */
function resolveAccessRequestCard(
  payload: Record<string, unknown>,
): ApprovalCardParams {
  const p = parseAccessRequestPayload(payload);

  const rawName = nonEmpty(p.actorDisplayName) ?? nonEmpty(p.senderIdentifier);
  const displayName = rawName ? sanitizeIdentityField(rawName) : "Someone";

  const metadata: Array<{ label: string; value: string }> = [];

  if (p.actorUsername) {
    metadata.push({
      label: "Username",
      value: `@${sanitizeIdentityField(p.actorUsername)}`,
    });
  }

  if (p.sourceChannel === "slack" && p.conversationExternalId) {
    const isDm = isSlackDmConversation(p.conversationExternalId);
    metadata.push({
      label: "Source",
      value: isDm
        ? "Slack — Direct message"
        : `Slack — #${p.conversationExternalId}`,
    });
  } else if (p.sourceChannel) {
    metadata.push({ label: "Source", value: p.sourceChannel });
  }

  const warnings = buildAccessRequestWarnings(p);
  const bodyParts: string[] = [];

  if (p.messagePreview) {
    bodyParts.push(`> "${sanitizeMessagePreview(p.messagePreview)}"`);
  }
  for (const w of warnings) {
    bodyParts.push(`⚠️ ${w}`);
  }
  if (p.sourceChannel === "slack" && p.conversationExternalId && p.messageTs) {
    const permalink = buildSlackMessagePermalink(
      p.conversationExternalId,
      p.messageTs,
    );
    bodyParts.push(`[View message](${permalink})`);
  }

  const body =
    bodyParts.length > 0
      ? bodyParts.join("\n\n")
      : "No additional context available.";

  return {
    surfaceIdPrefix: "access-request",
    cardTitle: "Access Request",
    requesterName: displayName,
    subtitle: "Requesting access to the assistant",
    body,
    metadata,
    requestId: p.requestId,
    fallbackText: buildAccessRequestContractText(payload),
  };
}

// ── Tool-approval resolution ─────────────────────────────────────────────────

/**
 * Determine whether a typed guardian.question payload represents a tool
 * approval (as opposed to a free-text answer). Uses the canonical mode
 * resolver in `guardian-question-mode.ts` — the single source of truth
 * for the requestKind → instructionMode mapping.
 */
function isToolApprovalPayload(payload: GuardianQuestionPayload): boolean {
  const { mode } = resolveGuardianInstructionModeFromPayload(payload);
  return mode === "approval" && payload.requestKind !== "access_request";
}

/**
 * Lenient approval detection for partially-constructed payloads that don't
 * satisfy the strict discriminated union schema.
 */
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

/** Shape a tool-approval/grant payload (strict or lenient) into card params. */
function extractToolApprovalCard(
  p: GuardianQuestionPayload | LenientToolApprovalPayload,
): ApprovalCardParams {
  const toolName =
    ("toolName" in p ? nonEmpty(p.toolName) : undefined) ?? "unknown tool";
  const rawRequester = nonEmpty(p.requesterIdentifier);
  const requester = rawRequester
    ? sanitizeIdentityField(rawRequester)
    : "Someone";

  const isGrant = p.requestKind === "tool_grant_request";

  const metadata: Array<{ label: string; value: string }> = [];
  metadata.push({ label: "Tool", value: toolName });
  const sourceChannel = nonEmpty(p.sourceChannel);
  if (sourceChannel) {
    metadata.push({ label: "Source", value: sourceChannel });
  }

  const body = p.questionText
    ? `> ${p.questionText}`
    : "No additional context available.";

  // Fallback text with request-code instructions for older clients.
  const baseFallback =
    p.questionText ?? `${requester} is requesting approval to use ${toolName}`;
  let fallbackText = baseFallback;
  const requestCode = nonEmpty(p.requestCode);
  if (requestCode) {
    const modeResolution = resolveGuardianInstructionModeFromFields(
      p.requestKind,
      "toolName" in p ? (p.toolName ?? undefined) : undefined,
    );
    const mode = modeResolution?.mode ?? "approval";
    const instruction = buildGuardianRequestCodeInstruction(
      requestCode.trim().toUpperCase(),
      mode,
    );
    fallbackText = `${baseFallback}\n\n${instruction}`;
  }

  return {
    surfaceIdPrefix: "tool-approval",
    cardTitle: isGrant ? "Tool Grant Request" : "Tool Approval",
    requesterName: requester,
    subtitle: isGrant
      ? "Requesting permission to use this tool"
      : "Requesting approval to run this tool",
    body,
    metadata,
    requestId: nonEmpty(p.requestId),
    fallbackText,
  };
}

/**
 * Resolve a guardian.question payload into tool-approval card params, or
 * `null` when it does not represent a tool approval.
 *
 * Tries strict Zod parsing first (full discriminated union), then falls back
 * to lenient field extraction so cards still render when optional fields are
 * absent.
 */
function resolveToolApprovalCard(
  payload: Record<string, unknown>,
): ApprovalCardParams | null {
  const strict = parseGuardianQuestionPayload(payload);
  if (strict) {
    if (!isToolApprovalPayload(strict)) return null;
    return extractToolApprovalCard(strict);
  }

  const lenient = LenientToolApprovalPayloadSchema.safeParse(payload);
  if (!lenient.success) return null;
  if (!isLenientToolApproval(lenient.data)) return null;
  return extractToolApprovalCard(lenient.data);
}

// ── Unified dispatcher + renderer ────────────────────────────────────────────

/**
 * Resolve a notification's `contextPayload` into typed {@link ApprovalCardData}
 * based on its source event, or `null` when the signal does not carry a
 * renderable approval card. Single entry point so each consumer (copy
 * composition, decision engine) shapes the payload identically.
 */
export function resolveApprovalCardData(
  sourceEventName: string,
  contextPayload: Record<string, unknown> | undefined,
): ApprovalCardData | null {
  if (!contextPayload) return null;

  if (sourceEventName === "ingress.access_request") {
    return {
      kind: "access_request",
      card: resolveAccessRequestCard(contextPayload),
    };
  }

  if (sourceEventName === "guardian.question") {
    const card = resolveToolApprovalCard(contextPayload);
    return card ? { kind: "tool_approval", card } : null;
  }

  return null;
}

/** Render resolved approval card data into Surface `[ui_surface, text]` blocks. */
export function renderApprovalCardData(data: ApprovalCardData): unknown[] {
  return buildApprovalCardBlocks(data.card);
}

// ── Public seed-content builders ─────────────────────────────────────────────

/**
 * Build structured content blocks for an access-request notification seed
 * message. Produces a `ui_surface` card block that the web/macOS/iOS apps
 * render as an interactive card via `SurfaceRouter → CardSurface`, plus a
 * plain-text fallback block for search, CLI display, and backward-compatible
 * clients that don't support surfaces.
 */
export function buildAccessRequestSeedContentBlocks(
  payload: Record<string, unknown>,
): unknown[] {
  return renderApprovalCardData({
    kind: "access_request",
    card: resolveAccessRequestCard(payload),
  });
}

/**
 * Build structured content blocks for a tool approval/grant notification seed
 * message. Returns `null` when the payload does not represent a tool approval.
 *
 * Accepts both strict `GuardianQuestionPayload` (Zod-validated) and raw
 * `Record<string, unknown>` payloads. For raw payloads, attempts strict
 * parsing first, then falls back to lenient field extraction so cards
 * still render when optional fields are absent.
 */
export function buildToolApprovalSeedContentBlocks(
  payload: GuardianQuestionPayload,
): unknown[] | null;
export function buildToolApprovalSeedContentBlocks(
  payload: Record<string, unknown>,
): unknown[] | null;
export function buildToolApprovalSeedContentBlocks(
  payload: GuardianQuestionPayload | Record<string, unknown>,
): unknown[] | null {
  const data = resolveApprovalCardData(
    "guardian.question",
    payload as Record<string, unknown>,
  );
  return data ? renderApprovalCardData(data) : null;
}
