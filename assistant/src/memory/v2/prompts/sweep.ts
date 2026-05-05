/**
 * Memory v2 — sweep prompt template.
 *
 * Body taken from §9 of the design doc (`memoized-spinning-wadler.md`). The
 * template uses two placeholders that the sweep job substitutes at runtime:
 *
 *   - `{{ASSISTANT_NAME}}` — the assistant's display name (from IDENTITY.md
 *     when available, else "the assistant" so the prompt still parses).
 *   - `{{USER_NAME}}` — the guardian's display name (from the guardian
 *     persona when available, else "the user").
 *
 * Kept here (under `prompts/`) rather than inlined in `sweep-job.ts` so the
 * prompt body is reviewable on its own and the job module stays focused on
 * orchestration. The same convention applies to the consolidation prompt
 * landing in PR 20.
 */

/** Sentinel substituted with the assistant's display name at runtime. */
const ASSISTANT_NAME_PLACEHOLDER = "{{ASSISTANT_NAME}}";

/** Sentinel substituted with the guardian's display name at runtime. */
const USER_NAME_PLACEHOLDER = "{{USER_NAME}}";

/**
 * Sweep prompt — body from design doc §9. The model is asked to surface
 * additional facts/preferences/plans/etc. that should be remembered but
 * aren't already in the existing buffer. It MUST emit a JSON-shaped tool
 * call with an `entries` array; the runtime parses the response via the
 * tool definition declared in `sweep-job.ts`.
 *
 * The `existingBuffer` text is appended at the call site (rather than
 * templated here) so we don't inadvertently expand `{{` inside user buffer
 * content. Recent messages are likewise appended outside the template.
 */
const SWEEP_PROMPT = `You are a background helper for ${ASSISTANT_NAME_PLACEHOLDER}. Read these recent messages between ${ASSISTANT_NAME_PLACEHOLDER} and ${USER_NAME_PLACEHOLDER}. The assistant has already called \`remember()\` for the entries shown in \`existingBuffer\`.

Identify additional facts, preferences, plans, corrections, names, dates, decisions, or notable felt moments that should be remembered but aren't already in \`existingBuffer\`. Emit a list of \`remember()\` entries (each one line, in the assistant's first-person voice). Don't duplicate. Prefer to over-remember rather than miss things.

Return only the \`entries\` array.`;

/**
 * Resolve `SWEEP_PROMPT` with assistant + user names substituted. Falls back
 * to neutral defaults so the prompt still produces well-formed English when
 * either name is unavailable on this workspace.
 */
export function renderSweepPrompt(opts: {
  assistantName: string | null;
  userName: string | null;
}): string {
  const assistant = opts.assistantName?.trim() || "the assistant";
  const user = opts.userName?.trim() || "the user";
  return SWEEP_PROMPT.replaceAll(
    ASSISTANT_NAME_PLACEHOLDER,
    assistant,
  ).replaceAll(USER_NAME_PLACEHOLDER, user);
}
