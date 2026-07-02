import { describe, expect, it } from "bun:test";

import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import {
  appendTextDelta,
  appendThinkingDelta,
  applyUserMessageEcho,
  createStreamingBubble,
  finalizeMessageComplete,
  finalizeOnIdle,
  handleConversationError,
} from "@/domains/chat/utils/stream-updaters/message-updaters";
import { attachSurface } from "@/domains/chat/utils/stream-updaters/surface-updaters";
import {
  applyToolResult,
  upsertToolCall,
} from "@/domains/chat/utils/stream-updaters/tool-call-updaters";
import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  isToolCallCompleted,
  isToolCallRunning,
} from "@/domains/chat/utils/tool-call-status";
import {
  messageText as text,
  textBody as seg,
} from "@/domains/chat/utils/message-test-helpers";

function makeAssistantMsg(
  overrides: Partial<DisplayMessage> = {},
): DisplayMessage {
  return {
    id: "stable-1",
    role: "assistant",
    ...seg("hello"),
    timestamp: 1000,
    ...overrides,
  };
}

const userMsg: DisplayMessage = {
  id: "user-1",
  role: "user",
  ...seg("hi"),
  timestamp: 999,
};

// ---------------------------------------------------------------------------
// createStreamingBubble
// ---------------------------------------------------------------------------

describe("createStreamingBubble", () => {
  it("appends a new streaming assistant message", () => {
    const prev = [userMsg];
    const result = createStreamingBubble(prev, "Hello", "msg-1");

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(userMsg);

    const bubble = result[1]!;
    expect(bubble.role).toBe("assistant");
    expect(liveAssistantRowId(result, true)).toBe(bubble.id);
    expect(text(bubble)).toBe("Hello");
    expect(bubble.id).toBe("msg-1");
    expect(bubble.id).toBeDefined();
  });

  it("works on an empty array", () => {
    const result = createStreamingBubble([], "text");
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(liveAssistantRowId(result, true)).toBe(result[0]!.id);
  });

  it("preserves existing messages", () => {
    const existing = [userMsg, makeAssistantMsg({ id: "a1" })];
    const result = createStreamingBubble(existing, "new");
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(userMsg);
  });
});

// ---------------------------------------------------------------------------
// appendTextDelta
// ---------------------------------------------------------------------------

