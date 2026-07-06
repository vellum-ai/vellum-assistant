import { describe, expect, test } from "bun:test";

import {
  CallSetupFlow,
  type CallSetupFlowDeps,
  type GuardianWaitHandle,
} from "../calls/call-setup-flow.js";
import type {
  SetupFlowResult,
  SetupFlowTransport,
} from "../calls/call-setup-flow-types.js";
import type {
  GuardianWaitControllerDeps,
  GuardianWaitDisposeReason,
  GuardianWaitStartParams,
} from "../calls/guardian-wait-controller.js";
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
const REQUEST_ID = "canonical-req-1";
const CALLER_NAME = "John Smith";

const UPGRADED_TRUST: TrustContext = {
  sourceChannel: "phone",
  trustClass: "trusted_contact",
  requesterChatId: PHONE_NUMBER,
};

const nameCaptureOutcome: SetupOutcome = {
  action: "name_capture",
  assistantId: "self",
  fromNumber: PHONE_NUMBER,
};

function unverifiedOutcome(isGuardian: boolean): SetupOutcome {
  return {
    action: "unverified_caller",
    assistantId: "self",
    fromNumber: PHONE_NUMBER,
    displayName: "Sam Example",
    isGuardian,
  };
}

function makeResolved(trustClass: TrustClass = "unknown"): SetupResolved {
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
    initiatedFromConversationId: null,
    startedAt: null,
    endedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Fake wait controller capturing the flow's wiring for the tests to drive. */
class FakeGuardianWait implements GuardianWaitHandle {
  startParams: GuardianWaitStartParams | null = null;
  transcripts: string[] = [];
  disposeReasons: GuardianWaitDisposeReason[] = [];

  constructor(readonly deps: GuardianWaitControllerDeps) {}

  start(params: GuardianWaitStartParams): void {
    this.startParams = params;
  }

  handleTranscript(text: string): void {
    this.transcripts.push(text);
  }

  dispose(reason: GuardianWaitDisposeReason = "teardown"): void {
    this.disposeReasons.push(reason);
  }
}

type NotifyParams = Parameters<
  NonNullable<CallSetupFlowDeps["notifyGuardianOfAccessRequest"]>
>[0];
type NotifyResult = Awaited<
  ReturnType<NonNullable<CallSetupFlowDeps["notifyGuardianOfAccessRequest"]>>
>;

function createFlow(opts?: {
  deps?: Partial<CallSetupFlowDeps>;
  notifyResult?: NotifyResult | Error;
}) {
  const endReasons: Array<string | undefined> = [];
  const transport: SetupFlowTransport = {
    sendTextToken: () => {},
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
  const notifyCalls: NotifyParams[] = [];
  const notified: Array<{
    conversationId: string;
    callSessionId: string;
    speaker: string;
    text: string;
  }> = [];
  const trustResolutions: Array<{ assistantId: string; fromNumber: string }> =
    [];
  const finalized: Array<{ callSessionId: string; conversationId: string }> =
    [];
  const waits: FakeGuardianWait[] = [];

  const session = makeSession();
  const notifyResult: NotifyResult | Error = opts?.notifyResult ?? {
    notified: true,
    created: true,
    requestId: REQUEST_ID,
  };

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
    notifyGuardianOfAccessRequest: async (params) => {
      notifyCalls.push(params);
      if (notifyResult instanceof Error) {
        throw notifyResult;
      }
      return notifyResult;
    },
    createGuardianWaitController: (_callSessionId, waitDeps) => {
      const wait = new FakeGuardianWait(waitDeps);
      waits.push(wait);
      return wait;
    },
    resolveMidCallTrustContext: async (assistantId, fromNumber) => {
      trustResolutions.push({ assistantId, fromNumber });
      return UPGRADED_TRUST;
    },
    nameCaptureTimeoutMs: 10_000,
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
    notifyCalls,
    notified,
    trustResolutions,
    finalized,
    waits,
  };
}

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start name capture and speak the caller's name, returning the fake wait. */
async function startWait(f: ReturnType<typeof createFlow>) {
  await f.flow.start(nameCaptureOutcome, makeResolved());
  f.flow.pushTranscriptFinal(CALLER_NAME);
  await sleep();
  const wait = f.waits[0];
  if (!wait) {
    throw new Error("expected a guardian wait controller to be created");
  }
  return wait;
}

function eventTypes(events: Array<{ eventType: string }>): string[] {
  return events.map((e) => e.eventType);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSetupFlow name capture", () => {
  test("start records the started event, speaks the intro greeting, and captures the name", async () => {
    const f = createFlow();

    await f.flow.start(nameCaptureOutcome, makeResolved());

    expect(f.flow.getState()).toBe("capturing_name");
    expect(f.events).toEqual([
      {
        eventType: "inbound_acl_name_capture_started",
        payload: { from: PHONE_NUMBER, trustClass: "unknown" },
      },
    ]);
    expect(f.spoken).toEqual([
      "Hi, this is Aria, Alex's assistant. Sorry, I don't recognize this number. I'll let Alex know you called and see if I have permission to speak with you. Can I get your name?",
    ]);
  });

  test("intro greeting omits the assistant name when unavailable", async () => {
    const f = createFlow({ deps: { resolveAssistantLabel: () => null } });

    await f.flow.start(nameCaptureOutcome, makeResolved());

    expect(f.spoken).toEqual([
      "Hi, this is Alex's assistant. Sorry, I don't recognize this number. I'll let Alex know you called and see if I have permission to speak with you. Can I get your name?",
    ]);
  });

  test("blank transcripts and DTMF are ignored while capturing the name", async () => {
    const f = createFlow();
    await f.flow.start(nameCaptureOutcome, makeResolved());

    f.flow.pushTranscriptFinal("   ");
    for (const digit of "123456") {
      f.flow.pushDtmfDigit(digit);
    }
    await sleep();

    expect(f.notifyCalls).toHaveLength(0);
    expect(f.flow.getState()).toBe("capturing_name");
  });

  test("the caller's name creates the access request and hands off to the wait controller", async () => {
    const f = createFlow();

    const wait = await startWait(f);

    expect(eventTypes(f.events)).toEqual([
      "inbound_acl_name_capture_started",
      "inbound_acl_name_captured",
    ]);
    expect(
      f.events.find((e) => e.eventType === "inbound_acl_name_captured")
        ?.payload,
    ).toEqual({ from: PHONE_NUMBER, callerName: CALLER_NAME });
    expect(f.notifyCalls).toEqual([
      {
        canonicalAssistantId: "self",
        sourceChannel: "phone",
        conversationExternalId: PHONE_NUMBER,
        actorExternalId: PHONE_NUMBER,
        actorDisplayName: CALLER_NAME,
      },
    ]);
    expect(wait.startParams).toEqual({
      requestId: REQUEST_ID,
      assistantId: "self",
      fromNumber: PHONE_NUMBER,
      callerName: CALLER_NAME,
    });
    expect(f.flow.getState()).toBe("awaiting_guardian_decision");
  });

  test("wait-state utterances are routed to the controller", async () => {
    const f = createFlow();
    const wait = await startWait(f);

    f.flow.pushTranscriptFinal("hello are you still there");
    f.flow.pushTranscriptFinal("yes call me back please");

    expect(wait.transcripts).toEqual([
      "hello are you still there",
      "yes call me back please",
    ]);
    // Wait-state DTMF stays ignored.
    f.flow.pushDtmfDigit("5");
    expect(f.results).toHaveLength(0);
  });

  test("approval runs the activation continuation and completes with proceed-handoff-spoken", async () => {
    const f = createFlow();
    const wait = await startWait(f);

    await wait.deps.onApproved({
      requestId: REQUEST_ID,
      assistantId: "self",
      fromNumber: PHONE_NUMBER,
      callerName: CALLER_NAME,
      callbackOptIn: false,
    });

    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_approved")
        ?.payload,
    ).toEqual({
      from: PHONE_NUMBER,
      callerName: CALLER_NAME,
      requestId: REQUEST_ID,
    });
    expect(f.trustResolutions).toEqual([
      { assistantId: "self", fromNumber: PHONE_NUMBER },
    ]);
    expect(f.sessionUpdates).toContainEqual({ status: "in_progress" });

    const handoff = "Great! Alex said I can speak with you. How can I help?";
    expect(f.spoken).toContain(handoff);
    expect(
      f.events.find((e) => e.eventType === "assistant_spoke")?.payload,
    ).toEqual({ text: handoff });
    expect(f.notified).toEqual([
      {
        conversationId: "conv-1",
        callSessionId: CALL_SESSION_ID,
        speaker: "assistant",
        text: handoff,
      },
    ]);
    expect(eventTypes(f.events)).toContain(
      "inbound_acl_post_approval_handoff_spoken",
    );
    expect(f.results).toEqual([
      {
        kind: "proceed-handoff-spoken",
        assistantId: "self",
        trustContext: UPGRADED_TRUST,
        deferredTranscripts: undefined,
      },
    ]);
    expect(f.flow.hasFinalized()).toBe(false);
  });

  test("denial speaks the goodbye copy, fails the session, and ends", async () => {
    const f = createFlow();
    const wait = await startWait(f);

    await wait.deps.onDenied({
      requestId: REQUEST_ID,
      assistantId: "self",
      fromNumber: PHONE_NUMBER,
      callerName: CALLER_NAME,
      callbackOptIn: false,
    });

    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_denied")
        ?.payload,
    ).toEqual({ from: PHONE_NUMBER, requestId: REQUEST_ID });
    expect(f.sessionUpdates.at(-1)).toMatchObject({
      status: "failed",
      lastError: "Inbound voice ACL: guardian denied access request",
    });
    expect(f.spoken).toContain(
      "Sorry, Alex says I'm not allowed to speak with you. Goodbye.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request denied" },
    ]);
    await sleep();
    expect(f.endReasons).toEqual(["Access request denied"]);
  });

  test("timeout without callback opt-in speaks the base copy and ends", async () => {
    const f = createFlow();
    const wait = await startWait(f);

    await wait.deps.onTimeout({
      requestId: REQUEST_ID,
      assistantId: "self",
      fromNumber: PHONE_NUMBER,
      callerName: CALLER_NAME,
      callbackOptIn: false,
    });

    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_timeout")
        ?.payload,
    ).toEqual({
      from: PHONE_NUMBER,
      requestId: REQUEST_ID,
      callbackOptIn: false,
    });
    expect(f.sessionUpdates.at(-1)).toMatchObject({
      status: "failed",
      lastError: "Inbound voice ACL: guardian approval wait timed out",
    });
    expect(f.spoken).toContain(
      "Sorry, I can't get ahold of Alex right now. I'll let them know you called.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request timed out" },
    ]);
    await sleep();
    expect(f.endReasons).toEqual(["Access request timed out"]);
  });

  test("timeout with callback opt-in appends the callback note", async () => {
    const f = createFlow();
    const wait = await startWait(f);

    await wait.deps.onTimeout({
      requestId: REQUEST_ID,
      assistantId: "self",
      fromNumber: PHONE_NUMBER,
      callerName: CALLER_NAME,
      callbackOptIn: true,
    });

    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_timeout")
        ?.payload,
    ).toMatchObject({ callbackOptIn: true });
    expect(f.spoken).toContain(
      "Sorry, I can't get ahold of Alex right now. I'll let them know you called. I've noted that you'd like a callback — I'll pass that along to Alex.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request timed out" },
    ]);
  });

  test("name-capture timeout fails the session, speaks the timeout copy, and ends", async () => {
    const f = createFlow({ deps: { nameCaptureTimeoutMs: 5 } });
    await f.flow.start(nameCaptureOutcome, makeResolved());

    await sleep(15);

    expect(
      f.events.find((e) => e.eventType === "inbound_acl_name_capture_timeout")
        ?.payload,
    ).toEqual({ from: PHONE_NUMBER });
    expect(f.sessionUpdates.at(-1)).toMatchObject({
      status: "failed",
      lastError: "Inbound voice ACL: name capture timed out",
    });
    expect(f.spoken).toContain(
      "Sorry, I didn't catch your name. Please try calling back. Goodbye.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Name capture timed out" },
    ]);
    await sleep();
    expect(f.endReasons).toEqual(["Name capture timed out"]);
  });

  test("a name arriving after capture completes does not double-handle", async () => {
    const f = createFlow({ deps: { nameCaptureTimeoutMs: 5 } });
    await f.flow.start(nameCaptureOutcome, makeResolved());
    await sleep(15);
    expect(f.results).toHaveLength(1);

    f.flow.pushTranscriptFinal(CALLER_NAME);
    await sleep();

    expect(f.notifyCalls).toHaveLength(0);
    expect(f.results).toHaveLength(1);
  });

  test("access-request creation failure fails closed to the timeout copy", async () => {
    const f = createFlow({ notifyResult: new Error("gateway down") });
    await f.flow.start(nameCaptureOutcome, makeResolved());

    f.flow.pushTranscriptFinal(CALLER_NAME);
    await sleep();

    expect(f.waits).toHaveLength(0);
    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_timeout")
        ?.payload,
    ).toEqual({ from: PHONE_NUMBER, requestId: null, callbackOptIn: false });
    expect(f.spoken).toContain(
      "Sorry, I can't get ahold of Alex right now. I'll let them know you called.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request timed out" },
    ]);
  });

  test("a notified:false result (no sender id) also fails closed", async () => {
    const f = createFlow({
      notifyResult: { notified: false, reason: "no_sender_id" },
    });
    await f.flow.start(nameCaptureOutcome, makeResolved());

    f.flow.pushTranscriptFinal(CALLER_NAME);
    await sleep();

    expect(f.waits).toHaveLength(0);
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request timed out" },
    ]);
  });

  test("a previously denied caller gets the denial copy, not the timeout copy", async () => {
    const f = createFlow({
      notifyResult: { notified: false, reason: "already_denied" },
    });
    await f.flow.start(nameCaptureOutcome, makeResolved());

    f.flow.pushTranscriptFinal(CALLER_NAME);
    await sleep();

    expect(f.waits).toHaveLength(0);
    expect(
      f.events.find((e) => e.eventType === "inbound_acl_access_denied")
        ?.payload,
    ).toEqual({ from: PHONE_NUMBER, requestId: null });
    expect(f.spoken).toContain(
      "Sorry, Alex says I'm not allowed to speak with you. Goodbye.",
    );
    expect(f.results).toEqual([
      { kind: "ended", reason: "Access request denied" },
    ]);
  });

  describe("dispose", () => {
    test("disconnect mid-wait disposes the controller and never emits a result", async () => {
      const f = createFlow();
      const wait = await startWait(f);

      f.flow.dispose("transport_closed");

      expect(wait.disposeReasons).toEqual(["transport_closed"]);
      expect(f.flow.getState()).toBe("completed");
      expect(f.flow.hasFinalized()).toBe(false);
      expect(f.results).toHaveLength(0);

      // Idempotent, and late input is swallowed.
      f.flow.dispose("transport_closed");
      f.flow.pushTranscriptFinal("hello?");
      expect(wait.disposeReasons).toEqual(["transport_closed"]);
      expect(wait.transcripts).toEqual([]);
    });

    test("disconnect mid-capture clears the name-capture timer", async () => {
      const f = createFlow({ deps: { nameCaptureTimeoutMs: 5 } });
      await f.flow.start(nameCaptureOutcome, makeResolved());

      f.flow.dispose("transport_closed");
      await sleep(15);

      // No timeout copy, no terminal result, no session teardown after dispose.
      expect(
        eventTypes(f.events).includes("inbound_acl_name_capture_timeout"),
      ).toBe(false);
      expect(f.results).toHaveLength(0);
      expect(f.endReasons).toEqual([]);
    });

    test("dispose during access-request creation suppresses the fail-closed teardown", async () => {
      let releaseNotify!: (result: NotifyResult) => void;
      const gated = new Promise<NotifyResult>((resolve) => {
        releaseNotify = resolve;
      });
      const f = createFlow({
        deps: { notifyGuardianOfAccessRequest: () => gated },
      });
      await f.flow.start(nameCaptureOutcome, makeResolved());
      f.flow.pushTranscriptFinal(CALLER_NAME);
      await sleep();

      f.flow.dispose("transport_closed");
      releaseNotify({ notified: true, created: true, requestId: REQUEST_ID });
      await sleep();

      expect(f.waits).toHaveLength(0);
      expect(f.results).toHaveLength(0);
    });

    test("dispose during post-approval trust re-resolution suppresses the handoff", async () => {
      let releaseTrust!: (ctx: TrustContext) => void;
      const gated = new Promise<TrustContext>((resolve) => {
        releaseTrust = resolve;
      });
      const f = createFlow({
        deps: { resolveMidCallTrustContext: () => gated },
      });
      const wait = await startWait(f);

      const approval = wait.deps.onApproved({
        requestId: REQUEST_ID,
        assistantId: "self",
        fromNumber: PHONE_NUMBER,
        callerName: CALLER_NAME,
        callbackOptIn: false,
      });
      await sleep();

      // Caller hangs up while trust re-resolution is still in flight.
      f.flow.dispose("transport_closed");
      releaseTrust(UPGRADED_TRUST);
      await approval;

      // No synthetic handoff on the dead call: no speech, transcript
      // event, notifier delivery, or terminal result.
      expect(f.spoken).not.toContain(
        "Great! Alex said I can speak with you. How can I help?",
      );
      expect(eventTypes(f.events)).not.toContain("assistant_spoke");
      expect(eventTypes(f.events)).not.toContain(
        "inbound_acl_post_approval_handoff_spoken",
      );
      expect(f.notified).toEqual([]);
      expect(f.results).toHaveLength(0);
    });

    test("hasFinalized reports flow-side finalization so the close handler can skip", async () => {
      // Drive a sub-flow that finalizes inside the flow (invite failure).
      const f = createFlow({
        deps: {
          attemptInviteCodeRedemption: async () => ({
            outcome: "failure" as const,
            ttsMessage: "That code is not valid. Goodbye.",
          }),
        },
      });
      await f.flow.start(
        {
          action: "invite_redemption",
          assistantId: "self",
          fromNumber: PHONE_NUMBER,
          inviteeName: null,
        },
        makeResolved(),
      );
      for (const digit of "123456") {
        f.flow.pushDtmfDigit(digit);
      }
      await sleep();

      expect(f.finalized).toEqual([
        { callSessionId: CALL_SESSION_ID, conversationId: "conv-1" },
      ]);
      expect(f.flow.hasFinalized()).toBe(true);

      // A transport close after the flow finalized must not finalize again.
      f.flow.dispose("transport_closed");
      expect(f.finalized).toHaveLength(1);
    });
  });
});

