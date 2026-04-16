/**
 * Tests for meet-join wire-protocol contracts.
 *
 * These tests verify:
 * 1. The contracts are free of imports from assistant/ or meet-bot.
 * 2. Every event and command schema parses valid payloads and rejects
 *    malformed ones.
 * 3. The discriminated unions (MeetBotEvent, MeetBotCommand) correctly
 *    narrow on `type`, including round-trip validation.
 */

import { describe, expect, test } from "bun:test";
import {
  InboundChatEventSchema,
  LeaveCommandSchema,
  LifecycleEventSchema,
  MEET_BOT_COMMAND_TYPES,
  MEET_BOT_EVENT_TYPES,
  MeetBotCommandSchema,
  MeetBotEventSchema,
  ParticipantChangeEventSchema,
  ParticipantSchema,
  PlayAudioCommandSchema,
  SendChatCommandSchema,
  SpeakerChangeEventSchema,
  StatusCommandSchema,
  TranscriptChunkEventSchema,
  type MeetBotCommand,
  type MeetBotEvent,
} from "../index.js";

// ---------------------------------------------------------------------------
// Independence guard — contracts must not pull in assistant or the bot.
// ---------------------------------------------------------------------------

describe("contract independence", () => {
  const sourceFiles = ["../index.ts", "../events.ts", "../commands.ts"];

  for (const file of sourceFiles) {
    test(`${file} does not import from assistant/ or skills/meet-join/bot/`, () => {
      const src = require("node:fs").readFileSync(
        require("node:path").resolve(__dirname, file),
        "utf-8",
      );
      expect(src).not.toMatch(/from\s+['"].*assistant\//);
      expect(src).not.toMatch(/from\s+['"].*meet-join\/bot\//);
      expect(src).not.toMatch(/require\(['"].*assistant\//);
      expect(src).not.toMatch(/require\(['"].*meet-join\/bot\//);
    });
  }
});

// ---------------------------------------------------------------------------
// Event type const tuple
// ---------------------------------------------------------------------------

describe("MEET_BOT_EVENT_TYPES", () => {
  test("includes every discriminator used by MeetBotEventSchema", () => {
    expect(new Set(MEET_BOT_EVENT_TYPES)).toEqual(
      new Set([
        "transcript.chunk",
        "speaker.change",
        "participant.change",
        "chat.inbound",
        "lifecycle",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// TranscriptChunkEventSchema
// ---------------------------------------------------------------------------

describe("TranscriptChunkEventSchema", () => {
  test("parses a minimal final chunk", () => {
    const result = TranscriptChunkEventSchema.parse({
      type: "transcript.chunk",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      isFinal: true,
      text: "Hello world",
    });
    expect(result.isFinal).toBe(true);
    expect(result.text).toBe("Hello world");
    expect(result.speakerLabel).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  test("parses a chunk with optional speaker + confidence fields", () => {
    const result = TranscriptChunkEventSchema.parse({
      type: "transcript.chunk",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      isFinal: false,
      text: "partial...",
      speakerLabel: "Alice",
      speakerId: "spk-alice",
      confidence: 0.87,
    });
    expect(result.speakerLabel).toBe("Alice");
    expect(result.speakerId).toBe("spk-alice");
    expect(result.confidence).toBe(0.87);
  });

  test("rejects missing isFinal", () => {
    expect(() =>
      TranscriptChunkEventSchema.parse({
        type: "transcript.chunk",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        text: "oops",
      }),
    ).toThrow();
  });

  test("rejects confidence out of [0, 1]", () => {
    expect(() =>
      TranscriptChunkEventSchema.parse({
        type: "transcript.chunk",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        isFinal: true,
        text: "hi",
        confidence: 1.5,
      }),
    ).toThrow();
    expect(() =>
      TranscriptChunkEventSchema.parse({
        type: "transcript.chunk",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        isFinal: true,
        text: "hi",
        confidence: -0.1,
      }),
    ).toThrow();
  });

  test("rejects wrong type literal", () => {
    expect(() =>
      TranscriptChunkEventSchema.parse({
        type: "transcript.final",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        isFinal: true,
        text: "hi",
      }),
    ).toThrow();
  });

  test("rejects empty meetingId", () => {
    expect(() =>
      TranscriptChunkEventSchema.parse({
        type: "transcript.chunk",
        meetingId: "",
        timestamp: "2026-04-15T00:00:00Z",
        isFinal: true,
        text: "hi",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SpeakerChangeEventSchema
// ---------------------------------------------------------------------------

describe("SpeakerChangeEventSchema", () => {
  test("parses a valid speaker change", () => {
    const result = SpeakerChangeEventSchema.parse({
      type: "speaker.change",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      speakerId: "spk-bob",
      speakerName: "Bob",
    });
    expect(result.speakerId).toBe("spk-bob");
    expect(result.speakerName).toBe("Bob");
  });

  test("rejects missing speakerName", () => {
    expect(() =>
      SpeakerChangeEventSchema.parse({
        type: "speaker.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        speakerId: "spk-bob",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ParticipantSchema / ParticipantChangeEventSchema
// ---------------------------------------------------------------------------

describe("ParticipantSchema", () => {
  test("parses a minimal participant", () => {
    const result = ParticipantSchema.parse({ id: "p-1", name: "Alice" });
    expect(result.id).toBe("p-1");
    expect(result.isHost).toBeUndefined();
    expect(result.isSelf).toBeUndefined();
  });

  test("parses participant with isHost/isSelf", () => {
    const result = ParticipantSchema.parse({
      id: "p-2",
      name: "Bot",
      isHost: false,
      isSelf: true,
    });
    expect(result.isSelf).toBe(true);
  });

  test("rejects missing id", () => {
    expect(() => ParticipantSchema.parse({ name: "Alice" })).toThrow();
  });
});

describe("ParticipantChangeEventSchema", () => {
  test("parses joined-only change", () => {
    const result = ParticipantChangeEventSchema.parse({
      type: "participant.change",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      joined: [{ id: "p-1", name: "Alice" }],
      left: [],
    });
    expect(result.joined).toHaveLength(1);
    expect(result.left).toHaveLength(0);
  });

  test("parses left-only change", () => {
    const result = ParticipantChangeEventSchema.parse({
      type: "participant.change",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      joined: [],
      left: [{ id: "p-1", name: "Alice", isHost: true }],
    });
    expect(result.left[0]?.isHost).toBe(true);
  });

  test("rejects a malformed participant inside the arrays", () => {
    expect(() =>
      ParticipantChangeEventSchema.parse({
        type: "participant.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        joined: [{ name: "Missing id" }],
        left: [],
      }),
    ).toThrow();
  });

  test("rejects missing joined/left arrays", () => {
    expect(() =>
      ParticipantChangeEventSchema.parse({
        type: "participant.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// InboundChatEventSchema
// ---------------------------------------------------------------------------

describe("InboundChatEventSchema", () => {
  test("parses a valid inbound chat", () => {
    const result = InboundChatEventSchema.parse({
      type: "chat.inbound",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      fromId: "p-alice",
      fromName: "Alice",
      text: "hello bot",
    });
    expect(result.text).toBe("hello bot");
  });

  test("rejects missing fromId", () => {
    expect(() =>
      InboundChatEventSchema.parse({
        type: "chat.inbound",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        fromName: "Alice",
        text: "hello bot",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// LifecycleEventSchema
// ---------------------------------------------------------------------------

describe("LifecycleEventSchema", () => {
  test("parses every lifecycle state", () => {
    for (const state of ["joining", "joined", "leaving", "left", "error"] as const) {
      const result = LifecycleEventSchema.parse({
        type: "lifecycle",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        state,
      });
      expect(result.state).toBe(state);
    }
  });

  test("parses an error lifecycle with detail", () => {
    const result = LifecycleEventSchema.parse({
      type: "lifecycle",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      state: "error",
      detail: "Bot failed to join: stream timeout",
    });
    expect(result.detail).toBe("Bot failed to join: stream timeout");
  });

  test("rejects unknown lifecycle state", () => {
    expect(() =>
      LifecycleEventSchema.parse({
        type: "lifecycle",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        state: "dialing",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MeetBotEventSchema — discriminated union round-trip
// ---------------------------------------------------------------------------

describe("MeetBotEventSchema", () => {
  test("round-trips a transcript chunk", () => {
    const input: MeetBotEvent = {
      type: "transcript.chunk",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      isFinal: true,
      text: "hello",
    };
    const parsed = MeetBotEventSchema.parse(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual(input);
    if (parsed.type === "transcript.chunk") {
      // narrowing check
      expect(parsed.text).toBe("hello");
    } else {
      throw new Error("expected transcript.chunk");
    }
  });

  test("round-trips every event shape", () => {
    const fixtures: MeetBotEvent[] = [
      {
        type: "transcript.chunk",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        isFinal: true,
        text: "hi",
      },
      {
        type: "speaker.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:01Z",
        speakerId: "spk-1",
        speakerName: "Alice",
      },
      {
        type: "participant.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:02Z",
        joined: [{ id: "p-1", name: "Alice" }],
        left: [],
      },
      {
        type: "chat.inbound",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:03Z",
        fromId: "p-alice",
        fromName: "Alice",
        text: "hey bot",
      },
      {
        type: "lifecycle",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:04Z",
        state: "joined",
      },
    ];

    for (const fixture of fixtures) {
      const parsed = MeetBotEventSchema.parse(
        JSON.parse(JSON.stringify(fixture)),
      );
      expect(parsed).toEqual(fixture);
    }
  });

  test("rejects an unknown event type", () => {
    expect(() =>
      MeetBotEventSchema.parse({
        type: "transcript.preview",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        text: "hi",
      }),
    ).toThrow();
  });

  test("rejects an event missing the discriminator", () => {
    expect(() =>
      MeetBotEventSchema.parse({
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
        text: "hi",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Command type const tuple
// ---------------------------------------------------------------------------

describe("MEET_BOT_COMMAND_TYPES", () => {
  test("includes every discriminator used by MeetBotCommandSchema", () => {
    expect(new Set(MEET_BOT_COMMAND_TYPES)).toEqual(
      new Set(["send_chat", "play_audio", "leave", "status"]),
    );
  });
});

// ---------------------------------------------------------------------------
// SendChatCommandSchema
// ---------------------------------------------------------------------------

describe("SendChatCommandSchema", () => {
  test("parses a valid send_chat", () => {
    const result = SendChatCommandSchema.parse({
      type: "send_chat",
      text: "thanks, team",
    });
    expect(result.text).toBe("thanks, team");
  });

  test("rejects an empty text", () => {
    expect(() =>
      SendChatCommandSchema.parse({ type: "send_chat", text: "" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PlayAudioCommandSchema
// ---------------------------------------------------------------------------

describe("PlayAudioCommandSchema", () => {
  test("parses metadata-only play_audio", () => {
    const result = PlayAudioCommandSchema.parse({
      type: "play_audio",
      streamId: "stream-abc",
    });
    expect(result.streamId).toBe("stream-abc");
  });

  test("rejects missing streamId", () => {
    expect(() => PlayAudioCommandSchema.parse({ type: "play_audio" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// LeaveCommandSchema
// ---------------------------------------------------------------------------

describe("LeaveCommandSchema", () => {
  test("parses a leave with no reason", () => {
    const result = LeaveCommandSchema.parse({ type: "leave" });
    expect(result.reason).toBeUndefined();
  });

  test("parses a leave with reason", () => {
    const result = LeaveCommandSchema.parse({
      type: "leave",
      reason: "host ended meeting",
    });
    expect(result.reason).toBe("host ended meeting");
  });
});

// ---------------------------------------------------------------------------
// StatusCommandSchema
// ---------------------------------------------------------------------------

describe("StatusCommandSchema", () => {
  test("parses a status command", () => {
    const result = StatusCommandSchema.parse({ type: "status" });
    expect(result.type).toBe("status");
  });

  test("rejects wrong type", () => {
    expect(() => StatusCommandSchema.parse({ type: "ping" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MeetBotCommandSchema — discriminated union round-trip
// ---------------------------------------------------------------------------

describe("MeetBotCommandSchema", () => {
  test("round-trips every command shape", () => {
    const fixtures: MeetBotCommand[] = [
      { type: "send_chat", text: "hi" },
      { type: "play_audio", streamId: "s-1" },
      { type: "leave" },
      { type: "leave", reason: "done" },
      { type: "status" },
    ];

    for (const fixture of fixtures) {
      const parsed = MeetBotCommandSchema.parse(
        JSON.parse(JSON.stringify(fixture)),
      );
      expect(parsed).toEqual(fixture);
    }
  });

  test("rejects an unknown command type", () => {
    expect(() =>
      MeetBotCommandSchema.parse({ type: "mute", target: "self" }),
    ).toThrow();
  });

  test("rejects a command missing the discriminator", () => {
    expect(() => MeetBotCommandSchema.parse({ text: "oops" })).toThrow();
  });
});
