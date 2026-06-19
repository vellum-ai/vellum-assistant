import { validateInferenceProfileKey } from "../../config/inference-profile-validation.js";
import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { AUTO_PROFILE_KEY } from "../../config/seed-inference-profiles.js";
import { findConversation } from "../../daemon/conversation-registry.js";
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
  const inferenceProfile = input.inference_profile;

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

  let requestedOverrideProfile: string | undefined;
  let forceOverrideProfile = false;
  if (inferenceProfile !== undefined) {
    if (typeof inferenceProfile !== "string") {
      return {
        content: "Error: inference_profile must be a string",
        isError: true,
      };
    }
    const profileError = validateInferenceProfileKey(inferenceProfile);
    if (profileError) {
      return {
        content: `Error: ${profileError}`,
        isError: true,
      };
    }
    requestedOverrideProfile = inferenceProfile;
    forceOverrideProfile = true;
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
  // Pass the parent's profile explicitly via `SubagentConfig` so
  // `SubagentManager.spawn` forwards it back into the subagent's
  // `runAgentLoop` call as `options.overrideProfile`.
  //
  // Resolution order: an explicit spawn-time profile, then the per-turn
  // `context.overrideProfile` (populated by `runAgentLoopImpl` from its
  // resolved `turnOverrideProfile`, covering per-conversation overrides and
  // tool-routed switches), then a row read, and finally the resolved DEFAULT
  // profile of the call site that invoked us. That last fallback is what makes
  // a subagent match its invoker when the invoking turn ran purely on its
  // call-site default — the workspace `activeProfile` for `mainAgent`, or the
  // call site's own catalog default (e.g. `cost-optimized`) for a
  // heartbeat/background invoker. `resolveDefaultProfileKey` does not reflect a
  // static `llm.callSites.<callSite>` profile override (only the
  // activeProfile-for-mainAgent path plus the catalog default), a narrow gap
  // that only surfaces with no `activeProfile` set and a hand-tuned call-site
  // profile.
  //
  // The fallback is forwarded NON-forced, so an explicit
  // `llm.callSites.subagentSpawn` profile still wins; an explicit
  // `inference_profile` argument keeps `forceOverrideProfile` and wins
  // outright. (The row read short-circuits to `undefined` for the background
  // subagent conversation and for tool calls outside an agent-loop turn.)
  let inheritedOverrideProfile = requestedOverrideProfile;
  if (inheritedOverrideProfile === undefined) {
    const inheritedCandidate =
      context.overrideProfile ??
      getConversationOverrideProfile(context.conversationId) ??
      resolveDefaultProfileKey(
        context.invokingCallSite ?? "mainAgent",
        getConfig().llm,
      );
    // Skip the metadata-only "auto" key: forwarding it collapses the child to
    // `llm.default`, whereas the invoker's own auto base IS the `subagentSpawn`
    // default — so leaving this undefined keeps the child on that default.
    if (inheritedCandidate !== AUTO_PROFILE_KEY) {
      inheritedOverrideProfile = inheritedCandidate;
    }
  }

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
        ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
        ...(context.toolUseId ? { parentToolUseId: context.toolUseId } : {}),
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
