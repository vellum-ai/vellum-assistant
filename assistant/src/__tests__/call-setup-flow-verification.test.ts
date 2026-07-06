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
import type { CallSession } from "../calls/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { TrustClass } from "../runtime/trust-class.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CALL_SESSION_ID = "call-session-1";
const PHONE_NUMBER = "+15555550100";
const TO_NUMBER = "+15555550101";
const CORRECT_CODE = "123456";

const UPGRADED_TRUST: TrustContext = {
  sourceChannel: "phone",
  trustClass: "guardian",
  requesterChatId: PHONE_NUMBER,
};

function makeResolved(
  trustClass: TrustClass = "unknown",
  overrides?: Partial<SetupResolved>,
): SetupResolved {
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
    ...overrides,
  };
}

function makeSession(overrides?: Partial<CallSession>): CallSession {
  return {
    id: CALL_SESSION_ID,
    conversationId: "conv-1",
    provider: "twilio",
    providerCallSid: null,
    fromNumber: PHONE_NUMBER,
    toNumber: TO_NUMBER,
    task: null,
    status: "in_progress",
    callMode: null,
    verificationSessionId: null,
    inviteFriendName: null,
    inviteGuardianName: null,
    callerIdentityMode: null,
    callerIdentitySource: null,
    skipDisclosure: false,
    initiatedFromConversationId: "conv-origin",
    startedAt: null,
    endedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const inboundVerificationOutcome: SetupOutcome = {
  action: "verification",
  assistantId: "self",
  fromNumber: PHONE_NUMBER,
};

const outboundVerificationOutcome: SetupOutcome = {
  action: "outbound_verification",
  assistantId: "self",
  sessionId: "vs-1",
  toNumber: TO_NUMBER,
};

function calleeOutcome(maxAttempts = 3, codeLength = 4): SetupOutcome {
  return {
    action: "callee_verification",
    verificationConfig: { maxAttempts, codeLength },
  };
}

type AttemptParams = Parameters<
  NonNullable<CallSetupFlowDeps["attemptVerificationCode"]>
>[0];

/** Mirror of call-verification's attemptVerificationCode result contract. */
function fakeAttemptVerification(opts: {
  correctCode: string;
  verificationType?: "guardian" | "trusted_contact";
}): NonNullable<CallSetupFlowDeps["attemptVerificationCode"]> {
  return async (params) => {
    if (params.enteredCode === opts.correctCode) {
      return {
        outcome: "success",
        verificationType: opts.verificationType ?? "guardian",
        eventName: params.isOutbound
          ? "outbound_voice_verification_succeeded"
          : "voice_verification_succeeded",
      };
    }
    const attempts = params.verificationAttempts + 1;
    if (attempts >= params.verificationMaxAttempts) {
      return {
        outcome: "failure",
        eventName: params.isOutbound
          ? "outbound_voice_verification_failed"
          : "voice_verification_failed",
        ttsMessage: "Verification failed. Goodbye.",
        attempts,
      };
    }
    return {
      outcome: "retry",
      ttsMessage: "That code was incorrect. Please try again.",
      attempt: attempts,
      maxAttempts: params.verificationMaxAttempts,
    };
  };
}

function createFlow(opts?: {
  deps?: Partial<CallSetupFlowDeps>;
  session?: CallSession | null;
}) {
  const spokenTokens: Array<{ token: string; last: boolean }> = [];
  const endReasons: Array<string | undefined> = [];
  const transport: SetupFlowTransport = {
    sendTextToken: (token, last) => {
      spokenTokens.push({ token, last });
    },
    endSession: (reason) => {
      endReasons.push(reason);
    },
  };

  const spoken: string[] = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const events: Array<{
    eventType: string;
    payload?: Record<string, unknown>;
  }> = [];
  const results: SetupFlowResult[] = [];
  const attemptCalls: AttemptParams[] = [];
  const pointerMessages: Array<{
    conversationId: string;
    event: string;
    phoneNumber: string;
    extra?: Record<string, unknown>;
  }> = [];
  const addedMessages: Array<{
    conversationId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const finalized: Array<{ callSessionId: string; conversationId: string }> =
    [];
  const notified: Array<{
    conversationId: string;
    callSessionId: string;
    speaker: string;
    text: string;
  }> = [];
  const trustResolutions: Array<{ assistantId: string; fromNumber: string }> =
    [];

  const session = opts && "session" in opts ? opts.session! : makeSession();
  const attempt = fakeAttemptVerification({ correctCode: CORRECT_CODE });

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
    getCallSession: () => session,
    finalizeCall: (callSessionId, conversationId) => {
      finalized.push({ callSessionId, conversationId });
    },
    addMessage: (async (
      conversationId: string,
      role: string,
      content: string,
      options?: { metadata?: Record<string, unknown> },
    ) => {
      addedMessages.push({
        conversationId,
        role,
        content,
        metadata: options?.metadata,
      });
    }) as unknown as CallSetupFlowDeps["addMessage"],
    postPointerMessage: ((
      conversationId: string,
      event: string,
      phoneNumber: string,
      extra?: Record<string, unknown>,
    ) => {
      pointerMessages.push({ conversationId, event, phoneNumber, extra });
    }) as unknown as CallSetupFlowDeps["postPointerMessage"],
    fireCallTranscriptNotifier: (
      conversationId,
      callSessionId,
      speaker,
      text,
    ) => {
      notified.push({ conversationId, callSessionId, speaker, text });
    },
    resolveGuardianLabel: () => "Alex",
    resolveAssistantLabel: () => "Aria",
    attemptVerificationCode: async (params) => {
      attemptCalls.push(params);
      return attempt(params);
    },
    resolveMidCallTrustContext: async (assistantId, fromNumber) => {
      trustResolutions.push({ assistantId, fromNumber });
      return UPGRADED_TRUST;
    },
    ...opts?.deps,
  };

  const flow = new CallSetupFlow(CALL_SESSION_ID, transport, deps);
  return {
    flow,
    endReasons,
    spoken,
    sessionUpdates,
    events,
    results,
    attemptCalls,
    pointerMessages,
    addedMessages,
    finalized,
    notified,
    trustResolutions,
  };
}

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function pushCode(flow: CallSetupFlow, code: string): void {
  for (const digit of code) {
    flow.pushDtmfDigit(digit);
  }
}

function eventTypes(events: Array<{ eventType: string }>): string[] {
  return events.map((e) => e.eventType);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSetupFlow verification sub-flows", () => {
  describe("inbound guardian verification", () => {
    test("start records the started event and prompts for the code", async () => {
      const { flow, events, spoken } = createFlow();

      await flow.start(inboundVerificationOutcome, makeResolved());

      expect(flow.getState()).toBe("collecting_code");
      expect(events).toEqual([
        {
          eventType: "voice_verification_started",
          payload: { assistantId: "self", maxAttempts: 3 },
        },
      ]);
      expect(spoken).toEqual([
        "Welcome. Please enter your six-digit verification code using your keypad, or speak the digits now.",
      ]);
    });

    test("correct DTMF code proceeds to initial greeting under re-resolved trust", async () => {
      const { flow, results, events, attemptCalls, trustResolutions } =
        createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, CORRECT_CODE);
      await sleep();

      expect(attemptCalls).toHaveLength(1);
      expect(attemptCalls[0]).toMatchObject({
        verificationFromNumber: PHONE_NUMBER,
        enteredCode: CORRECT_CODE,
        isOutbound: false,
        codeDigits: 6,
      });
      expect(eventTypes(events)).toContain("voice_verification_succeeded");
      expect(
        events.find((e) => e.eventType === "voice_verification_succeeded")
          ?.payload,
      ).toEqual({ verificationType: "guardian" });
      expect(trustResolutions).toEqual([
        { assistantId: "self", fromNumber: PHONE_NUMBER },
      ]);

      expect(flow.getState()).toBe("completed");
      expect(results).toEqual([
        {
          kind: "proceed-initial-greeting",
          assistantId: "self",
          trustContext: UPGRADED_TRUST,
          deferredTranscripts: undefined,
        },
      ]);
    });

    test("spoken digits are parsed and verified", async () => {
      const { flow, results, attemptCalls } = createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      flow.pushTranscriptFinal("one two three four five six");
      await sleep();

      expect(attemptCalls[0]?.enteredCode).toBe(CORRECT_CODE);
      expect(results[0]?.kind).toBe("proceed-initial-greeting");
    });

    test("partial spoken digits re-prompt without attempting", async () => {
      const { flow, spoken, attemptCalls } = createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      flow.pushTranscriptFinal("one two three");
      await sleep();

      expect(attemptCalls).toHaveLength(0);
      expect(spoken).toContain(
        "I heard 3 digits. Please enter all 6 digits of your code.",
      );
      expect(flow.getState()).toBe("collecting_code");
    });

    test("wrong code under max attempts re-prompts, then a correct code proceeds", async () => {
      const { flow, results, spoken, attemptCalls } = createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, "000000");
      await sleep();

      expect(spoken).toContain("That code was incorrect. Please try again.");
      expect(flow.getState()).toBe("collecting_code");
      expect(results).toHaveLength(0);

      pushCode(flow, CORRECT_CODE);
      await sleep();

      // The retry attempt counter carries into the second validation call.
      expect(attemptCalls[1]?.verificationAttempts).toBe(1);
      expect(results[0]?.kind).toBe("proceed-initial-greeting");
    });

    test("exhausted attempts fail the session, finalize, speak goodbye, and end", async () => {
      const { flow, results, spoken, events, sessionUpdates, finalized } =
        createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      for (const code of ["000000", "111111", "222222"]) {
        pushCode(flow, code);
        await sleep();
      }

      expect(
        events.find((e) => e.eventType === "voice_verification_failed")
          ?.payload,
      ).toEqual({ attempts: 3 });
      expect(sessionUpdates.at(-1)).toMatchObject({
        status: "failed",
        lastError: "Guardian voice verification failed — max attempts exceeded",
      });
      expect(finalized).toEqual([
        { callSessionId: CALL_SESSION_ID, conversationId: "conv-1" },
      ]);
      expect(spoken).toContain("Verification failed. Goodbye.");
      expect(results).toEqual([
        { kind: "ended", reason: "Verification failed — challenge rejected" },
      ]);
    });

    test("further input after completion is ignored", async () => {
      const { flow, attemptCalls } = createFlow();
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, CORRECT_CODE);
      await sleep();
      expect(flow.getState()).toBe("completed");

      pushCode(flow, CORRECT_CODE);
      flow.pushTranscriptFinal("one two three four five six");
      await sleep();
      expect(attemptCalls).toHaveLength(1);
    });

    test("trusted-contact success runs the activation continuation and hands off", async () => {
      const { flow, results, spoken, events, sessionUpdates, notified } =
        createFlow({
          deps: {
            attemptVerificationCode: fakeAttemptVerification({
              correctCode: CORRECT_CODE,
              verificationType: "trusted_contact",
            }),
          },
        });
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, CORRECT_CODE);
      await sleep();

      const handoff = "Great! Alex said I can speak with you. How can I help?";
      expect(sessionUpdates).toContainEqual({ status: "in_progress" });
      expect(spoken).toContain(handoff);
      expect(
        events.find((e) => e.eventType === "assistant_spoke")?.payload,
      ).toEqual({ text: handoff });
      expect(notified).toEqual([
        {
          conversationId: "conv-1",
          callSessionId: CALL_SESSION_ID,
          speaker: "assistant",
          text: handoff,
        },
      ]);
      expect(results).toEqual([
        {
          kind: "proceed-handoff-spoken",
          assistantId: "self",
          trustContext: UPGRADED_TRUST,
          deferredTranscripts: undefined,
        },
      ]);
    });

    test("a transcript arriving during trust re-resolution is deferred and rides the result", async () => {
      let releaseTrust!: (ctx: TrustContext) => void;
      const gated = new Promise<TrustContext>((resolve) => {
        releaseTrust = resolve;
      });
      const { flow, results, spoken } = createFlow({
        deps: { resolveMidCallTrustContext: () => gated },
      });
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, CORRECT_CODE);
      await sleep();

      // Re-resolution is in flight — a final transcript must be buffered,
      // not treated as spoken digits and not answered under stale trust.
      expect(results).toHaveLength(0);
      flow.pushTranscriptFinal("hello are you there");
      await sleep();
      expect(results).toHaveLength(0);
      expect(spoken.some((t) => t.startsWith("I heard"))).toBe(false);

      releaseTrust(UPGRADED_TRUST);
      await sleep();

      expect(results).toEqual([
        {
          kind: "proceed-initial-greeting",
          assistantId: "self",
          trustContext: UPGRADED_TRUST,
          deferredTranscripts: ["hello are you there"],
        },
      ]);
    });

    test("trust re-resolution failure falls back to the setup-time trust", async () => {
      const { flow, results } = createFlow({
        deps: {
          resolveMidCallTrustContext: async () => {
            throw new Error("gateway blip");
          },
        },
      });
      await flow.start(inboundVerificationOutcome, makeResolved("guardian"));

      pushCode(flow, CORRECT_CODE);
      await sleep();

      expect(results).toHaveLength(1);
      const result = results[0];
      if (result.kind !== "proceed-initial-greeting") {
        throw new Error("expected proceed-initial-greeting");
      }
      expect(result.trustContext.trustClass).toBe("guardian");
    });
  });

  describe("outbound guardian verification", () => {
    test("start records the started event and speaks the call intro", async () => {
      const { flow, events, spoken } = createFlow();

      await flow.start(
        outboundVerificationOutcome,
        makeResolved("unknown", {
          isInbound: false,
          otherPartyNumber: TO_NUMBER,
        }),
      );

      expect(flow.getState()).toBe("collecting_code");
      expect(events).toEqual([
        {
          eventType: "outbound_voice_verification_started",
          payload: {
            assistantId: "self",
            verificationSessionId: "vs-1",
            maxAttempts: 3,
          },
        },
      ]);
      expect(spoken).toHaveLength(1);
      expect(spoken[0]).toContain("guardian verification call");
      expect(spoken[0]).toContain("6-digit verification code");
    });

    test("success posts the succeeded pointer and proceeds to the post-verification greeting", async () => {
      const {
        flow,
        results,
        events,
        sessionUpdates,
        pointerMessages,
        attemptCalls,
        trustResolutions,
      } = createFlow();
      await flow.start(
        outboundVerificationOutcome,
        makeResolved("unknown", {
          isInbound: false,
          otherPartyNumber: TO_NUMBER,
        }),
      );

      pushCode(flow, CORRECT_CODE);
      await sleep();

      expect(attemptCalls[0]).toMatchObject({
        isOutbound: true,
        verificationFromNumber: TO_NUMBER,
      });
      expect(eventTypes(events)).toContain(
        "outbound_voice_verification_succeeded",
      );
      expect(pointerMessages).toEqual([
        {
          conversationId: "conv-origin",
          event: "verification_succeeded",
          phoneNumber: TO_NUMBER,
          extra: { channel: "phone" },
        },
      ]);
      expect(trustResolutions).toEqual([
        { assistantId: "self", fromNumber: TO_NUMBER },
      ]);
      expect(sessionUpdates).toContainEqual({ status: "in_progress" });
      expect(results).toEqual([
        {
          kind: "proceed-post-verification-greeting",
          assistantId: "self",
          trustContext: UPGRADED_TRUST,
          deferredTranscripts: undefined,
        },
      ]);
    });

    test("exhausted attempts post the failed pointer, finalize, and end", async () => {
      const { flow, results, events, pointerMessages, finalized, endReasons } =
        createFlow();
      await flow.start(
        outboundVerificationOutcome,
        makeResolved("unknown", {
          isInbound: false,
          otherPartyNumber: TO_NUMBER,
        }),
      );

      for (const code of ["000000", "111111", "222222"]) {
        pushCode(flow, code);
        await sleep();
      }

      expect(
        events.find((e) => e.eventType === "outbound_voice_verification_failed")
          ?.payload,
      ).toEqual({ attempts: 3 });
      expect(pointerMessages).toEqual([
        {
          conversationId: "conv-origin",
          event: "verification_failed",
          phoneNumber: TO_NUMBER,
          extra: {
            channel: "phone",
            reason: "Max verification attempts exceeded",
          },
        },
      ]);
      expect(finalized).toEqual([
        { callSessionId: CALL_SESSION_ID, conversationId: "conv-1" },
      ]);
      expect(results).toEqual([
        { kind: "ended", reason: "Verification failed — challenge rejected" },
      ]);
      await sleep();
      expect(endReasons).toEqual(["Verification failed — challenge rejected"]);
    });
  });

  describe("callee verification", () => {
    const calleeResolved = () =>
      makeResolved("unknown", {
        isInbound: false,
        otherPartyNumber: TO_NUMBER,
      });

    /** Extract the generated code from the message posted to the origin conversation. */
    function postedCode(
      addedMessages: Array<{ content: string }>,
      codeLength: number,
    ): string {
      const text = (
        JSON.parse(addedMessages[0].content) as Array<{ text: string }>
      )[0].text;
      const match = text.match(new RegExp(`(\\d{${codeLength}})$`));
      if (!match) {
        throw new Error(`No code found in posted message: ${text}`);
      }
      return match[1];
    }

    test("start posts the code to the origin conversation and prompts with spoken digits", async () => {
      const { flow, events, spoken, addedMessages } = createFlow();

      await flow.start(calleeOutcome(3, 4), calleeResolved());

      expect(flow.getState()).toBe("collecting_code");
      expect(events).toEqual([
        {
          eventType: "callee_verification_started",
          payload: { codeLength: 4, maxAttempts: 3 },
        },
      ]);

      expect(addedMessages).toHaveLength(1);
      expect(addedMessages[0].conversationId).toBe("conv-origin");
      expect(addedMessages[0].content).toContain(
        `Verification code for call to ${TO_NUMBER}:`,
      );
      const code = postedCode(addedMessages, 4);

      // The TTS prompt speaks the same code digit by digit.
      expect(spoken).toEqual([
        `Please enter the verification code: ${code.split("").join(". ")}.`,
      ]);
    });

    test("no code message is posted without an origin conversation", async () => {
      const { flow, addedMessages } = createFlow({
        session: makeSession({ initiatedFromConversationId: null }),
      });

      await flow.start(calleeOutcome(), calleeResolved());
      expect(addedMessages).toHaveLength(0);
    });

    test("correct DTMF code proceeds under the setup-time trust without re-resolution", async () => {
      const { flow, results, events, addedMessages, trustResolutions } =
        createFlow();
      await flow.start(calleeOutcome(3, 4), calleeResolved());
      const code = postedCode(addedMessages, 4);

      pushCode(flow, code);
      await sleep();

      expect(eventTypes(events)).toContain("callee_verification_succeeded");
      expect(trustResolutions).toEqual([]);
      expect(results).toHaveLength(1);
      const result = results[0];
      if (result.kind !== "proceed-initial-greeting") {
        throw new Error("expected proceed-initial-greeting");
      }
      expect(result.assistantId).toBe("self");
      expect(result.trustContext.trustClass).toBe("unknown");
      expect(result.trustContext.requesterChatId).toBe(TO_NUMBER);
    });

    test("speech is ignored — the callee flow is DTMF-only", async () => {
      const { flow, results, spoken, addedMessages } = createFlow();
      await flow.start(calleeOutcome(3, 4), calleeResolved());
      const code = postedCode(addedMessages, 4);
      const promptCount = spoken.length;

      // Speaking the correct code out loud must not verify or re-prompt.
      flow.pushTranscriptFinal(code.split("").join(" "));
      await sleep();

      expect(results).toHaveLength(0);
      expect(spoken).toHaveLength(promptCount);
      expect(flow.getState()).toBe("collecting_code");
    });

    test("a wrong code re-prompts, and a subsequent correct code succeeds", async () => {
      const { flow, results, spoken, addedMessages } = createFlow();
      await flow.start(calleeOutcome(3, 4), calleeResolved());
      const code = postedCode(addedMessages, 4);
      const wrong = code === "0000" ? "1111" : "0000";

      pushCode(flow, wrong);
      await sleep();
      expect(spoken).toContain("That code was incorrect. Please try again.");
      expect(results).toHaveLength(0);

      pushCode(flow, code);
      await sleep();
      expect(results[0]?.kind).toBe("proceed-initial-greeting");
    });

    test("max attempts fail the session, finalize, post the failed pointer, and end", async () => {
      const {
        flow,
        results,
        spoken,
        events,
        sessionUpdates,
        finalized,
        pointerMessages,
        endReasons,
        addedMessages,
      } = createFlow();
      await flow.start(calleeOutcome(2, 4), calleeResolved());
      const code = postedCode(addedMessages, 4);
      const wrong = code === "0000" ? "1111" : "0000";

      pushCode(flow, wrong);
      await sleep();
      pushCode(flow, wrong);
      await sleep();

      expect(
        events.find((e) => e.eventType === "callee_verification_failed")
          ?.payload,
      ).toEqual({ attempts: 2 });
      expect(sessionUpdates.at(-1)).toMatchObject({
        status: "failed",
        lastError: "Callee verification failed — max attempts exceeded",
      });
      expect(finalized).toEqual([
        { callSessionId: CALL_SESSION_ID, conversationId: "conv-1" },
      ]);
      expect(pointerMessages).toEqual([
        {
          conversationId: "conv-origin",
          event: "failed",
          phoneNumber: TO_NUMBER,
          extra: { reason: "Callee verification failed" },
        },
      ]);
      expect(spoken).toContain("Verification failed. Goodbye.");
      expect(results).toEqual([
        { kind: "ended", reason: "Verification failed" },
      ]);
      await sleep();
      expect(endReasons).toEqual(["Verification failed"]);
    });
  });

  describe("dep validation", () => {
    test("start throws a descriptive error when verification deps are missing", async () => {
      const { flow } = createFlow({
        deps: {
          getCallSession: undefined,
          finalizeCall: undefined,
          addMessage: undefined,
          postPointerMessage: undefined,
          fireCallTranscriptNotifier: undefined,
          resolveGuardianLabel: undefined,
          resolveAssistantLabel: undefined,
        },
      });

      expect(
        flow.start(inboundVerificationOutcome, makeResolved()),
      ).rejects.toThrow(/verification deps missing: getCallSession/);
    });
  });

  describe("in-flight submission guard", () => {
    test("a 12-digit DTMF burst fires exactly one validation attempt", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempt = fakeAttemptVerification({ correctCode: CORRECT_CODE });
      const calls: AttemptParams[] = [];
      const { flow, results } = createFlow({
        deps: {
          attemptVerificationCode: async (params) => {
            calls.push(params);
            await gate;
            return attempt(params);
          },
        },
      });
      await flow.start(inboundVerificationOutcome, makeResolved());

      // Duplicated DTMF burst: the correct code arrives twice back-to-back.
      pushCode(flow, CORRECT_CODE + CORRECT_CODE);
      await sleep();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.enteredCode).toBe(CORRECT_CODE);

      release();
      await sleep();

      expect(calls).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]?.kind).toBe("proceed-initial-greeting");
    });

    test("a spoken code during a pending validation is dropped", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempt = fakeAttemptVerification({ correctCode: CORRECT_CODE });
      const calls: AttemptParams[] = [];
      const { flow, results } = createFlow({
        deps: {
          attemptVerificationCode: async (params) => {
            calls.push(params);
            await gate;
            return attempt(params);
          },
        },
      });
      await flow.start(inboundVerificationOutcome, makeResolved());

      pushCode(flow, CORRECT_CODE);
      await sleep();
      expect(calls).toHaveLength(1);

      // The same code re-spoken while the validation is pending must not
      // launch a second attempt.
      flow.pushTranscriptFinal("one two three four five six");
      await sleep();
      expect(calls).toHaveLength(1);

      release();
      await sleep();
      expect(calls).toHaveLength(1);
      expect(results).toHaveLength(1);
    });

    test("the attempt counter advances once per settled attempt", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempt = fakeAttemptVerification({ correctCode: CORRECT_CODE });
      const calls: AttemptParams[] = [];
      const { flow } = createFlow({
        deps: {
          attemptVerificationCode: async (params) => {
            calls.push(params);
            await gate;
            return attempt(params);
          },
        },
      });
      await flow.start(inboundVerificationOutcome, makeResolved());

      // Duplicated wrong code: only the first submission validates.
      pushCode(flow, "000000" + "000000");
      flow.pushTranscriptFinal("zero zero zero zero zero zero");
      await sleep();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.verificationAttempts).toBe(0);

      release();
      await sleep();

      // The next submission sees a counter advanced exactly once.
      pushCode(flow, "111111");
      await sleep();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.verificationAttempts).toBe(1);
    });
  });
});
