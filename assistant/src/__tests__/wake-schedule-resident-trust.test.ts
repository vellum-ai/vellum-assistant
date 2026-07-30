/**
 * A scheduled wake must reach the same trust whether its target conversation is
 * cold or still resident from an earlier guardian turn.
 *
 * `wake-schedule-trust.test.ts` covers what a row must prove to recover trust,
 * asserted on the {@link WakeOptions} the row produces. That shape is only half
 * the answer: the class a woken turn actually runs at is what tool setup reads
 * off the conversation (`resolveEffectiveTurnTrust`), and a conversation that is
 * still in memory from a guardian interaction is resting at guardian. So these
 * tests drive the real wake against a resident target and assert the trust the
 * tool executor would see mid-run, plus that the conversation is left exactly as
 * the wake found it.
 *
 * The doubles stand in for the two halves of the live path:
 * - `resolveTarget` mirrors `getOrCreateConversation`'s trust application
 *   (`daemon/conversation-store.ts`), which the default resolver threads
 *   `WakeOptions.trustContext` into. The threading itself is pinned by
 *   `runtime/__tests__/agent-wake.test.ts`.
 * - the conversation double carries the two trust fields tool setup reads and
 *   records the effective trust at `agentLoop.run` time.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../daemon/trust-context-types.js";
import type { Message } from "../providers/types.js";

/** Stored `origin_channel` per conversation id, read by resting-trust recovery. */
const originChannels = new Map<string, string | null>();

mock.module("../persistence/conversation-crud.js", () => ({
  getConversation: (conversationId: string) =>
    originChannels.has(conversationId)
      ? {
          id: conversationId,
          originChannel: originChannels.get(conversationId) ?? null,
          archivedAt: null,
        }
      : undefined,
  getConversationOverrideProfile: () => undefined,
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
}));

// The wake's persistence and client-broadcast boundary. These tests are about
// the trust the run executes under, so the boundary is stubbed out entirely.
mock.module("../daemon/wake-conversation-ops.js", () => ({
  persistWakeTriggerMessage: async () => {},
  persistWakeTailMessage: async () => {},
  emitWakeAgentEvent: () => {},
  broadcastWakeSurface: () => {},
  scopeWakeAllowedTools: () => () => {},
}));

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  INTERNAL_GUARDIAN_TRUST_CONTEXT,
  resolveEffectiveTurnTrust,
  resolveTrustClass,
} from "../daemon/trust-context.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
  type WakeOptions,
} from "../runtime/agent-wake.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import {
  LEGACY_DEFER_CREATED_BY,
  OWNER_DEFER_CREATED_BY,
} from "../schedule/defer-provenance.js";
import { buildWakeScheduleOptions } from "../schedule/wake-schedule-options.js";
import { resolveSensitiveToolDecision } from "../tools/tool-approval-handler.js";

const TARGET = "conv-guardian-owned";

/** A row as `createOwnerDeferredWake` writes it. */
const OWNER_WAKE_JOB = {
  message: "Check back on this",
  inferenceProfile: null,
  createdBy: OWNER_DEFER_CREATED_BY,
  createdFromConversationId: TARGET,
};

/** The guardian trust a conversation is resting at after an owner's turn. */
const RESTING_GUARDIAN_TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

interface WakeTargetDouble {
  conversation: Conversation;
  /** Effective turn trust captured inside `agentLoop.run`, one per run. */
  trustDuringRun: TrustContext[];
  /** What each firing handed the conversation store to hydrate under. */
  hydrationTrust: Array<TrustContext | undefined>;
  /** `conversation.trustContext` as it stands now. */
  restingTrust: () => TrustContext | undefined;
  /** `conversation.currentTurnTrustContext` as it stands now. */
  turnTrust: () => TrustContext | undefined;
}

/**
 * A conversation double carrying the members the wake touches. `restingTrust`
 * seeds both trust fields the way an in-memory conversation looks right after a
 * turn by that actor finished: the persistent context plus the per-turn
 * snapshot that turn left behind.
 */
