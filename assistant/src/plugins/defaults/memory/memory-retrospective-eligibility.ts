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
// Four dimensions decide it, and all four live here:
//   - the memory master switch and the retrospective switch;
//   - the conversation's identity (its type and source);
//   - the actor's trust, which every trigger path gates on;
//   - nothing else. The tail-dependent gates (user activity, cooldown,
//     thresholds) are the funnel's own, and are what makes an eligible
//     conversation's review conditional rather than promised.
//
// Pure: takes every input as a value, so the funnel (config singleton, DB
// row, caller-supplied trust) and the injector (plugin config accessor,
// `TurnContext`) can each supply them from the seam they already have.

import { AUTO_ANALYSIS_SOURCE } from "../../../persistence/auto-analysis-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../persistence/conversation-types.js";
import { resolveCapabilities } from "../../../runtime/capabilities.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";

/**
 * The trust semantic every retrospective trigger shares: the guardian, plus
 * legacy rows that never recorded provenance.
 *
 * Deliberately NOT `resolveCapabilities(...).canAccessMemory`, which reads
 * `undefined` as the `unknown` class and would drop the legacy/desktop
 * guardian conversations whose messages predate provenance stamping. The two
 * agree on every named class: the guardian writes memory and triggers a pass,
 * and `trusted_contact` / `unverified_contact` / `unknown` do neither. The
 * retrospective job runs under guardian trust with `remember`, so admitting a
 * contact-audience conversation would write its content across the memory
 * trust boundary.
 */
export function isRetrospectiveTrustedActor(
  trustClass: string | undefined,
): boolean {
  return trustClass === "guardian" || trustClass === undefined;
}

/**
 * Why a later pass never reviews a conversation, in precedence order: the
 * memory master switch first (nothing memory-shaped runs), the retrospective
 * switch second, then the conversation's own identity, then the actor. The
 * conversation reasons are reported ahead of `untrusted_actor` because they
 * are permanent facts about the conversation, while the actor reason is
 * scoped to the turn in hand.
 */
export type RetrospectiveIneligibilityReason =
  | "memory_disabled"
  | "retrospective_disabled"
  | "retrospective_conversation"
  | "consolidation"
  | "auto_analysis"
  | "scheduled"
  | "untrusted_actor";

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
  /**
   * Trust of the actor this decision is about, read through
   * {@link isRetrospectiveTrustedActor}. Each caller supplies the actor its
   * own trigger gates on: the post-turn indexer the message's provenance, the
   * sweep the conversation's recent provenance, the compaction site the
   * turn's trust context (falling back to the conversation's provenance), and
   * the injector the live turn's trust class. `undefined` is the legacy
   * no-provenance case and counts as trusted.
   */
  actorTrustClass: string | undefined;
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
  if (!isRetrospectiveTrustedActor(input.actorTrustClass)) {
    return { status: "ineligible", reason: "untrusted_actor" };
  }
  return { status: "conditional" };
}

/**
 * What the model should be told about memory capture on one turn: whether a
 * later pass may review the conversation, and whether this turn can write
 * memory at all.
 *
 * `canWriteMemory` is every gate a `remember` call has to clear, in the same
 * order the runtime applies them: the memory master switch (which hides the
 * tool), the actor's memory capability (which its executor refuses under),
 * and the turn's resolved tool surface (a wire-scoped background run or a
 * subagent allowlist that omits it, read-only mode, disk-pressure cleanup, a
 * workspace `tools.exclude` entry). Consolidation and the researcher and
 * advisor subagent roles all run guardian-trust with allowlists that omit
 * `remember`, so trust alone would advertise a tool they cannot call.
 */
export interface MemoryCaptureGuidance {
  laterPass: RetrospectiveEligibility;
  canWriteMemory: boolean;
}

export function resolveMemoryCaptureGuidance(
  input: Omit<RetrospectiveEligibilityInput, "actorTrustClass"> & {
    trustClass: string | undefined;
    /**
     * Whether `remember` resolves onto this turn's tool surface. Omitted
     * means "not known to be absent": a caller with no live conversation to
     * resolve the surface from makes no claim about it.
     */
    rememberToolAvailable?: boolean;
  },
): MemoryCaptureGuidance {
  return {
    laterPass: classifyRetrospectiveEligibility({
      ...input,
      actorTrustClass: input.trustClass,
    }),
    canWriteMemory:
      input.memoryEnabled &&
      resolveCapabilities(input.trustClass).canAccessMemory &&
      input.rememberToolAvailable !== false,
  };
}

/**
 * The one line the `memory-capture-guidance` injector renders. A turn that
 * cannot write memory is told so and never pointed at `remember`; a turn
 * that can write is told whether a later pass is coming and that anything
 * which must survive is saved now either way.
 *
 * The `untrusted_actor` copy is deliberately turn-scoped. A conversation the
 * guardian also speaks in stays reviewable, and that review covers the whole
 * window including this turn, so "no later pass reviews this conversation"
 * would overclaim; what is certainly true is that this turn triggers none.
 */
export function renderMemoryCaptureGuidance(
  guidance: MemoryCaptureGuidance,
): string {
  const { laterPass, canWriteMemory } = guidance;
  if (!canWriteMemory) {
    if (laterPass.status === "ineligible") {
      switch (laterPass.reason) {
        case "memory_disabled":
          return "Memory is off for this assistant: nothing from this conversation is saved, now or later.";
        case "untrusted_actor":
          return "You cannot save memory on this turn, and this turn does not trigger a later memory pass.";
        default:
          return "You cannot save memory on this turn, and no later memory pass reviews this conversation.";
      }
    }
    return "You cannot save memory on this turn. A later memory pass may review this conversation but is not guaranteed.";
  }
  if (laterPass.status === "ineligible") {
    return "No later memory pass reviews this conversation. Anything that must survive it has to be saved with `remember` now.";
  }
  return "A later memory pass may review this conversation but is not guaranteed. Anything that must survive still has to be saved with `remember` now.";
}
