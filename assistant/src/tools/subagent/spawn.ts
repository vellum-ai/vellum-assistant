import { validateInferenceProfileKey } from "../../config/inference-profile-validation.js";
import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  getConversationOverrideProfile,
  getMessages,
} from "../../persistence/conversation-crud.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import {
  advisorRequestText,
  buildAdvisorSystem,
} from "../../subagent/consult-prompt.js";
import { sanitizeConsultTranscript } from "../../subagent/consult-transcript.js";
import {
  getSubagentManager,
  SubagentAbortedError,
} from "../../subagent/index.js";
import type { SubagentRole } from "../../subagent/types.js";
import { getLogger } from "../../util/logger.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { createConsultDeadline } from "./consult-deadline.js";

const log = getLogger("subagent-spawn");

/**
 * Idle ceiling on a single advisor consult: abort only after this much time
 * passes with NO streamed token (thinking or text). A reasoning advisor profile
 * streams its reasoning while it works, so a fixed wall-clock ceiling would kill
 * it mid-thought; an idle window instead fires only when the consult is
 * genuinely stalled (or never starts). Generous enough to also span
 * time-to-first-token over a large inherited transcript.
 */
const ADVISOR_IDLE_TIMEOUT_MS = 60_000;

/**
 * Absolute backstop on a single advisor consult regardless of streaming
 * progress, so a runaway or looping stream can't block the parent forever.
 * Either ceiling still yields the partial guidance (recovered in the
 * `SubagentAbortedError` branch below), not a discard.
 */
