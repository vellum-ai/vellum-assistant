import { describe, expect, test } from "bun:test";

import {
  CallSetupFlow,
  type CallSetupFlowDeps,
} from "../calls/call-setup-flow.js";
import type {
  SetupFlowResult,
  SetupFlowTransport,
} from "../calls/call-setup-flow-types.js";
import type {
  SetupOutcome,
  SetupResolved,
} from "../calls/call-setup-router.js";
import type { TrustContext } from "../daemon/trust-context-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALL_SESSION_ID = "call-session-1";
const CALLER_NUMBER = "+15555550100";
const CONVERSATION_ID = "conv-invite-1";
const CODE = "123456";

const UPGRADED_TRUST: TrustContext = {
  sourceChannel: "phone",
  trustClass: "trusted_contact",
  requesterChatId: CALLER_NUMBER,
};

function makeResolved(isInbound: boolean): SetupResolved {
  return {
    assistantId: "self",
    isInbound,
    otherPartyNumber: CALLER_NUMBER,
    actorTrust: {
      canonicalSenderId: CALLER_NUMBER,
      guardianBindingMatch: null,
      memberRecord: null,
      trustClass: "unknown",
      actorMetadata: {
        identifier: CALLER_NUMBER,
        displayName: undefined,
        senderDisplayName: undefined,
        memberDisplayName: undefined,
        username: undefined,
        channel: "phone",
        trustStatus: "unknown",
      },
    },
  };
}

function inviteOutcome(inviteeName: string | null): SetupOutcome {
  return {
    action: "invite_redemption",
    assistantId: "self",
    fromNumber: CALLER_NUMBER,
    inviteeName,
  };
}

type RedemptionFn = NonNullable<
  CallSetupFlowDeps["attemptInviteCodeRedemption"]
>;

const successRedemption: RedemptionFn = async () => ({
  outcome: "success",
  memberId: "contact-abc",
  type: "redeemed",
  inviteId: "invite-xyz",
});

const failureRedemption: RedemptionFn = async ({ guardianLabel }) => ({
  outcome: "failure",
  ttsMessage: `Sorry, the code you provided is incorrect or has since expired. Please ask ${guardianLabel} for a new code. Goodbye.`,
});

