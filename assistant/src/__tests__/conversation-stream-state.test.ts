import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  _peekStreamForTesting,
  _resetConversationStreamsForTesting,
  clearConversationStream,
  getReplayWindow,
  stampAndBuffer,
} from "../runtime/conversation-stream-state.js";

const CONV = "conv_test";

function mkEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    id: `uuid-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: CONV,
    emittedAt: new Date().toISOString(),
    message: { type: "assistant_text_delta", conversationId: CONV, text: "x" },
    ...overrides,
  } as AssistantEvent;
}

describe("conversation-stream-state", () => {
  beforeEach(() => {
    _resetConversationStreamsForTesting();
  });

  describe("stampAndBuffer", () => {
    test("assigns monotonic seq starting at 1 per conversation", () => {
      const a = mkEvent();
      const b = mkEvent();
      const c = mkEvent();
      stampAndBuffer(a);
      stampAndBuffer(b);
      stampAndBuffer(c);
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(c.seq).toBe(3);
    });

    test("seq is per-conversation, not global", () => {
      const a = mkEvent({ conversationId: "conv_a" });
      const b = mkEvent({ conversationId: "conv_b" });
      const a2 = mkEvent({ conversationId: "conv_a" });
      stampAndBuffer(a);
      stampAndBuffer(b);
      stampAndBuffer(a2);
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(1); // independent counter
      expect(a2.seq).toBe(2);
    });

    test("no-op when conversationId is absent (unscoped broadcasts)", () => {
      const event = mkEvent({ conversationId: undefined });
      stampAndBuffer(event);
      expect(event.seq).toBeUndefined();
    });

    test("pushes event onto ring buffer", () => {
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.ringLength).toBe(2);
      expect(peek?.oldestSeq).toBe(1);
      expect(peek?.newestSeq).toBe(2);
    });

    test("replayable: false stamps seq but skips ring push", () => {
      const targeted = mkEvent();
      stampAndBuffer(targeted, { replayable: false });
      expect(targeted.seq).toBe(1); // still stamped for wire-side ordering
      const peek = _peekStreamForTesting(CONV);
      // State exists (we created it to assign seq) but ring is empty.
      expect(peek?.nextSeq).toBe(2);
      expect(peek?.ringLength).toBe(0);
    });

    test("seq stays monotonic across mixed replayable/non-replayable events", () => {
      const a = mkEvent();
      const b = mkEvent();
      const c = mkEvent();
      const d = mkEvent();
      stampAndBuffer(a); // replayable
      stampAndBuffer(b, { replayable: false }); // targeted -- skipped
      stampAndBuffer(c); // replayable
      stampAndBuffer(d, { replayable: false }); // targeted -- skipped
      expect([a.seq, b.seq, c.seq, d.seq]).toEqual([1, 2, 3, 4]);
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.ringLength).toBe(2); // only a + c in buffer
      expect(peek?.oldestSeq).toBe(1);
      expect(peek?.newestSeq).toBe(3);
    });
  });

  describe("ring buffer eviction", () => {
    test("evicts oldest entries past the 200-event count cap", () => {
      for (let i = 0; i < 250; i++) stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.ringLength).toBe(200);
      // Newest is 250, oldest should be 51 (250 - 200 + 1)
      expect(peek?.newestSeq).toBe(250);
      expect(peek?.oldestSeq).toBe(51);
    });

    test("evicts past the 256 KB size cap", () => {
      // Each event with a large text payload pushes past the limit fast.
      const bigText = "x".repeat(8 * 1024); // 8 KB per event
      for (let i = 0; i < 60; i++) {
        stampAndBuffer(
          mkEvent({
            message: {
              type: "assistant_text_delta",
              conversationId: CONV,
              text: bigText,
            },
          }),
        );
      }
      const peek = _peekStreamForTesting(CONV);
      expect(peek).not.toBeNull();
      // 60 * ~8KB = ~480KB pushed; ring must have evicted down under 256KB.
      expect(peek!.totalSizeBytes).toBeLessThanOrEqual(256 * 1024);
      expect(peek!.ringLength).toBeLessThan(60);
    });

    test("evicts past the 30s age cap", async () => {
      const originalNow = Date.now;
      let fakeNow = 1_000_000;
      Date.now = () => fakeNow;
      try {
        stampAndBuffer(mkEvent()); // emittedAt = 1_000_000
        fakeNow = 1_000_000 + 10_000;
        stampAndBuffer(mkEvent()); // emittedAt = 1_010_000

        // Jump 31s past the first event but keep within window of second.
        fakeNow = 1_000_000 + 31_000;
        stampAndBuffer(mkEvent()); // triggers eviction sweep on push

        const peek = _peekStreamForTesting(CONV);
        // First event is now > 30s old → evicted. Second + third remain.
        expect(peek?.ringLength).toBe(2);
        expect(peek?.oldestSeq).toBe(2);
        expect(peek?.newestSeq).toBe(3);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("getReplayWindow", () => {
    test("returns events with seq > lastSeenSeq in order", () => {
      const events = Array.from({ length: 5 }, () => mkEvent());
      events.forEach((e) => stampAndBuffer(e));
      const replay = getReplayWindow(CONV, 2);
      expect(replay).not.toBeNull();
      expect(replay!.map((e) => e.seq)).toEqual([3, 4, 5]);
    });

    test("returns empty array when lastSeenSeq is current (nothing to replay)", () => {
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());
      const replay = getReplayWindow(CONV, 2);
      expect(replay).toEqual([]);
    });

    test("returns null when lastSeenSeq is older than oldest buffered entry", () => {
      // Force eviction by pushing past the count cap.
      for (let i = 0; i < 250; i++) stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.oldestSeq).toBe(51);
      // Client claims to have last seen seq=10 — that's far below oldest.
      const replay = getReplayWindow(CONV, 10);
      expect(replay).toBeNull();
    });

    test("returns empty array for a conversation with no stream state", () => {
      const replay = getReplayWindow("conv_never_streamed", 0);
      expect(replay).toEqual([]);
    });

    test("lastSeenSeq exactly one below oldest is a valid replay (no snapshot needed)", () => {
      stampAndBuffer(mkEvent()); // seq 1
      stampAndBuffer(mkEvent()); // seq 2
      stampAndBuffer(mkEvent()); // seq 3
      // Client saw nothing → lastSeenSeq=0, oldest=1, replay [1,2,3].
      const replay = getReplayWindow(CONV, 0);
      expect(replay).not.toBeNull();
      expect(replay!.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    test("evicts age-expired entries at read time on idle stream", () => {
      const originalNow = Date.now;
      let fakeNow = 5_000_000;
      Date.now = () => fakeNow;
      try {
        stampAndBuffer(mkEvent()); // seq 1, emitted at 5_000_000
        stampAndBuffer(mkEvent()); // seq 2, emitted at 5_000_000

        // No further stampAndBuffer calls. Stream goes idle. Advance
        // clock past the 30s age cap.
        fakeNow = 5_000_000 + 60_000;

        // Eviction has not run since the last write -- the buffer still
        // physically holds [1, 2]. getReplayWindow must sweep first.
        const replay = getReplayWindow(CONV, 0);

        // Both events were past their TTL, so eviction drains the ring
        // and the call returns [] (no replay possible, no snapshot
        // needed either -- client claims they saw nothing and there is
        // nothing left).
        expect(replay).toEqual([]);
        // State entry is dropped after the drain.
        expect(_peekStreamForTesting(CONV)).toBeNull();
      } finally {
        Date.now = originalNow;
      }
    });

    test("read-time eviction preserves the snapshot fallback signal", () => {
      const originalNow = Date.now;
      let fakeNow = 6_000_000;
      Date.now = () => fakeNow;
      try {
        stampAndBuffer(mkEvent()); // seq 1
        stampAndBuffer(mkEvent()); // seq 2

        // 40s pass. Both entries are over the age cap.
        fakeNow = 6_000_000 + 40_000;

        // Now a fresh event lands -- ring contains only seq 3.
        stampAndBuffer(mkEvent()); // seq 3
        // After this write, evict() already ran and dropped the stale
        // entries from the write path. Verify that.
        const peek = _peekStreamForTesting(CONV);
        expect(peek?.ringLength).toBe(1);
        expect(peek?.oldestSeq).toBe(3);

        // Client reconnects claiming lastSeenSeq=1. Oldest buffered is
        // 3, so 1 < 3 - 1 = 2 -> snapshot fallback (null).
        const replay = getReplayWindow(CONV, 1);
        expect(replay).toBeNull();
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("clearConversationStream", () => {
    test("drops all state for the conversation", () => {
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());
      expect(_peekStreamForTesting(CONV)).not.toBeNull();

      clearConversationStream(CONV);

      expect(_peekStreamForTesting(CONV)).toBeNull();
      // Subsequent emit starts seq fresh at 1.
      const event = mkEvent();
      stampAndBuffer(event);
      expect(event.seq).toBe(1);
    });
  });
});
