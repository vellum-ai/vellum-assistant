/**
 * Tests for `runBackgroundJob()`.
 *
 * Strategy: stub `bootstrapConversation`, `processMessage`, and
 * `emitNotificationSignal` via `mock.module()` and inspect the recorded
 * calls. We do NOT exercise the real conversation runtime here — the unit
 * under test is the wrapper's contract:
 *  - bootstrap is called once
 *  - processMessage is awaited (or raced against a timeout)
 *  - failure paths emit `activity.failed` (unless suppressed)
 *  - the result is always a structured value, never a thrown error
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../../daemon/trust-context.js";

// ── Module mocks ─────────────────────────────────────────────────────

let bootstrapCalls = 0;
let bootstrapLastArgs: Record<string, unknown> | null = null;
const STUB_CONVERSATION_ID = "conv-test-1";

mock.module("../../persistence/conversation-bootstrap.js", () => ({
  bootstrapConversation: (opts: Record<string, unknown>) => {
    bootstrapCalls += 1;
    bootstrapLastArgs = opts;
    return { id: STUB_CONVERSATION_ID };
  },
}));

const addMessageCalls: Array<{
  conversationId: string;
  role: string;
  content: string;
}> = [];

mock.module("../../persistence/conversation-crud.js", () => ({
  addMessage: async (conversationId: string, role: string, content: string) => {
    addMessageCalls.push({ conversationId, role, content });
    return { id: `msg-${addMessageCalls.length}` };
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

let processMessageImpl: (
  conversationId: string,
  content: string,
  options: Record<string, unknown> | undefined,
) => Promise<{
  messageId: string;
  turnFailure?: { failureCode?: string };
}> = async () => ({ messageId: "msg-1" });
const processMessageCalls: Array<{
  conversationId: string;
  content: string;
  options: Record<string, unknown> | undefined;
}> = [];

mock.module("../../daemon/process-message.js", () => ({
  processMessage: async (
    conversationId: string,
    content: string,
    options: Record<string, unknown> | undefined,
  ) => {
    processMessageCalls.push({ conversationId, content, options });
    return processMessageImpl(conversationId, content, options);
  },
}));

const emitCalls: Array<Record<string, unknown>> = [];
let emitImpl: (
  params: Record<string, unknown>,
) => Promise<unknown> = async () => ({
  signalId: "sig-1",
  deduplicated: false,
  dispatched: true,
  reason: "ok",
  deliveryResults: [],
});

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: Record<string, unknown>) => {
    emitCalls.push(params);
    return emitImpl(params);
  },
}));

// Stub the pre-first-message gate. Default OPEN — every pre-existing
// test assumes a fully-onboarded daemon. The dedicated "gate closed"
// test flips this to false.
let preFirstMessageGateOpen = true;
mock.module("../pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => preFirstMessageGateOpen,
}));

// Import after mocks are in place.
const { runBackgroundJob } = await import("../background-job-runner.js");
const { bufferIfDeferred, resetDeferredForTest } =
  await import("../../notifications/deferred-emit.js");

// ── Shared fixtures ──────────────────────────────────────────────────

const TRUST_CONTEXT: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    jobName: "test-job",
    source: "test-source",
    prompt: "do the test",
    trustContext: TRUST_CONTEXT,
    callSite: "heartbeatAgent" as const,
    timeoutMs: 5_000,
    origin: "heartbeat" as const,
    ...overrides,
  };
}

beforeEach(() => {
  bootstrapCalls = 0;
  bootstrapLastArgs = null;
  processMessageCalls.length = 0;
  emitCalls.length = 0;
  addMessageCalls.length = 0;
  resetDeferredForTest();
  preFirstMessageGateOpen = true;
  processMessageImpl = async () => ({ messageId: "msg-1" });
  emitImpl = async () => ({
    signalId: "sig-1",
    deduplicated: false,
    dispatched: true,
    reason: "ok",
    deliveryResults: [],
  });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("runBackgroundJob", () => {
  test("success path: returns ok=true and emits no notification", async () => {
    processMessageImpl = async () => ({ messageId: "msg-success" });

    const result = await runBackgroundJob(baseOpts());

    expect(result.ok).toBe(true);
    expect(result.conversationId).toBe(STUB_CONVERSATION_ID);
    expect(result.error).toBeUndefined();
    expect(result.errorKind).toBeUndefined();
    expect(bootstrapCalls).toBe(1);
    expect(bootstrapLastArgs).toMatchObject({
      conversationType: "background",
      source: "test-source",
      origin: "heartbeat",
      systemHint: "do the test",
      groupId: "system:background",
    });
    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      trustContext: TRUST_CONTEXT,
      callSite: "heartbeatAgent",
    });
    // No requestOrigin set on baseOpts → none threaded to processMessage, so no
    // origin-scoped permission grant can fire for an ordinary background job.
    expect(
      (processMessageCalls[0].options as { requestOrigin?: string })
        .requestOrigin,
    ).toBeUndefined();
    expect(emitCalls).toHaveLength(0);
  });

  test("threads requestOrigin into processMessage options when set", async () => {
    await runBackgroundJob(baseOpts({ requestOrigin: "memory_consolidation" }));

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      trustContext: TRUST_CONTEXT,
      callSite: "heartbeatAgent",
      requestOrigin: "memory_consolidation",
    });
  });

  test("generic exception: returns ok=false with errorKind=exception and emits activity.failed with dedupeKey", async () => {
    processMessageImpl = async () => {
      throw new Error("boom");
    };

    const result = await runBackgroundJob(baseOpts());

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("exception");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("boom");
    expect(result.conversationId).toBe(STUB_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    const emitted = emitCalls[0];
    expect(emitted.sourceEventName).toBe("activity.failed");
    expect(emitted.sourceChannel).toBe("assistant_tool");
    expect(emitted.sourceContextId).toBe(STUB_CONVERSATION_ID);
    expect(emitted.contextPayload).toMatchObject({
      jobName: "test-job",
      errorMessage: "boom",
      errorKind: "exception",
    });
    expect(emitted.attentionHints).toMatchObject({
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    });
    // Dedupe key collapses repeated failures of the same job per UTC day.
    expect(typeof emitted.dedupeKey).toBe("string");
    expect(emitted.dedupeKey as string).toMatch(
      /^activity-failed:test-job:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("non-throwing turn failure: returns ok=false with errorKind=model_provider and emits activity.failed", async () => {
    // A failed LLM call (e.g. an invalid provider) does NOT throw — the turn
    // persists a synthetic error message and processMessage resolves with a
    // `turnFailure`. The runner must surface this as a failure, not ok=true.
    processMessageImpl = async () => ({
      messageId: "msg-failed-turn",
      turnFailure: { failureCode: "provider_error" },
    });

    const result = await runBackgroundJob(baseOpts());

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("model_provider");
    expect(result.error?.message).toContain("provider_error");
    expect(result.conversationId).toBe(STUB_CONVERSATION_ID);

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].sourceEventName).toBe("activity.failed");
    expect(
      (emitCalls[0].contextPayload as { errorKind: string }).errorKind,
    ).toBe("model_provider");
  });

  test("non-throwing turn failure with deferNotifications drops buffered notifications", async () => {
    processMessageImpl = async () => ({
      messageId: "msg-failed-turn",
      turnFailure: { failureCode: "provider_error" },
    });

    const result = await runBackgroundJob(
      baseOpts({ deferNotifications: true }),
    );

    expect(result.ok).toBe(false);
    // Only the runner's failure signal emits — no committed "success" signal.
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].sourceEventName).toBe("activity.failed");
  });

  test("timeout: returns ok=false with errorKind=timeout and emits activity.failed", async () => {
    // Never resolve — force timeout to win the race.
    processMessageImpl = () => new Promise(() => {});

    const result = await runBackgroundJob(baseOpts({ timeoutMs: 50 }));

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("timeout");
    expect(result.error?.message).toContain("timed out after 50ms");
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].sourceEventName).toBe("activity.failed");
    expect(
      (emitCalls[0].contextPayload as { errorKind: string }).errorKind,
    ).toBe("timeout");
  });

  test("suppressFailureNotifications: failure returns ok=false but emits nothing", async () => {
    processMessageImpl = async () => {
      throw new Error("suppressed");
    };

    const result = await runBackgroundJob(
      baseOpts({ suppressFailureNotifications: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("exception");
    expect(result.error?.message).toBe("suppressed");
    expect(emitCalls).toHaveLength(0);
  });

  test("onConversationCreated fires synchronously after bootstrap, BEFORE processMessage", async () => {
    let processMessageStarted = false;
    let callbackFiredBeforeProcessMessage = false;

    processMessageImpl = async () => {
      processMessageStarted = true;
      // Delay completion so we can observe the ordering — even with the
      // delay, the callback should already have fired.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return { messageId: "msg-after" };
    };

    const seenConversationIds: string[] = [];
    const onConversationCreated = (conversationId: string) => {
      seenConversationIds.push(conversationId);
      callbackFiredBeforeProcessMessage = !processMessageStarted;
    };

    const result = await runBackgroundJob(baseOpts({ onConversationCreated }));

    expect(result.ok).toBe(true);
    expect(seenConversationIds).toEqual([STUB_CONVERSATION_ID]);
    expect(callbackFiredBeforeProcessMessage).toBe(true);
  });

  test("onConversationCreated callback throws are swallowed and the job still runs", async () => {
    const result = await runBackgroundJob(
      baseOpts({
        onConversationCreated: () => {
          throw new Error("callback boom");
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(processMessageCalls).toHaveLength(1);
  });

  test("conversationType=scheduled and scheduleJobId are propagated to bootstrapConversation", async () => {
    await runBackgroundJob(
      baseOpts({
        conversationType: "scheduled",
        scheduleJobId: "job-abc",
      }),
    );

    expect(bootstrapLastArgs).toMatchObject({
      conversationType: "scheduled",
      scheduleJobId: "job-abc",
    });
  });

  test("default conversationType is 'background' when not specified", async () => {
    await runBackgroundJob(baseOpts());
    expect(bootstrapLastArgs).toMatchObject({ conversationType: "background" });
    // No scheduleJobId by default.
    expect(bootstrapLastArgs).not.toHaveProperty("scheduleJobId");
  });

  test("assistantSandwich seeds three messages in user/assistant/user order, with sandwich written before processMessage runs", async () => {
    let addMessageCountAtProcessMessageStart = -1;
    processMessageImpl = async () => {
      addMessageCountAtProcessMessageStart = addMessageCalls.length;
      return { messageId: "msg-final" };
    };

    await runBackgroundJob(
      baseOpts({
        prompt: "",
        assistantSandwich: {
          preamble: "TRUSTED_PRE",
          content: "UNTRUSTED_PAYLOAD",
          postamble: "TRUSTED_POST",
        },
      }),
    );

    // All three sandwich addMessage calls happened.
    expect(addMessageCalls).toHaveLength(3);
    expect(addMessageCalls[0]).toMatchObject({
      conversationId: STUB_CONVERSATION_ID,
      role: "user",
      content: "TRUSTED_PRE",
    });
    expect(addMessageCalls[1]).toMatchObject({
      conversationId: STUB_CONVERSATION_ID,
      role: "assistant",
      content: "UNTRUSTED_PAYLOAD",
    });
    expect(addMessageCalls[2]).toMatchObject({
      conversationId: STUB_CONVERSATION_ID,
      role: "user",
      content: "TRUSTED_POST",
    });
    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toBe("");
    // processMessage observed all 3 sandwich messages already in place.
    expect(addMessageCountAtProcessMessageStart).toBe(3);
  });

  describe("pre-first-message gate", () => {
    test("gate closed: no bootstrap, no processMessage, no notification — result reports skipReason", async () => {
      preFirstMessageGateOpen = false;

      const result = await runBackgroundJob(baseOpts());

      expect(result.ok).toBe(true);
      expect(result.skipReason).toBe("pre_first_user_message");
      expect(result.conversationId).toBe("");
      expect(bootstrapCalls).toBe(0);
      expect(processMessageCalls).toHaveLength(0);
      expect(emitCalls).toHaveLength(0);
    });

    test("gate closed but allowPreFirstUserMessage=true: runs normally", async () => {
      preFirstMessageGateOpen = false;

      const result = await runBackgroundJob(
        baseOpts({ allowPreFirstUserMessage: true }),
      );

      expect(result.ok).toBe(true);
      expect(result.skipReason).toBeUndefined();
      expect(bootstrapCalls).toBe(1);
      expect(processMessageCalls).toHaveLength(1);
    });
  });

  describe("deferNotifications", () => {
    function buildSkillNotificationParams(message: string) {
      return {
        sourceEventName: "assistant.share",
        sourceChannel: "assistant_tool" as const,
        sourceContextId: "skill-ctx",
        contextPayload: { requestedMessage: message },
        attentionHints: {
          requiresAction: false,
          urgency: "low" as const,
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      };
    }

    test("success path commits buffered in-band notifications", async () => {
      processMessageImpl = async () => {
        // Stand in for the IPC route's bufferIfDeferred call when the model
        // invokes `notifications send` mid-turn.
        const buffered = bufferIfDeferred(
          STUB_CONVERSATION_ID,
          buildSkillNotificationParams("all green"),
        );
        expect(buffered).not.toBeNull();
        expect(buffered!.dispatched).toBe(false);
        return { messageId: "msg-success" };
      };

      const result = await runBackgroundJob(
        baseOpts({ deferNotifications: true }),
      );

      expect(result.ok).toBe(true);
      // Commit flushed the buffered notification through emitNotificationSignal.
      const successEmits = emitCalls.filter(
        (e) => e.sourceEventName !== "activity.failed",
      );
      expect(successEmits).toHaveLength(1);
      expect(successEmits[0].sourceEventName).toBe("assistant.share");
    });

    // Regression for the PR #31216 Codex P1 finding: a heartbeat that calls
    // the notifications skill and then times out must not leave a "success"
    // notification standing alongside the runner's `activity.failed` emit.
    test("timeout drops buffered in-band notifications; only activity.failed emits", async () => {
      processMessageImpl = () => {
        bufferIfDeferred(
          STUB_CONVERSATION_ID,
          buildSkillNotificationParams("premature success"),
        );
        return new Promise(() => {});
      };

      const result = await runBackgroundJob(
        baseOpts({ deferNotifications: true, timeoutMs: 30 }),
      );

      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("timeout");
      // Only the runner's failure signal makes it out — the buffered
      // "success" notification is discarded.
      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].sourceEventName).toBe("activity.failed");
    });

    test("thrown exception also drops buffered notifications", async () => {
      processMessageImpl = async () => {
        bufferIfDeferred(
          STUB_CONVERSATION_ID,
          buildSkillNotificationParams("doomed"),
        );
        throw new Error("kaboom");
      };

      const result = await runBackgroundJob(
        baseOpts({ deferNotifications: true }),
      );

      expect(result.ok).toBe(false);
      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].sourceEventName).toBe("activity.failed");
    });

    // Regression: after timeout, `processMessage` keeps running and may
    // emit a late skill call. The tombstone must swallow it instead of
    // letting it bypass the buffer and reach the dispatch pipeline.
    test("late skill call after timeout is swallowed by the tombstone", async () => {
      processMessageImpl = () => new Promise(() => {});

      const result = await runBackgroundJob(
        baseOpts({ deferNotifications: true, timeoutMs: 20 }),
      );
      expect(result.ok).toBe(false);

      const late = bufferIfDeferred(
        STUB_CONVERSATION_ID,
        buildSkillNotificationParams("post-timeout"),
      );
      expect(late).not.toBeNull();
      expect(late!.dispatched).toBe(false);
      expect(late!.reason).toMatch(/did not complete/);

      // Only the runner's failure signal made it out.
      expect(emitCalls).toHaveLength(1);
      expect(emitCalls[0].sourceEventName).toBe("activity.failed");
    });

    test("without deferNotifications, bufferIfDeferred is a no-op", async () => {
      processMessageImpl = async () => {
        const buffered = bufferIfDeferred(
          STUB_CONVERSATION_ID,
          buildSkillNotificationParams("immediate"),
        );
        // Buffer was never armed, so the call returns null and the IPC
        // handler would emit directly.
        expect(buffered).toBeNull();
        return { messageId: "msg-success" };
      };

      const result = await runBackgroundJob(baseOpts());
      expect(result.ok).toBe(true);
    });
  });
});
