/**
 * Tests for `VoiceTranscriptText`.
 *
 * Two load-bearing contracts: the plain sentence is exactly the rendered
 * `textContent` (so the caller's `aria-live` region announces it verbatim),
 * and the optional color overrides land on the right spans — the leading edge
 * (last word) gets `leadingColor`, the settled words get `baseColor`.
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

  test("applies color overrides to the leading vs. non-leading spans", () => {
    const { container } = render(
      <VoiceTranscriptText
        text="hello world"
        leadingColor="rgb(1, 2, 3)"
        baseColor="rgb(4, 5, 6)"
      />,
    );
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBe(2);
    // The last word is the leading edge; earlier words settle to the base tone.
    expect(spans[spans.length - 1]!.style.color).toBe("rgb(1, 2, 3)");
    expect(spans[0]!.style.color).toBe("rgb(4, 5, 6)");
  });
});
