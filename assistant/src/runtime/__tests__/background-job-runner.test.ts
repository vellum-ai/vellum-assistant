/**
 * Tests for `runBackgroundJob()`.
 *
 * Strategy: stub `bootstrapConversation`, `processMessage`, the run store,
 * and the System health recorder via `mock.module()` and inspect the recorded
 * calls. We do NOT exercise the real conversation runtime here — the unit
 * under test is the wrapper's contract:
 *  - bootstrap is called once
 *  - processMessage is awaited (or raced against a timeout)
 *  - failure paths increment the job's System health counter (unless
 *    suppressed) and fail the job's run
 *  - the result is always a structured value, never a thrown error
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustContext } from "../../daemon/trust-context-types.js";

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

mock.module("../../home/system-health.js", () => ({
  recordSubsystemFailure: async (failure: Record<string, unknown>) => {
    emitCalls.push(failure);
  },
  recordSubsystemSuccess: async () => {},
}));

/** Terminal transitions the job's run reached, in order. */
const runTransitions: Array<{ kind: string; payload?: unknown }> = [];
let lastRunOptions: Record<string, unknown> | null = null;

mock.module("../../runs/run-store.js", () => ({
  startRun: (options: Record<string, unknown>) => {
    lastRunOptions = options;
    return {
      runId: "run-stub",
      progress: () => {},
      needsInput: async () => {},
      succeed: async (payload: unknown) => {
        runTransitions.push({ kind: "succeed", payload });
      },
      fail: async (payload: unknown) => {
        runTransitions.push({ kind: "fail", payload });
      },
      cancel: async () => {
        runTransitions.push({ kind: "cancel" });
      },
    };
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
  runTransitions.length = 0;
  lastRunOptions = null;
  addMessageCalls.length = 0;
  preFirstMessageGateOpen = true;
  processMessageImpl = async () => ({ messageId: "msg-1" });
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

  test("a routine job's run is silent, so its failures never reach the bell", async () => {
    await runBackgroundJob(baseOpts());

    // Silent by default: routine infrastructure whose outcome the user did
    // not ask about stays in Activity, and its failures roll into the System
    // health counter instead of notifying.
    expect(lastRunOptions).toMatchObject({
      kind: "test-job",
      silent: true,
      collapseKey: "background-job:test-job",
    });
    expect(runTransitions).toEqual([
      { kind: "succeed", payload: { notable: false, conversationId: STUB_CONVERSATION_ID } },
    ]);
  });

  test("a job the user asked for opts its run into notifying", async () => {
    await runBackgroundJob(
      baseOpts({
        run: { kind: "scheduled_run", label: "Morning digest", notifies: true },
      }),
    );

    expect(lastRunOptions).toMatchObject({
      kind: "scheduled_run",
      label: "Morning digest",
      silent: false,
    });
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

  test("threads allowedTools + toolGateMode into processMessage options when set", async () => {
    await runBackgroundJob(
      baseOpts({
        allowedTools: ["file_read", "bash"],
        toolGateMode: "wire",
      }),
    );

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      allowedTools: ["file_read", "bash"],
      toolGateMode: "wire",
    });
  });

  test("omits allowedTools/toolGateMode from processMessage options when unset (ordinary jobs unchanged)", async () => {
    await runBackgroundJob(baseOpts());

    expect(processMessageCalls).toHaveLength(1);
    const opts = processMessageCalls[0].options as {
      allowedTools?: unknown;
      toolGateMode?: unknown;
    };
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.toolGateMode).toBeUndefined();
  });

  test("threads skipPromptIndexing as skipUserMessageIndexing when set", async () => {
    await runBackgroundJob(baseOpts({ skipPromptIndexing: true }));

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      skipUserMessageIndexing: true,
    });
  });

  test("omits skipUserMessageIndexing when skipPromptIndexing is unset (prompts index by default)", async () => {
    await runBackgroundJob(baseOpts());

    expect(processMessageCalls).toHaveLength(1);
    const opts = processMessageCalls[0].options as {
      skipUserMessageIndexing?: unknown;
    };
    expect(opts.skipUserMessageIndexing).toBeUndefined();
  });

  test("generic exception: returns ok=false with errorKind=exception and counts against System health", async () => {
    processMessageImpl = async () => {
      throw new Error("boom");
    };

    const result = await runBackgroundJob(baseOpts());

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("exception");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("boom");
    expect(result.conversationId).toBe(STUB_CONVERSATION_ID);

    // One durable counter row per failing job, keyed by job name, rather
    // than one notification per failure.
    expect(emitCalls).toHaveLength(1);
    const recorded = emitCalls[0];
    expect(recorded.subsystem).toBe("test-job");
    expect(recorded.conversationId).toBe(STUB_CONVERSATION_ID);
    // Prose, not a log line: the classified kind carries the actionable part.
    expect(recorded.errorSummary).toContain("boom");
    expect(recorded.errorSummary).not.toContain("exception:");

    // The job's run fails too, so a long job that died is not left spinning.
    expect(runTransitions).toEqual([
      { kind: "fail", payload: { reason: recorded.errorSummary, retryable: false } },
    ]);
  });

  test("non-throwing turn failure: returns ok=false with errorKind=model_provider and counts against System health", async () => {
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
    // The stable classified code rides the result so callers can branch on
    // the failure class without parsing the error message.
    expect(result.failureCode).toBe("provider_error");

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].subsystem).toBe("test-job");
    expect(emitCalls[0].errorSummary).toContain(
      "The model provider did not answer.",
    );
  });

  test("timeout: returns ok=false with errorKind=timeout and counts against System health", async () => {
    // Never resolve — force timeout to win the race.
    processMessageImpl = () => new Promise(() => {});

    const result = await runBackgroundJob(baseOpts({ timeoutMs: 50 }));

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("timeout");
    expect(result.error?.message).toContain("timed out after 50ms");
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].errorSummary).toContain(
      "It ran out of time before finishing.",
    );
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
});
