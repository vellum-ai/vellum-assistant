/**
 * Tests for the two-conversation runner. Uses the same `mock.module
 * ("../create-agent", …)` + `nextAgent` test seam as `run-once.test.ts`
 * so we can hand `runIngestAsk` arbitrary `BaseAgent` stubs without
 * standing up a real vellum/hermes container. Each test sets
 * `nextAgent` to a `FakeAgent` configured for that scenario; the
 * `afterEach` clears it so a forgotten setup throws clearly instead
 * of leaking state into the next case.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
  ConfirmationDecision,
  WorkspaceFileWrite,
} from "../../adapter";
import type { TestSetupCommand } from "../../setup-command";
import type { Profile } from "../../profile";

let nextAgent: BaseAgent | null = null;
mock.module("../create-agent", () => ({
  createAgent: (input: AgentHatchInput): BaseAgent => {
    if (!nextAgent) {
      throw new Error(
        `test forgot to set nextAgent before runIngestAsk reached createAgent (runId=${input.runId})`,
      );
    }
    return nextAgent;
  },
}));

// Import-under-test goes AFTER `mock.module` so the runner's import-time
// reference to `createAgent` resolves to the stub above.
import { IngestAskError, runIngestAsk } from "../run-ingest-ask";

function profileFor(id: string): Profile {
  return {
    id,
    manifest: { species: "vellum" },
    workspaceDir: `/tmp/${id}/workspace`,
  };
}

function textEvent(text: string): AgentEvent {
  return { message: { type: "assistant_text_delta", text } };
}

/**
 * The completion sentinel the ingest turn waits for. The runner only
 * treats an ingest turn as finished once this standalone line appears, so
 * every happy-path ingest queue must end with it.
 */
function readyEvent(): AgentEvent {
  return textEvent("\nReady.");
}

/**
 * A pending tool-confirmation event, the kind a hatched assistant emits
 * when it reaches for a tool above the auto-approve risk threshold. In a
 * headless run nothing answers it unless the runner auto-confirms.
 */
function confirmationRequestEvent(requestId: string): AgentEvent {
  return { message: { type: "confirmation_request", requestId } };
}

interface FakeAgentOptions {
  /**
   * Events to yield per turn. Index 0 = after the ingest send, index
   * 1 = after the question send. Defaults to one assistant_text_delta
   * each so the happy path produces a non-empty hypothesis.
   */
  responses?: AgentEvent[][];
  /** When set, `writeWorkspaceFile()` throws with the given message. */
  writeFailure?: string;
  /** Omit `writeWorkspaceFile` entirely (capability missing). */
  omitWriteWorkspaceFile?: boolean;
  /** Omit `newConversation` entirely (capability missing). */
  omitNewConversation?: boolean;
  /** When true, `newConversation()` does NOT rotate `conversationKey`. */
  newConversationNoOp?: boolean;
  /** Omit `confirm` entirely (capability missing). */
  omitConfirm?: boolean;
  /** When set, `confirm()` throws with the given message. */
  confirmFailure?: string;
  /**
   * Artificial delay (ms) before each ingest-turn (index 0) event *after
   * the first* is yielded, simulating the long between-step silences of a
   * heavy agentic turn. The first event arrives promptly (the turn always
   * starts emitting); the gap that bites is mid-turn. Used to exercise the
   * ingest drain's quiet window.
   */
  ingestEventDelayMs?: number;
  /**
   * Usage records the egress jail's `readUsageRecords()` returns — the
   * assistant's observed model traffic. Omit to leave the capability
   * unimplemented (the runner then surfaces an empty `recordedUsage`).
   */
  usageRecords?: Array<Record<string, unknown>>;
  /**
   * When true, `readUsageRecords()` records the shutdown count at call time
   * so a test can assert it ran *before* the agent was retired.
   */
  trackUsageReadOrder?: boolean;
}

