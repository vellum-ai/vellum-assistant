/**
 * Unit tests for {@link MeetSpeakerResolver}.
 *
 * The resolver's hard parts are:
 *   - The ±500ms correlation window between DOM speaker-change events and
 *     Deepgram transcript chunks (tests drive timestamps explicitly).
 *   - Lazy learning of `speakerLabel → identity` bindings on the first
 *     near-in-time DOM event, and reusing them afterwards.
 *   - DOM-override precedence when a known Deepgram mapping disagrees
 *     with a freshly-correlated DOM snapshot.
 *   - Forwarding resolved identities to the shared
 *     {@link SpeakerIdentityTracker} so cross-surface speaker profiling
 *     keeps working.
 *
 * Tests inject a local subscribe shim so they never touch the process
 * dispatcher singleton.
 */

import { describe, expect, test } from "bun:test";

import type {
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import { SpeakerIdentityTracker } from "../../calls/speaker-identification.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";
import {
  MeetSpeakerResolver,
  UNKNOWN_SPEAKER_NAME,
} from "../speaker-resolver.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MEETING_ID = "m-resolver";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function transcript(
  overrides: Partial<TranscriptChunkEvent> = {},
): TranscriptChunkEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp: toIso(1_000),
    isFinal: true,
    text: "hello",
    ...overrides,
  };
}

function speakerChange(
  overrides: Partial<SpeakerChangeEvent> = {},
): SpeakerChangeEvent {
  return {
    type: "speaker.change",
    meetingId: MEETING_ID,
    timestamp: toIso(1_000),
    speakerId: "p-alice",
    speakerName: "Alice",
    ...overrides,
  };
}

/**
 * Build a local dispatcher shim so each test starts with a clean slate.
 * The resolver calls `subscribe(meetingId, cb)` once in its constructor;
 * `dispatch()` simulates router-forwarded events landing on the stream.
 */
function makeDispatcher() {
  const subscribers = new Map<string, Set<MeetEventSubscriber>>();

  const subscribe = (
    meetingId: string,
    cb: MeetEventSubscriber,
  ): MeetEventUnsubscribe => {
    let set = subscribers.get(meetingId);
    if (!set) {
      set = new Set();
      subscribers.set(meetingId, set);
    }
    set.add(cb);
    return () => {
      subscribers.get(meetingId)?.delete(cb);
    };
  };

  const dispatch = (
    meetingId: string,
    event: SpeakerChangeEvent | TranscriptChunkEvent,
  ): void => {
    const set = subscribers.get(meetingId);
    if (!set) return;
    for (const cb of set) cb(event);
  };

  const subscriberCount = (meetingId: string): number =>
    subscribers.get(meetingId)?.size ?? 0;

  return { subscribe, dispatch, subscriberCount };
}

