/**
 * Tests for the personality system-message builder — the load-bearing mapping
 * from the five 0–100 sliders to the nine named trait scores. Must reproduce
 * the agreed template wording exactly (the assistant parses these lines).
 */

import { describe, expect, test } from "bun:test";

import { buildPersonalityMessage } from "./apply-personality";

describe("buildPersonalityMessage", () => {
  test("reproduces the template scores from the matching slider values", () => {
    // Sliders that should yield the reference template (Companion 30/Coworker
    // 70, Voice 80, Execute 20/Collaborate 80, Playful 100/Serious 0, Polite
    // 40/Unfiltered 60).
    const msg = buildPersonalityMessage(
      {
        "companion-coworker": 70,
        "genz-boomer": 80,
        "execute-collaborate": 80,
        "playful-serious": 0,
        "polite-unfiltered": 60,
      },
      "Akash",
    );

    expect(msg).toContain("Akash wants to customize your personality.");
    expect(msg).toContain("Companion (0-100): 30");
    expect(msg).toContain("Coworker (0-100): 70");
    expect(msg).toContain("Voice Style (0 = Gen Z, 100 = Boomer): 80");
    expect(msg).toContain("Execute Independently (0 - 100): 20");
    expect(msg).toContain("Collaborative (0 - 100): 80");
    expect(msg).toContain("Playfulness (0 - 100): 100");
    expect(msg).toContain("Seriousness (0 - 100): 0");
    expect(msg).toContain("Politeness (0 - 100): 40");
    expect(msg).toContain("Unfiltered Rawness/Crassness (0 - 100): 60");
    expect(msg).toContain("Rewrite your identity files (IDENTITY.md, SOUL.md, users/guardian.md)");
    expect(msg).toContain("<system-message>");
    expect(msg).toContain("</system-message>");
  });

  test("defaults missing sliders to the midpoint and falls back to a generic name", () => {
    const msg = buildPersonalityMessage({});
    expect(msg).toContain("The user wants to customize your personality.");
    // Empty → every slider treated as 50, so both ends read 50.
    expect(msg).toContain("Companion (0-100): 50");
    expect(msg).toContain("Coworker (0-100): 50");
    expect(msg).toContain("Voice Style (0 = Gen Z, 100 = Boomer): 50");
  });

  test("clamps out-of-range values into 0–100", () => {
    const msg = buildPersonalityMessage({ "companion-coworker": 140 });
    expect(msg).toContain("Coworker (0-100): 100");
    expect(msg).toContain("Companion (0-100): 0");
  });

  test("weaves the persona into the message when provided", () => {
    const msg = buildPersonalityMessage(
      {},
      "Akash",
      "a noir detective on the case",
    );
    expect(msg).toContain(
      'They also described the character they want you to embody: "a noir detective on the case".',
    );
    // Trait scores and the rewrite instruction still survive the insertion.
    expect(msg).toContain("Companion (0-100): 50");
    expect(msg).toContain(
      "Rewrite your identity files (IDENTITY.md, SOUL.md, users/guardian.md)",
    );
  });

  test("collapses whitespace and omits the persona block when blank", () => {
    const multiline = buildPersonalityMessage(
      {},
      undefined,
      "a sassy\n  goth   girl",
    );
    expect(multiline).toContain('"a sassy goth girl"');

    const blank = buildPersonalityMessage({}, undefined, "   ");
    expect(blank).not.toContain("described the character");
  });
});
