/**
 * Unit tests for MeetConversationBridge.
 *
 * The bridge is tested with a recording shim for `addMessage`, a local
 * router instance (no singleton state leaks), and a stub event hub —
 * so the whole surface is exercised without touching SQLite or the
 * real process-level hub.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  InboundChatEvent,
  LifecycleEvent,
  MeetBotEvent,
  ParticipantChangeEvent,
  SpeakerChangeEvent,
  TranscriptChunkEvent,
} from "@vellumai/meet-contracts";

import type { AssistantEvent } from "../../runtime/assistant-event.js";
import {
  type InsertMessageFn,
  MeetConversationBridge,
} from "../conversation-bridge.js";
import { MeetSessionEventRouter } from "../session-event-router.js";

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

function makeBridge(
  overrides: {
    conversationId?: string;
    meetingId?: string;
    insertMessage?: InsertMessageFn;
    router?: MeetSessionEventRouter;
    hubPublish?: ReturnType<typeof mock>;
  } = {},
) {
  const recorder = overrides.insertMessage
    ? { fn: overrides.insertMessage, calls: [] as InsertCall[] }
    : makeInsertRecorder();
  const router = overrides.router ?? new MeetSessionEventRouter();
  const hubPublish = overrides.hubPublish ?? mock(async () => {});
  const bridge = new MeetConversationBridge({
    meetingId: overrides.meetingId ?? MEETING_ID,
    conversationId: overrides.conversationId ?? CONVERSATION_ID,
    insertMessage: recorder.fn,
    router,
    assistantEventHub: { publish: hubPublish as unknown as (e: AssistantEvent) => Promise<void> },
  });
  return { bridge, router, calls: recorder.calls, hubPublish };
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

function dispatch(router: MeetSessionEventRouter, event: MeetBotEvent): void {
  router.dispatch(event.meetingId, event);
}

/**
 * Let all micro-tasks settle — the router dispatches synchronously but
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
  test("subscribe() registers a router handler; unsubscribe() removes it", () => {
    const { bridge, router } = makeBridge();
    expect(router.registeredCount()).toBe(0);

    bridge.subscribe();
    expect(router.registeredCount()).toBe(1);
    expect(bridge.isSubscribed()).toBe(true);

    bridge.unsubscribe();
    expect(router.registeredCount()).toBe(0);
    expect(bridge.isSubscribed()).toBe(false);
  });

  test("events dispatched before subscribe() are dropped", async () => {
    const { bridge, router, calls } = makeBridge();

    dispatch(router, finalTranscript());
    await flush();
    expect(calls).toHaveLength(0);

    // Subscribe and dispatch again — now it should be recorded.
    bridge.subscribe();
    dispatch(router, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);
  });

  test("events dispatched after unsubscribe() are dropped", async () => {
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();
    dispatch(router, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);

    bridge.unsubscribe();
    dispatch(router, finalTranscript());
    await flush();
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Transcript handling
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — transcript.chunk", () => {
  test("final chunks become conversation messages with speaker metadata", async () => {
    const { bridge, router, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
    expect(parsed).toEqual([
      { type: "text", text: "[Speaker 0]: Let's kick off the sync." },
    ]);
    expect(call?.metadata).toMatchObject({
      meetingId: MEETING_ID,
      meetTimestamp: TIMESTAMP,
      meetSpeakerLabel: "Speaker 0",
      meetSpeakerId: "spk-0",
      meetSpeakerName: "Speaker 0",
    });

    // Final transcripts must not go to the hub as interim events.
    expect(hubPublish).toHaveBeenCalledTimes(0);
  });

  test("final chunks without a speakerLabel fall back to 'Unknown speaker'", async () => {
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
      finalTranscript({
        text: "Off-mic remark.",
        speakerLabel: undefined,
        speakerId: undefined,
      }),
    );
    await flush();

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]!.content) as Array<{ text: string }>;
    expect(parsed[0]?.text).toBe("[Unknown speaker]: Off-mic remark.");
    expect(calls[0]?.metadata).toMatchObject({
      meetSpeakerName: "Unknown speaker",
    });
    expect(calls[0]?.metadata?.meetSpeakerLabel).toBeUndefined();
    expect(calls[0]?.metadata?.meetSpeakerId).toBeUndefined();
  });

  test("empty / whitespace-only final chunks are skipped (no insert)", async () => {
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(router, finalTranscript({ text: "" }));
    dispatch(router, finalTranscript({ text: "   \n\t  " }));
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("interim chunks publish to the hub but never persist", async () => {
    const { bridge, router, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
    const { bridge, router, calls } = makeBridge({
      hubPublish: failingPublish,
    });
    bridge.subscribe();

    // Should not throw — the router would surface an unhandled rejection
    // via the bridge's .catch otherwise.
    dispatch(router, interimTranscript());
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
    const { bridge, router, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(router, participantChange({ joined: [], left: [] }));
    await flush();

    expect(calls).toHaveLength(0);
  });

  test("simultaneous joins + leaves each produce their own line", async () => {
    const { bridge, router, calls } = makeBridge();
    bridge.subscribe();

    dispatch(
      router,
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
// Ignored event types (speaker.change, lifecycle)
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — ignored events", () => {
  test("speaker.change events do not persist or publish", async () => {
    const { bridge, router, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    dispatch(router, speakerChange());
    await flush();

    expect(calls).toHaveLength(0);
    expect(hubPublish).toHaveBeenCalledTimes(0);
  });

  test("lifecycle events do not persist or publish (every state)", async () => {
    const { bridge, router, calls, hubPublish } = makeBridge();
    bridge.subscribe();

    for (const state of [
      "joining",
      "joined",
      "leaving",
      "left",
      "error",
    ] as const) {
      dispatch(router, lifecycle({ state }));
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
  test("an insert failure does not tear down the bridge or router", async () => {
    let shouldFail = true;
    const failingInsert: InsertMessageFn = async () => {
      if (shouldFail) {
        throw new Error("db offline");
      }
      return { id: "recovered" };
    };

    const router = new MeetSessionEventRouter();
    const hubPublish = mock(async () => {});
    const bridge = new MeetConversationBridge({
      meetingId: MEETING_ID,
      conversationId: CONVERSATION_ID,
      insertMessage: failingInsert,
      router,
      assistantEventHub: { publish: hubPublish as unknown as (e: AssistantEvent) => Promise<void> },
    });
    bridge.subscribe();

    // First dispatch fails inside the handler — router must survive.
    dispatch(router, finalTranscript());
    await flush();

    shouldFail = false;
    dispatch(
      router,
      interimTranscript({ text: "still alive", isFinal: false }),
    );
    await flush();

    // Hub publish happened for the interim chunk even though the earlier
    // insert threw — the bridge did not crash the router registration.
    expect(hubPublish).toHaveBeenCalledTimes(1);
    expect(router.registeredCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-meeting isolation
// ---------------------------------------------------------------------------

describe("MeetConversationBridge — cross-meeting isolation", () => {
  let router: MeetSessionEventRouter;

  beforeEach(() => {
    router = new MeetSessionEventRouter();
  });

  test("events for another meeting id do not reach this bridge", async () => {
    const { bridge, calls } = makeBridge({ router });
    bridge.subscribe();

    dispatch(router, { ...finalTranscript(), meetingId: "some-other-meet" });
    await flush();

    expect(calls).toHaveLength(0);
  });
});
