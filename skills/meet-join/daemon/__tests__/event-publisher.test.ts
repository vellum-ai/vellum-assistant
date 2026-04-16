/**
 * Unit tests for the Meet event publisher + dispatcher.
 *
 * Covers:
 *   - `publishMeetEvent` builds a proper `AssistantEvent` and hands it to
 *     `assistantEventHub.publish` with the expected `type` + `meetingId` +
 *     payload fields.
 *   - `MeetEventDispatcher` supports multiple subscribers per meeting with
 *     independent unsubscribe, and tolerates a throwing subscriber.
 *   - `registerMeetingDispatcher` + `subscribeEventHubPublisher` turn
 *     router-delivered bot events into the right `meet.*` event kinds.
 *   - Interim transcript chunks are dropped; finals are published with the
 *     full payload.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { MeetBotEvent } from "../../contracts/index.js";

import type { AssistantEvent } from "../../../../assistant/src/runtime/assistant-event.js";
import { assistantEventHub } from "../../../../assistant/src/runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../assistant/src/runtime/assistant-scope.js";
import {
  meetEventDispatcher,
  publishMeetEvent,
  registerMeetingDispatcher,
  subscribeEventHubPublisher,
  subscribeToMeetingEvents,
  unregisterMeetingDispatcher,
} from "../event-publisher.js";
import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
} from "../session-event-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe to the event hub for a given assistantId and collect every
 * published event. Returns the collected list + an unsubscribe function.
 */
function captureHub(assistantId: string) {
  const received: AssistantEvent[] = [];
  const sub = assistantEventHub.subscribe({ assistantId }, (event) => {
    received.push(event);
  });
  return { received, dispose: () => sub.dispose() };
}

function makeTranscript(
  meetingId: string,
  isFinal: boolean,
  overrides: Partial<{
    text: string;
    speakerLabel: string;
    speakerId: string;
    confidence: number;
  }> = {},
): MeetBotEvent {
  return {
    type: "transcript.chunk",
    meetingId,
    timestamp: new Date(0).toISOString(),
    isFinal,
    text: overrides.text ?? "hello world",
    speakerLabel: overrides.speakerLabel,
    speakerId: overrides.speakerId,
    confidence: overrides.confidence,
  };
}

function makeSpeakerChange(meetingId: string): MeetBotEvent {
  return {
    type: "speaker.change",
    meetingId,
    timestamp: new Date(0).toISOString(),
    speakerId: "spk-1",
    speakerName: "Alice",
  };
}

function makeParticipantChange(meetingId: string): MeetBotEvent {
  return {
    type: "participant.change",
    meetingId,
    timestamp: new Date(0).toISOString(),
    joined: [{ id: "p1", name: "Alice" }],
    left: [{ id: "p2", name: "Bob" }],
  };
}

function makeLifecycle(
  meetingId: string,
  state: "joining" | "joined" | "leaving" | "left" | "error",
  detail?: string,
): MeetBotEvent {
  return {
    type: "lifecycle",
    meetingId,
    timestamp: new Date(0).toISOString(),
    state,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
});

// ---------------------------------------------------------------------------
// publishMeetEvent
// ---------------------------------------------------------------------------

