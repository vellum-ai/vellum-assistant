/**
 * Surface card renderer for guardian approval notifications.
 *
 * Produces `[ui_surface, text]` block pairs from `ApprovalCardData`
 * (the channel-agnostic card content resolved by `approval-card-data.ts`).
 * The `ui_surface` block renders as an interactive card with Approve/Reject
 * buttons in the Vellum web/macOS/iOS apps. The `text` block provides a
 * plain-text fallback for search, CLI display, and backward-compatible
 * clients.
 *
 * Surface card data shape: `CardSurfaceData` from
 * `daemon/message-types/surfaces.ts` — `{ title, subtitle, body, metadata }`.
 * Actions use the canonical `apr:<requestId>:<action>` callback format
 * consumed by `surface-action-routes.ts` → `processGuardianDecision`.
 */

import { buildAccessRequestContractText } from "./access-request-copy.js";
import type {
  AccessRequestCardData,
  ApprovalCardData,
  ToolApprovalCardData,
} from "./approval-card-data.js";
import {
  buildGuardianRequestCodeInstruction,
  resolveGuardianInstructionModeFromFields,
} from "./guardian-question-mode.js";

// ── Surface block builder (shared structure) ────────────────────────────────

interface SurfaceCardParams {
  surfaceIdPrefix: string;
  cardTitle: string;
  requesterName: string;
  subtitle: string;
  body: string;
  metadata: Array<{ label: string; value: string }>;
  requestId: string | undefined;
  fallbackText: string;
}

function buildSurfaceBlocks(params: SurfaceCardParams): unknown[] {
  const actions = params.requestId
    ? [
        {
          id: `apr:${params.requestId}:approve_once`,
          label: "Approve",
          style: "primary",
        },
        {
          id: `apr:${params.requestId}:reject`,
          label: "Reject",
          style: "destructive",
        },
      ]
    : undefined;

  const surfaceBlock = {
    type: "ui_surface" as const,
    surfaceId: `${params.surfaceIdPrefix}-${params.requestId ?? "unknown"}`,
    surfaceType: "card" as const,
    title: params.cardTitle,
    data: {
      title: params.requesterName,
      subtitle: params.subtitle,
      body: params.body,
      metadata: params.metadata,
    },
    ...(actions ? { actions } : {}),
  };

  const textBlock = {
    type: "text" as const,
    text: params.fallbackText,
  };

  return [surfaceBlock, textBlock];
}

// ── Public renderers ────────────────────────────────────────────────────────

/**
 * Render `ApprovalCardData` as Surface card seed content blocks.
 *
 * Dispatches to the appropriate renderer based on `data.kind`.
 */
export function renderSurfaceApprovalCard(data: ApprovalCardData): unknown[] {
  if (data.kind === "access_request") {
    return renderAccessRequestSurface(data);
  }
  return renderToolApprovalSurface(data);
}

// ── Tool approval → Surface ─────────────────────────────────────────────────

function renderToolApprovalSurface(data: ToolApprovalCardData): unknown[] {
  const isGrant = data.kind === "tool_grant";

  const metadata: Array<{ label: string; value: string }> = [];
  metadata.push({ label: "Tool", value: data.toolName });
  if (data.sourceChannel) {
    metadata.push({ label: "Source", value: data.sourceChannel });
  }

  const body = data.questionText
    ? `> ${data.questionText}`
    : "No additional context available.";

  const baseFallback =
    data.questionText ??
    `${data.requester} is requesting approval to use ${data.toolName}`;
  let fallbackText = baseFallback;
  if (data.requestCode) {
    const requestKind = isGrant ? "tool_grant_request" : "tool_approval";
    const modeResolution = resolveGuardianInstructionModeFromFields(
      requestKind,
      data.toolName,
    );
    const mode = modeResolution?.mode ?? "approval";
    const instruction = buildGuardianRequestCodeInstruction(
      data.requestCode.trim().toUpperCase(),
      mode,
    );
    fallbackText = `${baseFallback}\n\n${instruction}`;
  }

  return buildSurfaceBlocks({
    surfaceIdPrefix: "tool-approval",
    cardTitle: isGrant ? "Tool Grant Request" : "Tool Approval",
    requesterName: data.requester,
    subtitle: isGrant
      ? "Requesting permission to use this tool"
      : "Requesting approval to run this tool",
    body,
    metadata,
    requestId: data.requestId,
    fallbackText,
  });
}

// ── Access request → Surface ────────────────────────────────────────────────

function renderAccessRequestSurface(data: AccessRequestCardData): unknown[] {
  const metadata: Array<{ label: string; value: string }> = [];

  if (data.username) {
    metadata.push({ label: "Username", value: `@${data.username}` });
  }

  if (data.sourceChannel === "slack" && data.conversationExternalId) {
    metadata.push({
      label: "Source",
      value: data.isSlackDm
        ? "Slack — Direct message"
        : `Slack — #${data.conversationExternalId}`,
    });
  } else if (data.sourceChannel) {
    metadata.push({ label: "Source", value: data.sourceChannel });
  }

  const bodyParts: string[] = [];
  if (data.messagePreview) {
    bodyParts.push(`> "${data.messagePreview}"`);
  }
  for (const w of data.warnings) {
    bodyParts.push(`⚠️ ${w}`);
  }
  if (data.messagePermalink) {
    bodyParts.push(`[View message](${data.messagePermalink})`);
  }

  const body =
    bodyParts.length > 0
      ? bodyParts.join("\n\n")
      : "No additional context available.";

  return buildSurfaceBlocks({
    surfaceIdPrefix: "access-request",
    cardTitle: "Access Request",
    requesterName: data.displayName,
    subtitle: "Requesting access to the assistant",
    body,
    metadata,
    requestId: data.requestId,
    fallbackText: buildAccessRequestFallbackText(data),
  });
}

/**
 * Build plain-text fallback for access request Surface cards.
 *
 * Re-uses `buildAccessRequestContractText` which needs the raw payload.
 * Since we've already parsed the payload into `AccessRequestCardData`,
 * we reconstruct the minimal payload shape it expects.
 */
function buildAccessRequestFallbackText(data: AccessRequestCardData): string {
  // Reconstruct the payload shape that buildAccessRequestContractText expects.
  const payload: Record<string, unknown> = {
    requestId: data.requestId,
    requestCode: data.requestCode,
    sourceChannel: data.sourceChannel,
    conversationExternalId: data.conversationExternalId,
    actorExternalId: data.externalId,
    actorDisplayName:
      data.displayName !== "Someone" ? data.displayName : undefined,
    actorUsername: data.username,
    senderIdentifier: data.senderIdentifier,
    guardianResolutionSource: data.guardianResolutionSource,
    messagePreview: data.messagePreview,
    messageTs: data.messageTs,
  };
  return buildAccessRequestContractText(payload);
}
