import { findConversation } from "../../daemon/conversation-store.js";
import { getConversationOverrideProfile } from "../../memory/conversation-crud.js";
import type { Message } from "../../providers/types.js";
import { getSubagentManager } from "../../subagent/index.js";
import type { SubagentRole } from "../../subagent/types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const label = input.label as string;
  const objective = input.objective as string;
  const extraContext = input.context as string | undefined;
  const fork = input.fork === true;
  const role = (input.role as string | undefined) ?? undefined;

  // For fork mode, sendResultToUser defaults to false unless explicitly set to true.
  // For regular mode, sendResultToUser defaults to true (existing behavior).
  const sendResultToUser = fork
    ? input.send_result_to_user === true
    : input.send_result_to_user !== false;

  if (!label || !objective) {
    return {
      content: 'Both "label" and "objective" are required.',
      isError: true,
    };
  }

  const manager = getSubagentManager();
  const sendToClient = context.sendToClient as
    | ((msg: { type: string; [key: string]: unknown }) => void)
    | undefined;
  if (!sendToClient) {
    return {
      content: "No client connected - cannot spawn subagent.",
      isError: true,
    };
  }

  // ── Fork mode: resolve parent context ────────────────────────────
  let forkFields:
    | {
        fork: true;
        parentMessages: Message[];
        parentSystemPrompt: string;
      }
    | undefined;

  if (fork) {
    const parentConversation = findConversation(context.conversationId);
    if (!parentConversation) {
      return {
        content:
          "Cannot fork: parent conversation could not be resolved. " +
          "This may happen if the conversation was evicted.",
        isError: true,
      };
    }

    const parentMessages = [...parentConversation.messages];
    const parentSystemPrompt = parentConversation.getCurrentSystemPrompt();

    forkFields = {
      fork: true,
      parentMessages,
      parentSystemPrompt,
    };
  }

  // The subagent runs as its own background conversation, so the agent
  // loop's background-skip rule would zero out any inherited profile.
  // Pass the parent's profile explicitly via `SubagentConfig` so the
  // PR 6 plumbing in `SubagentManager.spawn` forwards it back into the
  // subagent's `runAgentLoop` call as `options.overrideProfile`.
  //
  // Prefer the per-turn `context.overrideProfile` (populated by
  // `runAgentLoopImpl` from its resolved `turnOverrideProfile`) over a
  // row read so nested spawns inherit correctly. The current subagent's
  // own conversation row never has `inferenceProfile` set — its override
  // arrived via in-memory `SubagentConfig.overrideProfile` — and even if it
  // were set, `getConversationOverrideProfile` short-circuits for
  // background conversations and returns `undefined`. Falling back to the
  // row read preserves behavior for tool calls that originate outside an
  // agent-loop turn.
  const inheritedOverrideProfile =
    context.overrideProfile ??
    getConversationOverrideProfile(context.conversationId);

  try {
    const subagentId = await manager.spawn(
      {
        parentConversationId: context.conversationId,
        label,
        objective,
        context: extraContext,
        sendResultToUser,
        // For fork mode, role is ignored by the manager (forced to general),
        // but we still omit it from the config to signal intent.
        ...(!fork && role ? { role: role as SubagentRole } : {}),
        ...(inheritedOverrideProfile
          ? { overrideProfile: inheritedOverrideProfile }
          : {}),
        ...forkFields,
      },
      sendToClient as (msg: unknown) => void,
    );

    return {
      content: JSON.stringify({
        subagentId,
        label,
        status: "pending",
        ...(fork ? { isFork: true } : {}),
        message: fork
          ? `Forked subagent "${label}" spawned with full parent context. You will be notified automatically when it completes or fails - do NOT poll subagent_status. Continue the conversation normally.`
          : `Subagent "${label}" spawned. You will be notified automatically when it completes or fails - do NOT poll subagent_status. Continue the conversation normally.`,
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to spawn subagent: ${msg}`, isError: true };
  }
}