function makeWakeTarget(options: {
  conversationId: string;
  restingTrust?: TrustContext;
}): WakeTargetDouble {
  const messages: Message[] = [];
  let processing = false;
  const trustDuringRun: TrustContext[] = [];

  const conversation = {
    conversationId: options.conversationId,
    trustContext: options.restingTrust,
    currentTurnTrustContext: options.restingTrust,
    agentLoop: {
      run: async ({ messages: input }: { messages: Message[] }) => {
        trustDuringRun.push(resolveEffectiveTurnTrust(conversation));
        return { history: input, exitReason: null, newMessages: [] };
      },
    },
    messages,
    getMessages: () => messages,
    isProcessing: () => processing,
    waitForIdle: async () => !processing,
    setProcessing: (on: boolean) => {
      processing = on;
    },
    setTrustContext(ctx: TrustContext | null) {
      // Mirrors Conversation.setTrustContext (coerces null → undefined).
      conversation.trustContext = ctx ?? undefined;
    },
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {},
    maybeCompact: async () => null,
    contextWindowManager: { estimateInputTokens: () => 0 },
    buildCurrentSystemPrompt: () => "mock-system-prompt",
    modelOverride: undefined,
  } as unknown as Conversation & { trustContext?: TrustContext };

  return {
    conversation: conversation as Conversation,
    trustDuringRun,
    hydrationTrust: [],
    restingTrust: () => conversation.trustContext,
    turnTrust: () => conversation.currentTurnTrustContext,
  };
}

/**
 * Fire `options` against `target` through the resolution the default resolver
 * performs: it hands `getOrCreateConversation` the wake's context or nothing at
 * all, and the store applies that to a resident conversation only when it is
 * something. A firing that recovered no trust must arrive as nothing, so the
 * conversation's own resting trust survives the wake untouched.
 */
async function fireWake(
  options: WakeOptions,
  target: WakeTargetDouble,
): Promise<void> {
  await wakeAgentForOpportunity(options, {
    resolveTarget: async (opts) => {
      const hydrationTrust = opts.trustContext ?? undefined;
      target.hydrationTrust.push(hydrationTrust);
      if (hydrationTrust !== undefined) {
        target.conversation.setTrustContext(hydrationTrust);
      }
      return target.conversation;
    },
  });
}

/** The decision the sensitive-tool gate reaches for a `bash` call at `trust`. */
function gateDecision(
  trust: TrustContext,
  reach: "sandbox" | "host" = "sandbox",
): string {
  const { sensitiveToolApproval } = resolveCapabilities(
    resolveTrustClass(trust),
  );
  return resolveSensitiveToolDecision({
    reach,
    cellThreshold: undefined,
    sensitiveToolApproval,
  });
}

/** Register `conversation` as resident for the duration of `run`. */
async function withResidentConversation(
  target: WakeTargetDouble,
  run: () => Promise<void>,
): Promise<void> {
  setConversation(target.conversation.conversationId, target.conversation);
  try {
    await run();
  } finally {
    deleteConversation(target.conversation.conversationId);
  }
}

beforeEach(() => {
  __resetWakeChainForTests();
  originChannels.clear();
  originChannels.set(TARGET, null);
});

/**
 * Every row shape that proves nothing: legacy provenance, an unmarked schedule,
 * a marked row with no source binding, and a marked row retargeted away from
 * the conversation it was created in. Each one fires against a guardian-owned
 * target, so the only thing standing between it and the guardian's tools is the
 * class its turn runs at.
 */
type WakeJob = Parameters<typeof buildWakeScheduleOptions>[0];

const UNPROVEN_ROWS: Array<{ label: string; job: WakeJob }> = [
  {
    label: "a legacy defer",
    job: { ...OWNER_WAKE_JOB, createdBy: LEGACY_DEFER_CREATED_BY },
  },
  {
    label: "an unmarked wake schedule",
    job: { ...OWNER_WAKE_JOB, createdBy: "agent" },
  },
  {
    label: "a marked row with no source binding",
    job: { ...OWNER_WAKE_JOB, createdFromConversationId: null },
  },
  {
    label: "a marked row retargeted away from its source",
    job: { ...OWNER_WAKE_JOB, createdFromConversationId: "conv-elsewhere" },
  },
];

