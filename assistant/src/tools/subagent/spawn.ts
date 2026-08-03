import { z } from "zod";

import type { AssistantEvent } from "../../api/index.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { validateInferenceProfileKey } from "../../config/inference-profile-validation.js";
import { resolveDefaultProfileKey } from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { profileSupportsTools } from "../../config/profile-tool-support.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import {
  getConversationOverrideProfile,
  getMessages,
} from "../../persistence/conversation-crud.js";
import {
  countRecentSimilarSpawns,
  normalizeSpawnObjective,
  type RecentSimilarSpawns,
  type SimilarSpawnTally,
} from "../../persistence/subagent-store.js";
import type { ContentBlock, Message } from "../../providers/types.js";
import { buildAdvisorContext } from "../../subagent/consult-context.js";
import {
  advisorRequestText,
  buildAdvisorSystem,
} from "../../subagent/consult-prompt.js";
import { sanitizeConsultTranscript } from "../../subagent/consult-transcript.js";
import {
  getSubagentManager,
  SubagentAbortedError,
} from "../../subagent/index.js";
import {
  type ResolvedSubagentRole,
  resolveSubagentRole,
} from "../../subagent/role-resolution.js";
import { getLogger } from "../../util/logger.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
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

/** How far back the repeat-spawn guard looks for near-identical runs. */
const LOOP_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Near-identical runs one conversation may complete inside the window before
 * the next spawn is held for confirmation. A couple of repeats is normal work;
 * a fourth completed run of one objective in a single conversation is a loop.
 * Runs that failed, were aborted, or were interrupted never count, so a retry
 * after a bad run is not what trips this.
 */
const LOOP_GUARD_CONVERSATION_LIMIT = 3;

/**
 * Near-identical runs the whole assistant may complete inside the window,
 * counted the same way. Higher than the per-conversation limit so the same
 * audit asked for in a few separate chats still goes through, while a standing
 * re-run of one objective does not.
 */
const LOOP_GUARD_ASSISTANT_LIMIT = 10;

/**
 * Model-input schema, `safeParse`d at the top of {@link executeSubagentSpawn}.
 * Same in-tool pattern and TOOLS.json drift guard as the other bundled-skill
 * tools — see the schema block in `tools/document/document-tool.ts` for the
 * framework.
 *
 * `fork` / `send_result_to_user` (deliberate `=== true` / `!== false`
 * coercions) and `role` (any string resolves, see `resolveSubagentRole`) are
 * deliberately UNDECLARED: loose passthrough.
 */
export const subagentSpawnInputSchema = z.looseObject({
  label: nullAsOmitted(z.string()),
  objective: nullAsOmitted(z.string()),
  context: nullAsOmitted(z.string()),
  inference_profile: z.string().optional(),
  confirm_repeat: nullAsOmitted(z.boolean()),
});

