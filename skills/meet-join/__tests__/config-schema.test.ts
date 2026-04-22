import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AVATAR_DEVICE_PATH,
  DEFAULT_MEET_OBJECTION_KEYWORDS,
  DEFAULT_MEET_PROACTIVE_CHAT_KEYWORDS,
  MeetServiceSchema,
} from "../config-schema.js";

const DEFAULT_PROACTIVE_CHAT = {
  enabled: true,
  detectorKeywords: [...DEFAULT_MEET_PROACTIVE_CHAT_KEYWORDS],
  tier2DebounceMs: 5_000,
  escalationCooldownSec: 30,
  tier2MaxTranscriptSec: 30,
};

const DEFAULT_VOICE_MODE = {
  enabled: true,
  eouDebounceMs: 800,
};

const DEFAULT_AVATAR = {
  enabled: false,
  renderer: "noop",
  devicePath: DEFAULT_AVATAR_DEVICE_PATH,
};

describe("MeetServiceSchema", () => {
  test("empty object parses to the documented defaults (feature off by default)", () => {
    const parsed = MeetServiceSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      containerImage: "vellum-meet-bot:dev",
      joinName: null,
      consentMessage:
        "Hi, I'm {assistantName}, an AI assistant joining to take notes. Let me know if you'd prefer I leave.",
      autoLeaveOnObjection: true,
      objectionKeywords: [...DEFAULT_MEET_OBJECTION_KEYWORDS],
      dockerNetwork: "bridge",
      maxMeetingMinutes: 240,
      proactiveChat: DEFAULT_PROACTIVE_CHAT,
      voiceMode: DEFAULT_VOICE_MODE,
      avatar: DEFAULT_AVATAR,
    });
  });

  test("default objection keyword list matches the exported constant", () => {
    // Guards against accidental divergence between the schema default and the
    // constant that downstream runtime code imports directly.
    const parsed = MeetServiceSchema.parse({});
    expect(parsed.objectionKeywords).toEqual([
      ...DEFAULT_MEET_OBJECTION_KEYWORDS,
    ]);
    // The default must be a fresh array so a consumer mutating the parsed
    // value can't poison the module-level constant.
    expect(parsed.objectionKeywords).not.toBe(DEFAULT_MEET_OBJECTION_KEYWORDS);
  });

  test("valid custom values round-trip", () => {
    const input = {
      enabled: true,
      containerImage: "registry.example.com/meet-bot:1.0.0",
      joinName: "Notes Bot",
      consentMessage:
        "Hi — I'll be taking notes. Say the word and I'll step out.",
      autoLeaveOnObjection: false,
      objectionKeywords: ["leave please", "go away bot"],
      dockerNetwork: "vellum-meet",
      maxMeetingMinutes: 60,
    };
    const parsed = MeetServiceSchema.parse(input);
    expect(parsed).toEqual({
      ...input,
      proactiveChat: DEFAULT_PROACTIVE_CHAT,
      voiceMode: DEFAULT_VOICE_MODE,
      avatar: DEFAULT_AVATAR,
    });
  });

  test("rejects negative maxMeetingMinutes", () => {
    const result = MeetServiceSchema.safeParse({ maxMeetingMinutes: -1 });
    expect(result.success).toBe(false);
  });

  test("rejects zero maxMeetingMinutes (must be strictly positive)", () => {
    const result = MeetServiceSchema.safeParse({ maxMeetingMinutes: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer maxMeetingMinutes", () => {
    const result = MeetServiceSchema.safeParse({ maxMeetingMinutes: 12.5 });
    expect(result.success).toBe(false);
  });

  test("rejects non-string joinName that isn't null (e.g. number, boolean)", () => {
    const numberResult = MeetServiceSchema.safeParse({ joinName: 42 });
    expect(numberResult.success).toBe(false);

    const boolResult = MeetServiceSchema.safeParse({ joinName: true });
    expect(boolResult.success).toBe(false);

    const arrayResult = MeetServiceSchema.safeParse({ joinName: ["Bot"] });
    expect(arrayResult.success).toBe(false);
  });

  test("joinName: null is accepted and stays null", () => {
    const parsed = MeetServiceSchema.parse({ joinName: null });
    expect(parsed.joinName).toBe(null);
  });

  test("joinName: '' is normalized to null (empty string = 'use assistant display name')", () => {
    // Documented decision: empty/whitespace-only joinName values are treated
    // identically to null — they both mean "fall back to the assistant's
    // display name at runtime". This keeps downstream callers honest: they
    // only have to check for null, never for empty strings.
    const parsed = MeetServiceSchema.parse({ joinName: "" });
    expect(parsed.joinName).toBe(null);

    const whitespaceParsed = MeetServiceSchema.parse({ joinName: "   " });
    expect(whitespaceParsed.joinName).toBe(null);
  });

  test("joinName with surrounding whitespace is trimmed", () => {
    const parsed = MeetServiceSchema.parse({ joinName: "  Notes Bot  " });
    expect(parsed.joinName).toBe("Notes Bot");
  });

  test("empty containerImage falls back to default", () => {
    const parsed = MeetServiceSchema.parse({ containerImage: "" });
    expect(parsed.containerImage).toBe("vellum-meet-bot:dev");
  });

  test("empty dockerNetwork falls back to default", () => {
    const parsed = MeetServiceSchema.parse({ dockerNetwork: "" });
    expect(parsed.dockerNetwork).toBe("bridge");
  });

  test("rejects non-string entries in objectionKeywords", () => {
    const result = MeetServiceSchema.safeParse({
      objectionKeywords: ["please leave", 42],
    });
    expect(result.success).toBe(false);
  });

  test("objectionKeywords: [] parses as an explicit empty array (opts out of keyword matching)", () => {
    const parsed = MeetServiceSchema.parse({ objectionKeywords: [] });
    expect(parsed.objectionKeywords).toEqual([]);
  });

  test("default objection keyword list includes the expanded Phase 1.7 coverage", () => {
    // Explicitly pin the Phase 1.7 additions so they aren't silently dropped
    // from the default. The fast-keyword filter only gates whether we run an
    // extra (latency-optimized) LLM confirmation, so biasing toward coverage
    // here is safe — missing keywords cost us actual miss rate.
    const parsed = MeetServiceSchema.parse({});
    const expectedNew = [
      // polite requests
      "can you leave",
      "could you leave",
      "would you mind leaving",
      "please exit",
      "step out",
      // direct objections
      "no AI",
      "turn off the bot",
      "turn off the AI",
      "remove the bot",
      "kick the bot",
      "mute the bot",
      "stop listening",
      "stop transcribing",
      // discomfort signaling
      "not comfortable",
      "don't record",
      "don't want this recorded",
    ];
    for (const keyword of expectedNew) {
      expect(parsed.objectionKeywords).toContain(keyword);
    }
  });

  test("default objection keyword list preserves the original Phase 1 entries", () => {
    // Guard against accidental deletion during future expansions — the
    // originals must keep matching existing consent-monitor behavior.
    const parsed = MeetServiceSchema.parse({});
    const original = [
      "please leave",
      "stop recording",
      "no bots",
      "no recording",
      "I don't consent",
      "can the bot leave",
    ];
    for (const keyword of original) {
      expect(parsed.objectionKeywords).toContain(keyword);
    }
  });

  test("user-supplied objectionKeywords override the default completely (no merge)", () => {
    // Documented semantics: passing objectionKeywords replaces the default
    // list wholesale. We do NOT merge user values into the defaults — users
    // who want "defaults plus mine" should spread DEFAULT_MEET_OBJECTION_KEYWORDS
    // themselves at the call site.
    const userKeywords = ["custom phrase", "another phrase"];
    const parsed = MeetServiceSchema.parse({ objectionKeywords: userKeywords });
    expect(parsed.objectionKeywords).toEqual(userKeywords);
    // None of the defaults should have leaked in.
    for (const defaultKeyword of DEFAULT_MEET_OBJECTION_KEYWORDS) {
      expect(parsed.objectionKeywords).not.toContain(defaultKeyword);
    }
  });

  test("partial config with only enabled: true fills in remaining defaults", () => {
    const parsed = MeetServiceSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.containerImage).toBe("vellum-meet-bot:dev");
    expect(parsed.joinName).toBe(null);
    expect(parsed.autoLeaveOnObjection).toBe(true);
    expect(parsed.maxMeetingMinutes).toBe(240);
  });
});

