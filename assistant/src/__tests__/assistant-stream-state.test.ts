import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../runtime/assistant-event.js";
import type {
  EventTargeting,
  ReplaySubscriber,
} from "../runtime/assistant-stream-state.js";
import {
  _peekStreamForTesting,
  _resetStreamStateForTesting,
  _simulateRestartForTesting,
  getCurrentSeq,
  getPersistedSeq,
  getReplayWindow,
  recordPersistedSeq,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";

const CONV = "conv_test";

function mkEvent(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  const conversationId =
    "conversationId" in overrides ? overrides.conversationId : CONV;
  return {
    id: `uuid-${Math.random().toString(36).slice(2, 10)}`,
    conversationId,
    emittedAt: new Date().toISOString(),
    message: {
      type: "assistant_text_delta",
      conversationId,
      text: "x",
    },
    ...overrides,
  } as AssistantEvent;
}

describe("assistant-stream-state", () => {
  beforeEach(() => {
    _resetStreamStateForTesting();
  });

  describe("stampAndBuffer", () => {
    test("assigns monotonic seq starting at 1", () => {
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

    test("seq is a single global counter shared across conversations", () => {
      /**
       * All conversations draw from one global seq space, so a reconnect
       * cursor can be a single number rather than a per-conversation map.
       */

      // GIVEN events interleaved across two conversations
      const a = mkEvent({ conversationId: "conv_a" });
      const b = mkEvent({ conversationId: "conv_b" });
      const a2 = mkEvent({ conversationId: "conv_a" });

      // WHEN they are stamped
      stampAndBuffer(a);
      stampAndBuffer(b);
      stampAndBuffer(a2);

      // THEN seq is contiguous across conversations, not reset per conversation
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(a2.seq).toBe(3);
    });

    test("no-op when conversationId is absent (unscoped broadcasts)", () => {
      const event = mkEvent({ conversationId: undefined });
      stampAndBuffer(event);
      expect(event.seq).toBeUndefined();
    });

    test("pushes event onto the ring buffer", () => {
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting();
      expect(peek.ringLength).toBe(2);
      expect(peek.oldestSeq).toBe(1);
      expect(peek.newestSeq).toBe(2);
    });

    test("targeted events are buffered with targeting metadata", () => {
      /** Targeted events stay in the ring so replay can filter them. */

      // GIVEN a targeting modifier
      const targeting: EventTargeting = {
        targetCapability: "host_bash",
      };

      // WHEN a targeted event is stamped
      const targeted = mkEvent();
      stampAndBuffer(targeted, { targeting });

      // THEN it receives a seq and lands in the ring
      expect(targeted.seq).toBe(1);
      const peek = _peekStreamForTesting();
      expect(peek.ringLength).toBe(1);
      expect(peek.oldestSeq).toBe(1);
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
      const peek = _peekStreamForTesting();
      expect(peek.ringLength).toBe(4);
      expect(peek.oldestSeq).toBe(1);
      expect(peek.newestSeq).toBe(4);
    });
  });

  describe("ring buffer eviction", () => {
    test("evicts oldest entries past the 200-event count cap", () => {
      for (let i = 0; i < 250; i++) stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting();
      expect(peek.ringLength).toBe(200);
      // Newest is 250, oldest should be 51 (250 - 200 + 1)
      expect(peek.newestSeq).toBe(250);
      expect(peek.oldestSeq).toBe(51);
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
      const peek = _peekStreamForTesting();
      // 60 * ~8KB = ~480KB pushed; ring must have evicted down under 256KB.
      expect(peek.totalSizeBytes).toBeLessThanOrEqual(256 * 1024);
      expect(peek.ringLength).toBeLessThan(60);
    });

    test("evicts past the 30s age cap", () => {
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

        const peek = _peekStreamForTesting();
        // First event is now > 30s old → evicted. Second + third remain.
        expect(peek.ringLength).toBe(2);
        expect(peek.oldestSeq).toBe(2);
        expect(peek.newestSeq).toBe(3);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("getReplayWindow", () => {
    test("returns events with seq > lastSeenSeq in order", () => {
      const events = Array.from({ length: 5 }, () => mkEvent());
      events.forEach((e) => stampAndBuffer(e));
      const replay = getReplayWindow(2);
      expect(replay).not.toBeNull();
      expect(replay!.map((e) => e.seq)).toEqual([3, 4, 5]);
    });

    test("returns empty array when lastSeenSeq is current (nothing to replay)", () => {
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent());
      const replay = getReplayWindow(2);
      expect(replay).toEqual([]);
    });

    test("returns null when lastSeenSeq is older than oldest buffered entry", () => {
      // Force eviction by pushing past the count cap.
      for (let i = 0; i < 250; i++) stampAndBuffer(mkEvent());
      const peek = _peekStreamForTesting();
      expect(peek.oldestSeq).toBe(51);
      // Client claims to have last seen seq=10 — that's far below oldest.
      const replay = getReplayWindow(10);
      expect(replay).toBeNull();
    });

    test("returns empty array when the ring is empty", () => {
      const replay = getReplayWindow(0);
      expect(replay).toEqual([]);
    });

    test("lastSeenSeq exactly one below oldest is a valid replay (no snapshot needed)", () => {
      stampAndBuffer(mkEvent()); // seq 1
      stampAndBuffer(mkEvent()); // seq 2
      stampAndBuffer(mkEvent()); // seq 3
      // Client saw nothing → lastSeenSeq=0, oldest=1, replay [1,2,3].
      const replay = getReplayWindow(0);
      expect(replay).not.toBeNull();
      expect(replay!.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    test("evicts age-expired entries at read time on an idle stream", () => {
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
        const replay = getReplayWindow(0);

        // Both events were past their TTL, so eviction drains the ring
        // and the call returns [] (no replay possible, no snapshot needed
        // either -- client claims they saw nothing and there is nothing
        // left).
        expect(replay).toEqual([]);
        expect(_peekStreamForTesting().ringLength).toBe(0);
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
        const peek = _peekStreamForTesting();
        expect(peek.ringLength).toBe(1);
        expect(peek.oldestSeq).toBe(3);

        // Client reconnects claiming lastSeenSeq=1. Oldest buffered is
        // 3, so 1 < 3 - 1 = 2 -> snapshot fallback (null).
        const replay = getReplayWindow(1);
        expect(replay).toBeNull();
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe("getReplayWindow — conversation filter", () => {
    test("restricts replay to a single conversation when conversationId is given", () => {
      /**
       * A scoped subscription only delivers its own conversation live, so
       * replay must not push other conversations' buffered events.
       */

      // GIVEN events interleaved across two conversations in the global ring
      stampAndBuffer(mkEvent({ conversationId: "conv_a" })); // seq 1
      stampAndBuffer(mkEvent({ conversationId: "conv_b" })); // seq 2
      stampAndBuffer(mkEvent({ conversationId: "conv_a" })); // seq 3
      stampAndBuffer(mkEvent({ conversationId: "conv_b" })); // seq 4

      // WHEN replay is scoped to conv_a
      const replay = getReplayWindow(0, undefined, "conv_a");

      // THEN only conv_a's events return, still in global seq order
      expect(replay!.map((e) => e.seq)).toEqual([1, 3]);
    });

    test("unfiltered replay returns every conversation's events in seq order", () => {
      /** The unfiltered (assistant-wide) stream resumes the whole ring. */

      // GIVEN events across two conversations
      stampAndBuffer(mkEvent({ conversationId: "conv_a" })); // seq 1
      stampAndBuffer(mkEvent({ conversationId: "conv_b" })); // seq 2
      stampAndBuffer(mkEvent({ conversationId: "conv_a" })); // seq 3

      // WHEN replay is requested without a conversation filter
      const replay = getReplayWindow(0);

      // THEN all events return in one contiguous global seq order
      expect(replay!.map((e) => e.seq)).toEqual([1, 2, 3]);
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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const procReplay = getReplayWindow(0, PROCESS_SUB);

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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const procReplay = getReplayWindow(0, PROCESS_SUB);

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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const extReplay = getReplayWindow(0, CHROME_EXT_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);

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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const procReplay = getReplayWindow(0, PROCESS_SUB);

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
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const macReplay = getReplayWindow(0, MACOS_CLIENT);

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
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const procReplay = getReplayWindow(0, PROCESS_SUB);

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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);
      const procReplay = getReplayWindow(0, PROCESS_SUB);

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
      const macReplay = getReplayWindow(0, MACOS_CLIENT);
      const webReplay = getReplayWindow(0, WEB_CLIENT);

      // THEN macOS sees all four; web sees 1 + 4 (not 2=no capability, not 3=excluded)
      expect(macReplay!.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(webReplay!.map((e) => e.seq)).toEqual([1, 4]);
    });

    test("no subscriber argument returns all entries unfiltered", () => {
      /** Omitting subscriber skips targeting filtering. */

      // GIVEN targeted and untargeted events
      stampAndBuffer(mkEvent());
      stampAndBuffer(mkEvent(), {
        targeting: { targetCapability: "host_bash" },
      });

      // WHEN replay is requested without a subscriber
      const replay = getReplayWindow(0);

      // THEN all events are returned
      expect(replay!.map((e) => e.seq)).toEqual([1, 2]);
    });

    test("subscriber and conversation filters compose", () => {
      /**
       * When both filters are supplied, an entry must satisfy targeting
       * AND belong to the requested conversation.
       */

      // GIVEN bash-targeted events across two conversations
      stampAndBuffer(mkEvent({ conversationId: "conv_a" }), {
        targeting: { targetCapability: "host_bash" },
      }); // seq 1
      stampAndBuffer(mkEvent({ conversationId: "conv_b" }), {
        targeting: { targetCapability: "host_bash" },
      }); // seq 2
      stampAndBuffer(mkEvent({ conversationId: "conv_a" })); // seq 3 untargeted

      // WHEN a web client (no host_bash) replays scoped to conv_a
      const webReplay = getReplayWindow(0, WEB_CLIENT, "conv_a");
      // AND macOS replays scoped to conv_a
      const macReplay = getReplayWindow(0, MACOS_CLIENT, "conv_a");

      // THEN web sees only conv_a's untargeted event; macOS sees both conv_a entries
      expect(webReplay!.map((e) => e.seq)).toEqual([3]);
      expect(macReplay!.map((e) => e.seq)).toEqual([1, 3]);
    });
  });

  describe("getCurrentSeq", () => {
    test("is 0 before anything is stamped", () => {
      expect(getCurrentSeq()).toBe(0);
    });

    test("reports the seq just assigned by stampAndBuffer", () => {
      const a = mkEvent();
      stampAndBuffer(a);
      expect(a.seq).toBe(1);
      expect(getCurrentSeq()).toBe(1);

      const b = mkEvent();
      stampAndBuffer(b);
      expect(b.seq).toBe(2);
      expect(getCurrentSeq()).toBe(2);
    });

    test("unscoped (unstamped) events do not advance it", () => {
      stampAndBuffer(mkEvent());
      // An event with no conversationId is never stamped.
      stampAndBuffer(mkEvent({ conversationId: undefined }));
      expect(getCurrentSeq()).toBe(1);
    });
  });

  describe("persisted seq", () => {
    test("getPersistedSeq is null for an unknown conversation", () => {
      expect(getPersistedSeq("conv_unknown")).toBeNull();
    });

    test("records and retrieves a per-conversation value", () => {
      recordPersistedSeq("conv_a", 7);
      expect(getPersistedSeq("conv_a")).toBe(7);
      expect(getPersistedSeq("conv_b")).toBeNull();
    });

    test("tracks conversations independently", () => {
      recordPersistedSeq("conv_a", 3);
      recordPersistedSeq("conv_b", 9);
      expect(getPersistedSeq("conv_a")).toBe(3);
      expect(getPersistedSeq("conv_b")).toBe(9);
    });

    test("advances monotonically and never regresses", () => {
      recordPersistedSeq("conv_a", 5);
      recordPersistedSeq("conv_a", 12);
      expect(getPersistedSeq("conv_a")).toBe(12);

      // A lower seq (e.g. an out-of-order async commit) is clamped.
      recordPersistedSeq("conv_a", 8);
      expect(getPersistedSeq("conv_a")).toBe(12);
    });

    test("ignores non-positive and non-finite seq values", () => {
      recordPersistedSeq("conv_a", 0);
      recordPersistedSeq("conv_a", -3);
      recordPersistedSeq("conv_a", Number.NaN);
      recordPersistedSeq("conv_a", Number.POSITIVE_INFINITY);
      expect(getPersistedSeq("conv_a")).toBeNull();
    });

    test("is cleared by reset", () => {
      recordPersistedSeq("conv_a", 4);
      _resetStreamStateForTesting();
      expect(getPersistedSeq("conv_a")).toBeNull();
    });

    test("evicts the least-recently-recorded conversation past the cap", () => {
      // The map is LRU-bounded at 1024 conversations. Fill to the cap,
      // then one more insert evicts the oldest key.
      const CAP = 1024;
      for (let i = 0; i < CAP; i++) {
        recordPersistedSeq(`conv_${i}`, i + 1);
      }
      // All present at the cap.
      expect(getPersistedSeq("conv_0")).toBe(1);
      expect(getPersistedSeq(`conv_${CAP - 1}`)).toBe(CAP);

      // One more distinct conversation evicts the oldest (conv_0).
      recordPersistedSeq("conv_overflow", 9999);
      expect(getPersistedSeq("conv_0")).toBeNull();
      expect(getPersistedSeq("conv_1")).toBe(2);
      expect(getPersistedSeq("conv_overflow")).toBe(9999);
    });

    test("re-recording refreshes recency so a kept key is not evicted first", () => {
      const CAP = 1024;
      for (let i = 0; i < CAP; i++) {
        recordPersistedSeq(`conv_${i}`, i + 1);
      }
      // Touch the oldest key so it moves to the most-recent end.
      recordPersistedSeq("conv_0", 5000);

      // The next insert now evicts conv_1 (the new oldest), not conv_0.
      recordPersistedSeq("conv_overflow", 9999);
      expect(getPersistedSeq("conv_0")).toBe(5000);
      expect(getPersistedSeq("conv_1")).toBeNull();
    });
  });

  describe("seq persistence across restarts", () => {
    test("counter resumes above the persisted reservation after a restart", () => {
      // GIVEN a process that stamped events (reserving a seq block on disk)
      const a = mkEvent();
      stampAndBuffer(a);
      expect(a.seq).toBe(1);

      // WHEN the daemon restarts
      _simulateRestartForTesting();

      // THEN the next stamp resumes above the reserved block instead of 1,
      // so clients never observe the counter moving backwards.
      const b = mkEvent();
      stampAndBuffer(b);
      expect(b.seq).toBe(1025);
    });

    test("repeated restarts keep advancing monotonically", () => {
      stampAndBuffer(mkEvent());
      _simulateRestartForTesting();
      const a = mkEvent();
      stampAndBuffer(a);
      _simulateRestartForTesting();
      const b = mkEvent();
      stampAndBuffer(b);
      expect(a.seq).toBe(1025);
      expect(b.seq).toBe(2049);
    });

    test("stamping within a reserved block does not advance the persisted ceiling", () => {
      // GIVEN many stamps within one block
      for (let i = 0; i < 100; i++) stampAndBuffer(mkEvent());

      // WHEN the daemon restarts
      _simulateRestartForTesting();

      // THEN the resume point is the block ceiling, not per-event state.
      const a = mkEvent();
      stampAndBuffer(a);
      expect(a.seq).toBe(1025);
    });

    test("a corrupt reservation file degrades to a cold start", () => {
      const path = join(
        process.env.VELLUM_WORKSPACE_DIR!,
        "data",
        "stream-seq.json",
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "not json");

      _simulateRestartForTesting();
      const a = mkEvent();
      stampAndBuffer(a);
      expect(a.seq).toBe(1);
    });

    test("a pre-restart cursor replays the post-restart events (reservation gap is not an eviction)", () => {
      // GIVEN a client that saw seq 1 before the daemon restarted
      stampAndBuffer(mkEvent());
      _simulateRestartForTesting();

      // AND the restarted daemon has buffered new events
      const a = mkEvent();
      const b = mkEvent();
      stampAndBuffer(a);
      stampAndBuffer(b);
      expect(a.seq).toBe(1025);

      // WHEN the client reconnects with its pre-restart cursor
      const window = getReplayWindow(1);

      // THEN the post-restart events are replayed rather than treated as
      // an out-of-window gap (no events below the reservation ever existed
      // in this process, so nothing replayable is missing).
      expect(window).not.toBeNull();
      expect(window?.map((e) => e.seq)).toEqual([1025, 1026]);
    });

    test("a pre-restart cursor still gets the snapshot fallback once post-restart events evict", () => {
      stampAndBuffer(mkEvent());
      _simulateRestartForTesting();

      // Stamp past the 200-event ring cap so the restarted process's
      // earliest events are genuinely evicted.
      for (let i = 0; i < 205; i++) stampAndBuffer(mkEvent());

      // The gap now includes evicted post-restart events, so replay must
      // signal the snapshot fallback.
      expect(getReplayWindow(1)).toBeNull();
    });

    test("a missing reservation file is a cold start at 1", () => {
      rmSync(
        join(process.env.VELLUM_WORKSPACE_DIR!, "data", "stream-seq.json"),
        { force: true },
      );
      _simulateRestartForTesting();
      const a = mkEvent();
      stampAndBuffer(a);
      expect(a.seq).toBe(1);
    });
  });
});
