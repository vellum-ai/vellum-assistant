/**
 * Tests for the native-messaging wire protocol.
 *
 * Every message variant in each union is exercised with a parse
 * round-trip assertion. Each union also has a negative test verifying
 * an unknown `type` value is rejected.
 */

import { describe, expect, test } from "bun:test";

import {
  BOT_TO_EXTENSION_MESSAGE_TYPES,
  BotJoinCommandSchema,
  BotLeaveCommandSchema,
  BotSendChatCommandSchema,
  BotToExtensionMessageSchema,
  EXTENSION_TO_BOT_MESSAGE_TYPES,
  ExtensionDiagnosticMessageSchema,
  ExtensionInboundChatMessageSchema,
  ExtensionLifecycleMessageSchema,
  ExtensionParticipantChangeMessageSchema,
  ExtensionReadyMessageSchema,
  ExtensionSendChatResultMessageSchema,
  ExtensionSpeakerChangeMessageSchema,
  ExtensionToBotMessageSchema,
  ExtensionTrustedTypeMessageSchema,
  type BotToExtensionMessage,
  type ExtensionToBotMessage,
} from "../index.js";

// ---------------------------------------------------------------------------
// Type-constant coverage
// ---------------------------------------------------------------------------

describe("EXTENSION_TO_BOT_MESSAGE_TYPES", () => {
  test("includes every discriminator used by ExtensionToBotMessageSchema", () => {
    expect(new Set(EXTENSION_TO_BOT_MESSAGE_TYPES)).toEqual(
      new Set([
        "ready",
        "lifecycle",
        "participant.change",
        "speaker.change",
        "chat.inbound",
        "diagnostic",
        "trusted_click",
        "trusted_type",
        "send_chat_result",
      ]),
    );
  });
});