describe("appendTextDelta", () => {
  it("appends text to the last streaming assistant message", () => {
    const msg = makeAssistantMsg(seg("He"));
    const result = appendTextDelta([userMsg, msg], "llo");

    expect(result).toHaveLength(2);
    const last = result[1]!;
    expect(text(last)).toBe("Hello");
  });

  it("creates a new streaming bubble when last message is a user message", () => {
    // Initial assistant turn (no prior assistant bubble at all) — first
    // text delta must spawn the bubble rather than no-op.
    const result = appendTextDelta([userMsg], "text");

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(liveAssistantRowId(result, true)).toBe(result[1]!.id);
    expect(text(result[1]!)).toBe("text");
  });

  it("uses the supplied messageId when creating a new bubble", () => {
    const result = appendTextDelta([userMsg], "text", "msg-xyz");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("msg-xyz");
  });

  it("does not mutate the original array", () => {
    const msg = makeAssistantMsg(seg("a"));
    const prev = [msg];
    appendTextDelta(prev, "b");
    expect(text(prev[0]!)).toBe("a");
  });

  it("extends the matching row when messageId matches, regardless of tail position", () => {
    // Every event in an LLM call carries the same `messageId`. The handler
    // must land deltas in the row keyed by id, not the tail — otherwise a
    // reconcile race (a poll fetches the daemon's reserved empty row into
    // local state ahead of the first delta) opens a duplicate row sharing
    // the same id.
    const reservedFromReconcile = makeAssistantMsg({
      id: "row-X",
      textSegments: [],
      contentOrder: [],
      contentBlocks: [],
    });
    const result = appendTextDelta(
      [userMsg, reservedFromReconcile],
      "Hello",
      "row-X",
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-X");
    expect(text(result[1]!)).toBe("Hello");
    expect(liveAssistantRowId(result, true)).toBe("row-X");
    expect(result[1]!.textSegments).toEqual(["Hello"]);
  });

  it("folds a later LLM call's delta into the assistant tail, recording its id as an alias", () => {
    /**
     * A multi-LLM-call agent turn renders as one bubble: the second LLM
     * call's first delta carries a fresh messageId, but it must fold into
     * the current assistant run rather than open a duplicate bubble.
     */

    // GIVEN the first LLM call has finalized into an assistant tail
    const call1Final = makeAssistantMsg({
      id: "row-A",
      textSegments: ["Hello"],
      contentOrder: [{ type: "text", id: "0" }],
    });

    // WHEN the next LLM call's first delta arrives with a new messageId
    const result = appendTextDelta([userMsg, call1Final], " world", "row-B");

    // THEN it extends the existing bubble instead of opening a new one
    expect(result).toHaveLength(2);
    const tail = result[1]!;
    expect(tail.id).toBe("row-A");
    expect(text(tail)).toBe("Hello world");
    expect(liveAssistantRowId(result, true)).toBe("row-A");

    // AND the new messageId is recorded as an alias so later events for it
    // (and the post-turn reconcile) resolve to this anchor
    expect(tail.mergedMessageIds).toEqual(["row-B"]);
  });

  it("opens a new bubble when messageId is provided and the tail is a user row", () => {
    /**
     * A new agent turn always begins with a user row, so a delta whose id
     * no row owns opens a fresh bubble when the tail is not assistant.
     */

    // GIVEN the tail is a user message (start of a new turn)
    // WHEN the first delta of the assistant reply arrives
    const result = appendTextDelta([userMsg], "text", "row-B");

    // THEN a fresh streaming bubble opens, keyed by the messageId
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-B");
    expect(text(result[1]!)).toBe("text");
    expect(liveAssistantRowId(result, true)).toBe("row-B");
    expect(result[1]!.mergedMessageIds).toBeUndefined();
  });

  it("folds a delta whose id the anchor already lists as a merged alias", () => {
    /**
     * The backend merge collapses a run of reserved rows onto the first
     * row's id and lists the rest as aliases. A live delta carrying one of
     * those alias ids must resolve to the anchor, not open a duplicate.
     */

    // GIVEN an anchor row that already owns "row-B" as a merged alias
    const anchor = makeAssistantMsg({
      id: "row-A",
      textSegments: ["Hello"],
      contentOrder: [{ type: "text", id: "0" }],
      mergedMessageIds: ["row-B"],
    });

    // WHEN a delta arrives stamped with the aliased id
    const result = appendTextDelta([userMsg, anchor], " world", "row-B");

    // THEN it extends the anchor and leaves the alias set unchanged
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-A");
    expect(text(result[1]!)).toBe("Hello world");
    expect(result[1]!.mergedMessageIds).toEqual(["row-B"]);
  });

  it("extends consecutive same-id deltas into a single row", () => {
    // The common case: a single LLM call emits N deltas, all carrying
    // the same `messageId`. They accumulate into one row.
    let state: DisplayMessage[] = [userMsg];
    state = appendTextDelta(state, "Hello", "row-A");
    state = appendTextDelta(state, " ", "row-A");
    state = appendTextDelta(state, "world", "row-A");

    expect(state).toHaveLength(2);
    expect(state[1]!.id).toBe("row-A");
    expect(text(state[1]!)).toBe("Hello world");
  });

  it("backfills a skipped block instead of clobbering a neighbour when coalescing onto a short projection", () => {
    // GIVEN a reconcile race lands a row whose contentBlocks projection is
    // shorter than its contentOrder — normalizeContentBlocks drops the empty
    // trailing text segment, so the only block is the leading thinking one
    const reserved = makeAssistantMsg({
      id: "row-A",
      thinkingSegments: ["reasoning"],
      textSegments: [""],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "text", id: "0" },
      ],
      contentBlocks: [{ type: "thinking", thinking: "reasoning" }],
    });

    // WHEN a text delta coalesces onto that now-populated text segment
    const result = appendTextDelta([userMsg, reserved], "Hello", "row-A");

    // THEN the trailing thinking block is preserved and the text block is
    // backfilled, rather than the thinking block being overwritten
    const row = result[1]!;
    expect(row.textSegments).toEqual(["Hello"]);
    expect(row.contentBlocks).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "Hello" },
    ]);
  });

  // --- re-attach seed: the "vanishing prefix" fix ---

  it("seeds the live row from its history twin so a re-attach keeps the persisted prefix", () => {
    // GIVEN this client attaches mid-turn: the live turn holds only the user
    // row, while the daemon already persisted a prefix under the reserved id,
    // which now sits in the history cache (the resolver returns it).
    const historyTwin = makeAssistantMsg({ id: "row-B", ...seg("The persisted ") });

    // WHEN the first replayed delta (seq > the snapshot watermark) arrives
    const result = appendTextDelta([userMsg], "answer", "row-B", () => historyTwin);

    // THEN the delta extends the persisted prefix on the SAME row instead of
    // opening a fresh, prefix-less bubble — the opening text is not dropped.
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-B");
    expect(text(result[1]!)).toBe("The persisted answer");
  });

  it("opens a fresh bubble when the twin resolver finds no history prefix", () => {
    // GIVEN a genuinely new turn — no persisted prefix, resolver returns undefined.
    const result = appendTextDelta([userMsg], "answer", "row-B", () => undefined);

    // THEN behaviour is identical to before the seed existed: a fresh bubble.
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-B");
    expect(text(result[1]!)).toBe("answer");
  });

  it("never resolves the twin when a live row already owns the id (hot-path guard)", () => {
    // The per-token steady state must not pay for a history lookup — the
    // resolver is consulted only in the cold "no live row owns this id" branch.
    const anchor = makeAssistantMsg({ id: "row-A", ...seg("Hello") });
    let resolverCalls = 0;

    const result = appendTextDelta([userMsg, anchor], " world", "row-A", () => {
      resolverCalls++;
      return undefined;
    });

    expect(resolverCalls).toBe(0);
    expect(text(result[1]!)).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// finalizeMessageComplete
// ---------------------------------------------------------------------------

describe("finalizeMessageComplete", () => {
  // `message_complete` carries no body content on the wire — text streams via
  // `assistant_text_delta` chunks; `message_complete` only finalizes/binds.
  // The "new bubble" branch fires only when attachments accompany the event.

  it("opens a new finalized assistant bubble with attachments when tail is a user message", () => {
    const result = finalizeMessageComplete([userMsg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          data: "JVBERi0=",
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.id).toBe("row-A");
    expect(text(result[1]!)).toBe("");
    expect(result[1]!.attachments).toHaveLength(1);
  });

  it("opens a new bubble with attachments when prev is empty", () => {
    const result = finalizeMessageComplete([], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
      attachments: [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          data: "JVBERi0=",
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("row-A");
    expect(result[0]!.attachments).toHaveLength(1);
  });

  it("returns prev unchanged when tail is user and event has no attachments", () => {
    const prev = [userMsg];
    const result = finalizeMessageComplete(prev, {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-A",
    });
    expect(result).toBe(prev);
  });

  it("finalizes a streaming assistant tail and keeps tail.id (anchor preservation)", () => {
    const msg = makeAssistantMsg({
      id: "bubble-anchor",
      ...seg("hello world"),
    });
    const result = finalizeMessageComplete([userMsg, msg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "inner-row-id",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("bubble-anchor");
    // Bubble content stays whatever the text-delta accumulator left it as —
    // message_complete no longer carries body content on the wire.
    expect(text(result[1]!)).toBe("hello world");
  });

  it("finalizes running tool calls when finalizing", () => {
    const toolCall: ChatMessageToolCall = {
      id: "t-1",
      name: "bash",
      input: { command: "ls" },
    };
    const msg = makeAssistantMsg({ id: "bubble-A", toolCalls: [toolCall] });
    const result = finalizeMessageComplete([msg], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-B",
    });
    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
  });

  it("appends to a finalized assistant tail without overwriting its id (multi-LLM-call turn)", () => {
    // Second message_complete in the same agent turn — tail is the bubble
    // from the previous call. Should keep id.
    const tail = makeAssistantMsg({
      id: "bubble-anchor",
      ...seg("first call done"),
    });
    const result = finalizeMessageComplete([userMsg, tail], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "row-B",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("bubble-anchor");
    // Tail content preserved across multi-call merge — message_complete no
    // longer brings its own content.
    expect(text(result[1]!)).toBe("first call done");
  });

  it("adopts the server messageId for an optimistic streaming tail (first message_complete)", () => {
    // The live streaming bubble is created optimistic (text deltas carry no
    // messageId). The first message_complete must swap its client UUID for the
    // server id so the post-turn reconcile matches by id — otherwise a
    // multi-LLM-call turn (e.g. subagent spawn) whose collapsed server content
    // diverges from the bubble text reconciles to a duplicate row.
    const optimistic = makeAssistantMsg({
      id: "client-uuid",
      ...seg("Spawning a researcher on this now."),
      isOptimistic: true,
    });
    const result = finalizeMessageComplete([userMsg, optimistic], {
      type: "message_complete",
      conversationId: "c-1",
      messageId: "server-row-id",
    });

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-row-id");
    expect(result[1]!.isOptimistic).toBe(false);
  });

  it("keeps the optimistic id when message_complete carries no messageId", () => {
    const optimistic = makeAssistantMsg({
      id: "client-uuid",
      isOptimistic: true,
    });
    const result = finalizeMessageComplete([userMsg, optimistic], {
      type: "message_complete",
      conversationId: "c-1",
    });

    expect(result[1]!.id).toBe("client-uuid");
    expect(result[1]!.isOptimistic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleConversationError
// ---------------------------------------------------------------------------

describe("handleConversationError", () => {
  it("finalizes the assistant tail and keeps message with content", () => {
    const msg = makeAssistantMsg(seg("partial response"));
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(2);
    expect(text(result[1]!)).toBe("partial response");
  });

  it("removes empty streaming bubble", () => {
    const msg = makeAssistantMsg({ ...seg(""), toolCalls: undefined });
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(userMsg);
  });

  it("keeps message with tool calls but no text content", () => {
    const msg = makeAssistantMsg({
      ...seg(""),
      toolCalls: [
        {
          id: "tc-1",
          name: "search",
          input: {},
        },
      ],
    });
    const result = handleConversationError([userMsg, msg]);

    expect(result).toHaveLength(2);
    expect(isToolCallCompleted(result[1]!.toolCalls![0]!)).toBe(true);
  });

  it("returns prev unchanged if last is not an assistant", () => {
    const prev = [userMsg];
    const result = handleConversationError(prev);
    expect(result).toBe(prev);
  });
});

// ---------------------------------------------------------------------------
// upsertToolCall
// ---------------------------------------------------------------------------

describe("upsertToolCall", () => {
  const toolCall = {
    id: "tc-1",
    name: "web_search",
    input: {} as Record<string, unknown>,
    status: "running" as const,
  };

  it("appends tool call to existing streaming assistant tail", () => {
    const msg = makeAssistantMsg({ toolCalls: undefined });
    const result = upsertToolCall([userMsg, msg], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.toolCalls).toHaveLength(1);
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
    expect(result[1]!.toolCalls![0]!.name).toBe("web_search");
  });

  it("updates existing tool call by id", () => {
    const msg = makeAssistantMsg({
      toolCalls: [{ id: "tc-1", name: "old_name", input: {} }],
    });
    const updatedTc = {
      id: "tc-1",
      name: "web_search",
      input: {} as Record<string, unknown>,
      status: "running" as const,
    };
    const result = upsertToolCall([msg], updatedTc);

    expect(result[0]!.toolCalls).toHaveLength(1);
    expect(result[0]!.toolCalls![0]!.name).toBe("web_search");
  });

  it("folds into the assistant tail rather than opening a duplicate bubble", () => {
    // Liveness is positional: a tool call arriving while an assistant row
    // is the tail belongs to that same run (the consolidation invariant),
    // so it folds in instead of spawning a sibling.
    const tail = makeAssistantMsg({ toolCalls: undefined });
    const result = upsertToolCall([userMsg, tail], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe(tail.id);
    expect(result[1]!.toolCalls).toHaveLength(1);
  });

  it("creates a new bubble when no streaming assistant tail exists", () => {
    const result = upsertToolCall([userMsg], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("does not mutate existing messages", () => {
    const msg = makeAssistantMsg({ toolCalls: [] });
    const prev = [msg];
    upsertToolCall(prev, toolCall);
    expect(prev[0]!.toolCalls).toHaveLength(0);
  });

  it("folds into an id-matched assistant row when messageId is present", () => {
    // Reserved-row case: `assistant_turn_start` (or reconcile) landed an
    // empty assistant row at the anchor id ahead of the first
    // `tool_use_start`. Without id matching, upsertToolCall would open a
    // duplicate bubble.
    const anchor = makeAssistantMsg({
      id: "anchor-1",
      ...seg(""),
      toolCalls: undefined,
      contentOrder: undefined,
    });
    const result = upsertToolCall([userMsg, anchor], toolCall, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("anchor-1");
    expect(liveAssistantRowId(result, true)).toBe("anchor-1");
    expect(result[1]!.toolCalls).toHaveLength(1);
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("folds a later LLM call's tool call into the assistant tail, recording its id as an alias", () => {
    /**
     * A multi-LLM-call turn renders as one bubble: a tool call from a
     * later call (fresh messageId) folds into the current assistant run
     * instead of opening a duplicate bubble.
     */

    // GIVEN the first LLM call has finalized into an assistant tail
    const call1Final = makeAssistantMsg({
      id: "row-A",
      ...seg("Hello"),
    });

    // WHEN the next LLM call's tool_use_start arrives with a new messageId
    const result = upsertToolCall([userMsg, call1Final], toolCall, "row-B");

    // THEN it folds into the existing bubble and records the alias
    expect(result).toHaveLength(2);
    const tail = result[1]!;
    expect(tail.id).toBe("row-A");
    expect(liveAssistantRowId(result, true)).toBe("row-A");
    expect(tail.toolCalls).toHaveLength(1);
    expect(tail.toolCalls![0]!.id).toBe("tc-1");
    expect(tail.mergedMessageIds).toEqual(["row-B"]);
  });

  it("folds a tool call whose id the anchor already lists as a merged alias", () => {
    /**
     * A tool_use_start carrying an id the backend merge already folded
     * onto the anchor must resolve to the anchor, not open a duplicate.
     */

    // GIVEN an anchor row that already owns "row-B" as a merged alias
    const anchor = makeAssistantMsg({
      id: "row-A",
      ...seg("Hello"),
      mergedMessageIds: ["row-B"],
    });

    // WHEN a tool call arrives stamped with the aliased id
    const result = upsertToolCall([userMsg, anchor], toolCall, "row-B");

    // THEN it folds into the anchor and leaves the alias set unchanged
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-A");
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
    expect(result[1]!.mergedMessageIds).toEqual(["row-B"]);
  });

  it("adopts messageId as the row id when opening a new bubble (no isOptimistic flag)", () => {
    // Anchor protocol: every `tool_use_start` carries `messageId` from
    // event zero — the daemon has committed to the assistant message
    // existing. The new bubble adopts that id and is NOT optimistic.
    const result = upsertToolCall([userMsg], toolCall, "server-msg-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-msg-1");
    expect(result[1]!.isOptimistic).toBeUndefined();
    expect(result[1]!.toolCalls![0]!.id).toBe("tc-1");
  });

  it("stamps isOptimistic only when messageId is absent (pre-anchor daemon)", () => {
    // Fallback path — only reachable from pre-B2 daemons that haven't
    // adopted the anchor protocol. The row id is a client UUID and the
    // flag tells reconcile to fall back to content matching.
    const result = upsertToolCall([userMsg], toolCall);

    expect(result).toHaveLength(2);
    expect(result[1]!.isOptimistic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attachSurface
// ---------------------------------------------------------------------------

describe("attachSurface", () => {
  const surface: Surface = {
    surfaceId: "surf-1",
    surfaceType: "card",
    data: {},
  };

  it("attaches to an id-matched assistant row when messageId is present", () => {
    const target = makeAssistantMsg({ id: "anchor-1" });
    const result = attachSurface([userMsg, target], surface, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("anchor-1");
    expect(result[1]!.surfaces).toHaveLength(1);
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("attaches to an assistant row that owns the messageId as a merged alias", () => {
    /**
     * The backend merge lists later LLM-call ids as aliases on the anchor.
     * A surface stamped with such an id must resolve to the anchor rather
     * than open a duplicate bubble.
     */

    // GIVEN an anchor row that already owns "row-B" as a merged alias
    const anchor = makeAssistantMsg({
      id: "row-A",
      mergedMessageIds: ["row-B"],
    });

    // WHEN a surface arrives stamped with the aliased id
    const result = attachSurface([userMsg, anchor], surface, "row-B");

    // THEN it attaches to the anchor and leaves the alias set unchanged
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-A");
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
    expect(result[1]!.mergedMessageIds).toEqual(["row-B"]);
  });

  it("folds a later LLM call's surface into the assistant tail, recording its id as an alias", () => {
    /**
     * A surface from a later LLM call (fresh messageId) folds into the
     * current assistant run instead of opening a duplicate bubble.
     */

    // GIVEN the first LLM call has finalized into an assistant tail
    const call1Final = makeAssistantMsg({ id: "row-A" });

    // WHEN the next LLM call's surface arrives with a new messageId
    const result = attachSurface([userMsg, call1Final], surface, "row-B");

    // THEN it attaches to the existing bubble and records the alias
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-A");
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
    expect(result[1]!.mergedMessageIds).toEqual(["row-B"]);
  });

  it("falls back to the assistant tail when messageId is absent", () => {
    const target = makeAssistantMsg({ id: "stream-1" });
    const result = attachSurface([userMsg, target], surface);

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("stream-1");
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("adopts messageId as the row id when opening a new bubble (no isOptimistic flag)", () => {
    // Surface-only turn: no streaming assistant yet, but the daemon
    // stamps the wire event with the anchor messageId.
    const result = attachSurface([userMsg], surface, "server-msg-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("server-msg-1");
    expect(result[1]!.isOptimistic).toBeUndefined();
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("stamps isOptimistic only when messageId is absent (pre-anchor daemon)", () => {
    const result = attachSurface([userMsg], surface);

    expect(result).toHaveLength(2);
    expect(result[1]!.isOptimistic).toBe(true);
    expect(result[1]!.surfaces![0]!.surfaceId).toBe("surf-1");
  });

  it("is a no-op when the surface is already attached to the target message", () => {
    const target = makeAssistantMsg({
      id: "anchor-1",
      surfaces: [surface],
      contentOrder: [{ type: "surface", id: "surf-1" }],
    });
    const result = attachSurface([userMsg, target], surface, "anchor-1");

    expect(result).toHaveLength(2);
    expect(result[1]!.surfaces).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — activityMetadata persistence
// ---------------------------------------------------------------------------

describe("applyToolResult — activityMetadata", () => {
  const baseToolCall: ChatMessageToolCall = {
    id: "tc-1",
    name: "web_search",
    input: { query: "tigers" },
    startedAt: 1000,
  };

  function msgWithRunningCall(): DisplayMessage {
    return makeAssistantMsg({
      toolCalls: [baseToolCall],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
  }

  const metadata: ToolActivityMetadata = {
    webSearch: {
      query: "tigers",
      provider: "anthropic-native",
      resultCount: 1,
      durationMs: 250,
      results: [
        {
          rank: 1,
          title: "Tigers - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Tiger",
          domain: "en.wikipedia.org",
        },
      ],
    },
  };

  it("persists activityMetadata onto the tool call", () => {
    const result = applyToolResult([msgWithRunningCall()], {
      toolUseId: "tc-1",
      result: "...",
      activityMetadata: metadata,
    });
    expect(result[0]!.toolCalls![0]!.activityMetadata).toEqual(metadata);
    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
  });

  it("preserves prior activityMetadata when re-applied without it", () => {
    const msg = makeAssistantMsg({
      toolCalls: [{ ...baseToolCall, activityMetadata: metadata }],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const result = applyToolResult([msg], {
      toolUseId: "tc-1",
      result: "...",
    });
    expect(result[0]!.toolCalls![0]!.activityMetadata).toEqual(metadata);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — completedAt clock source
// ---------------------------------------------------------------------------

describe("applyToolResult — completedAt", () => {
  function msgWithRunningCall(): DisplayMessage {
    return makeAssistantMsg({
      toolCalls: [
        { id: "tc-1", name: "bash", input: { command: "ls" }, startedAt: 1000 },
      ],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
  }

  it("uses the server-stamped completedAt so it shares the daemon clock with startedAt", () => {
    // GIVEN a running tool started at the daemon's clock (1000)
    // WHEN a result carries the daemon completion time
    const result = applyToolResult([msgWithRunningCall()], {
      toolUseId: "tc-1",
      result: "ok",
      completedAt: 4200,
    });

    // THEN the tool call ends on that same clock (duration stays 3.2s)
    expect(result[0]!.toolCalls![0]!.completedAt).toBe(4200);
  });

  it("falls back to the local clock when the daemon omits completedAt", () => {
    // GIVEN a result from an older daemon with no completion time
    const before = Date.now();

    // WHEN the result is applied
    const result = applyToolResult([msgWithRunningCall()], {
      toolUseId: "tc-1",
      result: "ok",
    });

    // THEN the completion is stamped from the local clock
    expect(typeof result[0]!.toolCalls![0]!.completedAt).toBe("number");
    expect(result[0]!.toolCalls![0]!.completedAt).toBeGreaterThanOrEqual(
      before,
    );
    expect(result[0]!.toolCalls![0]!.completedAt).toBeLessThanOrEqual(
      Date.now(),
    );
  });
});

// ---------------------------------------------------------------------------
// finalizeOnIdle — multi-message coverage
// ---------------------------------------------------------------------------

describe("finalizeOnIdle", () => {
  it("finalizes running tool calls across all assistant messages", () => {
    const msg1 = makeAssistantMsg({
      id: "a1",
      ...seg(""),
      toolCalls: [{ id: "tc-1", name: "web_search", input: {} }],
      contentOrder: [{ type: "toolCall", id: "tc-1" }],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
      ...seg("some text"),
      toolCalls: [{ id: "tc-2", name: "web_fetch", input: {} }],
      contentOrder: [{ type: "toolCall", id: "tc-2" }],
    });
    const result = finalizeOnIdle([userMsg, msg1, msg2]);

    expect(result).toHaveLength(3);
    expect(isToolCallCompleted(result[1]!.toolCalls![0]!)).toBe(true);
    expect(result[1]!.toolCalls![0]!.completedAt).toBeDefined();
    expect(isToolCallCompleted(result[2]!.toolCalls![0]!)).toBe(true);
    expect(result[2]!.toolCalls![0]!.completedAt).toBeDefined();
  });

  it("returns prev unchanged when no assistant messages have running tool calls", () => {
    const prev = [userMsg];
    const result = finalizeOnIdle(prev);
    expect(result).toBe(prev);
  });

  it("is a no-op when assistant messages have only completed tool calls", () => {
    // Idle only finalizes *running* tool calls; there is no per-row flag
    // to flip, so a row whose tool calls are already complete is returned
    // untouched.
    const msg = makeAssistantMsg({
      toolCalls: [
        { id: "tc-1", name: "web_search", input: {}, completedAt: 1 },
      ],
    });
    const prev = [msg];
    const result = finalizeOnIdle(prev);

    expect(result).toBe(prev);
    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
  });

  it("is a no-op for an assistant row with no tool calls at all", () => {
    const msg = makeAssistantMsg({ toolCalls: undefined });
    const prev = [msg];
    const result = finalizeOnIdle(prev);

    expect(result).toBe(prev);
  });

  it("finalizes running tool calls on every assistant row on idle", () => {
    // Idle clears the conversation's processing state, so any tool call
    // still marked running is stale and gets finalized regardless of the
    // row's position.
    const msgA = makeAssistantMsg({
      id: "a-1",
      toolCalls: [{ id: "tc-old", name: "bash", input: {} }],
    });
    const msgB = makeAssistantMsg({
      id: "a-2",
      toolCalls: [{ id: "tc-new", name: "web_search", input: {} }],
    });
    const result = finalizeOnIdle([msgA, msgB]);

    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
    expect(isToolCallCompleted(result[1]!.toolCalls![0]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — cross-message matching
// ---------------------------------------------------------------------------

describe("applyToolResult — cross-message matching", () => {
  it("preserves image data from tool result events on the matching tool call", () => {
    const toolCall: ChatMessageToolCall = {
      id: "tc-img",
      name: "media_generate_image",
      input: { prompt: "diagram" },
    };
    const msg = makeAssistantMsg({
      toolCalls: [toolCall],
      contentOrder: [{ type: "toolCall", id: "tc-img" }],
      contentBlocks: [{ type: "tool_use", toolCall }],
    });

    const result = applyToolResult([msg], {
      toolUseId: "tc-img",
      result: "Generated 2 images",
      imageData: "img-a",
      imageDataList: ["img-a", "img-b"],
    });

    const updatedToolCall = result[0]!.toolCalls![0]!;
    expect(updatedToolCall.imageData).toBe("img-a");
    expect(updatedToolCall.imageDataList).toEqual(["img-a", "img-b"]);

    const toolUseBlock = result[0]!.contentBlocks!.find(
      (block) => block.type === "tool_use",
    );
    expect(toolUseBlock?.toolCall.imageData).toBe("img-a");
    expect(toolUseBlock?.toolCall.imageDataList).toEqual(["img-a", "img-b"]);
  });

  it("finds the tool call on an earlier message when toolUseId is provided", () => {
    // Simulate: tool_use_start on msg1, then a new bubble was created (msg2),
    // then tool_result arrives with toolUseId pointing to msg1's tool call.
    const msg1 = makeAssistantMsg({
      id: "a1",
      ...seg(""),
      toolCalls: [{ id: "tc-early", name: "web_search", input: {} }],
      contentOrder: [{ type: "toolCall", id: "tc-early" }],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
      ...seg("some later text"),
      toolCalls: [{ id: "tc-later", name: "bash", input: {} }],
      contentOrder: [{ type: "toolCall", id: "tc-later" }],
    });
    const result = applyToolResult([userMsg, msg1, msg2], {
      toolUseId: "tc-early",
      result: "search results",
    });

    // msg1's tool call should be completed
    expect(isToolCallCompleted(result[1]!.toolCalls![0]!)).toBe(true);
    expect(result[1]!.toolCalls![0]!.result).toBe("search results");
    // msg2's tool call should remain running
    expect(isToolCallRunning(result[2]!.toolCalls![0]!)).toBe(true);
  });

  it("falls back to last assistant message when toolUseId is not provided", () => {
    const msg1 = makeAssistantMsg({
      id: "a1",
      ...seg(""),
      toolCalls: [{ id: "tc-1", name: "web_search", input: {} }],
    });
    const msg2 = makeAssistantMsg({
      id: "a2",
      ...seg(""),
      toolCalls: [{ id: "tc-2", name: "bash", input: {} }],
    });
    const result = applyToolResult([userMsg, msg1, msg2], {
      result: "done",
    });

    // Without toolUseId, falls back to the last assistant message's last running tool call
    expect(isToolCallRunning(result[1]!.toolCalls![0]!)).toBe(true);
    expect(isToolCallCompleted(result[2]!.toolCalls![0]!)).toBe(true);
  });

  it("falls back to last running tool call when toolUseId does not match any message", () => {
    const msg = makeAssistantMsg({
      toolCalls: [{ id: "tc-1", name: "bash", input: {} }],
    });
    const result = applyToolResult([msg], {
      toolUseId: "nonexistent-id",
      result: "done",
    });

    // Should fall back and complete the last running tool call
    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
  });
});

describe("applyUserMessageEcho", () => {
  it("appends a new id-keyed user row on a passive client", () => {
    /**
     * A client that did not originate the send has no optimistic row, so
     * the echo must materialize the user turn keyed by the server id.
     */
    // GIVEN a conversation with no matching user row
    const prev: DisplayMessage[] = [makeAssistantMsg()];

    // WHEN an echo for a send from another client arrives
    const result = applyUserMessageEcho(prev, {
      text: "from another device",
      messageId: "msg-server-1",
    });

    // THEN a new user row is appended, keyed by the server id
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      id: "msg-server-1",
      role: "user",
      ...seg("from another device"),
      timestamp: result[1]!.timestamp,
    });
  });

  it("stamps the nonce on the appended row when the echo carries one", () => {
    /**
     * On the originating client the optimistic row lives in the overlay, not
     * the snapshot, so the echo appends a fresh snapshot row. That row must
     * carry the nonce so it shares the persisted server row's identity keys —
     * the transcript overlay collapses the retained optimistic copy onto it
     * and the reseed prune correlates on the same keys.
     */
    // GIVEN a snapshot with no matching user row (the optimistic copy is in
    // the overlay)
    const prev: DisplayMessage[] = [makeAssistantMsg()];

    // WHEN the echo arrives with a nonce and a server id
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-n",
      clientMessageId: "nonce-n",
    });

    // THEN the appended row carries both identity keys
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: "msg-server-n",
      clientMessageId: "nonce-n",
      role: "user",
    });
    expect(result[1]!.isOptimistic).toBeUndefined();
  });

  it("appends an optimistic row for a synthetic echo with no messageId", () => {
    /**
     * Surface-action prompts persist no distinct user row, so the echo
     * carries no messageId; the row stays optimistic for reconcile.
     */
    // GIVEN an empty conversation
    const prev: DisplayMessage[] = [];

    // WHEN a synthetic echo (no messageId) arrives
    const result = applyUserMessageEcho(prev, { text: "surface prompt" });

    // THEN an optimistic user row is appended
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    expect(text(result[0]!)).toBe("surface prompt");
    expect(result[0]!.isOptimistic).toBe(true);
  });

  it("upgrades the originating client's optimistic row by clientMessageId", () => {
    /**
     * When the echo beats the 202 response, the originating client still
     * shows its optimistic row; the echo correlates on the nonce it minted
     * and swaps the row to the server id so a later reconcile cannot
     * produce a duplicate.
     */
    // GIVEN an optimistic user row carrying the client nonce
    const prev: DisplayMessage[] = [
      {
        id: "client-uuid",
        clientMessageId: "client-uuid",
        role: "user",
        ...seg("hello"),
        isOptimistic: true,
        timestamp: 1,
      },
    ];

    // WHEN the echo for that send arrives with the nonce and a server id
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-2",
      clientMessageId: "client-uuid",
    });

    // THEN the row is upgraded in place — id swapped, optimistic cleared, no duplicate
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("msg-server-2");
    expect(result[0]!.isOptimistic).toBe(false);
  });

  it("correlates by nonce even when the echoed text differs", () => {
    /**
     * Identity correlation does not depend on text, so a daemon that
     * normalizes (trims, rewrites markdown) the persisted content still
     * folds into the originating optimistic row rather than appending a
     * duplicate.
     */
    // GIVEN an optimistic user row whose nonce the echo carries
    const prev: DisplayMessage[] = [
      {
        id: "nonce-a",
        clientMessageId: "nonce-a",
        role: "user",
        ...seg("  hello  "),
        isOptimistic: true,
        timestamp: 1,
      },
    ];

    // WHEN the echo arrives with normalized text but the same nonce
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-x",
      clientMessageId: "nonce-a",
    });

    // THEN the optimistic row is upgraded in place, not duplicated
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("msg-server-x");
    expect(result[0]!.isOptimistic).toBe(false);
  });

  it("folds the correct row when two sends are in flight", () => {
    /**
     * Two optimistic sends each carry a distinct nonce. The echo for the
     * earlier send must upgrade the earlier row — a recency heuristic would
     * wrongly pick the most recent optimistic row.
     */
    // GIVEN two optimistic user rows with distinct nonces
    const prev: DisplayMessage[] = [
      {
        id: "nonce-1",
        clientMessageId: "nonce-1",
        role: "user",
        ...seg("first"),
        isOptimistic: true,
        timestamp: 1,
      },
      {
        id: "nonce-2",
        clientMessageId: "nonce-2",
        role: "user",
        ...seg("second"),
        isOptimistic: true,
        timestamp: 2,
      },
    ];

    // WHEN the echo for the earlier send arrives
    const result = applyUserMessageEcho(prev, {
      text: "first",
      messageId: "msg-server-first",
      clientMessageId: "nonce-1",
    });

    // THEN only the earlier row is upgraded; the later row stays optimistic
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("msg-server-first");
    expect(result[0]!.isOptimistic).toBe(false);
    expect(result[1]!.id).toBe("nonce-2");
    expect(result[1]!.isOptimistic).toBe(true);
  });

  it("falls back to the most recent optimistic row when the echo carries no nonce", () => {
    /**
     * A daemon that predates the idempotency contract echoes no nonce, so
     * the originating client folds the most recent still-optimistic user
     * row — the single in-flight send in the common case.
     */
    // GIVEN one optimistic user row and no nonce on either side
    const prev: DisplayMessage[] = [
      {
        id: "client-uuid",
        role: "user",
        ...seg("hello"),
        isOptimistic: true,
        timestamp: 1,
      },
    ];

    // WHEN the echo arrives without a clientMessageId
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-legacy",
    });

    // THEN the optimistic row is upgraded in place
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("msg-server-legacy");
    expect(result[0]!.isOptimistic).toBe(false);
  });

  it("clears optimistic queue status when upgrading the originating row", () => {
    /**
     * Regression: the client optimistically marks a send `queued` when it
     * believes a turn is in flight, but the daemon had just gone idle and
     * processes the message directly — emitting only `user_message_echo`,
     * never the `message_queued` / `message_dequeued` pair that would clear
     * the badge. Because the echo swaps the row id, the POST-resolve path's
     * `clearQueueStatus(originalId)` can no longer find the row, so the echo
     * must clear the stale queue status itself or the Queue drawer never
     * closes.
     */
    // GIVEN an optimistic row the client marked queued
    const prev: DisplayMessage[] = [
      {
        id: "client-uuid",
        clientMessageId: "client-uuid",
        role: "user",
        ...seg("queue me"),
        isOptimistic: true,
        queueStatus: "queued",
        queuePosition: 0,
        timestamp: 1,
      },
    ];

    // WHEN the echo for that send arrives (daemon processed it directly)
    const result = applyUserMessageEcho(prev, {
      text: "queue me",
      messageId: "msg-server-q",
      clientMessageId: "client-uuid",
    });

    // THEN the row is upgraded and no longer reads as queued
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("msg-server-q");
    expect(result[0]!.isOptimistic).toBe(false);
    expect(result[0]!.queueStatus).toBeUndefined();
    expect(result[0]!.queuePosition).toBeUndefined();
  });

  it("is a no-op when a row already carries the server id", () => {
    /**
     * A redelivered echo (reconnect/resume) or an already-resolved POST
     * must not append a second copy of the user turn.
     */
    // GIVEN a row already keyed by the server id
    const prev: DisplayMessage[] = [
      { id: "msg-server-3", role: "user", ...seg("hello"), timestamp: 1 },
    ];

    // WHEN a duplicate echo for the same id arrives
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-3",
    });

    // THEN the array is returned unchanged
    expect(result).toBe(prev);
  });

  it("is a no-op when the server id matches a merged alias", () => {
    /**
     * Reconcile can fold the server id into mergedMessageIds; the echo
     * must recognize that alias and not append a duplicate.
     */
    // GIVEN a row whose mergedMessageIds includes the server id
    const prev: DisplayMessage[] = [
      {
        id: "client-uuid",
        role: "user",
        ...seg("hello"),
        mergedMessageIds: ["msg-server-4"],
        timestamp: 1,
      },
    ];

    // WHEN the echo for that id arrives
    const result = applyUserMessageEcho(prev, {
      text: "hello",
      messageId: "msg-server-4",
    });

    // THEN the array is returned unchanged
    expect(result).toBe(prev);
  });
});

// ---------------------------------------------------------------------------
// appendThinkingDelta
// ---------------------------------------------------------------------------

describe("appendThinkingDelta", () => {
  it("opens a thinking bubble when the turn has no assistant row yet", () => {
    // GIVEN a turn that has only the user message (reasoning-heavy models
    // stream their chain of thought before any text delta)
    // WHEN the first thinking delta arrives
    const result = appendThinkingDelta([userMsg], "reason");

    // THEN a new optimistic assistant bubble is opened carrying the thinking
    expect(result).toHaveLength(2);
    const bubble = result[1]!;
    expect(bubble.role).toBe("assistant");
    expect(bubble.thinkingSegments).toEqual(["reason"]);
    expect(bubble.contentOrder).toEqual([{ type: "thinking", id: "0" }]);
  });

  it("coalesces consecutive thinking deltas into one trailing segment", () => {
    // GIVEN an assistant row whose last content entry is thinking
    const start = appendThinkingDelta([userMsg], "Hel", "row-A");
    // WHEN a second thinking delta lands for the same row
    const result = appendThinkingDelta(start, "lo", "row-A");

    // THEN the trailing segment extends rather than opening a new block
    const row = result[1]!;
    expect(row.thinkingSegments).toEqual(["Hello"]);
    expect(row.contentOrder).toEqual([{ type: "thinking", id: "0" }]);
  });

  it("opens a fresh thinking block when reasoning resumes after text", () => {
    // GIVEN an assistant row that has emitted thinking, then text
    const afterThinking = appendThinkingDelta([userMsg], "first", "row-A");
    const afterText = appendTextDelta(afterThinking, "answer", "row-A");

    // WHEN reasoning resumes
    const result = appendThinkingDelta(afterText, "second", "row-A");

    // THEN a new thinking segment + content-order entry is appended after
    // the text, preserving interleaving order
    const row = result[1]!;
    expect(row.thinkingSegments).toEqual(["first", "second"]);
    expect(row.contentOrder).toEqual([
      { type: "thinking", id: "0" },
      { type: "text", id: "0" },
      { type: "thinking", id: "1" },
    ]);
  });

  it("backfills a skipped block instead of clobbering a neighbour when coalescing onto a short projection", () => {
    // GIVEN a reconcile race lands a row whose contentBlocks projection is
    // shorter than its contentOrder — normalizeContentBlocks drops the empty
    // trailing thinking segment, so the only block is the leading text one
    const reserved = makeAssistantMsg({
      id: "row-A",
      textSegments: ["answer"],
      thinkingSegments: [""],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "thinking", id: "0" },
      ],
      contentBlocks: [{ type: "text", text: "answer" }],
    });

    // WHEN a thinking delta coalesces onto that now-populated thinking segment
    const result = appendThinkingDelta([userMsg, reserved], "reason", "row-A");

    // THEN the trailing text block is preserved and the thinking block is
    // backfilled, rather than the text block being overwritten
    const row = result[1]!;
    expect(row.thinkingSegments).toEqual(["reason"]);
    expect(row.contentBlocks).toEqual([
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "reason" },
    ]);
  });

  it("lands deltas on the row keyed by messageId regardless of tail position", () => {
    // GIVEN a reserved assistant row pulled in by a reconcile race ahead of
    // the first delta
    const reserved = makeAssistantMsg({
      id: "row-X",
      textSegments: [],
      contentOrder: [],
    });

    // WHEN a thinking delta arrives stamped with that row's id
    const result = appendThinkingDelta([userMsg, reserved], "think", "row-X");

    // THEN it extends that row rather than opening a duplicate bubble
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-X");
    expect(result[1]!.thinkingSegments).toEqual(["think"]);
  });

  it("does not mutate the original array", () => {
    // GIVEN an existing assistant row
    const prev = appendThinkingDelta([userMsg], "a", "row-A");
    const before = prev[1]!.thinkingSegments;

    // WHEN another delta is applied
    appendThinkingDelta(prev, "b", "row-A");

    // THEN the prior row's segments are untouched
    expect(prev[1]!.thinkingSegments).toBe(before);
    expect(prev[1]!.thinkingSegments).toEqual(["a"]);
  });

  it("seeds the live row from its history twin so a re-attach keeps the persisted thinking prefix", () => {
    // GIVEN this client attaches mid-turn to a reasoning-heavy turn: the live
    // turn holds only the user row, while the daemon already persisted a
    // thinking prefix under the reserved id, now sitting in the history cache.
    const historyTwin = makeAssistantMsg({
      id: "row-B",
      thinkingSegments: ["Reasoning so "],
      textSegments: [],
      contentOrder: [{ type: "thinking", id: "0" }],
      contentBlocks: [{ type: "thinking", thinking: "Reasoning so " }],
    });

    // WHEN the first replayed thinking delta arrives
    const result = appendThinkingDelta([userMsg], "far", "row-B", () => historyTwin);

    // THEN it extends the persisted thinking prefix on the SAME row instead of
    // opening a fresh, prefix-less bubble.
    expect(result).toHaveLength(2);
    expect(result[1]!.id).toBe("row-B");
    expect(result[1]!.thinkingSegments).toEqual(["Reasoning so far"]);
  });
});