export async function executeSubagentSpawn(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = subagentSpawnInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("subagent_spawn", parsedInput.error);
  }
  const parsed = parsedInput.data;

  const label = parsed.label;
  const objective = parsed.objective;
  const extraContext = parsed.context;
  const fork = input.fork === true;
  const requestedRole =
    typeof input.role === "string" && input.role.trim().length > 0
      ? input.role
      : undefined;
  const resolvedRole = resolveSubagentRole(requestedRole);
  const inferenceProfile = parsed.inference_profile;

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
  if (resolvedRole.role === "advisor") {
    return runAdvisorConsult({
      context,
      label,
      objective,
      sendToClient: sendToClient as (msg: AssistantEvent) => void,
      requestedOverrideProfile,
    });
  }

  // ── Repeat-spawn guard ───────────────────────────────────────────
  // Re-running an objective that already completed several times in the last
  // day buys the same answer twice, so the guard hands the repetition back to
  // the caller with what it has already cost. It never blocks: `confirm_repeat`
  // always spawns, and the advisor consult returned above is never guarded.
  if (
    isAssistantFeatureFlagEnabled("subagent-loop-guard") &&
    parsed.confirm_repeat !== true
  ) {
    const guardResult = repeatSpawnGuardResult(
      context.conversationId,
      objective,
    );
    if (guardResult) {
      return guardResult;
    }
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
  // call site's own winning default (a `llm.callSites.<callSite>` pin or the
  // catalog intent, e.g. `cost-optimized`) for a heartbeat/background
  // invoker (`resolveDefaultProfileKey` runs the same winner selection as
  // dispatch, minus a per-turn override).
  //
  // An explicit `llm.callSites.subagentSpawn` profile must still win over
  // the invoker-default tier: that tier is a matching heuristic, not a user
  // choice, and any override outranks the call-site pin under single-winner
  // resolution — so the heuristic is only forwarded when no explicit pin
  // exists. An explicit `inference_profile` argument keeps
  // `forceOverrideProfile` and wins outright; the row read short-circuits
  // to `undefined` for the background subagent conversation and for tool
  // calls outside an agent-loop turn.
  //
  // `subagent-profile-isolation` replaces the two inheritance rungs for
  // non-advisor spawns. A profile pinned on a conversation is a choice about
  // that conversation, not about delegated work, yet it carries the pinned
  // model's price and its tool-calling reliability into every child the turn
  // spawns. Under the flag a spawn that names no `inference_profile` resolves
  // to the `subagentSpawn` call site's own default instead, and an explicit
  // profile the catalog states cannot call tools falls back to that same
  // default with a note on the result.
  const config = getConfig();
  const llm = config.llm;
  const isolateProfile = isAssistantFeatureFlagEnabled(
    "subagent-profile-isolation",
  );
  // `resolveDefaultProfileKey` already prefers an `llm.callSites.subagentSpawn`
  // pin over the `balanced` catalog intent, and skips a pin that is disabled or
  // incomplete, so it is the whole answer for "what does this call site run on".
  const subagentCallSiteProfile = (): string | undefined =>
    resolveDefaultProfileKey("subagentSpawn", llm);

  let profileNote: string | undefined;
  let inheritedOverrideProfile = requestedOverrideProfile;
  if (inheritedOverrideProfile === undefined) {
    inheritedOverrideProfile = isolateProfile
      ? subagentCallSiteProfile()
      : (context.overrideProfile ??
        getConversationOverrideProfile(context.conversationId) ??
        (llm.callSites?.subagentSpawn?.profile == null
          ? resolveDefaultProfileKey(
              context.invokingCallSite ?? "mainAgent",
              llm,
            )
          : undefined));
  } else if (
    isolateProfile &&
    profileSupportsTools(inheritedOverrideProfile, config) === false
  ) {
    profileNote = `requested profile "${inheritedOverrideProfile}" is not verified for tool calling; ran on the default profile instead.`;
    inheritedOverrideProfile = subagentCallSiteProfile();
    forceOverrideProfile = inheritedOverrideProfile !== undefined;
  }

  const roleNote = resolvedRoleNote(resolvedRole);

  try {
    const subagentId = await manager.spawn(
      {
        parentConversationId: context.conversationId,
        label,
        objective,
        context: extraContext,
        sendResultToUser,
        // The resolved type is passed for every spawn, fork included: a fork
        // that named no role resolves to `builder`, which imposes no
        // allowlist, so it keeps the parent's tool surface, which is what the
        // system prompt it inherits describes. The advisor is special-cased
        // earlier via runAdvisorConsult, not here.
        role: resolvedRole.role,
        ...(resolvedRole.personaText
          ? { persona: resolvedRole.personaText }
          : {}),
        // Declare the spawn mode so delegated LLM spend is separable in
        // telemetry: every variety shares `llm_call_site = "subagentSpawn"`,
        // and a fork's inherited transcript costs very differently from a
        // fresh objective-only spawn.
        spawnMode: fork ? "fork" : "regular",
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
        role: resolvedRole.role,
        ...(fork ? { isFork: true } : {}),
        ...(profileNote ? { note: profileNote } : {}),
        ...(roleNote ? { roleNote } : {}),
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

// ── Role resolution ──────────────────────────────────────────────────

/**
 * What to tell the parent about how its `role` was read, or `undefined` when
 * the requested role was a type name and nothing needs saying.
 *
 * The parent chose the role, so a silent substitution is the one outcome to
 * avoid: an alias and a persona fallback both change what the child can do,
 * and only the parent can decide whether that is what it wanted.
 */
function resolvedRoleNote(resolved: ResolvedSubagentRole): string | undefined {
  if (resolved.alias) {
    return `Role "${resolved.alias}" is an older name for "${resolved.role}"; the subagent runs with the ${resolved.role} toolset.`;
  }
  if (resolved.personaText) {
    return (
      `Role "${resolved.personaText}" is not a subagent type, so it was used as a persona and the subagent runs as a researcher: ` +
      'read-only, no shell. If the task has to write files or run commands, re-spawn it with role "builder".'
    );
  }
  return undefined;
}

// ── Repeat-spawn guard ───────────────────────────────────────────────

/**
 * The result to return instead of spawning when this objective has already
 * completed too often inside {@link LOOP_GUARD_WINDOW_MS}, or `undefined` when
 * the spawn should proceed.
 *
 * Only completed runs are counted, so the message can point the caller at an
 * answer that exists and a re-spawn after failures is never held.
 *
 * Not an error: the caller is being handed what its earlier runs produced and
 * cost, and can still spawn by passing `confirm_repeat: true`. The spawn
 * history can only advise, so a failed read lets the spawn through.
 */
function repeatSpawnGuardResult(
  parentConversationId: string,
  objective: string,
): ToolExecutionResult | undefined {
  let recent: RecentSimilarSpawns;
  try {
    recent = countRecentSimilarSpawns({
      parentConversationId,
      normalizedObjective: normalizeSpawnObjective(objective),
      sinceMs: Date.now() - LOOP_GUARD_WINDOW_MS,
    });
  } catch (err) {
    log.warn(
      { err, conversationId: parentConversationId },
      "Repeat-spawn guard could not read spawn history",
    );
    return undefined;
  }

  // The spawn being asked for is itself part of the limit, so a window whose
  // completed runs already fill the allowance is what trips the guard.
  let scope: string;
  let tally: SimilarSpawnTally;
  if (recent.conversation.count >= LOOP_GUARD_CONVERSATION_LIMIT) {
    scope = "in this conversation";
    tally = recent.conversation;
  } else if (recent.assistant.count >= LOOP_GUARD_ASSISTANT_LIMIT) {
    scope = "across this assistant";
    tally = recent.assistant;
  } else {
    return undefined;
  }

  const hours = LOOP_GUARD_WINDOW_MS / 3_600_000;
  const cost =
    tally.estimatedCost > 0
      ? `, at a total cost of about $${tally.estimatedCost.toFixed(2)}`
      : "";
  return {
    content:
      `${tally.count} near-identical subagents already completed ${scope} in the last ${hours} hours${cost}. ` +
      "Repeating an objective rarely returns a different answer: read what the earlier run produced with subagent_read, " +
      "or narrow the objective to what is actually still missing. " +
      "If the repetition is intentional, call subagent_spawn again with confirm_repeat: true.",
    isError: false,
  };
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
  sendToClient: (msg: AssistantEvent) => void;
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

    // Situational awareness for the advisor: the parent's live tool set, the
    // full skill catalog, and its workspace. Assembled off the per-turn
    // ToolContext snapshot (trust, channel) so the personal-memory sections
    // are gated exactly like the runtime injectors. Best-effort: a null pack
    // just means the consult runs on transcript + system prompt alone.
    const situationalContext = await buildAdvisorContext({
      conversationId: context.conversationId,
      workingDir: context.workingDir,
      allowedToolNames: context.allowedToolNames,
      trustClass: context.trustClass,
      sourceChannel: context.executionChannel,
      enabledPluginSet: context.enabledPluginSet,
      // The parent's warm per-turn catalog keeps the synchronous on-disk
      // catalog scan out of the consult path.
      skillCatalog: parentConversation.skillProjectionCache?.catalog,
    });

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
          // agent states the task here, and the inherited transcript can be
          // thin. The situational pack rides in the model request only
          // (`requestText`), keeping the system prompt minimal and the
          // display-facing `objective` free of bulky internal context.
          objective: advisorRequestText(objective),
          requestText: advisorRequestText(objective, situationalContext),
          sendResultToUser: false,
          role: "advisor",
          fork: true,
          // The advisor is a ROLE, not an `LLMCallSiteEnum` value, so its usage
          // lands under `subagentSpawn` like any other subagent. This is what
          // makes advisor consults separable from regular forks in telemetry.
          spawnMode: "advisor_consult",
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
  if (messages[messages.length - 1]?.role === "assistant") {
    return messages;
  }

  let rows;
  try {
    rows = getMessages(conversationId);
  } catch {
    return messages;
  }
  if (!rows || rows.length === 0) {
    return messages;
  }

  const lastRow = rows[rows.length - 1];
  if (lastRow.role !== "assistant") {
    return messages;
  }

  const blocks: ContentBlock[] = lastRow.content;

  if (blocks.length === 0) {
    return messages;
  }
  return [...messages, { role: "assistant", content: blocks }];
}
