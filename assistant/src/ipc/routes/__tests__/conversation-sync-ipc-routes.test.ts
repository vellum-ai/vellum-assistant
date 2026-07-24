/**
 * The daemon-side handler for the worker → daemon conversation-persist
 * hand-off. Workers persist a turn's rows then ask the daemon (the sole seq
 * authority) to record the honest snapshot anchor and republish the
 * messages-changed invalidation to real subscribers.
 *
 * `recordConversationPersistedSeq` and `publishConversationMessagesChanged`
 * are stubbed to capture calls (their own behavior is covered in their own
 * suites); the seq authority (`assistant-stream-state`) and the in-flight-turn
 * registry are exercised for real so the anchor the handler records is a
 * genuine `getCurrentSeq()` — capped at a streaming turn's flushed-content
 * watermark when one is in flight for the conversation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const recordCalls: Array<[string, number]> = [];
const publishCalls: string[] = [];

mock.module("../../../persistence/conversation-crud.js", () => ({
  recordConversationPersistedSeq: (id: string, seq: number) => {
    recordCalls.push([id, seq]);
  },
}));

mock.module("../../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: (id: string) => {
    publishCalls.push(id);
  },
}));

import type { EventHandlerState } from "../../../daemon/conversation-agent-loop-handlers.js";
import { DB_MIGRATION_READINESS_EXEMPT_OPERATIONS } from "../../../daemon/daemon-readiness.js";
import {
  registerInflightTurn,
  unregisterInflightTurn,
} from "../../../daemon/inflight-turn-registry.js";
import type { AssistantEvent } from "../../../runtime/assistant-event.js";
import {
  _resetStreamStateForTesting,
  stampAndBuffer,
} from "../../../runtime/assistant-stream-state.js";
import { NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD } from "../../../runtime/sync/worker-daemon-notify.js";
import {
  CONVERSATION_SYNC_IPC_METHODS,
  handleNotifyConversationPersisted,
} from "../conversation-sync-ipc-routes.js";

function stampEvent(): void {
  stampAndBuffer({
    conversationId: "conv-x",
    message: { type: "assistant_text_delta", text: "x" },
  } as unknown as AssistantEvent);
}

describe("conversation-sync IPC route", () => {
  beforeEach(() => {
    recordCalls.length = 0;
    publishCalls.length = 0;
    _resetStreamStateForTesting();
  });

  test("records the anchor at the daemon's current seq when no turn is streaming the conversation", () => {
    // Advance the daemon's real seq counter so the recorded anchor is a
    // concrete, non-zero daemon-issued position — never above what it has served.
    stampEvent();
    stampEvent();
    stampEvent(); // getCurrentSeq() === 3

    const result = handleNotifyConversationPersisted({
      body: { conversationId: "conv-1" },
    });

    expect(result).toEqual({ ok: true });
    expect(recordCalls).toEqual([["conv-1", 3]]);
    expect(publishCalls).toEqual(["conv-1"]);
  });

  test("caps the anchor at the streaming turn's flushed-content seq, below the live counter", () => {
    stampEvent();
    stampEvent();
    stampEvent(); // getCurrentSeq() === 3

    // A daemon turn is streaming into conv-1 but has committed a flush only
    // through seq 2 — the live counter (3) is ahead of the durable rows.
    const state = {
      flushedContentSeq: 2,
    } as unknown as EventHandlerState;
    registerInflightTurn("conv-1", state);
    try {
      const result = handleNotifyConversationPersisted({
        body: { conversationId: "conv-1" },
      });

      expect(result).toEqual({ ok: true });
      // Anchored at the flushed watermark (2), NOT the live counter (3), so the
      // snapshot never claims the in-flight delta at seq 3.
      expect(recordCalls).toEqual([["conv-1", 2]]);
      expect(publishCalls).toEqual(["conv-1"]);
    } finally {
      unregisterInflightTurn("conv-1", state);
    }
  });

  test("holds the anchor at the committed flush watermark when the live streamed seq has raced ahead", () => {
    stampEvent();
    stampEvent();
    stampEvent();
    stampEvent(); // getCurrentSeq() === 4

    // The exact P1 window: the turn emitted a delta at seq 4 (stamped onto the
    // live streamed position the instant it was emitted) but that delta's flush
    // has not committed — the durable rows hold only through seq 2. The persist
    // notification must anchor at the committed watermark, never the live emit
    // position, or the client discards the seq-4 delta as an already-covered
    // replay and the streamed text vanishes.
    const state = {
      lastStreamedContentSeq: 4,
      flushedContentSeq: 2,
    } as unknown as EventHandlerState;
    registerInflightTurn("conv-1", state);
    try {
      handleNotifyConversationPersisted({ body: { conversationId: "conv-1" } });

      // Anchored at the durable watermark (2), NOT the un-flushed live seq (4).
      expect(recordCalls).toEqual([["conv-1", 2]]);
      expect(publishCalls).toEqual(["conv-1"]);
    } finally {
      unregisterInflightTurn("conv-1", state);
    }
  });

  test("records 0 (a raise-only no-op) when a streaming turn has flushed no content yet", () => {
    stampEvent(); // getCurrentSeq() === 1

    // A turn is streaming but has committed no flush, so its watermark is
    // undefined; the ceiling is 0, capping the anchor below the un-flushed seq.
    const state = {
      flushedContentSeq: undefined,
    } as unknown as EventHandlerState;
    registerInflightTurn("conv-1", state);
    try {
      handleNotifyConversationPersisted({ body: { conversationId: "conv-1" } });

      // The handler passes 0; `recordConversationPersistedSeq` ignores it and
      // leaves the existing anchor intact (the live seq 1 is never advertised).
      expect(recordCalls).toEqual([["conv-1", 0]]);
      expect(publishCalls).toEqual(["conv-1"]);
    } finally {
      unregisterInflightTurn("conv-1", state);
    }
  });

  test("rejects a payload without a conversationId", () => {
    expect(() => handleNotifyConversationPersisted({ body: {} })).toThrow();
    expect(recordCalls).toEqual([]);
    expect(publishCalls).toEqual([]);
  });

  test("is reachable on the IPC surface under the shared method name", () => {
    expect(
      typeof CONVERSATION_SYNC_IPC_METHODS[
        NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD
      ],
    ).toBe("function");
  });

  test("is DB-migration readiness gated (absent from the exempt set)", () => {
    // The IPC server gates every non-exempt method on migration readiness, so
    // the handler's DB touch (`recordConversationPersistedSeq`) never runs
    // against a partially-migrated schema.
    expect(
      DB_MIGRATION_READINESS_EXEMPT_OPERATIONS.has(
        NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD,
      ),
    ).toBe(false);
  });
});
