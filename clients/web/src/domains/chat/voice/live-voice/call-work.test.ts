import { describe, expect, test } from "bun:test";

import {
  VOICE_ACTIVITY_WORK_MAX,
  VOICE_ACTIVITY_WORK_TEXT_MAX,
} from "@vellumai/ipc-contract";

import type { SubagentEntry } from "@/domains/chat/subagent-store";

import {
  CALL_WORK_SETTLED_LINGER_MS,
  buildCallWork,
  createCallWorkTracker,
  sameCallWork,
  type CallWorkInput,
} from "./call-work";

const entry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  subagentId: "sub-1",
  label: "Flights to Lisbon",
  objective: "Find flights",
  status: "running",
  isFork: false,
  inputTokens: 0,
  outputTokens: 0,
  spawnedAt: 500,
  events: [],
  history: null,
  parentConversationId: "conv-1",
  ...overrides,
});

const input = (overrides: Partial<CallWorkInput> = {}): CallWorkInput => ({
  activityLabel: "",
  assistantName: "Ziggy",
  conversationId: "conv-1",
  subagents: [],
  now: 1_000,
  ...overrides,
});

describe("buildCallWork", () => {
  test("lists the foreground turn only while it is on a step", () => {
    const tracker = createCallWorkTracker();
    expect(buildCallWork(input(), tracker).work).toEqual([]);

    const { work } = buildCallWork(
      input({ activityLabel: "Searching the web" }),
      tracker,
    );
    expect(work).toEqual([
      {
        id: "turn",
        kind: "turn",
        title: "Ziggy",
        step: "Searching the web",
        state: "running",
        startedAt: 1_000,
      },
    ]);
  });

  test("keeps the turn's start across steps, and resets it between runs", () => {
    const tracker = createCallWorkTracker();
    buildCallWork(input({ activityLabel: "Searching the web" }), tracker);
    const next = buildCallWork(
      input({ activityLabel: "Reading a file", now: 3_000 }),
      tracker,
    );
    expect(next.work[0]?.startedAt).toBe(1_000);

    buildCallWork(input({ now: 4_000 }), tracker);
    const later = buildCallWork(
      input({ activityLabel: "Reading a file", now: 5_000 }),
      tracker,
    );
    expect(later.work[0]?.startedAt).toBe(5_000);
  });

  test("lists the call's running sub-agents, and no one else's", () => {
    const { work } = buildCallWork(
      input({
        subagents: [
          entry(),
          entry({ subagentId: "sub-2", parentConversationId: "conv-other" }),
          entry({ subagentId: "sub-3", parentConversationId: undefined }),
        ],
      }),
      createCallWorkTracker(),
    );
    expect(work.map((item) => item.id)).toEqual(["sub-1"]);
    expect(work[0]).toMatchObject({
      kind: "subagent",
      title: "Flights to Lisbon",
      state: "running",
      startedAt: 500,
    });
  });

  test("lists nothing of a sub-agent before the conversation is known", () => {
    const { work } = buildCallWork(
      input({ conversationId: null, subagents: [entry()] }),
      createCallWorkTracker(),
    );
    expect(work).toEqual([]);
  });

  test("leaves out sub-agents that finished before the call saw them run", () => {
    const { work } = buildCallWork(
      input({ subagents: [entry({ status: "completed" })] }),
      createCallWorkTracker(),
    );
    expect(work).toEqual([]);
  });

  test("keeps a finished sub-agent as done for a beat, then drops it", () => {
    const tracker = createCallWorkTracker();
    buildCallWork(input({ subagents: [entry()] }), tracker);

    const settled = buildCallWork(
      input({ subagents: [entry({ status: "completed" })], now: 2_000 }),
      tracker,
    );
    expect(settled.work[0]?.state).toBe("done");
    expect(settled.nextChangeAt).toBe(2_000 + CALL_WORK_SETTLED_LINGER_MS);

    const still = buildCallWork(
      input({ subagents: [entry({ status: "completed" })], now: 3_000 }),
      tracker,
    );
    expect(still.work[0]?.state).toBe("done");
    expect(still.nextChangeAt).toBe(2_000 + CALL_WORK_SETTLED_LINGER_MS);

    const gone = buildCallWork(
      input({
        subagents: [entry({ status: "completed" })],
        now: 2_000 + CALL_WORK_SETTLED_LINGER_MS,
      }),
      tracker,
    );
    expect(gone.work).toEqual([]);
    expect(gone.nextChangeAt).toBeNull();
  });

  test("reads a sub-agent that did not complete as failed", () => {
    const tracker = createCallWorkTracker();
    buildCallWork(input({ subagents: [entry()] }), tracker);
    const { work } = buildCallWork(
      input({ subagents: [entry({ status: "aborted" })], now: 2_000 }),
      tracker,
    );
    expect(work[0]?.state).toBe("failed");
  });

  test("reads a sub-agent waiting on the user as waiting, with no step", () => {
    const { work } = buildCallWork(
      input({ subagents: [entry({ status: "awaiting_input" })] }),
      createCallWorkTracker(),
    );
    expect(work[0]).toMatchObject({ state: "waiting", step: "" });
  });

  test("names a sub-agent's tool in flight as its step", () => {
    const { work } = buildCallWork(
      input({
        subagents: [
          entry({
            events: [
              {
                id: "e1",
                type: "tool_call",
                content: "notes.txt",
                toolName: "file_read",
                toolUseId: "tu-1",
                input: { path: "notes.txt", activity: "Reading your notes" },
                timestamp: 600,
              },
            ],
          }),
        ],
      }),
      createCallWorkTracker(),
    );
    expect(work[0]?.step).toBe("Reading your notes");
  });

  test("gives a sub-agent between tools no step", () => {
    const { work } = buildCallWork(
      input({
        subagents: [
          entry({
            events: [
              {
                id: "e1",
                type: "text",
                content: "Let me look.",
                timestamp: 600,
              },
            ],
          }),
        ],
      }),
      createCallWorkTracker(),
    );
    expect(work[0]?.step).toBe("");
  });
});

describe("sameCallWork", () => {
  const item = buildCallWork(
    input({ activityLabel: "Searching the web" }),
    createCallWorkTracker(),
  ).work;

  test("matches equal lists", () => {
    expect(sameCallWork(item, [{ ...item[0]! }])).toBe(true);
  });

  test("tells a changed step apart", () => {
    expect(sameCallWork(item, [{ ...item[0]!, step: "Reading a file" }])).toBe(
      false,
    );
  });
});

describe("the contract's bounds", () => {
  test("clamps a label longer than one update carries", () => {
    const { work } = buildCallWork(
      input({ subagents: [entry({ label: "x".repeat(2_000) })] }),
      createCallWorkTracker(),
    );
    expect(work[0]!.title.length).toBe(VOICE_ACTIVITY_WORK_TEXT_MAX);
    expect(work[0]!.title.endsWith("…")).toBe(true);
  });

  test("keeps the turn and the newest sub-agents past the list's limit", () => {
    const subagents = Array.from(
      { length: VOICE_ACTIVITY_WORK_MAX + 5 },
      (_, index) => entry({ subagentId: `sub-${index}` }),
    );
    const { work } = buildCallWork(
      input({ activityLabel: "Searching the web", subagents }),
      createCallWorkTracker(),
    );
    expect(work).toHaveLength(VOICE_ACTIVITY_WORK_MAX);
    expect(work[0]!.id).toBe("turn");
    expect(work.at(-1)!.id).toBe(`sub-${VOICE_ACTIVITY_WORK_MAX + 4}`);
  });
});
