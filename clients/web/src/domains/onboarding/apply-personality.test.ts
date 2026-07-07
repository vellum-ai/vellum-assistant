/**
 * Tests for the personality system-message builder — the load-bearing mapping
 * from the five 0–100 sliders to the nine named trait scores. Must reproduce
 * the agreed template wording exactly (the assistant parses these lines).
 * Also covers the rewrite-turn settle decision, which gates the "Let's chat"
 * handoff: settling early would let the first greeting race the identity
 * rewrite.
 */

import { describe, expect, test } from "bun:test";

import {
  buildPersonalityMessage,
  shouldSettlePersonalityPoll,
} from "./apply-personality";

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
      "Alice",
    );

    expect(msg).toContain("Alice wants to customize your personality.");
    expect(msg).toContain("Companion (0-100): 30");
    expect(msg).toContain("Coworker (0-100): 70");
    expect(msg).toContain("Voice Style (0 = Gen Z, 100 = Boomer): 80");
    expect(msg).toContain("Execute Independently (0 - 100): 20");
    expect(msg).toContain("Collaborative (0 - 100): 80");
    expect(msg).toContain("Playfulness (0 - 100): 100");
    expect(msg).toContain("Seriousness (0 - 100): 0");
    expect(msg).toContain("Politeness (0 - 100): 40");
    expect(msg).toContain("Unfiltered Rawness/Crassness (0 - 100): 60");
    expect(msg).toContain("Rewrite your own identity files (IDENTITY.md and SOUL.md)");
    // The rewrite is scoped to the assistant's own identity — the user's
    // profile (users/guardian.md) must be preserved, not clobbered by
    // personality text.
    expect(msg).toContain("Do not touch users/guardian.md");
    // The instruction forces a full overwrite rather than an append, so the
    // rewrite lands the persona in the assistant's voice instead of stacking a
    // patch on top of the default text.
    expect(msg).toContain("Overwrite each file completely with file_write");
    expect(msg).toContain("not an edit");
    expect(msg).toContain("do not append");
    // The rewrite reshapes personality only — it must not rename the assistant.
    expect(msg).toContain("Keep your existing name exactly as it is");
    expect(msg).toContain("Do not rename yourself");
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

  test("states the chosen assistant name outright when one was picked", () => {
    const msg = buildPersonalityMessage({}, "Alice", "Quill");
    // The rewrite conversation's system prompt can predate the name landing in
    // IDENTITY.md, so the message itself must carry the authoritative name…
    expect(msg).toContain("Your name is Quill.");
    // …pinned to the exact field-line format the onboarding name-seeder's
    // regex matches.
    expect(msg).toContain("Write exactly `- **Name:** Quill` in IDENTITY.md");
    expect(msg).toContain("do not rename yourself or invent a different name");
    // The generic keep-your-name wording is replaced, not duplicated.
    expect(msg).not.toContain("Keep your existing name exactly as it is");
  });

  test("keeps the carry-your-name-through wording when no name was picked", () => {
    const msg = buildPersonalityMessage({}, "Alice");
    expect(msg).toContain("Keep your existing name exactly as it is");
    expect(msg).toContain("Do not rename yourself");
    expect(msg).not.toContain("Your name is");
  });

  test("ignores a whitespace-only assistant name", () => {
    const msg = buildPersonalityMessage({}, "Alice", "   ");
    expect(msg).toContain("Keep your existing name exactly as it is");
    expect(msg).not.toContain("Your name is");
  });
});

describe("shouldSettlePersonalityPoll", () => {
  test("does not settle while the daemon reports the turn mid-flight", () => {
    // The regression: the rewrite emits a stable "rewriting now…" preamble and
    // then spends tens of seconds on file_write calls. Text-stability alone
    // settled here and released the chat handoff before IDENTITY.md was
    // written.
    expect(
      shouldSettlePersonalityPoll({
        processing: true,
        hasReply: true,
        stableReads: 5,
      }),
    ).toBe(false);
  });

  test("settles once the daemon reports the turn finished and a reply exists", () => {
    expect(
      shouldSettlePersonalityPoll({
        processing: false,
        hasReply: true,
        stableReads: 0,
      }),
    ).toBe(true);
  });

  test("does not settle on processing:false before the turn has produced a reply", () => {
    // A just-posted message can still be queued — `processing` is false until
    // the turn actually starts, so the flag alone would settle instantly.
    expect(
      shouldSettlePersonalityPoll({
        processing: false,
        hasReply: false,
        stableReads: 0,
      }),
    ).toBe(false);
  });

  test("falls back to text-stability when the daemon omits the flag", () => {
    expect(
      shouldSettlePersonalityPoll({
        processing: undefined,
        hasReply: true,
        stableReads: 2,
      }),
    ).toBe(true);
    expect(
      shouldSettlePersonalityPoll({
        processing: undefined,
        hasReply: true,
        stableReads: 1,
      }),
    ).toBe(false);
    expect(
      shouldSettlePersonalityPoll({
        processing: undefined,
        hasReply: false,
        stableReads: 2,
      }),
    ).toBe(false);
  });
});
