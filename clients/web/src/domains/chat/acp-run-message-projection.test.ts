import { describe, expect, it } from "bun:test";

import type { AcpRunRawEvent } from "@/domains/chat/acp-run-store";
import {
  computeAcpRunChatBlocks,
  createAcpRunChatProjection,
  type AcpChatBlock,
} from "@/domains/chat/acp-run-message-projection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

function event(overrides: Partial<AcpRunRawEvent>): AcpRunRawEvent {
  return {
    seq: seq++,
    updateType: "agent_message_chunk",
    ...overrides,
  };
}

function agentChunk(messageId: string, content: string): AcpRunRawEvent {
  return event({ updateType: "agent_message_chunk", messageId, content });
}

function thoughtChunk(messageId: string, content: string): AcpRunRawEvent {
  return event({ updateType: "agent_thought_chunk", messageId, content });
}

function userChunk(messageId: string, content: string): AcpRunRawEvent {
  return event({ updateType: "user_message_chunk", messageId, content });
}

function steerMarker(n: number, instruction: string): AcpRunRawEvent {
  return event({
    updateType: "agent_message_chunk",
    messageId: `local-marker-${n}`,
    content: `↻ Steering: ${instruction}`,
  });
}

// ---------------------------------------------------------------------------
// computeAcpRunChatBlocks — chronological ordering
// ---------------------------------------------------------------------------

describe("computeAcpRunChatBlocks ordering", () => {
  it("preserves chronological order across block kinds", () => {
    const blocks = computeAcpRunChatBlocks([
      userChunk("u1", "hi"),
      thoughtChunk("t1", "let me think"),
      agentChunk("a1", "hello"),
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Read" }),
    ]);

    expect(blocks.map((b) => b.kind)).toEqual([
      "user",
      "thinking",
      "agent",
      "tool",
    ]);
  });

  it("includes user turns (unlike the step projection)", () => {
    const blocks = computeAcpRunChatBlocks([userChunk("u1", "do the thing")]);
    expect(blocks).toEqual([{ kind: "user", id: "u1", content: "do the thing" }]);
  });
});

// ---------------------------------------------------------------------------
// messageId coalescing
// ---------------------------------------------------------------------------