interface FakeAgentHarness {
  agent: BaseAgent;
  hatched: () => boolean;
  shutdownCount: () => number;
  writes: () => WorkspaceFileWrite[];
  sends: () => string[];
  confirms: () => ConfirmationDecision[];
  /**
   * Shutdown count observed at the moment `readUsageRecords()` was called,
   * or `undefined` if it was never called. `0` proves the usage read
   * happened before the agent was retired.
   */
  shutdownCountAtUsageRead: () => number | undefined;
}

/**
 * Build a fully-controllable `BaseAgent` stub. The events iterator
 * yields the queued events for the current turn one at a time across
 * `next()` calls, matching the real adapter contract where the
 * collector drives the stream. `newConversation()` advances the turn
 * pointer so the post-rotation `events()` subscription sees the next
 * queue (never the closed conversation's tail).
 */
function makeFakeAgent(opts: FakeAgentOptions = {}): FakeAgentHarness {
  let hatched = false;
  let shutdowns = 0;
  let shutdownCountAtUsageRead: number | undefined;
  const writes: WorkspaceFileWrite[] = [];
  const sends: string[] = [];
  const confirms: ConfirmationDecision[] = [];
  const queues: AgentEvent[][] = (
    opts.responses ?? [
      [textEvent("ack"), readyEvent()],
      [textEvent("hypothesis")],
    ]
  ).map((q) => q.slice());
  let turn = 0;
  let conversationKey = "convo-1";

  const eventsFn = (): AsyncIterable<AgentEvent> => {
    const queue = queues[turn];
    const delayMs = turn === 0 ? (opts.ingestEventDelayMs ?? 0) : 0;
    let yielded = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (!queue || queue.length === 0) {
              return { value: undefined, done: true };
            }
            if (delayMs > 0 && yielded > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            const value = queue.shift()!;
            yielded += 1;
            return { value, done: false };
          },
        };
      },
    };
  };

  const agent: BaseAgent = {
    id: "fake-agent",
    get conversationKey() {
      return conversationKey;
    },
    async hatch(): Promise<void> {
      hatched = true;
    },
    async send(message: AgentMessage): Promise<void> {
      sends.push(message.content);
    },
    async runSetupCommand(_command: TestSetupCommand): Promise<void> {
      throw new Error("unreachable: runIngestAsk does not run setup commands");
    },
    events: eventsFn,
    // Not exercised: runIngestAsk drives collection with its own quiet/
    // sentinel windows, not the turn-completion signal.
    isTurnComplete(): boolean {
      return false;
    },
    async shutdown(): Promise<void> {
      shutdowns += 1;
    },
  };

  if (!opts.omitWriteWorkspaceFile) {
    agent.writeWorkspaceFile = async (input) => {
      if (opts.writeFailure) {
        throw new Error(opts.writeFailure);
      }
      writes.push(input);
    };
  }
  if (!opts.omitNewConversation) {
    agent.newConversation = async () => {
      turn += 1;
      if (!opts.newConversationNoOp) {
        conversationKey = `convo-${turn + 1}`;
      }
    };
  }
  if (!opts.omitConfirm) {
    agent.confirm = async (input) => {
      if (opts.confirmFailure) {
        throw new Error(opts.confirmFailure);
      }
      confirms.push(input);
    };
  }
  if (opts.usageRecords) {
    agent.readUsageRecords = async () => {
      if (opts.trackUsageReadOrder) {
        shutdownCountAtUsageRead = shutdowns;
      }
      return opts.usageRecords!.map((record) => ({ ...record }));
    };
  }

  return {
    agent,
    hatched: () => hatched,
    shutdownCount: () => shutdowns,
    writes: () => writes.slice(),
    sends: () => sends.slice(),
    confirms: () => confirms.slice(),
    shutdownCountAtUsageRead: () => shutdownCountAtUsageRead,
  };
}

