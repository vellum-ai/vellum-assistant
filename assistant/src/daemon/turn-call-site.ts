import type { LLMCallSite } from "../config/schemas/llm.js";
import type { Conversation } from "./conversation.js";

/**
 * The call site a turn runs under: the caller's explicit one, or a default
 * derived from the conversation. Subagent conversations default to
 * `subagentSpawn` (not `mainAgent`) so that turns which omit an explicit call
 * site — queue-drained follow-ups, background-command wakes — stay tagged as
 * subagent turns. They then resolve the subagent inference config, and
 * post-tool-use hooks gate on them correctly (e.g. exempting subagents from the
 * exploration-drift delegation nudge, and not nudging a user-less subagent to
 * show a progress card).
 *
 * Both daemon run paths (the main turn loop and the wake path) route their
 * call-site default through here so the rule cannot drift between them.
 */
export function resolveTurnCallSite(
  explicitCallSite: LLMCallSite | undefined,
  conversation: Pick<Conversation, "isSubagent">,
): LLMCallSite {
  return (
    explicitCallSite ??
    (conversation.isSubagent ? "subagentSpawn" : "mainAgent")
  );
}
