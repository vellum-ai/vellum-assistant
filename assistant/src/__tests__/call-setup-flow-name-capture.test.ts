import { describe, expect, mock, test } from "bun:test";

// ── Logger mock (must come before any source imports) ────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── toTrustContext stub ──────────────────────────────────────────────

mock.module("../runtime/actor-trust-resolver.js", () => ({
  toTrustContext: (ctx: { trustClass?: string }, externalId: string) => ({
    sourceChannel: "phone",
    trustClass: ctx.trustClass ?? "unknown",
    requesterExternalUserId: externalId,
  }),
}));

// ── Verification template stub ───────────────────────────────────────

mock.module("../runtime/verification-templates.js", () => ({
  GUARDIAN_VERIFY_TEMPLATE_KEYS: { VOICE_CALL_INTRO: "voice.call_intro" },
  composeVerificationVoice: (key: string, vars: { codeDigits: number }) =>
    `[${key}:${vars.codeDigits}]`,
}));

// ── relay-verification stub (parseDigitsFromSpeech kept real-ish) ─────

mock.module("../calls/relay-verification.js", () => ({
  parseDigitsFromSpeech: (transcript: string) => transcript.replace(/\D/g, ""),
  attemptInviteCodeRedemption: () => {
    throw new Error("not used in name-capture tests");
  },
  attemptVerificationCode: () => {
    throw new Error("not used in name-capture tests");
  },
}));

import {
  CallSetupFlow,
  type CallSetupFlowDeps,
  type SetupFlowSession,
} from "../calls/call-setup-flow.js";
import type {
  SetupFlowResult,
  SetupFlowTransport,
} from "../calls/call-setup-flow-types.js";
import type { GuardianWaitControllerDeps } from "../calls/guardian-wait-controller.js";
import type {
  SetupOutcome,
  SetupResolved,
} from "../calls/relay-setup-router.js";
import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";

// ── Test doubles ─────────────────────────────────────────────────────

function makeTransport() {
  const calls = { ended: [] as Array<string | undefined> };
  const transport: SetupFlowTransport = {
    sendTextToken() {},
    endSession(reason) {
      calls.ended.push(reason);
    },
    getConnectionState() {
      return "connected";
    },
  };
  return { transport, calls };
}

/**
 * Fake guardian-wait controller: records `start`/`handleTranscript`/`dispose`
 * and exposes the wired resolution callbacks so a test can drive the
 * approve/deny/timeout paths deterministically without real timers.
 */
function makeFakeController() {
  const record = {
    started: [] as Array<{
      accessRequestId: string;
      assistantId: string;
      fromNumber: string;
      callerName: string | null;
    }>,
    transcripts: [] as string[],
    disposeCount: 0,
    deps: null as GuardianWaitControllerDeps | null,
  };
  const controller = {
    start(params: {
      accessRequestId: string;
      assistantId: string;
      fromNumber: string;
      callerName: string | null;
    }) {
      record.started.push(params);
    },
    handleTranscript(text: string) {
      record.transcripts.push(text);
    },
    dispose() {
      record.disposeCount += 1;
    },
    getState() {
      return "awaiting_guardian_decision" as const;
    },
  };
  return { controller, record };
}