const ADVISOR_MAX_TIMEOUT_MS = 300_000;

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

  // ── Advisor role: synchronous, tool-less, stronger-model consult ──
  // Branch before the fire-and-forget path: the advisor blocks on the run and
  // returns its guidance as the tool result in the same turn.
  if (role === "advisor") {
    return runAdvisorConsult({
      context,
      label,
      objective,
      sendToClient: sendToClient as (msg: ServerMessage) => void,
      requestedOverrideProfile,
    });
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
  // Forward the invoker's profile explicitly via `SubagentConfig` so
  // `SubagentManager.spawn` passes it into the subagent's `runAgentLoop` as
  // `options.overrideProfile`.
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
  // An explicit `llm.callSites.subagentSpawn` profile must still win over
  // the invoker-default tier: that tier is a matching heuristic, not a user
  // choice, and any override outranks the call-site pin under
  // override-or-default resolution — so the heuristic is only forwarded
  // when no explicit pin exists. (Under the legacy cascade a non-forced
  // override already lost to the pin, so this guard is behavior-identical
  // there.) An explicit `inference_profile` argument keeps
  // `forceOverrideProfile` and wins outright; the row read short-circuits
  // to `undefined` for the background subagent conversation and for tool
  // calls outside an agent-loop turn.
  let inheritedOverrideProfile = requestedOverrideProfile;
  if (inheritedOverrideProfile === undefined) {
    const llm = getConfig().llm;
    inheritedOverrideProfile =
      context.overrideProfile ??
      getConversationOverrideProfile(context.conversationId) ??
      (llm.callSites?.subagentSpawn?.profile == null
        ? resolveDefaultProfileKey(context.invokingCallSite ?? "mainAgent", llm)
        : undefined);
  }

  try {
    const subagentId = await manager.spawn(
      {
        parentConversationId: context.conversationId,
        label,
        objective,
        context: extraContext,
        sendResultToUser,
        // Regular forks omit the role so they default to general; the advisor
        // role is special-cased earlier via runAdvisorConsult, not here.
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

// ── Advisor consult ──────────────────────────────────────────────────

/**
 * Run the `advisor` role as a synchronous, context-inheriting, stronger-model
 * consult and return its guidance as the tool result.
 *
 * Inherits the parent transcript (sanitized), frames it as advice via
 * `buildAdvisorSystem`, runs tool-less on `llm.advisorProfile` (unless the
 * caller passed an explicit `inference_profile`), and is bounded by a
 * progress-aware deadline: an idle window (`ADVISOR_IDLE_TIMEOUT_MS`) reset on
 * every streamed token so a reasoning model isn't killed mid-thought, plus an
 * absolute `ADVISOR_MAX_TIMEOUT_MS` backstop. If either ceiling is hit, the
 * partial guidance produced so far is recovered and returned with a "may be cut
 * off" note rather than discarded. Degrades to a benign non-error notice on any
 * other failure (including the depth-limit rejection when a subagent itself
 * calls the advisor).
 */
async function runAdvisorConsult(args: {
  context: ToolContext;
  label: string;
  /** The agent's own `objective` — its framing of what it wants advised on. */
  objective: string;
  sendToClient: (msg: ServerMessage) => void;
  requestedOverrideProfile: string | undefined;
}): Promise<ToolExecutionResult> {
  const { context, label, objective, sendToClient, requestedOverrideProfile } =
    args;

  try {
    const parentConversation = findConversation(context.conversationId);
    if (!parentConversation) {
      return {
        content:
          "(advisor unavailable: parent conversation could not be resolved)",
        isError: false,
      };
    }

    // Snapshot the parent's in-memory transcript and system prompt, then append
    // the in-flight assistant turn (the plan/text the model wrote THIS turn,
    // before calling the advisor). The in-memory array does not yet hold that
    // turn — the agent loop only writes it back to `conversation.messages` after
    // the turn settles — but it is already persisted to the DB (the assistant
    // row is finalized at `message_complete`, which fires before tool execution).
    // `sanitizeConsultTranscript` then strips the dangling advisor `tool_use`
    // off that final assistant turn so the inherited transcript is provider-safe.
    const parentSystemPrompt = parentConversation.getCurrentSystemPrompt();
    const withInFlight = appendInFlightAssistantTurn(
      [...parentConversation.messages],
      context.conversationId,
    );
    const sanitizedMessages = sanitizeConsultTranscript(withInFlight);

    // Default to the stronger advisor profile when the caller did not pin one;
    // an explicit `inference_profile` wins (already forced upstream).
    const advisorProfile = getConfig().llm.advisorProfile;
    const overrideProfile = requestedOverrideProfile ?? advisorProfile;
    const forceOverrideProfile = overrideProfile !== undefined;

    // Progress-aware deadline: reset on every streamed token so the consult
    // isn't killed mid-thought, with an absolute backstop. Combine it with the
    // caller's own signal.
    const deadline = createConsultDeadline({
      idleMs: ADVISOR_IDLE_TIMEOUT_MS,
      maxMs: ADVISOR_MAX_TIMEOUT_MS,
    });
    const signal = context.signal
      ? AbortSignal.any([context.signal, deadline.signal])
      : deadline.signal;
    // Every streamed chunk (thinking or text) counts as progress and resets the
    // idle window, then forwards to the caller's stream sink if one is present.
    const onText = (chunk: string): void => {
      deadline.recordProgress();
      context.onOutput?.(chunk);
    };

    try {
      const advice = await getSubagentManager().spawnAndAwait(
        {
          parentConversationId: context.conversationId,
          label,
          // Carry the agent's own objective into the consult request — the
          // agent states the task here, and the inherited transcript can be thin.
          objective: advisorRequestText(objective),
          sendResultToUser: false,
          role: "advisor",
          fork: true,
          parentMessages: sanitizedMessages,
          systemPromptOverride: buildAdvisorSystem(parentSystemPrompt),
          ...(overrideProfile ? { overrideProfile } : {}),
          ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
          ...(context.toolUseId ? { parentToolUseId: context.toolUseId } : {}),
        },
        sendToClient,
        { signal, onText },
      );

      const trimmed = advice.trim();
      return {
        content:
          trimmed.length > 0 ? trimmed : "(advisor returned no guidance)",
        isError: false,
      };
    } finally {
      deadline.dispose();
    }
  } catch (err) {
    // Timed out mid-generation: salvage whatever guidance the advisor had
    // written rather than throwing it away. Partial strategic advice is far
    // more useful to the agent than an "unavailable" notice — especially on a
    // slow reasoning profile that needs most of the window to think.
    if (err instanceof SubagentAbortedError) {
      const partial = err.partialText.trim();
      if (partial.length > 0) {
        log.warn(
          { conversationId: context.conversationId },
          "Advisor consult timed out; returning partial guidance",
        );
        return {
          content: `${partial}\n\n_(The advisor reached its time limit while still writing — the guidance above may be cut off.)_`,
          isError: false,
        };
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, conversationId: context.conversationId },
      "Advisor consult failed",
    );
    // Never fail the turn — the advisor is advice, not a blocker.
    return { content: `(advisor unavailable: ${reason})`, isError: false };
  }
}

/**
 * Append the in-flight assistant turn (persisted this turn before the advisor
 * tool ran) to an in-memory message snapshot, unless the snapshot already ends
 * with it. The latest persisted assistant row carries the plan/text the model
 * wrote immediately before calling the advisor plus the dangling advisor
 * `tool_use`; `sanitizeConsultTranscript` strips the dangling call.
 *
 * Best-effort: a malformed or missing row leaves the snapshot unchanged so the
 * consult still runs over the in-memory history.
 */
function appendInFlightAssistantTurn(
  messages: Message[],
  conversationId: string,
): Message[] {
  // When the snapshot already ends on an assistant turn, the in-flight turn is
  // present (or there is none to add) — appending the latest row would duplicate it.
  if (messages[messages.length - 1]?.role === "assistant") return messages;

  let rows;
  try {
    rows = getMessages(conversationId);
  } catch {
    return messages;
  }
  if (!rows || rows.length === 0) return messages;

  const lastRow = rows[rows.length - 1];
  if (lastRow.role !== "assistant") return messages;

  let blocks: ContentBlock[];
  try {
    const parsed = JSON.parse(lastRow.content);
    if (Array.isArray(parsed)) {
      blocks = parsed as ContentBlock[];
    } else if (typeof parsed === "string") {
      blocks = [{ type: "text", text: parsed }];
    } else {
      return messages;
    }
  } catch {
    // Plain-text content (no JSON envelope).
    blocks = [{ type: "text", text: lastRow.content }];
  }

  if (blocks.length === 0) return messages;
  return [...messages, { role: "assistant", content: blocks }];
}