describe("runIngestAsk — happy path", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("hatches, stages inputs, sends both messages, rotates conversation, returns hypothesis", async () => {
    const harness = makeFakeAgent({
      responses: [
        [textEvent("ingested-ack"), readyEvent()],
        [textEvent("March 14"), textEvent(", 2025")],
      ],
    });
    nextAgent = harness.agent;

    const result = await runIngestAsk({
      profile: profileFor("p-fake"),
      runId: "r-1",
      inputs: [
        { path: "inputs/longmemeval/q1/haystack.jsonl", content: "{}\n" },
      ],
      ingestMessage:
        "Read and ingest the trajectories at inputs/longmemeval/q1/haystack.jsonl.",
      questionMessage: "When did the meeting happen?",
      quietMs: 25,
    });

    expect(harness.hatched()).toBe(true);
    expect(harness.writes()).toEqual([
      { path: "inputs/longmemeval/q1/haystack.jsonl", content: "{}\n" },
    ]);
    expect(harness.sends()).toEqual([
      "Read and ingest the trajectories at inputs/longmemeval/q1/haystack.jsonl.",
      "When did the meeting happen?",
    ]);
    expect(result.profileId).toBe("p-fake");
    expect(result.runId).toBe("r-1");
    expect(result.ingestConversationKey).not.toBe(
      result.questionConversationKey,
    );
    expect(result.hypothesis).toBe("March 14, 2025");
    expect(result.questionAnswered).toBe(true);
    expect(result.ingestEvents.length).toBe(2);
    expect(result.questionEvents.length).toBe(2);
    expect(result.ingestSentinelSeen).toBe(true);
    expect(harness.shutdownCount()).toBe(1);
    // An adapter without the egress-jail capability surfaces no usage.
    expect(result.recordedUsage).toEqual([]);
  });

  test("surfaces the egress jail's usage records, read before the agent is retired", async () => {
    // GIVEN an agent whose egress jail observed two model calls
    const records = [
      {
        provider: "anthropic",
        model: "claude",
        input_tokens: 100,
        output_tokens: 20,
      },
      {
        provider: "anthropic",
        model: "claude",
        input_tokens: 5,
        output_tokens: 300,
      },
    ];
    const harness = makeFakeAgent({
      responses: [[textEvent("ack"), readyEvent()], [textEvent("answer")]],
      usageRecords: records,
      trackUsageReadOrder: true,
    });
    nextAgent = harness.agent;

    // WHEN the two-conversation run completes
    const result = await runIngestAsk({
      profile: profileFor("p-fake"),
      runId: "r-usage",
      inputs: [],
      ingestMessage: "ingest",
      questionMessage: "question",
      quietMs: 25,
    });

    // THEN the recorded usage is surfaced verbatim for the caller to price
    expect(result.recordedUsage).toEqual(records);
    // AND it was read while the agent (and its sidecar) was still alive
    expect(harness.shutdownCountAtUsageRead()).toBe(0);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("supports zero inputs (caller relies on persistent state alone)", async () => {
    const harness = makeFakeAgent({
      responses: [[textEvent("ok"), readyEvent()], [textEvent("answer")]],
    });
    nextAgent = harness.agent;

    const result = await runIngestAsk({
      profile: profileFor("p-empty"),
      runId: "r-empty",
      inputs: [],
      ingestMessage: "consolidate what you remember",
      questionMessage: "what did the user say?",
      quietMs: 25,
    });

    expect(harness.writes()).toEqual([]);
    expect(harness.sends()).toEqual([
      "consolidate what you remember",
      "what did the user say?",
    ]);
    expect(result.hypothesis).toBe("answer");
  });
});

describe("runIngestAsk — confirmation auto-approval", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("auto-approves confirmation_request events raised during ingest", async () => {
    // GIVEN an ingest turn whose stream carries a pending tool confirmation
    // before the agent finishes and emits the sentinel
    const harness = makeFakeAgent({
      responses: [
        [
          textEvent("reading trajectories"),
          confirmationRequestEvent("req-42"),
          textEvent(" committed to memory"),
          readyEvent(),
        ],
        [textEvent("answer")],
      ],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives the ingest turn
    const result = await runIngestAsk({
      profile: profileFor("p-confirm"),
      runId: "r-confirm",
      inputs: [],
      ingestMessage: "ingest everything",
      questionMessage: "recall it",
      quietMs: 25,
    });

    // THEN the pending confirmation was approved so the turn could complete
    expect(harness.confirms()).toEqual([
      { requestId: "req-42", decision: "allow" },
    ]);
    // AND the ingest reached its completion sentinel and the run produced a
    // hypothesis rather than stalling on the unresolved confirmation
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("answer");
  });

  test("does not stall when the adapter cannot confirm", async () => {
    // GIVEN an adapter that lacks the optional confirm() capability but whose
    // ingest still completes (e.g. a species that never gates on confirmation)
    const harness = makeFakeAgent({
      omitConfirm: true,
      responses: [[textEvent("done"), readyEvent()], [textEvent("answer")]],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives the ingest turn
    const result = await runIngestAsk({
      profile: profileFor("p-no-confirm"),
      runId: "r-no-confirm",
      inputs: [],
      ingestMessage: "ingest everything",
      questionMessage: "recall it",
      quietMs: 25,
    });

    // THEN the run completes normally without requiring confirm()
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("answer");
  });

  test("a failed confirmation is not fatal; the sentinel still governs completion", async () => {
    // GIVEN an adapter whose confirm() throws, with a confirmation raised
    // mid-ingest that the agent recovers from to reach the sentinel
    const harness = makeFakeAgent({
      confirmFailure: "gateway unreachable",
      responses: [
        [
          textEvent("working"),
          confirmationRequestEvent("req-7"),
          textEvent(" recovered"),
          readyEvent(),
        ],
        [textEvent("answer")],
      ],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives the ingest turn and the approval call fails
    const result = await runIngestAsk({
      profile: profileFor("p-confirm-fail"),
      runId: "r-confirm-fail",
      inputs: [],
      ingestMessage: "ingest everything",
      questionMessage: "recall it",
      quietMs: 25,
    });

    // THEN the failed approval does not abort the drain; the sentinel is what
    // decides the turn completed
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("answer");
  });

  test("auto-approves confirmation_request events raised during the question turn", async () => {
    // GIVEN an ingest turn that completes on the sentinel
    // AND a question turn that gates on a pending tool confirmation before
    // the agent produces its answer (e.g. on-demand retrieval reaches for a
    // tool above the auto-approve risk threshold)
    const harness = makeFakeAgent({
      responses: [
        [textEvent("noted"), readyEvent()],
        [
          textEvent("looking it up"),
          confirmationRequestEvent("req-q1"),
          textEvent(" the answer is blue"),
        ],
      ],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives both turns
    const result = await runIngestAsk({
      profile: profileFor("p-confirm-question"),
      runId: "r-confirm-question",
      inputs: [],
      ingestMessage: "ingest everything",
      questionMessage: "recall it",
      quietMs: 25,
    });

    // THEN the question turn's pending confirmation was approved so the agent
    // could finish answering rather than stalling on the unresolved gate
    expect(harness.confirms()).toEqual([
      { requestId: "req-q1", decision: "allow" },
    ]);
    expect(result.hypothesis).toBe("looking it up the answer is blue");
  });
});

describe("runIngestAsk — ingest quiet window", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("does not abandon the ingest turn during a gap longer than the question quiet window", async () => {
    // GIVEN an ingest turn whose events arrive with gaps longer than the
    // (tight) question quiet window but shorter than the (generous) ingest
    // quiet window — the heavy-turn case where the model sits silent between
    // steps without being done
    const harness = makeFakeAgent({
      ingestEventDelayMs: 60,
      responses: [[textEvent("thinking"), readyEvent()], [textEvent("answer")]],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives the turns with a 20ms question window and a
    // 200ms ingest window
    const result = await runIngestAsk({
      profile: profileFor("p-ingest-quiet"),
      runId: "r-ingest-quiet",
      inputs: [],
      ingestMessage: "ingest everything",
      questionMessage: "recall it",
      quietMs: 20,
      ingestQuietMs: 200,
    });

    // THEN the ingest turn survives the 60ms inter-event gaps and reaches its
    // sentinel rather than being cut off at the 20ms question window
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("answer");
  });

  test("fails loudly when an ingest gap exceeds even the ingest quiet window", async () => {
    // GIVEN an ingest turn whose inter-event gap exceeds the ingest quiet
    // window itself — a genuinely stalled turn
    const harness = makeFakeAgent({
      ingestEventDelayMs: 120,
      responses: [[textEvent("thinking"), readyEvent()], [textEvent("answer")]],
    });
    nextAgent = harness.agent;

    // WHEN the runner drives the ingest turn with a 40ms ingest window
    // THEN the drain goes quiet before the sentinel arrives and the run fails
    // loudly rather than grading a truncated ingest
    await expect(
      runIngestAsk({
        profile: profileFor("p-ingest-stall"),
        runId: "r-ingest-stall",
        inputs: [],
        ingestMessage: "ingest everything",
        questionMessage: "recall it",
        quietMs: 20,
        ingestQuietMs: 40,
        ingestMaxMs: 5_000,
      }),
    ).rejects.toThrow(/never emitted the completion sentinel/);
  });
});

describe("runIngestAsk — capability checks", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("throws clearly when adapter omits writeWorkspaceFile", async () => {
    const harness = makeFakeAgent({ omitWriteWorkspaceFile: true });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-bare"),
        runId: "r-2",
        inputs: [{ path: "x.txt", content: "hi" }],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/writeWorkspaceFile/);
    // Hatch still ran (capability checks happen post-hatch on purpose
    // so infra failures aren't masked), and shutdown is always called
    // via finally.
    expect(harness.hatched()).toBe(true);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("throws clearly when adapter omits newConversation", async () => {
    const harness = makeFakeAgent({ omitNewConversation: true });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-bare"),
        runId: "r-3",
        inputs: [],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/newConversation/);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("throws when newConversation does not rotate the conversation key", async () => {
    const harness = makeFakeAgent({ newConversationNoOp: true });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-bug"),
        runId: "r-4",
        inputs: [],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/did not rotate the conversation key/);
    expect(harness.shutdownCount()).toBe(1);
  });
});

describe("runIngestAsk — event-stream failures", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("throws when the ingest turn produces zero events", async () => {
    const harness = makeFakeAgent({
      responses: [[], [textEvent("unreachable")]],
    });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-quiet"),
        runId: "r-5",
        inputs: [],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/Ingest turn produced no events/);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("throws when the question turn produces zero events", async () => {
    const harness = makeFakeAgent({
      responses: [[textEvent("ack"), readyEvent()], []],
    });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-quiet"),
        runId: "r-6",
        inputs: [],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/Question turn produced no events/);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("returns an unanswered result (not an error) when the question turn emits only non-text events", async () => {
    // GIVEN an ingest turn that completes on the sentinel
    // AND a question turn that produces events but no gradable text
    // (e.g. conversation B did on-demand retrieval / extended thinking but
    // never composed an answer before its time budget elapsed)
    const harness = makeFakeAgent({
      responses: [
        [textEvent("ack"), readyEvent()],
        [{ message: { type: "tool_use_start", toolName: "lookup" } }],
      ],
    });
    nextAgent = harness.agent;

    // WHEN the run executes
    const result = await runIngestAsk({
      profile: profileFor("p-toolonly"),
      runId: "r-7",
      inputs: [],
      ingestMessage: "ingest",
      questionMessage: "ask",
      quietMs: 25,
    });

    // THEN it does NOT throw — "too slow to answer" is a gradable outcome,
    // so the run returns normally with an empty hypothesis flagged as
    // unanswered, leaving the caller to score it a completed miss.
    expect(result.questionAnswered).toBe(false);
    expect(result.hypothesis).toBe("");
    // AND it still carries both turns' events so the caller can persist
    // them and inspect what conversation B did
    expect(result.ingestEvents.length).toBe(2);
    expect(result.questionEvents.length).toBe(1);
    expect(harness.shutdownCount()).toBe(1);
  });
});

describe("runIngestAsk — ingest completion sentinel", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("fails loudly when the ingest turn ends without the sentinel", async () => {
    // GIVEN an ingest turn that emits events but never declares completion
    // (e.g. it stalled on an unresolved tool confirmation before saying
    // "Ready.")
    const harness = makeFakeAgent({
      responses: [
        [textEvent("reading trajectories..."), textEvent("still working")],
        [textEvent("unreachable hypothesis")],
      ],
    });
    nextAgent = harness.agent;

    // WHEN we run ingest → ask
    const run = runIngestAsk({
      profile: profileFor("p-no-sentinel"),
      runId: "r-no-sentinel",
      inputs: [],
      ingestMessage: "ingest",
      questionMessage: "ask",
      quietMs: 25,
      ingestMaxMs: 200,
    });

    // THEN it refuses to grade the truncated ingest rather than rotating
    // to the question turn
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestAskError);
    expect((err as Error).message).toMatch(
      /never emitted the completion sentinel/,
    );
    // AND it carries the captured ingest events so the caller can persist
    // them for debugging the stalled turn
    expect((err as IngestAskError).ingestEvents.length).toBe(2);
    // AND the question turn was never sent
    expect(harness.sends()).toEqual(["ingest"]);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("accepts a sentinel wrapped in quotes and trailing punctuation", async () => {
    // GIVEN an ingest turn whose final line is a quoted/punctuated variant
    // of the sentinel, as models commonly emit
    const harness = makeFakeAgent({
      responses: [
        [textEvent("done ingesting.\n"), textEvent('"Ready!"')],
        [textEvent("the answer")],
      ],
    });
    nextAgent = harness.agent;

    // WHEN we run ingest → ask
    const result = await runIngestAsk({
      profile: profileFor("p-fuzzy-sentinel"),
      runId: "r-fuzzy-sentinel",
      inputs: [],
      ingestMessage: "ingest",
      questionMessage: "ask",
      quietMs: 25,
    });

    // THEN the sentinel is recognized and the run completes normally
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("the answer");
  });

  test("honors a custom ingestSentinel", async () => {
    // GIVEN a caller that overrides the completion sentinel
    const harness = makeFakeAgent({
      responses: [
        [textEvent("indexed everything"), textEvent("\nDONE")],
        [textEvent("recalled")],
      ],
    });
    nextAgent = harness.agent;

    // WHEN we run ingest → ask with that sentinel
    const result = await runIngestAsk({
      profile: profileFor("p-custom-sentinel"),
      runId: "r-custom-sentinel",
      inputs: [],
      ingestMessage: "ingest",
      questionMessage: "ask",
      quietMs: 25,
      ingestSentinel: "DONE",
    });

    // THEN the custom sentinel ends the ingest turn
    expect(result.ingestSentinelSeen).toBe(true);
    expect(result.hypothesis).toBe("recalled");
  });
});

describe("runIngestAsk — shutdown is always called", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("calls shutdown even when writeWorkspaceFile throws mid-flight", async () => {
    const harness = makeFakeAgent({
      writeFailure: "simulated writeWorkspaceFile failure",
    });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-write-fail"),
        runId: "r-8",
        inputs: [{ path: "a.txt", content: "x" }],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/simulated writeWorkspaceFile failure/);
    expect(harness.shutdownCount()).toBe(1);
  });
});
