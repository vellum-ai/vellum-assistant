/**
 * Deterministic helpers for building guardian-facing tool-approval copy.
 *
 * Produces Surface card seed content blocks for `tool_approval`,
 * `tool_grant_request`, and voice/call `pending_question` (with `toolName`)
 * guardian questions, enabling Approve/Reject buttons in the Vellum in-app
 * channel (web/macOS/iOS).
 */

import { sanitizeIdentityField } from "./access-request-copy.js";
import { buildApprovalCardBlocks } from "./approval-card-builder.js";
import {
  buildGuardianRequestCodeInstruction,
  resolveGuardianQuestionInstructionMode,
} from "./guardian-question-mode.js";

// ── Local string utility ────────────────────────────────────────────────────
// Duplicated from copy-composer to avoid a circular import
// (copy-composer imports this module).

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Typed payload reader ────────────────────────────────────────────────────

interface ParsedToolApprovalPayload {
  requestId?: string;
  requestCode?: string;
  requestKind?: string;
  toolName?: string;
  questionText?: string;
  sourceChannel?: string;
  requesterIdentifier?: string;
}

function parseToolApprovalPayload(
  payload: Record<string, unknown>,
): ParsedToolApprovalPayload {
  const s = (key: string): string | undefined => {
    const v = payload[key];
    return typeof v === "string" ? v : undefined;
  };
  return {
    requestId: s("requestId"),
    requestCode: s("requestCode"),
    requestKind: s("requestKind"),
    toolName: s("toolName"),
    questionText: s("questionText"),
    sourceChannel: s("sourceChannel"),
    requesterIdentifier: s("requesterIdentifier"),
  };
}

// ── Seed content blocks (Surface-based rendering) ───────────────────────────

/**
 * Build structured content blocks for a tool approval/grant notification seed
 * message. Returns `null` when the payload does not represent a tool approval.
 *
 * Covers `tool_approval`, `tool_grant_request`, and `pending_question` with a
 * `toolName` (voice/call tool approvals persisted as pending questions — see
 * `guardian-question-mode.ts` REQUEST_KIND_MODE_CONFIG).
 */
export function buildToolApprovalSeedContentBlocks(
  payload: Record<string, unknown>,
): unknown[] | null {
  const p = parseToolApprovalPayload(payload);

  const isToolApproval =
    p.requestKind === "tool_approval" ||
    p.requestKind === "tool_grant_request" ||
    (p.requestKind === "pending_question" && !!nonEmpty(p.toolName));

  if (!isToolApproval) {
    return null;
  }

  const toolName = nonEmpty(p.toolName) ?? "unknown tool";
  const rawRequester = nonEmpty(p.requesterIdentifier);
  const requester = rawRequester
    ? sanitizeIdentityField(rawRequester)
    : "Someone";

  const isGrant = p.requestKind === "tool_grant_request";

  const metadata: Array<{ label: string; value: string }> = [];
  metadata.push({ label: "Tool", value: toolName });
  if (p.sourceChannel) {
    metadata.push({ label: "Source", value: p.sourceChannel });
  }

  const body = p.questionText
    ? `> ${p.questionText}`
    : "No additional context available.";

  // Build fallback text with request-code instructions for older clients.
  const baseFallback =
    p.questionText ?? `${requester} is requesting approval to use ${toolName}`;
  let fallbackText = baseFallback;
  if (p.requestCode) {
    const modeResolution = resolveGuardianQuestionInstructionMode(payload);
    const instruction = buildGuardianRequestCodeInstruction(
      p.requestCode.trim().toUpperCase(),
      modeResolution.mode,
    );
    fallbackText = `${baseFallback}\n\n${instruction}`;
  }

  return buildApprovalCardBlocks({
    surfaceIdPrefix: "tool-approval",
    cardTitle: isGrant ? "Tool Grant Request" : "Tool Approval",
    requesterName: requester,
    subtitle: isGrant
      ? "Requesting permission to use this tool"
      : "Requesting approval to run this tool",
    body,
    metadata,
    requestId: p.requestId,
    fallbackText,
  });
}
