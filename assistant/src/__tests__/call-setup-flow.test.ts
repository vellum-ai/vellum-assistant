import { describe, expect, test } from "bun:test";

import {
  CallSetupFlow,
  type CallSetupFlowDeps,
  UnsupportedSetupFlowError,
} from "../calls/call-setup-flow.js";
import type {
  SetupFlowResult,
  SetupFlowState,
  SetupFlowTransport,
} from "../calls/call-setup-flow-types.js";
import type { MediaStreamOutput } from "../calls/media-stream-output.js";
import type {
  SetupOutcome,
  SetupResolved,
} from "../calls/relay-setup-router.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { TrustClass } from "../runtime/trust-class.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALL_SESSION_ID = "call-session-1";
const PHONE_NUMBER = "+15555550100";

function makeResolved(trustClass: TrustClass = "guardian"): SetupResolved {
  return {
    assistantId: "self",
    isInbound: true,
    otherPartyNumber: PHONE_NUMBER,
    actorTrust: {
      canonicalSenderId: PHONE_NUMBER,
      guardianBindingMatch: null,
      memberRecord: null,
      trustClass,
      actorMetadata: {
        identifier: PHONE_NUMBER,
        displayName: undefined,
        senderDisplayName: undefined,
        memberDisplayName: undefined,
        username: undefined,
        channel: "phone",
        trustStatus: trustClass,
      },
    },
  };
}

function createFakeTransport() {
  const spokenTokens: Array<{ token: string; last: boolean }> = [];
  const endReasons: Array<string | undefined> = [];
  const transport: SetupFlowTransport = {
    sendTextToken: (token, last) => {
      spokenTokens.push({ token, last });
    },
    endSession: (reason) => {
      endReasons.push(reason);
    },
    requiresWavAudio: true,
  };
  return { transport, spokenTokens, endReasons };
}

