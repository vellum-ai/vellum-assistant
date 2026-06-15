/**
 * Deterministic helpers for building guardian-facing tool-approval copy.
 *
 * Produces Surface card seed content blocks for `tool_approval`,
 * `tool_grant_request`, and voice/call `pending_question` (with `toolName`)
 * guardian questions, enabling Approve/Reject buttons in the Vellum in-app
 * channel (web/macOS/iOS).
 *
 * Delegates to the unified `resolveApprovalCardData` resolver for payload
 * parsing and field extraction, then renders via `renderSurfaceApprovalCard`.
 */

import { renderSurfaceApprovalCard } from "./approval-card-builder.js";
import { resolveApprovalCardData } from "./approval-card-data.js";
import type { GuardianQuestionPayload } from "./guardian-question-mode.js";

// ── Seed content blocks (Surface-based rendering) ───────────────────────────

/**
 * Build structured content blocks for a tool approval/grant notification seed
 * message. Returns `null` when the payload does not represent a tool approval.
 *
 * Accepts both strict `GuardianQuestionPayload` (Zod-validated) and raw
 * `Record<string, unknown>` payloads. The unified resolver handles strict
 * and lenient parsing internally.
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
  if (!data || data.kind === "access_request") return null;
  return renderSurfaceApprovalCard(data);
}