describe("CallSetupFlow unverified caller", () => {
  test("guardian variant speaks the self-service verification guidance and ends", async () => {
    const f = createFlow();

    await f.flow.start(unverifiedOutcome(true), makeResolved());

    expect(f.events).toEqual([
      {
        eventType: "inbound_acl_unverified_caller",
        payload: { callSessionId: CALL_SESSION_ID, isGuardian: true },
      },
    ]);
    expect(f.sessionUpdates.at(-1)).toMatchObject({
      status: "failed",
      lastError: "Inbound voice ACL: caller channel unverified",
    });
    expect(f.spoken).toEqual([
      "This number is registered as Sam Example's phone but has not been verified yet. " +
        "To verify, open your assistant's contacts page, click Verify next to the phone channel, " +
        "and follow the prompts. Then call back once the verification session is active.",
    ]);
    expect(f.results).toEqual([
      { kind: "ended", reason: "Inbound voice ACL: caller channel unverified" },
    ]);
    await sleep();
    expect(f.endReasons).toEqual([
      "Inbound voice ACL: caller channel unverified",
    ]);
  });

  test("non-guardian variant directs the caller to the guardian", async () => {
    const f = createFlow();

    await f.flow.start(unverifiedOutcome(false), makeResolved());

    expect(f.spoken).toEqual([
      "This number is registered as Sam Example's phone but has not been verified yet. " +
        "Please reach out to the account guardian to start a new verification session, " +
        "then call back once the verification session is active.",
    ]);
    expect(f.results).toEqual([
      { kind: "ended", reason: "Inbound voice ACL: caller channel unverified" },
    ]);
  });
});
