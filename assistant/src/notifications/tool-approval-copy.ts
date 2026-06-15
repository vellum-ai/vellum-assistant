/**
 * Deterministic helpers for building guardian-facing tool-approval copy.
 *
 * Produces Surface card seed content blocks for `tool_approval` and
 * `tool_grant_request` guardian questions, enabling Approve/Reject buttons
 * in the Vellum in-app channel (web/macOS/iOS).
 *
 * Mirrors the pattern established by `access-request-copy.ts`.
 */

import { sanitizeIdentityField } from "./access-request-copy.js";
import {
  buildGuardianRequestCodeInstruction,
  resolveGuardianQuestionInstructionMode,
} from "./guardian-question-mode.js";

// ── Local string utilities ──────────────────────────────────────────────────

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
 * message. Produces a `ui_surface` card block with Approve/Reject buttons
 * plus a plain-text fallback block.
 *
 * Returns `null` when the payload does not represent a tool approval. Covers
 * `tool_approval`, `tool_grant_request`, and `pending_question` with a
 * `toolName` (voice/call tool approvals persisted as pending questions).
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
  const subtitle = isGrant
    ? "Requesting permission to use this tool"
    : "Requesting approval to run this tool";

  const metadata: Array<{ label: string; value: string }> = [];
  metadata.push({ label: "Tool", value: toolName });

  if (p.sourceChannel) {
    metadata.push({ label: "Source", value: p.sourceChannel });
  }

  // questionText contains the full formatted string (e.g.
  // 'Bob wants to use "bash": mkdir -p scratch && ...').
  // Extract the input summary portion after the tool name for the card body.
  const bodyParts: string[] = [];
  if (p.questionText) {
    // The questionText may contain the input summary after a colon or dash.
    // Display it as a blockquote for readability.
    bodyParts.push(`> ${p.questionText}`);
  }

  const body =
    bodyParts.length > 0
      ? bodyParts.join("\n\n")
      : "No additional context available.";

  const actions = p.requestId
    ? [
        {
          id: `apr:${p.requestId}:approve_once`,
          label: "Approve",
          style: "primary",
        },
        {
          id: `apr:${p.requestId}:reject`,
          label: "Reject",
          style: "destructive",
        },
      ]
    : undefined;

  const surfaceBlock = {
    type: "ui_surface" as const,
    surfaceId: `tool-approval-${p.requestId ?? "unknown"}`,
    surfaceType: "card" as const,
    title: isGrant ? "Tool Grant Request" : "Tool Approval",
    data: {
      title: requester,
      subtitle,
      body,
      metadata,
    },
    ...(actions ? { actions } : {}),
  };

  const fallbackText =
    p.questionText ?? `${requester} is requesting approval to use ${toolName}`;

  // Include request-code instruction in the text fallback so older clients
  // that cannot render ui_surface blocks still show the approve/reject
  // disambiguation.
  let textContent = fallbackText;
  if (p.requestCode) {
    const modeResolution = resolveGuardianQuestionInstructionMode(payload);
    const instruction = buildGuardianRequestCodeInstruction(
      p.requestCode.trim().toUpperCase(),
      modeResolution.mode,
    );
    textContent = `${fallbackText}\n\n${instruction}`;
  }

  const textBlock = {
    type: "text" as const,
    text: textContent,
  };

  return [surfaceBlock, textBlock];
}
