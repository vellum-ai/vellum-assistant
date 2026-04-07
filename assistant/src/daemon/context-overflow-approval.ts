import type { PermissionPrompter } from "../permissions/prompter.js";
import { isAllowDecision } from "../permissions/types.js";

/**
 * Reserved pseudo tool name used for context overflow compression approval
 * prompts. This is not a real tool — it provides a recognizable identifier
 * in the confirmation UI so the user can see what is being requested.
 */
export const CONTEXT_OVERFLOW_TOOL_NAME = "context_overflow_compression";

export type CompressionApprovalResult =
  | { approved: true }
  | { approved: false };

/**
 * Prompts the user for approval to compress the latest turn in order to
 * recover from a context overflow.
 *
 * Uses the existing PermissionPrompter / `/v1/confirm` resolution flow with:
 * - A reserved pseudo tool name so the UI can display a meaningful label
 * - Low risk level (this is a lossy but non-destructive operation)
 * - No persistent decision affordances (the decision is one-shot per overflow)
 * - Empty allowlist/scope options (no "always allow" or scope variants)
 */
export async function requestCompressionApproval(
  prompter: PermissionPrompter,
  opts?: { signal?: AbortSignal },
): Promise<CompressionApprovalResult> {
  const result = await prompter.prompt(
    CONTEXT_OVERFLOW_TOOL_NAME,
    {
      description:
        "The conversation has exceeded the context window limit. " +
        "Approve to compress the most recent turn so the conversation can continue.",
    },
    "low",
    [],
    [],
    undefined,
    undefined,
    undefined,
    false,
    opts?.signal,
  );

  return { approved: isAllowDecision(result.decision) };
}