describe("MeetServiceSchema.avatar", () => {
  test("avatar defaults to disabled with the noop renderer", () => {
    const parsed = MeetServiceSchema.parse({});
    expect(parsed.avatar.enabled).toBe(false);
    expect(parsed.avatar.renderer).toBe("noop");
    expect(parsed.avatar.devicePath).toBe(DEFAULT_AVATAR_DEVICE_PATH);
  });

  test("accepts each renderer id in the documented enum", () => {
    const ids = [
      "noop",
      "talking-head",
      "simli",
      "heygen",
      "tavus",
      "sadtalker",
      "musetalk",
    ];
    for (const id of ids) {
      const parsed = MeetServiceSchema.parse({
        avatar: { enabled: true, renderer: id },
      });
      expect(parsed.avatar.renderer).toBe(id);
    }
  });

  test("rejects an unknown renderer id", () => {
    const result = MeetServiceSchema.safeParse({
      avatar: { renderer: "not-a-renderer" },
    });
    expect(result.success).toBe(false);
  });

  test("per-renderer option blocks are all optional at the schema level", () => {
    // Each renderer PR fills in its own required shape inside its
    // `start()` implementation — the schema stays permissive so a
    // partially-configured avatar block still round-trips through the
    // config loader.
    const parsed = MeetServiceSchema.parse({
      avatar: {
        enabled: true,
        renderer: "simli",
        simli: { apiKeyCredentialId: "credential-simli-prod" },
      },
    });
    expect(parsed.avatar.renderer).toBe("simli");
    expect(parsed.avatar.simli).toEqual({
      apiKeyCredentialId: "credential-simli-prod",
    });
  });

  test("devicePath can be overridden for non-default v4l2loopback nodes", () => {
    const parsed = MeetServiceSchema.parse({
      avatar: {
        enabled: true,
        renderer: "noop",
        devicePath: "/dev/video11",
      },
    });
    expect(parsed.avatar.devicePath).toBe("/dev/video11");
  });
});