function makeDeps(
  session: SetupFlowSession | null,
  fakeController: ReturnType<typeof makeFakeController>,
  overrides: Partial<CallSetupFlowDeps> = {},
) {
  const completed: SetupFlowResult[] = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const spoken: string[] = [];
  const transcripts: Array<{ speaker: string; text: string }> = [];
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const finalized: string[] = [];
  const nameTimers: Array<{ fn: () => void; delayMs: number }> = [];
  const accessRequestArgs: Array<{
    assistantId: string;
    fromNumber: string;
    callerName: string;
  }> = [];
  let waitingMarked = 0;

  const deps: CallSetupFlowDeps = {
    async speakSystemPrompt(_t, text) {
      spoken.push(text);
    },
    recordCallEvent(_id, eventType, payload) {
      events.push({ type: eventType, payload });
    },
    onComplete(result) {
      completed.push(result);
    },
    getSession: () => session,
    fireTranscript(_conversationId, _callSessionId, speaker, text) {
      transcripts.push({ speaker, text });
    },
    finalizeFailedCall(reason) {
      finalized.push(reason);
    },
    resolveGuardianLabel: () => "Alex",
    resolveAssistantLabel: () => "Cleo",
    createAccessRequest(input) {
      accessRequestArgs.push(input);
      return "access-req-1";
    },
    markWaitingOnUser() {
      waitingMarked += 1;
    },
    makeGuardianWaitController: (_id, _t, controllerDeps) => {
      fakeController.record.deps = controllerDeps;
      return fakeController.controller as never;
    },
    nameCaptureTimeoutMs: 30_000,
    setNameCaptureTimer: (fn, delayMs) => {
      nameTimers.push({ fn, delayMs });
      return nameTimers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearNameCaptureTimer: (handle) => {
      const idx = (handle as unknown as number) - 1;
      if (idx >= 0 && idx < nameTimers.length)
        nameTimers[idx] = { fn: () => {}, delayMs: -1 };
    },
    hangupDelayMs: 999,
    schedule(fn, delayMs) {
      scheduled.push({ fn, delayMs });
    },
    ...overrides,
  };
  return {
    deps,
    completed,
    events,
    spoken,
    transcripts,
    scheduled,
    finalized,
    nameTimers,
    accessRequestArgs,
    waitingMarked: () => waitingMarked,
  };
}

const RESOLVED: SetupResolved = {
  assistantId: "asst_test",
  isInbound: true,
  otherPartyNumber: "+15550100",
  actorTrust: { trustClass: "unknown" } as unknown as ActorTrustContext,
};

const SESSION: SetupFlowSession = {
  conversationId: "conv_voice",
  toNumber: "+15550199",
  initiatedFromConversationId: "conv_origin",
};

const NAME_CAPTURE: Extract<SetupOutcome, { action: "name_capture" }> = {
  action: "name_capture",
  assistantId: "asst_test",
  fromNumber: "+15550100",
};

const UNVERIFIED: Extract<SetupOutcome, { action: "unverified_caller" }> = {
  action: "unverified_caller",
  assistantId: "asst_test",
  fromNumber: "+15550100",
  displayName: "Sam",
  isGuardian: false,
};

describe("CallSetupFlow name-capture sub-flow", () => {
  test("greets, captures name, opens access request, starts the wait", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(NAME_CAPTURE, RESOLVED);
    await Promise.resolve();

    expect(flow.getState()).toBe("capturing_name");
    // Greeting includes the assistant + guardian labels.
    expect(
      ctx.spoken.some((t) => t.includes("Cleo") && t.includes("Alex")),
    ).toBe(true);
    expect(ctx.events.map((e) => e.type)).toContain(
      "inbound_acl_name_capture_started",
    );
    // A silence timeout was armed.
    expect(ctx.nameTimers).toHaveLength(1);
    expect(ctx.nameTimers[0]!.delayMs).toBe(30_000);

    // Caller speaks their name.
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();

    expect(ctx.accessRequestArgs).toEqual([
      {
        assistantId: "asst_test",
        fromNumber: "+15550100",
        callerName: "Robin",
      },
    ]);
    expect(ctx.events.map((e) => e.type)).toContain(
      "inbound_acl_name_captured",
    );
    expect(flow.getState()).toBe("awaiting_guardian_decision");
    // The wait controller was started with the opened request + captured name.
    expect(fake.record.started).toEqual([
      {
        accessRequestId: "access-req-1",
        assistantId: "asst_test",
        fromNumber: "+15550100",
        callerName: "Robin",
      },
    ]);
  });

  test("whitespace-only transcript does not capture a name", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("   ");
    await Promise.resolve();

    expect(flow.getState()).toBe("capturing_name");
    expect(ctx.accessRequestArgs).toHaveLength(0);
    expect(fake.record.started).toHaveLength(0);
  });

  test("approval → proceed-handoff-spoken with handoff copy + notifier", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();

    // The controller marks waiting + drives approval.
    fake.record.deps!.markWaitingOnUser();
    expect(ctx.waitingMarked()).toBe(1);

    fake.record.deps!.onApproved({
      assistantId: "asst_test",
      fromNumber: "+15550100",
      callerName: "Robin",
    });

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
    expect(flow.getState()).toBe("completed");
    expect(ctx.spoken.some((t) => t.includes("Alex"))).toBe(true);
    expect(ctx.events.map((e) => e.type)).toContain(
      "inbound_acl_post_approval_handoff_spoken",
    );
    expect(ctx.events.map((e) => e.type)).toContain("assistant_spoke");
    expect(ctx.transcripts).toHaveLength(1);
    expect(ctx.transcripts[0]!.speaker).toBe("assistant");
  });

  test("caller speaks during the wait → routed to the controller", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();
    expect(flow.getState()).toBe("awaiting_guardian_decision");

    flow.pushTranscriptFinal("are you still there?");
    expect(fake.record.transcripts).toEqual(["are you still there?"]);
  });

  test("denial → ended (deferred hangup) + single finalization", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();

    fake.record.deps!.onDenied({ guardianLabel: "Alex" });
    const result = await started;
    expect(result).toEqual({ kind: "ended", reason: "Access request denied" });
    expect(flow.getState()).toBe("completed");
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: guardian denied access request",
    ]);
    // Hangup deferred, not synchronous.
    expect(transport.calls.ended).toHaveLength(0);
    expect(ctx.scheduled).toHaveLength(1);
    ctx.scheduled[0]!.fn();
    expect(transport.calls.ended).toEqual(["Access request denied"]);

    // Disposing afterward does not re-finalize or double-hang-up.
    flow.dispose();
    expect(fake.record.disposeCount).toBe(0);
    expect(ctx.finalized).toHaveLength(1);
  });

  test("timeout → ended with callback note when opted in", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();

    fake.record.deps!.onTimeout({ guardianLabel: "Alex", callbackOptIn: true });
    const result = await started;
    expect(result).toEqual({
      kind: "ended",
      reason: "Access request timed out",
    });
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: guardian approval wait timed out",
    ]);
    expect(ctx.spoken.some((t) => t.toLowerCase().includes("callback"))).toBe(
      true,
    );
  });

  test("disconnect mid-wait disposes the controller exactly once", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");
    await Promise.resolve();
    expect(flow.getState()).toBe("awaiting_guardian_decision");

    flow.dispose();
    expect(fake.record.disposeCount).toBe(1);
    // Idempotent.
    flow.dispose();
    expect(fake.record.disposeCount).toBe(1);
  });

  test("no access request opened → fails closed (timeout copy + ended)", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake, {
      createAccessRequest: () => null,
    });
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");

    const result = await started;
    expect(result.kind).toBe("ended");
    expect(result).toMatchObject({ reason: "Access request timed out" });
    // Wait controller never started.
    expect(fake.record.started).toHaveLength(0);
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: guardian approval wait timed out",
    ]);
  });

  test("createAccessRequest throws → fails closed (timeout copy + ended), promise resolves", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake, {
      createAccessRequest: () => {
        throw new Error("guardian-notification failed");
      },
    });
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    flow.pushTranscriptFinal("Robin");

    // A thrown createAccessRequest must not escape pushTranscriptFinal and
    // strand start(); it routes to the same fail-closed timeout path as null.
    const result = await started;
    expect(result.kind).toBe("ended");
    expect(result).toMatchObject({ reason: "Access request timed out" });
    expect(fake.record.started).toHaveLength(0);
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: guardian approval wait timed out",
    ]);
  });

  test("silent-caller name-capture timeout → ended + finalize", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(NAME_CAPTURE, RESOLVED);
    expect(ctx.nameTimers).toHaveLength(1);

    // Fire the silence timeout.
    ctx.nameTimers[0]!.fn();
    const result = await started;
    expect(result).toEqual({
      kind: "ended",
      reason: "Name capture timed out",
    });
    expect(ctx.events.map((e) => e.type)).toContain(
      "inbound_acl_name_capture_timeout",
    );
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: name capture timed out",
    ]);
  });
});