describe("BOT_TO_EXTENSION_MESSAGE_TYPES", () => {
  test("includes every discriminator used by BotToExtensionMessageSchema", () => {
    expect(new Set(BOT_TO_EXTENSION_MESSAGE_TYPES)).toEqual(
      new Set(["join", "leave", "send_chat"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Extension → Bot — per-variant parse
// ---------------------------------------------------------------------------

describe("ExtensionReadyMessageSchema", () => {
  test("parses a ready handshake", () => {
    const input = { type: "ready", extensionVersion: "1.2.3" } as const;
    const parsed = ExtensionReadyMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects empty extensionVersion", () => {
    expect(() =>
      ExtensionReadyMessageSchema.parse({ type: "ready", extensionVersion: "" }),
    ).toThrow();
  });
});

describe("ExtensionLifecycleMessageSchema", () => {
  test("parses every lifecycle state", () => {
    for (const state of ["joining", "joined", "left", "error"] as const) {
      const input = {
        type: "lifecycle" as const,
        state,
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      };
      const parsed = ExtensionLifecycleMessageSchema.parse(input);
      expect(parsed).toEqual(input);
    }
  });

  test("parses an error lifecycle with detail", () => {
    const input = {
      type: "lifecycle" as const,
      state: "error" as const,
      detail: "pre-join screen timed out",
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
    };
    const parsed = ExtensionLifecycleMessageSchema.parse(input);
    expect(parsed.detail).toBe("pre-join screen timed out");
  });

  test("rejects unknown lifecycle state", () => {
    expect(() =>
      ExtensionLifecycleMessageSchema.parse({
        type: "lifecycle",
        state: "dialing",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      }),
    ).toThrow();
  });
});

describe("ExtensionParticipantChangeMessageSchema", () => {
  test("parses a participant change", () => {
    const input = {
      type: "participant.change" as const,
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      joined: [{ id: "p-1", name: "Alice" }],
      left: [],
    };
    const parsed = ExtensionParticipantChangeMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});

describe("ExtensionSpeakerChangeMessageSchema", () => {
  test("parses a speaker change", () => {
    const input = {
      type: "speaker.change" as const,
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      speakerId: "spk-alice",
      speakerName: "Alice",
    };
    const parsed = ExtensionSpeakerChangeMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});

describe("ExtensionInboundChatMessageSchema", () => {
  test("parses an inbound chat", () => {
    const input = {
      type: "chat.inbound" as const,
      meetingId: "meet-1",
      timestamp: "2026-04-15T00:00:00Z",
      fromId: "p-alice",
      fromName: "Alice",
      text: "hi bot",
    };
    const parsed = ExtensionInboundChatMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});

describe("ExtensionDiagnosticMessageSchema", () => {
  test("parses an info diagnostic", () => {
    const input = {
      type: "diagnostic" as const,
      level: "info" as const,
      message: "waited for pre-join screen",
    };
    const parsed = ExtensionDiagnosticMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("parses an error diagnostic", () => {
    const input = {
      type: "diagnostic" as const,
      level: "error" as const,
      message: "chat input selector not found",
    };
    const parsed = ExtensionDiagnosticMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects unknown diagnostic level", () => {
    expect(() =>
      ExtensionDiagnosticMessageSchema.parse({
        type: "diagnostic",
        level: "warn",
        message: "mid-severity",
      }),
    ).toThrow();
  });
});

describe("ExtensionTrustedTypeMessageSchema", () => {
  test("parses a valid trusted_type message without delayMs", () => {
    const input = {
      type: "trusted_type" as const,
      text: "hello meet",
    };
    const parsed = ExtensionTrustedTypeMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("parses a valid trusted_type message with delayMs", () => {
    const input = {
      type: "trusted_type" as const,
      text: "hello meet",
      delayMs: 12,
    };
    const parsed = ExtensionTrustedTypeMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects empty text", () => {
    expect(() =>
      ExtensionTrustedTypeMessageSchema.parse({
        type: "trusted_type",
        text: "",
      }),
    ).toThrow();
  });

  test("rejects text longer than 2000 chars", () => {
    expect(() =>
      ExtensionTrustedTypeMessageSchema.parse({
        type: "trusted_type",
        text: "a".repeat(2001),
      }),
    ).toThrow();
  });

  test("accepts text exactly 2000 chars", () => {
    const input = {
      type: "trusted_type" as const,
      text: "a".repeat(2000),
    };
    const parsed = ExtensionTrustedTypeMessageSchema.parse(input);
    expect(parsed.text.length).toBe(2000);
  });

  test("rejects delayMs > 500", () => {
    expect(() =>
      ExtensionTrustedTypeMessageSchema.parse({
        type: "trusted_type",
        text: "hi",
        delayMs: 501,
      }),
    ).toThrow();
  });

  test("rejects negative delayMs", () => {
    expect(() =>
      ExtensionTrustedTypeMessageSchema.parse({
        type: "trusted_type",
        text: "hi",
        delayMs: -1,
      }),
    ).toThrow();
  });

  test("rejects non-integer delayMs", () => {
    expect(() =>
      ExtensionTrustedTypeMessageSchema.parse({
        type: "trusted_type",
        text: "hi",
        delayMs: 12.5,
      }),
    ).toThrow();
  });
});

describe("ExtensionSendChatResultMessageSchema", () => {
  test("parses an ok result without error", () => {
    const input = {
      type: "send_chat_result" as const,
      requestId: "req-1",
      ok: true,
    };
    const parsed = ExtensionSendChatResultMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("parses a failure result with error detail", () => {
    const input = {
      type: "send_chat_result" as const,
      requestId: "req-2",
      ok: false,
      error: "chat input not focusable",
    };
    const parsed = ExtensionSendChatResultMessageSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects missing requestId", () => {
    expect(() =>
      ExtensionSendChatResultMessageSchema.parse({
        type: "send_chat_result",
        ok: true,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ExtensionToBotMessageSchema — discriminated union round-trip
// ---------------------------------------------------------------------------

describe("ExtensionToBotMessageSchema", () => {
  test("round-trips every extension→bot message shape", () => {
    const fixtures: ExtensionToBotMessage[] = [
      { type: "ready", extensionVersion: "1.0.0" },
      {
        type: "lifecycle",
        state: "joining",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      },
      {
        type: "lifecycle",
        state: "error",
        detail: "boom",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:01Z",
      },
      {
        type: "participant.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:02Z",
        joined: [{ id: "p-1", name: "Alice" }],
        left: [],
      },
      {
        type: "speaker.change",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:03Z",
        speakerId: "spk-1",
        speakerName: "Alice",
      },
      {
        type: "chat.inbound",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:04Z",
        fromId: "p-alice",
        fromName: "Alice",
        text: "hey bot",
      },
      {
        type: "diagnostic",
        level: "info",
        message: "attached to call",
      },
      {
        type: "trusted_type",
        text: "hi bot",
      },
      {
        type: "trusted_type",
        text: "hi bot",
        delayMs: 20,
      },
      {
        type: "send_chat_result",
        requestId: "req-1",
        ok: true,
      },
      {
        type: "send_chat_result",
        requestId: "req-2",
        ok: false,
        error: "not allowed",
      },
    ];

    for (const fixture of fixtures) {
      const parsed = ExtensionToBotMessageSchema.parse(
        JSON.parse(JSON.stringify(fixture)),
      );
      expect(parsed).toEqual(fixture);
    }
  });

  test("rejects an unknown message type", () => {
    expect(() =>
      ExtensionToBotMessageSchema.parse({
        type: "heartbeat",
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      }),
    ).toThrow();
  });

  test("rejects a message missing the discriminator", () => {
    expect(() =>
      ExtensionToBotMessageSchema.parse({
        meetingId: "meet-1",
        timestamp: "2026-04-15T00:00:00Z",
      }),
    ).toThrow();
  });

  test("narrows on trusted_type via the discriminated union", () => {
    const parsed = ExtensionToBotMessageSchema.parse({
      type: "trusted_type",
      text: "hi",
    });
    expect(parsed.type).toBe("trusted_type");
  });
});

// ---------------------------------------------------------------------------
// Bot → Extension — per-variant parse
// ---------------------------------------------------------------------------

describe("BotJoinCommandSchema", () => {
  test("parses a full join command", () => {
    const input = {
      type: "join" as const,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage:
        "Hi, I'm here on behalf of Sidd to take notes. Reply STOP to have me leave.",
    };
    const parsed = BotJoinCommandSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects empty meetingUrl", () => {
    expect(() =>
      BotJoinCommandSchema.parse({
        type: "join",
        meetingUrl: "",
        displayName: "Vellum Bot",
        consentMessage: "Hi",
      }),
    ).toThrow();
  });

  test("rejects missing displayName", () => {
    expect(() =>
      BotJoinCommandSchema.parse({
        type: "join",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        consentMessage: "Hi",
      }),
    ).toThrow();
  });
});

describe("BotLeaveCommandSchema", () => {
  test("parses a leave with reason", () => {
    const input = { type: "leave" as const, reason: "host ended meeting" };
    const parsed = BotLeaveCommandSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects empty reason", () => {
    expect(() =>
      BotLeaveCommandSchema.parse({ type: "leave", reason: "" }),
    ).toThrow();
  });
});

describe("BotSendChatCommandSchema", () => {
  test("parses a send_chat", () => {
    const input = {
      type: "send_chat" as const,
      text: "thanks, team",
      requestId: "req-1",
    };
    const parsed = BotSendChatCommandSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("rejects empty text", () => {
    expect(() =>
      BotSendChatCommandSchema.parse({
        type: "send_chat",
        text: "",
        requestId: "req-1",
      }),
    ).toThrow();
  });

  test("rejects missing requestId", () => {
    expect(() =>
      BotSendChatCommandSchema.parse({
        type: "send_chat",
        text: "hi",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BotToExtensionMessageSchema — discriminated union round-trip
// ---------------------------------------------------------------------------

describe("BotToExtensionMessageSchema", () => {
  test("round-trips every bot→extension message shape", () => {
    const fixtures: BotToExtensionMessage[] = [
      {
        type: "join",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, I'm here to take notes.",
      },
      { type: "leave", reason: "user requested" },
      { type: "send_chat", text: "hi", requestId: "req-1" },
    ];

    for (const fixture of fixtures) {
      const parsed = BotToExtensionMessageSchema.parse(
        JSON.parse(JSON.stringify(fixture)),
      );
      expect(parsed).toEqual(fixture);
    }
  });

  test("rejects an unknown command type", () => {
    expect(() =>
      BotToExtensionMessageSchema.parse({
        type: "mute",
        target: "self",
      }),
    ).toThrow();
  });

  test("rejects a command missing the discriminator", () => {
    expect(() =>
      BotToExtensionMessageSchema.parse({
        meetingUrl: "https://meet.google.com/abc",
      }),
    ).toThrow();
  });
});
