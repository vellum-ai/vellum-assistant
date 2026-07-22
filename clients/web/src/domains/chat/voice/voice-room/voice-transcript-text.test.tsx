/**
 * Tests for `VoiceTranscriptText`.
 *
 * Load-bearing contracts: the plain sentence is exactly the rendered
 * `textContent` (so the caller's `aria-live` region announces it verbatim);
 * an optional `color` flattens every word to that single tone (the default
 * two-tone leading-edge look applies only when `color` is omitted); and an
 * optional `highlightIndex` moves the bright leading-edge tone to that word
 * (clamped) so an audio-playhead cursor can track the spoken word.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import {
  splitTranscriptWords,
  VoiceTranscriptText,
} from "@/domains/chat/voice/voice-room/voice-transcript-text";

afterEach(() => {
  cleanup();
});

/**
 * Which word carries the bright leading-edge tone. The tone is a `var()` color
 * with a fallback, which happy-dom drops from inline style entirely — so the
 * component marks the leading word with `data-leading` and the tests assert on
 * that (the `color`-override tests below still assert on `style.color`, which
 * happy-dom preserves for concrete values).
 */
function leadingFlags(container: HTMLElement): boolean[] {
  return [...container.querySelectorAll("span")].map((span) =>
    span.hasAttribute("data-leading"),
  );
}

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

  test("last word carries the leading tone when highlightIndex is omitted", () => {
    const { container } = render(<VoiceTranscriptText text="one two three" />);
    expect(leadingFlags(container)).toEqual([false, false, true]);
  });

  test("highlightIndex moves the leading tone to that word", () => {
    const { container } = render(
      <VoiceTranscriptText text="one two three" highlightIndex={1} />,
    );
    // The cursor owns the highlight — the last-arrived word renders the muted base.
    expect(leadingFlags(container)).toEqual([false, true, false]);
  });

  test("out-of-range highlightIndex clamps to the last word", () => {
    const { container } = render(
      <VoiceTranscriptText text="one two three" highlightIndex={99} />,
    );
    expect(leadingFlags(container)).toEqual([false, false, true]);
  });

  test("negative highlightIndex clamps to the first word", () => {
    const { container } = render(
      <VoiceTranscriptText text="one two three" highlightIndex={-3} />,
    );
    expect(leadingFlags(container)).toEqual([true, false, false]);
  });

  test("non-finite highlightIndex normalizes to the first word", () => {
    // NaN would otherwise propagate through the clamp and leave no word
    // carrying the leading tone.
    const { container } = render(
      <VoiceTranscriptText text="one two three" highlightIndex={Number.NaN} />,
    );
    expect(leadingFlags(container)).toEqual([true, false, false]);
  });

  test("color override still flattens every word when highlightIndex is set", () => {
    const { container } = render(
      <VoiceTranscriptText
        text="one two three"
        color="rgb(1, 2, 3)"
        highlightIndex={1}
      />,
    );
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBe(3);
    for (const span of spans) {
      expect(span.style.color).toBe("rgb(1, 2, 3)");
    }
  });

  test("textContent is unchanged when highlightIndex is set", () => {
    const { container } = render(
      <VoiceTranscriptText text="hello world" highlightIndex={0} />,
    );
    expect(container.textContent).toBe("hello world");
  });

  test("splitTranscriptWords matches the rendered segmentation", () => {
    // The cursor maps audio progress onto this segmentation, so it must be
    // exactly what the component renders — one span per returned word.
    const text = "  hello   brave\nworld ";
    expect(splitTranscriptWords(text)).toEqual(["hello", "brave", "world"]);
    const { container } = render(<VoiceTranscriptText text={text} />);
    expect(container.querySelectorAll("span").length).toBe(3);
    expect(container.textContent).toBe("hello brave world");
  });
});
