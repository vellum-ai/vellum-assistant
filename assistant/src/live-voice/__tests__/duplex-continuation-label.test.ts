import { describe, expect, test } from "bun:test";

import {
  buildDuplexContinuationLabel,
  DUPLEX_CONTINUATION_FALLBACK_LABEL,
} from "../live-voice-session.js";

describe("buildDuplexContinuationLabel", () => {
  test("names the continuation after the interrupted request", () => {
    expect(buildDuplexContinuationLabel("what's on my calendar tomorrow")).toBe(
      "What's on my calendar tomorrow",
    );
  });

  test("collapses transcript whitespace between segments", () => {
    expect(
      buildDuplexContinuationLabel("  check my   reminders \n please "),
    ).toBe("Check my reminders please");
  });

  test("cuts a long request to conversation-title length", () => {
    const label = buildDuplexContinuationLabel(
      "can you go through every email from last week and tell me which ones still need a reply from me",
    );
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toBe("Can you go through every");
  });

  test("falls back to a plain description when no transcript landed", () => {
    expect(buildDuplexContinuationLabel("")).toBe(
      DUPLEX_CONTINUATION_FALLBACK_LABEL,
    );
    expect(buildDuplexContinuationLabel("   ")).toBe(
      DUPLEX_CONTINUATION_FALLBACK_LABEL,
    );
  });
});
