import { z } from "zod";

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
import { getSubagentManager } from "../../subagent/index.js";
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

const log = getLogger("subagent-spawn");

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

  // The advisor answers the agent, not the user, so its guidance is always
  // internal. For fork mode, sendResultToUser defaults to false unless
  // explicitly set to true. For regular mode it defaults to true.
  const isAdvisor = resolvedRole.role === "advisor";
  const sendResultToUser =
    !isAdvisor &&
    (fork
      ? input.send_result_to_user === true
      : input.send_result_to_user !== false);

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

  // ── Repeat-spawn guard ───────────────────────────────────────────
  // Re-running an objective that already completed several times in the last
  // day buys the same answer twice, so the guard hands the repetition back to
  // the caller with what it has already cost. It never blocks: `confirm_repeat`
  // always spawns.
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

  // An advisor never forks: it advises off the brief alone, so inheriting the
  // parent transcript would both defeat the framing and re-prefill the whole
  // chat at advisor rates. `fork` is ignored for it, the way `context` is.
  if (fork && !isAdvisor) {
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
  if (inheritedOverrideProfile === undefined && isAdvisor) {
    // A consult is worth having only when it brings a stronger read than the
    // agent's own, so the advisor runs on `llm.advisorProfile` unless the
    // caller pinned a profile itself.
    inheritedOverrideProfile = llm.advisorProfile;
    forceOverrideProfile = inheritedOverrideProfile !== undefined;
  }
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
    // Every type carries read tools, so a profile the catalog states cannot
    // call them is handed a surface it can never use. Fall back to the call
    // site's own default and say so on the result. Only a catalog `false`
    // redirects, so a model the catalog has never heard of is left alone.
    const requested = requestedOverrideProfile !== undefined;
    profileNote =
      `${requested ? "requested profile" : "profile"} "${inheritedOverrideProfile}" ` +
      "is not verified for tool calling; ran on the default profile instead.";
    inheritedOverrideProfile = undefined;
    forceOverrideProfile = false;
  }

  const roleNote = resolvedRoleNote(resolvedRole);
  const advisorFields = isAdvisor
    ? await buildAdvisorFields(context, objective)
    : undefined;

  try {
    const subagentId = await manager.spawn(
      {
        parentConversationId: context.conversationId,
        label,
        objective,
        ...(isAdvisor ? {} : { context: extraContext }),
        sendResultToUser,
        // The resolved type is passed for every spawn, fork and advisor
        // included: a fork that named no role resolves to `builder`, which
        // imposes no allowlist, so it keeps the parent's tool surface, which is
        // what the system prompt it inherits describes. The advisor's role is
        // what carries its allowlist and its `denySideEffects` read-only gate.
        role: resolvedRole.role,
        ...(resolvedRole.personaText
          ? { persona: resolvedRole.personaText }
          : {}),
        ...(outputContract ? { outputContract } : {}),
        // Declare the spawn mode so delegated LLM spend is separable in
        // telemetry: every variety shares `llm_call_site = "subagentSpawn"`,
        // and a fork's inherited transcript costs very differently from a
        // fresh objective-only spawn. The advisor is a ROLE, not an
        // `LLMCallSiteEnum` value, so its mode is what makes consults
        // separable from regular spawns.
        spawnMode: isAdvisor ? "advisor_consult" : fork ? "fork" : "regular",
        ...advisorFields,
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
        ...(fork && !isAdvisor ? { isFork: true } : {}),
        ...(profileNote ? { note: profileNote } : {}),
        ...(roleNote ? { roleNote } : {}),
        message: spawnedMessage({
          label,
          isAdvisor,
          isFork: fork && !isAdvisor,
        }),
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
 * The spawn-config fields that turn a background child into an advisor
 * consult: the advice framing, and the brief it advises off.
 *
 * The consult sees only what it is handed. The spawning agent's own
 * `objective` IS the brief, so it carries into the request verbatim inside
 * `requestText`, together with the situational pack from
 * `buildAdvisorContext`. Nothing of the parent conversation's transcript or
 * system prompt travels with it, so a consult costs the brief rather than a
 * re-prefill of the whole chat at premium rates.
 *
 * `objective` is left to the caller's raw brief, unframed: it is the field the
 * durable row and the subagent detail panel show, and the field the
 * repeat-spawn guard folds, so a consult has to record it the same way every
 * other spawn does or the guard could never match one consult against another.
 *
 * The context pack is best effort: the parent conversation is looked up only
 * for its warm skill catalog, so an unresolvable one (e.g. evicted) costs the
 * skills section of the pack and nothing else.
 */
async function buildAdvisorFields(
  context: ToolContext,
  objective: string,
): Promise<{
  requestText: string;
  systemPromptOverride: string;
}> {
  const parentConversation = findConversation(context.conversationId);
  // Situational awareness for the advisor: the parent's live tool set, the
  // full skill catalog, and its workspace. Assembled off the per-turn
  // ToolContext snapshot (trust, channel) so the personal-memory sections are
  // gated exactly like the runtime injectors. A null pack just means the
  // consult runs on the brief alone.
  const situationalContext = await buildAdvisorContext({
    conversationId: context.conversationId,
    workingDir: context.workingDir,
    allowedToolNames: context.allowedToolNames,
    trustClass: context.trustClass,
    enabledPluginSet: context.enabledPluginSet,
    // The parent's warm per-turn catalog keeps the synchronous on-disk catalog
    // scan out of the spawn path.
    skillCatalog: parentConversation?.skillProjectionCache?.catalog,
  });
  return {
    requestText: advisorRequestText(objective, situationalContext),
    systemPromptOverride: buildAdvisorSystem(),
  };
}

/**
 * What the spawn tool tells the model it just started. Every variety returns
 * immediately and reports back through the terminal notification, so each
 * message says the same thing in the vocabulary of the type that ran.
 */
function spawnedMessage(opts: {
  label: string;
  isAdvisor: boolean;
  isFork: boolean;
}): string {
  const { label, isAdvisor, isFork } = opts;
  if (isAdvisor) {
    return (
      `Advisor "${label}" is thinking in the background. Its guidance arrives as a notification when it finishes - ` +
      "do NOT poll subagent_status. Keep working on the task; weigh the guidance in when it lands."
    );
  }
  if (isFork) {
    return `Forked subagent "${label}" spawned with full parent context. You will be notified automatically when it completes or fails - do NOT poll subagent_status. Continue the conversation normally.`;
  }
  return `Subagent "${label}" spawned. You will be notified automatically when it completes or fails - do NOT poll subagent_status. Continue the conversation normally.`;
}

// ── Output contract ──────────────────────────────────────────────────

/**
 * Why the requested `output_contract` cannot run under the type this spawn
 * resolved to, or `undefined` when the pairing is fine.
 *
 * The two non-default contracts each need a capability only one type has: a
 * verdict is a claim about what already exists, which is the read-only
 * researcher's job, and an artifact has to be written, which only a builder
 * can do. The advisor takes no contract at all: it answers in its own advice
 * framing, and its child never sees a built system prompt or fork framing to
 * render one into. That includes an explicit `report`, which is checked against
 * the advisor before it is waved through as the default everywhere else: the
 * caller asked for a shape the consult cannot produce, and only an omitted
 * contract means it never asked.
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
      `output_contract "${contract}" does not apply to the advisor: it answers with guidance in its own shape. ` +
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
