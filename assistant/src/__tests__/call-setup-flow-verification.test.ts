import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock (must come before any source imports) ────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── toTrustContext stub ──────────────────────────────────────────────

mock.module("../runtime/actor-trust-resolver.js", () => ({
  toTrustContext: (ctx: { trustClass: string }, externalId: string) => ({
    sourceChannel: "phone",
    trustClass: ctx.trustClass,
    requesterExternalUserId: externalId,
  }),
}));

// ── Verification template stub ───────────────────────────────────────
// Deterministic, dependency-free copy so the flow's spoken prompts are
// assertable without loading the real template/config machinery.

mock.module("../runtime/verification-templates.js", () => ({
  GUARDIAN_VERIFY_TEMPLATE_KEYS: {
    VOICE_CALL_INTRO: "voice.call_intro",
    VOICE_RETRY: "voice.retry",
    VOICE_SUCCESS: "voice.success",
    VOICE_FAILURE: "voice.failure",
  },
  composeVerificationVoice: (key: string, vars: { codeDigits: number }) =>
    `[${key}:${vars.codeDigits}]`,
}));

// ── attemptVerificationCode stub ─────────────────────────────────────
// Drive the guardian success/retry/failure branches deterministically
// without the channel-verification service / config. parseDigitsFromSpeech
// is kept real (it is pure and transport-agnostic).

const verificationOutcomes: Array<
  | {
      outcome: "success";
      verificationType: "guardian" | "trusted_contact";
      eventName: string;
    }
  | {
      outcome: "failure";
      eventName: string;
      ttsMessage: string;
      attempts: number;
    }
  | {
      outcome: "retry";
      ttsMessage: string;
      attempt: number;
      maxAttempts: number;
    }
> = [];