describe("a wake that recovers no trust runs fail-closed on a resident target", () => {
  for (const { label, job } of UNPROVEN_ROWS) {
    test(`${label} cannot reach sensitive tools`, async () => {
      const target = makeWakeTarget({
        conversationId: TARGET,
        restingTrust: RESTING_GUARDIAN_TRUST,
      });

      await withResidentConversation(target, () =>
        fireWake(buildWakeScheduleOptions(job, TARGET), target),
      );

      expect(target.trustDuringRun).toHaveLength(1);
      expect(target.trustDuringRun[0]!.trustClass).toBe("unknown");
      expect(gateDecision(target.trustDuringRun[0]!)).toBe("deny");
    });
  }

  test("an owner-authored row on a remote-origin target cannot reach them either", async () => {
    // The row proves its author, but trust comes from the conversation the wake
    // lands in, and a remote-channel conversation recovers none. Residency must
    // not substitute for what the target could not supply.
    originChannels.set("conv-remote", "telegram");
    const target = makeWakeTarget({
      conversationId: "conv-remote",
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    await withResidentConversation(target, () =>
      fireWake(
        buildWakeScheduleOptions(
          { ...OWNER_WAKE_JOB, createdFromConversationId: "conv-remote" },
          "conv-remote",
        ),
        target,
      ),
    );

    expect(target.trustDuringRun[0]!.trustClass).toBe("unknown");
  });

  test("an unrecognized stored origin cannot reach them either", async () => {
    // A value outside the canonical channel set (newer build, renamed channel,
    // corrupted row) lands where a remote channel lands.
    originChannels.set("conv-future", "channel-from-a-newer-build");
    const target = makeWakeTarget({
      conversationId: "conv-future",
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    await withResidentConversation(target, () =>
      fireWake(
        buildWakeScheduleOptions(
          { ...OWNER_WAKE_JOB, createdFromConversationId: "conv-future" },
          "conv-future",
        ),
        target,
      ),
    );

    expect(target.trustDuringRun[0]!.trustClass).toBe("unknown");
  });

  test("the cold target reaches the same class as the resident one", async () => {
    // The parity this whole file exists for: same row, same verdict, whether or
    // not the conversation was still in memory.
    const cold = makeWakeTarget({ conversationId: TARGET });
    const resident = makeWakeTarget({
      conversationId: TARGET,
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    const options = buildWakeScheduleOptions(
      { ...OWNER_WAKE_JOB, createdBy: LEGACY_DEFER_CREATED_BY },
      TARGET,
    );
    await fireWake(options, cold);
    __resetWakeChainForTests();
    await withResidentConversation(resident, () => fireWake(options, resident));

    expect(resident.trustDuringRun[0]).toEqual(cold.trustDuringRun[0]!);
  });
});

describe("the wake leaves a resident conversation as it found it", () => {
  test("a fail-closed wake restores the turn snapshot and never rewrites the resting trust", async () => {
    // The fail-closed class is scoped to the woken turn. A queued user message
    // draining behind the wake reads the conversation's resting trust, so the
    // wake must not leave its own class sitting on either field.
    const target = makeWakeTarget({
      conversationId: TARGET,
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    await withResidentConversation(target, () =>
      fireWake(
        buildWakeScheduleOptions(
          { ...OWNER_WAKE_JOB, createdBy: LEGACY_DEFER_CREATED_BY },
          TARGET,
        ),
        target,
      ),
    );

    // Nothing was handed to hydration either, so the resting trust was never
    // rewritten on the way in and put back on the way out: it was never touched.
    expect(target.hydrationTrust).toEqual([undefined]);
    expect(target.restingTrust()).toEqual(RESTING_GUARDIAN_TRUST);
    expect(target.turnTrust()).toEqual(RESTING_GUARDIAN_TRUST);
    expect(gateDecision(resolveEffectiveTurnTrust(target.conversation))).toBe(
      "proceed",
    );
  });

  test("an elevating wake restores the prior turn snapshot too", async () => {
    const target = makeWakeTarget({
      conversationId: TARGET,
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    await withResidentConversation(target, () =>
      fireWake(buildWakeScheduleOptions(OWNER_WAKE_JOB, TARGET), target),
    );

    expect(target.trustDuringRun[0]).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
    expect(target.turnTrust()).toEqual(RESTING_GUARDIAN_TRUST);
    expect(target.restingTrust()).toEqual(RESTING_GUARDIAN_TRUST);
  });
});

describe("an owner-authored defer still resumes at the target's own trust", () => {
  test("a resident guardian-owned target keeps its sensitive tools", async () => {
    const target = makeWakeTarget({
      conversationId: TARGET,
      restingTrust: RESTING_GUARDIAN_TRUST,
    });

    await withResidentConversation(target, () =>
      fireWake(buildWakeScheduleOptions(OWNER_WAKE_JOB, TARGET), target),
    );

    expect(target.trustDuringRun[0]!.trustClass).toBe("guardian");
    expect(gateDecision(target.trustDuringRun[0]!)).toBe("proceed");
    expect(gateDecision(target.trustDuringRun[0]!, "host")).toBe("proceed");
  });

  test("a cold guardian-owned target reaches the same class", async () => {
    const target = makeWakeTarget({ conversationId: TARGET });

    await fireWake(buildWakeScheduleOptions(OWNER_WAKE_JOB, TARGET), target);

    expect(target.trustDuringRun[0]).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  });
});
