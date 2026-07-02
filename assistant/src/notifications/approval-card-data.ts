/**
 * Unified resolver + renderer for guardian approval card seed content.
 *
 * `contextPayload` resolves into a typed {@link ApprovalCardData} discriminated
 * union, then renders into Surface `[ui_surface, text]` blocks via the shared
 * {@link buildApprovalCardBlocks}. Access-request and tool-approval
 * notifications share this single entry point, which parses and shapes the raw
 * payload into card data.
 *
 * The Surface card data shape matches `CardSurfaceData` from
 * `daemon/message-types/surfaces.ts`. Actions use the canonical
 * `apr:<requestId>:<action>` callback format consumed by
 * `surface-action-routes.ts` → `processGuardianDecision`.
 */

import {
  buildAccessRequestCardView,
  buildAccessRequestContractText,
  buildIntroductionActionsForPayload,
  parseAccessRequestPayload,
} from "./access-request-copy.js";
import {
  type ApprovalCardActionOption,
  type ApprovalCardBlock,
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
import { nonEmpty, sanitizeIdentityField } from "./notification-utils.js";

// ── Surface ids ──────────────────────────────────────────────────────────────

/**
 * `surfaceId` prefixes for the in-app approval cards. The full id is
 * `${prefix}-${requestId}` (see {@link buildApprovalCardBlocks}). These are the
 * single source of truth for the prefix, shared by the card builders below and
 * by {@link approvalCardSurfaceId} so the withdrawal path can recompute the id.
 */
const ACCESS_REQUEST_SURFACE_PREFIX = "access-request";
const TOOL_APPROVAL_SURFACE_PREFIX = "tool-approval";

/**
 * Resolve the `ui_surface` id for a guardian request's in-app approval card
 * from its kind, or `null` for kinds that never render an approval card.
 *
 * The card is rendered once at notification time; when the request is later
 * resolved from a different surface the withdrawal path recomputes the id here
 * to complete that card. Keeping this beside the builders ensures the two stay
 * in lockstep.
 */
export function approvalCardSurfaceId(
  kind: string,
  requestId: string,
): string | null {
  switch (kind) {
    case "access_request":
      return `${ACCESS_REQUEST_SURFACE_PREFIX}-${requestId}`;
    case "tool_approval":
    case "tool_grant_request":
    case "pending_question":
      return `${TOOL_APPROVAL_SURFACE_PREFIX}-${requestId}`;
    default:
      return null;
  }
}

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

/** Shape the parsed access-request payload into card params via the view model. */
function resolveAccessRequestCard(
  payload: Record<string, unknown>,
): ApprovalCardParams {
  const parsed = parseAccessRequestPayload(payload);
  const view = buildAccessRequestCardView(parsed);

  // Signal-driven introduction actions: the first action is the emphasized
  // default; Block is destructive; the rest stay secondary.
  const actions: ApprovalCardActionOption[] =
    buildIntroductionActionsForPayload(parsed).map((action, index) => ({
      id: action.id,
      label: action.label,
      style:
        action.id === "block"
          ? ("destructive" as const)
          : index === 0
            ? ("primary" as const)
            : ("secondary" as const),
    }));

  const metadata: Array<{ label: string; value: string }> = [];

  if (view.username) {
    metadata.push({
      label: "Username",
      value: `@${view.username}`,
    });
  }

  if (view.sourceChannel === "slack" && view.conversationExternalId) {
    metadata.push({
      label: "Source",
      value: view.isSlackDm
        ? "Slack — Direct message"
        : `Slack — #${view.conversationExternalId}`,
    });
  } else if (view.sourceChannel) {
    metadata.push({ label: "Source", value: view.sourceChannel });
  }

  const bodyParts: string[] = [];

  if (view.messagePreview) {
    bodyParts.push(`> "${view.messagePreview}"`);
  }
  for (const w of view.warnings) {
    bodyParts.push(`⚠️ ${w}`);
  }
  if (view.messagePermalink) {
    bodyParts.push(`[View message](${view.messagePermalink})`);
  }

  const body =
    bodyParts.length > 0
      ? bodyParts.join("\n\n")
      : "No additional context available.";

  return {
    surfaceIdPrefix: ACCESS_REQUEST_SURFACE_PREFIX,
    cardTitle: "Access Request",
    requesterName: view.displayName,
    subtitle: "Requesting access to the assistant",
    body,
    metadata,
    requestId: view.requestId,
    actions,
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
  if (!modeResolution) {
    return false;
  }
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
    surfaceIdPrefix: TOOL_APPROVAL_SURFACE_PREFIX,
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
    if (!isToolApprovalPayload(strict)) {
      return null;
    }
    return extractToolApprovalCard(strict);
  }

  const lenient = LenientToolApprovalPayloadSchema.safeParse(payload);
  if (!lenient.success) {
    return null;
  }
  if (!isLenientToolApproval(lenient.data)) {
    return null;
  }
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
  if (!contextPayload) {
    return null;
  }

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
export function renderApprovalCardData(
  data: ApprovalCardData,
): ApprovalCardBlock[] {
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
): ApprovalCardBlock[] {
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
): ApprovalCardBlock[] | null;
export function buildToolApprovalSeedContentBlocks(
  payload: Record<string, unknown>,
): ApprovalCardBlock[] | null;
export function buildToolApprovalSeedContentBlocks(
  payload: GuardianQuestionPayload | Record<string, unknown>,
): ApprovalCardBlock[] | null {
  const data = resolveApprovalCardData(
    "guardian.question",
    payload as Record<string, unknown>,
  );
  return data ? renderApprovalCardData(data) : null;
}