describe("CallSetupFlow unverified-caller sub-flow", () => {
  test("speaks guidance then ends (deferred hangup) + finalize", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const result = await flow.start(UNVERIFIED, RESOLVED);
    expect(result.kind).toBe("ended");
    expect(flow.getState()).toBe("completed");
    expect(ctx.events.map((e) => e.type)).toContain(
      "inbound_acl_unverified_caller",
    );
    expect(ctx.spoken.some((t) => t.includes("Sam"))).toBe(true);
    expect(ctx.finalized).toEqual([
      "Inbound voice ACL: caller channel unverified",
    ]);

    // Hangup deferred.
    expect(transport.calls.ended).toHaveLength(0);
    expect(ctx.scheduled).toHaveLength(1);
    ctx.scheduled[0]!.fn();
    expect(transport.calls.ended).toEqual([
      "Inbound voice ACL: caller channel unverified",
    ]);
  });

  test("guardian variant speaks the self-serve verification guidance", async () => {
    const transport = makeTransport();
    const fake = makeFakeController();
    const ctx = makeDeps(SESSION, fake);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    await flow.start(
      { ...UNVERIFIED, isGuardian: true, displayName: "Pat" },
      RESOLVED,
    );
    expect(ctx.spoken.some((t) => t.includes("contacts page"))).toBe(true);
  });
});
