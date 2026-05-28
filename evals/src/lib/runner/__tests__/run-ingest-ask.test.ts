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
import { runIngestAsk } from "../run-ingest-ask";

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
}

interface FakeAgentHarness {
  agent: BaseAgent;
  hatched: () => boolean;
  shutdownCount: () => number;
  writes: () => WorkspaceFileWrite[];
  sends: () => string[];
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
  const writes: WorkspaceFileWrite[] = [];
  const sends: string[] = [];
  const queues: AgentEvent[][] = (
    opts.responses ?? [[textEvent("ack")], [textEvent("hypothesis")]]
  ).map((q) => q.slice());
  let turn = 0;
  let conversationKey = "convo-1";

  const eventsFn = (): AsyncIterable<AgentEvent> => {
    const queue = queues[turn];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (!queue || queue.length === 0) {
              return { value: undefined, done: true };
            }
            const value = queue.shift()!;
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

  return {
    agent,
    hatched: () => hatched,
    shutdownCount: () => shutdowns,
    writes: () => writes.slice(),
    sends: () => sends.slice(),
  };
}

describe("runIngestAsk — happy path", () => {
  afterEach(() => {
    nextAgent = null;
  });

  test("hatches, stages inputs, sends both messages, rotates conversation, returns hypothesis", async () => {
    const harness = makeFakeAgent({
      responses: [
        [textEvent("ingested-ack")],
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
    expect(result.ingestEvents.length).toBe(1);
    expect(result.questionEvents.length).toBe(2);
    expect(harness.shutdownCount()).toBe(1);
  });

  test("supports zero inputs (caller relies on persistent state alone)", async () => {
    const harness = makeFakeAgent({
      responses: [[textEvent("ok")], [textEvent("answer")]],
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
      responses: [[textEvent("ack")], []],
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

  test("throws when the question turn emits only non-text events", async () => {
    const harness = makeFakeAgent({
      responses: [
        [textEvent("ack")],
        // tool-use event with no text/chunk → hypothesis would be
        // empty even though the turn produced an event.
        [{ message: { type: "tool_use_start", toolName: "lookup" } }],
      ],
    });
    nextAgent = harness.agent;

    await expect(
      runIngestAsk({
        profile: profileFor("p-toolonly"),
        runId: "r-7",
        inputs: [],
        ingestMessage: "ingest",
        questionMessage: "ask",
        quietMs: 25,
      }),
    ).rejects.toThrow(/no assistant text/);
    expect(harness.shutdownCount()).toBe(1);
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