// ---------------------------------------------------------------------------
// Fixture 1 — Deepgram + DOM agree
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — Deepgram + DOM agree", () => {
  test("a known-label transcript with agreeing DOM resolves via Deepgram mapping", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bootstrap: DOM says Alice is speaking at t=900, transcript lands at
    // t=1_000 with speakerLabel `speaker-0` — this binds the mapping.
    dispatch(
      MEETING_ID,
      speakerChange({ timestamp: toIso(900), speakerId: "p-alice" }),
    );
    const first = resolver.resolve(
      transcript({
        timestamp: toIso(1_000),
        speakerLabel: "speaker-0",
        text: "first",
      }),
    );
    expect(first.confidence).toBe("dom-override");
    expect(first.speakerId).toBe("p-alice");

    // Later: DOM emits another Alice-matching event just before the next
    // transcript, and Deepgram keeps reporting `speaker-0`. Because the
    // mapping is already bound *and* DOM still agrees, confidence is
    // `"deepgram"` (the bound path is the canonical fast path).
    dispatch(
      MEETING_ID,
      speakerChange({ timestamp: toIso(1_900), speakerId: "p-alice" }),
    );
    const second = resolver.resolve(
      transcript({
        timestamp: toIso(2_000),
        speakerLabel: "speaker-0",
        text: "second",
      }),
    );
    expect(second.confidence).toBe("deepgram");
    expect(second.speakerId).toBe("p-alice");
    expect(second.speakerName).toBe("Alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — Deepgram label unknown + DOM known → dom-override, bind mapping
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — learns mapping from DOM", () => {
  test("unknown Deepgram label + near-in-time DOM binds for future calls", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Alice's DOM snapshot at t=1_000.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_000),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );

    // Deepgram speaker-0, first time seen, transcript at t=1_300 (inside
    // the ±500ms window). → dom-override, plus the mapping is learned.
    const first = resolver.resolve(
      transcript({
        timestamp: toIso(1_300),
        speakerLabel: "speaker-0",
      }),
    );
    expect(first.confidence).toBe("dom-override");
    expect(first.speakerId).toBe("p-alice");
    expect(first.speakerName).toBe("Alice");

    // Follow-up transcript with the same Deepgram label but NO new DOM
    // event resolves via the learned mapping → confidence `"deepgram"`.
    const second = resolver.resolve(
      transcript({
        timestamp: toIso(10_000),
        speakerLabel: "speaker-0",
        text: "later utterance",
      }),
    );
    expect(second.confidence).toBe("deepgram");
    expect(second.speakerId).toBe("p-alice");
    expect(second.speakerName).toBe("Alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — Neither signal available → unknown
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — unknown fallback", () => {
  test("no Deepgram label + no DOM within window → unknown with default name", () => {
    const { subscribe } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(5_000),
        speakerLabel: undefined,
        text: "orphaned utterance",
      }),
    );
    expect(resolved.confidence).toBe("unknown");
    expect(resolved.speakerId).toBeUndefined();
    expect(resolved.speakerName).toBe(UNKNOWN_SPEAKER_NAME);

    resolver.unsubscribe();
  });

  test("Deepgram label + stale DOM event (outside window) → unknown", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // DOM at t=1_000, transcript at t=5_000 — well outside the ±500ms window.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(1_000) }));

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(5_000),
        speakerLabel: "speaker-7",
      }),
    );
    expect(resolved.confidence).toBe("unknown");
    expect(resolved.speakerId).toBeUndefined();

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — Bound mapping works without a fresh DOM lookup
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — mapping sticks across transcripts", () => {
  test("learned mapping survives once DOM snapshot ages out of the window", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind the mapping.
    dispatch(
      MEETING_ID,
      speakerChange({ timestamp: toIso(1_000), speakerId: "p-alice" }),
    );
    resolver.resolve(
      transcript({
        timestamp: toIso(1_200),
        speakerLabel: "speaker-0",
      }),
    );

    // Now a long time later — no fresh DOM event, but the mapping should
    // still apply.
    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(60_000),
        speakerLabel: "speaker-0",
        text: "way later",
      }),
    );
    expect(resolved.confidence).toBe("deepgram");
    expect(resolved.speakerId).toBe("p-alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 5 — Conflict: Deepgram mapped to one, DOM says another → DOM wins
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — conflict resolution", () => {
  test("known Deepgram mapping disagrees with near-in-time DOM → DOM wins", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Step 1 — bind speaker-0 → Alice.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_000),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );
    const aliceBound = resolver.resolve(
      transcript({
        timestamp: toIso(1_100),
        speakerLabel: "speaker-0",
        text: "Alice says hi",
      }),
    );
    expect(aliceBound.speakerId).toBe("p-alice");

    // Step 2 — a later transcript also labeled speaker-0, but the DOM has
    // shifted to Bob within the correlation window. DOM must win.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(10_000),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const conflicted = resolver.resolve(
      transcript({
        timestamp: toIso(10_200),
        speakerLabel: "speaker-0",
        text: "but Bob is speaking now",
      }),
    );
    expect(conflicted.confidence).toBe("dom-override");
    expect(conflicted.speakerId).toBe("p-bob");
    expect(conflicted.speakerName).toBe("Bob");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// SpeakerIdentityTracker integration
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — forwards to SpeakerIdentityTracker", () => {
  test("resolved identities are observed by the shared tracker", () => {
    const tracker = new SpeakerIdentityTracker();
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
      tracker,
    });

    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_000),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );
    resolver.resolve(
      transcript({
        timestamp: toIso(1_100),
        speakerLabel: "speaker-0",
      }),
    );

    const profiles = tracker.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      speakerId: "p-alice",
      speakerLabel: "Alice",
      source: "provider",
    });

    resolver.unsubscribe();
  });

  test("unknown resolutions do NOT pollute the tracker", () => {
    const tracker = new SpeakerIdentityTracker();
    const { subscribe } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
      tracker,
    });

    resolver.resolve(
      transcript({
        timestamp: toIso(5_000),
        speakerLabel: undefined,
      }),
    );

    expect(tracker.listProfiles()).toHaveLength(0);
    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — subscription lifecycle", () => {
  test("constructor subscribes; unsubscribe tears down", () => {
    const { subscribe, subscriberCount } = makeDispatcher();
    expect(subscriberCount(MEETING_ID)).toBe(0);

    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });
    expect(subscriberCount(MEETING_ID)).toBe(1);

    resolver.unsubscribe();
    expect(subscriberCount(MEETING_ID)).toBe(0);
  });

  test("unsubscribe is idempotent (safe to call twice)", () => {
    const { subscribe, subscriberCount } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    resolver.unsubscribe();
    resolver.unsubscribe();
    expect(subscriberCount(MEETING_ID)).toBe(0);
  });

  test("non-speaker.change events do not perturb state", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Dispatching an interim transcript event through the shared stream
    // should NOT be interpreted as a DOM snapshot.
    dispatch(
      MEETING_ID,
      transcript({
        timestamp: toIso(1_000),
        isFinal: false,
        speakerLabel: "speaker-0",
      }),
    );

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(1_050),
        speakerLabel: "speaker-0",
      }),
    );
    // No DOM snapshot was observed, so the resolver must treat the
    // Deepgram label as unknown → unknown fallback.
    expect(resolved.confidence).toBe("unknown");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — edge cases", () => {
  test("unparsable transcript timestamp disables DOM correlation", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(1_000) }));

    const resolved = resolver.resolve(
      transcript({
        timestamp: "not-a-real-timestamp",
        speakerLabel: "speaker-0",
      }),
    );
    // No correlation possible with NaN ms → unknown.
    expect(resolved.confidence).toBe("unknown");

    resolver.unsubscribe();
  });

  test("custom correlationWindowMs narrows the correlation window", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
      correlationWindowMs: 100,
    });

    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(1_000) }));

    // ±101 ms is just outside a 100 ms window.
    const outside = resolver.resolve(
      transcript({
        timestamp: toIso(1_101),
        speakerLabel: "speaker-0",
      }),
    );
    expect(outside.confidence).toBe("unknown");

    // ±50 ms is inside a 100 ms window.
    const inside = resolver.resolve(
      transcript({
        timestamp: toIso(1_050),
        speakerLabel: "speaker-0",
      }),
    );
    expect(inside.confidence).toBe("dom-override");

    resolver.unsubscribe();
  });

  test("transcript without speakerLabel + DOM within window still returns dom-override", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_000),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );
    const resolved = resolver.resolve(
      transcript({ timestamp: toIso(1_100), speakerLabel: undefined }),
    );
    expect(resolved.confidence).toBe("dom-override");
    expect(resolved.speakerId).toBe("p-alice");

    resolver.unsubscribe();
  });
});
