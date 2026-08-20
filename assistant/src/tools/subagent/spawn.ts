import { z } from "zod";

import type { AssistantEvent } from "../../api/index.js";
import { validateInferenceProfileKey } from "../../config/inference-profile-validation.js";
import { getConfig } from "../../config/loader.js";
import { profileSupportsTools } from "../../config/profile-tool-support.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import {
  countRecentSimilarSpawns,
  normalizeSpawnObjective,
  type RecentSimilarSpawns,
  type SimilarSpawnTally,
} from "../../persistence/subagent-store.js";
import type { Message } from "../../providers/types.js";
import { buildAdvisorContext } from "../../subagent/consult-context.js";
import {
  advisorRequestText,
  buildAdvisorSystem,
} from "../../subagent/consult-prompt.js";
import {
  getSubagentManager,
  SubagentAbortedError,
} from "../../subagent/index.js";
import {
  type ResolvedSubagentRole,
  resolveSubagentRole,
} from "../../subagent/role-resolution.js";
import {
  SUBAGENT_OUTPUT_CONTRACTS,
  type SubagentOutputContract,
  type SubagentRole,
} from "../../subagent/types.js";
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
 * passes with NO sign of forward progress, meaning neither a streamed token
 * (thinking or text) nor tool activity. A reasoning advisor profile streams its
 * reasoning while it works, so a fixed wall-clock ceiling would kill it
 * mid-thought; an idle window instead fires only when the consult is genuinely
 * stalled (or never starts). Generous enough to also span time-to-first-token
 * on a slow reasoning profile.
 */
const ADVISOR_IDLE_TIMEOUT_MS = 60_000;

/**
 * Absolute backstop on a single advisor consult regardless of streaming
 * progress, so a runaway or looping stream can't block the parent forever.
 * Either ceiling still yields the partial guidance (recovered in the
 * `SubagentAbortedError` branch below), not a discard.
 */
const ADVISOR_MAX_TIMEOUT_MS = 300_000;

/**
 * Tool calls a single advisor consult may make before it is stopped and asked
 * to answer with what it has.
 *
 * The consult BLOCKS the user-facing turn, and every tool call it makes
 * re-arms the idle window, so a reading advisor is otherwise bounded only by
 * the absolute backstop: five minutes of silence in the chat. A consult is
 * meant to check a decisive fact or two, not to survey a codebase, so a handful
 * of reads is the whole budget; past it the guidance written so far is worth
 * more to the caller than the reads it was still queuing.
 */
const ADVISOR_MAX_TOOL_CALLS = 8;

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
 * Near-identical runs one conversation may have IN FLIGHT before the next
 * spawn is held. Lower than the completed limits because nothing has come back
 * yet: a burst of copies fired before any of them finishes is the runaway shape
 * the guard exists for, and the completed counts are blind to it for as long as
 * the burst lasts.
 */
const LOOP_GUARD_IN_FLIGHT_CONVERSATION_LIMIT = 2;

/** The same ceiling assistant-wide, scaled like the completed limits. */
const LOOP_GUARD_IN_FLIGHT_ASSISTANT_LIMIT = 4;

/**
 * The tier a `verdict` spawn runs on when it names no `inference_profile`.
 *
 * Checking a criterion against evidence that already exists is mechanical:
 * find the file, read the value, say PASS or FAIL. A premium model buys
 * nothing there, and completion checks are frequent enough that paying
 * investigation rates for them dominates delegated spend, so the contract that
 * makes a spawn a check also picks the tier the check is worth.
 */
