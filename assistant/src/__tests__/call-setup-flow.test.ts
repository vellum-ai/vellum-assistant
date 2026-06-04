import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock (must come before any source imports) ────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── toTrustContext stub ──────────────────────────────────────────────
// Avoids pulling config/canonicalization into the unit test; the flow only
// forwards the resulting TrustContext, so a deterministic stub is enough.

mock.module("../runtime/actor-trust-resolver.js", () => ({
  toTrustContext: (ctx: { trustClass: string }, externalId: string) => ({
    sourceChannel: "phone",
    trustClass: ctx.trustClass,
    requesterExternalUserId: externalId,
  }),
}));

import {
  CallSetupFlow,
  type CallSetupFlowDeps,
  UnsupportedSetupFlowError,
} from "../calls/call-setup-flow.js";
import type {
  SetupFlowResult,
  SetupFlowTransport,
} from "../calls/call-setup-flow-types.js";
import { MediaStreamOutput } from "../calls/media-stream-output.js";
import type {
  SetupOutcome,
  SetupResolved,
} from "../calls/relay-setup-router.js";
import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";

// ── Test doubles ─────────────────────────────────────────────────────

function makeTransport() {
  const calls = {
    spoken: [] as Array<{ token: string; last: boolean }>,
    ended: [] as Array<string | undefined>,
  };
  const transport: SetupFlowTransport = {
    sendTextToken(token, last) {
      calls.spoken.push({ token, last });
    },
    endSession(reason) {
      calls.ended.push(reason);
    },
    getConnectionState() {
      return "connected";
    },
  };
  return { transport, calls };
}

function makeDeps() {
  const completed: SetupFlowResult[] = [];
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const spoken: Array<{ text: string }> = [];
  // Captured scheduled teardowns; tests fire them manually to assert the
  // deny hangup is deferred rather than synchronous. No real timers run.
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const deps: CallSetupFlowDeps = {
    async speakSystemPrompt(_transport, text) {
      spoken.push({ text });
    },
    recordCallEvent(_id, eventType, payload) {
      events.push({ type: eventType, payload });
    },
    onComplete(result) {
      completed.push(result);
    },
    hangupDelayMs: 1234,
    schedule(fn, delayMs) {
      scheduled.push({ fn, delayMs });
    },
  };
  return { deps, completed, events, spoken, scheduled };
}

const RESOLVED: SetupResolved = {
  assistantId: "asst_test",
  isInbound: true,
  otherPartyNumber: "+15550100",
  actorTrust: { trustClass: "guardian" } as unknown as ActorTrustContext,
};

describe("CallSetupFlow", () => {
  let transport: ReturnType<typeof makeTransport>;
  let depsCtx: ReturnType<typeof makeDeps>;
  let flow: CallSetupFlow;

  beforeEach(() => {
    transport = makeTransport();
    depsCtx = makeDeps();
    flow = new CallSetupFlow("call_1", transport.transport, depsCtx.deps);
  });

  test("starts in idle state", () => {
    expect(flow.getState()).toBe("idle");
  });

  test("normal_call resolves to proceed-initial-greeting", async () => {
    const outcome: SetupOutcome = { action: "normal_call", isInbound: true };

    const result = await flow.start(outcome, RESOLVED);

    expect(result).toEqual({
      kind: "proceed-initial-greeting",
      assistantId: "asst_test",
      trustContext: {
        sourceChannel: "phone",
        trustClass: "guardian",
        requesterExternalUserId: "+15550100",
      },
    });
    expect(depsCtx.completed).toEqual([result]);
    expect(flow.getState()).toBe("completed");
    // Normal call does not speak or end the session here — the controller
    // takes over with startInitialGreeting().
    expect(transport.calls.spoken).toHaveLength(0);
    expect(transport.calls.ended).toHaveLength(0);
  });

  test("deny speaks the message and resolves to ended without ending the session synchronously", async () => {
    const outcome: SetupOutcome = {
      action: "deny",
      message: "This number is not authorized.",
      logReason: "Inbound voice ACL: member policy deny",
    };

    const result = await flow.start(outcome, RESOLVED);

    expect(result).toEqual({
      kind: "ended",
      reason: "Inbound voice ACL: member policy deny",
    });
    expect(depsCtx.spoken).toEqual([
      { text: "This number is not authorized." },
    ]);
    // The transport teardown must NOT fire synchronously — endSession()
    // flushes queued TTS playback, so the denial audio needs time to play.
    expect(transport.calls.ended).toHaveLength(0);
    // Instead the teardown is scheduled with the (injected) playback delay.
    expect(depsCtx.scheduled).toHaveLength(1);
    expect(depsCtx.scheduled[0]!.delayMs).toBe(1234);
    // The session is still reported ended right away.
    expect(depsCtx.completed).toEqual([result]);
    expect(flow.getState()).toBe("completed");
    expect(depsCtx.events).toEqual([
      {
        type: "inbound_acl_denied",
        payload: { logReason: "Inbound voice ACL: member policy deny" },
      },
    ]);

    // Once the scheduled delay elapses, the session is torn down.
    depsCtx.scheduled[0]!.fn();
    expect(transport.calls.ended).toEqual([
      "Inbound voice ACL: member policy deny",
    ]);
  });

  test("unknown actions throw UnsupportedSetupFlowError", async () => {
    // Every router-emitted action is now implemented; only a synthetic,
    // off-contract action should hit the loud fallback.
    const outcome = {
      action: "totally_unknown_action",
    } as unknown as SetupOutcome;

    await expect(flow.start(outcome, RESOLVED)).rejects.toBeInstanceOf(
      UnsupportedSetupFlowError,
    );
    expect(depsCtx.completed).toHaveLength(0);
  });

  test("pushDtmfDigit / pushTranscriptFinal are no-ops before a sub-flow is active", () => {
    expect(() => flow.pushDtmfDigit("4")).not.toThrow();
    expect(() => flow.pushTranscriptFinal("hello")).not.toThrow();
    expect(flow.getState()).toBe("idle");
  });

  describe("SetupFlowResult variants", () => {
    test("encodes all four continuation kinds", () => {
      const variants: SetupFlowResult[] = [
        {
          kind: "proceed-initial-greeting",
          assistantId: "a",
          trustContext: { sourceChannel: "phone", trustClass: "guardian" },
        },
        {
          kind: "proceed-post-verification-greeting",
          assistantId: "a",
          trustContext: { sourceChannel: "phone", trustClass: "guardian" },
        },
        {
          kind: "proceed-handoff-spoken",
          assistantId: "a",
          trustContext: { sourceChannel: "phone", trustClass: "guardian" },
        },
        { kind: "ended", reason: "denied" },
      ];

      expect(variants.map((v) => v.kind)).toEqual([
        "proceed-initial-greeting",
        "proceed-post-verification-greeting",
        "proceed-handoff-spoken",
        "ended",
      ]);
    });
  });

  test("MediaStreamOutput is assignable to SetupFlowTransport", () => {
    // Type-level assertion: MediaStreamOutput satisfies the structural
    // SetupFlowTransport subset. A failure here is a compile error.
    const assertAssignable = (_t: SetupFlowTransport): void => {};
    const _check = (output: MediaStreamOutput): void => {
      assertAssignable(output);
    };
    expect(typeof _check).toBe("function");
  });
});