describe("publishMeetEvent", () => {
  test("wraps payload in a ServerMessage via buildAssistantEvent", async () => {
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    try {
      await publishMeetEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        "m-pub-1",
        "meet.joining",
        { url: "https://meet.google.com/abc-def-ghi" },
      );

      expect(received).toHaveLength(1);
      const event = received[0]!;
      expect(event.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(Number.isNaN(Date.parse(event.emittedAt))).toBe(false);
      expect(event.message.type).toBe("meet.joining");
      expect((event.message as { meetingId: string }).meetingId).toBe(
        "m-pub-1",
      );
      expect((event.message as { url: string }).url).toBe(
        "https://meet.google.com/abc-def-ghi",
      );
    } finally {
      dispose();
    }
  });

  test("does not propagate subscriber failures", async () => {
    // Subscribe with a throwing callback — the publish should still resolve.
    const sub = assistantEventHub.subscribe(
      { assistantId: DAEMON_INTERNAL_ASSISTANT_ID },
      () => {
        throw new Error("boom");
      },
    );
    try {
      await expect(
        publishMeetEvent(DAEMON_INTERNAL_ASSISTANT_ID, "m-pub-2", "meet.left", {
          reason: "user-requested",
        }),
      ).resolves.toBeUndefined();
    } finally {
      sub.dispose();
    }
  });

  test("each of the seven kinds round-trips as the message.type", async () => {
    const kinds = [
      "meet.joining",
      "meet.joined",
      "meet.participant_changed",
      "meet.speaker_changed",
      "meet.transcript_chunk",
      "meet.left",
      "meet.error",
    ] as const;
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    try {
      for (const kind of kinds) {
        await publishMeetEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          "m-kinds",
          kind,
          {},
        );
      }
      expect(received.map((e) => e.message.type)).toEqual([...kinds]);
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// MeetEventDispatcher
// ---------------------------------------------------------------------------

describe("meetEventDispatcher", () => {
  test("supports multiple subscribers per meeting", () => {
    const a: MeetBotEvent[] = [];
    const b: MeetBotEvent[] = [];
    const unsubA = subscribeToMeetingEvents("m1", (e) => a.push(e));
    const unsubB = subscribeToMeetingEvents("m1", (e) => b.push(e));

    const event = makeSpeakerChange("m1");
    meetEventDispatcher.dispatch("m1", event);

    expect(a).toEqual([event]);
    expect(b).toEqual([event]);
    expect(meetEventDispatcher.subscriberCount("m1")).toBe(2);

    unsubA();
    expect(meetEventDispatcher.subscriberCount("m1")).toBe(1);
    meetEventDispatcher.dispatch("m1", makeSpeakerChange("m1"));
    expect(a).toHaveLength(1); // no new delivery
    expect(b).toHaveLength(2);

    unsubB();
    expect(meetEventDispatcher.subscriberCount("m1")).toBe(0);
  });

  test("a throwing subscriber does not poison its neighbors", () => {
    subscribeToMeetingEvents("m2", () => {
      throw new Error("boom");
    });
    const b: MeetBotEvent[] = [];
    subscribeToMeetingEvents("m2", (e) => b.push(e));

    const event = makeSpeakerChange("m2");
    meetEventDispatcher.dispatch("m2", event);
    expect(b).toEqual([event]);
  });

  test("subscribers are scoped per meeting (no cross-talk)", () => {
    const m1: MeetBotEvent[] = [];
    const m2: MeetBotEvent[] = [];
    subscribeToMeetingEvents("m1", (e) => m1.push(e));
    subscribeToMeetingEvents("m2", (e) => m2.push(e));

    meetEventDispatcher.dispatch("m1", makeSpeakerChange("m1"));
    meetEventDispatcher.dispatch("m2", makeSpeakerChange("m2"));

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
  });

  test("clear drops all subscribers for a single meeting", () => {
    subscribeToMeetingEvents("m-clr", () => {});
    subscribeToMeetingEvents("m-clr", () => {});
    subscribeToMeetingEvents("m-other", () => {});

    meetEventDispatcher.clear("m-clr");

    expect(meetEventDispatcher.subscriberCount("m-clr")).toBe(0);
    expect(meetEventDispatcher.subscriberCount("m-other")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Router integration
// ---------------------------------------------------------------------------

describe("registerMeetingDispatcher / unregisterMeetingDispatcher", () => {
  test("router forwards events into the dispatcher", () => {
    registerMeetingDispatcher("m-router");

    const seen: MeetBotEvent[] = [];
    subscribeToMeetingEvents("m-router", (e) => seen.push(e));

    const event = makeSpeakerChange("m-router");
    getMeetSessionEventRouter().dispatch("m-router", event);

    expect(seen).toEqual([event]);
  });

  test("unregister clears router + dispatcher state", () => {
    registerMeetingDispatcher("m-u");
    subscribeToMeetingEvents("m-u", () => {});
    expect(meetEventDispatcher.subscriberCount("m-u")).toBe(1);

    unregisterMeetingDispatcher("m-u");

    // Router has no handler → dispatch is a no-op.
    getMeetSessionEventRouter().dispatch("m-u", makeSpeakerChange("m-u"));
    expect(meetEventDispatcher.subscriberCount("m-u")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// subscribeEventHubPublisher — router event → meet.* fan-out
// ---------------------------------------------------------------------------

describe("subscribeEventHubPublisher", () => {
  test("participant.change → meet.participant_changed with joined/left arrays", async () => {
    registerMeetingDispatcher("m-p");
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    const unsub = subscribeEventHubPublisher(
      DAEMON_INTERNAL_ASSISTANT_ID,
      "m-p",
    );
    try {
      const event = makeParticipantChange("m-p");
      getMeetSessionEventRouter().dispatch("m-p", event);

      // Give the fire-and-forget publish a microtask to settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(received).toHaveLength(1);
      const msg = received[0]!.message as {
        type: string;
        meetingId: string;
        joined: Array<{ id: string; name: string }>;
        left: Array<{ id: string; name: string }>;
      };
      expect(msg.type).toBe("meet.participant_changed");
      expect(msg.meetingId).toBe("m-p");
      expect(msg.joined).toEqual([{ id: "p1", name: "Alice" }]);
      expect(msg.left).toEqual([{ id: "p2", name: "Bob" }]);
    } finally {
      unsub();
      unregisterMeetingDispatcher("m-p");
      dispose();
    }
  });

  test("speaker.change → meet.speaker_changed with id + name", async () => {
    registerMeetingDispatcher("m-s");
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    const unsub = subscribeEventHubPublisher(
      DAEMON_INTERNAL_ASSISTANT_ID,
      "m-s",
    );
    try {
      getMeetSessionEventRouter().dispatch("m-s", makeSpeakerChange("m-s"));
      await Promise.resolve();
      await Promise.resolve();

      expect(received).toHaveLength(1);
      const msg = received[0]!.message as {
        type: string;
        speakerId: string;
        speakerName: string;
      };
      expect(msg.type).toBe("meet.speaker_changed");
      expect(msg.speakerId).toBe("spk-1");
      expect(msg.speakerName).toBe("Alice");
    } finally {
      unsub();
      unregisterMeetingDispatcher("m-s");
      dispose();
    }
  });

  test("final transcript.chunk → meet.transcript_chunk; interims are dropped", async () => {
    registerMeetingDispatcher("m-t");
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    const unsub = subscribeEventHubPublisher(
      DAEMON_INTERNAL_ASSISTANT_ID,
      "m-t",
    );
    try {
      // Interim — should NOT publish.
      getMeetSessionEventRouter().dispatch(
        "m-t",
        makeTranscript("m-t", false, { text: "interim …" }),
      );
      // Final — SHOULD publish with all optional fields preserved.
      getMeetSessionEventRouter().dispatch(
        "m-t",
        makeTranscript("m-t", true, {
          text: "hello final",
          speakerLabel: "Alice",
          speakerId: "spk-1",
          confidence: 0.92,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(received).toHaveLength(1);
      const msg = received[0]!.message as {
        type: string;
        text: string;
        speakerLabel: string;
        speakerId: string;
        confidence: number;
      };
      expect(msg.type).toBe("meet.transcript_chunk");
      expect(msg.text).toBe("hello final");
      expect(msg.speakerLabel).toBe("Alice");
      expect(msg.speakerId).toBe("spk-1");
      expect(msg.confidence).toBe(0.92);
    } finally {
      unsub();
      unregisterMeetingDispatcher("m-t");
      dispose();
    }
  });

  test("lifecycle events are NOT fanned out via the publisher", async () => {
    // The session manager publishes lifecycle events itself (at join start,
    // first joined, leave, error). The router-hub bridge must stay quiet on
    // lifecycle or we'd double-publish `meet.joined` etc.
    registerMeetingDispatcher("m-l");
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    const unsub = subscribeEventHubPublisher(
      DAEMON_INTERNAL_ASSISTANT_ID,
      "m-l",
    );
    try {
      getMeetSessionEventRouter().dispatch(
        "m-l",
        makeLifecycle("m-l", "joined"),
      );
      getMeetSessionEventRouter().dispatch("m-l", makeLifecycle("m-l", "left"));
      await Promise.resolve();
      await Promise.resolve();

      expect(received).toEqual([]);
    } finally {
      unsub();
      unregisterMeetingDispatcher("m-l");
      dispose();
    }
  });

  test("chat.inbound is dropped (not a meet.* event kind)", async () => {
    registerMeetingDispatcher("m-c");
    const { received, dispose } = captureHub(DAEMON_INTERNAL_ASSISTANT_ID);
    const unsub = subscribeEventHubPublisher(
      DAEMON_INTERNAL_ASSISTANT_ID,
      "m-c",
    );
    try {
      getMeetSessionEventRouter().dispatch("m-c", {
        type: "chat.inbound",
        meetingId: "m-c",
        timestamp: new Date(0).toISOString(),
        fromId: "p1",
        fromName: "Alice",
        text: "hi",
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(received).toEqual([]);
    } finally {
      unsub();
      unregisterMeetingDispatcher("m-c");
      dispose();
    }
  });
});
