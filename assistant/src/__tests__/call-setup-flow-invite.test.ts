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

mock.module("../runtime/verification-templates.js", () => ({
  GUARDIAN_VERIFY_TEMPLATE_KEYS: {
    VOICE_CALL_INTRO: "voice.call_intro",
  },
  composeVerificationVoice: (key: string, vars: { codeDigits: number }) =>
    `[${key}:${vars.codeDigits}]`,
}));

// ── attemptInviteCodeRedemption stub ─────────────────────────────────
// Drive the invite success/failure branches deterministically without the
// invite service. parseDigitsFromSpeech is kept real (pure, transport-agnostic).

const inviteOutcomes: Array<
  | {
      outcome: "success";
      memberId: string;
      type: "redeemed" | "already_member";
      inviteId?: string;
    }
  | { outcome: "failure"; ttsMessage: string }
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
  attemptInviteCodeRedemption: () => {
    const next = inviteOutcomes.shift();
    if (!next) throw new Error("no queued invite outcome");
    return next;
  },
  // Unused here but part of the module surface.
  attemptVerificationCode: () => {
    throw new Error("not used in invite tests");
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
import type {
  ActorTrustContext,
  ResolveActorTrustInput,
} from "../runtime/actor-trust-resolver.js";

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

function makeDeps(
  session: SetupFlowSession | null,
  overrides: Partial<CallSetupFlowDeps> = {},
) {
  const completed: SetupFlowResult[] = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const spoken: string[] = [];
  const pointers: Array<{ event: string }> = [];
  const transcripts: Array<{ speaker: string; text: string }> = [];
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const finalized: string[] = [];

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
    async addPointerMessage(_conversationId, event) {
      pointers.push({ event });
    },
    fireTranscript(_conversationId, _callSessionId, speaker, text) {
      transcripts.push({ speaker, text });
    },
    composeInviteRedemptionPrompt: ({ isOutbound, friendName, guardianName }) =>
      `prompt:${isOutbound ? "out" : "in"}:${friendName}:${guardianName}`,
    composeInviteHandoffText: ({ friendName }) =>
      `handoff:${friendName ?? "friend"}`,
    finalizeFailedCall(reason) {
      finalized.push(reason);
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
    pointers,
    transcripts,
    scheduled,
    finalized,
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

const INVITE_OUTCOME: Extract<SetupOutcome, { action: "invite_redemption" }> = {
  action: "invite_redemption",
  assistantId: "asst_test",
  fromNumber: "+15550100",
  friendName: "Robin",
  guardianName: "Alex",
};

function pushDigits(flow: CallSetupFlow, code: string): void {
  for (const d of code) flow.pushDtmfDigit(d);
}

describe("CallSetupFlow invite-redemption sub-flow", () => {
  beforeEach(() => {
    inviteOutcomes.length = 0;
  });

  test("starts collecting and speaks the (inbound) prompt", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(INVITE_OUTCOME, RESOLVED);
    await Promise.resolve();

    expect(flow.getState()).toBe("collecting_code");
    expect(ctx.spoken).toContain("prompt:in:Robin:Alex");
    expect(ctx.events.map((e) => e.type)).toContain(
      "invite_redemption_started",
    );
  });

  test("outbound direction is reflected in the prompt", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    flow.start(INVITE_OUTCOME, { ...RESOLVED, isInbound: false });
    await Promise.resolve();

    expect(ctx.spoken).toContain("prompt:out:Robin:Alex");
  });

  test("valid code → proceed-handoff-spoken with handoff copy + notifier", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "success",
      memberId: "member_1",
      type: "redeemed",
      inviteId: "invite_1",
    });
    pushDigits(flow, "123456");

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
    expect(flow.getState()).toBe("completed");

    // Handoff copy spoken + assistant_spoke event + transcript fire.
    expect(ctx.spoken).toContain("handoff:Robin");
    expect(ctx.events.map((e) => e.type)).toContain(
      "invite_redemption_succeeded",
    );
    expect(ctx.events.map((e) => e.type)).toContain("assistant_spoke");
    expect(ctx.transcripts).toEqual([
      { speaker: "assistant", text: "handoff:Robin" },
    ]);
    // Success event carries the redemption side-effect identifiers.
    const success = ctx.events.find(
      (e) => e.type === "invite_redemption_succeeded",
    );
    expect(success?.payload).toMatchObject({
      memberId: "member_1",
      inviteId: "invite_1",
    });
  });

  test("already_member success also proceeds to handoff", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "success",
      memberId: "member_2",
      type: "already_member",
    });
    pushDigits(flow, "654321");

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
    const success = ctx.events.find(
      (e) => e.type === "invite_redemption_succeeded",
    );
    expect(success?.payload).toMatchObject({ memberId: "member_2" });
    // No inviteId on the already_member branch.
    expect(success?.payload).not.toHaveProperty("inviteId");
  });

  test("success re-resolves trust for the redeemed member (not stale)", async () => {
    const transport = makeTransport();
    const resolveArgs: ResolveActorTrustInput[] = [];
    const resolveActorTrust = (input: ResolveActorTrustInput) => {
      resolveArgs.push(input);
      return { trustClass: "trusted_contact" } as unknown as ActorTrustContext;
    };
    const ctx = makeDeps(SESSION, { resolveActorTrust });
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "success",
      memberId: "member_1",
      type: "redeemed",
      inviteId: "invite_1",
    });
    pushDigits(flow, "123456");

    const result = await started;
    expect(resolveArgs).toHaveLength(1);
    expect(resolveArgs[0]).toMatchObject({
      assistantId: "asst_test",
      sourceChannel: "phone",
      conversationExternalId: "+15550100",
      actorExternalId: "+15550100",
    });
    if (result.kind === "proceed-handoff-spoken") {
      expect(result.trustContext).toMatchObject({
        trustClass: "trusted_contact",
      });
    }
  });

  test("invalid/expired code → failure spoken then ended (deferred hangup)", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "failure",
      ttsMessage: "Sorry, that code is expired. Goodbye.",
    });
    pushDigits(flow, "000000");

    const result = await started;
    expect(result).toEqual({
      kind: "ended",
      reason: "Invite redemption failed",
    });
    expect(flow.getState()).toBe("completed");

    expect(ctx.events.map((e) => e.type)).toContain("invite_redemption_failed");
    expect(ctx.finalized).toEqual([
      "Voice invite redemption failed — invalid or expired code",
    ]);
    expect(ctx.spoken).toContain("Sorry, that code is expired. Goodbye.");

    // Hangup is deferred, not synchronous.
    expect(transport.calls.ended).toHaveLength(0);
    expect(ctx.scheduled).toHaveLength(1);
    expect(ctx.scheduled[0]!.delayMs).toBe(999);
    ctx.scheduled[0]!.fn();
    expect(transport.calls.ended).toEqual(["Invite redemption failed"]);
  });

  test("spoken digits drive redemption too", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION);
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "success",
      memberId: "member_1",
      type: "redeemed",
      inviteId: "invite_1",
    });
    flow.pushTranscriptFinal("one two three four five six");

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
  });

  test("rejecting finalize dep on failure still ends the flow", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION, {
      finalizeFailedCall() {
        throw new Error("call session already gone");
      },
    });
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "failure",
      ttsMessage: "Sorry, that code is expired. Goodbye.",
    });
    pushDigits(flow, "000000");

    const result = await started;
    expect(result.kind).toBe("ended");
    expect(flow.getState()).toBe("completed");
    expect(ctx.scheduled).toHaveLength(1);
  });

  test("rejecting pointer-write dep still finishes the flow", async () => {
    const transport = makeTransport();
    const ctx = makeDeps(SESSION, {
      async addPointerMessage() {
        throw new Error("origin conversation deleted");
      },
    });
    const flow = new CallSetupFlow("call_1", transport.transport, ctx.deps);

    const started = flow.start(INVITE_OUTCOME, RESOLVED);
    inviteOutcomes.push({
      outcome: "success",
      memberId: "member_1",
      type: "redeemed",
      inviteId: "invite_1",
    });
    pushDigits(flow, "123456");

    const result = await started;
    expect(result.kind).toBe("proceed-handoff-spoken");
    expect(flow.getState()).toBe("completed");
  });
});