describe("messageId coalescing", () => {
  it("coalesces two same-id agent chunks into one concatenated block", () => {
    const blocks = computeAcpRunChatBlocks([
      agentChunk("a1", "Hello, "),
      agentChunk("a1", "world"),
    ]);

    expect(blocks).toEqual([
      { kind: "agent", messageId: "a1", content: "Hello, world", isComplete: false },
    ]);
  });

  it("coalesces same-id thinking chunks", () => {
    const blocks = computeAcpRunChatBlocks([
      thoughtChunk("t1", "step "),
      thoughtChunk("t1", "one"),
    ]);

    expect(blocks).toEqual([
      { kind: "thinking", messageId: "t1", content: "step one", isComplete: false },
    ]);
  });

  it("starts a new block when the messageId changes and closes the prior", () => {
    const blocks = computeAcpRunChatBlocks([
      agentChunk("a1", "first"),
      agentChunk("a2", "second"),
    ]);

    expect(blocks).toEqual([
      { kind: "agent", messageId: "a1", content: "first", isComplete: true },
      { kind: "agent", messageId: "a2", content: "second", isComplete: false },
    ]);
  });

  it("flips isComplete on the prior block when a later block starts", () => {
    const blocks = computeAcpRunChatBlocks([
      agentChunk("a1", "answer"),
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Bash" }),
    ]);

    const agent = blocks[0] as Extract<AcpChatBlock, { kind: "agent" }>;
    expect(agent.isComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// empty thought signals
// ---------------------------------------------------------------------------

describe("empty thought signals", () => {
  it("does not open a thinking block for all-empty thought chunks", () => {
    const blocks = computeAcpRunChatBlocks([
      thoughtChunk("t1", ""),
      thoughtChunk("t1", ""),
      agentChunk("a1", "hello"),
    ]);

    expect(blocks.map((b) => b.kind)).toEqual(["agent"]);
  });

  it("starts the thinking block at the first non-empty chunk", () => {
    const blocks = computeAcpRunChatBlocks([
      thoughtChunk("t1", ""),
      thoughtChunk("t1", "real"),
    ]);

    expect(blocks).toEqual([
      { kind: "thinking", messageId: "t1", content: "real", isComplete: false },
    ]);
  });

  it("preserves whitespace chunks once a thinking block is open", () => {
    const blocks = computeAcpRunChatBlocks([
      thoughtChunk("t1", "Hello"),
      thoughtChunk("t1", " "),
      thoughtChunk("t1", "world"),
    ]);

    expect(blocks).toEqual([
      {
        kind: "thinking",
        messageId: "t1",
        content: "Hello world",
        isComplete: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// steer markers / user turns
// ---------------------------------------------------------------------------

describe("user blocks", () => {
  it("turns a steer marker into a user block with the prefix stripped", () => {
    const blocks = computeAcpRunChatBlocks([steerMarker(2, "focus on tests")]);
    expect(blocks).toEqual([
      { kind: "user", id: "local-marker-2", content: "focus on tests" },
    ]);
  });

  it("treats a steer marker as a user turn even mid-stream", () => {
    const blocks = computeAcpRunChatBlocks([
      agentChunk("a1", "working"),
      steerMarker(1, "actually, stop"),
      agentChunk("a2", "ok"),
    ]);

    expect(blocks.map((b) => b.kind)).toEqual(["agent", "user", "agent"]);
    const user = blocks[1] as Extract<AcpChatBlock, { kind: "user" }>;
    expect(user.content).toBe("actually, stop");
    const firstAgent = blocks[0] as Extract<AcpChatBlock, { kind: "agent" }>;
    expect(firstAgent.isComplete).toBe(true);
  });

  it("does not strip a prefix from a plain user_message_chunk", () => {
    const blocks = computeAcpRunChatBlocks([userChunk("u1", "hi there")]);
    expect((blocks[0] as { content: string }).content).toBe("hi there");
  });

  it("reconciles the agent's echoed steer with the optimistic marker", () => {
    const blocks = computeAcpRunChatBlocks([
      steerMarker(1, "focus on tests"),
      // The agent echoes the accepted steer as a real user chunk.
      userChunk("u-echo", "focus on tests"),
    ]);
    // One bubble, upgraded to the real id — not the marker plus a duplicate.
    expect(blocks).toEqual([
      { kind: "user", id: "u-echo", content: "focus on tests" },
    ]);
  });

  it("reconciles the echo even when agent output lands between marker and echo", () => {
    const blocks = computeAcpRunChatBlocks([
      steerMarker(1, "stop and summarize"),
      agentChunk("a1", "cancelling…"),
      userChunk("u-echo", "stop and summarize"),
    ]);
    const users = blocks.filter((b) => b.kind === "user");
    expect(users).toHaveLength(1);
    expect((users[0] as { id: string }).id).toBe("u-echo");
  });

  it("keeps a user_message_chunk that does not match any marker", () => {
    const blocks = computeAcpRunChatBlocks([
      steerMarker(1, "focus on tests"),
      userChunk("u1", "something else entirely"),
    ]);
    expect(blocks.filter((b) => b.kind === "user")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// tool blocks
// ---------------------------------------------------------------------------

describe("tool blocks", () => {
  it("transitions a tool block running -> completed -> error", () => {
    const proj = createAcpRunChatProjection();

    let blocks = proj.project([
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Read" }),
    ]);
    expect((blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>).status).toBe(
      "running",
    );

    blocks = proj.project([
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Read" }),
      event({
        updateType: "tool_call_update",
        toolCallId: "tc1",
        toolStatus: "completed",
        content: "file contents",
      }),
    ]);
    let tool = blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>;
    expect(tool.status).toBe("completed");
    expect(tool.content).toBe("file contents");

    blocks = proj.project([
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Read" }),
      event({
        updateType: "tool_call_update",
        toolCallId: "tc1",
        toolStatus: "completed",
        content: "file contents",
      }),
      event({
        updateType: "tool_call_update",
        toolCallId: "tc1",
        toolStatus: "failed",
      }),
    ]);
    tool = blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>;
    expect(tool.status).toBe("error");
  });

  it("carries locations from a tool event when present", () => {
    const blocks = computeAcpRunChatBlocks([
      {
        seq: 0,
        updateType: "tool_call",
        toolCallId: "tc1",
        toolTitle: "Edit",
        // Passthrough field not in the store type; read defensively.
        locations: [{ path: "a.ts", line: 12 }, { path: "b.ts" }],
      } as AcpRunRawEvent,
    ]);

    const tool = blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>;
    expect(tool.locations).toEqual([{ path: "a.ts", line: 12 }, { path: "b.ts" }]);
  });

  it("honors a terminal status on the initial tool_call (no follow-up update)", () => {
    const blocks = computeAcpRunChatBlocks([
      event({
        updateType: "tool_call",
        toolCallId: "tc1",
        toolTitle: "Read",
        toolStatus: "completed",
      }),
      event({
        updateType: "tool_call",
        toolCallId: "tc2",
        toolTitle: "Bash",
        toolStatus: "failed",
      }),
    ]);

    expect((blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>).status).toBe(
      "completed",
    );
    expect((blocks[1] as Extract<AcpChatBlock, { kind: "tool" }>).status).toBe(
      "error",
    );
  });

  it("defaults the initial tool_call status to running when absent", () => {
    const blocks = computeAcpRunChatBlocks([
      event({ updateType: "tool_call", toolCallId: "tc1", toolTitle: "Read" }),
    ]);
    expect((blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>).status).toBe(
      "running",
    );
  });

  it("clears stale locations when an update carries an empty array", () => {
    const blocks = computeAcpRunChatBlocks([
      {
        seq: 0,
        updateType: "tool_call",
        toolCallId: "tc1",
        toolTitle: "Edit",
        locations: [{ path: "a.ts", line: 12 }],
      } as AcpRunRawEvent,
      {
        seq: 1,
        updateType: "tool_call_update",
        toolCallId: "tc1",
        // ACP `locations: []` means "replace with empty".
        locations: [],
      } as AcpRunRawEvent,
    ]);

    const tool = blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>;
    expect(tool.locations).toEqual([]);
  });

  it("preserves locations when an update omits the locations field", () => {
    const blocks = computeAcpRunChatBlocks([
      {
        seq: 0,
        updateType: "tool_call",
        toolCallId: "tc1",
        toolTitle: "Edit",
        locations: [{ path: "a.ts", line: 12 }],
      } as AcpRunRawEvent,
      event({
        updateType: "tool_call_update",
        toolCallId: "tc1",
        toolStatus: "completed",
      }),
    ]);

    const tool = blocks[0] as Extract<AcpChatBlock, { kind: "tool" }>;
    expect(tool.locations).toEqual([{ path: "a.ts", line: 12 }]);
  });
});

// ---------------------------------------------------------------------------
// plan upsert
// ---------------------------------------------------------------------------

describe("plan upsert", () => {
  it("upserts a single plan block across multiple plan events", () => {
    const plan1 = JSON.stringify([{ content: "step 1", status: "pending" }]);
    const plan2 = JSON.stringify([
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "pending" },
    ]);

    const blocks = computeAcpRunChatBlocks([
      event({ updateType: "plan", content: plan1 }),
      agentChunk("a1", "thinking out loud"),
      event({ updateType: "plan", content: plan2 }),
    ]);

    const planBlocks = blocks.filter((b) => b.kind === "plan");
    expect(planBlocks).toHaveLength(1);
    expect(planBlocks[0]).toEqual({
      kind: "plan",
      entries: [
        { label: "step 1", checked: true },
        { label: "step 2", checked: false },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// incremental projector — append fast path
// ---------------------------------------------------------------------------

describe("incremental projector", () => {
  it("returns the same reference when events are unchanged", () => {
    const proj = createAcpRunChatProjection();
    const events = [agentChunk("a1", "hi")];
    const first = proj.project(events);
    const second = proj.project(events);
    expect(second).toBe(first);
  });

  it("append fast path returns value-equal output to a full rebuild", () => {
    const proj = createAcpRunChatProjection();

    const base = [agentChunk("a1", "Hello, "), thoughtChunk("t1", "hmm")];
    proj.project(base);

    const tail = event({
      updateType: "tool_call",
      toolCallId: "tc1",
      toolTitle: "Bash",
    });
    const grown = [...base, tail];

    const incremental = proj.project(grown);
    const fromScratch = computeAcpRunChatBlocks(grown);

    expect(incremental).toEqual(fromScratch);
  });

  it("falls back to a full rebuild on a non-append diff (truncation)", () => {
    const proj = createAcpRunChatProjection();
    const full = [agentChunk("a1", "one"), agentChunk("a2", "two")];
    proj.project(full);

    const truncated = full.slice(0, 1);
    const result = proj.project(truncated);
    expect(result).toEqual(computeAcpRunChatBlocks(truncated));
  });
});