function createFlow(overrides?: Partial<CallSetupFlowDeps>) {
  const fake = createFakeTransport();
  const spoken: string[] = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const events: Array<{
    eventType: string;
    payload?: Record<string, unknown>;
  }> = [];
  const results: SetupFlowResult[] = [];

  const deps: CallSetupFlowDeps = {
    speakSystemPrompt: async (text) => {
      spoken.push(text);
    },
    updateCallSession: (_id, updates) => {
      sessionUpdates.push(updates as Record<string, unknown>);
    },
    recordCallEvent: (_callSessionId, eventType, payload) => {
      events.push({ eventType, payload });
    },
    onComplete: (result) => {
      results.push(result);
    },
    ttsPlaybackDelayMs: 0,
    attemptInviteCodeRedemption: async () => ({
      outcome: "failure" as const,
      ttsMessage: "unused",
    }),
    resolveGuardianLabel: () => "Bob",
    resolveAssistantLabel: () => null,
    getCallSession: () => ({ conversationId: "conv-1" }),
    finalizeCall: () => {},
    fireCallTranscriptNotifier: () => {},
    resolveMidCallTrustContext: async () => ({
      sourceChannel: "phone" as const,
      trustClass: "trusted_contact" as const,
    }),
    ...overrides,
  };

  const flow = new CallSetupFlow(CALL_SESSION_ID, fake.transport, deps);
  return { flow, ...fake, spoken, sessionUpdates, events, results };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSetupFlow", () => {
  describe("normal_call", () => {
    test("completes with proceed-initial-greeting carrying the resolved trust", async () => {
      const { flow, results, spoken, endReasons } = createFlow();
      const resolved = makeResolved("guardian");

      expect(flow.getState()).toBe("idle");
      await flow.start({ action: "normal_call", isInbound: true }, resolved);

      expect(flow.getState()).toBe("completed");
      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.kind).toBe("proceed-initial-greeting");
      if (result.kind !== "proceed-initial-greeting") {
        throw new Error("expected proceed-initial-greeting");
      }
      expect(result.assistantId).toBe("self");
      expect(result.trustContext.trustClass).toBe("guardian");
      expect(result.trustContext.sourceChannel).toBe("phone");
      expect(result.trustContext.requesterChatId).toBe(PHONE_NUMBER);

      // No speech and no teardown on the normal path.
      expect(spoken).toEqual([]);
      expect(endReasons).toEqual([]);
    });
  });

  describe("deny", () => {
    const denyOutcome: SetupOutcome = {
      action: "deny",
      message: "This number is not authorized to use this assistant.",
      logReason: "Inbound voice ACL: member policy deny",
    };

    test("records the ACL event, fails the session, speaks, and ends", async () => {
      const { flow, results, spoken, events, sessionUpdates, endReasons } =
        createFlow();
      const resolved = makeResolved("unknown");

      await flow.start(denyOutcome, resolved);

      expect(events).toEqual([
        {
          eventType: "inbound_acl_denied",
          payload: {
            from: PHONE_NUMBER,
            trustClass: "unknown",
            channelId: undefined,
            memberPolicy: undefined,
          },
        },
      ]);
      expect(sessionUpdates).toHaveLength(1);
      expect(sessionUpdates[0].status).toBe("failed");
      expect(sessionUpdates[0].lastError).toBe(denyOutcome.logReason);
      expect(sessionUpdates[0].endedAt).toBeNumber();

      expect(spoken).toEqual([denyOutcome.message]);
      expect(flow.getState()).toBe("completed");
      expect(results).toEqual([
        { kind: "ended", reason: denyOutcome.logReason },
      ]);

      // Session teardown fires after the playback delay, not inline.
      await sleep(0);
      expect(endReasons).toEqual([denyOutcome.logReason]);
    });

    test("delays endSession until the playback delay elapses", async () => {
      const { flow, endReasons } = createFlow({ ttsPlaybackDelayMs: 25 });

      await flow.start(denyOutcome, makeResolved("unknown"));

      expect(endReasons).toEqual([]);
      await sleep(40);
      expect(endReasons).toEqual([denyOutcome.logReason]);
    });
  });

  describe("unsupported actions", () => {
    test("throws UnsupportedSetupFlowError and stays idle", async () => {
      const { flow, results } = createFlow();

      await expect(
        flow.start(
          { action: "not_a_real_action" } as unknown as SetupOutcome,
          makeResolved("unknown"),
        ),
      ).rejects.toBeInstanceOf(UnsupportedSetupFlowError);

      expect(flow.getState()).toBe("idle");
      expect(results).toEqual([]);
    });
  });

  describe("lifecycle guards", () => {
    test("start() may only run once", async () => {
      const { flow } = createFlow();
      const resolved = makeResolved();

      await flow.start({ action: "normal_call", isInbound: true }, resolved);
      await expect(
        flow.start({ action: "normal_call", isInbound: true }, resolved),
      ).rejects.toThrow("may only be called once");
    });

    test("start() during an in-flight deny path throws", async () => {
      // The deny path awaits TTS before completing, so the flow is still
      // in `idle` state while the first start() is in flight.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { flow } = createFlow({ speakSystemPrompt: () => gate });
      const denyOutcome: SetupOutcome = {
        action: "deny",
        message: "Denied.",
        logReason: "test deny",
      };

      const first = flow.start(denyOutcome, makeResolved("unknown"));
      await expect(
        flow.start(denyOutcome, makeResolved("unknown")),
      ).rejects.toThrow("may only be called once");

      release();
      await first;
    });

    test("input methods are no-ops while idle and completed", async () => {
      const { flow, results, spoken } = createFlow();

      // Idle: inputs are swallowed.
      flow.pushDtmfDigit("1");
      flow.pushTranscriptFinal("hello");
      expect(flow.getState()).toBe("idle");

      await flow.start(
        { action: "normal_call", isInbound: true },
        makeResolved(),
      );

      // Completed: inputs are swallowed.
      flow.pushDtmfDigit("2");
      flow.pushTranscriptFinal("still here");
      expect(flow.getState()).toBe("completed");
      expect(results).toHaveLength(1);
      expect(spoken).toEqual([]);
    });
  });

  describe("type surfaces", () => {
    test("MediaStreamOutput is assignable to SetupFlowTransport", () => {
      // Compile-time assertion: the structural transport subset is
      // satisfied by the media-stream output adapter.
      const assertAssignable = (
        output: MediaStreamOutput,
      ): SetupFlowTransport => output;
      expect(assertAssignable).toBeInstanceOf(Function);
    });

    test("all SetupFlowResult variants are representable", () => {
      const trustContext: TrustContext = {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
      };
      const variants: SetupFlowResult[] = [
        { kind: "proceed-initial-greeting", assistantId: "self", trustContext },
        {
          kind: "proceed-post-verification-greeting",
          assistantId: "self",
          trustContext,
        },
        { kind: "proceed-handoff-spoken", assistantId: "self", trustContext },
        { kind: "ended", reason: "test" },
      ];
      expect(variants.map((v) => v.kind)).toEqual([
        "proceed-initial-greeting",
        "proceed-post-verification-greeting",
        "proceed-handoff-spoken",
        "ended",
      ]);
    });

    test("all SetupFlowState values are representable", () => {
      const states: SetupFlowState[] = [
        "idle",
        "collecting_code",
        "capturing_name",
        "awaiting_guardian_decision",
        "completed",
      ];
      expect(states).toHaveLength(5);
    });
  });
});
