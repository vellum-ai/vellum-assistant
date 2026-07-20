/**
 * Tests for `VoiceTranscriptText`.
 *
 * Two load-bearing contracts: the plain sentence is exactly the rendered
 * `textContent` (so the caller's `aria-live` region announces it verbatim),
 * and an optional `color` flattens every word to that single tone (the default
 * two-tone leading-edge look applies only when `color` is omitted).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { VoiceTranscriptText } from "@/domains/chat/voice/voice-room/voice-transcript-text";

afterEach(() => {
  cleanup();
});

describe("VoiceTranscriptText", () => {
  test("exposes the plain sentence as textContent", () => {
    const { container } = render(<VoiceTranscriptText text="hello world" />);
    expect(container.textContent).toBe("hello world");
  });

  test("paints every word the single color override when given", () => {
    const { container } = render(
      <VoiceTranscriptText text="hello world" color="rgb(1, 2, 3)" />,
    );
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBe(2);
    // A single `color` flattens the reveal — leading edge and settled words alike.
    for (const span of spans) {
      expect(span.style.color).toBe("rgb(1, 2, 3)");
    }
  });
});
