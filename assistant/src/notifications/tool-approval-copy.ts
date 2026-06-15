/**
 * Deterministic helpers for building guardian-facing tool-approval copy.
 *
 * Produces Surface card seed content blocks for `tool_approval`,
 * `tool_grant_request`, and voice/call `pending_question` (with `toolName`)
 * guardian questions, enabling Approve/Reject buttons in the Vellum in-app
 * channel (web/macOS/iOS).
 */

import { buildApprovalCardBlocks } from "./approval-card-builder.js";
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

// ── Approval detection ──────────────────────────────────────────────────────

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

// ── Seed content blocks (Surface-based rendering) ───────────────────────────

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
  // Try strict Zod parsing first (full discriminated union).
  const strict = parseGuardianQuestionPayload(
    payload as Record<string, unknown>,
  );
  if (strict) {
    if (!isToolApprovalPayload(strict)) return null;
    return buildCardFromFields(strict);
  }

  // Fall back to lenient parsing — requires only `requestKind`.
  const lenient = LenientToolApprovalPayloadSchema.safeParse(payload);
  if (!lenient.success) return null;
  if (!isLenientToolApproval(lenient.data)) return null;
  return buildCardFromFields(lenient.data);
}

// ── Card construction (shared between strict and lenient paths) ─────────────

function buildCardFromFields(
  p: GuardianQuestionPayload | LenientToolApprovalPayload,
): unknown[] {
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

  return buildApprovalCardBlocks({
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
  });
}
