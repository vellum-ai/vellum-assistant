import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import type {
  EventTargeting,
  ReplaySubscriber,
} from "../runtime/conversation-stream-state.js";
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

    test("targeted events are buffered with targeting metadata", () => {
      /** Targeted events now stay in the ring so replay can filter them. */

      // GIVEN a targeting modifier
      const targeting: EventTargeting = {
        targetCapability: "host_bash",
      };

      // WHEN a targeted event is stamped
      const targeted = mkEvent();
      stampAndBuffer(targeted, { targeting });

      // THEN it receives a seq and lands in the ring
      expect(targeted.seq).toBe(1);
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.ringLength).toBe(1);
      expect(peek?.oldestSeq).toBe(1);
    });

    test("seq stays monotonic across targeted and untargeted events", () => {
      /** All events share a contiguous seq counter regardless of targeting. */

      // GIVEN a mix of untargeted and targeted events
      const a = mkEvent();
      const b = mkEvent();
      const c = mkEvent();
      const d = mkEvent();

      // WHEN they are stamped
      stampAndBuffer(a);
      stampAndBuffer(b, { targeting: { targetCapability: "host_bash" } });
      stampAndBuffer(c);
      stampAndBuffer(d, { targeting: { excludeClientId: "client-1" } });

      // THEN seqs are monotonic and all four are buffered
      expect([a.seq, b.seq, c.seq, d.seq]).toEqual([1, 2, 3, 4]);
      const peek = _peekStreamForTesting(CONV);
      expect(peek?.ringLength).toBe(4);
      expect(peek?.oldestSeq).toBe(1);
      expect(peek?.newestSeq).toBe(4);
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

  describe("getReplayWindow — targeting filter", () => {
    const MACOS_CLIENT: ReplaySubscriber = {
      type: "client",
      clientId: "mac-1",
      interfaceId: "macos",
      capabilities: ["host_bash", "host_file", "host_cu", "host_browser"],
    };

    const WEB_CLIENT: ReplaySubscriber = {
      type: "client",
      clientId: "web-1",
      interfaceId: "web",
      capabilities: [],
    };

    const CHROME_EXT_CLIENT: ReplaySubscriber = {
      type: "client",
      clientId: "ext-1",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
    };

    const PROCESS_SUB: ReplaySubscriber = { type: "process" };

    test("untargeted events are replayed to all subscriber types", () => {
      /** Events without targeting metadata go to everyone. */

      // GIVEN two untargeted events in the ring
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());

      // WHEN each subscriber type requests replay
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const procReplay = getReplayWindow(CONV, 0, PROCESS_SUB);

      // THEN all see both events
      expect(macReplay!.map((e) => e.seq)).toEqual([1, 2]);
      expect(webReplay!.map((e) => e.seq)).toEqual([1, 2]);
      expect(procReplay!.map((e) => e.seq)).toEqual([1, 2]);
    });

    test("capability-targeted events only replay to subscribers with that capability", () => {
      /** host_bash events should only reach macOS, not web or process. */

      // GIVEN an untargeted event and a host_bash-targeted event
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent(), {
        targeting: { targetCapability: "host_bash" },
      });

      // WHEN each subscriber requests replay
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const procReplay = getReplayWindow(CONV, 0, PROCESS_SUB);

      // THEN macOS sees both; web and process see only the untargeted event
      expect(macReplay!.map((e) => e.seq)).toEqual([1, 2]);
      expect(webReplay!.map((e) => e.seq)).toEqual([1]);
      expect(procReplay!.map((e) => e.seq)).toEqual([1]);
    });

    test("host_browser capability targets both macOS and chrome-extension", () => {
      /** Both interfaces declare host_browser. */

      // GIVEN a host_browser-targeted event
      stampAndBuffer(mkEvent(), {
        targeting: { targetCapability: "host_browser" },
      });

      // WHEN macOS and chrome-extension request replay
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const extReplay = getReplayWindow(CONV, 0, CHROME_EXT_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);

      // THEN both capable clients see it; web does not
      expect(macReplay!.map((e) => e.seq)).toEqual([1]);
      expect(extReplay!.map((e) => e.seq)).toEqual([1]);
      expect(webReplay).toEqual([]);
    });

    test("client-targeted events only replay to the named client", () => {
      /** targetClientId narrows delivery to a single subscriber. */

      // GIVEN an event targeted to mac-1
      stampAndBuffer(mkEvent(), {
        targeting: { targetClientId: "mac-1" },
      });

      // WHEN different clients request replay
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const procReplay = getReplayWindow(CONV, 0, PROCESS_SUB);

      // THEN only the named client receives it
      expect(macReplay!.map((e) => e.seq)).toEqual([1]);
      expect(webReplay).toEqual([]);
      expect(procReplay).toEqual([]);
    });

    test("client + capability targeting requires both to match", () => {
      /**
       * targetClientId + targetCapability: the client must match by ID
       * AND have the required capability.
       */

      // GIVEN an event targeted to web-1 with host_bash capability
      stampAndBuffer(mkEvent(), {
        targeting: { targetClientId: "web-1", targetCapability: "host_bash" },
      });

      // WHEN the named client (without the capability) and macOS request replay
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);

      // THEN neither receives it — web-1 lacks the capability, mac-1 isn't the target
      expect(webReplay).toEqual([]);
      expect(macReplay).toEqual([]);
    });

    test("excludeClientId suppresses replay for the originating client", () => {
      /** Self-echo suppression on replay. */

      // GIVEN an event excluding web-1
      stampAndBuffer(mkEvent(), {
        targeting: { excludeClientId: "web-1" },
      });

      // WHEN web-1 and mac-1 request replay
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const procReplay = getReplayWindow(CONV, 0, PROCESS_SUB);

      // THEN web-1 is suppressed; mac-1 and process subscribers see it
      expect(webReplay).toEqual([]);
      expect(macReplay!.map((e) => e.seq)).toEqual([1]);
      expect(procReplay!.map((e) => e.seq)).toEqual([1]);
    });

    test("interface-targeted events only replay to clients of that interface", () => {
      /** targetInterfaceId narrows delivery to a specific interface. */

      // GIVEN an event targeted to the macos interface
      stampAndBuffer(mkEvent(), {
        targeting: { targetInterfaceId: "macos" },
      });

      // WHEN different subscribers request replay
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);
      const procReplay = getReplayWindow(CONV, 0, PROCESS_SUB);

      // THEN only the macos client receives it
      expect(macReplay!.map((e) => e.seq)).toEqual([1]);
      expect(webReplay).toEqual([]);
      expect(procReplay).toEqual([]);
    });

    test("mixed targeting across events filters per-entry", () => {
      /**
       * A ring with untargeted, capability-targeted, and excluded events
       * filters each entry independently.
       */

      // GIVEN a mix of events
      stampAndBuffer(mkEvent()); // seq 1: untargeted
      stampAndBuffer(mkEvent(), {
        targeting: { targetCapability: "host_bash" },
      }); // seq 2: bash-targeted
      stampAndBuffer(mkEvent(), {
        targeting: { excludeClientId: "web-1" },
      }); // seq 3: exclude web-1
      stampAndBuffer(mkEvent()); // seq 4: untargeted

      // WHEN each subscriber requests replay from seq 0
      const macReplay = getReplayWindow(CONV, 0, MACOS_CLIENT);
      const webReplay = getReplayWindow(CONV, 0, WEB_CLIENT);

      // THEN macOS sees all four; web sees 1 + 4 (not 2=no capability, not 3=excluded)
      expect(macReplay!.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(webReplay!.map((e) => e.seq)).toEqual([1, 4]);
    });

    test("no subscriber argument returns all entries unfiltered", () => {
      /** Backwards-compatible: omitting subscriber skips filtering. */

      // GIVEN targeted and untargeted events
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent(), {
        targeting: { targetCapability: "host_bash" },
      });

      // WHEN replay is requested without a subscriber
      const replay = getReplayWindow(CONV, 0);

      // THEN all events are returned
      expect(replay!.map((e) => e.seq)).toEqual([1, 2]);
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