const VERDICT_PROFILE_KEY = "cost-optimized";

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
  output_contract: nullAsOmitted(z.enum(SUBAGENT_OUTPUT_CONTRACTS)),
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
  const outputContract = parsed.output_contract;

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

  const contractError = outputContractError(outputContract, resolvedRole.role);
  if (contractError) {
    return { content: contractError, isError: true };
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

  // ── Advisor role: synchronous, read-only, stronger-model consult ──
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
  if (parsed.confirm_repeat !== true) {
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

  // A subagent resolves the `subagentSpawn` call site's own default profile.
  // A profile pinned on a conversation is a choice about that conversation,
  // not about the work it delegates, and carrying it into a child would apply
  // the pinned model's price and its tool-calling reliability to every spawn
  // the turn makes.
  //
  // Landing on the call site's own profile means passing NO override: the
  // child already runs its loop under `callSite: "subagentSpawn"`, so the
  // resolver picks that profile on its own. Passing it explicitly would select
  // the same model but register as an override, and `resolveUsageAttribution`
  // classifies an override winner as `conversation`, which would file every
  // subagent's spend under a pin the caller never set and break the call-site
  // breakdown this telemetry exists for.
  //
  // An explicit `inference_profile` argument keeps `forceOverrideProfile` and
  // wins outright, unless the catalog states it cannot call tools, in which
  // case it falls back to the same default with a note on the result.
  const config = getConfig();
  const llm = config.llm;

  let profileNote: string | undefined;
  let inheritedOverrideProfile = requestedOverrideProfile;
  if (inheritedOverrideProfile === undefined) {
    if (outputContract === "verdict") {
      // A verdict is a check rather than an investigation, so it takes the
      // cheap tier. The tier is this tool's preset, not a caller's choice, and
      // an override outranks a call site's own profile under single-winner
      // resolution, so the preset is only applied when the user pinned
      // nothing: with an explicit `llm.callSites.subagentSpawn` profile the
      // field is left unset and that pin wins. An `inference_profile` argument
      // beats both and never enters this branch at all.
      inheritedOverrideProfile =
        llm.callSites?.subagentSpawn?.profile == null
          ? VERDICT_PROFILE_KEY
          : undefined;
    }
    // Every other spawn leaves this unset, which is what lands it on the
    // subagentSpawn default rather than anything the parent turn was pinned to.
  } else if (profileSupportsTools(inheritedOverrideProfile, config) === false) {
    profileNote = `requested profile "${inheritedOverrideProfile}" is not verified for tool calling; ran on the default profile instead.`;
    inheritedOverrideProfile = undefined;
    forceOverrideProfile = false;
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
        ...(outputContract ? { outputContract } : {}),
        // Declare the spawn mode so delegated LLM spend is separable in
        // telemetry: every variety shares `llm_call_site = "subagentSpawn"`,
        // and a fork's inherited transcript costs very differently from a
        // fresh objective-only spawn.
        spawnMode: fork ? "fork" : "regular",
        ...(inheritedOverrideProfile
          ? { overrideProfile: inheritedOverrideProfile }
          : {}),
        ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
        // Delegated work belongs to the firing that triggered the invoking
        // turn, so the child's usage rows carry the parent's stamp.
        ...(context.cronRunId ? { cronRunId: context.cronRunId } : {}),
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

// ── Output contract ──────────────────────────────────────────────────

/**
 * Why the requested `output_contract` cannot run under the type this spawn
 * resolved to, or `undefined` when the pairing is fine.
 *
 * The two non-default contracts each need a capability only one type has: a
 * verdict is a claim about what already exists, which is the read-only
 * researcher's job, and an artifact has to be written, which only a builder
 * can do. The advisor takes no contract at all: it is a blocking consult that
 * returns guidance in its own framing, and its child never sees a built system
 * prompt or fork framing to render one into. That includes an explicit
 * `report`, which is checked against the advisor before it is waved through as
 * the default everywhere else: the caller asked for a shape the consult cannot
 * produce, and only an omitted contract means it never asked.
 *
 * Mismatches are rejected rather than coerced. Silently promoting a verdict
 * spawn to a builder would hand out write access the caller never asked for,
 * and silently demoting one to a report would return prose where the caller
 * expected pass/fail. Either way the caller is the only one who can say which
 * half of its request was the mistake.
 */
function outputContractError(
  contract: SubagentOutputContract | undefined,
  role: SubagentRole,
): string | undefined {
  if (contract === undefined) {
    return undefined;
  }
  if (role === "advisor") {
    return (
      `output_contract "${contract}" does not apply to the advisor: it is a blocking consult that returns guidance in its own shape. ` +
      'Drop output_contract, or spawn role "researcher" with output_contract "verdict" to have work checked.'
    );
  }
  if (contract === "report") {
    return undefined;
  }
  if (contract === "verdict" && role !== "researcher") {
    return (
      `output_contract "verdict" is only available to researcher-typed subagents, and this spawn resolved to "${role}". ` +
      'Spawn it with role "researcher" to get an evidence-backed PASS/FAIL check, or drop output_contract to get a report.'
    );
  }
  if (contract === "artifact" && role !== "builder") {
    return (
      `output_contract "artifact" is only available to builder-typed subagents, and this spawn resolved to "${role}". ` +
      'Spawn it with role "builder" so it can actually produce the artifact, or drop output_contract to get a report.'
    );
  }
  return undefined;
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
 * The result to return instead of spawning when this objective has already run
 * too often inside {@link LOOP_GUARD_WINDOW_MS}, or `undefined` when the spawn
 * should proceed.
 *
 * Two shapes of repetition are held, and they are told apart because the caller
 * has to do something different about each. Completed runs mean an answer
 * exists, so the caller is pointed at it. In-flight runs mean copies of this
 * work are executing right now with nothing to show yet, which is the runaway
 * loop the guard is for: a burst issued faster than anything can finish is
 * invisible to the completed counts for its whole duration. Runs that ended
 * without an answer count as neither, so a retry after a failure is never held.
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
  // runs already fill the allowance is what trips the guard. Completed runs are
  // checked first: when both shapes are present, an answer that already exists
  // is the more actionable thing to hand back.
  let scope: string;
  let tally: SimilarSpawnTally;
  if (recent.conversation.count >= LOOP_GUARD_CONVERSATION_LIMIT) {
    scope = "in this conversation";
    tally = recent.conversation;
  } else if (recent.assistant.count >= LOOP_GUARD_ASSISTANT_LIMIT) {
    scope = "across this assistant";
    tally = recent.assistant;
  } else if (
    recent.conversation.inFlight >= LOOP_GUARD_IN_FLIGHT_CONVERSATION_LIMIT
  ) {
    return inFlightGuardResult(
      recent.conversation.inFlight,
      "this conversation",
    );
  } else if (
    recent.assistant.inFlight >= LOOP_GUARD_IN_FLIGHT_ASSISTANT_LIMIT
  ) {
    return inFlightGuardResult(recent.assistant.inFlight, "this assistant");
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

/**
 * The result handed back when copies of this objective are still executing.
 * Says explicitly that there is nothing to read yet, so the caller waits for
 * the running work instead of being sent after results that do not exist.
 */
function inFlightGuardResult(
  inFlight: number,
  scope: string,
): ToolExecutionResult {
  return {
    content:
      `${inFlight} near-identical subagents are already running in ${scope}, and none of them has returned yet. ` +
      "Another copy would repeat work that is in progress: wait for the running ones to report back, " +
      "or narrow the objective to the part they are not covering. " +
      "If the repetition is intentional, call subagent_spawn again with confirm_repeat: true.",
    isError: false,
  };
}

// ── Advisor consult ──────────────────────────────────────────────────

/**
 * Run the `advisor` role as a synchronous, stronger-model consult and return
 * its guidance as the tool result.
 *
 * The consult sees only what it is handed: the spawning agent's own `objective`
 * as a written brief, plus the situational context pack from
 * `buildAdvisorContext`. Nothing of the parent conversation's transcript or
 * system prompt travels with it, so a consult costs the brief rather than a
 * re-prefill of the whole chat at premium rates.
 *
 * It is framed as advice via `buildAdvisorSystem` and runs on
 * `llm.advisorProfile` (unless the caller passed an explicit
 * `inference_profile`) under both the advisor role allowlist and
 * `denySideEffectTools`, so the only tools it can reach are the first-party
 * built-in readers. It is bounded on two axes, because the consult holds up the
 * user-facing turn while it runs: a progress-aware deadline (an idle window,
 * `ADVISOR_IDLE_TIMEOUT_MS`, reset on every streamed token and every tool event
 * so a reasoning or reading model isn't killed mid-consult, plus an absolute
 * `ADVISOR_MAX_TIMEOUT_MS` backstop), and a ceiling of `ADVISOR_MAX_TOOL_CALLS`
 * tool calls, since tool activity re-arms the idle window and a reading consult
 * would otherwise be bounded only by the backstop. Whichever ceiling is hit, the
 * partial guidance produced so far is recovered and returned with a note saying
 * what cut it short, rather than discarded. Degrades to a benign non-error
 * notice on any other failure (including the depth-limit rejection when a
 * subagent itself calls the advisor).
 */
async function runAdvisorConsult(args: {
  context: ToolContext;
  label: string;
  /** The agent's own `objective`: the brief the advisor advises off. */
  objective: string;
  sendToClient: (msg: AssistantEvent) => void;
  requestedOverrideProfile: string | undefined;
}): Promise<ToolExecutionResult> {
  const { context, label, objective, sendToClient, requestedOverrideProfile } =
    args;

  /** Set when the consult is stopped for reading past its tool ceiling. */
  let stoppedForToolCap = false;
  /** Appended to the guidance when the consult did not run as asked for. */
  let profileNote: string | undefined;

  try {
    // The parent conversation is looked up only for its warm skill catalog, so
    // an unresolvable one (e.g. evicted) costs the skills section of the pack
    // and nothing else: the consult itself runs off the brief.
    const parentConversation = findConversation(context.conversationId);

    // Situational awareness for the advisor: the parent's live tool set, the
    // full skill catalog, and its workspace. Assembled off the per-turn
    // ToolContext snapshot (trust, channel) so the personal-memory sections
    // are gated exactly like the runtime injectors. Best-effort: a null pack
    // just means the consult runs on the brief alone.
    const situationalContext = await buildAdvisorContext({
      conversationId: context.conversationId,
      workingDir: context.workingDir,
      allowedToolNames: context.allowedToolNames,
      trustClass: context.trustClass,
      enabledPluginSet: context.enabledPluginSet,
      // The parent's warm per-turn catalog keeps the synchronous on-disk
      // catalog scan out of the consult path.
      skillCatalog: parentConversation?.skillProjectionCache?.catalog,
    });

    // Default to the stronger advisor profile when the caller did not pin one;
    // an explicit `inference_profile` wins (already forced upstream).
    const config = getConfig();
    let overrideProfile = requestedOverrideProfile ?? config.llm.advisorProfile;
    // The advisor carries read tools, so a profile the catalog states cannot
    // call them is handed a surface it can never use and answers from the
    // brief alone. Fall back to the call site's own default and say so
    // alongside the guidance, the way a regular spawn reports it. The check is
    // unconditional, matching the tools it protects, and only a catalog `false`
    // redirects, so a model the catalog has never heard of is left alone.
    if (
      overrideProfile !== undefined &&
      profileSupportsTools(overrideProfile, config) === false
    ) {
      profileNote = `profile "${overrideProfile}" is not verified for tool calling; the advisor ran on the default profile instead.`;
      // Clearing this is what lands the consult on the subagentSpawn default:
      // the child runs under that call site, so the resolver picks it anyway.
      // Naming it would select the same model but register as an override,
      // which usage attribution reports as a conversation pin, filing a consult
      // that merely fell back against a pin nobody set.
      overrideProfile = undefined;
    }
    const forceOverrideProfile = overrideProfile !== undefined;

    // Progress-aware deadline: reset on every sign of forward progress so the
    // consult isn't killed mid-thought or mid-read, with an absolute backstop.
    // Combine it with the caller's own signal.
    const deadline = createConsultDeadline({
      idleMs: ADVISOR_IDLE_TIMEOUT_MS,
      maxMs: ADVISOR_MAX_TIMEOUT_MS,
    });
    // Tool ceiling, on its own controller so the abort is attributable: the
    // consult is stopped for reading too much, which reads back to the caller
    // differently from running out of time.
    const toolCap = new AbortController();
    const signal = AbortSignal.any(
      context.signal
        ? [context.signal, deadline.signal, toolCap.signal]
        : [deadline.signal, toolCap.signal],
    );
    // Count the child's tool calls off its own event stream. Each executed call
    // emits exactly one `tool_use_start`, enveloped by the manager as a
    // `subagent_event` on its way to the parent's client. The budget is spent
    // in full before the abort fires: the call that trips it is the one past
    // `ADVISOR_MAX_TOOL_CALLS`, so the consult keeps every result inside the
    // budget and loses only the call it was starting.
    let toolCalls = 0;
    const countingSendToClient = (msg: AssistantEvent): void => {
      sendToClient(msg);
      if (!isAdvisorToolCallEvent(msg) || toolCap.signal.aborted) {
        return;
      }
      toolCalls += 1;
      if (toolCalls > ADVISOR_MAX_TOOL_CALLS) {
        stoppedForToolCap = true;
        log.warn(
          { conversationId: context.conversationId, toolCalls },
          "Advisor consult exceeded its tool ceiling; returning guidance so far",
        );
        toolCap.abort();
      }
    };
    // Streamed tokens AND tool activity both count as progress. A consult that
    // opens a file emits no token while the read runs, so token-only progress
    // would let the idle window lapse on a healthy advisor and abort it before
    // the model ever sees its tool result. The absolute backstop is untouched,
    // so a stalled tool cannot extend the consult past `ADVISOR_MAX_TIMEOUT_MS`.
    const onProgress = (): void => {
      deadline.recordProgress();
    };
    // Streamed chunks additionally forward to the caller's stream sink.
    const onText = (chunk: string): void => {
      context.onOutput?.(chunk);
    };

    try {
      const advice = await getSubagentManager().spawnAndAwait(
        {
          parentConversationId: context.conversationId,
          label,
          // The agent's own objective IS the brief the consult runs on, so it
          // carries into the request verbatim. The situational pack rides in
          // the model request only (`requestText`), keeping the system prompt
          // minimal and the display-facing `objective` free of bulky internal
          // context.
          objective: advisorRequestText(objective),
          requestText: advisorRequestText(objective, situationalContext),
          sendResultToUser: false,
          role: "advisor",
          // The advisor's read-only guarantee cannot rest on tool NAMES. A
          // workspace tool may register under `file_read` (registerWorkspaceTools
          // stashes the built-in and installs its own implementation), and a
          // name-only role allowlist would hand the advisor that implementation
          // to execute. The owner-aware read-only gate that closes this comes
          // from `denySideEffects` on the advisor's registry entry, so every
          // path that projects the role applies it, this spawn and the
          // `tools list --agent advisor` preview alike.
          //
          // The advisor is a ROLE, not an `LLMCallSiteEnum` value, so its usage
          // lands under `subagentSpawn` like any other subagent. This is what
          // makes advisor consults separable from regular spawns in telemetry.
          spawnMode: "advisor_consult",
          systemPromptOverride: buildAdvisorSystem(),
          ...(overrideProfile ? { overrideProfile } : {}),
          ...(forceOverrideProfile ? { forceOverrideProfile: true } : {}),
          // A consult is delegated work of the invoking turn, so its spend
          // attributes to the same firing.
          ...(context.cronRunId ? { cronRunId: context.cronRunId } : {}),
          ...(context.toolUseId ? { parentToolUseId: context.toolUseId } : {}),
        },
        countingSendToClient,
        { signal, onText, onProgress },
      );

      const trimmed = advice.trim();
      return {
        content: withAdvisorNote(
          trimmed.length > 0 ? trimmed : "(advisor returned no guidance)",
          profileNote,
        ),
        isError: false,
      };
    } finally {
      deadline.dispose();
    }
  } catch (err) {
    // Cut short mid-generation: salvage whatever guidance the advisor had
    // written rather than throwing it away. Partial strategic advice is far
    // more useful to the agent than an "unavailable" notice — especially on a
    // slow reasoning profile that needs most of the window to think. The note
    // names which ceiling stopped it, because "it ran out of time" and "it was
    // still reading" call for different follow-ups from the caller.
    if (err instanceof SubagentAbortedError) {
      const partial = err.partialText.trim();
      if (partial.length > 0) {
        log.warn(
          { conversationId: context.conversationId, stoppedForToolCap },
          "Advisor consult was cut short; returning partial guidance",
        );
        return {
          content: withAdvisorNote(
            partial,
            stoppedForToolCap
              ? `The advisor used its full budget of ${ADVISOR_MAX_TOOL_CALLS} tool calls and answered with what it had read, so the guidance above may be incomplete.`
              : "The advisor reached its time limit while still writing, so the guidance above may be cut off.",
            profileNote,
          ),
          isError: false,
        };
      }
      if (stoppedForToolCap) {
        return {
          content: withAdvisorNote(
            `(advisor used its full budget of ${ADVISOR_MAX_TOOL_CALLS} tool calls without writing any guidance: narrow the question, or point it at the specific file or decision you want checked)`,
            profileNote,
          ),
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
 * Whether a parent-bound event is a child tool call starting. The manager
 * envelopes every child event as `subagent_event`, so the consult reads the
 * inner event to see what the advisor is doing.
 */
function isAdvisorToolCallEvent(msg: AssistantEvent): boolean {
  if (msg.type !== "subagent_event") {
    return false;
  }
  const inner = (msg as { event?: { type?: string } }).event;
  return inner?.type === "tool_use_start";
}

/**
 * The guidance with any notes about how the consult actually ran appended
 * below it. Notes are italicized asides so the guidance itself stays the
 * result; nothing is appended when there is nothing to say.
 */
function withAdvisorNote(
  guidance: string,
  ...notes: (string | undefined)[]
): string {
  const present = notes.filter((note): note is string => Boolean(note));
  if (present.length === 0) {
    return guidance;
  }
  return `${guidance}\n\n${present.map((note) => `_(${note})_`).join("\n")}`;
}
