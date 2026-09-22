// ---------------------------------------------------------------------------
// Memory retrospective: eligibility, and the per-turn capture guidance that
// derives from it.
// ---------------------------------------------------------------------------
//
// One statement of which conversations a later memory pass can review. The
// enqueue funnel (`memory-retrospective-enqueue.ts`) reads it to decide
// whether to queue a retrospective, and the `memory-capture-guidance`
// injector (`injectors.ts`) reads it to tell the model, on every turn, what
// that decision means for the fact in front of it. The two must never
// diverge: a turn told "a later pass may review this" while the funnel would
// skip it is exactly the false promise the `remember` description used to
// make. The retrospective sweep's SQL filter mirrors the type and source
// reasons here and is pinned to them by a parity test.
//
// Pure: takes the conversation row's type and source plus the two config
// switches as values, so the funnel (config singleton, DB row) and the
// injector (plugin config accessor, `TurnContext`) can each supply them from
// the seam they already have.

import { AUTO_ANALYSIS_SOURCE } from "../../../persistence/auto-analysis-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../persistence/conversation-types.js";
import { resolveCapabilities } from "../../../runtime/capabilities.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";

/**
 * Why a later pass never reviews a conversation, in precedence order: the
 * memory master switch first (nothing memory-shaped runs), the retrospective
 * switch second, then the conversation's own identity.
 */
export type RetrospectiveIneligibilityReason =
  | "memory_disabled"
  | "retrospective_disabled"
  | "retrospective_conversation"
  | "consolidation"
  | "auto_analysis"
  | "scheduled";

/**
 * `ineligible`: no later pass reviews this conversation, for `reason`.
 * `conditional`: a later pass may review it, subject to the tail-dependent
 * gates the funnel applies per trigger (user activity, cooldown, thresholds),
 * so it is never guaranteed.
 */
export type RetrospectiveEligibility =
  | { status: "ineligible"; reason: RetrospectiveIneligibilityReason }
  | { status: "conditional" };

export interface RetrospectiveEligibilityInput {
  conversationType: string;
  source: string;
  /** `memory.enabled !== false`. */
  memoryEnabled: boolean;
  /** `memory.retrospective.enabled`. */
  retrospectiveEnabled: boolean;
}

/**
 * Classify a conversation for the retrospective. `scheduled` is the only
 * conversation type excluded; `background` (heartbeat) conversations are
 * conditional like standard ones. Sources are excluded when the pass would
 * review its own output (a retrospective conversation), content already
 * persisted to the corpus (a consolidation run), or a retired
 * auto-analysis row.
 */
export function classifyRetrospectiveEligibility(
  input: RetrospectiveEligibilityInput,
): RetrospectiveEligibility {
  if (!input.memoryEnabled) {
    return { status: "ineligible", reason: "memory_disabled" };
  }
  if (!input.retrospectiveEnabled) {
    return { status: "ineligible", reason: "retrospective_disabled" };
  }
  if (isMemoryRetrospectiveSource(input.source)) {
    return { status: "ineligible", reason: "retrospective_conversation" };
  }
  if (input.source === MEMORY_V2_CONSOLIDATION_SOURCE) {
    return { status: "ineligible", reason: "consolidation" };
  }
  if (input.source === AUTO_ANALYSIS_SOURCE) {
    return { status: "ineligible", reason: "auto_analysis" };
  }
  if (input.conversationType === "scheduled") {
    return { status: "ineligible", reason: "scheduled" };
  }
  return { status: "conditional" };
}

/**
 * What the model should be told about memory capture on one turn: whether a
 * later pass may review the conversation, and whether this turn can write
 * memory at all. `canWriteMemory` is derived from the two authorities
 * `remember` itself answers to: the tool is absent from the surface when
 * memory is off, and its executor refuses when the actor's trust class has
 * no memory capability (`resolveCapabilities(trustClass).canAccessMemory`).
 */
export interface MemoryCaptureGuidance {
  laterPass: RetrospectiveEligibility;
  canWriteMemory: boolean;
}

export function resolveMemoryCaptureGuidance(
  input: RetrospectiveEligibilityInput & { trustClass: string | undefined },
): MemoryCaptureGuidance {
  return {
    laterPass: classifyRetrospectiveEligibility(input),
    canWriteMemory:
      input.memoryEnabled &&
      resolveCapabilities(input.trustClass).canAccessMemory,
  };
}

/**
 * The one line the `memory-capture-guidance` injector renders. A turn that
 * cannot write memory is told so and never pointed at `remember`; a turn
 * that can write is told whether a later pass is coming and that anything
 * which must survive is saved now either way.
 */
export function renderMemoryCaptureGuidance(
  guidance: MemoryCaptureGuidance,
): string {
  const { laterPass, canWriteMemory } = guidance;
  if (!canWriteMemory) {
    if (laterPass.status === "ineligible") {
      return laterPass.reason === "memory_disabled"
        ? "Memory is off for this assistant: nothing from this conversation is saved, now or later."
        : "You cannot save memory on this turn, and no later memory pass reviews this conversation.";
    }
    return "You cannot save memory on this turn. A later memory pass may review this conversation but is not guaranteed.";
  }
  if (laterPass.status === "ineligible") {
    return "No later memory pass reviews this conversation. Anything that must survive it has to be saved with `remember` now.";
  }
  return "A later memory pass may review this conversation but is not guaranteed. Anything that must survive still has to be saved with `remember` now.";
}