function createHarness(overrides?: Partial<CallSetupFlowDeps>) {
  const spoken: string[] = [];
  const endReasons: Array<string | undefined> = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const events: Array<{
    eventType: string;
    payload?: Record<string, unknown>;
  }> = [];
  const results: SetupFlowResult[] = [];
  const redemptionCalls: Array<{
    inviteRedemptionFromNumber: string;
    enteredCode: string;
    guardianLabel: string;
  }> = [];
  const finalizeCalls: Array<{
    callSessionId: string;
    conversationId: string;
  }> = [];
  const notifierCalls: Array<{
    conversationId: string;
    callSessionId: string;
    speaker: "caller" | "assistant";
    text: string;
  }> = [];

  const transport: SetupFlowTransport = {
    sendTextToken: () => {},
    endSession: (reason) => {
      endReasons.push(reason);
    },
  };

  // Record every claim regardless of which redemption impl a test injects.
  const {
    attemptInviteCodeRedemption: redemptionImpl = successRedemption,
    ...restOverrides
  } = overrides ?? {};

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
    attemptInviteCodeRedemption: async (params) => {
      redemptionCalls.push(params);
      return redemptionImpl(params);
    },
    resolveGuardianLabel: () => "Bob",
    resolveAssistantLabel: () => "Vellum",
    getCallSession: () => ({ conversationId: CONVERSATION_ID }),
    finalizeCall: (callSessionId, conversationId) => {
      finalizeCalls.push({ callSessionId, conversationId });
    },
    fireCallTranscriptNotifier: (
      conversationId,
      callSessionId,
      speaker,
      text,
    ) => {
      notifierCalls.push({ conversationId, callSessionId, speaker, text });
    },
    resolveMidCallTrustContext: async () => UPGRADED_TRUST,
    ...restOverrides,
  };

  const flow = new CallSetupFlow(CALL_SESSION_ID, transport, deps);
  return {
    flow,
    spoken,
    endReasons,
    sessionUpdates,
    events,
    results,
    redemptionCalls,
    finalizeCalls,
    notifierCalls,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function enterCode(flow: CallSetupFlow, code = CODE) {
  for (const digit of code) {
    flow.pushDtmfDigit(digit);
  }
  await settle();
  await settle();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSetupFlow invite redemption", () => {
  describe("prompt copy", () => {
    test("inbound prompt greets the invitee by first name with the guardian label", async () => {
      const { flow, spoken, events } = createHarness();

      await flow.start(inviteOutcome("Alice Example"), makeResolved(true));

      expect(flow.getState()).toBe("collecting_code");
      expect(spoken).toEqual([
        "Welcome Alice. Please enter the 6-digit code that Bob provided you to verify your identity.",
      ]);
      expect(events).toEqual([
        {
          eventType: "invite_redemption_started",
          payload: { assistantId: "self", codeLength: 6, maxAttempts: 1 },
        },
      ]);
    });

    test("inbound prompt falls back to 'there' when the invitee name is missing", async () => {
      const { flow, spoken } = createHarness();

      await flow.start(inviteOutcome(null), makeResolved(true));

      expect(spoken).toEqual([
        "Welcome there. Please enter the 6-digit code that Bob provided you to verify your identity.",
      ]);
    });

    test("outbound prompt introduces the assistant by name", async () => {
      const { flow, spoken } = createHarness({
        resolveGuardianLabel: () => "Hank",
      });

      await flow.start(inviteOutcome("Grace"), makeResolved(false));

      expect(spoken).toEqual([
        "Hi Grace, this is Vellum, Hank's assistant. To get started, please enter the 6-digit code that Hank shared with you.",
      ]);
    });

    test("outbound prompt omits the assistant name when unavailable", async () => {
      const { flow, spoken } = createHarness({
        resolveGuardianLabel: () => "Hank",
        resolveAssistantLabel: () => null,
      });

      await flow.start(inviteOutcome("Grace"), makeResolved(false));

      expect(spoken).toEqual([
        "Hi Grace, this is Hank's assistant. To get started, please enter the 6-digit code that Hank shared with you.",
      ]);
    });
  });

  describe("successful redemption", () => {
    test("valid DTMF code redeems at the gateway and hands off with proceed-handoff-spoken", async () => {
      const {
        flow,
        spoken,
        events,
        results,
        sessionUpdates,
        redemptionCalls,
        notifierCalls,
        endReasons,
      } = createHarness();

      await flow.start(inviteOutcome("Carolina Flaherty"), makeResolved(true));
      await enterCode(flow);

      expect(redemptionCalls).toEqual([
        {
          inviteRedemptionFromNumber: CALLER_NUMBER,
          enteredCode: CODE,
          guardianLabel: "Bob",
        },
      ]);
      expect(events).toContainEqual({
        eventType: "invite_redemption_succeeded",
        payload: { memberId: "contact-abc", inviteId: "invite-xyz" },
      });
      expect(sessionUpdates).toContainEqual({ status: "in_progress" });

      // Greeting uses the bound contact displayName's first token only.
      const handoff =
        "Great, I've verified that you are Carolina. It's nice to meet you! I'm Vellum, Bob's assistant. How can I help?";
      expect(spoken).toContain(handoff);
      expect(events).toContainEqual({
        eventType: "assistant_spoke",
        payload: { text: handoff },
      });
      expect(notifierCalls).toEqual([
        {
          conversationId: CONVERSATION_ID,
          callSessionId: CALL_SESSION_ID,
          speaker: "assistant",
          text: handoff,
        },
      ]);

      expect(flow.getState()).toBe("completed");
      expect(results).toEqual([
        {
          kind: "proceed-handoff-spoken",
          assistantId: "self",
          trustContext: UPGRADED_TRUST,
        },
      ]);
      // The call stays alive — no session teardown on success.
      expect(endReasons).toEqual([]);
    });

    test("spoken digits redeem like DTMF", async () => {
      const { flow, redemptionCalls, results } = createHarness();

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      flow.pushTranscriptFinal("one two three four five six");
      await settle();
      await settle();

      expect(redemptionCalls).toEqual([
        {
          inviteRedemptionFromNumber: CALLER_NUMBER,
          enteredCode: "123456",
          guardianLabel: "Bob",
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe("proceed-handoff-spoken");
    });

    test("already_member outcome also proceeds to the handoff", async () => {
      const { flow, results, events } = createHarness({
        attemptInviteCodeRedemption: async () => ({
          outcome: "success",
          memberId: "contact-abc",
          type: "already_member",
          inviteId: "invite-xyz",
        }),
      });

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      await enterCode(flow);

      expect(
        events.some((e) => e.eventType === "invite_redemption_succeeded"),
      ).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe("proceed-handoff-spoken");
    });
  });

  describe("greeting personalization", () => {
    test("blank invitee name triggers the neutral 'Hi there' greeting, never the phone number", async () => {
      const { flow, spoken } = createHarness();

      await flow.start(inviteOutcome("   "), makeResolved(true));
      await enterCode(flow);

      expect(spoken).toContain(
        "Hi there! I'm Vellum, Bob's assistant. How can I help?",
      );
      expect(spoken.every((text) => !text.includes(CALLER_NUMBER))).toBe(true);
    });

    test("blank invitee name without an assistant name uses the plain neutral copy", async () => {
      const { flow, spoken } = createHarness({
        resolveAssistantLabel: () => null,
      });

      await flow.start(inviteOutcome(null), makeResolved(true));
      await enterCode(flow);

      expect(spoken).toContain("Hi there! How can I help?");
    });

    test("named invitee without an assistant name omits the introduction", async () => {
      const { flow, spoken } = createHarness({
        resolveAssistantLabel: () => null,
      });

      await flow.start(inviteOutcome("Alice Example"), makeResolved(true));
      await enterCode(flow);

      expect(spoken).toContain(
        "Great, I've verified that you are Alice. It's nice to meet you! How can I help?",
      );
    });
  });

  describe("failed redemption", () => {
    test("invalid code speaks the exact failure copy, finalizes, and ends the call", async () => {
      const {
        flow,
        spoken,
        events,
        results,
        sessionUpdates,
        finalizeCalls,
        endReasons,
      } = createHarness({
        attemptInviteCodeRedemption: failureRedemption,
        resolveGuardianLabel: () => "Dave",
      });

      await flow.start(inviteOutcome("Carol"), makeResolved(true));
      await enterCode(flow, "000000");

      expect(spoken).toContain(
        "Sorry, the code you provided is incorrect or has since expired. Please ask Dave for a new code. Goodbye.",
      );
      expect(events).toContainEqual({
        eventType: "invite_redemption_failed",
        payload: { attempts: 1 },
      });

      expect(sessionUpdates).toHaveLength(1);
      expect(sessionUpdates[0].status).toBe("failed");
      expect(sessionUpdates[0].lastError).toBe(
        "Voice invite redemption failed — invalid or expired code",
      );
      expect(sessionUpdates[0].endedAt).toBeNumber();

      expect(finalizeCalls).toEqual([
        {
          callSessionId: CALL_SESSION_ID,
          conversationId: CONVERSATION_ID,
        },
      ]);

      expect(flow.getState()).toBe("completed");
      expect(results).toEqual([
        { kind: "ended", reason: "Invite redemption failed" },
      ]);

      // Session teardown fires after the playback delay.
      await settle();
      expect(endReasons).toEqual(["Invite redemption failed"]);
    });

    test("input after a terminal failure is ignored", async () => {
      const { flow, redemptionCalls, results } = createHarness({
        attemptInviteCodeRedemption: failureRedemption,
      });

      await flow.start(inviteOutcome("Carol"), makeResolved(true));
      await enterCode(flow, "000000");
      expect(redemptionCalls).toHaveLength(1);

      await enterCode(flow);
      flow.pushTranscriptFinal("one two three four five six");
      await settle();

      expect(redemptionCalls).toHaveLength(1);
      expect(results).toHaveLength(1);
    });
  });

  describe("in-flight dedupe", () => {
    test("a repeated code while the gateway claim is pending never double-fires redemption", async () => {
      let releaseClaim: () => void = () => {};
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimCalls = 0;

      const { flow, results, events } = createHarness({
        attemptInviteCodeRedemption: async (params) => {
          claimCalls += 1;
          await claimGate;
          return successRedemption(params);
        },
      });

      await flow.start(inviteOutcome("Eve"), makeResolved(true));

      // First attempt reaches the awaited gateway claim.
      for (const digit of CODE) {
        flow.pushDtmfDigit(digit);
      }
      await settle();
      expect(claimCalls).toBe(1);

      // Second burst with the same code arrives while the claim is pending —
      // it must be dropped, not queued.
      for (const digit of CODE) {
        flow.pushDtmfDigit(digit);
      }
      await settle();
      expect(claimCalls).toBe(1);

      releaseClaim();
      await settle();
      await settle();

      expect(claimCalls).toBe(1);
      expect(
        events.some((e) => e.eventType === "invite_redemption_succeeded"),
      ).toBe(true);
      expect(
        events.some((e) => e.eventType === "invite_redemption_failed"),
      ).toBe(false);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe("proceed-handoff-spoken");
    });
  });

  describe("code collection", () => {
    test("partial spoken digits re-prompt without attempting redemption", async () => {
      const { flow, spoken, redemptionCalls } = createHarness();

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      flow.pushTranscriptFinal("one two three");
      await settle();

      expect(redemptionCalls).toEqual([]);
      expect(spoken).toContain(
        "I heard 3 digits. Please enter all 6 digits of your code.",
      );
      expect(flow.getState()).toBe("collecting_code");
    });

    test("non-digit speech during collection is ignored", async () => {
      const { flow, spoken, redemptionCalls } = createHarness();

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      const promptCount = spoken.length;
      flow.pushTranscriptFinal("hello, is anyone there?");
      await settle();

      expect(redemptionCalls).toEqual([]);
      expect(spoken).toHaveLength(promptCount);
    });
  });

  describe("trust re-resolution", () => {
    test("falls back to the setup-time trust context when re-resolution fails", async () => {
      const { flow, results } = createHarness({
        resolveMidCallTrustContext: async () => {
          throw new Error("gateway unavailable");
        },
      });

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      await enterCode(flow);

      expect(results).toHaveLength(1);
      const result = results[0];
      if (result.kind !== "proceed-handoff-spoken") {
        throw new Error("expected proceed-handoff-spoken");
      }
      // Fail-soft: the call continues under the setup-time trust rather
      // than wedging on the re-resolution error.
      expect(result.trustContext.sourceChannel).toBe("phone");
      expect(result.trustContext.trustClass).toBe("unknown");
      expect(result.trustContext.requesterChatId).toBe(CALLER_NUMBER);
    });

    test("dispose during re-resolution suppresses the handoff on the dead call", async () => {
      let releaseTrust!: (ctx: TrustContext) => void;
      const gated = new Promise<TrustContext>((resolve) => {
        releaseTrust = resolve;
      });
      const { flow, spoken, events, notifierCalls, results } = createHarness({
        resolveMidCallTrustContext: () => gated,
      });

      await flow.start(inviteOutcome("Alice"), makeResolved(true));
      for (const digit of CODE) {
        flow.pushDtmfDigit(digit);
      }
      await settle();

      // Caller hangs up while trust re-resolution is still in flight.
      flow.dispose("transport_closed");
      releaseTrust(UPGRADED_TRUST);
      await settle();

      // Only the invite prompt was spoken — no synthetic handoff.
      expect(spoken).toHaveLength(1);
      expect(events.map((e) => e.eventType)).not.toContain("assistant_spoke");
      expect(notifierCalls).toEqual([]);
      expect(results).toHaveLength(0);
    });
  });
});
