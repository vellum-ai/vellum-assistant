/**
 * Unit tests for {@link MeetSpeakerResolver}.
 *
 * The resolver's hard parts are:
 *   - The ±500ms correlation window between DOM speaker-change events and
 *     provider transcript chunks (tests drive timestamps explicitly).
 *   - Lazy learning of `label → participant` mappings on the first
 *     near-in-time DOM event, agreement counts that grow on repeat
 *     confirmations, and a 3-consecutive-disagreement threshold before a
 *     mapping is replaced (guards against transient DOM flicker).
 *   - Fallbacks when the DOM is absent in the correlation window: stable
 *     mapping → `provider-via-mapping`; otherwise last-known DOM →
 *     `dom-fallback`.
 *   - Forwarding resolved identities to the shared
 *     {@link SpeakerIdentityTracker} so cross-surface speaker profiling
 *     keeps working.
 *   - Emitting a structured summary log on teardown.
 *
 * Tests inject a local subscribe shim so they never touch the process
 * dispatcher singleton.
 */

import { describe, expect, test } from "bun:test";

import type {
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import { SpeakerIdentityTracker } from "../../../../assistant/src/calls/speaker-identification.js";
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

/**
 * Dispatch `count` agreeing DOM-then-transcript pairs so the mapping for
 * `label` reaches `agreementCount === count`. Each pair is dispatched with
 * a unique timestamp to avoid spurious correlation interference.
 */
function bootstrapAgreement(
  resolver: MeetSpeakerResolver,
  dispatch: (
    meetingId: string,
    event: SpeakerChangeEvent | TranscriptChunkEvent,
  ) => void,
  label: string,
  speakerId: string,
  speakerName: string,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const t = 1_000 + i * 1_000;
    dispatch(
      MEETING_ID,
      speakerChange({ timestamp: toIso(t), speakerId, speakerName }),
    );
    resolver.resolve(
      transcript({
        timestamp: toIso(t + 100),
        speakerLabel: label,
        text: `agree-${i}`,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture 1 — Provider label matches DOM on first appearance
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — provider label + DOM agree", () => {
  test("first appearance binds the mapping and returns dom-authoritative", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // DOM says Alice at t=900; transcript lands at t=1_000 with label "0".
    dispatch(
      MEETING_ID,
      speakerChange({ timestamp: toIso(900), speakerId: "p-alice" }),
    );
    const first = resolver.resolve(
      transcript({
        timestamp: toIso(1_000),
        speakerLabel: "0",
      }),
    );
    expect(first.confidence).toBe("dom-authoritative");
    expect(first.speakerId).toBe("p-alice");
    expect(first.speakerName).toBe("Alice");

    resolver.unsubscribe();
  });

  test("same label seen again with agreeing DOM increments agreementCount", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Seen #1 — bind.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );
    // Seen #2 — agreement.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(1_900) }));
    const second = resolver.resolve(
      transcript({ timestamp: toIso(2_000), speakerLabel: "0" }),
    );
    expect(second.confidence).toBe("dom-authoritative");
    expect(second.speakerId).toBe("p-alice");

    // After a third agreement, the mapping has agreementCount >= 3 and
    // now qualifies as stable — a DOM-gap lookup would return
    // provider-via-mapping (covered in a separate test below).
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(2_900) }));
    const third = resolver.resolve(
      transcript({ timestamp: toIso(3_000), speakerLabel: "0" }),
    );
    expect(third.confidence).toBe("dom-authoritative");
    expect(third.speakerId).toBe("p-alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — Single disagreement → mapping preserved, conflict logged
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — DOM disagreement (transient flicker)", () => {
  test("single disagreement increments conflictCount and keeps the mapping", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind label "0" → Alice.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );

    // DOM now flickers to Bob for a single event; same label "0" arrives.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_900),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const resolved = resolver.resolve(
      transcript({ timestamp: toIso(2_000), speakerLabel: "0" }),
    );

    // Mapping is preserved — DOM flicker is treated as transient.
    expect(resolved.confidence).toBe("provider-via-mapping");
    expect(resolved.speakerId).toBe("p-alice");
    expect(resolved.speakerName).toBe("Alice");

    // The conflict is observable in the summary.
    const summary = resolver.flushSummary();
    expect(summary.conflictCount).toBe(1);
    // Mapping is still bound to Alice (unchanged despite disagreement).
    expect(summary.labelMappings).toEqual([
      {
        label: "0",
        participantId: "p-alice",
        participantName: "Alice",
        agreementCount: 1,
      },
    ]);

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — 3 consecutive disagreements → mapping replaced
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — mapping replacement", () => {
  test("3 consecutive DOM disagreements replace the mapping", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind label "0" → Alice.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );

    // Disagree #1 — mapping preserved.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(1_900),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const d1 = resolver.resolve(
      transcript({ timestamp: toIso(2_000), speakerLabel: "0" }),
    );
    expect(d1.speakerId).toBe("p-alice");

    // Disagree #2 — still preserved.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(2_900),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const d2 = resolver.resolve(
      transcript({ timestamp: toIso(3_000), speakerLabel: "0" }),
    );
    expect(d2.speakerId).toBe("p-alice");

    // Disagree #3 — crosses the threshold; mapping replaced, DOM wins.
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(3_900),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const d3 = resolver.resolve(
      transcript({ timestamp: toIso(4_000), speakerLabel: "0" }),
    );
    expect(d3.confidence).toBe("dom-authoritative");
    expect(d3.speakerId).toBe("p-bob");
    expect(d3.speakerName).toBe("Bob");

    // Subsequent transcript with a DOM-gap and no agreement rebuild yet
    // → the new mapping has agreementCount=1, so it's not stable; the
    // resolver falls back to the last-known DOM (which is still Bob).
    const later = resolver.resolve(
      transcript({ timestamp: toIso(60_000), speakerLabel: "0" }),
    );
    expect(later.confidence).toBe("dom-fallback");
    expect(later.speakerId).toBe("p-bob");

    resolver.unsubscribe();
  });

  test("disagreement counter resets after an agreement", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind label "0" → Alice.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );

    // Two disagreements.
    for (let i = 0; i < 2; i += 1) {
      dispatch(
        MEETING_ID,
        speakerChange({
          timestamp: toIso(1_900 + i * 1_000),
          speakerId: "p-bob",
          speakerName: "Bob",
        }),
      );
      resolver.resolve(
        transcript({
          timestamp: toIso(2_000 + i * 1_000),
          speakerLabel: "0",
        }),
      );
    }

    // An agreement arrives — counter resets.
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(3_900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(4_000), speakerLabel: "0" }),
    );

    // A single disagreement now should NOT replace (counter was reset).
    dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: toIso(4_900),
        speakerId: "p-bob",
        speakerName: "Bob",
      }),
    );
    const resolved = resolver.resolve(
      transcript({ timestamp: toIso(5_000), speakerLabel: "0" }),
    );
    expect(resolved.confidence).toBe("provider-via-mapping");
    expect(resolved.speakerId).toBe("p-alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — Provider label + DOM gap + stable mapping → provider-via-mapping
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — stable mapping, DOM gap", () => {
  test("stable mapping (agreementCount >= 3) resolves without a fresh DOM event", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    bootstrapAgreement(resolver, dispatch, "0", "p-alice", "Alice", 3);

    // Long after the last DOM event — no fresh snapshot within the window.
    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(60_000),
        speakerLabel: "0",
      }),
    );
    expect(resolved.confidence).toBe("provider-via-mapping");
    expect(resolved.speakerId).toBe("p-alice");
    expect(resolved.speakerName).toBe("Alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 5 — Provider label + DOM gap + no stable mapping → dom-fallback
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — DOM fallback for weak mapping", () => {
  test("provider label + DOM gap + agreementCount < 3 falls back to last-known DOM", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind label "0" → Alice once (agreementCount=1).
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );

    // Well outside the correlation window. No stable mapping yet.
    const resolved = resolver.resolve(
      transcript({ timestamp: toIso(60_000), speakerLabel: "0" }),
    );
    expect(resolved.confidence).toBe("dom-fallback");
    expect(resolved.speakerId).toBe("p-alice");
    expect(resolved.speakerName).toBe("Alice");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 6 — Provider label absent → DOM-only path (regression guard)
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — no provider label, DOM-only", () => {
  test("no label + DOM in window → dom-authoritative", () => {
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
    expect(resolved.confidence).toBe("dom-authoritative");
    expect(resolved.speakerId).toBe("p-alice");

    resolver.unsubscribe();
  });

  test("no label + no DOM within window → unknown", () => {
    const { subscribe } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(5_000),
        speakerLabel: undefined,
      }),
    );
    expect(resolved.confidence).toBe("unknown");
    expect(resolved.speakerId).toBeUndefined();
    expect(resolved.speakerName).toBe(UNKNOWN_SPEAKER_NAME);

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Fixture 7 — No DOM ever seen → unknown
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — true unknown", () => {
  test("label present + never saw any DOM → unknown", () => {
    const { subscribe } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(5_000),
        speakerLabel: "0",
      }),
    );
    // No DOM in window, no mapping, no last-known DOM → unknown.
    expect(resolved.confidence).toBe("unknown");

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
        speakerLabel: "0",
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

  test("non-speaker.change events do not perturb DOM state", () => {
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
        speakerLabel: "0",
      }),
    );

    const resolved = resolver.resolve(
      transcript({
        timestamp: toIso(1_050),
        speakerLabel: "0",
      }),
    );
    // No DOM snapshot was observed, so no correlation, no mapping, no
    // last-known DOM speaker → unknown fallback.
    expect(resolved.confidence).toBe("unknown");

    resolver.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// End-of-meeting summary log
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — meeting summary", () => {
  test("unsubscribe returns a summary with all learned mappings", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Learn two mappings.
    bootstrapAgreement(resolver, dispatch, "0", "p-alice", "Alice", 2);
    bootstrapAgreement(resolver, dispatch, "1", "p-bob", "Bob", 1);

    const summary = resolver.flushSummary();
    expect(summary.meetingId).toBe(MEETING_ID);
    expect(summary.conflictCount).toBe(0);
    expect(summary.labelMappings).toHaveLength(2);
    expect(summary.labelMappings).toEqual(
      expect.arrayContaining([
        {
          label: "0",
          participantId: "p-alice",
          participantName: "Alice",
          agreementCount: 2,
        },
        {
          label: "1",
          participantId: "p-bob",
          participantName: "Bob",
          agreementCount: 1,
        },
      ]),
    );

    resolver.unsubscribe();
  });

  test("summary includes conflictCount when disagreements occurred", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Bind label "0" → Alice, then two disagreements with Bob (below
    // the replacement threshold).
    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(900) }));
    resolver.resolve(
      transcript({ timestamp: toIso(1_000), speakerLabel: "0" }),
    );
    for (let i = 0; i < 2; i += 1) {
      dispatch(
        MEETING_ID,
        speakerChange({
          timestamp: toIso(1_900 + i * 1_000),
          speakerId: "p-bob",
          speakerName: "Bob",
        }),
      );
      resolver.resolve(
        transcript({
          timestamp: toIso(2_000 + i * 1_000),
          speakerLabel: "0",
        }),
      );
    }

    const summary = resolver.flushSummary();
    expect(summary.conflictCount).toBe(2);

    resolver.unsubscribe();
  });

  test("flushSummary is safe to call repeatedly and before unsubscribe", () => {
    const { subscribe } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    // Multiple calls before and after unsubscribe return the same data.
    const first = resolver.flushSummary();
    const second = resolver.flushSummary();
    resolver.unsubscribe();
    const third = resolver.flushSummary();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first.labelMappings).toEqual([]);
    expect(first.conflictCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("MeetSpeakerResolver — edge cases", () => {
  test("unparsable transcript timestamp → no correlation, falls back to last-known DOM", () => {
    const { subscribe, dispatch } = makeDispatcher();
    const resolver = new MeetSpeakerResolver({
      meetingId: MEETING_ID,
      subscribe,
    });

    dispatch(MEETING_ID, speakerChange({ timestamp: toIso(1_000) }));

    const resolved = resolver.resolve(
      transcript({
        timestamp: "not-a-real-timestamp",
        speakerLabel: "0",
      }),
    );
    // NaN ms → no correlation, so the label + no-DOM path is taken.
    // agreementCount is 0 (no prior binding), so the resolver falls back
    // to the last-known DOM speaker instead of binding an arbitrary label
    // to whoever spoke last — the binding path is reserved for correlated
    // transcripts only.
    expect(resolved.confidence).toBe("dom-fallback");
    expect(resolved.speakerId).toBe("p-alice");

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

    // ±50 ms is inside a 100 ms window → dom-authoritative.
    const inside = resolver.resolve(
      transcript({
        timestamp: toIso(1_050),
        speakerLabel: "0",
      }),
    );
    expect(inside.confidence).toBe("dom-authoritative");

    // ±101 ms is just outside a 100 ms window. No stable mapping yet
    // (agreementCount=1 from the inside-window call), so the resolver
    // falls back to the last-known DOM speaker.
    const outside = resolver.resolve(
      transcript({
        timestamp: toIso(1_101),
        speakerLabel: "0",
      }),
    );
    expect(outside.confidence).toBe("dom-fallback");

    resolver.unsubscribe();
  });
});