mock.module("../calls/relay-verification.js", () => ({
  parseDigitsFromSpeech: (transcript: string) => {
    const words: Record<string, string> = {
      one: "1",
      two: "2",
      three: "3",
      four: "4",
      five: "5",
      six: "6",
    };
    const digits: string[] = [];
    for (const token of transcript.toLowerCase().split(/[\s,]+/)) {
      if (/^\d+$/.test(token)) digits.push(...token.split(""));
      else if (words[token]) digits.push(words[token]);
    }
    return digits.join("");
  },
  attemptVerificationCode: () => {
    const next = verificationOutcomes.shift();
    if (!next) throw new Error("no queued verification outcome");
    return next;
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
import type {
  SetupOutcome,
  SetupResolved,
} from "../calls/relay-setup-router.js";
import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";

// ── Test doubles ─────────────────────────────────────────────────────

function makeTransport() {
  const calls = {
    ended: [] as Array<string | undefined>,
  };
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

function makeDeps(session: SetupFlowSession | null) {
  const completed: SetupFlowResult[] = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const spoken: string[] = [];
  const pointers: Array<{
    conversationId: string;
    event: string;
    phoneNumber: string;
    extra?: Record<string, unknown>;
  }> = [];
  const codePosts: Array<{
    conversationId: string;
    toNumber: string;
    code: string;
  }> = [];
  const transcripts: Array<{ speaker: string; text: string }> = [];
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];

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
    async postCalleeVerificationCode(conversationId, toNumber, code) {
      codePosts.push({ conversationId, toNumber, code });
    },
    async addPointerMessage(conversationId, event, phoneNumber, extra) {
      pointers.push({ conversationId, event, phoneNumber, extra });
    },
    fireTranscript(_conversationId, _callSessionId, speaker, text) {
      transcripts.push({ speaker, text });
    },
    composeTrustedContactHandoffText: () => "Verified — welcome!",
    hangupDelayMs: 999,
    schedule(fn, delayMs) {
      scheduled.push({ fn, delayMs });
    },
  };
  return {
    deps,
    completed,
    events,
    spoken,
    pointers,
    codePosts,
    transcripts,
    scheduled,
  };
}

const RESOLVED: SetupResolved = {
  assistantId: "asst_test",
  isInbound: true,
  otherPartyNumber: "+15550100",
  actorTrust: { trustClass: "guardian" } as unknown as ActorTrustContext,
};

const SESSION: SetupFlowSession = {
  conversationId: "conv_voice",
  toNumber: "+15550199",
  initiatedFromConversationId: "conv_origin",
};

function pushDigits(flow: CallSetupFlow, code: string): void {
  for (const d of code) flow.pushDtmfDigit(d);
}

describe("CallSetupFlow verification sub-flows", () => {
  beforeEach(() => {
    verificationOutcomes.length = 0;
  });

  // ── Inbound guardian verification ──────────────────────────────────

  test("inbound guardian: correct DTMF code → proceed-initial-greeting", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const outcome: SetupOutcome = {
      action: "verification",
      assistantId: "asst_test",
      fromNumber: "+15550100",
    };
    const started = flow.start(outcome, RESOLVED);
    expect(flow.getState()).toBe("collecting_code");

    verificationOutcomes.push({
      outcome: "success",
      verificationType: "guardian",
      eventName: "voice_verification_succeeded",
    });
    pushDigits(flow, "123456");

    const result = await started;
    expect(result.kind).toBe("proceed-initial-greeting");
    expect(flow.getState()).toBe("completed");
    expect(ctx.events.map((e) => e.type)).toContain(
      "voice_verification_started",
    );
    expect(ctx.events.map((e) => e.type)).toContain(
      "voice_verification_succeeded",
    );
  });

  test("inbound trusted_contact success → proceed-handoff-spoken + notifier", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      { action: "verification", assistantId: "asst_test", fromNumber: "+1" },
      RESOLVED,
    );
    verificationOutcomes.push({
      outcome: "success",
      verificationType: "trusted_contact",
      eventName: "voice_verification_succeeded",
    });
    pushDigits(flow, "123456");

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
    // Handoff copy is spoken and an assistant_spoke event + transcript fire.
    expect(ctx.spoken).toContain("Verified — welcome!");
    expect(ctx.events.map((e) => e.type)).toContain("assistant_spoke");
    expect(ctx.transcripts).toEqual([
      { speaker: "assistant", text: "Verified — welcome!" },
    ]);
  });

  test("inbound guardian: wrong code under max → retry (no completion)", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(
      { action: "verification", assistantId: "asst_test", fromNumber: "+1" },
      RESOLVED,
    );
    verificationOutcomes.push({
      outcome: "retry",
      ttsMessage: "That code was incorrect. Please try again.",
      attempt: 1,
      maxAttempts: 3,
    });
    pushDigits(flow, "000000");

    expect(ctx.completed).toHaveLength(0);
    expect(flow.getState()).toBe("collecting_code");
    expect(ctx.spoken).toContain("That code was incorrect. Please try again.");
  });

  test("inbound guardian: exceed max attempts → ended with deferred hangup", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      { action: "verification", assistantId: "asst_test", fromNumber: "+1" },
      RESOLVED,
    );
    verificationOutcomes.push({
      outcome: "failure",
      eventName: "voice_verification_failed",
      ttsMessage: "Verification failed. Goodbye.",
      attempts: 3,
    });
    pushDigits(flow, "000000");

    const result = await started;
    expect(result).toEqual({
      kind: "ended",
      reason: "Verification failed — challenge rejected",
    });
    // Hangup is deferred, not synchronous.
    expect(transport.calls.ended).toHaveLength(0);
    expect(ctx.scheduled).toHaveLength(1);
    expect(ctx.scheduled[0]!.delayMs).toBe(999);
    ctx.scheduled[0]!.fn();
    expect(transport.calls.ended).toEqual([
      "Verification failed — challenge rejected",
    ]);
  });

  // ── Outbound guardian verification ─────────────────────────────────

  test("outbound: spoken digits → proceed-post-verification-greeting + pointer", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      {
        action: "outbound_verification",
        assistantId: "asst_test",
        sessionId: "vs_1",
        toNumber: "+15550199",
      },
      RESOLVED,
    );
    verificationOutcomes.push({
      outcome: "success",
      verificationType: "guardian",
      eventName: "outbound_voice_verification_succeeded",
    });
    // Spoken digits, parsed via parseDigitsFromSpeech.
    flow.pushTranscriptFinal("one two three four five six");

    const result = await started;
    expect(result.kind).toBe("proceed-post-verification-greeting");
    expect(ctx.pointers).toEqual([
      {
        conversationId: "conv_origin",
        event: "verification_succeeded",
        phoneNumber: "+15550199",
        extra: { channel: "phone" },
      },
    ]);
  });

  test("outbound: failure → pointer + ended", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      {
        action: "outbound_verification",
        assistantId: "asst_test",
        sessionId: "vs_1",
        toNumber: "+15550199",
      },
      RESOLVED,
    );
    verificationOutcomes.push({
      outcome: "failure",
      eventName: "outbound_voice_verification_failed",
      ttsMessage: "[voice.failure:6]",
      attempts: 3,
    });
    pushDigits(flow, "000000");

    const result = await started;
    expect(result.kind).toBe("ended");
    expect(ctx.pointers).toEqual([
      {
        conversationId: "conv_origin",
        event: "verification_failed",
        phoneNumber: "+15550199",
        extra: {
          channel: "phone",
          reason: "Max verification attempts exceeded",
        },
      },
    ]);
  });

  // ── Outbound callee verification ───────────────────────────────────

  test("callee: posts code, correct entry → proceed-initial-greeting", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      {
        action: "callee_verification",
        verificationConfig: { maxAttempts: 3, codeLength: 4 },
      },
      RESOLVED,
    );
    // Let the async setup (speak + code post) settle before collecting.
    await Promise.resolve();
    await Promise.resolve();
    expect(flow.getState()).toBe("collecting_code");

    // The generated code was posted to the originating conversation.
    expect(ctx.codePosts).toHaveLength(1);
    const posted = ctx.codePosts[0]!;
    expect(posted.conversationId).toBe("conv_origin");
    expect(posted.toNumber).toBe("+15550199");
    expect(posted.code).toHaveLength(4);

    // Entering the correct code succeeds.
    pushDigits(flow, posted.code);
    const result = await started;
    expect(result.kind).toBe("proceed-initial-greeting");
    expect(ctx.events.map((e) => e.type)).toContain(
      "callee_verification_succeeded",
    );
  });

  test("callee: wrong code under max → retry; exceed max → ended + pointer", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(
      {
        action: "callee_verification",
        verificationConfig: { maxAttempts: 2, codeLength: 4 },
      },
      RESOLVED,
    );
    await Promise.resolve();
    await Promise.resolve();
    const correct = ctx.codePosts[0]!.code;
    const wrong = correct === "9999" ? "0000" : "9999";

    // First wrong attempt → retry.
    pushDigits(flow, wrong);
    expect(ctx.completed).toHaveLength(0);
    expect(flow.getState()).toBe("collecting_code");
    expect(ctx.spoken).toContain("That code was incorrect. Please try again.");

    // Second wrong attempt → max reached → ended + pointer.
    pushDigits(flow, wrong);
    const result = await started;
    expect(result.kind).toBe("ended");
    expect(ctx.completed.at(-1)?.kind).toBe("ended");
    expect(ctx.events.map((e) => e.type)).toContain(
      "callee_verification_failed",
    );
    expect(ctx.pointers).toEqual([
      {
        conversationId: "conv_origin",
        event: "failed",
        phoneNumber: "+15550199",
        extra: { reason: "Callee verification failed" },
      },
    ]);
    expect(ctx.scheduled).toHaveLength(1);
  });
});
