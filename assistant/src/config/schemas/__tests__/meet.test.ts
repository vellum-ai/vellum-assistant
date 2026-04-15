import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MEET_OBJECTION_KEYWORDS,
  MeetServiceSchema,
} from "../meet.js";

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
      consentMessage: "Hi — I'll be taking notes. Say the word and I'll step out.",
      autoLeaveOnObjection: false,
      objectionKeywords: ["leave please", "go away bot"],
      dockerNetwork: "vellum-meet",
      maxMeetingMinutes: 60,
    };
    const parsed = MeetServiceSchema.parse(input);
    expect(parsed).toEqual(input);
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

  test("rejects empty containerImage", () => {
    const result = MeetServiceSchema.safeParse({ containerImage: "" });
    expect(result.success).toBe(false);
  });

  test("rejects empty dockerNetwork", () => {
    const result = MeetServiceSchema.safeParse({ dockerNetwork: "" });
    expect(result.success).toBe(false);
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

  test("partial config with only enabled: true fills in remaining defaults", () => {
    const parsed = MeetServiceSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.containerImage).toBe("vellum-meet-bot:dev");
    expect(parsed.joinName).toBe(null);
    expect(parsed.autoLeaveOnObjection).toBe(true);
    expect(parsed.maxMeetingMinutes).toBe(240);
  });
});
