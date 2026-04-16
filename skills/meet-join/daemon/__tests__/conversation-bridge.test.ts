/**
 * Unit tests for MeetConversationBridge.
 *
 * The bridge is tested with a recording shim for `addMessage`, a local
 * dispatcher shim (no singleton state leaks), and a stub event hub —
 * so the whole surface is exercised without touching SQLite or the
 * real process-level hub.
 *
 * Notable shapes covered here:
 *   - Final transcripts go through the speaker resolver before insert —
 *     resolved name + confidence appear in the metadata.
 *   - The bridge subscribes via `subscribeToMeetingEvents` (PR 19 multi-
 *     subscriber dispatcher), not `MeetSessionEventRouter` directly.
 *   - The resolver observes `speaker.change` through the same dispatcher
 *     stream, so a DOM snapshot just before a transcript binds the
 *     Deepgram label for future resolutions.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  InboundChatEvent,
  LifecycleEvent,
  MeetBotEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "../../contracts/index.js";

import type { AssistantEvent } from "../../../../assistant/src/runtime/assistant-event.js";
import {
  type InsertMessageFn,
  MeetConversationBridge,
} from "../conversation-bridge.js";
import type {
  MeetEventSubscriber,
  MeetEventUnsubscribe,
} from "../event-publisher.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const MEETING_ID = "meeting-abc";
const CONVERSATION_ID = "conv-xyz";
const TIMESTAMP = "2025-01-01T00:00:00.000Z";

interface InsertCall {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  opts?: { skipIndexing?: boolean };
}

function makeInsertRecorder(): {
  fn: InsertMessageFn;
  calls: InsertCall[];
} {
  const calls: InsertCall[] = [];
  let counter = 0;
  const fn: InsertMessageFn = async (
    conversationId,
    role,
    content,
    metadata,
    opts,
  ) => {
    calls.push({ conversationId, role, content, metadata, opts });
    counter += 1;
    return { id: `msg-${counter}` };
  };
  return { fn, calls };
}

/**
 * Local dispatcher shim that mirrors the PR 19 `subscribeToMeetingEvents`
 * API. Keeps a per-meeting subscriber set and exposes a `dispatch` helper
 * that tests call to deliver an event to all current subscribers.
 *
 * The resolver subscribes in the bridge constructor and the bridge
 * subscribes in `subscribe()`, so the shim has to handle multiple
 * subscribers per meeting — exactly the point of migrating away from
 * the single-handler router.
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

  const dispatch = (meetingId: string, event: MeetBotEvent): void => {
    const set = subscribers.get(meetingId);
    if (!set) return;
    // Snapshot so a subscriber that self-unsubscribes mid-dispatch
    // doesn't mutate the live iterator.
    for (const cb of Array.from(set)) cb(event);
  };

  const subscriberCount = (meetingId: string): number =>
    subscribers.get(meetingId)?.size ?? 0;

  return { subscribe, dispatch, subscriberCount };
}

type Dispatcher = ReturnType<typeof makeDispatcher>;

function makeBridge(
  overrides: {
    conversationId?: string;
    meetingId?: string;
    insertMessage?: InsertMessageFn;
    dispatcher?: Dispatcher;
    hubPublish?: ReturnType<typeof mock>;
  } = {},
) {
  const recorder = overrides.insertMessage
    ? { fn: overrides.insertMessage, calls: [] as InsertCall[] }
    : makeInsertRecorder();
  const dispatcher = overrides.dispatcher ?? makeDispatcher();
  const hubPublish = overrides.hubPublish ?? mock(async () => {});
  const bridge = new MeetConversationBridge({
    meetingId: overrides.meetingId ?? MEETING_ID,
    conversationId: overrides.conversationId ?? CONVERSATION_ID,
    insertMessage: recorder.fn,
    subscribeToMeetingEvents: dispatcher.subscribe,
    assistantEventHub: {
      publish: hubPublish as unknown as (e: AssistantEvent) => Promise<void>,
    },
  });
  return { bridge, dispatcher, calls: recorder.calls, hubPublish };
}

function finalTranscript(
  overrides: Partial<TranscriptChunkEvent> = {},
): TranscriptChunkEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    isFinal: true,
    text: "Hello, team.",
    speakerLabel: "Speaker 0",
    speakerId: "spk-0",
    ...overrides,
  };
}

function interimTranscript(
  overrides: Partial<TranscriptChunkEvent> = {},
): TranscriptChunkEvent {
  return {
    type: "transcript.chunk",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    isFinal: false,
    text: "Hello",
    speakerLabel: "Speaker 0",
    speakerId: "spk-0",
    confidence: 0.5,
    ...overrides,
  };
}

function inboundChat(
  overrides: Partial<InboundChatEvent> = {},
): InboundChatEvent {
  return {
    type: "chat.inbound",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    fromId: "u-alice",
    fromName: "Alice",
    text: "Hey assistant, please take notes.",
    ...overrides,
  };
}

function participantChange(
  overrides: Partial<ParticipantChangeEvent> = {},
): ParticipantChangeEvent {
  return {
    type: "participant.change",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    joined: [],
    left: [],
    ...overrides,
  };
}

function speakerChange(
  overrides: Partial<SpeakerChangeEvent> = {},
): SpeakerChangeEvent {
  return {
    type: "speaker.change",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    speakerId: "spk-1",
    speakerName: "Bob",
    ...overrides,
  };
}

function lifecycle(overrides: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    type: "lifecycle",
    meetingId: MEETING_ID,
    timestamp: TIMESTAMP,
    state: "joined",
    ...overrides,
  };
}

/**
 * Let all micro-tasks settle — the dispatcher delivers synchronously but
 * the bridge's handler uses `void this.handleEvent(...)`, so we need a
 * microtask flush before asserting inserts / publishes.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe("MeetConversationBridge subscription", () => {
  test("bridge constructor registers the resolver; subscribe() adds a second subscriber", () => {
    const dispatcher = makeDispatcher();
    const { bridge } = makeBridge({ dispatcher });
    // Resolver subscribed on construction.
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(1);

    bridge.subscribe();
    // Bridge handler is the second subscriber.
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(2);
    expect(bridge.isSubscribed()).toBe(true);

    bridge.unsubscribe();
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(0);
    expect(bridge.isSubscribed()).toBe(false);
  });

  test("events dispatched before subscribe() are dropped", async () => {
    const { bridge, dispatcher, calls } = makeBridge();

    dispatcher.dispatch(MEETING_ID, finalTranscript());
    await flush();
    expect(calls).toHaveLength(0);

    // Subscribe and dispatch again — now it should be recorded.
    bridge.subscribe();
    dispatcher.dispatch(MEETING_ID, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("events dispatched after unsubscribe() are dropped", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();
    dispatcher.dispatch(MEETING_ID, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);

    bridge.unsubscribe();
    dispatcher.dispatch(MEETING_ID, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("subscribe() is idempotent — calling twice keeps one bridge subscriber", () => {
    const dispatcher = makeDispatcher();
    const { bridge } = makeBridge({ dispatcher });
    bridge.subscribe();
    bridge.subscribe();
    // Resolver (1) + bridge (1) — subscribe twice must not stack another.
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(2);
    bridge.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Transcript handling — resolver integration
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — transcript.chunk (resolver integration)", () => {
  test("no DOM snapshot → resolver returns unknown; metadata reflects that", async () => {
    const { bridge, dispatcher, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      finalTranscript({
        text: "Let's kick off the sync.",
        speakerLabel: "Speaker 0",
        speakerId: "spk-0",
      }),
    );
    await flush();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.conversationId).toBe(CONVERSATION_ID);
    expect(call?.role).toBe("user");
    const parsed = JSON.parse(call!.content) as Array<{
      type: string;
      text: string;
    }>;
    // Without a DOM snapshot, the resolver falls back to "Unknown speaker".
    expect(parsed).toEqual([
      { type: "text", text: "[Unknown speaker]: Let's kick off the sync." },
    ]);
    expect(call?.metadata).toMatchObject({
      meetingId: MEETING_ID,
      meetTimestamp: TIMESTAMP,
      meetSpeakerLabel: "Speaker 0",
      meetSpeakerId: "spk-0",
      meetSpeakerName: "Unknown speaker",
      meetSpeakerConfidence: "unknown",
    });

    expect(hubPublish).toHaveBeenCalledTimes(0);
  });

  test("DOM snapshot just before transcript → resolved name used in content + metadata", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    // Deliver a DOM speaker-change within the correlation window.
    dispatcher.dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: new Date(Date.parse(TIMESTAMP) - 100).toISOString(),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );

    dispatcher.dispatch(
      MEETING_ID,
      finalTranscript({
        text: "Let's kick off.",
        speakerLabel: "Speaker 0",
        speakerId: "spk-0",
        timestamp: TIMESTAMP,
      }),
    );
    await flush();

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.content) as Array<{ text: string }>;
    expect(parsed[0]?.text).toBe("[Alice]: Let's kick off.");
    expect(calls[0]?.metadata).toMatchObject({
      meetSpeakerName: "Alice",
      meetSpeakerId: "p-alice",
      meetSpeakerLabel: "Speaker 0",
      meetSpeakerConfidence: "dom-authoritative",
    });
  });

  test("learned mapping reused on later transcripts (DOM gap) → dom-fallback", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    // Bootstrap — a single DOM-correlated transcript binds label "Speaker 0"
    // to Alice with agreementCount=1 (below the stable threshold).
    dispatcher.dispatch(
      MEETING_ID,
      speakerChange({
        timestamp: new Date(Date.parse(TIMESTAMP) - 200).toISOString(),
        speakerId: "p-alice",
        speakerName: "Alice",
      }),
    );
    dispatcher.dispatch(
      MEETING_ID,
      finalTranscript({ text: "First", speakerLabel: "Speaker 0" }),
    );

    // Later — another Speaker 0 transcript, well outside the correlation
    // window, with no new DOM event. Mapping is not stable yet (agreement
    // count = 1), so the resolver falls back to the last-known DOM
    // speaker (still Alice) with confidence `dom-fallback`.
    const laterTs = new Date(Date.parse(TIMESTAMP) + 60_000).toISOString();
    dispatcher.dispatch(
      MEETING_ID,
      finalTranscript({
        text: "Later",
        speakerLabel: "Speaker 0",
        timestamp: laterTs,
      }),
    );
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.metadata).toMatchObject({
      meetSpeakerName: "Alice",
      meetSpeakerId: "p-alice",
      meetSpeakerConfidence: "dom-fallback",
    });
  });

  test("empty / whitespace-only final chunks are skipped (no insert)", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(MEETING_ID, finalTranscript({ text: "" }));
    dispatcher.dispatch(MEETING_ID, finalTranscript({ text: "   \n\t  " }));
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("interim chunks publish to the hub but never persist", async () => {
    const { bridge, dispatcher, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      interimTranscript({ text: "Hello tea", confidence: 0.72 }),
    );
    await flush();

    expect(calls).toHaveLength(0);
    expect(hubPublish).toHaveBeenCalledTimes(1);

    const published = hubPublish.mock.calls[0]?.[0] as AssistantEvent;
    expect(published.conversationId).toBe(CONVERSATION_ID);
    expect(published.message).toMatchObject({
      type: "meet.transcript_interim",
      meetingId: MEETING_ID,
      conversationId: CONVERSATION_ID,
      timestamp: TIMESTAMP,
      text: "Hello tea",
      speakerLabel: "Speaker 0",
      speakerId: "spk-0",
      confidence: 0.72,
    });
  });

  test("interim hub failures are logged but do not throw", async () => {
    const failingPublish = mock(async () => {
      throw new Error("hub offline");
    });
    const { bridge, dispatcher, calls } = makeBridge({
      hubPublish: failingPublish,
    });
    bridge.subscribe();

    // Should not throw — the dispatcher would surface an unhandled rejection
    // via the bridge's .catch otherwise.
    dispatcher.dispatch(MEETING_ID, interimTranscript());
    await flush();

    expect(failingPublish).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inbound chat handling
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — chat.inbound", () => {
  test("chat messages persist with [Meet chat] prefix and chat metadata", async () => {
    const { bridge, dispatcher, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      inboundChat({ fromName: "Alice", fromId: "u-alice", text: "Notes?" }),
    );
    await flush();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.role).toBe("user");
    expect(call?.conversationId).toBe(CONVERSATION_ID);
    const parsed = JSON.parse(call!.content) as Array<{ text: string }>;
    expect(parsed[0]?.text).toBe("[Meet chat] Alice: Notes?");
    expect(call?.metadata).toMatchObject({
      meetingId: MEETING_ID,
      meetTimestamp: TIMESTAMP,
      meetChatFromId: "u-alice",
      meetChatFromName: "Alice",
      automated: true,
    });
    expect(hubPublish).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Participant change handling
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — participant.change", () => {
  test("joined participants produce one short 'X joined' line each", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      participantChange({
        joined: [
          { id: "u-alice", name: "Alice" },
          { id: "u-bob", name: "Bob" },
        ],
      }),
    );
    await flush();

    expect(calls).toHaveLength(2);
    const [alice, bob] = calls;

    const aliceText = JSON.parse(alice!.content)[0].text;
    const bobText = JSON.parse(bob!.content)[0].text;
    expect(aliceText).toBe("Alice joined");
    expect(bobText).toBe("Bob joined");

    expect(alice?.role).toBe("assistant");
    expect(alice?.metadata).toMatchObject({
      meetingId: MEETING_ID,
      meetParticipantId: "u-alice",
      meetParticipantChange: "joined",
      automated: true,
    });
    expect(alice?.opts).toEqual({ skipIndexing: true });
    expect(bob?.opts).toEqual({ skipIndexing: true });
  });

  test("left participants produce one short 'X left' line each", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      participantChange({
        left: [{ id: "u-carol", name: "Carol" }],
      }),
    );
    await flush();

    expect(calls).toHaveLength(1);
    const text = JSON.parse(calls[0]!.content)[0].text;
    expect(text).toBe("Carol left");
    expect(calls[0]?.role).toBe("assistant");
    expect(calls[0]?.metadata).toMatchObject({
      meetParticipantId: "u-carol",
      meetParticipantChange: "left",
      automated: true,
    });
  });

  test("empty joined/left arrays produce no inserts", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      participantChange({ joined: [], left: [] }),
    );
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("simultaneous joins + leaves each produce their own line", async () => {
    const { bridge, dispatcher, calls } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(
      MEETING_ID,
      participantChange({
        joined: [{ id: "u-alice", name: "Alice" }],
        left: [{ id: "u-bob", name: "Bob" }],
      }),
    );
    await flush();

    expect(calls).toHaveLength(2);
    const texts = calls.map((c) => JSON.parse(c.content)[0].text);
    expect(texts).toEqual(["Alice joined", "Bob left"]);
  });
});

// ---------------------------------------------------------------------------
// Ignored event types (speaker.change at bridge level, lifecycle)
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — ignored events", () => {
  test("speaker.change events do not persist or publish (resolver consumes them)", async () => {
    const { bridge, dispatcher, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatcher.dispatch(MEETING_ID, speakerChange());
    await flush();

    expect(calls).toHaveLength(0);
    expect(hubPublish).toHaveBeenCalledTimes(0);
  });

  test("lifecycle events do not persist or publish (every state)", async () => {
    const { bridge, dispatcher, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    for (const state of [
      "joining",
      "joined",
      "leaving",
      "left",
      "error",
    ] as const) {
      dispatcher.dispatch(MEETING_ID, lifecycle({ state }));
    }
    await flush();

    expect(calls).toHaveLength(0);
    expect(hubPublish).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — error isolation", () => {
  test("an insert failure does not tear down the bridge or dispatcher", async () => {
    let shouldFail = true;
    const failingInsert: InsertMessageFn = async () => {
      if (shouldFail) {
        throw new Error("db offline");
      }
      return { id: "recovered" };
    };

    const dispatcher = makeDispatcher();
    const hubPublish = mock(async () => {});
    const bridge = new MeetConversationBridge({
      meetingId: MEETING_ID,
      conversationId: CONVERSATION_ID,
      insertMessage: failingInsert,
      subscribeToMeetingEvents: dispatcher.subscribe,
      assistantEventHub: {
        publish: hubPublish as unknown as (e: AssistantEvent) => Promise<void>,
      },
    });
    bridge.subscribe();

    // First dispatch fails inside the handler — dispatcher must survive.
    dispatcher.dispatch(MEETING_ID, finalTranscript());
    await flush();

    shouldFail = false;
    dispatcher.dispatch(
      MEETING_ID,
      interimTranscript({ text: "still alive", isFinal: false }),
    );
    await flush();

    // Hub publish happened for the interim chunk even though the earlier
    // insert threw — the bridge did not crash the dispatcher subscription.
    expect(hubPublish).toHaveBeenCalledTimes(1);
    // Resolver + bridge subscribers still alive.
    expect(dispatcher.subscriberCount(MEETING_ID)).toBe(2);

    bridge.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Cross-meeting isolation
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — cross-meeting isolation", () => {
  let dispatcher: Dispatcher;

  beforeEach(() => {
    dispatcher = makeDispatcher();
  });

  test("events for another meeting id do not reach this bridge", async () => {
    const { bridge, calls } = makeBridge({ dispatcher });
    bridge.subscribe();

    // Explicitly dispatch an event keyed under a different meeting id.
    dispatcher.dispatch("some-other-meet", {
      ...finalTranscript(),
      meetingId: "some-other-meet",
    });
    await flush();

    expect(calls).toHaveLength(0);
  });
});
