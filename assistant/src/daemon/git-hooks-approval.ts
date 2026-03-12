import type { PermissionPrompter } from "../permissions/prompter.js";
import { isAllowDecision } from "../permissions/types.js";

/**
 * Reserved pseudo tool name used for git hooks trust prompts.
 * This is not a real tool — it provides a recognizable identifier
 * in the confirmation UI so the user can see what is being requested.
 */
export const GIT_HOOKS_TRUST_TOOL_NAME = "__internal:git-hooks-trust";

export type GitHooksTrustApprovalResult =
  | { approved: true }
  | { approved: false };

/**
 * Prompts the user to decide whether to trust the project's git hooks
 * and allow them to run during assistant auto-commits.
 *
 * Uses the existing PermissionPrompter / `/v1/confirm` resolution flow with:
 * - A reserved pseudo tool name so the UI can display a meaningful label
 * - Medium risk level (hooks run arbitrary code)
 * - No persistent decision affordances (decision is one-shot per session prompt;
 *   persistence is handled separately via the trust-state helper)
 * - Empty allowlist/scope options (no "always allow" or scope variants)
 */
export async function requestGitHooksTrustApproval(
  prompter: PermissionPrompter,
  opts?: { signal?: AbortSignal },
): Promise<GitHooksTrustApprovalResult> {
  const result = await prompter.prompt(
    GIT_HOOKS_TRUST_TOOL_NAME,
    {
      description:
        "This project has git hooks. Do you trust this project and want to enable hooks for assistant auto-commits?",
    },
    "medium",
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    opts?.signal,
  );

  return { approved: isAllowDecision(result.decision) };
}
